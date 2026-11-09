'use strict';
// Tests for the shared Zovo license module. No network. Run: node --test test/license.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const lic = require(fs.existsSync(path.join(__dirname, '..', 'license.js')) ? '../license.js' : '../src/license/license.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(payload, key = privateKey) {
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.sign(null, Buffer.from(lic.SIG_CONTEXT + p), key);
  return `${lic.KEY_PREFIX}${p}.${b64url(sig)}`;
}
const base = { v: 1, sku: 'hex-pro', eh: 'a'.repeat(24), sid: 'cs_live_abcdefghijklmnop', iat: '2026-11-09', lm: true };
const NOW = Date.UTC(2026, 10, 10);
const opts = { publicKey: PUB, now: NOW };

test('valid lifetime key', () => {
  const r = lic.checkKey(sign(base), 'hex-pro', opts);
  assert.equal(r.ok, true);
  assert.equal(r.license.sku, 'hex-pro');
  assert.equal(r.license.expires, null);
  assert.equal(r.license.seats, 1);
});

test('copy noise is tolerated: spaces, line breaks, quotes', () => {
  const k = sign(base);
  const noisy = ` "${k.slice(0, 30)}\n  ${k.slice(30, 60)}\r\n${k.slice(60)}" `;
  assert.equal(lic.checkKey(noisy, 'hex-pro', opts).ok, true);
});

test('tampered payload fails the signature', () => {
  const k = sign(base);
  const [p, s] = k.slice(lic.KEY_PREFIX.length).split('.');
  const forged = b64url(Buffer.from(JSON.stringify({ ...base, sku: 'zovo-pro' })));
  assert.equal(lic.verifyKey(`ZOVO1.${forged}.${s}`, opts).reason, 'signature');
  const flipped = p.slice(0, -2) + (p.at(-2) === 'A' ? 'B' : 'A') + p.at(-1);
  assert.equal(lic.verifyKey(`ZOVO1.${flipped}.${s}`, opts).reason, 'signature');
});

test('tampered signature or other signer fails', () => {
  const k = sign(base);
  const bad = k.slice(0, -3) + (k.at(-3) === 'A' ? 'B' : 'A') + k.slice(-2);
  assert.equal(lic.verifyKey(bad, opts).ok, false);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(lic.verifyKey(sign(base, other), opts).reason, 'signature');
});

test('wrong sku is refused; bundle sku unlocks all', () => {
  assert.equal(lic.checkKey(sign(base), 'docx-pro', opts).reason, 'sku');
  const bundle = sign({ ...base, sku: 'zovo-pro' });
  assert.equal(lic.checkKey(bundle, 'docx-pro', opts).ok, true);
  assert.equal(lic.checkKey(bundle, 'hex-pro', opts).ok, true);
});

test('yearly key: valid through the exp day (UTC), expired after', () => {
  const k = sign({ ...base, exp: '2027-11-16' });
  assert.equal(lic.verifyKey(k, { publicKey: PUB, now: Date.UTC(2027, 10, 16, 23, 59) }).ok, true);
  const r = lic.verifyKey(k, { publicKey: PUB, now: Date.UTC(2027, 10, 17) });
  assert.equal(r.reason, 'expired');
  assert.equal(lic.renewUrl(r.license), 'https://license.zovo.one/claim?session_id=cs_live_abcdefghijklmnop');
});

test('test-mode key refused unless allowTest', () => {
  const k = sign({ ...base, lm: false, sid: 'cs_test_abcdefghijklmnop' });
  assert.equal(lic.verifyKey(k, { ...opts, allowTest: false }).reason, 'test');
  assert.equal(lic.verifyKey(k, { ...opts, allowTest: true }).ok, true);
});

test('garbage and wrong versions', () => {
  for (const g of ['', 'hello', 'ZOVO1.', 'ZOVO1.abc', 'ZOVO1.a.b.c', 'ZOVO1.!!!.???', 'ZOVO1.' + 'A'.repeat(20) + '.' + 'A'.repeat(86), 'ZOVO-' + 'A'.repeat(20) + '.' + 'A'.repeat(86)]) {
    assert.equal(lic.verifyKey(g, opts).ok, false, g);
  }
  assert.equal(lic.verifyKey(sign({ ...base, v: 2 }), opts).reason, 'version');
  assert.equal(lic.verifyKey(sign({ ...base, iat: 'yesterday' }), opts).reason, 'version');
  assert.equal(lic.verifyKey(sign({ ...base, sku: '' }), opts).reason, 'version');
});

test('embedded public key is a real Ed25519 SPKI key (not the placeholder)', () => {
  const k = crypto.createPublicKey({ key: Buffer.from(lic.PUBLIC_KEY_SPKI_B64, 'base64'), format: 'der', type: 'spki' });
  assert.equal(k.asymmetricKeyType, 'ed25519');
  // a key signed by the test key must NOT pass the embedded key
  assert.equal(lic.verifyKey(sign(base), { now: NOW }).reason, 'signature');
});

// --- VS Code side with a fake vscode API ---
const { createLicense } = require(fs.existsSync(path.join(__dirname, '..', 'index.js')) ? '../index.js' : '../src/license/index.js');

function fakeVscode(answers = {}) {
  const log = { info: [], warn: [], opened: [], commands: {}, input: [], picks: [] };
  const vscode = {
    Uri: { parse: (s) => ({ toString: () => s, s }) },
    env: { openExternal: async (u) => { log.opened.push(u.s); return true; } },
    window: {
      showInformationMessage: async (msg, ...rest) => { log.info.push(msg); return answers.info ? answers.info(msg, rest) : undefined; },
      showWarningMessage: async (msg, ...rest) => { log.warn.push(msg); return answers.warn ? answers.warn(msg, rest) : undefined; },
      showErrorMessage: async (msg) => { log.warn.push(msg); },
      showInputBox: async (o) => { log.input.push(o); return typeof answers.input === 'function' ? answers.input(o) : answers.input; },
      showQuickPick: async (items, o) => { log.picks.push(items.map((i) => i.label)); return answers.pick ? items.find((i) => i.label === answers.pick) : undefined; },
    },
    commands: { registerCommand: (id, fn) => { log.commands[id] = fn; return { dispose() {} }; } },
  };
  const secrets = new Map(); const global = new Map();
  const context = {
    subscriptions: [],
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) },
    globalState: { get: (k) => global.get(k), update: async (k, v) => { global.set(k, v); } },
  };
  return { vscode, context, log, secrets, global };
}

// A stand-in Sponsors rail (the real one is tested in sponsors.test.js).
function fakeSponsors(result) {
  let pro = false; const ls = new Set();
  return {
    id: 'github-sponsors', ready: Promise.resolve(), isPro: () => pro,
    async unlock() { pro = result.pro; for (const f of ls) f(pro); return { rail: 'github-sponsors', kind: pro ? 'lifetime' : 'none', login: 'x', ...result }; },
    async refresh() { this.refreshed = (this.refreshed || 0) + 1; return false; },
    async remove() { pro = false; for (const f of ls) f(pro); },
    state: () => (pro ? { kind: 'lifetime' } : null),
    onDidChange(fn) { ls.add(fn); return { dispose: () => ls.delete(fn) }; },
  };
}

const mk = (f, extra = {}) => createLicense({ ...f, sku: 'hex-pro', name: 'Hex Viewer', publicKey: PUB, now: () => NOW, ...extra });

test('key rail: offline unlock stores in SecretStorage, survives a restart, remove clears', async () => {
  const f = fakeVscode({ input: sign(base) });
  const rail = lic.createKeyRail({ ...f, sku: 'hex-pro', name: 'Hex Viewer', publicKey: PUB, now: () => NOW });
  await rail.ready;
  assert.equal(rail.isPro('hex-pro'), false);
  let events = 0; rail.onDidChange(() => events++);
  const r = await rail.unlock();
  assert.deepEqual({ ...r, message: undefined }, { rail: 'license-key', pro: true, reason: 'ok', kind: 'lifetime', login: '', message: undefined });
  assert.equal(rail.isPro('hex-pro'), true);
  assert.equal(rail.isPro('docx-pro'), false);
  assert.equal(events, 1);
  assert.equal(f.secrets.get(lic.SECRET_KEY), sign(base));
  assert.deepEqual(rail.state(), { sku: 'hex-pro', issued: '2026-11-09', expires: null, seats: 1, live: true }); // no key in state
  assert.equal(await rail.refresh(), false);
  const again = lic.createKeyRail({ ...f, sku: 'hex-pro', publicKey: PUB, now: () => NOW });
  await again.ready;
  assert.equal(again.isPro('hex-pro'), true);
  await again.remove();
  assert.equal(again.isPro('hex-pro'), false);
  assert.equal(f.secrets.size, 0);
  assert.equal(f.log.opened.length, 0);
});

test('key rail: wrong sku, tampered, test-mode and cancel return reasons and store nothing', async () => {
  const f = fakeVscode();
  const rail = lic.createKeyRail({ ...f, sku: 'hex-pro', publicKey: PUB, now: () => NOW });
  await rail.ready;
  assert.equal((await rail.saveKey(sign({ ...base, sku: 'docx-pro' }))).reason, 'wrong-sku');
  assert.equal((await rail.saveKey(sign(base).slice(0, -4) + 'AAAA')).reason, 'invalid-key');
  assert.equal((await rail.saveKey(sign({ ...base, lm: false }))).reason, 'invalid-key');
  assert.equal((await rail.unlock()).reason, 'cancelled');
  const exp = await rail.saveKey(sign({ ...base, exp: '2026-01-01' }));
  assert.equal(exp.reason, 'expired');
  assert.equal(exp.renewUrl, 'https://license.zovo.one/claim?session_id=cs_live_abcdefghijklmnop');
  assert.equal(f.secrets.size, 0);
});

test('facade: Pro when ANY rail says so; commands registered; change events', async () => {
  const sp = fakeSponsors({ pro: true, reason: 'ok', message: 'Zovo Pro is on. Thank you.' });
  const f = fakeVscode();
  const keyOnly = lic.createKeyRail({ ...f, sku: 'hex-pro', publicKey: PUB, now: () => NOW });
  const pro = mk(f, { rails: [sp, keyOnly], commandPrefix: 'hexViewer' });
  await pro.ready;
  assert.equal(pro.isPro(), false);
  assert.deepEqual(Object.keys(f.log.commands).sort(), ['hexViewer.enterLicenseKey', 'hexViewer.getPro', 'hexViewer.removeLicense', 'hexViewer.unlockWithSponsors']);
  const seen = []; pro.onDidChange((p) => seen.push(p));
  await f.log.commands['hexViewer.unlockWithSponsors']();
  assert.equal(pro.isPro('hex-pro'), true);
  assert.deepEqual(f.log.info, ['Zovo Pro is on. Thank you.']);
  assert.deepEqual(seen, [true]);
  await pro.remove();
  assert.equal(pro.isPro(), false);
  assert.deepEqual(seen, [true, false]);
});

test('facade default rails: Sponsors rail from sponsors.js + key rail; Enter key command unlocks', async () => {
  const f = fakeVscode({ input: sign({ ...base, sku: 'zovo-pro' }) });
  const pro = mk(f, { commandPrefix: 'hexViewer' });
  await pro.ready;
  assert.deepEqual(pro.rails.map((r) => r.id), ['github-sponsors', 'license-key']);
  await f.log.commands['hexViewer.enterLicenseKey']();
  assert.equal(pro.isPro('hex-pro'), true);
  assert.equal(pro.isPro('docx-pro'), true); // bundle
  assert.match(f.log.info[0], /Hex Viewer Pro is on/);
});

test('facade unlock() with no rail id: quick pick of rails plus Get Pro', async () => {
  const g = fakeVscode({ pick: 'I have a license key', input: sign(base) });
  const pro = mk(g);
  await pro.ready;
  const r = await pro.unlock();
  assert.deepEqual(g.log.picks[0], ['Unlock with GitHub Sponsors', 'I have a license key', 'Get Hex Viewer Pro']);
  assert.equal(r.pro, true);
  assert.equal(pro.isPro(), true);
});

test('Get Pro: Sponsors page by default; Stripe link gets a stable random install id; "" = not on sale', async () => {
  const a = fakeVscode();
  await mk(a).getPro();
  assert.deepEqual(a.log.opened, ['https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878']);
  assert.equal(a.global.size, 0); // no install id for the Sponsors page
  const b = fakeVscode();
  const pb = mk(b, { paymentUrl: lic.BUY_URL + 'hex-pro' });
  await pb.getPro(); await pb.getPro();
  assert.match(b.log.opened[0], /^https:\/\/license\.zovo\.one\/buy\/hex-pro\?client_reference_id=[0-9a-f-]{36}$/);
  assert.equal(b.log.opened[1], b.log.opened[0]);
  const c = fakeVscode();
  await mk(c, { paymentUrl: '' }).getPro();
  assert.equal(c.log.opened.length, 0);
  assert.match(c.log.info[0], /not on sale yet/);
});

test('requirePro: true when unlocked (and triggers rail refresh); explains with rail buttons when locked', async () => {
  const sp = fakeSponsors({ pro: true, reason: 'ok', message: 'on' });
  let buttons;
  const f = fakeVscode({ info: (msg, rest) => { if (rest[0] && rest[0].modal) buttons = rest.slice(1); return undefined; } });
  const pro = mk(f, { rails: [sp] });
  await pro.ready;
  assert.equal(await pro.requirePro('Binary templates'), false);
  assert.match(f.log.info[0], /Binary templates is part of Hex Viewer Pro/);
  assert.deepEqual(buttons, ['Unlock with GitHub Sponsors', 'Get Hex Viewer Pro']);
  await pro.unlock('github-sponsors');
  assert.equal(await pro.requirePro('Binary templates'), true);
  assert.equal(sp.refreshed, 1);
});

test('requirePro: picking a rail button unlocks and returns true', async () => {
  const f = fakeVscode({ info: (msg, rest) => (rest[0] && rest[0].modal ? 'I have a license key' : undefined), input: sign(base) });
  const pro = mk(f);
  await pro.ready;
  assert.equal(await pro.requirePro('Checksums'), true);
});

test('expired yearly key: locked, Renew page offered and opened', async () => {
  const f = fakeVscode({ info: (msg, rest) => (rest.includes('Renew page') ? 'Renew page' : undefined) });
  f.secrets.set(lic.SECRET_KEY, sign({ ...base, exp: '2026-11-01' }));
  const pro = mk(f, { rails: undefined });
  await pro.ready;
  assert.equal(pro.isPro(), false);
  await pro.requirePro('Struct export');
  assert.deepEqual(f.log.opened, ['https://license.zovo.one/claim?session_id=cs_live_abcdefghijklmnop']);
});

test('yearly key runs out while the editor stays open', async () => {
  let now = Date.UTC(2027, 10, 16, 12);
  const f = fakeVscode();
  f.secrets.set(lic.SECRET_KEY, sign({ ...base, exp: '2027-11-16' }));
  const pro = mk(f, { now: () => now });
  await pro.ready;
  assert.equal(pro.isPro(), true);
  now = Date.UTC(2027, 10, 17, 1);
  assert.equal(pro.isPro(), false);
});

test('vscode:// license link asks first, then stores; declining stores nothing', async () => {
  const f = fakeVscode({ info: (msg) => (/^Add a/.test(msg) ? 'Add key' : undefined) });
  const pro = mk(f);
  await pro.ready;
  assert.equal(await pro.handleUri({ path: '/other', query: '' }), false);
  assert.equal(await pro.handleUri({ path: '/license', query: 'key=' + encodeURIComponent(sign(base)) }), true);
  assert.equal(pro.isPro(), true);
  const g = fakeVscode();
  const p2 = mk(g);
  assert.equal(await p2.handleUri({ path: '/license', query: 'key=' + encodeURIComponent(sign(base)) }), false);
  assert.equal(g.secrets.size, 0);
});

test('PRO1 compatibility: its PREFIX.payload.sig verifier accepts these keys', () => {
  const pro1 = path.join(__dirname, '..', '..', '..', '..', 'run-20261107', 'wave14', 'out', 'PRO1-work', 'hex', 'src', 'pro', 'license.js');
  if (!fs.existsSync(pro1)) return; // only on the factory Mac while PRO1-work exists
  const { verifyKey } = require(pro1);
  assert.equal(verifyKey(sign(base), 'hex-pro', [PUB], NOW).ok, true);
  assert.equal(verifyKey(sign({ ...base, sku: 'zovo-pro' }), 'hex-pro', [PUB], NOW).ok, true);
  assert.equal(verifyKey(sign({ ...base, sku: 'docx-pro' }), 'hex-pro', [PUB], NOW).ok, false);
  assert.equal(verifyKey(sign({ ...base, exp: '2027-11-16' }), 'hex-pro', [PUB], Date.UTC(2027, 10, 17, 1)).ok, false);
});

test('license.js and index.js make no network calls: no http/https/net/fetch', () => {
  for (const name of ['license.js', 'index.js']) {
    const p = fs.existsSync(path.join(__dirname, '..', name)) ? path.join(__dirname, '..', name) : path.join(__dirname, '..', 'src', 'license', name);
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dgram)['"]\)|\bfetch\(/.test(src), name);
  }
});

// EXEC3 (2026-11-09): the 5-seat team licence.
test('team licence: zovo-pro-team and zovo-pro + q=5 keys unlock every product and carry 5 seats', () => {
  assert.ok(lic.BUNDLE_SKUS.includes('zovo-pro-team'));
  for (const sku of ['zovo-pro-team', 'zovo-pro']) {
    const k = sign({ ...base, sku, sid: 'manual-paypal-TEAM1', q: 5 });
    for (const p of ['hex-pro', 'docx-pro', 'xlsx-pro', 'sql-client-pro']) assert.equal(lic.checkKey(k, p, opts).ok, true, `${sku} -> ${p}`);
    assert.equal(lic.verifyKey(k, opts).license.seats, 5);
    assert.equal(lic.renewUrl(lic.verifyKey(k, opts).license), null); // manual sale: no Stripe renew page
  }
  assert.equal(lic.checkKey(sign({ ...base, sku: 'zovo-pro-teams' }), 'hex-pro', opts).reason, 'sku'); // exact match only
});
