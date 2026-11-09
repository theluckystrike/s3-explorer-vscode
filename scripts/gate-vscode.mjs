// Release gate in a real VS Code. Never touches AWS: it uses a local S3-compatible server (RustFS or MinIO on
// 127.0.0.1, --endpoint) and the mock server in test/helpers/mock-s3.js (1M keys, hostile keys, region redirect,
// a bucket that never answers, a 5 GB multipart target that stores nothing). A fake HOME holds ~/.aws with a
// "default" profile that points to a trap server: the gate fails if the trap gets a single request.
//
//   node scripts/gate-vscode.mjs --vsix dist/x.vsix --work ~/s3-explorer-work/gate --endpoint http://127.0.0.1:19000 [--keep]
//
// Phase A starts the 5 GB upload and the gate kills VS Code (SIGKILL) mid-upload. Phase B resumes it and runs
// every other check. Large files live under --work and are deleted at the end.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const vsix = path.resolve(arg('vsix'));
const work = path.resolve(arg('work'));
const EP = arg('endpoint', 'http://127.0.0.1:19000');
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(EP)) { console.error('endpoint must be local'); process.exit(2); }
const CODE = arg('code', '/Applications/Visual Studio Code.app/Contents/MacOS/Code');
const CLI = path.join(path.dirname(path.dirname(CODE)), 'Resources/app/bin/code');
const keep = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { S3Client } = require(path.join(root, 'src/s3/client.js'));

fs.rmSync(work, { recursive: true, force: true });
const files = path.join(work, 'files');
const home = path.join(work, 'home');
fs.mkdirSync(files, { recursive: true });
fs.mkdirSync(path.join(home, '.aws'), { recursive: true });

// ---- mock and trap servers (own processes, so they outlive a killed VS Code) ----
async function startMock(key) {
  const p = spawn(process.execPath, [path.join(root, 'test/helpers/mock-s3.js'), '0'], { env: { ...process.env, MOCK_KEY: key }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((r) => p.stdout.once('data', (d) => r(JSON.parse(String(d)).port)));
  return { p, port, url: `http://127.0.0.1:${port}` };
}
const mock = await startMock('mockkey');
const trap = await startMock('trapkey');
const getJson = async (u) => (await fetch(u)).json();
console.log('mock', mock.url, 'trap', trap.url, 'store', EP);

// ---- fake ~/.aws: default -> trap; s3x-test -> local store; mock -> mock ----
fs.writeFileSync(path.join(home, '.aws', 'config'), `[default]\nregion = us-east-1\nendpoint_url = ${trap.url}\n\n[profile s3x-test]\nregion = us-east-1\nendpoint_url = ${EP}\n\n[profile mock]\nregion = us-east-1\nendpoint_url = ${mock.url}\n`);
fs.writeFileSync(path.join(home, '.aws', 'credentials'), `[default]\naws_access_key_id = trapkey\naws_secret_access_key = trapsecret\n\n[s3x-test]\naws_access_key_id = s3xtestkey\naws_secret_access_key = s3xtestsecret123\n\n[mock]\naws_access_key_id = mockkey\naws_secret_access_key = x\n`);

// ---- seed the local store with real files ----
const store = new S3Client({ endpoint: EP, region: 'us-east-1', credentials: async () => ({ accessKeyId: 's3xtestkey', secretAccessKey: 's3xtestsecret123' }) });
const P = path.join(root, '..');
const real = [
  ['docs/README.md', path.join(P, 'load-testing-vscode/README.md')],
  ['config/package.json', path.join(P, 'load-testing-vscode/package.json')],
  ['reports/2026/quarterly report Q3.pdf', path.join(P, 'pdf-viewer-vscode/test/fixtures/sample.pdf')],
  ['reports/earthquakes-october-2026.pdf', path.join(P, 'pdf-viewer-vscode/test/fixtures/earthquakes-october-2026.pdf')],
  ['tables/sample.xlsx', path.join(P, 'table-viewer-vscode/test/fixtures/sample.xlsx')],
  ['tables/semicolon.csv', path.join(P, 'table-viewer-vscode/test/fixtures/semicolon.csv')],
  ['tables/codec-snappy.parquet', path.join(P, 'parquet-viewer-vscode/test/fixtures/codec-snappy.parquet')],
  ['images/icon.png', path.join(root, 'icon.png')],
  ['unicodé/日本語/メモ.txt', null, 'これはテストです。\nUnicode key with spaces and accents.\n'],
  ['data/config.json', path.join(P, 'load-testing-vscode/schemas/load-test.schema.json')],
  ['hostile/zero-bytes.parquet', path.join(P, 'parquet-viewer-vscode/test/fixtures/hostile-zero-bytes.parquet')],
  ['hostile/footer-past-eof.parquet', path.join(P, 'parquet-viewer-vscode/test/fixtures/hostile-footer-past-eof.parquet')],
  ['notes/edit-me.md', null, '# Notes\n\nEdit and upload test.\n'],
];
const bigLog = path.join(work, 'big-30mb.log');
{
  const fd = fs.openSync(bigLog, 'w');
  const line = (i) => `2026-11-09T12:${String(Math.floor(i / 60000) % 60).padStart(2, '0')}:00.000Z INFO request id=${i} path=/api/orders status=200 ms=${i % 97}\n`;
  let buf = '';
  for (let i = 0; i < 400000; i++) { buf += line(i); if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = ''; } }
  fs.writeSync(fd, buf);
  fs.closeSync(fd);
}
real.push(['logs/big-30mb.log', bigLog]);
const B = 'gate-files', V = 'gate-versioned';
for (const b of [B, V]) { try { await store.createBucket(b); } catch (e) { if (!/BucketAlready/.test(e.code)) throw e; } }
const expected = {};
for (const [key, file, text] of real) {
  const body = file ? fs.readFileSync(file) : Buffer.from(text);
  await store.putObject(B, key, body, {});
  expected[key] = { sha: crypto.createHash('sha256').update(body).digest('hex'), size: body.length };
}
await store.putBucketVersioning(V, true);
await store.putObject(V, 'doc.txt', 'version one');
await store.putObject(V, 'doc.txt', 'version two');
console.log(`seeded ${real.length} real files in ${B} (large: logs/big-30mb.log ${Math.round(fs.statSync(bigLog).size / 1048576)} MB) and 2 versions in ${V}`);

// ---- 5 GB sparse file (no disk blocks) ----
const large = path.join(work, 'large', 'video-5gb.bin');
fs.mkdirSync(path.dirname(large), { recursive: true });
fs.closeSync(fs.openSync(large, 'w'));
fs.truncateSync(large, 5 * 1024 ** 3);

const manifest = { endpoint: EP, mock: mock.url, trap: trap.url, bucket: B, versioned: V, expected, large, files, work };
fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 1));

// ---- install the vsix into a private profile ----
const ud = path.join(work, 'ud'), ext = path.join(work, 'ext');
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false, 'security.workspace.trust.enabled': false, 'git.enabled': false, 'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true, 'window.dialogStyle': 'custom', 's3Explorer.requestTimeoutSeconds': 3, 'workbench.editorAssociations': { '*.pdf': 'default' },
}, null, 1));
const inst = spawnSync(CLI, ['--user-data-dir', ud, '--extensions-dir', ext, '--install-extension', vsix, '--force'], { encoding: 'utf8', timeout: 120000 });
console.log('install:', (inst.stdout + inst.stderr).trim().split('\n').pop());
const installed = fs.readdirSync(ext).find((d) => d.startsWith('zovo.zovo-s3-explorer-'));
if (!installed) { console.error('not installed'); process.exit(2); }

const env = { ...process.env, ZOVO_S3X_GATE: '1', GATE_MANIFEST: path.join(work, 'manifest.json') };
for (const k of Object.keys(env)) if (k.startsWith('AWS_')) delete env[k];
// No fake HOME (macOS would look for a keychain there): the AWS CLI variables point at the fake files.
env.AWS_CONFIG_FILE = path.join(home, '.aws', 'config');
env.AWS_SHARED_CREDENTIALS_FILE = path.join(home, '.aws', 'credentials');
const debugPort = arg('debug-port');
const launch = (phase, out) => spawn(CODE, [...(debugPort && phase === 'A' ? [`--remote-debugging-port=${debugPort}`] : []), '--user-data-dir', ud, '--extensions-dir', ext, '--disable-workspace-trust', '--skip-welcome', '--new-window',
  `--extensionDevelopmentPath=${path.join(ext, installed)}`, `--extensionTestsPath=${path.join(root, 'scripts/gate/runner.js')}`, files],
{ stdio: 'ignore', env: { ...env, GATE_PHASE: phase, GATE_OUT: out } });

// ---- warm-up launch (the first start of a fresh profile is slow to persist state) ----
{
  const w = launch('W', path.join(work, 'warmup.json'));
  const t = setTimeout(() => spawnSync('pkill', ['-9', '-f', ud]), 100000);
  await new Promise((r) => w.on('exit', r));
  clearTimeout(t);
  console.log('warm-up:', fs.existsSync(path.join(work, 'warmup.json')) ? fs.readFileSync(path.join(work, 'warmup.json'), 'utf8').replace(/\s+/g, ' ').slice(0, 400) : 'no output');
  await sleep(1000);
}
// ---- phase A: start the 5 GB upload, then kill VS Code hard ----
const outA = path.join(work, 'phaseA.json');
let a = launch('A', outA);
let killedAt = null;
if (debugPort) {
  const { attach } = await import('./vsc.mjs');
  setTimeout(async () => { try { const v = await attach(Number(debugPort)); await sleep(20000); await v.shot(path.join(work, 'phaseA.png')); console.log('phase A dom:', await v.wbEval(`[...document.querySelectorAll('.monaco-dialog-box, .notifications-toasts .notification-list-item, .quick-input-widget')].filter(e => e.offsetParent).map(e => e.textContent.slice(0, 200)).join(' || ')`)); } catch (e) { console.log('shot failed', e.message); } }, 2000);
}
for (let i = 0; i < Number(arg('waitA', '600')); i++) {
  await sleep(500);
  const ups = await getJson(mock.url + '/__uploads').catch(() => []);
  const p = ups.find((u) => u.key === 'video-5gb.bin');
  if (i % 20 === 0) console.log(`  phase A ${i / 2}s: uploads ${JSON.stringify(ups)} ops ${JSON.stringify((await getJson(mock.url + '/__stats')).byOp)}`);
  if (p && p.parts >= 40) { killedAt = p.parts; break; }
}
spawnSync('pkill', ['-9', '-f', ud]);
await new Promise((r) => { if (a.exitCode !== null) r(); else { a.on('exit', r); setTimeout(r, 5000); } });
console.log(`phase A: VS Code killed (SIGKILL) with ${killedAt} of 640 parts on the server`);
if (process.argv.includes('--only-a')) { console.log(fs.existsSync(outA) ? fs.readFileSync(outA, 'utf8').slice(0, 4000) : 'no phase A output'); mock.p.kill(); trap.p.kill(); process.exit(0); }
await sleep(1500);
for (const f of fs.readdirSync(ud)) if (f === 'code.lock' || f.endsWith('.sock')) fs.rmSync(path.join(ud, f), { force: true }); // left by the SIGKILL

// ---- phase B: first launch after the kill, resume only; phase C: clean launch, everything else ----
const runPhase = async (phase, out, mins) => {
  const p = launch(phase, out);
  const timer = setTimeout(() => { console.error(`phase ${phase} timeout, killing VS Code`); spawnSync('pkill', ['-9', '-f', ud]); }, mins * 60 * 1000);
  // Phase B can hang on exit (VS Code's own state after the kill): stop it once its results are written.
  const poll = setInterval(() => { try { if (JSON.parse(fs.readFileSync(out, 'utf8')).done) { setTimeout(() => spawnSync('pkill', ['-9', '-f', ud]), 3000); clearInterval(poll); } } catch (e) { /* not yet */ } }, 1000);
  await new Promise((r) => p.on('exit', r));
  clearTimeout(timer);
  clearInterval(poll);
  for (const f of fs.readdirSync(ud)) if (f === 'code.lock' || f.endsWith('.sock')) fs.rmSync(path.join(ud, f), { force: true });
  try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { console.error(`no results from phase ${phase}`); return { files: [], checks: [] }; }
};
const t0 = Date.now();
const resB = await runPhase('B', path.join(work, 'results-B.json'), 6);
// VER15: wait until every process of phase B has gone, or the phase C launch hands its window to the dying instance and exits.
for (let i = 0; i < 30 && spawnSync('pgrep', ['-f', ud]).status === 0; i++) await sleep(1000);
await sleep(1500);
const resC = await runPhase('C', path.join(work, 'results.json'), 10);
const res = Object.assign({}, resC, { files: [...resB.files, ...resC.files], checks: [...resB.checks, ...resC.checks], stepB: resB.step, stepC: resC.step });
// checks from outside VS Code
const check = (name, ok, detail) => res.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
const obj = await getJson(`${mock.url}/__object?bucket=big&key=${encodeURIComponent('video-5gb.bin')}`);
const zeroMd5 = crypto.createHash('md5').update(Buffer.alloc(8 * 1024 * 1024)).digest('hex');
check('5 GB multipart: object on the server is 5,368,709,120 bytes in 640 parts, every part MD5 equals the local file part', obj && obj.size === 5 * 1024 ** 3 && obj.parts.length === 640 && obj.parts.every((p) => p.md5 === zeroMd5 && p.size === 8 * 1024 * 1024), obj ? `${obj.size} bytes, ${obj.parts.length} parts, killed at ${killedAt} parts` : 'missing');
const trapStats = await getJson(trap.url + '/__stats');
check('the default profile (trap endpoint) got 0 requests during the whole gate', trapStats.total === 0, `${trapStats.total} requests`);
const mockStats = await getJson(mock.url + '/__stats');
res.mockStats = mockStats;
let pass = 0, fail = 0;
console.log(`VS Code ${res.vscode} ${res.platform}-${res.arch}, phase B ${Math.round((Date.now() - t0) / 1000)} s, extension host RSS ${res.extHostRssMB} MB`);
for (const f of res.files) { f.ok ? pass++ : fail++; console.log(`${f.ok ? 'PASS' : 'FAIL'} file  ${f.file.padEnd(40)} ${String(f.ms).padStart(6)} ms  ${f.detail}`); }
for (const c of res.checks) { c.ok ? pass++ : fail++; console.log(`${c.ok ? 'PASS' : 'FAIL'} check ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`); }
console.log(`gate: ${pass} pass, ${fail} fail, ${res.files.length} files`);
fs.writeFileSync(path.join(work, 'results-final.json'), JSON.stringify(res, null, 1));

// ---- teardown ----
try {
  for (const bk of [B, V]) {
    const vers = (await store.listObjectVersions(bk, {})).versions;
    if (vers.length) await store.deleteObjects(bk, vers.map((v) => ({ key: v.key, versionId: v.versionId })));
    const all = [];
    await store.listAll(bk, '', (o) => { all.push(...o.map((x) => ({ key: x.key }))); });
    if (all.length) await store.deleteObjects(bk, all);
    for (const u of await store.listMultipartUploads(bk)) await store.abortMultipart(bk, u.key, u.uploadId);
    await store.request({ method: 'DELETE', bucket: bk, okStatus: [200, 204, 404, 409] });
  }
} catch (e) { console.error('teardown store:', e.message); }
store.dispose();
mock.p.kill('SIGTERM'); trap.p.kill('SIGTERM');
fs.rmSync(path.dirname(large), { recursive: true, force: true });
fs.rmSync(bigLog, { force: true });
if (!keep) { fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(ext, { recursive: true, force: true }); }
process.exit(fail ? 1 : 0);
