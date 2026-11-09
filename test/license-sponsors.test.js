'use strict';
// Tests for the GitHub Sponsors rail (factory/sprint/license/sponsors.js). GraphQL, auth and storage are mocked.
// Run: node --test factory/sprint/license/test/
// In an extension repo, set ZOVO_SPONSORS_MODULE or copy to test/ and change the path below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MOD = process.env.ZOVO_SPONSORS_MODULE || path.join(__dirname, '..', 'src', 'license', 'sponsors.js');
const S = require(MOD);

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 9, 2, 0, 0);

// ---------- mocks ----------

const ZOVO = 'ST_kwDOAwq1PM4ACl_G';
const NM_ONCE = 'ST_kwDOAwq1PM4ACioy'; // notemods "$15 one time"
const NM_MONTH = 'ST_kwDOAwq1PM4ACiox'; // notemods "$5 a month"
const M10 = 'ST_kwDOAwq1PM4ACcUj';
const M25 = 'ST_kwDOAwq1PM4ACcUk';
const ONCE25 = 'ST_kwDOAwq1PM4ACizx'; // a general "$25 one time" tier: not Zovo Pro

/** One payment event in the viewer's history. */
const ev = (tier, { action = 'NEW_SPONSORSHIP', sponsor = 'buyer', to = 'theluckystrike' } = {}) => ({ action, sponsor: { login: sponsor }, sponsorable: { login: to }, sponsorsTier: tier ? { id: tier } : null });
/** GraphQL answer. history: events; sponsorship: current sponsorship to theluckystrike or null. */
function gql({ login = 'buyer', history = [], sponsorship = null, next = null } = {}) {
  const nodes = history.map((h) => (typeof h === 'string' ? ev(h, { sponsor: login }) : h));
  return { data: { viewer: { login, sponsorsActivities: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } }, user: { sponsorshipForViewerAsSponsor: sponsorship } } };
}
const monthly = (tier = M10, isActive = true) => ({ isActive, isOneTimePayment: false, tier: { id: tier } });
const oneTime = (tier = ZOVO, isActive = false) => ({ isActive, isOneTimePayment: true, tier: { id: tier } });
const zovoBuyer = (login = 'buyer') => gql({ login, history: [ZOVO], sponsorship: oneTime(ZOVO, true) });

/** fetch mock: each call takes the next answer. An answer is a body object, {status, body}, an Error (throws) or 'hang'. */
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    if (a === 'hang') {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    const { status, body } = a && a.status ? a : { status: 200, body: a };
    return { status, ok: status >= 200 && status < 300, json: async () => { if (body === 'not json') throw new SyntaxError('bad'); return body; } };
  };
  fn.calls = calls;
  return fn;
}

function fakeContext({ secretsBroken = false } = {}) {
  const secretMap = new Map();
  const stateMap = new Map();
  const listeners = [];
  return {
    subscriptions: [],
    secretMap,
    stateMap,
    secrets: {
      async get(k) { if (secretsBroken) throw new Error('keychain locked'); return secretMap.get(k); },
      async store(k, v) { if (secretsBroken) throw new Error('keychain locked'); secretMap.set(k, v); listeners.forEach((l) => l({ key: k })); },
      async delete(k) { if (secretsBroken) throw new Error('keychain locked'); secretMap.delete(k); listeners.forEach((l) => l({ key: k })); },
      onDidChange(l) { listeners.push(l); return { dispose() {} }; },
    },
    globalState: {
      get(k) { return stateMap.get(k); },
      async update(k, v) { if (v === undefined) stateMap.delete(k); else stateMap.set(k, v); },
    },
  };
}

function fakeVscode({ token = 'gho_test', cancel = false, silentToken } = {}) {
  const sessionCalls = [];
  const opened = [];
  return {
    sessionCalls,
    opened,
    authentication: {
      async getSession(provider, scopes, options) {
        sessionCalls.push({ provider, scopes, options });
        if (options && options.silent) return silentToken === undefined ? { accessToken: token } : silentToken ? { accessToken: silentToken } : undefined;
        if (cancel) throw new Error('User did not consent to login.');
        return { accessToken: token, account: { label: 'buyer' } };
      },
    },
    env: { async openExternal(uri) { opened.push(uri); return true; } },
    Uri: { parse: (s) => ({ toString: () => s, s }) },
  };
}

function make({ answers = [gql()], ctx = fakeContext(), vs = fakeVscode(), clock = { t: T0 }, timeoutMs } = {}) {
  const f = fakeFetch(...answers);
  const rail = S.createSponsorsRail({ vscode: vs, context: ctx, fetch: f, now: () => clock.t, timeoutMs });
  return { rail, f, ctx, vs, clock };
}

// ---------- pure rules ----------

test('evaluate: the Zovo tier at any time = lifetime; active general monthly >= USD 10 = monthly; else none', () => {
  const k = (o) => S.evaluate(gql(o).data).kind;
  assert.equal(k({ history: [ZOVO], sponsorship: oneTime(ZOVO, true) }), 'lifetime', 'just bought');
  assert.equal(k({ history: [ZOVO], sponsorship: oneTime(ZOVO, false) }), 'lifetime', 'bought long ago, sponsorship inactive');
  assert.equal(k({ history: [ZOVO, NM_ONCE], sponsorship: oneTime(NM_ONCE, true) }), 'lifetime', 'Zovo first, then the notemods tier: current tier is notemods, history keeps Zovo');
  assert.equal(k({ history: [], sponsorship: oneTime(ZOVO, false) }), 'lifetime', 'history not returned: the current tier is enough');
  assert.equal(k({ sponsorship: monthly(M10) }), 'monthly');
  for (const t of ['ST_kwDOAwq1PM4ACcUk', 'ST_kwDOAwq1PM4ACcUl', 'ST_kwDOAwq1PM4ACiGz', 'ST_kwDOAwq1PM4ACiG0']) assert.equal(k({ sponsorship: monthly(t) }), 'monthly', t);
  assert.equal(k({ history: [M10], sponsorship: monthly(M10, false) }), 'none', 'monthly that ended');
  assert.equal(k({ history: [NM_ONCE], sponsorship: oneTime(NM_ONCE, true) }), 'none', 'notemods one-time buyer');
  assert.equal(k({ history: [NM_MONTH], sponsorship: monthly(NM_MONTH) }), 'none', 'notemods monthly sponsor');
  assert.equal(k({ history: [ONCE25], sponsorship: oneTime(ONCE25, true) }), 'none', 'a general one-time tier is not Zovo Pro');
  assert.equal(k({}), 'none');
  assert.equal(S.evaluate({ viewer: { login: '' } }), null);
  assert.equal(S.evaluate(null), null);
  assert.equal(S.evaluate({ viewer: { login: 7 } }), null);
});

test('evaluate: notemods-only buyer is NOT Pro, whatever the amount or count', () => {
  const big = gql({ history: [NM_ONCE, NM_ONCE, NM_ONCE, NM_MONTH, NM_MONTH], sponsorship: monthly(NM_MONTH) });
  const r = S.evaluate(big.data);
  assert.equal(r.kind, 'none');
  assert.equal(r.sponsored, true);
  assert.equal(r.tierId, '');
});

test('evaluate: the notemods tiers never count, even if a list names them by mistake', () => {
  const policy = { ...S.POLICY, lifetimeTierIds: [ZOVO, NM_ONCE], monthlyTierIds: [M10, NM_MONTH] };
  assert.equal(S.evaluate(gql({ history: [NM_ONCE], sponsorship: oneTime(NM_ONCE, true) }).data, policy).kind, 'none');
  assert.equal(S.evaluate(gql({ sponsorship: monthly(NM_MONTH) }).data, policy).kind, 'none');
});

test('evaluate: only my own payments to theluckystrike count', () => {
  // The owner's own view: other people bought tiers FROM theluckystrike. That is not the viewer buying.
  const owner = gql({ login: 'theluckystrike', history: [ev(ZOVO, { sponsor: 'someone' }), ev(ZOVO, { sponsor: 'other' })] });
  assert.equal(S.evaluate(owner.data).kind, 'none');
  assert.equal(S.evaluate(owner.data).sponsored, false);
  // The viewer bought the same tier id from someone else (impossible on GitHub, but the target is checked).
  assert.equal(S.evaluate(gql({ history: [ev(ZOVO, { to: 'someone-else' })] }).data).kind, 'none');
  // Logins compare without case.
  assert.equal(S.evaluate(gql({ login: 'Buyer', history: [ev(ZOVO, { sponsor: 'buyer', to: 'TheLuckyStrike' })] }).data).kind, 'lifetime');
});

test('evaluate: a refund of the Zovo tier takes it back; a later purchase gives it again', () => {
  const refunded = gql({ history: [ev(ZOVO, { action: 'REFUND' }), ZOVO] });
  assert.equal(S.evaluate(refunded.data).kind, 'none');
  const again = gql({ history: [ZOVO, ev(ZOVO, { action: 'REFUND' }), ZOVO] });
  assert.equal(S.evaluate(again.data).kind, 'lifetime');
  const refundedNow = gql({ history: [ev(ZOVO, { action: 'REFUND' }), ZOVO], sponsorship: oneTime(ZOVO, false) });
  assert.equal(S.evaluate(refundedNow.data).kind, 'none', 'the current tier does not undo a refund');
});

test('evaluate: TIER_CHANGE to the Zovo tier counts; reason data', () => {
  const r = S.evaluate(gql({ history: [ev(ZOVO, { action: 'TIER_CHANGE' })] }).data);
  assert.equal(r.kind, 'lifetime');
  assert.equal(r.tierId, ZOVO);
  assert.equal(r.historyComplete, true);
  assert.equal(S.evaluate(gql({ next: 'c1' }).data).historyComplete, false);
  assert.equal(S.evaluate(gql().data).sponsored, false);
});

test('constants: tiers from the brief, notemods excluded, no total rule', () => {
  assert.equal(S.SPONSORABLE, 'theluckystrike');
  assert.deepEqual([...S.ZOVO_TIER_IDS], [ZOVO]);
  assert.deepEqual([...S.MONTHLY_TIER_IDS].sort(), ['ST_kwDOAwq1PM4ACcUj', 'ST_kwDOAwq1PM4ACcUk', 'ST_kwDOAwq1PM4ACcUl', 'ST_kwDOAwq1PM4ACiG0', 'ST_kwDOAwq1PM4ACiGz'].sort());
  assert.deepEqual([...S.NOTEMODS_TIER_IDS].sort(), [NM_MONTH, NM_ONCE].sort());
  for (const id of S.NOTEMODS_TIER_IDS) { assert.ok(!S.ZOVO_TIER_IDS.includes(id)); assert.ok(!S.MONTHLY_TIER_IDS.includes(id)); }
  assert.equal(S.MIN_TOTAL_CENTS, undefined, 'the USD 10 total rule is gone');
  assert.doesNotMatch(S.QUERY, /totalSponsorshipAmount/);
  assert.equal(S.BUY_URL, 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
  assert.equal(S.PRICE_TEXT, 'USD 19 once');
  assert.equal(S.RECHECK_MS, 30 * DAY);
  assert.deepEqual(S.SCOPES, ['read:user']);
  assert.equal(S.GRAPHQL_URL, 'https://api.github.com/graphql');
  assert.equal(S.STORE_KEY, 'zovo.pro.sponsors.v2');
});

test('ZOVO_TIER_DB_ID is the number inside the tier node id', () => {
  const b = Buffer.from(ZOVO.slice(3).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.equal(b.readUInt32BE(b.length - 4), S.ZOVO_TIER_DB_ID);
});

test('nextRecord: errors keep the cache; lifetime never goes down', () => {
  const life = { v: 2, kind: 'lifetime', login: 'a', tierId: ZOVO, checkedAt: T0, recheckAt: 0 };
  assert.equal(S.nextRecord(life, { ok: false, reason: 'network' }, T0 + DAY, 'recheck'), life);
  assert.equal(S.nextRecord(life, { ok: true, kind: 'none', login: 'a' }, T0 + DAY, 'unlock'), life);
  assert.equal(S.nextRecord(null, { ok: true, kind: 'none', login: 'a' }, T0, 'unlock'), null);
  const mon = { v: 2, kind: 'monthly', login: 'a', tierId: M10, checkedAt: T0, recheckAt: T0 + 30 * DAY };
  assert.equal(S.nextRecord(mon, { ok: true, kind: 'none', login: 'b' }, T0 + 31 * DAY, 'recheck'), mon, 'another account says nothing');
  assert.equal(S.nextRecord(mon, { ok: true, kind: 'none', login: 'a' }, T0 + DAY, 'unlock'), mon, 'unlock never shortens a paid month');
  assert.equal(S.nextRecord(mon, { ok: true, kind: 'none', login: 'a' }, T0 + 31 * DAY, 'recheck'), null);
  const up = S.nextRecord(mon, { ok: true, kind: 'lifetime', login: 'a', tierId: ZOVO }, T0 + 31 * DAY, 'recheck');
  assert.equal(up.kind, 'lifetime');
  assert.equal(up.tierId, ZOVO);
  assert.equal(up.recheckAt, 0);
});

test('parseRecord: damaged cache is ignored', () => {
  assert.equal(S.parseRecord('{nope'), null);
  assert.equal(S.parseRecord(JSON.stringify({ kind: 'god', login: 'a', checkedAt: 1 })), null);
  assert.equal(S.parseRecord(JSON.stringify({ kind: 'lifetime', login: '', checkedAt: 1 })), null);
  assert.equal(S.parseRecord(undefined), null);
  assert.equal(S.parseRecord(JSON.stringify({ v: 2, kind: 'lifetime', login: 'a', checkedAt: 1 })).kind, 'lifetime');
  assert.equal(S.parseRecord(JSON.stringify({ v: 1, kind: 'lifetime', login: 'a', totalCents: 1500, checkedAt: 1 })), null, 'v1 (total rule) is not honoured');
});

// ---------- the cases in the brief ----------

test('Zovo tier buyer: Pro for life, every Zovo sku', async () => {
  const { rail, f } = make({ answers: [zovoBuyer()] });
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.kind, 'lifetime');
  assert.equal(r.message, 'Zovo Pro is on. Thank you.');
  assert.equal(rail.state().recheckAt, 0);
  assert.equal(rail.state().tierId, ZOVO);
  assert.equal(rail.isPro('hex-pro'), true);
  assert.equal(rail.isPro('docx-pro'), true, 'one unlock covers every Zovo sku');
  assert.equal(f.calls.length, 1);
});

test('Zovo tier bought months ago (sponsorship inactive, later a notemods purchase): Pro for life', async () => {
  const { rail } = make({ answers: [gql({ history: [NM_ONCE, ZOVO], sponsorship: oneTime(NM_ONCE, false) })] });
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(r.kind, 'lifetime');
});

test('notemods-only buyer ($15 one time): NOT Pro, told which tier is Zovo Pro', async () => {
  const { rail, ctx, vs } = make({ answers: [gql({ history: [NM_ONCE], sponsorship: oneTime(NM_ONCE, true) })] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.kind, 'none');
  assert.equal(r.reason, 'other-tier');
  assert.match(r.message, /\$19 one time/);
  assert.match(r.message, /Obsidian plugin tiers do not include Zovo Pro/);
  assert.equal(rail.isPro('hex-pro'), false);
  assert.equal(ctx.secretMap.size + ctx.stateMap.size, 0, 'nothing stored for a no');
  await rail.openSponsorsPage();
  assert.equal(vs.opened[0].s, 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
});

test('notemods monthly sponsor ($5 a month, active): NOT Pro', async () => {
  const { rail } = make({ answers: [gql({ history: [NM_MONTH], sponsorship: monthly(NM_MONTH) })] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.reason, 'other-tier');
});

test('notemods buyer who paid USD 45 in total: still NOT Pro (no total rule)', async () => {
  const { rail } = make({ answers: [gql({ history: [NM_ONCE, NM_ONCE, NM_ONCE] })] });
  assert.equal((await rail.unlock()).pro, false);
});

test('active general monthly sponsor (USD 10 or more): Pro for 30 days, recheck date set', async () => {
  const { rail, f } = make({ answers: [gql({ history: [M25], sponsorship: monthly(M25) })] });
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.kind, 'monthly');
  assert.equal(rail.state().recheckAt, T0 + 30 * DAY);
  assert.equal(rail.state().tierId, M25);
  assert.equal(f.calls.length, 1);
});

test('ended general monthly sponsorship: no Pro, reason other-tier', async () => {
  const { rail } = make({ answers: [gql({ history: [M10], sponsorship: monthly(M10, false) })] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.reason, 'other-tier');
});

test('not a sponsor: no Pro, message points to the USD 19 tier', async () => {
  const { rail } = make({ answers: [gql()] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.reason, 'not-sponsor');
  assert.match(r.message, /USD 19 once/);
  assert.doesNotMatch(r.message, /USD 15|USD 10 or more in total/);
});

test('the owner account (others bought from it) is not Pro', async () => {
  const { rail } = make({ answers: [gql({ login: 'theluckystrike', history: [ev(ZOVO, { sponsor: 'x' }), ev(NM_ONCE, { sponsor: 'y' })] })] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.reason, 'not-sponsor');
});

test('a cached v1 record (old total rule) is ignored and deleted at start', async () => {
  const ctx = fakeContext();
  const v1 = { v: 1, kind: 'lifetime', login: 'nm', totalCents: 1500, checkedAt: T0, recheckAt: 0 };
  ctx.secretMap.set('zovo.pro.sponsors.v1', JSON.stringify(v1));
  ctx.stateMap.set('zovo.pro.sponsors.v1', v1);
  const { rail, f } = make({ ctx });
  await rail.ready;
  assert.equal(rail.isPro('hex-pro'), false);
  assert.equal(ctx.secretMap.size + ctx.stateMap.size, 0);
  assert.equal(f.calls.length, 0);
});

test('network error on unlock keeps the cached Pro (never lock a paid user out)', async () => {
  const ctx = fakeContext();
  const first = make({ ctx, answers: [zovoBuyer()] });
  await first.rail.unlock();
  const second = make({ ctx, answers: [new TypeError('fetch failed')] });
  await second.rail.ready;
  assert.equal(second.rail.isPro('hex-pro'), true);
  const r = await second.rail.unlock();
  assert.equal(r.reason, 'network');
  assert.equal(r.pro, true);
  assert.equal(second.rail.isPro('hex-pro'), true);
});

test('network error with no cache: no Pro, nothing stored, nothing thrown', async () => {
  const { rail, ctx } = make({ answers: [new TypeError('fetch failed')] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.reason, 'network');
  assert.match(r.message, /Nothing changed/);
  assert.equal(ctx.secretMap.size, 0);
});

// ---------- offline, restart, recheck ----------

test('restart offline: Pro comes from SecretStorage with no network and no sign-in', async () => {
  const ctx = fakeContext();
  await make({ ctx, answers: [zovoBuyer()] }).rail.unlock();
  const vs = fakeVscode();
  const { rail, f } = make({ ctx, vs, answers: [new TypeError('offline')] });
  await rail.ready;
  assert.equal(rail.isPro('hex-pro'), true);
  assert.equal(await rail.refresh(), false, 'lifetime is never checked again');
  assert.equal(f.calls.length, 0);
  assert.equal(vs.sessionCalls.length, 0);
});

test('isPro and refresh never show a sign-in; only unlock uses createIfNone', async () => {
  const ctx = fakeContext();
  const vs = fakeVscode();
  const { rail, f } = make({ ctx, vs, answers: [gql({ history: [M10], sponsorship: monthly() })] });
  await rail.ready;
  rail.isPro('hex-pro');
  await rail.refresh();
  assert.equal(vs.sessionCalls.length, 0);
  assert.equal(f.calls.length, 0);
  await rail.unlock();
  assert.deepEqual(vs.sessionCalls[0], { provider: 'github', scopes: ['read:user'], options: { createIfNone: true } });
});

test('monthly: no recheck before 30 days', async () => {
  const { rail, f, clock } = make({ answers: [gql({ history: [M10], sponsorship: monthly() })] });
  await rail.unlock();
  clock.t = T0 + 29 * DAY;
  assert.equal(await rail.refresh(), false);
  assert.equal(f.calls.length, 1);
});

test('monthly recheck after 30 days: still active extends 30 days, silently', async () => {
  const vs = fakeVscode();
  const { rail, f, clock } = make({ vs, answers: [gql({ history: [M10], sponsorship: monthly() }), gql({ history: [M10], sponsorship: monthly() })] });
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  assert.equal(await rail.refresh(), true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(vs.sessionCalls[1].options, { silent: true });
  assert.equal(rail.state().kind, 'monthly', 'months of a monthly tier never add up to lifetime');
  assert.equal(rail.state().recheckAt, T0 + 61 * DAY);
});

test('monthly recheck: the sponsor bought the Zovo tier meanwhile = lifetime', async () => {
  const { rail, clock } = make({ answers: [gql({ history: [M10], sponsorship: monthly() }), gql({ history: [M10, ZOVO], sponsorship: oneTime(ZOVO, true) })] });
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  await rail.refresh();
  assert.equal(rail.state().kind, 'lifetime');
});

test('monthly recheck: moved from USD 10 a month to the notemods USD 5 tier = Pro ends', async () => {
  const { rail, clock } = make({ answers: [gql({ history: [M10], sponsorship: monthly() }), gql({ history: [M10, NM_MONTH], sponsorship: monthly(NM_MONTH) })] });
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  await rail.refresh();
  assert.equal(rail.isPro('hex-pro'), false);
});

test('monthly recheck: network error keeps Pro and waits a day before the next try', async () => {
  const { rail, f, clock } = make({ answers: [gql({ history: [M10], sponsorship: monthly() }), new TypeError('offline')] });
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  assert.equal(await rail.refresh(), true);
  assert.equal(rail.isPro('hex-pro'), true);
  clock.t += 60 * 60 * 1000;
  assert.equal(await rail.refresh(), false, 'no retry within a day');
  assert.equal(f.calls.length, 2);
});

test('monthly recheck: no silent session keeps Pro, no network', async () => {
  const vs = fakeVscode({ silentToken: null });
  const { rail, f, clock } = make({ vs, answers: [gql({ history: [M10], sponsorship: monthly() })] });
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  await rail.refresh();
  assert.equal(rail.isPro('hex-pro'), true);
  assert.equal(f.calls.length, 1);
});

test('monthly recheck: GitHub says the same account stopped and never bought the Zovo tier: Pro ends', async () => {
  const { rail, ctx, clock } = make({ answers: [gql({ history: [M10], sponsorship: monthly() }), gql({ history: [M10], sponsorship: monthly(M10, false) })] });
  const seen = [];
  rail.onDidChange((p) => seen.push(p));
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  await rail.refresh();
  assert.equal(rail.isPro('hex-pro'), false);
  assert.equal(ctx.secretMap.size, 0);
  assert.deepEqual(seen, [true, false]);
});

test('unlock with another, non-sponsor GitHub account does not remove lifetime Pro', async () => {
  const { rail } = make({ answers: [zovoBuyer('a'), gql({ login: 'b' })] });
  await rail.unlock();
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.note, 'not-sponsor');
  assert.equal(rail.state().login, 'a');
});

// ---------- GitHub errors ----------

test('sign-in cancelled: no network, nothing changes', async () => {
  const { rail, f } = make({ vs: fakeVscode({ cancel: true }) });
  const r = await rail.unlock();
  assert.equal(r.reason, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('401 asks VS Code once for a new session, then reports auth', async () => {
  const vs = fakeVscode();
  const { rail, f } = make({ vs, answers: [{ status: 401, body: {} }] });
  const r = await rail.unlock();
  assert.equal(r.reason, 'auth');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(vs.sessionCalls[1].options, { forceNewSession: true });
});

test('401 then a fresh token that works: unlocked', async () => {
  const { rail } = make({ answers: [{ status: 401, body: {} }, zovoBuyer()] });
  assert.equal((await rail.unlock()).pro, true);
});

test('INSUFFICIENT_SCOPES is reported as scope', async () => {
  const body = { errors: [{ type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes" }] };
  const { rail } = make({ answers: [body] });
  assert.equal((await rail.unlock()).reason, 'scope');
});

test('rate limit, 5xx, bad JSON, wrong shape: no Pro change, no throw', async () => {
  for (const [a, reason] of [[{ status: 403, body: {} }, 'rate-limit'], [{ status: 429, body: {} }, 'rate-limit'], [{ status: 502, body: {} }, 'network'], [{ status: 200, body: 'not json' }, 'bad-response'], [{ data: { viewer: null } }, 'bad-response']]) {
    const { rail } = make({ answers: [a] });
    const r = await rail.unlock();
    assert.equal(r.reason, reason, JSON.stringify(a));
    assert.equal(r.pro, false);
  }
});

test('partial GraphQL error (user field failed) still uses the history', async () => {
  const body = gql({ login: 'a', history: [ZOVO] });
  body.data.user = null;
  body.errors = [{ type: 'NOT_FOUND', message: 'x' }];
  const { rail, f } = make({ answers: [body] });
  assert.equal((await rail.unlock()).pro, true);
  assert.equal(f.calls.length, 1);
});

test('GitHub refuses the history (data null): one fallback request for the current sponsorship', async () => {
  const refused = { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] };
  const current = { data: { viewer: { login: 'a' }, user: { sponsorshipForViewerAsSponsor: oneTime(ZOVO, true) } } };
  const { rail, f } = make({ answers: [refused, current] });
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.query, S.QUERY_CURRENT);
  assert.doesNotMatch(f.calls[1].body.query, /sponsorsActivities/);
});

test('fallback also refused: bad-response, nothing stored', async () => {
  const refused = { data: null, errors: [{ type: 'FORBIDDEN', message: 'no' }] };
  const { rail, ctx } = make({ answers: [refused, refused] });
  const r = await rail.unlock();
  assert.equal(r.reason, 'bad-response');
  assert.equal(ctx.secretMap.size, 0);
});

test('fallback with a notemods-only current tier: NOT Pro', async () => {
  const refused = { data: null, errors: [{ type: 'FORBIDDEN', message: 'no' }] };
  const current = { data: { viewer: { login: 'a' }, user: { sponsorshipForViewerAsSponsor: oneTime(NM_ONCE, true) } } };
  const { rail } = make({ answers: [refused, current] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.reason, 'other-tier');
});

test('long history: next pages only until the Zovo tier is found, at most MAX_PAGES', async () => {
  const page = (nodes, next) => ({ data: { viewer: { login: 'buyer', sponsorsActivities: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } } } });
  const other = (n) => Array.from({ length: n }, () => ev('ST_other', { to: 'someone' }));
  const first = { ...gql({ history: other(3), next: 'c1' }) };
  const { rail, f } = make({ answers: [first, page(other(3), 'c2'), page([ev(ZOVO)], 'c3'), page(other(1), null)] });
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(f.calls.length, 3, 'stops at the page with the Zovo tier');
  assert.equal(f.calls[1].body.query, S.QUERY_MORE);
  assert.deepEqual(f.calls[1].body.variables, { after: 'c1' });
  assert.deepEqual(f.calls[2].body.variables, { after: 'c2' });

  const endless = make({ answers: [gql({ history: other(2), next: 'c1' }), page(other(1), 'cX')] });
  const r2 = await endless.rail.unlock();
  assert.equal(r2.pro, false);
  assert.equal(endless.f.calls.length, S.MAX_PAGES);
});

test('a lifetime answer on page 1 makes no second request', async () => {
  const { rail, f } = make({ answers: [gql({ history: [ZOVO], next: 'c1' })] });
  await rail.unlock();
  assert.equal(f.calls.length, 1);
});

test('a failed next page keeps the first answer (no throw)', async () => {
  const { rail, f } = make({ answers: [gql({ history: [], sponsorship: monthly(M10), next: 'c1' }), new TypeError('offline')] });
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(r.kind, 'monthly');
  assert.equal(f.calls.length, 2);
});

test('timeout counts as a network error', async () => {
  const { rail } = make({ answers: ['hang'], timeoutMs: 30 });
  const r = await rail.unlock();
  assert.equal(r.reason, 'network');
});

// ---------- request, storage, privacy ----------

test('the one request: POST api.github.com/graphql with the token and theluckystrike, nothing else', async () => {
  const { rail, f } = make({ answers: [zovoBuyer()] });
  await rail.unlock();
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.github.com/graphql');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'bearer gho_test');
  assert.deepEqual(c.body.variables, { login: 'theluckystrike', after: null });
  assert.match(c.body.query, /sponsorsActivities\(first:100, after:\$after, period:ALL, includeAsSponsor:true/);
  assert.match(c.body.query, /sponsorsTier \{ id \}/);
  assert.match(c.body.query, /sponsorshipForViewerAsSponsor\(activeOnly:false\)\{ isActive isOneTimePayment tier \{ id \} \}/);
  assert.doesNotMatch(c.body.query, /totalSponsorshipAmount|monthlyPriceInCents/);
  assert.deepEqual(Object.keys(c.body).sort(), ['query', 'variables']);
});

test('the token is never stored', async () => {
  const { rail, ctx } = make({ answers: [zovoBuyer()] });
  await rail.unlock();
  const stored = JSON.stringify([...ctx.secretMap.values(), ...ctx.stateMap.values()]);
  assert.doesNotMatch(stored, /gho_test/);
  assert.deepEqual(Object.keys(JSON.parse(ctx.secretMap.get(S.STORE_KEY))).sort(), ['checkedAt', 'kind', 'login', 'recheckAt', 'tierId', 'v']);
});

test('keychain not readable: the globalState copy keeps Pro', async () => {
  const ctx = fakeContext();
  await make({ ctx, answers: [zovoBuyer()] }).rail.unlock();
  const broken = fakeContext({ secretsBroken: true });
  for (const [k, v] of ctx.stateMap) broken.stateMap.set(k, v);
  const { rail } = make({ ctx: broken });
  await rail.ready;
  assert.equal(rail.isPro('hex-pro'), true);
});

test('remove() clears both stores and fires the change', async () => {
  const { rail, ctx } = make({ answers: [zovoBuyer()] });
  await rail.unlock();
  const seen = [];
  rail.onDidChange((p) => seen.push(p));
  await rail.remove();
  assert.equal(rail.isPro('hex-pro'), false);
  assert.equal(ctx.secretMap.size + ctx.stateMap.size, 0);
  assert.deepEqual(seen, [false]);
});

test('isPro needs a sku string', async () => {
  const { rail } = make({ answers: [zovoBuyer()] });
  await rail.unlock();
  assert.equal(rail.isPro(''), false);
  assert.equal(rail.isPro(undefined), false);
});

test('source: no telemetry, only the GitHub GraphQL URL and the Sponsors page', () => {
  const src = fs.readFileSync(MOD, 'utf8');
  const urls = [...new Set(src.match(/https?:\/\/[^\s'"`)]+/g))].sort();
  assert.deepEqual(urls, ['https://api.github.com/graphql', 'https://github.com/sponsors/theluckystrike']);
  assert.doesNotMatch(src, /env\.(isTelemetryEnabled|telemetryLevel)|sendTelemetry|createTelemetryLogger|require\(['"](https?|net|dgram)['"]\)/);
});
