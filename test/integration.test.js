'use strict';
// Runs against a local S3-compatible server only (never AWS). Start one, for example:
//   docker run -d -p 127.0.0.1:19000:9000 --tmpfs /data:size=1200m,uid=10001,gid=10001 \
//     -e RUSTFS_ACCESS_KEY=s3xtestkey -e RUSTFS_SECRET_KEY=s3xtestsecret123 rustfs/rustfs:latest /data
// then: S3X_TEST_ENDPOINT=http://127.0.0.1:19000 node --test test/integration.test.js
// Without S3X_TEST_ENDPOINT the tests are skipped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { S3Client } = require('../src/s3/client');
const { uploadFile, downloadFile, UploadStore, MB } = require('../src/s3/transfer');
const { planUpload, planDownload, applyPlan } = require('../src/s3/sync');

const EP = process.env.S3X_TEST_ENDPOINT;
if (EP && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(EP)) throw new Error('S3X_TEST_ENDPOINT must be a local server');
const skip = !EP && 'S3X_TEST_ENDPOINT not set';
const creds = { accessKeyId: process.env.S3X_TEST_KEY || 's3xtestkey', secretAccessKey: process.env.S3X_TEST_SECRET || 's3xtestsecret123' };
const mk = (o = {}) => new S3Client({ endpoint: EP, region: 'us-east-1', credentials: async () => creds, ...o });
const B = 's3x-it-' + Date.now().toString(36);
const work = path.join(os.homedir(), 's3-explorer-work', 'it-' + process.pid);

test('integration against a local S3 server', { skip }, async (t) => {
  const c = mk();
  fs.mkdirSync(work, { recursive: true });
  t.after(async () => {
    try {
      const all = [];
      await c.listAll(B, '', (o) => { all.push(...o.map((x) => ({ key: x.key }))); });
      if (all.length) await c.deleteObjects(B, all);
      for (const u of await c.listMultipartUploads(B)) await c.abortMultipart(B, u.key, u.uploadId);
      await c.request({ method: 'DELETE', bucket: B, okStatus: [204, 200, 404, 409] });
    } catch (e) { /* best effort */ }
    fs.rmSync(work, { recursive: true, force: true });
    c.dispose();
  });

  await t.test('create bucket, list buckets', async () => {
    await c.createBucket(B);
    const bs = await c.listBuckets();
    assert.ok(bs.some((b) => b.name === B));
  });

  const weird = ['plain.txt', 'with space/file name.txt', 'unicodé/日本語/ファイル.txt', 'a+b=c&d.txt', 'emoji 🚀.json', 'percent%20literal.txt', 'deep/a/b/c/d.csv'];
  await t.test('put and get keys with spaces, Unicode, + and %', async () => {
    for (const k of weird) await c.putObject(B, k, `content of ${k}`, { contentType: 'text/plain', metadata: { origin: 'test' } });
    for (const k of weird) {
      const { body, info } = await c.getObjectBuffer(B, k);
      assert.strictEqual(body.toString(), `content of ${k}`);
      assert.strictEqual(info.metadata.origin, 'test');
    }
  });

  await t.test('list with delimiter and decoded keys', async () => {
    const top = await c.listObjects(B, { prefix: '' });
    assert.ok(top.folders.includes('with space/'));
    assert.ok(top.folders.includes('unicodé/'));
    assert.ok(top.objects.some((o) => o.key === 'a+b=c&d.txt'));
    assert.ok(top.objects.some((o) => o.key === 'emoji 🚀.json'));
    const sub = await c.listObjects(B, { prefix: 'unicodé/日本語/' });
    assert.deepStrictEqual(sub.objects.map((o) => o.key), ['unicodé/日本語/ファイル.txt']);
  });

  await t.test('paging with continuation tokens', async () => {
    const keys = Array.from({ length: 25 }, (_, i) => `page/k${String(i).padStart(3, '0')}`);
    await Promise.all(keys.map((k) => c.putObject(B, k, 'x')));
    const seen = [];
    let token;
    do { const p = await c.listObjects(B, { prefix: 'page/', maxKeys: 7, continuationToken: token }); seen.push(...p.objects.map((o) => o.key)); token = p.truncated ? p.next : undefined; } while (token);
    assert.deepStrictEqual(seen, keys);
  });

  await t.test('range read, head, copy, tags', async () => {
    const { body } = await c.getObjectBuffer(B, 'plain.txt', { range: [0, 6] });
    assert.strictEqual(body.toString(), 'content');
    const h = await c.headObject(B, 'plain.txt');
    assert.strictEqual(h.size, 'content of plain.txt'.length);
    await c.copyObject(B, 'with space/file name.txt', B, 'copied/ファイル copy.txt');
    assert.strictEqual((await c.getObjectBuffer(B, 'copied/ファイル copy.txt')).body.toString(), 'content of with space/file name.txt');
    await c.putObjectTagging(B, 'plain.txt', [{ key: 'team', value: 'data ml' }, { key: 'env', value: 'test' }]);
    const tags = await c.getObjectTagging(B, 'plain.txt');
    assert.deepStrictEqual(tags.sort((a, b) => a.key.localeCompare(b.key)), [{ key: 'env', value: 'test' }, { key: 'team', value: 'data ml' }]);
  });

  await t.test('presigned GET and PUT work, GET of a deleted object is 404', async () => {
    const url = await c.presign('GET', B, 'with space/file name.txt', 300);
    const r = await fetch(url);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), 'content of with space/file name.txt');
    const put = await c.presign('PUT', B, 'presigned/up load.txt', 300);
    const r2 = await fetch(put, { method: 'PUT', body: 'via presign' });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual((await c.getObjectBuffer(B, 'presigned/up load.txt')).body.toString(), 'via presign');
    await c.putObject(B, 'gone.txt', 'soon gone');
    const gurl = await c.presign('GET', B, 'gone.txt', 300);
    await c.deleteObject(B, 'gone.txt');
    assert.strictEqual((await fetch(gurl)).status, 404);
  });

  await t.test('versioning: list versions and restore an old one', async () => {
    const VB = B + '-v';
    await c.createBucket(VB);
    try {
      await c.putBucketVersioning(VB, true);
      assert.strictEqual(await c.getBucketVersioning(VB), 'Enabled');
      await c.putObject(VB, 'doc.txt', 'v1');
      await c.putObject(VB, 'doc.txt', 'v2');
      const { versions } = await c.listObjectVersions(VB, { prefix: 'doc.txt' });
      assert.strictEqual(versions.length, 2);
      const old = versions.find((v) => !v.isLatest);
      await c.copyObject(VB, 'doc.txt', VB, 'doc.txt', { versionId: old.versionId });
      assert.strictEqual((await c.getObjectBuffer(VB, 'doc.txt')).body.toString(), 'v1');
      const all = (await c.listObjectVersions(VB, {})).versions;
      await c.deleteObjects(VB, all.map((v) => ({ key: v.key, versionId: v.versionId })));
    } finally {
      await c.request({ method: 'DELETE', bucket: VB, okStatus: [204, 200, 404, 409] }).catch(() => {});
    }
  });

  await t.test('multipart upload (40 MB), stop after 2 parts, resume, content identical', async () => {
    const file = path.join(work, 'big.bin');
    const buf = crypto.randomBytes(40 * MB);
    fs.writeFileSync(file, buf);
    const store = new UploadStore(path.join(work, 'uploads'));
    const ac = new AbortController();
    let parts = 0;
    const slow = mk();
    const orig = slow.uploadPart.bind(slow);
    slow.uploadPart = async (...a) => { const r = await orig(...a); if (++parts === 2) ac.abort(); return r; };
    await assert.rejects(uploadFile(slow, { connId: 't', bucket: B, key: 'big/big.bin', file, store, signal: ac.signal, minPart: 5 * MB, concurrency: 1 }), (e) => e.aborted);
    assert.strictEqual(store.list().length, 1);
    const r = await uploadFile(c, { connId: 't', bucket: B, key: 'big/big.bin', file, store, minPart: 5 * MB, concurrency: 3 });
    assert.ok(r.resumed && r.resumedParts >= 2, JSON.stringify(r));
    assert.strictEqual(store.list().length, 0);
    const dest = path.join(work, 'down', 'big.bin');
    await downloadFile(c, B, 'big/big.bin', dest);
    assert.ok(fs.readFileSync(dest).equals(buf));
    slow.dispose();
  });

  await t.test('sync up then down, dry-run plan first, ../ key skipped', async () => {
    const src = path.join(work, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'A');
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'B');
    fs.writeFileSync(path.join(src, '.DS_Store'), 'x');
    let plan = await planUpload({ client: c, bucket: B, prefix: 'sync', root: src, excludes: ['.DS_Store'] });
    assert.deepStrictEqual(plan.create.map((x) => x.key).sort(), ['sync/a.txt', 'sync/sub/b.txt']);
    await applyPlan(plan, { client: c });
    plan = await planUpload({ client: c, bucket: B, prefix: 'sync', root: src, excludes: ['.DS_Store'] });
    assert.strictEqual(plan.create.length + plan.change.length, 0);
    assert.strictEqual(plan.same, 2);
    fs.writeFileSync(path.join(src, 'a.txt'), 'A2');
    plan = await planUpload({ client: c, bucket: B, prefix: 'sync', root: src, excludes: ['.DS_Store'] });
    assert.deepStrictEqual(plan.change.map((x) => x.key), ['sync/a.txt']);
    await applyPlan(plan, { client: c });
    // down (S3-compatible servers refuse ../ keys; the mock-server test covers them)
    const dst = path.join(work, 'dst');
    const dplan = await planDownload({ client: c, bucket: B, prefix: 'sync/', root: dst });
    assert.strictEqual(dplan.create.length, 2);
    await applyPlan(dplan, { client: c });
    assert.strictEqual(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'A2');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'sub', 'b.txt'), 'utf8'), 'B');
  });

  await t.test('wrong secret gives SignatureDoesNotMatch or InvalidAccessKeyId', async () => {
    const bad = new S3Client({ endpoint: EP, region: 'us-east-1', credentials: async () => ({ accessKeyId: creds.accessKeyId, secretAccessKey: 'wrong' }) });
    await assert.rejects(bad.listBuckets(), (e) => /SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/.test(e.code));
    bad.dispose();
  });
});

test('a server that never answers times out with a clear message', async () => {
  const srv = http.createServer(() => { /* never answers */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = new S3Client({ endpoint: `http://127.0.0.1:${srv.address().port}`, region: 'us-east-1', credentials: async () => creds, timeoutMs: 800 });
  const t0 = Date.now();
  await assert.rejects(c.listBuckets(), (e) => e.code === 'Timeout' && /No answer from 127\.0\.0\.1/.test(e.message));
  assert.ok(Date.now() - t0 < 3000);
  c.dispose();
  srv.closeAllConnections && srv.closeAllConnections();
  srv.close();
});
