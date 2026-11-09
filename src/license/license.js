'use strict';
// Shared Zovo license (factory/sprint/license/license.js, copied to src/license.js in each extension, unchanged).
// Offline: a license key is an Ed25519-signed payload. This file holds only the PUBLIC key. Checking a key needs no
// network. The extension sends nothing anywhere: no telemetry, no license server call. The one outbound action is
// the Payment Link (or the renew page), opened in the browser by the user's own click.
//
// Key format:  ZOVO1.<base64url(payload JSON)>.<base64url(64-byte Ed25519 signature)>
// Signed bytes: ASCII "ZOVO1." + <base64url(payload JSON)>  (the PREFIX.payload.sig layout of the XLSX TVPRO1 keys
//               and of PRO1's src/pro/license.js, so that verifier accepts these keys too)
// Payload:     { v: 1, sku, eh, sid, iat: "YYYY-MM-DD", exp?: "YYYY-MM-DD", lm: true|false, q?: seats }
//   sku  product id ("hex-pro", ...) or a bundle id (BUNDLE_SKUS) that unlocks every Zovo Pro
//   eh   first 24 hex of sha256("zovo-license-v1:" + lower-case checkout email); never the email itself
//   sid  Stripe Checkout Session id (the renew page uses it)
//   iat  issue date (date of payment), exp  last valid day in UTC (yearly plans only; none = lifetime)
//   lm   Stripe live mode (true for manual sales too). Test-mode keys are refused unless allowTest
//        (ZOVO_LICENSE_ALLOW_TEST=1). They are also signed with a separate test key pair, so a release build,
//        which embeds only the live public key, can never accept one.

const crypto = require('crypto');

// Written by factory/sprint/pay/keygen.mjs. The private half lives only in the macOS keychain
// (service ZOVO_LICENSE_PRIVKEY) and as the Worker secret LICENSE_PRIVATE_KEY.
const PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAtXEc+9zkJ34oa1Id1oSrAifTSxqhvKtMKZOo5ieX90k=';
const KEY_PREFIX = 'ZOVO1.';
const SIG_CONTEXT = KEY_PREFIX; // the signature covers the prefix
// "Zovo Pro: all viewers" and the 5-seat team licence. Team keys sold today carry sku zovo-pro + q (seats), because
// builds released before 2026-11-09 know only 'zovo-pro'; 'zovo-pro-team' is accepted here for keys made later.
const BUNDLE_SKUS = ['zovo-pro', 'zovo-pro-team'];
const CLAIM_URL = 'https://license.zovo.one/claim?session_id=';
const BUY_URL = 'https://license.zovo.one/buy/'; // + sku: 302 to the current Stripe Payment Link
const SECRET_KEY = 'zovo.license.key';
const INSTALL_ID_KEY = 'zovo.license.installId';
const TEST_ENV = 'ZOVO_LICENSE_ALLOW_TEST';
const DAY_MS = 24 * 60 * 60 * 1000;

function b64urlToBuffer(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function publicKeyObject(spkiB64) {
  return crypto.createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
}

let defaultKeyObject = null;
function defaultPublicKey() {
  if (!defaultKeyObject) defaultKeyObject = publicKeyObject(PUBLIC_KEY_SPKI_B64);
  return defaultKeyObject;
}

// Strip spaces, line breaks and quotes a mail client or a copy may add.
function cleanKey(text) {
  return String(text == null ? '' : text).replace(/[\s"'`<>]/g, '');
}

function dateOk(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

// Pure check of one key. Returns { ok: true, license } or { ok: false, reason, license? }.
// reason: empty | format | signature | version | test | expired
function verifyKey(text, opts = {}) {
  const key = cleanKey(text);
  if (!key) return { ok: false, reason: 'empty' };
  if (!key.startsWith(KEY_PREFIX)) return { ok: false, reason: 'format' };
  const body = key.slice(KEY_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'format' };
  const [payloadB64, sigB64] = parts;
  const sig = b64urlToBuffer(sigB64);
  const payloadBytes = b64urlToBuffer(payloadB64);
  if (!sig || sig.length !== 64 || !payloadBytes) return { ok: false, reason: 'format' };
  let good = false;
  try {
    const pub = opts.publicKey ? (typeof opts.publicKey === 'string' ? publicKeyObject(opts.publicKey) : opts.publicKey) : defaultPublicKey();
    good = crypto.verify(null, Buffer.from(SIG_CONTEXT + payloadB64, 'utf8'), pub, sig);
  } catch (e) {
    good = false;
  }
  if (!good) return { ok: false, reason: 'signature' };
  let p;
  try {
    p = JSON.parse(payloadBytes.toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'format' };
  }
  if (!p || p.v !== 1 || typeof p.sku !== 'string' || !p.sku || !dateOk(p.iat) || (p.exp !== undefined && !dateOk(p.exp))) {
    return { ok: false, reason: 'version' };
  }
  const license = {
    sku: p.sku,
    emailHash: typeof p.eh === 'string' ? p.eh : '',
    sessionId: typeof p.sid === 'string' ? p.sid : '',
    issued: p.iat,
    expires: p.exp || null,
    live: p.lm === true,
    seats: Number.isInteger(p.q) && p.q > 1 ? p.q : 1,
    key: KEY_PREFIX + body,
  };
  const allowTest = opts.allowTest !== undefined ? !!opts.allowTest : process.env[TEST_ENV] === '1';
  if (!license.live && !allowTest) return { ok: false, reason: 'test', license };
  const now = opts.now !== undefined ? opts.now : Date.now();
  if (license.expires && now >= Date.parse(license.expires + 'T00:00:00Z') + DAY_MS) {
    return { ok: false, reason: 'expired', license };
  }
  return { ok: true, license };
}

// Does this license unlock this product? A bundle license unlocks all of them.
function grants(license, sku) {
  return !!license && (license.sku === sku || BUNDLE_SKUS.includes(license.sku));
}

// verifyKey + grants. reason "sku" when the key is good but for another product.
function checkKey(text, sku, opts = {}) {
  const r = verifyKey(text, opts);
  if (!r.ok) return r;
  if (!grants(r.license, sku)) return { ok: false, reason: 'sku', license: r.license };
  return r;
}

function renewUrl(license) {
  return license && /^cs_(test|live)_[A-Za-z0-9]+$/.test(license.sessionId) ? CLAIM_URL + license.sessionId : null;
}

// Rail "license-key" (contract: API.md). Options:
//   vscode, context
//   sku                        this extension's Pro id, e.g. "hex-pro": unlock() refuses keys that do not grant it
//   name                       short product name for messages, e.g. "Hex Viewer"
//   publicKey, now, allowTest  for tests only
// unlock(prefill) asks for the key (input box), checks it offline, stores it in SecretStorage. No network ever.
function createKeyRail(o) {
  const { vscode, context, sku } = o;
  const label = o.name ? `${o.name} Pro` : 'Zovo Pro';
  const listeners = new Set();
  let current = null; // verified license (any sku), or null
  let lastResult = { ok: false, reason: 'empty' };
  const nowMs = () => (typeof o.now === 'function' ? o.now() : Date.now());
  const vopts = () => ({ publicKey: o.publicKey, allowTest: o.allowTest, now: nowMs() });
  const alive = (l) => !!l && (!l.expires || nowMs() < Date.parse(l.expires + 'T00:00:00Z') + DAY_MS);

  function fire() { const p = rail.isPro(sku); for (const fn of listeners) { try { fn(p); } catch (e) { /* listener error */ } } }

  function setFrom(result) {
    const before = current ? current.key : null;
    lastResult = result;
    current = result.ok ? result.license : null;
    if (before !== (current ? current.key : null)) fire();
  }

  async function load() {
    let stored;
    try { stored = await context.secrets.get(SECRET_KEY); } catch (e) { stored = undefined; }
    setFrom(stored ? verifyKey(stored, vopts()) : { ok: false, reason: 'empty' });
  }

  function message(r, keyText) {
    switch (r.reason) {
      case 'sku': return `This key is for ${r.license.sku}. It does not unlock ${label}.`;
      case 'expired': return `This key ran out on ${r.license.expires}. If your yearly plan renewed, get the new key from the renew page.`;
      case 'test': return 'This is a test-mode key. It does not unlock Pro.';
      default: return cleanKey(keyText).startsWith(KEY_PREFIX) ? 'This key is damaged or not genuine. Copy it again from the license page.' : 'This is not a Zovo license key. It starts with ZOVO1.';
    }
  }
  const REASON = { sku: 'wrong-sku', expired: 'expired', test: 'invalid-key', signature: 'invalid-key', format: 'invalid-key', version: 'invalid-key', empty: 'cancelled' };
  const result = (pro, reason, msg, license) => ({ rail: 'license-key', pro, reason, kind: pro ? (license && license.expires ? 'yearly' : 'lifetime') : 'none', login: '', message: msg });

  // Check and store a key. Returns an UnlockResult. Shows nothing: the caller (facade) shows result.message.
  async function saveKey(keyText) {
    const r = sku ? checkKey(keyText, sku, vopts()) : verifyKey(keyText, vopts());
    if (!r.ok) {
      const out = result(rail.isPro(sku), REASON[r.reason] || 'invalid-key', message(r, keyText));
      if (r.reason === 'expired') out.renewUrl = renewUrl(r.license);
      return out;
    }
    await context.secrets.store(SECRET_KEY, r.license.key);
    setFrom(r);
    const until = r.license.expires ? ` until ${r.license.expires}` : '';
    return result(true, 'ok', `${label} is on${until}. Thank you for supporting Zovo.`, r.license);
  }

  async function unlock(prefill) {
    const text = await vscode.window.showInputBox({
      title: `${label}: enter license key`,
      prompt: 'Paste the key from the license page or your receipt. It starts with ZOVO1. Checked offline.',
      placeHolder: 'ZOVO1....',
      value: typeof prefill === 'string' ? prefill : '',
      ignoreFocusOut: true,
      validateInput: (v) => (!v || cleanKey(v).startsWith(KEY_PREFIX) ? null : 'A Zovo key starts with ZOVO1.'),
    });
    if (text === undefined || !cleanKey(text)) return result(rail.isPro(sku), 'cancelled', '');
    return saveKey(text);
  }

  const rail = {
    id: 'license-key',
    label: 'I have a license key',
    ready: null,
    isPro(s) { return alive(current) && (!s || grants(current, s)); },
    unlock, saveKey,
    async refresh() { return false; }, // offline rail: nothing to refresh
    async remove() { await context.secrets.delete(SECRET_KEY); setFrom({ ok: false, reason: 'empty' }); },
    state() { return current ? { sku: current.sku, issued: current.issued, expires: current.expires, seats: current.seats, live: current.live } : null; },
    lastResult: () => lastResult,
    renewUrl: () => (lastResult.reason === 'expired' ? renewUrl(lastResult.license) : current && current.expires ? renewUrl(current) : null),
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
  rail.ready = load();
  if (context.secrets && typeof context.secrets.onDidChange === 'function') {
    context.subscriptions.push(context.secrets.onDidChange((e) => { if (!e || e.key === SECRET_KEY) load(); }));
  }
  return rail;
}

module.exports = {
  createKeyRail, verifyKey, checkKey, grants, cleanKey, renewUrl,
  KEY_PREFIX, SIG_CONTEXT, BUNDLE_SKUS, CLAIM_URL, BUY_URL, PUBLIC_KEY_SPKI_B64, SECRET_KEY, INSTALL_ID_KEY,
};
