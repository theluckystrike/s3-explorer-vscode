// README screenshots in a real VS Code (CDP on 127.0.0.1:<port>). Seeds a demo bucket on the local S3-compatible
// server, connects with a profile from a fake ~/.aws by clicking it in the tree, expands folders, opens the details
// of a PDF and captures dark and light shots. Also reports console errors from the workbench and webviews.
//   node scripts/shots.mjs --vsix dist/x.vsix --work ~/s3-explorer-work/shots --endpoint http://127.0.0.1:19000 --port 9265 --out <dir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launch, installVsix, sleep } from './vsc.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const work = path.resolve(arg('work'));
const EP = arg('endpoint', 'http://127.0.0.1:19000');
const port = Number(arg('port', '9265'));
const outDir = path.resolve(arg('out', path.join(root, 'images')));
const { S3Client } = require(path.join(root, 'src/s3/client.js'));

fs.rmSync(work, { recursive: true, force: true });
const home = path.join(work, 'home');
fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
fs.mkdirSync(path.join(work, 'folder'), { recursive: true });
fs.writeFileSync(path.join(home, '.aws', 'config'), `[profile analytics-prod]\nregion = eu-west-1\nendpoint_url = ${EP}\n`);
fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[analytics-prod]\naws_access_key_id = s3xtestkey\naws_secret_access_key = s3xtestsecret123\n');

const s3 = new S3Client({ endpoint: EP, region: 'eu-west-1', credentials: async () => ({ accessKeyId: 's3xtestkey', secretAccessKey: 's3xtestsecret123' }) });
const P = path.join(root, '..');
const B = 'acme-reports';
try { await s3.createBucket(B); } catch (e) { /* exists */ }
try { await s3.createBucket('acme-web-assets'); } catch (e) { /* exists */ }
try { await s3.createBucket('acme-ml-datasets'); } catch (e) { /* exists */ }
await s3.putBucketVersioning(B, true);
const pdf = fs.readFileSync(path.join(P, 'pdf-viewer-vscode/test/fixtures/earthquakes-october-2026.pdf'));
await s3.putObject(B, '2026/10/earthquakes-october-2026.pdf', pdf.subarray(0, pdf.length - 0), { contentType: 'application/pdf', metadata: { team: 'research', source: 'usgs' } });
await s3.putObject(B, '2026/10/earthquakes-october-2026.pdf', pdf, { contentType: 'application/pdf', metadata: { team: 'research', source: 'usgs' } });
await s3.putObjectTagging(B, '2026/10/earthquakes-october-2026.pdf', [{ key: 'project', value: 'quarterly' }, { key: 'retention', value: '3y' }]);
const files = [
  ['2026/10/summary.csv', path.join(P, 'table-viewer-vscode/test/fixtures/semicolon.csv'), 'text/csv'],
  ['2026/10/orders.xlsx', path.join(P, 'table-viewer-vscode/test/fixtures/sample.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['2026/10/events.parquet', path.join(P, 'parquet-viewer-vscode/test/fixtures/codec-snappy.parquet'), 'application/vnd.apache.parquet'],
  ['2026/10/notes.md', path.join(P, 'load-testing-vscode/CHANGELOG.md'), 'text/markdown'],
  ['2026/09/sample.pdf', path.join(P, 'pdf-viewer-vscode/test/fixtures/sample.pdf'), 'application/pdf'],
  ['2026/11/config.json', path.join(P, 'load-testing-vscode/schemas/load-test.schema.json'), 'application/json'],
  ['logo.png', path.join(root, 'icon.png'), 'image/png'],
  ['README.md', path.join(P, 'load-testing-vscode/README.md'), 'text/markdown'],
];
for (const [k, f, ct] of files) await s3.putObject(B, k, fs.readFileSync(f), { contentType: ct });
for (const k of ['archive/2025/q4.csv', 'archive/2025/q3.csv']) await s3.putObject(B, k, 'a;b\n1;2\n', { contentType: 'text/csv' });
s3.dispose();

const vsix = path.resolve(arg('vsix'));
console.log('install', installVsix(work, vsix).out.trim().split('\n').pop());
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('AWS_')) delete env[k];
// A fake HOME makes macOS look for a keychain that does not exist; point the AWS files instead.
env.AWS_CONFIG_FILE = path.join(home, '.aws', 'config');
env.AWS_SHARED_CREDENTIALS_FILE = path.join(home, '.aws', 'credentials');
const results = { console: [], shots: [] };
for (const theme of (arg('themes', 'Default Dark Modern,Default Light Modern')).split(',')) {
  console.log('launch', theme);
  const vs = await launch(work, port, path.join(work, 'folder'), { 'workbench.colorTheme': theme, 's3Explorer.askForRating': false, 'workbench.activityBar.location': 'default', 'window.dialogStyle': 'custom' }, env);
  try {
    await sleep(3000);
    // open the S3 Explorer view
    await sleep(4000);
    const act = await vs.waitFor(() => vs.wbEval(`(() => { const a = [...document.querySelectorAll('.activitybar .action-item a, .activitybar .action-label')].find(e => /S3 Explorer/.test(e.getAttribute('aria-label') || '')); if (!a) return null; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`), 15000);
    if (act) { const q = JSON.parse(act); await vs.click(q.x, q.y); } else { await vs.command('View: Show S3 Explorer'); }
    await sleep(2000);
    const row = (label) => vs.wbEval(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find(e => ((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(${JSON.stringify(label)})); if (!r) return null; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 40, y: b.y + b.height / 2 }); })()`);
    const clickRow = async (label, opts) => { console.log('click', label); const p = JSON.parse(await vs.waitFor(() => row(label), 15000) || 'null'); if (!p) throw new Error('row not found: ' + label); await vs.click(p.x, p.y, opts); await sleep(900); };
    if (!(await vs.waitFor(() => row('analytics-prod'), 3000))) await clickRow('AWS profiles on this computer');
    await clickRow('analytics-prod'); // connects (first click on the profile row)
    await sleep(2500);
    await clickRow(B);
    await clickRow('2026'); await sleep(1500);
    await clickRow('10');
    await sleep(800);
    // details of the PDF: select its row, then run the command (same as the inline info icon)
    await clickRow('earthquakes-october-2026.pdf', { count: 1 });
    await sleep(2500); // opens the PDF (download + viewer or default)
    await vs.command('View: Close All Editors');
    await sleep(800);
    // the inline info icon on the row (shown on hover)
    const p = JSON.parse(await row('earthquakes-october-2026.pdf'));
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 60, y: p.y }, vs.wb);
    await sleep(400);
    const icon = await vs.waitFor(() => vs.wbEval(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find(e => ((e.textContent || '') + (e.getAttribute('aria-label') || '')).includes('earthquakes-october-2026.pdf')); const a = r && [...r.querySelectorAll('.action-label')].find(x => /Show Details/.test(x.getAttribute('aria-label') || x.title || '')); if (!a) return null; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`), 5000);
    if (!icon) throw new Error('details icon not found');
    const q = JSON.parse(icon);
    await vs.click(q.x, q.y);
    await sleep(3000);
    await vs.command('Notifications: Clear All Notifications');
    await sleep(800);
    const name = theme.includes('Dark') ? 'screenshot-dark.png' : 'screenshot-light.png';
    await vs.shot(path.join(outDir, name));
    results.shots.push(name);
    const wv = await vs.webview();
    if (wv) {
      const info = await vs.wvEval(wv, `JSON.stringify({ title: document.querySelector('h1') && document.querySelector('h1').textContent, versions: document.querySelectorAll('[data-cmd=restoreVersion]').length, footer: !!document.getElementById('zovo-support'), bg: getComputedStyle(document.body).backgroundColor })`);
      results[name] = JSON.parse(info);
    }
  } catch (e) {
    results.error = (results.error || '') + e.message + '; ';
    console.log('ERROR', theme, e.message);
    await vs.shot(path.join(outDir, 'shot-error.png')).catch((e2) => console.log('error shot failed', e2.message));
  } finally {
    results.console.push(...vs.console.filter((c) => !/Extension Host|telemetry|marketplace|gallery|update/i.test(c.text)));
    await vs.close();
  }
}
fs.writeFileSync(path.join(outDir, 'shots-result.json'), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1).slice(0, 3000));
