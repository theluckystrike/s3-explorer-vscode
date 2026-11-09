'use strict';
// Folder <-> prefix sync. plan*() only reads and returns what would change (new, changed, deleted); apply() does it.
// Deletes happen only when the plan was made with deleteExtra and the user confirmed the listed keys.
const fs = require('fs');
const path = require('path');
const { safeLocalPath, localToKey } = require('./paths');
const { uploadFile, downloadFile, md5File } = require('./transfer');

const MD5_LIMIT = 256 * 1024 * 1024; // compare content hashes up to this size, larger files by size and time

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function excluder(patterns) {
  const res = (patterns || []).map(globToRegex);
  return (rel) => res.some((r) => r.test(rel) || r.test(rel.split('/').pop()));
}

/** Every regular file under root (symlinks are not followed). Returns [{ file, rel, size, mtimeMs }]. */
async function walk(root, isExcluded, signal) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'Aborted', aborted: true });
    const relDir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (isExcluded(rel) || isExcluded(rel + '/')) continue;
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile()) {
        const file = path.join(root, ...rel.split('/'));
        try { const st = await fs.promises.stat(file); out.push({ file, rel, size: st.size, mtimeMs: st.mtimeMs }); } catch (err) { /* vanished */ }
      }
    }
  }
  return out;
}

async function listRemote(client, bucket, prefix, signal) {
  const map = new Map();
  await client.listAll(bucket, prefix, (objs) => { for (const o of objs) if (!o.key.endsWith('/')) map.set(o.key, o); }, signal);
  return map;
}

const plainMd5 = (etag) => /^[a-f0-9]{32}$/i.test(etag || '');

async function sameContent(local, remote, direction) {
  if (local.size !== remote.size) return false;
  if (plainMd5(remote.etag) && local.size <= MD5_LIMIT) return (await md5File(local.file)) === remote.etag.toLowerCase();
  const rt = Date.parse(remote.lastModified) || 0;
  // Multipart ETags are not an MD5 of the file: equal size and a not-newer source counts as unchanged.
  return direction === 'up' ? local.mtimeMs <= rt + 2000 : rt <= local.mtimeMs + 2000;
}

function normPrefix(prefix) { return prefix && !prefix.endsWith('/') ? prefix + '/' : (prefix || ''); }

/** Plan local folder -> prefix. */
async function planUpload({ client, bucket, prefix, root, excludes, deleteExtra, signal }) {
  const p = normPrefix(prefix);
  const isExcluded = excluder(excludes);
  const [locals, remote] = await Promise.all([walk(root, isExcluded, signal), listRemote(client, bucket, p, signal)]);
  const plan = { direction: 'up', bucket, prefix: p, root, create: [], change: [], remove: [], same: 0, skipped: [], bytes: 0 };
  const seen = new Set();
  for (const l of locals) {
    const key = localToKey(root, l.file, p);
    if (!key) { plan.skipped.push({ path: l.file, why: 'outside the folder' }); continue; }
    seen.add(key);
    const r = remote.get(key);
    if (!r) { plan.create.push({ key, file: l.file, size: l.size }); plan.bytes += l.size; }
    else if (!(await sameContent(l, r, 'up'))) { plan.change.push({ key, file: l.file, size: l.size, remoteSize: r.size }); plan.bytes += l.size; }
    else plan.same++;
  }
  if (deleteExtra) {
    for (const [key, r] of remote) {
      if (seen.has(key)) continue;
      const rel = key.slice(p.length);
      if (isExcluded(rel)) continue;
      plan.remove.push({ key, size: r.size });
    }
  }
  return plan;
}

/** Plan prefix -> local folder. Keys that would leave the folder are skipped and listed. */
async function planDownload({ client, bucket, prefix, root, excludes, deleteExtra, signal }) {
  const p = normPrefix(prefix);
  const isExcluded = excluder(excludes);
  const [locals, remote] = await Promise.all([walk(root, isExcluded, signal).catch(() => []), listRemote(client, bucket, p, signal)]);
  const byPath = new Map(locals.map((l) => [path.resolve(l.file), l]));
  const plan = { direction: 'down', bucket, prefix: p, root, create: [], change: [], remove: [], same: 0, skipped: [], bytes: 0 };
  const seen = new Set();
  for (const [key, r] of remote) {
    const rel = key.slice(p.length);
    if (isExcluded(rel)) continue;
    const sp = safeLocalPath(root, key, p);
    if (sp.error) { plan.skipped.push({ key, why: sp.error }); continue; }
    seen.add(sp.path);
    const l = byPath.get(sp.path);
    if (!l) { plan.create.push({ key, file: sp.path, size: r.size, etag: r.etag }); plan.bytes += r.size; }
    else if (!(await sameContent(l, r, 'down'))) { plan.change.push({ key, file: sp.path, size: r.size, localSize: l.size }); plan.bytes += r.size; }
    else plan.same++;
  }
  if (deleteExtra) for (const [abs, l] of byPath) if (!seen.has(abs)) plan.remove.push({ file: abs, size: l.size });
  return plan;
}

/**
 * Run a plan. opts: { client, connId, store, concurrency, signal, onProgress({done, total, bytes, totalBytes, current}) }.
 * Returns { done, failed: [{item, error}], deleted }.
 */
async function applyPlan(plan, opts) {
  const { client, signal } = opts;
  const items = [...plan.create, ...plan.change];
  const total = items.length + plan.remove.length;
  let done = 0;
  let bytes = 0;
  const failed = [];
  const report = (current) => opts.onProgress && opts.onProgress({ done, total, bytes, totalBytes: plan.bytes, current });
  const queue = items.slice();
  const worker = async () => {
    while (queue.length) {
      if (signal && signal.aborted) return;
      const it = queue.shift();
      report(it.key);
      try {
        if (plan.direction === 'up') {
          await uploadFile(client, { connId: opts.connId, bucket: plan.bucket, key: it.key, file: it.file, store: opts.store, signal, contentType: opts.contentTypeFor ? opts.contentTypeFor(it.key) : undefined });
        } else {
          const check = safeLocalPath(plan.root, it.key, plan.prefix);
          if (check.error || check.path !== it.file) throw new Error('unsafe path: ' + (check.error || it.file));
          await downloadFile(client, plan.bucket, it.key, it.file, { signal });
        }
        bytes += it.size;
      } catch (e) {
        if (e && e.aborted) return;
        failed.push({ item: it, error: e && e.message ? e.message : String(e) });
      }
      done++;
      report(it.key);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, opts.concurrency || 4)) }, worker));
  let deleted = 0;
  if (plan.remove.length && !(signal && signal.aborted)) {
    if (plan.direction === 'up') {
      const r = await client.deleteObjects(plan.bucket, plan.remove.map((x) => ({ key: x.key })));
      deleted = r.deleted.length;
      for (const e of r.errors) failed.push({ item: { key: e.key }, error: e.message || e.code });
    } else {
      const rootAbs = path.resolve(plan.root) + path.sep;
      for (const x of plan.remove) {
        if (!path.resolve(x.file).startsWith(rootAbs)) continue;
        try { await fs.promises.unlink(x.file); deleted++; } catch (e) { failed.push({ item: x, error: e.message }); }
      }
    }
    done += plan.remove.length;
    report('');
  }
  return { done, failed, deleted, cancelled: !!(signal && signal.aborted) };
}

module.exports = { planUpload, planDownload, applyPlan, walk, excluder, globToRegex, sameContent };
