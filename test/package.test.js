'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pk = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const Module = require('module');

// A tiny vscode stand-in, enough to load the modules that need it.
const fakeVscode = { window: {}, commands: { executeCommand() {}, registerCommand: () => ({ dispose() {} }) }, workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, Uri: { parse: (s) => ({ toString: () => s }) } };
const origLoad = Module._load;
Module._load = function load(req, ...a) { return req === 'vscode' ? fakeVscode : origLoad.call(this, req, ...a); };
const panels = require('../src/panels');
const { createPro, FREE_TRIES, FEATURES } = require('../src/pro');

test('every command registered in the code is listed in package.json and the other way round', () => {
  const src = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8');
  const registered = new Set([...src.matchAll(/reg\('(s3Explorer\.[\w]+)'/g)].map((m) => m[1]));
  for (const c of ['supportDeveloper', 'moreViewers', 'unlockWithSponsors', 'getPro', 'enterLicenseKey', 'removeLicense']) registered.add('s3Explorer.' + c);
  const listed = new Set(pk.contributes.commands.map((c) => c.command));
  for (const c of registered) assert.ok(listed.has(c), `${c} missing in package.json`);
  for (const c of listed) assert.ok(registered.has(c), `${c} listed but never registered`);
  for (const m of Object.values(pk.contributes.menus).flat()) assert.ok(listed.has(m.command), `menu ${m.command}`);
});

test('engines floor for Cursor and Windsurf, display name has every target word', () => {
  assert.strictEqual(pk.engines.vscode, '^1.90.0');
  assert.strictEqual(pk.devDependencies['@types/vscode'], '~1.90.0');
  const name = pk.displayName.toLowerCase();
  for (const phrase of ['aws s3', 's3 browser', 's3 explorer', 's3 client', 'minio', 'cloudflare r2', 's3 bucket']) for (const w of phrase.split(' ')) assert.ok(name.includes(w), `${w} of "${phrase}"`);
  assert.ok(!pk.dependencies, 'no runtime dependencies');
});

test('walkthrough media and icons exist', () => {
  for (const s of pk.contributes.walkthroughs[0].steps) {
    const m = s.media.image || s.media.markdown;
    assert.ok(fs.existsSync(path.join(root, m)), m);
  }
  assert.ok(fs.existsSync(path.join(root, pk.icon)));
  assert.ok(fs.existsSync(path.join(root, 'media/activity.svg')));
});

const fakeWebview = { cspSource: 'vscode-resource:' };

test('webviews: strict CSP, nonce scripts, no inline style attributes, values escaped', () => {
  const html = panels.detailsHtml(fakeWebview, { key: 'a/<img src=x onerror=alert(1)>.txt', bucket: 'b"x', connName: '<c>', head: { size: 10, lastModified: 'd', contentType: '<t>', storageClass: 'STANDARD', etag: 'e', metadata: { '<k>': '<v>' } }, tags: [{ key: '<tk>', value: '"tv"' }], versions: [{ key: 'k', versionId: '<v1>', isLatest: true, lastModified: 'm', size: 1 }], versioning: 'Enabled', presign: { url: 'https://x/?a=1&b=<2>', method: 'GET', until: 'later' }, showLinks: true });
  assert.match(html, /default-src 'none'/);
  assert.ok(!/<img src=x/.test(html));
  assert.ok(!/ style="/.test(html));
  assert.ok(!/<script(?![^>]*nonce=)/.test(html));
  assert.ok(html.includes('&lt;tk&gt;') && html.includes('&quot;tv&quot;') && html.includes('&lt;v1&gt;') && html.includes('b=&lt;2&gt;'));
  assert.ok(html.includes('id="zovo-support"'), 'support footer');
  const plan = panels.planHtml(fakeWebview, { direction: 'down', bucket: 'b', prefix: 'p/', root: '/tmp/x', create: [{ key: 'p/<a>', file: '/tmp/x/<a>', size: 3 }], change: [], remove: [{ file: '/tmp/x/old', size: 1 }], same: 2, skipped: [{ key: '../../x', why: 'key has a ".." segment' }], bytes: 3, showLinks: false });
  assert.ok(plan.includes('p/&lt;a&gt;') && plan.includes('to delete') && plan.includes('1 skipped'));
  assert.ok(!plan.includes('id="zovo-support"'));
  const rep = panels.reportHtml(fakeWebview, { bucket: 'b', prefix: '', connName: 'c', count: 2, bytes: 3e9, price: 0.023, ms: 10, done: true, groups: [{ name: 'a/', count: 1, bytes: 2e9 }], classes: [{ name: 'STANDARD', count: 2, bytes: 3e9 }], largest: [], showLinks: true });
  assert.ok(!/ style="/.test(rep));
  assert.match(rep, /\$0\.06/);
});

test('size aggregation by folder and storage class', () => {
  const a = panels.aggregate([{ key: 'p/a/1', size: 5, storageClass: 'STANDARD' }, { key: 'p/a/2', size: 7, storageClass: 'GLACIER' }, { key: 'p/top.txt', size: 1 }], 'p/');
  assert.strictEqual(a.count, 3);
  assert.strictEqual(a.groups.get('a/').bytes, 12);
  assert.strictEqual(a.groups.get('(files here)').count, 1);
  assert.strictEqual(a.classes.get('GLACIER').bytes, 7);
  assert.strictEqual(a.largest[0].key, 'p/a/2');
});

function fakeContext() {
  const state = new Map();
  return { subscriptions: [], globalState: { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); } } };
}

test('Pro: 3 free tries per feature, then the explanation; off switch makes all free', async () => {
  let asked = 0;
  const license = { ready: Promise.resolve(), isPro: () => false, refresh: async () => false, requirePro: async () => { asked++; return false; } };
  const pro = createPro({ vscode: fakeVscode, context: fakeContext(), license });
  for (let i = 1; i <= FREE_TRIES; i++) { const g = await pro.gate('sizeReport'); assert.ok(g.ok); assert.match(g.note, new RegExp(`free try ${i} of ${FREE_TRIES}`)); }
  const g4 = await pro.gate('sizeReport');
  assert.ok(!g4.ok);
  assert.strictEqual(asked, 1);
  assert.ok((await pro.gate('schedule')).ok, 'tries count per feature');
  const paid = createPro({ vscode: fakeVscode, context: fakeContext(), license: Object.assign({}, license, { isPro: () => true }) });
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(await paid.gate('crossCopy'), { ok: true, note: '' });
  const off = createPro({ vscode: fakeVscode, context: fakeContext(), license, enabled: false });
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(await off.gate('crossCopy'), { ok: true, note: '' });
  assert.deepStrictEqual(Object.keys(FEATURES).sort(), ['crossCopy', 'schedule', 'sizeReport']);
});
