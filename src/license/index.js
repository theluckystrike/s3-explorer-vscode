'use strict';
// Zovo Pro facade (factory/sprint/license/index.js, lane PAY1). Copy this folder's index.js, license.js and
// sponsors.js to src/license/ in an extension, unchanged. Contract and rails: API.md.
//
// One object for the extension: isPro(sku) is true when ANY rail says so (GitHub Sponsors, offline license key,
// later Polar). isPro reads local caches only: no network at activation, on file open or in isPro.
// Network happens only after a user click: a rail's unlock() (GitHub sign-in + one GraphQL call for Sponsors;
// the key rail never uses the network) and "Get Pro", which opens a page in the browser. No telemetry.
//
//   const { createLicense } = require('./license');
//   const pro = createLicense({ vscode, context, sku: 'hex-pro', name: 'Hex Viewer', commandPrefix: 'hexViewer' });
//   await pro.ready;
//   pro.isPro('hex-pro');                          // sync
//   if (await pro.requirePro('Binary templates')) runIt();   // explains + offers unlock when locked
//
// Commands (registered when commandPrefix is set; list them in package.json, see README.md):
//   <prefix>.enterLicenseKey   "Zovo: Enter license key"
//   <prefix>.getPro            "Zovo: Get Pro"
//   <prefix>.unlockWithSponsors "Zovo: Unlock Pro with GitHub Sponsors"   (only when the Sponsors rail is present)
//   <prefix>.removeLicense     "Zovo: Remove license from this editor"

const crypto = require('crypto');
const { createKeyRail, INSTALL_ID_KEY } = require('./license');

// The Zovo Pro tier ("$19 one time", tier_id 679878) on GitHub Sponsors. Not the generic one-time page: that page also
// lists the notemods.com Obsidian tiers, which do not include Zovo Pro.
const SPONSORS_ONE_TIME = 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878';
const LABELS = {
  'github-sponsors': 'Unlock with GitHub Sponsors',
  'license-key': 'I have a license key',
  polar: 'Unlock with a Polar key',
};

function defaultSponsorsRail(vscode, context) {
  try {
    // eslint-disable-next-line global-require
    const { createSponsorsRail } = require('./sponsors');
    return createSponsorsRail({ vscode, context });
  } catch (e) {
    return null; // product ships without the Sponsors rail
  }
}

// Options:
//   vscode, context, sku ("hex-pro"), name ("Hex Viewer")
//   rails          optional array of rails (API.md). Default: [GitHub Sponsors (if sponsors.js is present), license key]
//   paymentUrl     optional buy page for "Get Pro". Default: the GitHub Sponsors one-time page (Stripe is not
//                  available to the seller; see out/PAY1.md). For the Stripe rail use BUY_URL + sku from license.js.
//                  '' = not on sale: Get Pro shows a message and opens nothing.
//   commandPrefix  registers the commands above
//   publicKey, now, allowTest   passed to the key rail (tests only)
function createLicense(o) {
  const { vscode, context, sku } = o;
  const name = o.name || 'Zovo';
  const label = `${name} Pro`;
  const keyRail = createKeyRail({ vscode, context, sku, name, publicKey: o.publicKey, now: o.now, allowTest: o.allowTest });
  const rails = (o.rails || [defaultSponsorsRail(vscode, context), keyRail]).filter(Boolean);
  const byId = (id) => rails.find((r) => r.id === id);
  const paymentUrl = o.paymentUrl === undefined ? SPONSORS_ONE_TIME : o.paymentUrl;
  const listeners = new Set();
  let last = null;

  const isPro = (s) => rails.some((r) => { try { return r.isPro(s || sku); } catch (e) { return false; } });
  function changed() {
    const now = isPro();
    if (now === last) return;
    last = now;
    for (const fn of listeners) { try { fn(now); } catch (e) { /* listener error */ } }
  }
  for (const r of rails) if (typeof r.onDidChange === 'function') r.onDidChange(changed);

  function installId() {
    let id = context.globalState.get(INSTALL_ID_KEY);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = crypto.randomUUID();
      context.globalState.update(INSTALL_ID_KEY, id);
    }
    return id;
  }

  const open = (url) => vscode.env.openExternal(vscode.Uri.parse(url, true));

  // Opens the buy page. A Stripe Payment Link (or /buy/<sku>) gets client_reference_id = a random install id,
  // so a support request can be matched to a checkout. Nothing about the user or machine is sent.
  async function getPro() {
    if (!paymentUrl) {
      await vscode.window.showInformationMessage(`${label} is not on sale yet. Everything you use today stays free.`);
      return false;
    }
    if (/^https:\/\/(buy\.stripe\.com|license(-test)?\.zovo\.one)\//.test(paymentUrl)) {
      const sep = paymentUrl.includes('?') ? '&' : '?';
      return open(`${paymentUrl}${sep}client_reference_id=${encodeURIComponent(installId())}`);
    }
    return open(paymentUrl);
  }

  // Run one rail's unlock and show its message. Returns the UnlockResult.
  async function unlock(railId) {
    let rail = railId ? byId(railId) : null;
    if (!rail && rails.length === 1) rail = rails[0];
    if (!rail) {
      const items = rails.map((r) => ({ label: r.label || LABELS[r.id] || r.id, id: r.id }));
      items.push({ label: `Get ${label}`, id: 'buy' });
      const pick = await vscode.window.showQuickPick(items, { title: `Unlock ${label}`, placeHolder: 'How did you get Zovo Pro?' });
      if (!pick) return { rail: '', pro: isPro(), reason: 'cancelled', kind: 'none', login: '', message: '' };
      if (pick.id === 'buy') { await getPro(); return { rail: '', pro: isPro(), reason: 'cancelled', kind: 'none', login: '', message: '' }; }
      rail = byId(pick.id);
    }
    const r = await rail.unlock();
    if (r && r.message) {
      if (r.pro) await vscode.window.showInformationMessage(r.message);
      else if (r.reason === 'expired' && r.renewUrl) {
        if ((await vscode.window.showWarningMessage(r.message, 'Renew page')) === 'Renew page') await open(r.renewUrl);
      } else if (r.reason === 'not-sponsor' || r.reason === 'other-tier' || r.reason === 'below-minimum') {
        if ((await vscode.window.showWarningMessage(r.message, 'Open GitHub Sponsors')) === 'Open GitHub Sponsors') await open(SPONSORS_ONE_TIME);
      } else if (r.reason !== 'cancelled') await vscode.window.showWarningMessage(r.message);
    }
    changed();
    return r;
  }

  // For a Pro action the user started: true when unlocked. Otherwise one modal (user-started, so allowed by the
  // VS Code UX rules) that says what the feature is, with the unlock ways and Get Pro. Never shown on its own.
  async function requirePro(feature, detail) {
    if (isPro()) {
      for (const r of rails) if (typeof r.refresh === 'function') r.refresh().catch(() => {}); // due monthly recheck only
      return true;
    }
    const buttons = rails.map((r) => r.label || LABELS[r.id] || r.id);
    buttons.push(`Get ${label}`);
    const renew = keyRail.renewUrl();
    if (renew) buttons.push('Renew page');
    const pick = await vscode.window.showInformationMessage(`${feature} is part of ${label}.`, {
      modal: true,
      detail: detail || 'Everything you use today stays free. Pro adds tools for professional work.',
    }, ...buttons);
    if (!pick) return false;
    if (pick === `Get ${label}`) { await getPro(); return false; }
    if (pick === 'Renew page') { await open(renew); return false; }
    const rail = rails.find((r) => (r.label || LABELS[r.id] || r.id) === pick);
    if (!rail) return false;
    return !!(await unlock(rail.id)).pro && isPro();
  }

  async function remove() {
    for (const r of rails) if (typeof r.remove === 'function') await r.remove();
    changed();
    await vscode.window.showInformationMessage(`${label} license removed from this editor. Free features keep working.`);
  }

  // vscode://<publisher.name>/license?key=ZOVO1... from the Stripe license page. Asks before it stores anything.
  async function handleUri(uri) {
    if (!uri || !/\/license\/?$/.test(uri.path || '')) return false;
    const key = new URLSearchParams(uri.query || '').get('key');
    if (!key) return false;
    const pick = await vscode.window.showInformationMessage(`Add a ${label} license key from the license page?`, { modal: true }, 'Add key');
    if (pick !== 'Add key') return false;
    const r = await keyRail.saveKey(key);
    if (r.pro) await vscode.window.showInformationMessage(r.message); else await vscode.window.showWarningMessage(r.message);
    changed();
    return r.pro;
  }

  function registerCommands(prefix) {
    const p = prefix || o.commandPrefix;
    const d = [
      vscode.commands.registerCommand(`${p}.enterLicenseKey`, () => unlock('license-key')),
      vscode.commands.registerCommand(`${p}.getPro`, () => getPro()),
      vscode.commands.registerCommand(`${p}.removeLicense`, () => remove()),
    ];
    if (byId('github-sponsors')) d.push(vscode.commands.registerCommand(`${p}.unlockWithSponsors`, () => unlock('github-sponsors')));
    context.subscriptions.push(...d);
    return d;
  }

  const api = {
    ready: Promise.all(rails.map((r) => Promise.resolve(r.ready).catch(() => {}))).then(() => { last = isPro(); }),
    rails,
    isPro,
    unlock,
    getPro,
    requirePro,
    remove,
    handleUri,
    registerCommands,
    installId,
    refresh: () => Promise.all(rails.map((r) => (typeof r.refresh === 'function' ? r.refresh().catch(() => false) : false))),
    state: () => Object.fromEntries(rails.map((r) => [r.id, typeof r.state === 'function' ? r.state() : null])),
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
  if (o.commandPrefix) registerCommands(o.commandPrefix);
  return api;
}

module.exports = { createLicense, SPONSORS_ONE_TIME };
