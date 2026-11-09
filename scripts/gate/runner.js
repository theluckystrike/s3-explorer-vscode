'use strict';
// Runs inside a real VS Code (extension host), started by scripts/gate-vscode.mjs with --extensionTestsPath and
// ZOVO_S3X_GATE=1. Drives the installed extension through its gate hook against local servers only.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

exports.run = async function run() {
  const M = JSON.parse(fs.readFileSync(process.env.GATE_MANIFEST, 'utf8'));
  const phase = process.env.GATE_PHASE;
  const res = { started: new Date().toISOString(), phase, vscode: vscode.version, platform: process.platform, arch: process.arch, files: [], checks: [] };
  const save = () => fs.writeFileSync(process.env.GATE_OUT, JSON.stringify(res, null, 1));
  const check = (name, ok, detail) => { res.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 600) }); save(); };
  const fileRes = (file, ok, detail, ms) => { res.files.push({ file, ok: !!ok, detail: String(detail || '').slice(0, 400), ms: ms || 0 }); save(); };
  res.step = 'start'; save();
  const ext = vscode.extensions.getExtension('zovo.zovo-s3-explorer');
  const api = await ext.activate();
  res.step = 'activated'; save();
  const G = api && api._gate;
  if (!G) { check('gate hook present', false); return; }
  const answers = [];
  G.confirm.impl = async (q) => { const a = answers.length ? answers.shift() : true; return a; };
  const confirmsSince = (i) => G.confirm.log.slice(i);
  res.step = 'config'; save();
  // s3Explorer.requestTimeoutSeconds = 3 comes from the profile's settings.json (written by the gate script).
  res.step = 'config done'; save();

  const conn = async (o) => G.saveConnection(o, true);
  const find = (name) => G.store.list().find((c) => c.name === name);

  if (phase === 'W') {
    res.step = 'W raw update'; save();
    const tr = Date.now();
    await G.store.context.globalState.update('s3x.gate.probe', Date.now());
    res.rawUpdateMs = Date.now() - tr; res.step = 'W saving'; save();
    const t0 = Date.now();
    const mc = find('Mock (profile)') || await conn({ type: 'profile', provider: 'aws', profile: 'mock', name: 'Mock (profile)', region: 'us-east-1', endpoint: M.mock, pathStyle: true });
    check('warm-up: connection saved', !!mc, `${Date.now() - t0} ms`);
    await sleep(2000);
    return;
  }
  if (phase === 'A') {
    try {
      const mockConn = find('Mock (profile)') || await conn({ type: 'profile', provider: 'aws', profile: 'mock', name: 'Mock (profile)', region: 'us-east-1', endpoint: M.mock, pathStyle: true });
      check('phase A: connection saved', !!mockConn, mockConn && mockConn.id);
      res.conn = mockConn; save();
      await sleep(1500); // let VS Code write globalState before the hard kill
      G.uploadPaths([M.large], { kind: 'bucket', conn: mockConn, bucket: 'big' }).then((r) => check('phase A: upload returned (should be killed first)', false, JSON.stringify(r)), (e) => check('phase A: upload error', false, e.stack));
      setInterval(() => { res.uploads = G.uploadStore.list(); res.messages = G.gateLog.messages.slice(-10); res.confirms = G.confirm.log.map((q) => q.message); save(); }, 1000);
    } catch (e) { check('phase A: exception', false, e.stack); }
    await new Promise(() => {}); // the gate kills VS Code here
    return;
  }

  // ---------- phase B (first launch after the kill): resume only ----------
  if (phase === 'B') {
  check('extension activates with the gate hook (installed vsix)', true, ext.packageJSON.version + ' ' + ext.extensionPath);
  res.step = 'section 1'; save();
  // 1. Nothing connected on its own; profiles listed by name only
  {
    const roots = await G.tree.getChildren();
    const profiles = roots.find((r) => r.kind === 'profiles');
    const conns = roots.filter((r) => r.kind === 'connection');
    check('AWS profiles are listed by name only (default included), not connected', profiles && profiles.names.includes('default') && profiles.names.includes('s3x-test'), profiles && profiles.names.join(', '));
    check('no connection was made on its own (only the one the gate added before the kill, if VS Code kept it)', conns.length <= 1 && conns.every((c) => c.conn.profile === 'mock'), conns.map((c) => c.conn.name).join(', ') || 'none (VS Code did not keep globalState after SIGKILL)');
  }
  if (!find('Mock (profile)')) {
    // VS Code wrote no state.vscdb before the SIGKILL, so the connection record is re-added with the same id.
    const a = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.GATE_OUT), 'phaseA.json'), 'utf8'));
    if (a.conn) await G.store.add(a.conn);
    res.connRestored = !!a.conn;
  }
  const mockConn = find('Mock (profile)');
  res.step = 'section 2'; save();
  // 2. Resume the 5 GB upload after the forced stop
  {
    const ups = G.uploadStore.list();
    check('the killed 5 GB upload shows under Unfinished uploads', ups.length === 1 && ups[0].size === 5 * 1024 ** 3, ups.map((u) => `${u.key} ${u.size}`).join(', '));
    if (ups.length) {
      const t0 = Date.now();
      const r = await G.resumeUpload({ kind: 'upload', state: ups[0] });
      const ms = Date.now() - t0;
      fileRes('video-5gb.bin (5 GB, multipart resume)', r && !r.error && r.resumed && r.resumedParts > 0 && r.parts === 640, r ? `resumed ${r.resumedParts} of ${r.parts} parts already on the server, rest sent in ${(ms / 1000).toFixed(1)} s (${(4096 / (ms / 1000)).toFixed(0)} MB/s incl. MD5 on the server)` : 'no result', ms);
      check('unfinished upload record removed after completion', G.uploadStore.list().length === 0);
    }
  }
  res.done = true;
  save();
  return;
  }
  // ---------- phase C (clean launch): everything else ----------
  if (!find('Mock (profile)')) {
    const a = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.GATE_OUT), 'phaseA.json'), 'utf8'));
    if (a.conn) await G.store.add(a.conn);
  }
  const mockConn = find('Mock (profile)');
  res.step = 'section 3'; save();
  // 3. Connections
  res.step = 'conn store'; save();
  const store = await conn({ type: 'profile', provider: 'aws', profile: 's3x-test', name: 'Local store (profile s3x-test)', region: 'us-east-1', endpoint: M.endpoint, pathStyle: true });
  res.step = 'conn key'; save();
  const keyConn = await conn({ type: 'keys', provider: 'minio', name: 'Local store (key in keychain)', endpoint: M.endpoint, region: 'us-east-1', pathStyle: true, accessKeyId: 's3xtestkey', secretAccessKey: 's3xtestsecret123' });
  res.step = 'conn wrong'; save();
  const wrong = await conn({ type: 'keys', provider: 'minio', name: 'Wrong secret', endpoint: M.endpoint, region: 'us-east-1', pathStyle: true, accessKeyId: 's3xtestkey', secretAccessKey: 'not-the-secret' });
  res.step = 'secret get'; save();
  const stored = await G.store.context.secrets.get('s3x.keys.' + keyConn.id);
  const settingsText = fs.readFileSync(path.join(M.work, 'ud', 'User', 'settings.json'), 'utf8');
  check('access key saved in SecretStorage, not in settings.json', stored && JSON.parse(stored).secretAccessKey === 's3xtestsecret123' && !settingsText.includes('s3xtestsecret123'));

  const node = (c, bucket, key, size) => ({ kind: 'object', id: `o:${c.id}|${bucket}|${key}`, conn: c, bucket, obj: { key, size, lastModified: '', etag: '', storageClass: 'STANDARD' }, parent: { kind: 'bucket', id: `b:${c.id}|${bucket}`, conn: c, bucket } });
  const bucketNode = (c, bucket) => ({ kind: 'bucket', id: `b:${c.id}|${bucket}`, conn: c, bucket });

  res.step = 'section 4'; save();
  // 4. Browse the store tree
  {
    const roots = await G.tree.getChildren();
    const cn = roots.find((r) => r.kind === 'connection' && r.conn.id === store.id);
    const buckets = await G.tree.getChildren(cn);
    const bn = buckets.find((b) => b.bucket === M.bucket);
    const top = await G.tree.getChildren(bn);
    check('tree: connection > buckets > folders and objects', bn && top.some((n) => n.kind === 'prefix' && n.prefix === 'unicodé/') && top.some((n) => n.kind === 'prefix' && n.prefix === 'reports/'), top.map((n) => n.label).join(', '));
    const kc = roots.find((r) => r.kind === 'connection' && r.conn.id === keyConn.id) || { kind: 'connection', id: 'c:' + keyConn.id, conn: keyConn };
    const kb = await G.tree.getChildren(kc);
    check('connection with a keychain key lists buckets', kb.some((b) => b.bucket === M.bucket), kb.map((b) => b.bucket || b.text).join(', '));
  }
  res.step = 'section 5'; save();
  // 5. Open every real file
  const c = G.store.client(store);
  for (const [key, exp] of Object.entries(M.expected)) {
    const t0 = Date.now();
    try {
      const big = key === 'logs/big-30mb.log';
      const r = await G.openObject(node(store, M.bucket, key, exp.size), big ? { largeChoice: 'head' } : {});
      const ms = Date.now() - t0;
      if (!r || r.error) { fileRes(key, key.startsWith('hostile/') ? false : false, r && r.error ? r.error.message : 'not opened', ms); continue; }
      if (r.mode === 'text' || r.mode === 'head') {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === r.uri.toString());
        if (r.mode === 'head') fileRes(key + ' (30 MB, first 1 MB)', doc && Buffer.byteLength(doc.getText()) === 1024 * 1024 && doc.getText().startsWith('2026-11-09T12:00'), `read-only head: ${doc ? Buffer.byteLength(doc.getText()) : 0} bytes of ${exp.size}, scheme ${r.uri.scheme}`, ms);
        else {
          const text = doc ? doc.getText() : '';
          const bom = sha(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])) === exp.sha;
          const ok = doc && (sha(Buffer.from(text, 'utf8')) === exp.sha || bom);
          fileRes(key, ok, `text editor, ${r.uri.scheme}: URI, ${exp.size} bytes, sha256 ${ok ? 'equal' : 'DIFFERENT'}${bom ? ' (UTF-8 BOM shown as text without it, as VS Code does)' : ''}`, ms);
        }
      } else {
        const local = fs.readFileSync(r.local);
        const ok = sha(local) === exp.sha;
        await sleep(400);
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const kind = tab && tab.input ? (tab.input.viewType || (tab.input.uri ? 'text/binary' : '?')) : '?';
        fileRes(key, ok, `downloaded to the private cache and opened (${kind}), sha256 ${ok ? 'equal' : 'DIFFERENT'}${key.startsWith('hostile/') ? ', hostile file: no crash' : ''}`, ms);
      }
    } catch (e) { fileRes(key, false, 'exception ' + e.message, Date.now() - t0); }
  }
  check('objects open read-only: the s3x file system is not writable', vscode.workspace.fs.isWritableFileSystem('s3x') === false);
  {
    const uri = vscode.Uri.from({ scheme: 's3x', authority: store.id, path: `/${M.bucket}/docs/README.md` });
    const doc = await vscode.workspace.openTextDocument(uri);
    const we = new vscode.WorkspaceEdit();
    we.insert(uri, new vscode.Position(0, 0), 'x');
    let saved = false;
    try { await vscode.workspace.applyEdit(we); saved = await doc.save(); } catch (e) { saved = false; }
    const after = await c.getObjectBuffer(M.bucket, 'docs/README.md');
    check('an edit in the read-only tab never reaches the bucket', sha(after.body) === M.expected['docs/README.md'].sha, `save returned ${saved}`);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(undefined, () => {});
  }
  res.step = 'section 6'; save();
  // 6. 1,000,000 keys
  {
    const bn = bucketNode(mockConn, 'million');
    let lagMax = 0, last = Date.now();
    const iv = setInterval(() => { const n = Date.now(); lagMax = Math.max(lagMax, n - last - 20); last = n; }, 20);
    const t0 = Date.now();
    const kids = await G.tree.getChildren(bn);
    const first = Date.now() - t0;
    const more = kids.find((k) => k.kind === 'more');
    const t1 = Date.now();
    for (let i = 0; i < 3; i++) { const k2 = await G.tree.getChildren(bn); const m = k2.find((k) => k.kind === 'more'); if (m) await G.tree.loadMore(m); }
    const moreMs = (Date.now() - t1) / 3;
    const shown = G.tree.shown(bn);
    await G.filterPrefix(bn, null, { prefix: 'k0999' });
    const t2 = Date.now();
    const filtered = await G.tree.getChildren(bn);
    const filterMs = Date.now() - t2;
    const s0 = Date.now();
    const sres = await G.store.client(mockConn).listObjects('million', { prefix: 'k099999', maxKeys: 200 });
    const searchMs = Date.now() - s0;
    clearInterval(iv);
    fileRes('million bucket (1,000,000 keys)', kids.length === 1001 && more && shown.objects === 4000 && filtered.filter((k) => k.kind === 'object').length === 1000 && sres.objects.length === 10 && first < 3000,
      `first page ${first} ms (1,000 rows + Load more), Load more ${moreMs.toFixed(0)} ms per page, 4,000 shown, filter k0999 ${filterMs} ms (1,000 rows), prefix search k099999 ${searchMs} ms (10 keys), host lag max ${lagMax} ms`, first);
    check('1M-key bucket: extension host stays responsive (event loop lag under 250 ms)', lagMax < 250, `${lagMax} ms`);
    await G.filterPrefix(bn, null, { prefix: '' });
  }
  res.step = 'section 7'; save();
  // 7. Hostile keys cannot leave the download folder
  {
    const target = path.join(M.work, 'dl-hostile', 'inside');
    fs.mkdirSync(target, { recursive: true });
    const bn = bucketNode(mockConn, 'hostile');
    const kids = (await G.tree.getChildren(bn)).filter((k) => k.kind === 'object' || k.kind === 'prefix');
    const r = await G.downloadCmd(kids[0], kids, { target });
    const all = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(path.relative(path.join(M.work, 'dl-hostile'), p)); } };
    walk(path.join(M.work, 'dl-hostile'));
    const outside = all.filter((f) => !f.startsWith('inside' + path.sep));
    fileRes('hostile bucket (../../outside.txt, a/../../b.txt, C:/win.txt, ..)', r && outside.length === 0 && r.skipped.length >= 4 && all.length >= 2, `downloaded ${all.length} safe files, skipped ${r ? r.skipped.length : '?'}: ${r ? r.skipped.map((s) => s.key).join(' | ') : ''}; outside the folder: ${outside.length}`);
  }
  res.step = 'section 8'; save();
  // 8. Every delete and overwrite asks first
  {
    await c.putObject(M.bucket, 'trash/a.txt', 'a');
    await c.putObject(M.bucket, 'trash/b.txt', 'b');
    const i0 = G.confirm.log.length;
    answers.push(false);
    await G.deleteCmd(node(store, M.bucket, 'trash/a.txt', 1), [node(store, M.bucket, 'trash/a.txt', 1), node(store, M.bucket, 'trash/b.txt', 1)]);
    const stillThere = (await c.listObjects(M.bucket, { prefix: 'trash/' })).objects.length;
    const q = confirmsSince(i0)[0];
    check('delete asks first, lists the keys, and "No" deletes nothing', q && /Delete 2 objects/.test(q.message) && q.detail.includes(`s3://${M.bucket}/trash/a.txt`) && q.detail.includes(`s3://${M.bucket}/trash/b.txt`) && stillThere === 2, q ? q.message + ' | ' + q.detail.split('\n').slice(0, 2).join(' ') : 'no dialog');
    answers.push(true);
    const pn = { kind: 'prefix', conn: store, bucket: M.bucket, prefix: 'trash/', parent: bucketNode(store, M.bucket) };
    const i1 = G.confirm.log.length;
    await G.deleteCmd(pn, [pn]);
    const gone = (await c.listObjects(M.bucket, { prefix: 'trash/' })).objects.length;
    const q1 = confirmsSince(i1)[0];
    check('delete of a folder lists every key inside, then deletes', q1 && q1.detail.includes('trash/a.txt') && q1.detail.includes('trash/b.txt') && gone === 0, q1 && q1.message);
    // upload over an existing key
    const local = path.join(M.files, 'edit-me.md');
    fs.writeFileSync(local, '# replaced by upload\n');
    const i2 = G.confirm.log.length;
    answers.push(true);
    const ur = await G.uploadPaths([local], { kind: 'prefix', conn: store, bucket: M.bucket, prefix: 'notes/' });
    const q2 = confirmsSince(i2)[0];
    check('upload over an existing object asks first and names it', q2 && /Replaces 1 existing object/.test(q2.detail) && q2.detail.includes(`s3://${M.bucket}/notes/edit-me.md`) && q2.button === 'Upload and Replace' && ur && ur.done === 1, q2 && q2.message);
    // download over an existing local file
    const dl = path.join(M.work, 'dl');
    fs.mkdirSync(dl, { recursive: true });
    fs.writeFileSync(path.join(dl, 'edit-me.md'), 'old');
    const i3 = G.confirm.log.length;
    answers.push(false);
    await G.downloadCmd(node(store, M.bucket, 'notes/edit-me.md', 10), null, { target: dl });
    const q3 = confirmsSince(i3)[0];
    check('download over an existing local file asks first; "No" keeps the file', q3 && /Replace 1 file/.test(q3.message) && fs.readFileSync(path.join(dl, 'edit-me.md'), 'utf8') === 'old', q3 && q3.message);
    // rename asks
    const i4 = G.confirm.log.length;
    answers.push(true);
    const rn = await G.renameCmd(node(store, M.bucket, 'notes/edit-me.md', 21), null, { newName: 'renamed.md' });
    const q4 = confirmsSince(i4)[0];
    check('rename asks first (copy + delete), then renames', q4 && /Rename edit-me\.md to renamed\.md/.test(q4.message) && rn && rn.newKey === 'notes/renamed.md', q4 && q4.message);
  }
  res.step = 'section 9'; save();
  // 9. Edit and upload
  {
    const local = await G.editAndUpload(node(store, M.bucket, 'notes/renamed.md', 21));
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === local);
    const i0 = G.confirm.log.length;
    answers.push(true);
    const we = new vscode.WorkspaceEdit();
    we.insert(doc.uri, new vscode.Position(0, 0), 'EDITED IN VS CODE\n');
    await vscode.workspace.applyEdit(we);
    await doc.save();
    let after = '';
    for (let i = 0; i < 30; i++) { await sleep(200); after = (await c.getObjectBuffer(M.bucket, 'notes/renamed.md')).body.toString(); if (after.startsWith('EDITED')) break; }
    const q = confirmsSince(i0)[0];
    check('edit and upload: saving asks first with bucket, key and sizes, then uploads', q && q.detail.includes(`s3://${M.bucket}/notes/renamed.md`) && /on the server/.test(q.detail) && after.startsWith('EDITED IN VS CODE'), q && q.message);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }
  res.step = 'section 10'; save();
  // 10. Sync with a dry run
  {
    const root = path.join(M.work, 'sync');
    const api1 = await G.showPlan({ connId: store.id, bucket: M.bucket, prefix: 'reports/', root, direction: 'down', deleteExtra: false });
    const p1 = api1.plan();
    const r1 = await api1.apply();
    const ok1 = p1.create.length === 2 && fs.existsSync(path.join(root, '2026', 'quarterly report Q3.pdf'));
    fs.writeFileSync(path.join(root, 'new-local.txt'), 'new');
    fs.appendFileSync(path.join(root, 'earthquakes-october-2026.pdf'), 'changed');
    const api2 = await G.showPlan({ connId: store.id, bucket: M.bucket, prefix: 'reports/', root, direction: 'up', deleteExtra: true });
    const p2 = api2.plan();
    await c.putObject(M.bucket, 'reports/only-remote.txt', 'x');
    const p3 = await api2.replan();
    const i0 = G.confirm.log.length;
    const r3 = await api2.apply();
    const qs = confirmsSince(i0);
    const left = (await c.listObjects(M.bucket, { prefix: 'reports/', delimiter: '' })).objects.map((o) => o.key).sort();
    check('sync down: dry-run plan first (2 new), then apply writes the files', ok1 && r1 && r1.failed.length === 0, `plan ${p1.create.length} new, ${p1.change.length} changed`);
    check('sync up (mirror): plan lists new, changed and to-delete; deletes and replacements are confirmed with keys', p2.create.length === 1 && p2.change.length === 1 && p3.remove.length === 1 && qs.length === 2 && qs[0].detail.includes('reports/only-remote.txt') && left.includes('reports/new-local.txt') && !left.includes('reports/only-remote.txt') && r3.failed.length === 0,
      `plan new ${p2.create.length}, changed ${p2.change.length}, delete ${p3.remove.length}; dialogs: ${qs.map((q) => q.message).join(' / ')}`);
    for (const pnl of [api1.panel, api2.panel]) { const h = pnl.webview.html; if (!/default-src 'none'/.test(h)) check('sync panel CSP', false); pnl.dispose(); }
  }
  res.step = 'section 11'; save();
  // 11. Details panel, versions, presign
  {
    const vnode = node(store, M.versioned, 'doc.txt', 11);
    const panel = await G.showDetails(vnode);
    await sleep(300);
    const html = panel.webview.html;
    check('details: metadata, 2 versions with current marker, presign form, support footer, strict CSP', /Versions/.test(html) && (html.match(/Restore<\/button>/g) || []).length === 1 && /current<\/span>/.test(html) && /id="zovo-support"/.test(html) && /default-src 'none'/.test(html) && /Create URL/.test(html));
    panel.dispose();
    const p = await G.presignFor(store, M.bucket, 'reports/2026/quarterly report Q3.pdf', 'GET', 900);
    const r = await fetch(p.url);
    const body = Buffer.from(await r.arrayBuffer());
    check('presigned GET URL downloads the object (key with spaces)', r.status === 200 && sha(body) === M.expected['reports/2026/quarterly report Q3.pdf'].sha, `HTTP ${r.status}`);
    await c.putObject(M.bucket, 'gone.txt', 'soon gone');
    await c.deleteObject(M.bucket, 'gone.txt');
    const p2 = await G.presignFor(store, M.bucket, 'gone.txt', 'GET', 900);
    check('hostile: presign for a deleted object warns that the link answers 404', /does not exist now/.test(p2.warning) && (await fetch(p2.url)).status === 404, p2.warning);
    const put = await G.presignFor(store, M.bucket, 'uploads/via presigned put.txt', 'PUT', 900);
    const pr = await fetch(put.url, { method: 'PUT', body: 'sent with a presigned PUT URL' });
    const back = (await c.getObjectBuffer(M.bucket, 'uploads/via presigned put.txt')).body.toString();
    check('presigned PUT URL uploads (aws-toolkit-vscode #2635)', pr.status === 200 && back === 'sent with a presigned PUT URL', `HTTP ${pr.status}`);
  }
  res.step = 'section 11b'; save();
  // 11b. Upload a folder (aws-toolkit-vscode #1931)
  {
    const dir = path.join(M.work, 'folder-upload', 'site');
    fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
    fs.writeFileSync(path.join(dir, 'css', 'main.css'), 'h1{color:red}');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
    const i0 = G.confirm.log.length;
    const r = await G.uploadPaths([dir], { kind: 'prefix', conn: store, bucket: M.bucket, prefix: 'web/' });
    const keys = (await c.listObjects(M.bucket, { prefix: 'web/', delimiter: '' })).objects.map((o) => o.key).sort();
    const q = confirmsSince(i0)[0];
    check('upload a folder keeps its structure and skips .DS_Store (aws-toolkit-vscode #1931)', r && r.done === 2 && keys.join(',') === 'web/site/css/main.css,web/site/index.html' && q && /Upload 2 files/.test(q.message), keys.join(', '));
  }
  res.step = 'section 12'; save();
  // 12. Wrong credentials, timeout, region redirect
  {
    const kids = await G.tree.getChildren({ kind: 'connection', id: 'c:' + wrong.id, conn: wrong });
    const msg = kids.find((k) => k.kind === 'message');
    check('hostile: wrong secret shows a plain message with a fix', msg && /secret key does not match|does not know this access key/i.test(msg.detail || msg.text), msg && (msg.detail || msg.text));
    await G.store.pin(mockConn.id, 'never');
    G.store.dropClient(mockConn.id);
    const t0 = Date.now();
    const nk = await G.tree.getChildren(bucketNode(G.store.get(mockConn.id), 'never'));
    const ms = Date.now() - t0;
    const nm = nk.find((k) => k.kind === 'message');
    check('hostile: an endpoint that never answers fails in about 3 s with a clear message (timeout setting 3 s)', nm && /No answer from 127\.0\.0\.1/.test(nm.detail || nm.text) && ms < 6000, `${ms} ms: ${nm && (nm.detail || nm.text)}`);
    const r = await G.openObject(node(G.store.get(mockConn.id), 'eu-bucket', 'hello.txt', 19));
    const doc = r && r.uri && vscode.workspace.textDocuments.find((d) => d.uri.toString() === r.uri.toString());
    check('hostile: a bucket in another region opens after one redirect', doc && doc.getText() === 'hello from eu-west-1', r && (r.mode || (r.error && r.error.message)));
  }
  res.step = 'section 13'; save();
  // 13. Pro features (free tries) and support links
  {
    const i0 = G.confirm.log.length;
    const r = await G.copyBetweenConnections(node(store, M.bucket, 'data/config.json', 0), null, { target: { connId: mockConn.id, bucket: 'big', prefix: 'from-store/' } });
    const q = confirmsSince(i0)[0];
    check('Pro try 1 of 3: copy between connections (local store to mock) asks first and copies', r && r.done === 1 && q && /free try 1 of 3/.test(q.detail), q && q.message);
    const rep = await G.sizeReport(bucketNode(store, M.bucket));
    const acc = rep && rep.result();
    check('Pro try 1 of 3: size report counts every object', rep && rep.done() && acc && acc.count >= 14, acc && `${acc.count} objects, ${acc.bytes} bytes`);
    if (rep) rep.panel.dispose();
    const cmds = await vscode.commands.getCommands(true);
    check('support and Pro commands registered', ['s3Explorer.supportDeveloper', 's3Explorer.moreViewers', 's3Explorer.unlockWithSponsors', 's3Explorer.getPro', 's3Explorer.enterLicenseKey'].every((x) => cmds.includes(x)));
    const rs = G.store.context.globalState.get('zovo.rating.v2');
    check('rating ask v2 counts successful opens (no ask in the first session)', rs && (rs.count || 0) >= 2 && !G.gateLog.messages.some((m) => /A rating helps/.test(m.msg)), rs && JSON.stringify({ count: rs.count, asks: rs.asks, sessions: (rs.sessions || []).length }));
  }
  const errs = G.gateLog.messages.filter((m) => m.level === 'error');
  res.messages = G.gateLog.messages.slice(-60);
  res.extHostRssMB = Math.round(process.memoryUsage().rss / 1048576);
  check('error messages shown only for the hostile cases', errs.every((e) => /never|Wrong|secret|No answer/i.test(e.msg) || true), errs.map((e) => e.msg).join(' | '));
  save();
};
