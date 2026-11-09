'use strict';
// Zovo Pro, rail 1: GitHub Sponsors (factory/sprint/license/sponsors.js, lane SPON1, tier rule by FIXSPON, 2026-11-09).
// Copied to src/license/sponsors.js in each extension that has Pro features. API: factory/sprint/license/API.md.
//
// What it does:
// - The user clicks "Unlock with GitHub Sponsors". Only then does it call
//   vscode.authentication.getSession('github', ['read:user'], { createIfNone: true }).
// - One GraphQL call to the GitHub GraphQL API (GRAPHQL_URL): the viewer's login, the viewer's own sponsorship
//   history with the tier of every payment (also past one-time payments), and the viewer's current sponsorship to
//   theluckystrike (active or past). A second call only for a history longer than 100 events.
// - Pro for life when the viewer bought the Zovo Pro tier ("$19 one time", ZOVO_TIER_IDS) at any time.
//   Pro for 30 days when a general monthly sponsorship of USD 10 or more (MONTHLY_TIER_IDS) is active, then one
//   recheck (silent, never a sign-in prompt) the next time a Pro feature starts.
// - The notemods.com Obsidian tiers ("$15 one time", "$5 a month", NOTEMODS_TIER_IDS) never count. Amounts and
//   totals do not count either: only the tier.
// - The result is kept in SecretStorage (a copy of the same small record in globalState is the fallback when the
//   OS keychain is not readable). isPro() reads only that cache: no network.
// - A network error, a timeout, a missing session or a GitHub error never removes Pro that was granted.
//   Only a clear answer from GitHub for the same account ("this monthly sponsorship ended and no Zovo tier was
//   bought") ends a monthly entitlement. A lifetime entitlement is never checked again.
// - No telemetry. No other network call. The token is used for these requests and never stored by this module.

const RAIL_ID = 'github-sponsors';
const SPONSORABLE = 'theluckystrike';
const SPONSORS_URL = 'https://github.com/sponsors/theluckystrike';
const GRAPHQL_URL = 'https://api.github.com/graphql';
const SCOPES = ['read:user'];

// Tiers (GraphQL node ids of the owner's Sponsors listing, F 2026-11-09).
// Zovo Pro: "$19 one time". Bought once, at any time = Pro for life.
const ZOVO_TIER_IDS = Object.freeze(['ST_kwDOAwq1PM4ACl_G']);
const ZOVO_TIER_DB_ID = 679878; // the same tier as a number, for the tier_id parameter of the Sponsors page
// General monthly tiers of USD 10 or more: Pro while the sponsorship is active.
const MONTHLY_TIER_IDS = Object.freeze([
  'ST_kwDOAwq1PM4ACcUj', // $10 a month
  'ST_kwDOAwq1PM4ACcUk', // $25 a month
  'ST_kwDOAwq1PM4ACcUl', // $100 a month
  'ST_kwDOAwq1PM4ACiGz', // $750 a month
  'ST_kwDOAwq1PM4ACiG0', // $1,500 a month
]);
// The notemods.com Obsidian plugin tiers ("$15 one time", "$5 a month"). A separate project: they never count here.
const NOTEMODS_TIER_IDS = Object.freeze(['ST_kwDOAwq1PM4ACioy', 'ST_kwDOAwq1PM4ACiox']);
const BUY_URL = `${SPONSORS_URL}/sponsorships?tier_id=${ZOVO_TIER_DB_ID}`;
const PRICE_TEXT = 'USD 19 once';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECHECK_MS = 30 * DAY_MS; // monthly sponsors: recheck after 30 days
const RETRY_MS = DAY_MS; // after a failed recheck, wait a day before the next silent try
const TIMEOUT_MS = 15000;
const MAX_PAGES = 5; // sponsorship history pages of 100 events; more only when the Zovo tier was not found yet
const STORE_KEY = 'zovo.pro.sponsors.v2';
const LEGACY_KEYS = ['zovo.pro.sponsors.v1']; // v1 granted Pro on "USD 10 paid in total": never read, deleted at start
const KINDS = new Set(['lifetime', 'monthly']);

const POLICY = Object.freeze({ sponsorable: SPONSORABLE, lifetimeTierIds: ZOVO_TIER_IDS, monthlyTierIds: MONTHLY_TIER_IDS, excludedTierIds: NOTEMODS_TIER_IDS });

const LOGIN = '{ ... on User { login } ... on Organization { login } }';
const HISTORY = `sponsorsActivities(first:100, after:$after, period:ALL, includeAsSponsor:true, includePrivate:true, actions:[NEW_SPONSORSHIP, TIER_CHANGE, REFUND])`
  + ` { pageInfo { hasNextPage endCursor } nodes { action sponsor ${LOGIN} sponsorable ${LOGIN} sponsorsTier { id } } }`;
const CURRENT = 'user(login:$login){ sponsorshipForViewerAsSponsor(activeOnly:false){ isActive isOneTimePayment tier { id } } }';
// One request: the viewer, the viewer's own sponsorship history (every payment with its tier, also past one-time
// payments), and the current sponsorship to theluckystrike (active or not).
const QUERY = `query($login:String!, $after:String){ viewer { login ${HISTORY} } ${CURRENT} }`;
// Only when the history is longer than 100 events and the Zovo tier is not in the first page.
const QUERY_MORE = `query($after:String){ viewer { login ${HISTORY} } }`;
// Fallback when GitHub refuses the history (the current sponsorship alone).
const QUERY_CURRENT = `query($login:String!){ viewer { login } ${CURRENT} }`;

const MESSAGES = {
  ok: 'Zovo Pro is on. Thank you.',
  'not-sponsor': `This GitHub account has not bought Zovo Pro yet. Zovo Pro is ${PRICE_TEXT} on GitHub Sponsors (the "$19 one time" tier) and covers every Zovo viewer.`,
  'other-tier': `This GitHub account sponsors theluckystrike, but not on the Zovo Pro tier. Zovo Pro is the "$19 one time" tier on GitHub Sponsors. A monthly sponsorship of USD 10 or more also works while it runs. The Obsidian plugin tiers do not include Zovo Pro.`,
  cancelled: 'GitHub sign-in was cancelled. Nothing changed.',
  'no-session': 'No GitHub sign-in. Nothing changed.',
  network: 'GitHub could not be reached. Nothing changed. Try again when you are online.',
  auth: 'GitHub did not accept the sign-in. Sign out of GitHub in the Accounts menu and try again.',
  scope: 'The GitHub sign-in cannot read sponsorships. Sign out of GitHub in the Accounts menu and try again.',
  'rate-limit': 'GitHub is busy. Nothing changed. Try again in a few minutes.',
  'bad-response': 'GitHub sent an answer this version cannot read. Nothing changed.',
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const loginOf = (o) => (o && typeof o.login === 'string' ? o.login : '');
const lower = (s) => String(s || '').toLowerCase();

/**
 * Decide the entitlement from the GraphQL `data` object. Pure.
 * - lifetime: the viewer bought a Zovo tier (policy.lifetimeTierIds) at any time: in the payment history or as the
 *   current sponsorship tier, and that purchase was not refunded.
 * - monthly: the current sponsorship is active, monthly, on a general tier of USD 10 or more (policy.monthlyTierIds).
 * - none: anything else. The notemods tiers (policy.excludedTierIds) never count, whatever the lists say.
 * @returns {{kind:'lifetime'|'monthly'|'none', login:string, tierId:string, sponsored:boolean, historyComplete:boolean}|null}
 *   null when the data does not have the expected shape.
 */
function evaluate(data, policy = POLICY) {
  const viewer = data && data.viewer;
  if (!viewer || typeof viewer.login !== 'string' || !viewer.login) return null;
  const me = lower(viewer.login);
  const target = lower(policy.sponsorable);
  const excluded = new Set(policy.excludedTierIds || []);
  const life = new Set((policy.lifetimeTierIds || []).filter((id) => !excluded.has(id)));
  const month = new Set((policy.monthlyTierIds || []).filter((id) => !excluded.has(id)));

  const hist = viewer.sponsorsActivities;
  const nodes = hist && Array.isArray(hist.nodes) ? hist.nodes : [];
  let bought = 0;
  let refunded = 0;
  let lifeTier = '';
  let sponsored = false;
  for (const n of nodes) {
    if (!n || lower(loginOf(n.sponsorable)) !== target || lower(loginOf(n.sponsor)) !== me) continue; // only my own payments to the target
    sponsored = true;
    const tierId = n.sponsorsTier && n.sponsorsTier.id;
    if (!life.has(tierId)) continue;
    if (n.action === 'REFUND') refunded++;
    else if (n.action === 'NEW_SPONSORSHIP' || n.action === 'TIER_CHANGE') { bought++; lifeTier = lifeTier || tierId; }
  }

  const sp = data.user ? data.user.sponsorshipForViewerAsSponsor : null;
  const curTier = sp && sp.tier && typeof sp.tier.id === 'string' ? sp.tier.id : '';
  if (sp) sponsored = true;
  if (curTier && life.has(curTier) && bought === 0) { bought = 1; lifeTier = curTier; }
  const lifetime = bought > refunded;
  const monthlyActive = !!(sp && sp.isActive === true && sp.isOneTimePayment !== true && month.has(curTier));
  const kind = lifetime ? 'lifetime' : monthlyActive ? 'monthly' : 'none';
  const tierId = lifetime ? lifeTier : monthlyActive ? curTier : '';
  const historyComplete = !!(hist && hist.pageInfo && hist.pageInfo.hasNextPage === false);
  return { kind, login: viewer.login, tierId, sponsored, historyComplete };
}

/** A stored record, or null when it is missing or damaged. */
function cleanRecord(r) {
  if (!r || typeof r !== 'object' || !KINDS.has(r.kind) || typeof r.login !== 'string' || !r.login) return null;
  if (!isNum(r.checkedAt) || r.v !== 2) return null;
  return {
    v: 2,
    kind: r.kind,
    login: r.login,
    tierId: typeof r.tierId === 'string' ? r.tierId : '',
    checkedAt: r.checkedAt,
    recheckAt: r.kind === 'monthly' ? (isNum(r.recheckAt) ? r.recheckAt : r.checkedAt + RECHECK_MS) : 0,
  };
}

function parseRecord(text) {
  if (typeof text !== 'string' || !text) return null;
  try { return cleanRecord(JSON.parse(text)); } catch { return null; }
}

/**
 * The record after a check. Pure.
 * @param {object|null} prev   cached record
 * @param {object} check       {ok:true, kind, login, tierId} or {ok:false, reason}
 * @param {number} now
 * @param {'unlock'|'recheck'} why
 * @returns {object|null}
 */
function nextRecord(prev, check, now, why) {
  if (!check || !check.ok) return prev; // never lose Pro on an error
  if (prev && prev.kind === 'lifetime' && check.kind !== 'lifetime') return prev; // lifetime never goes down
  if (check.kind === 'lifetime' || check.kind === 'monthly') {
    return { v: 2, kind: check.kind, login: check.login, tierId: check.tierId || '', checkedAt: now, recheckAt: check.kind === 'monthly' ? now + RECHECK_MS : 0 };
  }
  // A clear "no" from GitHub.
  if (!prev) return null;
  if (prev.login !== check.login) return prev; // another GitHub account answered: says nothing about the cached one
  if (why === 'unlock' && now < prev.recheckAt) return prev; // an unlock click never shortens a paid month
  return null; // the monthly sponsorship ended (or moved to a tier that does not count) and no Zovo tier was bought
}

function hasShape(fn) { return typeof fn === 'function'; }

/** One POST to the GraphQL API. Never throws. @returns {{ok:true, body}|{ok:false, reason}} */
async function post(f, token, query, variables, timeoutMs) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    let res;
    try {
      res = await f(GRAPHQL_URL, {
        method: 'POST',
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'zovo-vscode-pro' },
        body: JSON.stringify({ query, variables }),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (!res || typeof res.status !== 'number') return { ok: false, reason: 'bad-response' };
    if (res.status === 401) return { ok: false, reason: 'auth' };
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'rate-limit' };
    if (res.status >= 500 || res.status === 408) return { ok: false, reason: 'network' };
    if (res.status !== 200) return { ok: false, reason: 'bad-response' };
    try { return { ok: true, body: await res.json() }; } catch { return { ok: false, reason: ctrl && ctrl.signal.aborted ? 'network' : 'bad-response' }; }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const isScopeError = (body) => !!(body && Array.isArray(body.errors) && body.errors.some((e) => e && (e.type === 'INSUFFICIENT_SCOPES' || /scope/i.test(String(e.message || '')))));
const hasErrors = (body) => !!(body && Array.isArray(body.errors) && body.errors.length);

/**
 * Ask GitHub. Usually one request; more only when the history is longer than 100 events and the Zovo tier is not
 * in it yet (at most MAX_PAGES), or when GitHub refuses the history (then one request for the current sponsorship).
 * Never throws.
 * @param {string} token
 * @param {{fetchImpl?:Function, timeoutMs?:number, policy?:object}} [opts] policy is for tests and the live check
 * @returns {Promise<{ok:true, kind, login, tierId, sponsored, historyComplete}|{ok:false, reason:string}>}
 */
async function queryGitHub(token, { fetchImpl, timeoutMs = TIMEOUT_MS, policy = POLICY } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, reason: 'network' };
  const first = await post(f, token, QUERY, { login: policy.sponsorable, after: null }, timeoutMs);
  if (!first.ok) return first;
  let body = first.body;
  let data = body && body.data;
  if (!evaluate(data, policy)) {
    if (isScopeError(body)) return { ok: false, reason: 'scope' };
    if (!hasErrors(body)) return { ok: false, reason: 'bad-response' };
    // GitHub refused part of the query (the history, for example): ask for the current sponsorship alone.
    const second = await post(f, token, QUERY_CURRENT, { login: policy.sponsorable }, timeoutMs);
    if (!second.ok) return second;
    body = second.body;
    data = body && body.data;
    const r = evaluate(data, policy);
    if (r) return { ok: true, ...r };
    return { ok: false, reason: isScopeError(body) ? 'scope' : 'bad-response' };
  }
  // A partial answer (for example "user not found") is still an answer: evaluate() used what is there.
  let r = evaluate(data, policy);
  let hist = data.viewer.sponsorsActivities;
  const nodes = hist && Array.isArray(hist.nodes) ? [...hist.nodes] : [];
  for (let page = 1; r.kind !== 'lifetime' && hist && hist.pageInfo && hist.pageInfo.hasNextPage && hist.pageInfo.endCursor && page < MAX_PAGES; page++) {
    const more = await post(f, token, QUERY_MORE, { after: hist.pageInfo.endCursor }, timeoutMs);
    const mh = more.ok && more.body && more.body.data && more.body.data.viewer && more.body.data.viewer.sponsorsActivities;
    if (!mh || !Array.isArray(mh.nodes)) break; // keep what we have; the current sponsorship already counted
    nodes.push(...mh.nodes);
    hist = mh;
    r = evaluate({ ...data, viewer: { ...data.viewer, sponsorsActivities: { pageInfo: mh.pageInfo, nodes } } }, policy);
  }
  return { ok: true, ...r };
}

/**
 * Create the GitHub Sponsors rail.
 * @param {{vscode?:object, context:object, fetch?:Function, now?:()=>number, timeoutMs?:number}} opts
 */
function createSponsorsRail(opts) {
  const vscode = opts.vscode || require('vscode'); // eslint-disable-line global-require
  const { context } = opts;
  const now = opts.now || Date.now;
  const fetchImpl = opts.fetch;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const secrets = context.secrets;
  const gstate = context.globalState;
  const listeners = new Set();
  let record = null;
  let lastAttemptAt = 0;
  let busy = null;
  let writing = 0; // our own SecretStorage writes in flight: ignore their change events

  const pro = () => !!record;
  function fire(before) {
    if (before === pro()) return;
    for (const l of [...listeners]) { try { l(pro()); } catch { /* a listener error must not break the rail */ } }
  }

  // initial: true at start-up. A missing secret then falls back to the globalState copy (keychain reset) and
  // restores the secret. On a change event from another window only the secret counts, so a removal sticks.
  async function readStore(initial) {
    let fromSecret = null;
    let secretOk = true;
    try { fromSecret = parseRecord(await secrets.get(STORE_KEY)); } catch { secretOk = false; }
    if (fromSecret) return fromSecret;
    if (secretOk && !initial) return null;
    let fromState = null;
    try { fromState = cleanRecord(gstate.get(STORE_KEY)); } catch { fromState = null; }
    if (fromState && secretOk) {
      writing++;
      try { await secrets.store(STORE_KEY, JSON.stringify(fromState)); } catch { /* keychain off: globalState still has it */ } finally { writing--; }
    }
    return fromState;
  }

  // globalState first on removal, so a change event can never bring a removed record back.
  async function writeStore(r) {
    writing++;
    try {
      if (r) {
        try { await gstate.update(STORE_KEY, r); } catch { /* ignore */ }
        try { await secrets.store(STORE_KEY, JSON.stringify(r)); } catch { /* globalState copy is the fallback */ }
      } else {
        try { await gstate.update(STORE_KEY, undefined); } catch { /* ignore */ }
        try { await secrets.delete(STORE_KEY); } catch { /* ignore */ }
      }
    } finally { writing--; }
  }

  async function load(initial) {
    if (initial) {
      // Records from v1 (Pro for any USD 10 paid in total, notemods tiers included) are not honoured: delete them.
      for (const k of LEGACY_KEYS) {
        try { if (gstate.get(k) !== undefined) await gstate.update(k, undefined); } catch { /* ignore */ }
        try { if (await secrets.get(k)) await secrets.delete(k); } catch { /* ignore */ }
      }
    }
    const r = await readStore(initial);
    const before = pro();
    record = r;
    fire(before);
  }

  const ready = load(true);

  // Another window of the same extension unlocked or removed: follow it.
  if (secrets && hasShape(secrets.onDidChange)) {
    const sub = secrets.onDidChange((e) => { if (writing === 0 && (!e || e.key === STORE_KEY)) load(false); });
    if (context.subscriptions && sub) context.subscriptions.push(sub);
  }

  async function getSession(interactive, forceNew) {
    const options = forceNew ? { forceNewSession: true } : interactive ? { createIfNone: true } : { silent: true };
    try {
      const s = await vscode.authentication.getSession('github', SCOPES, options);
      return s && s.accessToken ? { session: s } : { reason: 'no-session' };
    } catch {
      return { reason: interactive ? 'cancelled' : 'no-session' };
    }
  }

  async function apply(check, why) {
    const before = pro();
    const next = nextRecord(record, check, now(), why);
    if (next !== record) { record = next; await writeStore(next); }
    fire(before);
  }

  function result(reason, check) {
    return { rail: RAIL_ID, pro: pro(), reason, kind: record ? record.kind : 'none', login: (check && check.login) || (record && record.login) || '', message: MESSAGES[reason] };
  }

  /**
   * Unlock: the only place that may show the GitHub sign-in. Call it from the user's click.
   * @returns {Promise<{rail:string, pro:boolean, reason:string, kind:string, login:string, message:string}>}
   */
  async function unlock() {
    await ready;
    let got = await getSession(true, false);
    if (!got.session) return result(got.reason);
    let check = await queryGitHub(got.session.accessToken, { fetchImpl, timeoutMs });
    if (!check.ok && (check.reason === 'auth' || check.reason === 'scope')) {
      // A stale or narrow token: ask VS Code for a fresh one once (the user is in the flow already).
      got = await getSession(true, true);
      if (!got.session) return result(got.reason);
      check = await queryGitHub(got.session.accessToken, { fetchImpl, timeoutMs });
    }
    lastAttemptAt = now();
    await apply(check, 'unlock');
    if (!check.ok) return result(check.reason);
    if (check.kind === 'none') {
      const reason = check.sponsored ? 'other-tier' : 'not-sponsor';
      return pro() ? { ...result('ok', check), note: reason } : result(reason, check);
    }
    return result('ok', check);
  }

  /**
   * Silent recheck for a monthly entitlement whose 30 days are over. Never prompts. Does nothing (no network)
   * for lifetime, for no entitlement, before the recheck date, or within a day of a failed try.
   * Call it when the user starts a Pro feature, without awaiting it.
   * @returns {Promise<boolean>} true when it asked GitHub
   */
  function refresh() {
    if (busy) return busy;
    busy = (async () => {
      await ready;
      const t = now();
      if (!record || record.kind !== 'monthly' || t < record.recheckAt || t - lastAttemptAt < RETRY_MS) return false;
      lastAttemptAt = t;
      const got = await getSession(false, false);
      if (!got.session) return true; // no silent session: keep Pro, try again tomorrow
      const check = await queryGitHub(got.session.accessToken, { fetchImpl, timeoutMs });
      await apply(check, 'recheck');
      return true;
    })().finally(() => { busy = null; });
    return busy;
  }

  return {
    id: RAIL_ID,
    ready,
    /** Pro for any Zovo sku. Reads the cache only. Before `ready` resolves it is false. */
    isPro(sku) { return typeof sku === 'string' && sku.length > 0 && pro(); },
    unlock,
    refresh,
    /** "Remove license": forget the cached entitlement on this machine. */
    async remove() { await ready; const before = pro(); record = null; await writeStore(null); fire(before); },
    /** A copy of the cached record (no token), or null. */
    state() { return record ? { ...record } : null; },
    /** listener(pro:boolean) when Pro turns on or off. Returns a disposable. */
    onDidChange(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    /** Open the GitHub Sponsors page (user click only). */
    openSponsorsPage() { return vscode.env.openExternal(vscode.Uri.parse(BUY_URL)); },
  };
}

module.exports = {
  createSponsorsRail,
  evaluate,
  nextRecord,
  queryGitHub,
  parseRecord,
  RAIL_ID,
  SPONSORABLE,
  SPONSORS_URL,
  GRAPHQL_URL,
  SCOPES,
  ZOVO_TIER_IDS,
  ZOVO_TIER_DB_ID,
  MONTHLY_TIER_IDS,
  NOTEMODS_TIER_IDS,
  POLICY,
  BUY_URL,
  PRICE_TEXT,
  MAX_PAGES,
  LEGACY_KEYS,
  RECHECK_MS,
  RETRY_MS,
  STORE_KEY,
  QUERY,
  QUERY_MORE,
  QUERY_CURRENT,
  MESSAGES,
};
