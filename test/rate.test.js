'use strict';
// Tests for the shared rating ask v2.2 (factory/sprint/rating). Copied unchanged into each extension's test/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../src/rate.js');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const DAY = R.DAY_MS;
const HOUR = R.HOUR_MS;
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m, 0).getTime(); // local time, November 2026
const T0 = at(2, 10); // local 10:00
const env = (over = {}) => ({ now: T0 + DAY, enabled: true, focused: true, askedThisSession: false, errorThisSession: false, ...over });

/** n successes in one session that started at `start` (its first success), the last one at `now`. */
function opens(n, now = T0, state, start = now) {
  let s = state;
  for (let i = 0; i < n; i++) s = R.recordSuccess(s, now, start);
  return s;
}
// 1 file in a session at 10:00 on day 0 and 1 file in a session on day 1: ready for the first ask on day 1.
const ready = () => opens(1, T0 + DAY, opens(1));

test('rating: message and buttons', () => {
  assert.equal(R.messageFor('DOCX Viewer'), 'Is DOCX Viewer useful? A rating helps others find it.');
  assert.deepEqual([R.RATE, R.LATER, R.NEVER], ['Rate it', 'Later', 'No thanks']);
});

test('rating: v2.1 constants (v2.2 keeps them)', () => {
  assert.equal(R.MIN_FILES, 2);
  assert.equal(R.MIN_GAP_MS, 4 * HOUR);
  assert.equal(R.ASK_DELAY_MS, 3000);
  assert.equal(R.LATER_DAYS, 7);
  assert.equal(R.MAX_ASKS, 2);
  assert.equal(R.ERROR_QUIET_MS, DAY);
  assert.equal(R.STATE_KEY, 'zovo.rating.v2');
});

test('rating: 2 files in 2 sessions 4 hours apart ask; 1 file does not', () => {
  assert.equal(R.decide(opens(1), env({ now: T0 })), false, '1 file');
  assert.equal(R.decide(ready(), env()), true, '1 file in each of 2 sessions, 24 h apart');
  assert.equal(ready().count, 2);
  assert.equal(ready().sessions.length, 2);
});

test('rating: no ask while all files were opened in one session', () => {
  const s = opens(50, T0 + 10 * HOUR, undefined, T0); // one long session: 10 hours of use, 50 files
  assert.equal(s.sessions.length, 1);
  assert.equal(R.decide(s, env({ now: T0 + 10 * HOUR })), false);
  assert.equal(R.decide(s, env({ now: T0 + 5 * DAY })), false, 'time alone does not count, a second session does');
  const s2 = opens(1, T0 + 5 * DAY, s);
  assert.equal(R.decide(s2, env({ now: T0 + 5 * DAY })), true);
});

test('rating clock: 23:50 and 00:10 (2 calendar days, 20 minutes) do not pass', () => {
  const late = at(2, 23, 50);
  const early = at(3, 0, 10);
  const s = opens(1, early, opens(1, late));
  assert.equal(s.count, 2);
  assert.equal(s.sessions.length, 2);
  assert.equal(R.decide(s, env({ now: early })), false);
  assert.notEqual(R.dayKey(late), R.dayKey(early), 'v2 would have passed: 2 calendar days');
});

test('rating clock: 09:00 and 15:00 on one day pass', () => {
  const s = opens(1, at(4, 15), opens(1, at(4, 9)));
  assert.equal(R.dayKey(at(4, 9)), R.dayKey(at(4, 15)), 'v2 would have failed: 1 calendar day');
  assert.equal(R.decide(s, env({ now: at(4, 15) })), true);
});

test('rating clock: the gap is 4 hours, to the minute', () => {
  const a = at(5, 8);
  assert.equal(R.decide(opens(1, a + 4 * HOUR - 60000, opens(1, a)), env({ now: a + 4 * HOUR - 60000 })), false, '3 h 59 min');
  assert.equal(R.decide(opens(1, a + 4 * HOUR, opens(1, a)), env({ now: a + 4 * HOUR })), true, '4 h 00 min');
});

test('rating clock: the gap is between session starts, not between files', () => {
  // Session 1 starts 09:00 and stays open; a file at 14:00 in it does not make a second session.
  const s = opens(1, at(6, 14), opens(1, at(6, 9)), at(6, 9));
  assert.equal(s.sessions.length, 1);
  assert.equal(R.decide(s, env({ now: at(6, 14) })), false);
  // A new session at 11:00 (2 h after 09:00) with 3 files: no. A session at 13:00: yes.
  const s2 = opens(3, at(6, 11), s);
  assert.equal(R.decide(s2, env({ now: at(6, 11) })), false);
  assert.equal(R.decide(opens(1, at(6, 13), s2), env({ now: at(6, 13) })), true);
});

test('rating: session list stays short and keeps the first session', () => {
  let s;
  for (let i = 0; i < 30; i++) s = opens(1, T0 + i * HOUR, s);
  assert.equal(s.sessions.length, R.MAX_SESSIONS);
  assert.equal(s.sessions[0], T0);
  assert.equal(s.sessions[s.sessions.length - 1], T0 + 29 * HOUR);
  assert.equal(R.spreadMs(s), 29 * HOUR);
});

test('rating: never after an error', () => {
  const s = ready();
  assert.equal(R.decide(s, env({ errorThisSession: true })), false, 'a failure in this session');
  const f = R.recordFailure(s, T0 + DAY - 1000);
  assert.equal(R.decide(f, env()), false, 'failure 1 s ago');
  assert.equal(R.decide(f, env({ now: T0 + 2 * DAY - 2000 })), false, 'failure 23 h ago');
  assert.equal(R.decide(f, env({ now: T0 + 2 * DAY })), true, 'failure more than 24 h ago, new session');
  assert.equal(R.recordFailure(s, 5).count, s.count, 'a failure does not count as a file');
});

test('rating: "Later" asks again one time, 7 days later', () => {
  const t1 = T0 + DAY;
  let s = R.recordAnswer(ready(), 'shown', t1);
  s = R.recordAnswer(s, R.LATER, t1);
  assert.equal(s.done, false);
  assert.equal(s.asks, 1);
  assert.equal(R.decide(opens(5, t1 + 6 * DAY, s), env({ now: t1 + 6 * DAY })), false, 'after 6 days');
  assert.equal(R.decide(opens(1, t1 + 7 * DAY, s), env({ now: t1 + 7 * DAY })), true, 'after 7 days');
  s = R.recordAnswer(opens(1, t1 + 7 * DAY, s), 'shown', t1 + 7 * DAY);
  s = R.recordAnswer(s, R.LATER, t1 + 7 * DAY);
  assert.equal(s.done, true, 'the second ask is the last');
  assert.equal(R.decide(opens(100, t1 + 60 * DAY, s), env({ now: t1 + 60 * DAY })), false);
});

test('rating: never more than 2 asks in all, whatever the answers', () => {
  let s = opens(3);
  let asks = 0;
  for (let h = 1; h < 400 * 24; h += 5) {
    const now = T0 + h * HOUR;
    s = R.recordSuccess(s, now, now);
    if (R.decide(s, env({ now }))) {
      asks++;
      s = R.recordAnswer(s, 'shown', now);
      s = R.recordAnswer(s, undefined, now); // closed without an answer
    }
  }
  assert.equal(asks, 2);
  assert.equal(s.done, true);
});

test('rating: closing the message counts like "Later"', () => {
  const s = R.recordAnswer(R.recordAnswer(ready(), 'shown', T0 + DAY), undefined, T0 + DAY);
  assert.equal(s.done, false);
  assert.equal(R.decide(s, env({ now: T0 + 2 * DAY })), false);
  assert.equal(R.decide(s, env({ now: T0 + 8 * DAY })), true);
});

test('rating: "Rate it" and "No thanks" end it', () => {
  for (const a of [R.RATE, R.NEVER]) {
    const s = R.recordAnswer(R.recordAnswer(ready(), 'shown', T0 + DAY), a, T0 + DAY);
    assert.equal(s.done, true);
    assert.equal(R.decide(opens(500, T0 + 30 * DAY, s), env({ now: T0 + 30 * DAY })), false);
  }
});

test('rating: setting off, unfocused window, already asked in this session', () => {
  const s = ready();
  assert.equal(R.decide(s, env({ enabled: false })), false);
  assert.equal(R.decide(s, env({ focused: false })), false);
  assert.equal(R.decide(s, env({ askedThisSession: true })), false);
});

test('rating: bad stored state is reset safely', () => {
  for (const bad of [null, 'x', 42, { count: -3, sessions: 'x', asks: NaN, nextAskAt: -1 }, { sessions: [T0, 'junk', -5, NaN, null] }, { days: 'x' }]) {
    const s = R.normalize(bad);
    assert.equal(s.count, 0);
    assert.equal(s.asks, 0);
    assert.equal(s.done, false);
    assert.ok(s.sessions.length <= 1);
    assert.ok(s.sessions.every((t) => Number.isFinite(t) && t > 0));
  }
  assert.equal(R.normalize({ asks: 9 }).done, true, 'more asks than allowed means done');
});

test('migration: a v2 state keeps its count, asks and answers', () => {
  const v2 = { count: 7, days: ['2026-11-02', '2026-11-03'], asks: 1, nextAskAt: T0 + 9 * DAY, lastErrorAt: T0, done: false };
  const s = R.normalize(v2);
  assert.equal(s.count, 7);
  assert.equal(s.asks, 1);
  assert.equal(s.nextAskAt, T0 + 9 * DAY);
  assert.equal(s.lastErrorAt, T0);
  assert.equal(s.done, false);
  assert.deepEqual(s.sessions, [at(3, 23, 59) + 59999], 'the newest v2 day, as one session at its last millisecond');
  assert.equal(R.normalize(s).sessions[0], s.sessions[0], 'normalize is stable');
});

test('migration: a v2 user who said "No thanks" or was asked twice is never asked again', () => {
  for (const v2 of [{ count: 9, days: ['2026-11-01', '2026-11-02'], asks: 1, done: true }, { count: 9, days: ['2026-11-01'], asks: 2, done: false }]) {
    const s = R.normalize(v2);
    assert.equal(s.done, true);
    assert.equal(R.decide(opens(10, T0 + 40 * DAY, s), env({ now: T0 + 40 * DAY })), false);
  }
});

test('migration: v2 days give no credit for use less than 4 hours ago', () => {
  // v2 saw a file on 2026-11-02 (maybe at 23:50). A session at 00:10 or 03:59 on 11-03 does not pass, 04:00 does.
  const v2 = { count: 3, days: ['2026-11-02'], asks: 0, done: false };
  assert.equal(R.decide(opens(1, at(3, 0, 10), v2), env({ now: at(3, 0, 10) })), false);
  assert.equal(R.decide(opens(1, at(3, 3, 59), v2), env({ now: at(3, 3, 59) })), false);
  assert.equal(R.decide(opens(1, at(3, 4, 0), v2), env({ now: at(3, 4, 0) })), true);
});

test('migration: v1 state keeps its answers', () => {
  assert.equal(R.fromV1({ count: 9, firstUse: T0, asks: 1, done: true }).done, true, '"Don\'t ask again" or "Rate it" in v1');
  const s = R.fromV1({ count: 9, firstUse: T0, asks: 1, done: false });
  assert.equal(s.asks, 1, 'a v1 ask counts toward the 2');
  assert.deepEqual(s.sessions, [T0]);
  assert.equal(R.fromV1({ asks: 3 }).done, true);
  assert.equal(R.fromV1({ count: 5, asks: 2 }).done, true, 'asked twice in v1');
  assert.deepEqual(R.fromV1(undefined), R.freshState());
});

test('samples: files from the extension folder or its storage do not count', () => {
  const roots = R.sampleRoots({
    extensionUri: { fsPath: '/Users/u/.vscode/extensions/zovo.x-1.0.0' },
    globalStorageUri: { fsPath: '/Users/u/Library/Application Support/Code/User/globalStorage/zovo.x' },
  });
  const uri = (p) => ({ scheme: 'file', fsPath: p, path: p });
  assert.equal(R.isSampleFile(uri('/Users/u/.vscode/extensions/zovo.x-1.0.0/media/sample/Q3 Report.docx'), roots), true);
  assert.equal(R.isSampleFile({ uri: uri('/Users/u/Library/Application Support/Code/User/globalStorage/zovo.x/sample.npy') }, roots), true, 'a document');
  assert.equal(R.isSampleFile('/USERS/U/.vscode/extensions/zovo.x-1.0.0/media/a.pdf', roots), true, 'path string, any case');
  assert.equal(R.isSampleFile({ sample: true }, roots), true, 'marked by the caller');
  assert.equal(R.isSampleFile(uri('/Users/u/.vscode/extensions/zovo.x-1.0.0-other/a.docx'), roots), false, 'a sibling folder');
  assert.equal(R.isSampleFile(uri('/Users/u/work/report.docx'), roots), false, 'a user file');
  assert.equal(R.isSampleFile(undefined, roots), false, 'no target: counts, as in v2');
  assert.equal(R.isSampleFile('C:\\Users\\u\\.vscode\\extensions\\zovo.x-1.0.0\\media\\s.docx', R.sampleRoots({ extensionPath: 'C:\\Users\\u\\.vscode\\extensions\\zovo.x-1.0.0\\' })), true, 'Windows paths');
  assert.deepEqual(R.sampleRoots(undefined), []);
});

test('rating: fake clock only from the env variables, bounded', () => {
  assert.equal(R.clockOffsetMs({}), 0);
  assert.equal(R.clockOffsetMs(null), 0);
  assert.equal(R.clockOffsetMs({ [R.CLOCK_ENV]: '1' }), DAY);
  assert.equal(R.clockOffsetMs({ [R.CLOCK_ENV]: '-3' }), 0);
  assert.equal(R.clockOffsetMs({ [R.CLOCK_ENV]: 'x' }), 0);
  assert.equal(R.clockOffsetMs({ [R.CLOCK_ENV]: '99999' }), 0);
  assert.equal(R.clockOffsetMs({ [R.CLOCK_ENV_HOURS]: '5' }), 5 * HOUR);
  assert.equal(R.clockOffsetMs({ [R.CLOCK_ENV_HOURS]: '0.5' }), HOUR / 2);
  assert.equal(R.clockOffsetMs({ [R.CLOCK_ENV]: '2', [R.CLOCK_ENV_HOURS]: '6' }), 2 * DAY + 6 * HOUR);
  assert.equal(R.clockOffsetMs({ [R.CLOCK_ENV_HOURS]: '-1' }), 0);
  assert.equal(R.clockOffsetMs({ [R.CLOCK_ENV_HOURS]: '100000' }), 0);
});

test('rating: review link points at this extension, in the store of the editor', () => {
  const id = `${pkg.publisher}.${pkg.name}`;
  assert.equal(R.reviewUrl(id), `https://marketplace.visualstudio.com/items?itemName=${id}&ssr=false#review-details`);
  assert.equal(R.reviewUrl(id, R.MARKETPLACE), R.reviewUrl(id));
  assert.equal(R.reviewUrl(id, R.OPENVSX), `https://open-vsx.org/extension/${pkg.publisher}/${pkg.name}/reviews`);
});

test('rating v2.2: the store comes from the editor (VS Code: Marketplace, others: Open VSX)', () => {
  const st = (appName, uriScheme) => R.storeFor({ appName, uriScheme });
  assert.equal(st('Visual Studio Code', 'vscode'), R.MARKETPLACE);
  assert.equal(st('Visual Studio Code - Insiders', 'vscode-insiders'), R.MARKETPLACE);
  assert.equal(st('Visual Studio Code', undefined), R.MARKETPLACE, 'vscode.dev and Codespaces');
  assert.equal(st('Cursor', 'cursor'), R.OPENVSX);
  assert.equal(st('Windsurf', 'windsurf'), R.OPENVSX);
  assert.equal(st('VSCodium', 'vscodium'), R.OPENVSX);
  assert.equal(st('Trae', 'trae'), R.OPENVSX);
  assert.equal(st('code-server', 'code-oss'), R.OPENVSX);
  assert.equal(st('Positron', 'positron'), R.OPENVSX);
  assert.equal(R.storeFor(undefined), R.MARKETPLACE, 'unknown keeps the Marketplace');
  assert.equal(R.storeFor({}), R.MARKETPLACE);
});

test('rating: manifest has an askForRating setting, default true', () => {
  const props = pkg.contributes.configuration.properties || {};
  const key = Object.keys(props).find((k) => k.endsWith('.askForRating'));
  assert.ok(key, 'askForRating setting');
  assert.equal(props[key].type, 'boolean');
  assert.equal(props[key].default, true);
});

const EXT_DIR = '/x/.vscode/extensions/zovo.x-1.0.0';
const fileUri = (p) => ({ scheme: 'file', fsPath: p, path: p });

function fake(o = {}) {
  const calls = { shown: [], opened: [] };
  let answer = o.answer;
  const vscode = {
    env: { openExternal: async (u) => { calls.opened.push(String(u)); return true; } },
    Uri: { parse: (s) => ({ toString: () => s }) },
    window: {
      state: { focused: true },
      showInformationMessage: async (msg, ...items) => { calls.shown.push([msg, items, clock.t]); return answer; },
    },
    workspace: { getConfiguration: () => ({ get: (k, d) => (k === 'askForRating' && 'enabled' in o ? o.enabled : d) }) },
  };
  const data = new Map(o.data || []);
  const context = { extensionUri: { fsPath: EXT_DIR }, globalState: { get: (k) => data.get(k), update: async (k, v) => { data.set(k, v); } } };
  const clock = { t: T0 };
  const make = (delayMs = 0) => R.createRatingPrompt({ vscode, context, extensionId: 'zovo.x', section: 'x', name: 'X Viewer', now: () => clock.t, delayMs });
  return { vscode, context, calls, data, clock, make, setAnswer: (a) => { answer = a; } };
}

test('rating: wiring asks once in the second session, opens the review page on "Rate it"', async () => {
  const f = fake({ answer: R.RATE });
  let p = f.make();
  for (let i = 0; i < 5; i++) await p.success(fileUri(`/w/a${i}.docx`));
  assert.equal(f.calls.shown.length, 0, 'session 1');
  f.clock.t = T0 + 3 * HOUR;
  p = f.make();
  await p.success(fileUri('/w/b.docx'));
  assert.equal(f.calls.shown.length, 0, 'session 2, 3 hours later: no');
  f.clock.t = T0 + 5 * HOUR;
  p = f.make();
  await p.success(fileUri('/w/c.docx'));
  await p.success(fileUri('/w/d.docx'));
  assert.equal(f.calls.shown.length, 1, 'session 3, 5 hours after session 1');
  assert.deepEqual(f.calls.shown[0].slice(0, 2), ['Is X Viewer useful? A rating helps others find it.', [R.RATE, R.LATER, R.NEVER]]);
  assert.deepEqual(f.calls.opened, [R.reviewUrl('zovo.x')]);
  assert.equal(f.data.get(R.STATE_KEY).done, true);
  f.clock.t = T0 + 30 * DAY;
  await f.make().success();
  assert.equal(f.calls.shown.length, 1, 'never again after "Rate it"');
});

test('rating: wiring waits 3 s after the success; a failure in that time cancels the ask', async () => {
  const f = fake({ answer: R.LATER });
  await f.make().success(fileUri('/w/a.docx'));
  f.clock.t = T0 + 6 * HOUR;
  let p = f.make(40);
  const t = Date.now();
  await p.success(fileUri('/w/b.docx'));
  assert.equal(f.calls.shown.length, 1);
  assert.ok(Date.now() - t >= 35, 'shown after the delay, not at once');

  const g = fake({ answer: R.LATER });
  await g.make().success(fileUri('/w/a.docx'));
  g.clock.t = T0 + 6 * HOUR;
  p = g.make(40);
  const pending = p.success(fileUri('/w/b.docx'));
  await p.failure(); // the next file fails while the ask waits
  await pending;
  assert.equal(g.calls.shown.length, 0, 'never next to an error');

  const h = fake({ answer: R.LATER });
  await h.make().success(fileUri('/w/a.docx'));
  h.clock.t = T0 + 6 * HOUR;
  p = h.make(40);
  const pend = p.success(fileUri('/w/b.docx'));
  h.vscode.window.state.focused = false; // the user switched to another app
  await pend;
  assert.equal(h.calls.shown.length, 0, 'only with window focus');
  assert.equal(R.ASK_DELAY_MS, 3000, 'the real delay');
});

test('rating: wiring ignores walkthrough samples', async () => {
  const f = fake({ answer: R.RATE });
  const sample = fileUri(`${EXT_DIR}/media/sample/Q3 Field Report.docx`);
  await f.make().success(sample);
  f.clock.t = T0 + 6 * HOUR;
  let p = f.make();
  await p.success(sample);
  await p.success({ sample: true });
  assert.equal(f.calls.shown.length, 0, 'samples in 2 sessions: no ask');
  assert.equal(f.data.get(R.STATE_KEY), undefined, 'not even stored');
  await p.success(fileUri('/w/real.docx'));
  assert.equal(f.calls.shown.length, 0, '1 real file: no ask');
  f.clock.t = T0 + 12 * HOUR;
  p = f.make();
  await p.success(sample);
  assert.equal(f.calls.shown.length, 0, 'a sample does not make the second session');
  await p.success(fileUri('/w/real2.docx'));
  assert.equal(f.calls.shown.length, 1, 'the second real file, in a session 6 hours later');
});

test('rating: wiring, a failure in the session blocks the ask; "Later" then 7 days', async () => {
  const f = fake({ answer: R.LATER });
  let p = f.make();
  for (let i = 0; i < 3; i++) await p.success();
  f.clock.t = T0 + 2 * DAY;
  p = f.make();
  await p.failure();
  await p.success();
  assert.equal(f.calls.shown.length, 0, 'never after an error');
  f.clock.t = T0 + 4 * DAY;
  p = f.make();
  await p.success();
  assert.equal(f.calls.shown.length, 1, 'next session, 2 days after the failure');
  assert.equal(f.calls.opened.length, 0, '"Later" opens nothing');
  f.clock.t = T0 + 10 * DAY;
  await f.make().success();
  assert.equal(f.calls.shown.length, 1, '6 days later: no');
  f.clock.t = T0 + 11 * DAY;
  await f.make().success();
  assert.equal(f.calls.shown.length, 2, '7 days later: the last ask');
  f.clock.t = T0 + 40 * DAY;
  await f.make().success();
  assert.equal(f.calls.shown.length, 2, 'never a third time');
});

test('rating: wiring asks at most once a session', async () => {
  const f = fake({ answer: undefined });
  await f.make().success();
  f.clock.t = T0 + 5 * HOUR;
  const p = f.make();
  await p.success();
  f.clock.t = T0 + 20 * DAY; // same session, the 7 days have passed
  await p.success();
  assert.equal(f.calls.shown.length, 1);
});

test('rating: wiring respects the setting, v1 and v2 answers and a missing globalState', async () => {
  const off = fake({ answer: R.RATE, enabled: false });
  await off.make().success();
  off.clock.t = T0 + DAY;
  await off.make().success();
  assert.equal(off.calls.shown.length, 0, 'setting off');

  const v1 = fake({ answer: R.RATE, data: [[R.OLD_KEY, { count: 40, firstUse: T0 - 9 * DAY, asks: 1, done: true }]] });
  await v1.make().success();
  assert.equal(v1.calls.shown.length, 0, '"Don\'t ask again" in v1 is kept');

  const v2 = fake({ answer: R.RATE, data: [[R.STATE_KEY, { count: 12, days: ['2026-10-20', '2026-10-21'], asks: 1, nextAskAt: 0, lastErrorAt: 0, done: true }]] });
  await v2.make().success();
  assert.equal(v2.calls.shown.length, 0, '"No thanks" in v2 is kept');
  assert.equal(v2.data.get(R.STATE_KEY).rules, R.RULES, 'stored in the current shape');

  const v2open = fake({ answer: R.LATER, data: [[R.STATE_KEY, { count: 2, days: ['2026-10-30'], asks: 0, nextAskAt: 0, lastErrorAt: 0, done: false }]] });
  await v2open.make().success();
  assert.equal(v2open.calls.shown.length, 1, 'a v2 user with use days ago is asked at the next file');

  const none = R.createRatingPrompt({ vscode: off.vscode, context: {}, extensionId: 'zovo.x', section: 'x', name: 'X' });
  await none.success();
  await none.failure();
});

test('rating: wiring never throws when VS Code calls fail', async () => {
  const f = fake();
  f.vscode.window.showInformationMessage = async () => { throw new Error('boom'); };
  f.context.globalState.update = async () => { throw new Error('disk'); };
  const p = f.make();
  await p.success();
  await p.failure();
  const g = fake();
  Object.defineProperty(g.context, 'extensionUri', { get() { throw new Error('gone'); } });
  await g.make().success();
});

test('rating v2.2: in Cursor (Open VSX), "Rate it" opens the Open VSX reviews page', async () => {
  const f = fake({ answer: R.RATE });
  f.vscode.env.appName = 'Cursor';
  f.vscode.env.uriScheme = 'cursor';
  await f.make().success(fileUri('/w/a.docx'));
  f.clock.t = T0 + 6 * HOUR;
  await f.make().success(fileUri('/w/b.docx'));
  assert.equal(f.calls.shown.length, 1);
  assert.deepEqual(f.calls.opened, ['https://open-vsx.org/extension/zovo/x/reviews']);
  const g = fake({ answer: R.RATE });
  g.vscode.env.appName = 'Visual Studio Code';
  g.vscode.env.uriScheme = 'vscode';
  await g.make().success(fileUri('/w/a.docx'));
  g.clock.t = T0 + 6 * HOUR;
  await g.make().success(fileUri('/w/b.docx'));
  assert.deepEqual(g.calls.opened, ['https://marketplace.visualstudio.com/items?itemName=zovo.x&ssr=false#review-details']);
});

test('rating v2.2: a window that stays open starts a new session 4 hours after its session start', async () => {
  const f = fake({ answer: R.LATER });
  const p = f.make(); // one window, never closed
  await p.success(fileUri('/w/a.docx'));
  f.clock.t = T0 + 3 * HOUR + 59 * 60 * 1000;
  await p.success(fileUri('/w/b.docx'));
  assert.equal(f.calls.shown.length, 0, '3 h 59 min later in the same window: still one session');
  f.clock.t = T0 + 6 * HOUR;
  await p.success(fileUri('/w/c.docx'));
  assert.equal(f.calls.shown.length, 1, '6 h later in the same window: the 2nd session, ask');
  assert.equal(f.data.get(R.STATE_KEY).sessions.length, 2);
  f.clock.t = T0 + 20 * DAY;
  await p.success(fileUri('/w/d.docx'));
  assert.equal(f.calls.shown.length, 1, 'still at most 1 ask per window');
});

test('rating v2.2: in a long window, a failure blocks its session and 24 hours, not the later sessions', async () => {
  const f = fake({ answer: R.NEVER });
  await f.make().success(fileUri('/w/a.docx')); // an earlier window: session 1
  f.clock.t = T0 + 6 * HOUR;
  const p = f.make();
  await p.failure();
  await p.success(fileUri('/w/b.docx'));
  assert.equal(f.calls.shown.length, 0, 'same session as the failure');
  f.clock.t = T0 + 6 * HOUR + 23 * HOUR;
  await p.success(fileUri('/w/c.docx'));
  assert.equal(f.calls.shown.length, 0, 'new session, but within 24 h of the failure');
  f.clock.t = T0 + 6 * HOUR + 30 * HOUR;
  await p.success(fileUri('/w/d.docx'));
  assert.equal(f.calls.shown.length, 1, '30 h after the failure, a new session in the same window: ask');
});

test('rating: no network module and no telemetry in rate.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'rate.js'), 'utf8');
  assert.ok(!/require\((['"])(https?|net|tls|dgram|child_process)\1\)/.test(src));
  assert.ok(!/fetch\(|XMLHttpRequest|telemetry\./i.test(src.replace(/\/\/.*$/gm, '')));
});
