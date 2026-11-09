'use strict';
// Against the in-process mock server: 1,000,000-key bucket, hostile keys, region redirect, wrong key, timeouts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { start } = require('./helpers/mock-s3');
const { S3Client } = require('../src/s3/client');
const { planDownload, applyPlan } = require('../src/s3/sync');
const { uploadFile, UploadStore, MB } = require('../src/s3/transfer');

let mock;
const mk = (o = {}) => new S3Client({ endpoint: mock.endpoint, region: 'us-east-1', credentials: async () => ({ accessKeyId: 'mockkey', secretAccessKey: 'x' }), ...o });
test.before(async () => { mock = await start(0); });
test.after(() => { mock.server.closeAllConnections && mock.server.closeAllConnections(); mock.server.close(); });

test('1,000,000-key bucket: first page fast, paging, prefix search', async () => {
  const c = mk();
  const t0 = Date.now();
  const p1 = await c.listObjects('million', {});
  const ms = Date.now() - t0;
  assert.strictEqual(p1.objects.length, 1000);
  assert.ok(p1.truncated && p1.next);
  assert.ok(ms < 1500, `first page took ${ms} ms`);
  const p2 = await c.listObjects('million', { continuationToken: p1.next });
  assert.strictEqual(p2.objects[0].key, 'k0001000.json');
  const s = await c.listObjects('million', { prefix: 'k099999' });
  assert.strictEqual(s.objects.length, 10);
  assert.strictEqual(s.objects[9].key, 'k0999999.json');
  const last = await c.listObjects('million', { prefix: 'k0999' });
  assert.strictEqual(last.objects.length, 1000);
  assert.ok(!last.truncated);
  c.dispose();
});

test('download plan skips keys that would leave the folder; nothing is written outside', async (t) => {
  const c = mk();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 's3x-hostile-'));
  const root = path.join(work, 'target');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const plan = await planDownload({ client: c, bucket: 'hostile', prefix: '', root });
  const skipped = plan.skipped.map((s) => s.key).sort();
  assert.deepStrictEqual(skipped, ['..', '../../outside.txt', 'C:/win.txt', 'a/../../b.txt', 'dir/..\\..\\x.txt'].sort());
  const r = await applyPlan(plan, { client: c });
  assert.strictEqual(r.failed.length, 0);
  const all = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(path.relative(work, p)); } };
  walk(work);
  for (const f of all) assert.ok(f.startsWith('target' + path.sep), `wrote ${f} outside the target`);
  assert.ok(fs.existsSync(path.join(root, 'ok', 'fine.txt')));
  assert.ok(fs.existsSync(path.join(root, 'abs.txt')));
  c.dispose();
});

test('a bucket in another region: one redirect, then signed for that region', async () => {
  const c = mk();
  const { body } = await c.getObjectBuffer('eu-bucket', 'hello.txt');
  assert.strictEqual(body.toString(), 'hello from eu-west-1');
  assert.strictEqual(c.bucketRegion.get('eu-bucket'), 'eu-west-1');
  c.dispose();
});

test('parallel requests to a bucket in another region all succeed', async () => {
  const c = mk();
  const r = await Promise.all([c.headObject('eu-bucket', 'hello.txt'), c.getObjectBuffer('eu-bucket', 'hello.txt'), c.getObjectBuffer('eu-bucket', 'hello.txt')]);
  assert.strictEqual(r[1].body.toString(), 'hello from eu-west-1');
  c.dispose();
});

test('wrong access key: InvalidAccessKeyId, no retry storm', async () => {
  const before = mock.stats.denied;
  const c = new S3Client({ endpoint: mock.endpoint, region: 'us-east-1', credentials: async () => ({ accessKeyId: 'wrong', secretAccessKey: 'x' }) });
  await assert.rejects(c.listBuckets(), (e) => e.code === 'InvalidAccessKeyId');
  assert.strictEqual(mock.stats.denied - before, 1);
  c.dispose();
});

test('a bucket that never answers times out with a clear message', async () => {
  const c = mk({ timeoutMs: 700 });
  const t0 = Date.now();
  await assert.rejects(c.listObjects('never', {}), (e) => e.code === 'Timeout' && /No answer from 127\.0\.0\.1:\d+ in 1 seconds?\./.test(e.message));
  assert.ok(Date.now() - t0 < 2500);
  c.dispose();
});

test('cancel stops a multipart upload; resume sends only the missing parts', async (t) => {
  const c = mk();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 's3x-mp-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const file = path.join(work, 'f.bin');
  const buf = crypto.randomBytes(30 * MB);
  fs.writeFileSync(file, buf);
  const store = new UploadStore(path.join(work, 'up'));
  const ac = new AbortController();
  let n = 0;
  await assert.rejects(uploadFile(c, { connId: 'm', bucket: 'big', key: 'f.bin', file, store, minPart: 5 * MB, concurrency: 1, signal: ac.signal, onProgress: () => { if (++n === 3) ac.abort(); } }), (e) => e.aborted);
  const st = store.list()[0];
  assert.ok(st && st.uploadId);
  const partsBefore = mock.uploads.get(st.uploadId).parts.size;
  assert.ok(partsBefore >= 1 && partsBefore < 6);
  const putsBefore = mock.stats.byOp['PUT object?partNumber?uploadId'] || 0;
  const r = await uploadFile(c, { connId: 'm', bucket: 'big', key: 'f.bin', file, store, minPart: 5 * MB, concurrency: 3 });
  assert.ok(r.resumed);
  assert.strictEqual((mock.stats.byOp['PUT object?partNumber?uploadId'] || 0) - putsBefore, 6 - partsBefore);
  const obj = mock.buckets.get('big').get('f.bin');
  assert.strictEqual(obj.size, buf.length);
  for (const p of obj.parts) assert.strictEqual(p.md5, crypto.createHash('md5').update(buf.subarray((p.n - 1) * 5 * MB, p.n * 5 * MB)).digest('hex'));
  assert.strictEqual(store.list().length, 0);
  c.dispose();
});

test('a changed local file restarts the upload instead of mixing parts', async (t) => {
  const c = mk();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 's3x-mp2-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const file = path.join(work, 'g.bin');
  fs.writeFileSync(file, crypto.randomBytes(12 * MB));
  const store = new UploadStore(path.join(work, 'up'));
  const ac = new AbortController();
  await assert.rejects(uploadFile(c, { connId: 'm', bucket: 'big', key: 'g.bin', file, store, threshold: 5 * MB, minPart: 5 * MB, concurrency: 1, signal: ac.signal, onProgress: (s) => { if (s > 0) ac.abort(); } }), (e) => e.aborted);
  const old = store.list()[0].uploadId;
  fs.appendFileSync(file, 'x');
  const r = await uploadFile(c, { connId: 'm', bucket: 'big', key: 'g.bin', file, store, threshold: 5 * MB, minPart: 5 * MB });
  assert.ok(!r.resumed);
  assert.ok(!mock.uploads.has(old), 'old upload aborted');
  assert.strictEqual(mock.buckets.get('big').get('g.bin').size, 12 * MB + 1);
  c.dispose();
});
