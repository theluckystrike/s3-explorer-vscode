'use strict';
// A small S3-like server for tests and the VS Code gate (path-style only, 127.0.0.1). It does not check signatures
// (the RustFS integration test does); it checks the access key ID, counts requests, and has special buckets:
//   million   1,000,000 generated keys k0000000.json .. k0999999.json plus logs/ (nothing stored)
//   hostile   keys like ../../outside.txt, /abs.txt, a/../../b.txt (allowed by AWS, refused by MinIO)
//   eu-bucket answers 301 + x-amz-bucket-region: eu-west-1 unless the request is signed for eu-west-1
//   never     never answers
//   anything else: in-memory objects; multipart parts are hashed (MD5) and dropped, so a 5 GB upload needs no disk
// Run alone: node test/helpers/mock-s3.js [port]  -> prints {"port": n}
const http = require('http');
const crypto = require('crypto');

const N_MILLION = 1000000;
const pad7 = (i) => String(i).padStart(7, '0');
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const urlEnc = (s) => encodeURIComponent(s).replace(/%2F/g, '/').replace(/%20/g, '+');

function createMock({ accessKeyId = 'mockkey', objectBytes = 64 } = {}) {
  const buckets = new Map(); // name -> Map(key -> {body?, size, etag, lastModified, parts?})
  const uploads = new Map(); // uploadId -> {bucket, key, parts: Map(n -> {size, md5})}
  const stats = { total: 0, byBucket: {}, byOp: {}, denied: 0 };
  const hostile = new Map();
  for (const k of ['../../outside.txt', 'ok/fine.txt', '/abs.txt', 'a/../../b.txt', 'C:/win.txt', 'dir/..\\..\\x.txt', 'nul/con.txt', '..']) hostile.set(k, { body: Buffer.from('hostile ' + k), etag: '', lastModified: new Date().toISOString() });
  for (const v of hostile.values()) { v.size = v.body.length; v.etag = crypto.createHash('md5').update(v.body).digest('hex'); }
  buckets.set('hostile', hostile);
  const eu = new Map([['hello.txt', { body: Buffer.from('hello from eu-west-1'), size: 19, etag: '', lastModified: new Date().toISOString() }]]);
  buckets.set('eu-bucket', eu);
  buckets.set('million', null);
  buckets.set('big', new Map());
  buckets.set('never', new Map());

  const millionObj = (i) => ({ key: `k${pad7(i)}.json`, size: objectBytes, etag: crypto.createHash('md5').update(`{"i":${i}}`).digest('hex'), lastModified: '2026-11-01T00:00:00.000Z' });
  const millionLogs = ['logs/2026-11-01.log', 'logs/2026-11-02.log', 'logs/2026-11-03.log'];

  function xml(res, status, body, headers = {}) {
    const b = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' + body);
    res.writeHead(status, Object.assign({ 'content-type': 'application/xml', 'content-length': b.length, 'x-amz-request-id': 'mock' }, headers));
    res.end(b);
  }
  const err = (res, status, code, msg, headers) => xml(res, status, `<Error><Code>${code}</Code><Message>${xmlEsc(msg)}</Message></Error>`, headers);

  function readBody(req) {
    return new Promise((resolve, reject) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });
  }

  /** Generic listing over sorted keys. */
  function listGeneric(keys, { prefix, delimiter, startAfter, maxKeys }) {
    const folders = [];
    const objects = [];
    let next;
    const seenFolders = new Set();
    let count = 0;
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      if (startAfter && k <= startAfter) continue;
      let entry;
      if (delimiter) {
        const rest = k.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) {
          const f = prefix + rest.slice(0, i + delimiter.length);
          if (seenFolders.has(f)) continue;
          seenFolders.add(f);
          entry = { folder: f, last: k };
        }
      }
      if (count >= maxKeys) { next = true; break; }
      if (entry) { folders.push(entry.folder); next = entry.folder; } else { objects.push(k); }
      count++;
      if (!entry) next = k;
    }
    return { folders, objects, truncated: next === true, lastKey: null };
  }

  function listMillion(q) {
    const prefix = q.prefix || '';
    const max = Math.min(1000, Number(q['max-keys'] || 1000));
    let start = q['continuation-token'] ? Number(Buffer.from(q['continuation-token'], 'base64').toString()) : 0;
    // index range of k-keys that match the prefix
    let lo = 0, hi = N_MILLION;
    if (prefix) {
      if (prefix.startsWith('k')) {
        const digits = prefix.slice(1);
        if (/^\d{0,7}$/.test(digits)) { const span = 10 ** (7 - digits.length); const d = digits ? Number(digits) : 0; lo = d * span; hi = Math.min(N_MILLION, (d + 1) * span); } else { lo = hi = 0; }
      } else { lo = hi = 0; }
    }
    const objs = [];
    const folders = [];
    let i = Math.max(lo, start);
    while (i < hi && objs.length < max) { objs.push(millionObj(i)); i++; }
    let truncated = i < hi;
    let token;
    if (truncated) token = Buffer.from(String(i)).toString('base64');
    // logs/ comes after all k keys
    const wantLogs = 'logs/'.startsWith(prefix) || prefix.startsWith('logs/');
    if (!truncated && wantLogs && objs.length < max && start <= N_MILLION) {
      if (q.delimiter === '/' && !prefix.startsWith('logs/')) folders.push('logs/');
      else for (const k of millionLogs) if (k.startsWith(prefix)) objs.push({ key: k, size: 10, etag: 'abc', lastModified: '2026-11-01T00:00:00.000Z' });
    }
    return { objs, folders, truncated, token };
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams.entries());
    const parts = u.pathname.split('/');
    const bucket = decodeURIComponent(parts[1] || '');
    const key = parts.slice(2).map(decodeURIComponent).join('/');
    if (u.pathname === '/__object') { const b0 = buckets.get(u.searchParams.get('bucket')); const o = b0 && b0.get(u.searchParams.get('key')); const b = Buffer.from(JSON.stringify(o ? Object.assign({}, o, { body: undefined }) : null)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); return; }
    if (u.pathname === '/__uploads') { const b = Buffer.from(JSON.stringify([...uploads.entries()].map(([id, v]) => ({ id, bucket: v.bucket, key: v.key, parts: v.parts.size })))); res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); return; }
    if (u.pathname === '/__stats') { const b = Buffer.from(JSON.stringify(stats)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); return; }
    stats.total++;
    stats.byBucket[bucket || '/'] = (stats.byBucket[bucket || '/'] || 0) + 1;
    const op = `${req.method} ${key ? 'object' : bucket ? 'bucket' : 'service'}${Object.keys(q).filter((k) => !k.startsWith('X-Amz')).map((k) => '?' + k).join('')}`;
    stats.byOp[op] = (stats.byOp[op] || 0) + 1;
    const auth = req.headers.authorization || '';
    const qcred = q['X-Amz-Credential'] || '';
    const cred = /Credential=([^/]+)\/\d{8}\/([^/]+)\//.exec(auth) || /^([^/]+)\/\d{8}\/([^/]+)\//.exec(qcred);
    if (!cred || cred[1] !== accessKeyId) { stats.denied++; await readBody(req); err(res, 403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.'); return; }
    const region = cred[2];
    if (bucket === 'never') return; // never answer
    if (bucket === 'eu-bucket' && region !== 'eu-west-1') { await readBody(req); if (req.method === 'HEAD') { res.writeHead(301, { 'x-amz-bucket-region': 'eu-west-1' }); res.end(); return; } err(res, 301, 'PermanentRedirect', 'The bucket you are attempting to access must be addressed using the specified endpoint.', { 'x-amz-bucket-region': 'eu-west-1' }); return; }
    try {
      // service
      if (!bucket) {
        const names = [...buckets.keys()].filter((b) => b !== 'never');
        xml(res, 200, `<ListAllMyBucketsResult><Owner><ID>mock</ID></Owner><Buckets>${names.map((b) => `<Bucket><Name>${xmlEsc(b)}</Name><CreationDate>2026-11-01T00:00:00.000Z</CreationDate></Bucket>`).join('')}</Buckets></ListAllMyBucketsResult>`);
        return;
      }
      if (!buckets.has(bucket)) {
        if (req.method === 'PUT' && !key) { buckets.set(bucket, new Map()); res.writeHead(200, { 'content-length': 0 }); res.end(); return; }
        await readBody(req); err(res, 404, 'NoSuchBucket', 'The specified bucket does not exist'); return;
      }
      const store = buckets.get(bucket);
      // bucket-level
      if (!key) {
        if (req.method === 'GET' && 'versioning' in q) { xml(res, 200, '<VersioningConfiguration/>'); return; }
        if (req.method === 'GET' && 'uploads' in q) { xml(res, 200, `<ListMultipartUploadsResult>${[...uploads.entries()].filter(([, v]) => v.bucket === bucket).map(([id, v]) => `<Upload><Key>${xmlEsc(v.key)}</Key><UploadId>${id}</UploadId></Upload>`).join('')}</ListMultipartUploadsResult>`); return; }
        if (req.method === 'POST' && 'delete' in q) {
          const body = (await readBody(req)).toString();
          const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
          for (const k of keys) if (store) store.delete(k);
          xml(res, 200, `<DeleteResult>${keys.map((k) => `<Deleted><Key>${xmlEsc(k)}</Key></Deleted>`).join('')}</DeleteResult>`);
          return;
        }
        if (req.method === 'HEAD') { res.writeHead(200, { 'x-amz-bucket-region': 'us-east-1' }); res.end(); return; }
        if (req.method === 'GET' && q['list-type'] === '2') {
          const enc = q['encoding-type'] === 'url';
          const ek = (k) => (enc ? urlEnc(k) : xmlEsc(k));
          let objs, folders, truncated, token;
          if (bucket === 'million') ({ objs, folders, truncated, token } = listMillion(q));
          else {
            const keys = [...store.keys()].sort();
            const start = q['continuation-token'] ? Buffer.from(q['continuation-token'], 'base64').toString() : (q['start-after'] || '');
            const r = listGeneric(keys, { prefix: q.prefix || '', delimiter: q.delimiter || '', startAfter: start, maxKeys: Math.min(1000, Number(q['max-keys'] || 1000)) });
            objs = r.objects.map((k) => Object.assign({ key: k }, store.get(k)));
            folders = r.folders;
            truncated = r.truncated;
            const last = [...r.objects, ...r.folders].sort().pop();
            if (truncated && last) token = Buffer.from(last.endsWith('/') ? last + '\uffff' : last).toString('base64');
          }
          xml(res, 200, `<ListBucketResult><Name>${xmlEsc(bucket)}</Name><Prefix>${ek(q.prefix || '')}</Prefix>${enc ? '<EncodingType>url</EncodingType>' : ''}<KeyCount>${objs.length + folders.length}</KeyCount><MaxKeys>${q['max-keys'] || 1000}</MaxKeys><IsTruncated>${truncated ? 'true' : 'false'}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''}`
            + objs.map((o) => `<Contents><Key>${ek(o.key)}</Key><LastModified>${o.lastModified}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')
            + folders.map((f) => `<CommonPrefixes><Prefix>${ek(f)}</Prefix></CommonPrefixes>`).join('') + '</ListBucketResult>');
          return;
        }
        await readBody(req); err(res, 400, 'NotImplemented', 'Not in the mock'); return;
      }
      // object-level
      if (bucket === 'million') {
        const m = /^k(\d{7})\.json$/.exec(key);
        const i = m ? Number(m[1]) : -1;
        if (i < 0 || i >= N_MILLION) { err(res, 404, 'NoSuchKey', 'The specified key does not exist.'); return; }
        const body = Buffer.from(JSON.stringify({ i, key }).padEnd(objectBytes, ' '));
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, etag: `"${millionObj(i).etag}"`, 'last-modified': new Date('2026-11-01').toUTCString() });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      if (req.method === 'POST' && 'uploads' in q) { await readBody(req); const id = crypto.randomBytes(8).toString('hex'); uploads.set(id, { bucket, key, parts: new Map() }); xml(res, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xmlEsc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return; }
      if (q.uploadId) {
        const up = uploads.get(q.uploadId);
        if (!up) { await readBody(req); err(res, 404, 'NoSuchUpload', 'The specified upload does not exist.'); return; }
        if (req.method === 'PUT' && q.partNumber) {
          const h = crypto.createHash('md5');
          let size = 0;
          await new Promise((resolve, reject) => { req.on('data', (d) => { h.update(d); size += d.length; }); req.on('end', resolve); req.on('error', reject); });
          const md5 = h.digest('hex');
          up.parts.set(Number(q.partNumber), { size, md5 });
          res.writeHead(200, { etag: `"${md5}"`, 'content-length': 0 }); res.end(); return;
        }
        if (req.method === 'GET') { xml(res, 200, `<ListPartsResult><UploadId>${q.uploadId}</UploadId><IsTruncated>false</IsTruncated>${[...up.parts.entries()].sort((a, b) => a[0] - b[0]).map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>"${p.md5}"</ETag><Size>${p.size}</Size></Part>`).join('')}</ListPartsResult>`); return; }
        if (req.method === 'DELETE') { uploads.delete(q.uploadId); res.writeHead(204); res.end(); return; }
        if (req.method === 'POST') {
          await readBody(req);
          const ps = [...up.parts.entries()].sort((a, b) => a[0] - b[0]);
          const size = ps.reduce((a, [, p]) => a + p.size, 0);
          const etag = crypto.createHash('md5').update(Buffer.concat(ps.map(([, p]) => Buffer.from(p.md5, 'hex')))).digest('hex') + '-' + ps.length;
          store.set(key, { size, etag, lastModified: new Date().toISOString(), parts: ps.map(([n, p]) => ({ n, size: p.size, md5: p.md5 })) });
          uploads.delete(q.uploadId);
          xml(res, 200, `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xmlEsc(key)}</Key><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`);
          return;
        }
      }
      if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
        await readBody(req);
        const src = decodeURIComponent(String(req.headers['x-amz-copy-source']).split('?')[0]).replace(/^\//, '');
        const sb = src.slice(0, src.indexOf('/')); const sk = src.slice(src.indexOf('/') + 1);
        const so = buckets.get(sb) && buckets.get(sb).get(sk);
        if (!so) { err(res, 404, 'NoSuchKey', 'The specified key does not exist.'); return; }
        store.set(key, Object.assign({}, so, { lastModified: new Date().toISOString() }));
        xml(res, 200, `<CopyObjectResult><ETag>"${so.etag}"</ETag></CopyObjectResult>`);
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const etag = crypto.createHash('md5').update(body).digest('hex');
        store.set(key, { body, size: body.length, etag, lastModified: new Date().toISOString(), contentType: req.headers['content-type'] });
        res.writeHead(200, { etag: `"${etag}"`, 'content-length': 0 }); res.end(); return;
      }
      if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && 'tagging' in q) { xml(res, 200, '<Tagging><TagSet></TagSet></Tagging>'); return; }
      const o = store.get(key);
      if (!o) { if (req.method === 'HEAD') { res.writeHead(404); res.end(); return; } err(res, 404, 'NoSuchKey', 'The specified key does not exist.'); return; }
      const headers = { 'content-type': o.contentType || 'application/octet-stream', etag: `"${o.etag}"`, 'last-modified': new Date(o.lastModified).toUTCString(), 'accept-ranges': 'bytes' };
      if (!o.body) { // multipart object without stored bytes: serve zeros (sparse test files are zeros)
        headers['content-length'] = o.size;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') { res.end(); return; }
        const chunk = Buffer.alloc(1024 * 1024);
        let left = o.size;
        const pump = () => { while (left > 0) { const n = Math.min(left, chunk.length); left -= n; if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { res.once('drain', pump); return; } } res.end(); };
        pump();
        return;
      }
      let body = o.body;
      let status = 200;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) { const a = Number(range[1]); const b = range[2] ? Math.min(Number(range[2]), o.size - 1) : o.size - 1; body = o.body.subarray(a, b + 1); status = 206; headers['content-range'] = `bytes ${a}-${b}/${o.size}`; }
      headers['content-length'] = body.length;
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      try { err(res, 500, 'InternalError', e.message); } catch (e2) { /* closed */ }
    }
  });
  return { server, buckets, uploads, stats, accessKeyId };
}

function start(port = 0, opts) {
  const m = createMock(opts);
  return new Promise((resolve) => m.server.listen(port, '127.0.0.1', () => { m.port = m.server.address().port; m.endpoint = `http://127.0.0.1:${m.port}`; resolve(m); }));
}

module.exports = { createMock, start, N_MILLION };

if (require.main === module) {
  start(Number(process.argv[2] || 0), { accessKeyId: process.env.MOCK_KEY || 'mockkey' }).then((m) => process.stdout.write(JSON.stringify({ port: m.port }) + '\n'));
}
