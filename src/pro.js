'use strict';
// Zovo Pro for S3 Explorer. Pro adds three extras: scheduled sync, copy between two connections (for example AWS to
// R2), and the size and cost report. Browsing, opening, editing, upload, download, copy, move, delete, versions,
// tags, presigned URLs and folder sync stay free for good.
// Each Pro feature has 3 free tries per computer (a local counter, no network). After that, one modal explains it,
// only when the user starts that feature. Nothing about Pro shows on its own.
const { createLicense } = require('./license');

const PRO_ENABLED = true; // false: every Pro feature is free and no Pro text shows anywhere
const FREE_TRIES = 3;
const TRIES_KEY = 'zovo.s3explorer.proTries.v1';
const SKU = 's3-explorer-pro';

const FEATURES = {
  schedule: { name: 'Scheduled sync', detail: 'Runs a folder sync again every few minutes while VS Code is open. Scheduled runs upload and download, and never delete.' },
  crossCopy: { name: 'Copy between connections', detail: 'Copies objects from one connection to another, for example from AWS S3 to Cloudflare R2 or MinIO, with the same confirmation as every copy.' },
  sizeReport: { name: 'Size and cost report', detail: 'Lists every object under a prefix and shows size, object count and an estimated monthly storage cost per folder and storage class.' },
};

const PRO_TEXT = 'Zovo Pro is USD 15 once on GitHub Sponsors and unlocks Pro in every Zovo extension. Already sponsored USD 10 or more? Choose Unlock with GitHub Sponsors. Unlocking sends one question to GitHub, nothing else. Browsing, opening, upload, download, versions, presigned URLs and folder sync stay free.';

function createPro({ vscode, context, license, enabled = PRO_ENABLED }) {
  const lic = license || (enabled ? createLicense({ vscode, context, sku: SKU, name: 'Zovo', commandPrefix: 's3Explorer' }) : null);
  if (!lic) {
    for (const c of ['getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense']) {
      context.subscriptions.push(vscode.commands.registerCommand(`s3Explorer.${c}`, () => vscode.window.showInformationMessage('Everything in S3 Explorer is free.')));
    }
  }
  const tries = () => Object.assign({}, context.globalState.get(TRIES_KEY) || {});

  /** For a Pro feature the user started. Returns { ok, note }: ok when it may run now; note like "free try 1 of 3". */
  async function gate(feature) {
    if (!enabled || !lic) return { ok: true, note: '' };
    await lic.ready;
    if (lic.isPro(SKU)) { Promise.resolve(lic.refresh && lic.refresh()).catch(() => {}); return { ok: true, note: '' }; }
    const t = tries();
    const used = Number(t[feature]) || 0;
    if (used < FREE_TRIES) {
      t[feature] = used + 1;
      await context.globalState.update(TRIES_KEY, t);
      return { ok: true, note: `${FEATURES[feature].name} is Pro: free try ${used + 1} of ${FREE_TRIES}.` };
    }
    const f = FEATURES[feature];
    const ok = await lic.requirePro(f.name, `${f.detail}\n\n${PRO_TEXT}`);
    return { ok: !!ok, note: '' };
  }

  return {
    gate,
    enabled: !!enabled,
    isPro: () => !enabled || !lic || lic.isPro(SKU),
    triesLeft: (feature) => Math.max(0, FREE_TRIES - (Number(tries()[feature]) || 0)),
    license: lic,
  };
}

module.exports = { createPro, PRO_ENABLED, FREE_TRIES, FEATURES, TRIES_KEY, SKU, PRO_TEXT };
