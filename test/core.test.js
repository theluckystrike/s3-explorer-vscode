'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sign, presign, uriEncode } = require('../src/s3/sigv4');
const xml = require('../src/s3/xml');
const { keyToRelative, safeLocalPath, localToKey, parentPrefix, baseName } = require('../src/s3/paths');
const { S3Client, dnsCompatible, errorFromResponse } = require('../src/s3/client');
const { partSizeFor, MB } = require('../src/s3/transfer');
const { globToRegex, excluder } = require('../src/s3/sync');
const { contentTypeFor, isTextKey, viewerFor } = require('../src/types');
const { keyList, describeError, fmtBytes } = require('../src/ui');

const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

test('SigV4 matches the AWS documentation example (GET Object with Range)', () => {
  const h = sign({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: {}, headers: { range: 'bytes=0-9' }, creds: AWS, region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') });
  assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.match(h.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
});

test('SigV4 matches the AWS documentation example (GET Bucket lifecycle and list)', () => {
  const h = sign({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/', query: { 'max-keys': '2', prefix: 'J' }, creds: AWS, region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') });
  assert.match(h.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
});

test('presigned URL matches the AWS documentation example', () => {
  const url = presign({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', creds: AWS, region: 'us-east-1', expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  assert.ok(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256'));
});

test('presign caps expiry at 7 days and adds the session token', () => {
  const url = presign({ method: 'GET', host: 'h', path: '/k', creds: Object.assign({ sessionToken: 'tok/en' }, AWS), region: 'us-east-1', expires: 10 ** 9 });
  assert.match(url, /X-Amz-Expires=604800/);
  assert.match(url, /X-Amz-Security-Token=tok%2Fen/);
});

test('uriEncode keeps unreserved characters and encodes the rest as UTF-8', () => {
  assert.strictEqual(uriEncode('a b/c+d~é', false), 'a%20b/c%2Bd~%C3%A9');
  assert.strictEqual(uriEncode('a/b'), 'a%2Fb');
});

test('XML reader: entities, CDATA, namespaces; refuses DOCTYPE', () => {
  const d = xml.parse('<?xml version="1.0"?><r xmlns="x"><a>1 &amp; 2 &#x263A;</a><b><![CDATA[<raw>]]></b><s:c>z</s:c></r>');
  assert.strictEqual(xml.textOf(d, 'a'), '1 & 2 ☺');
  assert.strictEqual(xml.textOf(d, 'b'), '<raw>');
  assert.strictEqual(xml.textOf(d, 'c'), 'z');
  assert.throws(() => xml.parse('<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>'), /DOCTYPE/);
  assert.throws(() => xml.parse('<a><b></a>'), /Broken XML/);
  assert.throws(() => xml.parse('<a>'.repeat(100) + '</a>'.repeat(100)), /deep/);
});

test('keys never map outside the target folder', () => {
  const root = path.join(os.tmpdir(), 's3x-root');
  for (const bad of ['../../.ssh/config', 'a/../../b', '..', './x', 'a/./b', 'C:/Windows/x', 'x\0y', 'dir/..\\..\\x']) {
    const r = safeLocalPath(root, bad);
    assert.ok(r.error, `should refuse ${bad}`);
  }
  assert.strictEqual(safeLocalPath(root, '/abs.txt').path, path.join(root, 'abs.txt'));
  assert.strictEqual(safeLocalPath(root, 'a//b///c.txt').path, path.join(root, 'a', 'b', 'c.txt'));
  assert.strictEqual(safeLocalPath(root, 'logs/2026/x.log', 'logs/').path, path.join(root, '2026', 'x.log'));
  assert.ok(safeLocalPath(root, 'folder/').error);
  assert.strictEqual(keyToRelative('a:b?/con.txt', '', 'win32').rel, ['a_b_', '_con.txt'].join(path.sep));
  assert.strictEqual(keyToRelative('trailing. ', '', 'win32').rel, 'trailing__');
});

test('local paths become keys with forward slashes', () => {
  const root = path.join(os.tmpdir(), 'r');
  assert.strictEqual(localToKey(root, path.join(root, 'a', 'b.txt'), 'p'), 'p/a/b.txt');
  assert.strictEqual(localToKey(root, path.join(root, 'b.txt'), ''), 'b.txt');
  assert.strictEqual(localToKey(root, path.join(os.tmpdir(), 'x.txt'), ''), null);
  assert.strictEqual(parentPrefix('a/b/c.txt'), 'a/b/');
  assert.strictEqual(parentPrefix('a/b/'), 'a/');
  assert.strictEqual(baseName('a/b/'), 'b');
});

test('client builds AWS virtual-hosted, path-style and custom endpoint URLs', () => {
  const c = new S3Client({ region: 'eu-central-1', credentials: async () => AWS });
  assert.deepStrictEqual([c.target('my-bucket', 'a b/c.txt').host, c.target('my-bucket', 'a b/c.txt').path], ['my-bucket.s3.eu-central-1.amazonaws.com', '/a%20b/c.txt']);
  assert.deepStrictEqual([c.target('my.dotted.bucket', 'k').host, c.target('my.dotted.bucket', 'k').path], ['s3.eu-central-1.amazonaws.com', '/my.dotted.bucket/k']);
  assert.strictEqual(c.target().host, 's3.eu-central-1.amazonaws.com');
  c.bucketRegion.set('far', 'ap-southeast-2');
  assert.strictEqual(c.target('far', 'k').host, 'far.s3.ap-southeast-2.amazonaws.com');
  const m = new S3Client({ endpoint: 'http://127.0.0.1:9000/', region: 'us-east-1', credentials: async () => AWS });
  assert.deepStrictEqual([m.target('b', 'k/é').host, m.target('b', 'k/é').path], ['127.0.0.1:9000', '/b/k/%C3%A9']);
  const r2 = new S3Client({ endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', credentials: async () => AWS });
  assert.strictEqual(r2.target('b', 'k').host, 'acc.r2.cloudflarestorage.com');
  const vh = new S3Client({ endpoint: 'https://nyc3.digitaloceanspaces.com', pathStyle: false, region: 'nyc3', credentials: async () => AWS });
  assert.strictEqual(vh.target('space', 'k').host, 'space.nyc3.digitaloceanspaces.com');
  assert.throws(() => new S3Client({ endpoint: 'ftp://x', credentials: async () => AWS }), /https/);
  assert.ok(dnsCompatible('abc-1') && !dnsCompatible('ABC') && !dnsCompatible('a..b'));
  for (const x of [c, m, r2, vh]) x.dispose();
});

test('error parsing keeps the region hint only for redirects', () => {
  const e = errorFromResponse(301, { 'x-amz-bucket-region': 'eu-west-1' }, Buffer.from('<Error><Code>PermanentRedirect</Code><Message>m</Message></Error>'), 'GET', 'h');
  assert.strictEqual(e.region, 'eu-west-1');
  const d = errorFromResponse(403, { 'x-amz-bucket-region': 'eu-west-1' }, Buffer.from('<Error><Code>AccessDenied</Code><Message>no</Message></Error>'), 'GET', 'h');
  assert.strictEqual(d.region, '');
  assert.strictEqual(d.code, 'AccessDenied');
  assert.strictEqual(errorFromResponse(404, {}, Buffer.alloc(0), 'HEAD', 'h').code, 'NotFound');
});

test('part size keeps uploads under 10,000 parts', () => {
  assert.strictEqual(partSizeFor(100 * MB), 8 * MB);
  const p = partSizeFor(5 * 1024 ** 4);
  assert.ok(Math.ceil((5 * 1024 ** 4) / p) <= 9900);
  assert.ok(partSizeFor(10 * MB, 1 * MB) >= 5 * MB);
});

test('glob excludes', () => {
  const ex = excluder(['.git/**', 'node_modules/**', '.DS_Store', '*.tmp']);
  assert.ok(ex('.git/config') && ex('node_modules/a/b.js') && ex('sub/.DS_Store') && ex('x.tmp'));
  assert.ok(!ex('src/a.js') && !ex('gitignore'));
  assert.ok(globToRegex('a/**/b').test('a/x/y/b'));
});

test('types: text keys, content types and viewers', () => {
  assert.ok(isTextKey('a/b.json') && isTextKey('Dockerfile') && isTextKey('noext') && !isTextKey('x.pdf') && !isTextKey('x.parquet'));
  assert.strictEqual(contentTypeFor('a.csv'), 'text/csv');
  assert.strictEqual(contentTypeFor('a.bin'), 'application/octet-stream');
  assert.strictEqual(viewerFor('report.PDF').id, 'zovo.pdf-viewer-dark');
  assert.strictEqual(viewerFor('t.parquet').id, 'zovo.table-viewer-vscode');
  assert.ok(viewerFor('a.csv').preferViewer);
  assert.strictEqual(viewerFor('a.txt'), null);
});

test('confirmation lists keys and says how many more', () => {
  const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
  const t = keyList('b', keys);
  assert.ok(t.startsWith('s3://b/k0\ns3://b/k1'));
  assert.match(t, /\.\.\. and 25 more$/);
  assert.strictEqual(t.split('\n').length, 16);
});

test('errors read in plain language with a next step', () => {
  assert.deepStrictEqual(describeError({ code: 'InvalidAccessKeyId' }, { name: 'R2' }).actions, ['Edit Connection']);
  assert.match(describeError({ code: 'SignatureDoesNotMatch' }, { name: 'R2' }).message, /secret key does not match/);
  assert.match(describeError({ code: 'Timeout', message: 'No answer from h in 30 seconds.' }).message, /VPN or proxy/);
  assert.strictEqual(fmtBytes(1536), '1.50 KB');
});

test('no module outside the S3 client, credentials and license opens network connections', () => {
  const src = path.join(__dirname, '..', 'src');
  const files = [];
  const walkDir = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkDir(p); else if (p.endsWith('.js')) files.push(p); } };
  walkDir(src);
  const allowed = new Set(['s3/client.js', 's3/credentials.js', 'license/sponsors.js', 'license/index.js', 'license/license.js']);
  for (const f of files) {
    const rel = path.relative(src, f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    if (/require\('(https?|net|tls|dgram)'\)|\bfetch\(|XMLHttpRequest|WebSocket/.test(text)) assert.ok(allowed.has(rel), `${rel} must not open network connections`);
  }
});
