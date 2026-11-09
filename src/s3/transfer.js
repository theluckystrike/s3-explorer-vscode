'use strict';
// Uploads (single PUT or multipart with resume) and streamed downloads. No VS Code here, so tests can run it.
// Memory: one part buffer per worker (part size x concurrency), never the whole file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { S3Error } = require('./client');

const MB = 1024 * 1024;
const MAX_PARTS = 10000;

/** Part size: at least minPart, big enough to stay under 10,000 parts. */
function partSizeFor(size, minPart = 8 * MB) {
  let p = Math.max(5 * MB, minPart);
  while (Math.ceil(size / p) > MAX_PARTS - 100) p *= 2;
  return p;
}

/** A folder of JSON files, one per unfinished multipart upload. */
class UploadStore {
  constructor(dir) { this.dir = dir; }
  file(id) { return path.join(this.dir, id.replace(/[^a-f0-9]/g, '') + '.json'); }
  get(id) { try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch (e) { return null; } }
  save(state) { fs.mkdirSync(this.dir, { recursive: true }); const f = this.file(state.id); fs.writeFileSync(f + '.tmp', JSON.stringify(state)); fs.renameSync(f + '.tmp', f); }
  remove(id) { try { fs.unlinkSync(this.file(id)); } catch (e) { /* gone */ } }
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')); } catch (e) { return []; }
    return names.map((n) => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8')); } catch (e) { return null; } }).filter(Boolean);
  }
}

function uploadId(connId, bucket, key, file) {
  return crypto.createHash('sha1').update([connId, bucket, key, path.resolve(file)].join('\0')).digest('hex');
}

async function readPart(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fd.read(buf, got, length - got, offset + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  if (got !== length) throw new S3Error('The file changed while it was uploading.', { code: 'FileChanged' });
  return buf;
}

/**
 * Upload one local file. opts: { connId, bucket, key, file, contentType, threshold, minPart, concurrency, store,
 * signal, onProgress(sent, total), onState(state) }. Returns { etag, multipart, resumed, parts }.
 */
async function uploadFile(client, opts) {
  const { bucket, key, file, contentType, signal } = opts;
  const st = await fs.promises.stat(file);
  if (!st.isFile()) throw new S3Error(`${file} is not a file.`, { code: 'NotAFile' });
  const size = st.size;
  const threshold = opts.threshold || 16 * MB;
  const progress = opts.onProgress || (() => {});
  if (size < threshold) {
    const buf = await fs.promises.readFile(file);
    const r = await client.putObject(bucket, key, buf, { contentType, signal });
    progress(size, size);
    return { etag: r.etag, multipart: false, resumed: false, parts: 1 };
  }
  const store = opts.store;
  const id = uploadId(opts.connId || '', bucket, key, file);
  let state = store ? store.get(id) : null;
  let resumed = false;
  const done = new Map();
  if (state && state.size === size && state.mtimeMs === st.mtimeMs && state.uploadId) {
    try {
      const parts = await client.listParts(bucket, key, state.uploadId);
      for (const p of parts) {
        const expect = p.partNumber * state.partSize > size ? size - (p.partNumber - 1) * state.partSize : state.partSize;
        if (p.size === expect) done.set(p.partNumber, p.etag);
      }
      resumed = true;
    } catch (e) {
      if (e.code !== 'NoSuchUpload' && e.status !== 404) throw e;
      state = null;
    }
  } else if (state && state.uploadId) {
    // The file changed since the unfinished upload began: start again and drop the old parts on the server.
    await client.abortMultipart(bucket, key, state.uploadId).catch(() => {});
    state = null;
  }
  if (!state || !resumed) {
    const partSize = partSizeFor(size, opts.minPart);
    const upId = await client.createMultipart(bucket, key, { contentType });
    state = { v: 1, id, connId: opts.connId || '', bucket, key, file: path.resolve(file), size, mtimeMs: st.mtimeMs, partSize, uploadId: upId, contentType: contentType || '', started: new Date().toISOString() };
    done.clear();
  }
  if (store) store.save(state);
  if (opts.onState) opts.onState(state);
  const total = Math.ceil(size / state.partSize);
  const todo = [];
  for (let n = 1; n <= total; n++) if (!done.has(n)) todo.push(n);
  const alreadyThere = total - todo.length;
  const partLen = (n) => Math.min(state.partSize, size - (n - 1) * state.partSize);
  let sent = 0;
  for (const n of done.keys()) sent += partLen(n);
  progress(sent, size);
  const fd = await fs.promises.open(file, 'r');
  let failure = null;
  try {
    const conc = Math.max(1, Math.min(16, opts.concurrency || 4));
    const worker = async () => {
      while (todo.length && !failure) {
        if (signal && signal.aborted) throw new S3Error('Cancelled', { code: 'Aborted', aborted: true });
        const n = todo.shift();
        const buf = await readPart(fd, (n - 1) * state.partSize, partLen(n));
        const etag = await client.uploadPart(bucket, key, state.uploadId, n, buf, signal);
        done.set(n, etag);
        sent += buf.length;
        progress(sent, size);
      }
    };
    await Promise.all(Array.from({ length: conc }, () => worker().catch((e) => { failure = failure || e; })));
    if (failure) throw failure;
    const st2 = await fs.promises.stat(file);
    if (st2.size !== size || st2.mtimeMs !== st.mtimeMs) throw new S3Error('The file changed while it was uploading.', { code: 'FileChanged' });
  } finally {
    await fd.close();
  }
  const parts = [...done.entries()].map(([partNumber, etag]) => ({ partNumber, etag }));
  const r = await client.completeMultipart(bucket, key, state.uploadId, parts);
  if (store) store.remove(id);
  return { etag: r.etag, multipart: true, resumed, parts: total, resumedParts: resumed ? alreadyThere : 0 };
}

/** Drop an unfinished upload: abort it on the server and forget it. */
async function discardUpload(client, store, state) {
  await client.abortMultipart(state.bucket, state.key, state.uploadId).catch(() => {});
  store.remove(state.id);
}

/**
 * Stream an object to a local file (written to "<dest>.s3x-part", renamed at the end). opts: { versionId, signal,
 * onProgress(got, total), range }. Returns { bytes, etag }.
 */
async function downloadFile(client, bucket, key, dest, opts = {}) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.s3x-part';
  const r = await client.getObjectStream(bucket, key, { versionId: opts.versionId, signal: opts.signal, range: opts.range });
  const total = Number(r.headers['content-length'] || 0);
  let got = 0;
  const counter = new Transform({ transform(chunk, enc, cb) { got += chunk.length; if (opts.onProgress) opts.onProgress(got, total); cb(null, chunk); } });
  try {
    await pipeline(r.stream, counter, fs.createWriteStream(tmp), opts.signal ? { signal: opts.signal } : {});
    if (total && got !== total && !opts.range) throw new S3Error(`The download stopped at ${got} of ${total} bytes.`, { code: 'Truncated' });
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) throw new S3Error('Cancelled', { code: 'Aborted', aborted: true });
    throw e;
  }
  return { bytes: got, etag: String(r.headers.etag || '').replace(/"/g, '') };
}

/** MD5 of a local file, streamed. */
function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = { uploadFile, discardUpload, downloadFile, UploadStore, uploadId, partSizeFor, md5File, MB };
