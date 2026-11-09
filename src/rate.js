'use strict';
// Shared Zovo rating ask, v2.2 (factory/sprint/rating/rate.js, copied to src/rate.js in each extension).
// No network and no telemetry. State lives only in context.globalState. The one outbound action is the
// review page of the store the editor installs from (VS Code: Marketplace; Cursor, Windsurf, VSCodium and other
// Open VSX editors: Open VSX), opened by the user's own click on "Rate it".
//
// Rules:
// - Ask only after the user opened 2 files without an error, in 2 window sessions that started at least 4 hours
//   apart. A session starts at its first file opened without an error. A window that stays open starts a new
//   session at its first good file 4 hours or more after its current session started (v2.2).
// - Show the ask 3 seconds after that success, not while the file renders, and only if the rules still hold then.
// - Files from the extension's own folder or storage (walkthrough samples) do not count.
// - "Rate it" opens the review page of the store this editor uses and ends it. "No thanks" ends it.
// - "Later" (or closing the message) asks again one time, 7 days later at the earliest.
// - At most 2 asks in all, at most 1 per window session, only while the window has focus.
// - Never after an error: no ask in a session where a file failed to open, and none for 24 hours after a failure.
// - The setting <section>.askForRating = false turns it off.
// The rules are pure functions (recordSuccess, recordFailure, decide, recordAnswer, isSampleFile) for unit tests.

const STATE_KEY = 'zovo.rating.v2'; // v2.1 keeps the v2 key and reads v2 states in place
const OLD_KEY = 'zovo.rating.v1';
const RULES = '2.2';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_FILES = 2; // files opened without an error before the first ask
const MIN_GAP_MS = 4 * HOUR_MS; // the first and the last session with a success must start this far apart
const MAX_SESSIONS = 8; // session start times kept (the first one and the newest ones)
const ASK_DELAY_MS = 3000; // wait after the success, so the file is on screen before the question
const LATER_DAYS = 7; // "Later" waits this long
const MAX_ASKS = 2; // asks in all
const ERROR_QUIET_MS = DAY_MS; // no ask for this long after a failure
const RATE = 'Rate it';
const LATER = 'Later';
const NEVER = 'No thanks';
// Fake clock for manual and VS Code tests: shifts "now" by these many days and hours. Unset in normal use.
const CLOCK_ENV = 'ZOVO_RATING_CLOCK_OFFSET_DAYS';
const CLOCK_ENV_HOURS = 'ZOVO_RATING_CLOCK_OFFSET_HOURS';
const MARKETPLACE = 'marketplace';
const OPENVSX = 'openvsx';

function freshState() {
  return { rules: RULES, count: 0, sessions: [], asks: 0, nextAskAt: 0, lastErrorAt: 0, done: false };
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

/** Session start times: positive numbers, unique, oldest first, at most MAX_SESSIONS (the first and the newest). */
function cleanSessions(list) {
  const t = [...new Set(list.map((x) => num(x, 0)).filter((x) => x > 0))].sort((a, b) => a - b);
  return t.length > MAX_SESSIONS ? [t[0], ...t.slice(t.length - MAX_SESSIONS + 1)] : t;
}

/** Local calendar day of a timestamp, as YYYY-MM-DD. */
function dayKey(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The last millisecond of a local calendar day YYYY-MM-DD, or 0. */
function dayEnd(day) {
  if (!isDay(day)) return 0;
  const [y, m, d] = day.split('-').map(Number);
  return num(new Date(y, m - 1, d, 23, 59, 59, 999).getTime(), 0);
}

function normalize(raw) {
  const s = freshState();
  if (!raw || typeof raw !== 'object') return s;
  s.count = num(raw.count, 0);
  if (Array.isArray(raw.sessions)) {
    s.sessions = cleanSessions(raw.sessions);
  } else if (Array.isArray(raw.days)) {
    // A v2 state has calendar days, not times. Its newest day counts as one session at the end of that day,
    // so a new session counts only when it starts 4 hours or more after any v2 use.
    const days = raw.days.filter(isDay).sort();
    const end = days.length ? dayEnd(days[days.length - 1]) : 0;
    s.sessions = end ? [end] : [];
  }
  s.asks = Math.min(MAX_ASKS, num(raw.asks, 0));
  s.nextAskAt = num(raw.nextAskAt, 0);
  s.lastErrorAt = num(raw.lastErrorAt, 0);
  s.done = raw.done === true || s.asks >= MAX_ASKS;
  return s;
}

/** State of the v1 prompt (5 files and 2 days, "Don't ask again"): keep its answers, asks and first use. */
function fromV1(old) {
  const s = freshState();
  if (!old || typeof old !== 'object') return s;
  s.count = num(old.count, 0);
  const first = num(old.firstUse, 0);
  if (first) s.sessions = [first];
  s.asks = Math.min(MAX_ASKS, num(old.asks, 0));
  s.done = old.done === true || s.asks >= MAX_ASKS;
  return s;
}

/** Time between the first and the last session with a success. */
function spreadMs(state) {
  const t = normalize(state).sessions;
  return t.length < 2 ? 0 : t[t.length - 1] - t[0];
}

/** A file opened without an error. sessionStart: when this window session had its first success (default now). */
function recordSuccess(state, now, sessionStart) {
  const s = normalize(state);
  s.count += 1;
  const start = num(sessionStart, 0) || num(now, 0);
  if (start) s.sessions = cleanSessions([...s.sessions, start]);
  return s;
}

/** A file failed to open. */
function recordFailure(state, now) {
  const s = normalize(state);
  s.lastErrorAt = Math.max(s.lastErrorAt, num(now, 0));
  return s;
}

/**
 * Should the ask show now? Call it right after recordSuccess, and again just before showing.
 * env: { now, enabled, focused, askedThisSession, errorThisSession }
 */
function decide(state, env) {
  const s = normalize(state);
  if (s.done || !env.enabled) return false;
  if (env.askedThisSession || env.errorThisSession || env.focused === false) return false;
  if (s.asks >= MAX_ASKS) return false;
  if (s.count < MIN_FILES || spreadMs(s) < MIN_GAP_MS) return false;
  if (s.lastErrorAt && env.now - s.lastErrorAt < ERROR_QUIET_MS) return false;
  return env.now >= s.nextAskAt;
}

/**
 * Apply an answer. 'shown' is saved before the message opens, so an ask is used up even if VS Code
 * quits with the message open. "Rate it" and "No thanks" end it; "Later" or no answer wait 7 days.
 */
function recordAnswer(state, answer, now) {
  const s = normalize(state);
  if (answer === 'shown') {
    s.asks += 1;
    s.nextAskAt = num(now, 0) + LATER_DAYS * DAY_MS;
  } else if (answer === RATE || answer === NEVER) {
    s.done = true;
  }
  if (s.asks >= MAX_ASKS) s.done = true;
  return s;
}

/**
 * The store this editor installs extensions from, read from vscode.env: 'marketplace' for VS Code (desktop, web,
 * Insiders, Codespaces), 'openvsx' for the other VS Code-based editors (Cursor, Windsurf, VSCodium, Trae, Kiro,
 * Positron, code-server, Gitpod). They install from Open VSX, and their users have no reason to sign in to the
 * Microsoft Marketplace. Unknown or missing values keep the Marketplace.
 */
function storeFor(env) {
  const scheme = String((env && env.uriScheme) || '').toLowerCase();
  const app = String((env && env.appName) || '').toLowerCase();
  if (!scheme && !app) return MARKETPLACE;
  if (/^vscode(-insiders|-exploration)?$/.test(scheme)) return MARKETPLACE;
  if (app.startsWith('visual studio code')) return MARKETPLACE;
  return OPENVSX;
}

/** The review page of an extension: the Marketplace review tab, or the Open VSX reviews tab. */
function reviewUrl(extensionId, store) {
  const id = String(extensionId || '');
  if (store === OPENVSX) {
    const dot = id.indexOf('.');
    const ns = dot > 0 ? id.slice(0, dot) : id;
    const name = dot > 0 ? id.slice(dot + 1) : '';
    return `https://open-vsx.org/extension/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/reviews`;
  }
  return `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(id)}&ssr=false#review-details`;
}

function messageFor(name) {
  return `Is ${name} useful? A rating helps others find it.`;
}

/** Days and hours to add to the clock, from ZOVO_RATING_CLOCK_OFFSET_DAYS (0 to 3650) and
 * ZOVO_RATING_CLOCK_OFFSET_HOURS (0 to 87600). An unset or out-of-range value adds 0. */
function clockOffsetMs(envVars) {
  const part = (key, max, unit) => {
    const v = Number(envVars && envVars[key]);
    return Number.isFinite(v) && v > 0 && v <= max ? v * unit : 0;
  };
  return Math.round(part(CLOCK_ENV, 3650, DAY_MS) + part(CLOCK_ENV_HOURS, 87600, HOUR_MS));
}

const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The file path of a success target: a vscode.Uri, a document ({ uri }), or a path string. */
function targetPath(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t !== 'object') return '';
  if (t.uri && t.uri !== t) return targetPath(t.uri);
  if (typeof t.fsPath === 'string') return t.fsPath;
  if (typeof t.path === 'string') return t.path;
  return '';
}

/** Folders whose files are not the user's own: the installed extension and its storage. */
function sampleRoots(context) {
  const c = context || {};
  const fp = (u) => (u && typeof u.fsPath === 'string' ? u.fsPath : '');
  const roots = [fp(c.extensionUri), c.extensionPath, fp(c.globalStorageUri), c.globalStoragePath, fp(c.storageUri), c.storagePath];
  return [...new Set(roots.map(normPath).filter(Boolean))];
}

/** A walkthrough sample: marked { sample: true }, or a file inside one of the roots. */
function isSampleFile(target, roots) {
  if (target && typeof target === 'object' && target.sample === true) return true;
  const p = normPath(targetPath(target));
  if (!p) return false;
  return (roots || []).some((r) => r && (p === r || p.startsWith(r + '/')));
}

/**
 * opts: { vscode, context, extensionId, section, name, now?, delayMs? }
 * Returns { success(target?), failure() }. Call success(document.uri) once per file that opened without an
 * error, failure() when a file could not be opened. Both never throw. success() without a target counts the
 * file (as in v2), so pass the uri to keep walkthrough samples out.
 */
function createRatingPrompt(opts) {
  const { vscode, context, extensionId, section, name } = opts;
  const offset = clockOffsetMs(typeof process !== 'undefined' ? process.env : null);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now() + offset;
  const delayMs = typeof opts.delayMs === 'number' && opts.delayMs >= 0 ? opts.delayMs : ASK_DELAY_MS;
  const store = context && context.globalState;
  const usable = !!(store && typeof store.get === 'function' && typeof store.update === 'function');
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const roots = safe(() => sampleRoots(context), []);
  const reviewStore = safe(() => storeFor(vscode.env), MARKETPLACE);
  let askedThisSession = false;
  let errorThisSession = false;
  let sessionStart = 0;
  let busy = false;

  function load() {
    const cur = store.get(STATE_KEY);
    if (cur && typeof cur === 'object') return normalize(cur);
    return fromV1(store.get(OLD_KEY));
  }

  const env = () => ({
    now: now(),
    enabled: safe(() => vscode.workspace.getConfiguration(section).get('askForRating', true) !== false, false),
    focused: safe(() => vscode.window.state.focused !== false, true),
    askedThisSession,
    errorThisSession,
  });

  async function ask(s, e) {
    askedThisSession = true;
    let st = recordAnswer(s, 'shown', e.now);
    await store.update(STATE_KEY, st);
    const pick = await vscode.window.showInformationMessage(messageFor(name), RATE, LATER, NEVER);
    st = recordAnswer(load(), pick, now());
    await store.update(STATE_KEY, st);
    if (pick === RATE) await vscode.env.openExternal(vscode.Uri.parse(reviewUrl(extensionId, reviewStore)));
  }

  async function success(target) {
    if (!usable || isSampleFile(target, roots)) return;
    const e = env();
    // A window that stays open for days is still used on several occasions: its first good file 4 hours or more
    // after the current session started begins a new session (and a failure from the earlier one no longer blocks).
    if (!sessionStart || e.now - sessionStart >= MIN_GAP_MS) {
      if (sessionStart) errorThisSession = false;
      sessionStart = e.now;
    }
    const s = recordSuccess(load(), e.now, sessionStart);
    await store.update(STATE_KEY, s);
    if (busy || !decide(s, e)) return;
    busy = true;
    try {
      // Let the file render first. A failure, a lost focus or another ask in the meantime cancels it.
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const e2 = env();
      const s2 = load();
      if (decide(s2, e2)) await ask(s2, e2);
    } finally { busy = false; }
  }

  async function failure() {
    errorThisSession = true;
    if (!usable) return;
    await store.update(STATE_KEY, recordFailure(load(), now()));
  }

  return {
    success: (target) => success(target).catch(() => {}),
    failure: () => failure().catch(() => {}),
  };
}

module.exports = {
  createRatingPrompt, decide, recordSuccess, recordFailure, recordAnswer, normalize, freshState, fromV1,
  spreadMs, cleanSessions, dayKey, dayEnd, reviewUrl, storeFor, messageFor, clockOffsetMs, isSampleFile, sampleRoots, targetPath,
  STATE_KEY, OLD_KEY, RULES, HOUR_MS, DAY_MS, MIN_FILES, MIN_GAP_MS, MAX_SESSIONS, ASK_DELAY_MS, LATER_DAYS, MAX_ASKS,
  ERROR_QUIET_MS, RATE, LATER, NEVER, CLOCK_ENV, CLOCK_ENV_HOURS, MARKETPLACE, OPENVSX,
};
