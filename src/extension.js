'use strict';
// S3 Explorer: browse, open, upload, download and sync objects in AWS S3, MinIO, Cloudflare R2, Backblaze B2,
// Wasabi and DigitalOcean Spaces. Network: only to the endpoints of the connections the user adds (and, for AWS SSO
// or role profiles, the AWS sign-in endpoints those profiles name). No telemetry.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ConnectionStore, PROVIDERS, fillEndpoint } = require('./connections');
const { S3Tree, createDnd } = require('./tree');
const { S3FileSystem, toUri, fromUri } = require('./fsprovider');
const { uploadFile, downloadFile, discardUpload, UploadStore, MB } = require('./s3/transfer');
const { planUpload, planDownload, applyPlan, walk, excluder } = require('./s3/sync');
const { safeLocalPath, baseName, parentPrefix } = require('./s3/paths');
const credentials = require('./s3/credentials');
const { fmtBytes, fmtCount, keyList, describeError, confirm } = require('./ui');
const panels = require('./panels');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');
const { createPro } = require('./pro');
const { contentTypeFor, isTextKey, viewerFor } = require('./types');

const EXT_ID = 'zovo.zovo-s3-explorer';
const SECTION = 's3Explorer';

let store, tree, view, uploadStore, rating, pro, ctx;
const editSessions = new Map(); // local edit file -> { connId, bucket, key, etag, size }
const detailPanels = new Map();
const schedules = new Map();
let scheduleStatus;
const gateLog = { opened: [], messages: [] };

const settings = () => {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    pageSize: c.get('pageSize', 1000),
    maxTextPreviewMB: c.get('maxTextPreviewMB', 10),
    confirmOpenOverMB: c.get('confirmOpenOverMB', 200),
    multipartThresholdMB: c.get('multipartThresholdMB', 16),
    partSizeMB: c.get('partSizeMB', 8),
    concurrency: c.get('concurrency', 4),
    requestTimeoutSeconds: c.get('requestTimeoutSeconds', 30),
    syncExcludes: c.get('syncExcludes', ['.git/**', 'node_modules/**', '.DS_Store', 'Thumbs.db']),
    pricePerGBMonth: c.get('pricePerGBMonth', 0),
    showAwsProfiles: c.get('showAwsProfiles', true),
  };
};

// ---------- small helpers ----------
function info(msg, ...items) { gateLog.messages.push({ level: 'info', msg }); return vscode.window.showInformationMessage(msg, ...items); }
function warn(msg, ...items) { gateLog.messages.push({ level: 'warn', msg }); return vscode.window.showWarningMessage(msg, ...items); }

async function showError(e, conn, prefix) {
  const d = describeError(e, conn);
  gateLog.messages.push({ level: 'error', msg: (prefix ? prefix + ' ' : '') + d.message, code: e && e.code });
  if (e && e.aborted) return;
  // The toast does not block the command that failed; its buttons act when clicked.
  vscode.window.showErrorMessage((prefix ? prefix + ' ' : '') + d.message, ...d.actions).then((pick) => {
    if (pick === 'Edit Connection' && conn) vscode.commands.executeCommand('s3Explorer.editConnection', { kind: 'connection', conn });
    if (pick === 'Reconnect' && conn) { store.dropClient(conn.id); tree.refresh(); }
    if (pick === 'Refresh') tree.refresh();
    if (pick === 'Run aws sso login') runSsoLogin(e.loginCommand);
  });
}

function runSsoLogin(cmd) {
  if (!cmd || !/^aws sso login --profile [\w.@+-]+$/.test(cmd)) return;
  const t = vscode.window.createTerminal('AWS SSO sign-in');
  t.show();
  t.sendText(cmd, true);
}

function connOf(node) {
  const c = node && node.conn ? store.get(node.conn.id) : null;
  if (!c) throw new Error('This connection no longer exists.');
  return c;
}

function containerPrefix(node) {
  if (!node) return '';
  if (node.kind === 'prefix') return node.prefix;
  if (node.kind === 'object') return parentPrefix(node.obj.key);
  if (node.kind === 'bucket') { const f = tree.filterOf(node.conn.id, node.bucket); return f.endsWith('/') ? f : parentPrefix(f); }
  return '';
}

function selection(node, nodes) {
  const list = Array.isArray(nodes) && nodes.length ? nodes : (node ? [node] : view.selection);
  return (list || []).filter(Boolean);
}

async function withProgress(title, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    return fn(progress, ac.signal);
  });
}

/** Every object key under the selected nodes. Returns { bucket, conn, items: [{key, size}] } (one bucket at a time). */
async function expandKeys(nodes, signal) {
  const first = nodes[0];
  const conn = connOf(first);
  const bucket = first.bucket;
  const items = [];
  const seen = new Set();
  for (const n of nodes) {
    if (n.bucket !== bucket || n.conn.id !== conn.id) continue;
    if (n.kind === 'object') { if (!seen.has(n.obj.key)) { seen.add(n.obj.key); items.push({ key: n.obj.key, size: n.obj.size, base: parentPrefix(n.obj.key) }); } }
    else if (n.kind === 'prefix') {
      const base = parentPrefix(n.prefix);
      await store.client(conn).listAll(bucket, n.prefix, (objs) => { for (const o of objs) if (!seen.has(o.key)) { seen.add(o.key); items.push({ key: o.key, size: o.size, base }); } }, signal);
    }
  }
  return { conn, bucket, items };
}

// ---------- connections ----------
async function addConnection(opts) {
  if (opts && opts.provider) return saveConnection(opts, true);
  const items = [
    { label: '$(account) AWS profile from ~/.aws', description: 'SSO, keys, credential_process, roles', id: 'profile' },
    { label: '$(cloud) Amazon S3 with an access key', id: 'aws' },
    { label: '$(cloud) Cloudflare R2', id: 'r2' },
    { label: '$(server) MinIO', description: 'self-hosted', id: 'minio' },
    { label: '$(cloud) Backblaze B2', id: 'b2' },
    { label: '$(cloud) Wasabi', id: 'wasabi' },
    { label: '$(cloud) DigitalOcean Spaces', id: 'spaces' },
    { label: '$(server) Other S3-compatible service', description: 'any endpoint URL', id: 'other' },
    { label: '$(terminal) Environment variables', description: 'AWS_ACCESS_KEY_ID in the environment of VS Code', id: 'env' },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Where are your buckets?', ignoreFocusOut: true });
  if (!pick) return null;
  if (pick.id === 'profile') return connectProfile();
  if (pick.id === 'env') {
    const region = await vscode.window.showInputBox({ prompt: 'AWS region', value: 'us-east-1', ignoreFocusOut: true });
    if (!region) return null;
    return saveConnection({ type: 'env', provider: 'aws', name: 'Environment variables', region }, false);
  }
  const p = PROVIDERS[pick.id];
  let account = '', region = p.region, endpoint = '';
  if (p.askAccount) { account = await vscode.window.showInputBox({ prompt: p.askAccount, ignoreFocusOut: true, validateInput: (v) => (/^[a-f0-9]{32}$/i.test(v.trim()) ? '' : 'A Cloudflare account ID has 32 hex characters.') }); if (!account) return null; account = account.trim(); }
  if (p.askRegion || pick.id === 'aws' || pick.id === 'other') { region = await vscode.window.showInputBox({ prompt: 'Region', value: p.region, ignoreFocusOut: true }); if (!region) return null; region = region.trim(); }
  if (p.askEndpoint) {
    endpoint = await vscode.window.showInputBox({ prompt: 'Endpoint URL', value: p.endpoint, placeHolder: 'https://s3.example.com', ignoreFocusOut: true, validateInput: (v) => (/^https?:\/\/[^\s/]+/i.test(v.trim()) ? '' : 'Start with https:// or http://') });
    if (!endpoint) return null;
    endpoint = endpoint.trim().replace(/\/+$/, '');
  } else endpoint = fillEndpoint(p.endpoint, { region, account });
  const accessKeyId = await vscode.window.showInputBox({ prompt: `${p.label}: access key ID`, ignoreFocusOut: true });
  if (!accessKeyId) return null;
  const secretAccessKey = await vscode.window.showInputBox({ prompt: `${p.label}: secret access key (saved in the OS keychain through VS Code, never in settings)`, password: true, ignoreFocusOut: true });
  if (!secretAccessKey) return null;
  const name = await vscode.window.showInputBox({ prompt: 'Name for this connection', value: pick.id === 'r2' ? 'Cloudflare R2' : p.label.replace(/ \(.*\)$/, ''), ignoreFocusOut: true });
  if (!name) return null;
  return saveConnection({ type: 'keys', provider: pick.id, name, endpoint, region, pathStyle: p.pathStyle, accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() }, false);
}

async function saveConnection(o, quiet) {
  const conn = { name: o.name, type: o.type || 'keys', provider: o.provider || 'other', profile: o.profile, endpoint: o.endpoint || '', region: o.region || 'us-east-1', pathStyle: o.pathStyle !== undefined ? !!o.pathStyle : !!o.endpoint, insecureTLS: !!o.insecureTLS, pinned: o.pinned || [] };
  const keys = conn.type === 'keys' ? { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, sessionToken: o.sessionToken } : null;
  const c = await store.add(conn, keys);
  tree.refresh();
  if (!quiet) {
    // Check it once, so a typo shows now and not on the first click.
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Connecting to ${c.name}` }, () => store.client(c).listBuckets());
      info(`Connected to ${c.name}.`);
    } catch (e) {
      if (e.code !== 'AccessDenied') await showError(e, c, `Saved "${c.name}", but:`);
    }
    try { await view.reveal(tree.nodes.get(`c:${c.id}`) || { kind: 'connection', id: `c:${c.id}`, conn: c }, { expand: true, focus: true }); } catch (e) { /* not visible */ }
  }
  return c;
}

async function connectProfile(name) {
  let profile = typeof name === 'string' ? name : undefined;
  if (!profile) {
    const names = credentials.listProfiles();
    if (!names.length) { warn(`No AWS profiles found in ${credentials.configPath()} or ${credentials.credentialsPath()}.`); return null; }
    const pick = await vscode.window.showQuickPick(names.map((n) => ({ label: n, description: n === 'default' ? 'the default profile' : '' })), { placeHolder: 'AWS profile to connect with' });
    if (!pick) return null;
    profile = pick.label;
  }
  const r = credentials.profileRegion(profile);
  return saveConnection({ type: 'profile', provider: 'aws', profile, name: profile, region: r.region || 'us-east-1', endpoint: r.endpoint, pathStyle: !!r.endpoint }, false);
}

async function editConnection(node) {
  const conn = connOf(node);
  const items = [
    { label: 'Rename', id: 'name' },
    { label: 'Change region', description: conn.region, id: 'region' },
  ];
  if (conn.type !== 'profile' && conn.type !== 'env') items.push({ label: 'Change endpoint', description: conn.endpoint || 'AWS', id: 'endpoint' }, { label: 'Enter new access key', id: 'keys' });
  items.push({ label: conn.pathStyle ? 'Use virtual-hosted style URLs' : 'Use path-style URLs', description: 'how the bucket goes into the URL', id: 'style' });
  if ((conn.endpoint || '').startsWith('https:')) items.push({ label: conn.insecureTLS ? 'Check TLS certificates again' : 'Allow a self-signed TLS certificate', description: 'for self-hosted servers only', id: 'tls' });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Edit ${conn.name}` });
  if (!pick) return;
  if (pick.id === 'name') { const v = await vscode.window.showInputBox({ value: conn.name, prompt: 'Name' }); if (v) await store.update(conn.id, { name: v }); }
  if (pick.id === 'region') { const v = await vscode.window.showInputBox({ value: conn.region, prompt: 'Region' }); if (v) await store.update(conn.id, { region: v.trim() }); }
  if (pick.id === 'endpoint') { const v = await vscode.window.showInputBox({ value: conn.endpoint, prompt: 'Endpoint URL (empty for AWS)' }); if (v !== undefined) await store.update(conn.id, { endpoint: v.trim().replace(/\/+$/, '') }); }
  if (pick.id === 'keys') {
    const a = await vscode.window.showInputBox({ prompt: 'Access key ID', ignoreFocusOut: true });
    if (!a) return;
    const s = await vscode.window.showInputBox({ prompt: 'Secret access key', password: true, ignoreFocusOut: true });
    if (!s) return;
    await store.update(conn.id, {}, { accessKeyId: a.trim(), secretAccessKey: s.trim() });
  }
  if (pick.id === 'style') await store.update(conn.id, { pathStyle: !conn.pathStyle });
  if (pick.id === 'tls') await store.update(conn.id, { insecureTLS: !conn.insecureTLS });
  tree.refresh();
}

async function removeConnection(node) {
  const conn = connOf(node);
  const ok = await confirm.ask(vscode, `Remove the connection "${conn.name}"?`, 'Its saved access key is deleted from the keychain. Nothing in the buckets changes.', 'Remove');
  if (!ok) return;
  await store.remove(conn.id);
  tree.refresh();
}

// ---------- open ----------
function cacheRoot() { return path.join(ctx.globalStorageUri.fsPath, 'open'); }

async function openObject(node, opts = {}) {
  const conn = connOf(node);
  const bucket = node.bucket;
  const key = node.obj ? node.obj.key : node.key;
  const versionId = opts.versionId;
  let size = node.obj && !versionId ? node.obj.size : undefined;
  const s = settings();
  const t0 = Date.now();
  try {
    if (size === undefined) size = (await store.client(conn).headObject(bucket, key, versionId)).size;
    const viewer = viewerFor(key);
    const viewerInstalled = viewer ? !!vscode.extensions.getExtension(viewer.id) : false;
    const text = isTextKey(key) && !(viewer && viewerInstalled && viewer.preferViewer);
    let mode = opts.mode || (text ? 'text' : 'download');
    let head = 0;
    if (mode === 'text' && size > s.maxTextPreviewMB * MB) {
      const choice = opts.largeChoice || (await vscode.window.showQuickPick([
        { label: '$(eye) Show the first 1 MB', description: 'read-only, one range request', id: 'head' },
        { label: '$(cloud-download) Download and open the whole file', description: fmtBytes(size), id: 'download' },
      ], { placeHolder: `${baseName(key)} is ${fmtBytes(size)}, more than ${s.maxTextPreviewMB} MB.` }) || {}).id;
      if (!choice) return null;
      if (choice === 'head') head = 1 * MB; else mode = 'download';
    }
    if (mode === 'text') {
      const uri = toUri(vscode, conn.id, bucket, key, { head, version: versionId });
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
      if (head) info(`Showing the first 1 MB of ${fmtBytes(size)}. Download the object to see all of it.`);
      gateLog.opened.push({ key, mode: head ? 'head' : 'text', ms: Date.now() - t0, size });
      rating.success(uri);
      return { mode: head ? 'head' : 'text', uri };
    }
    // Binary or viewer types: a local read-only copy, opened with whatever editor VS Code picks (Zovo viewers too).
    if (size > s.confirmOpenOverMB * MB && !opts.yes) {
      const ok = await vscode.window.showWarningMessage(`Download ${fmtBytes(size)} to open ${baseName(key)}?`, { modal: true }, 'Download and Open');
      if (ok !== 'Download and Open') return null;
    }
    const root = path.join(cacheRoot(), conn.id, bucket.replace(/[^\w.-]/g, '_'), versionId ? 'v-' + versionId.replace(/[^\w.-]/g, '_') : 'current');
    const sp = safeLocalPath(root, key);
    const local = sp.error ? path.join(root, crypto.createHash('sha1').update(key).digest('hex').slice(0, 12) + '-' + baseName(key).replace(/[^\w.-]/g, '_')) : sp.path;
    try { fs.chmodSync(local, 0o644); } catch (e) { /* not cached yet */ }
    await withProgress(`Downloading ${baseName(key)}`, async (progress, signal) => {
      let last = 0;
      await downloadFile(store.client(conn), bucket, key, local, { versionId, signal, onProgress: (got, total) => { const pct = total ? Math.floor((got / total) * 100) : 0; if (pct > last) { progress.report({ increment: pct - last, message: `${fmtBytes(got)} of ${fmtBytes(total)}` }); last = pct; } } });
    });
    try { fs.chmodSync(local, 0o444); } catch (e) { /* best effort */ }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(local), { preview: true });
    gateLog.opened.push({ key, mode: 'download', ms: Date.now() - t0, size, local });
    rating.success(toUri(vscode, conn.id, bucket, key));
    if (viewer && !viewerInstalled) suggestViewer(viewer);
    return { mode: 'download', local };
  } catch (e) {
    if (e && e.aborted) return null;
    rating.failure();
    await showError(e, conn, `Could not open ${baseName(key)}:`);
    return { error: e };
  }
}

async function suggestViewer(viewer) {
  const k = 'zovo.s3explorer.suggested.v1';
  const seen = ctx.globalState.get(k) || {};
  if (seen[viewer.id] || Object.keys(seen).length >= 3 || process.env.ZOVO_S3X_GATE === '1') return;
  seen[viewer.id] = Date.now();
  await ctx.globalState.update(k, seen);
  const pick = await vscode.window.showInformationMessage(`${viewer.what} files open in a better view with the free ${viewer.name}.`, 'Show it');
  if (pick === 'Show it') { try { await vscode.commands.executeCommand('extension.open', viewer.id); } catch (e) { vscode.env.openExternal(vscode.Uri.parse(`https://marketplace.visualstudio.com/items?itemName=${viewer.id}`)); } }
}

// ---------- edit and upload ----------
async function editAndUpload(node) {
  const conn = connOf(node);
  const key = node.obj.key;
  try {
    const head = await store.client(conn).headObject(node.bucket, key);
    if (head.size > 50 * MB) {
      const ok = await vscode.window.showWarningMessage(`${baseName(key)} is ${fmtBytes(head.size)}. Download it to edit?`, { modal: true }, 'Download and Edit');
      if (ok !== 'Download and Edit') return null;
    }
    const dir = path.join(ctx.globalStorageUri.fsPath, 'edit', crypto.createHash('sha1').update(`${conn.id}|${node.bucket}|${key}`).digest('hex').slice(0, 16));
    const local = path.join(dir, baseName(key).replace(/[\x00-\x1f<>:"|?*\\/]/g, '_') || 'object');
    try { fs.chmodSync(local, 0o644); } catch (e) { /* new */ }
    await downloadFile(store.client(conn), node.bucket, key, local, {});
    editSessions.set(path.resolve(local), { connId: conn.id, bucket: node.bucket, key, etag: head.etag, size: head.size, contentType: head.contentType });
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(local));
    await vscode.window.showTextDocument(doc, { preview: false });
    info(`Editing a copy of s3://${node.bucket}/${key}. Save to upload it (you will be asked first).`);
    return local;
  } catch (e) {
    await showError(e, conn, `Could not open ${baseName(key)} for editing:`);
    return null;
  }
}

async function onSaveEdited(doc) {
  const sess = editSessions.get(path.resolve(doc.uri.fsPath));
  if (!sess) return;
  const conn = store.get(sess.connId);
  if (!conn) return;
  const c = store.client(conn);
  const size = fs.statSync(doc.uri.fsPath).size;
  let changedRemotely = false;
  try { const h = await c.headObject(sess.bucket, sess.key); changedRemotely = h.etag !== sess.etag; } catch (e) { changedRemotely = e.code !== 'NotFound' && e.status !== 404 ? false : true; }
  const detail = `${keyList(sess.bucket, [sess.key])}\n${fmtBytes(sess.size)} on the server, ${fmtBytes(size)} after your edit.`
    + (changedRemotely ? '\n\nThe object changed on the server since you opened it. Uploading replaces that newer version.' : '');
  const ok = await confirm.ask(vscode, changedRemotely ? 'Replace a newer object on the server?' : 'Upload your changes and replace the object?', detail, 'Upload and Replace');
  if (!ok) { info('Not uploaded. Your edit is saved only in the local copy.'); return; }
  try {
    const r = await uploadFile(c, { connId: conn.id, bucket: sess.bucket, key: sess.key, file: doc.uri.fsPath, contentType: sess.contentType || contentTypeFor(sess.key), store: uploadStore, threshold: settings().multipartThresholdMB * MB });
    const h = await c.headObject(sess.bucket, sess.key).catch(() => ({ etag: r.etag }));
    sess.etag = h.etag;
    sess.size = size;
    info(`Uploaded to s3://${sess.bucket}/${sess.key}.`);
    rating.success(toUri(vscode, conn.id, sess.bucket, sess.key));
    tree.refresh();
  } catch (e) {
    await showError(e, conn, 'Upload failed:');
  }
}

// ---------- upload ----------
async function uploadCmd(node, nodes, opts = {}) {
  const dest = node && (node.kind === 'object' ? node.parent : node);
  if (!dest || (dest.kind !== 'bucket' && dest.kind !== 'prefix')) { warn('Pick a bucket or folder in the S3 view first.'); return null; }
  let files = opts.files;
  if (!files) {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: !opts.folders, canSelectFolders: !!opts.folders, openLabel: 'Upload' });
    if (!uris || !uris.length) return null;
    files = uris.map((u) => u.fsPath);
  }
  return uploadPaths(files, dest);
}

async function uploadPaths(paths, dest) {
  const conn = connOf(dest);
  const bucket = dest.bucket;
  const prefix = containerPrefix(dest);
  const c = store.client(conn);
  const s = settings();
  const items = [];
  const isExcluded = excluder(s.syncExcludes);
  for (const p of paths) {
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) {
      const name = path.basename(p);
      for (const f of await walk(p, isExcluded)) items.push({ file: f.file, key: `${prefix}${name}/${f.rel}`, size: f.size });
    } else if (st.isFile()) items.push({ file: p, key: prefix + path.basename(p), size: st.size });
  }
  if (!items.length) { warn('Nothing to upload.'); return null; }
  // Which keys exist already?
  const existing = new Set();
  try {
    if (items.length <= 100) {
      await Promise.all(items.map(async (it) => { try { await c.headObject(bucket, it.key); existing.add(it.key); } catch (e) { if (e.status !== 404 && e.code !== 'NotFound') throw e; } }));
    } else {
      const want = new Set(items.map((i) => i.key));
      await c.listAll(bucket, prefix, (objs) => { for (const o of objs) if (want.has(o.key)) existing.add(o.key); });
    }
  } catch (e) { await showError(e, conn, 'Could not check the destination:'); return null; }
  const total = items.reduce((a, b) => a + b.size, 0);
  const replace = items.filter((i) => existing.has(i.key)).map((i) => i.key);
  const fresh = items.filter((i) => !existing.has(i.key)).map((i) => i.key);
  const detail = (replace.length ? `Replaces ${fmtCount(replace.length)} existing object${replace.length > 1 ? 's' : ''}:\n${keyList(bucket, replace)}\n\n` : '')
    + (fresh.length ? `New:\n${keyList(bucket, fresh, replace.length ? 5 : 15)}` : '');
  const ok = await confirm.ask(vscode, `Upload ${fmtCount(items.length)} file${items.length > 1 ? 's' : ''} (${fmtBytes(total)}) to s3://${bucket}/${prefix}?`, detail, replace.length ? 'Upload and Replace' : 'Upload');
  if (!ok) return { cancelled: true };
  const res = await withProgress(`Uploading to s3://${bucket}/${prefix}`, async (progress, signal) => {
    let sentAll = 0, done = 0, lastPct = 0;
    const failed = [];
    const per = new Map();
    const q = items.slice();
    const bump = () => { const pct = total ? Math.floor((sentAll / total) * 100) : Math.floor((done / items.length) * 100); if (pct > lastPct) { progress.report({ increment: pct - lastPct, message: `${fmtCount(done)} of ${fmtCount(items.length)} · ${fmtBytes(sentAll)} of ${fmtBytes(total)}` }); lastPct = pct; } };
    const worker = async () => {
      while (q.length && !signal.aborted) {
        const it = q.shift();
        try {
          await uploadFile(c, { connId: conn.id, bucket, key: it.key, file: it.file, contentType: contentTypeFor(it.key), store: uploadStore, signal,
            threshold: s.multipartThresholdMB * MB, minPart: s.partSizeMB * MB, concurrency: items.length === 1 ? s.concurrency : 2,
            onProgress: (sent) => { sentAll += sent - (per.get(it.key) || 0); per.set(it.key, sent); bump(); } });
          done++;
          bump();
        } catch (e) {
          if (e && e.aborted) break;
          failed.push({ key: it.key, error: describeError(e, conn).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(items.length === 1 ? 1 : 4, items.length) }, worker));
    return { done, failed, cancelled: signal.aborted };
  });
  tree.refresh(dest);
  tree.emitter.fire(undefined);
  if (res.cancelled) { const left = uploadStore.list().length; info(`Upload stopped after ${fmtCount(res.done)} of ${fmtCount(items.length)} files.${left ? ' Large files can be resumed from "Unfinished uploads".' : ''}`); }
  else if (res.failed.length) warn(`Uploaded ${fmtCount(res.done)} of ${fmtCount(items.length)}. ${res.failed.length} failed: ${res.failed.slice(0, 3).map((f) => `${f.key} (${f.error})`).join('; ')}`);
  else { info(`Uploaded ${fmtCount(res.done)} file${res.done > 1 ? 's' : ''} (${fmtBytes(total)}) to s3://${bucket}/${prefix}.`); rating.success(toUri(vscode, conn.id, bucket, items[0].key)); }
  return res;
}

async function resumeUpload(node) {
  const st = node.state;
  const conn = store.get(st.connId);
  if (!conn) { warn('The connection of this upload was removed. Discard it instead.'); return null; }
  let fst;
  try { fst = fs.statSync(st.file); } catch (e) { warn(`The local file ${st.file} is gone. Discard the upload.`); return null; }
  if (fst.size !== st.size || fst.mtimeMs !== st.mtimeMs) {
    const ok = await confirm.ask(vscode, 'The local file changed since the upload began.', `${st.file}\nStart the upload again from the beginning? The parts already sent are dropped.\n${keyList(st.bucket, [st.key])}`, 'Start Again');
    if (!ok) return null;
  }
  const c = store.client(conn);
  const s = settings();
  const res = await withProgress(`Resuming ${baseName(st.key)}`, async (progress, signal) => {
    let last = 0;
    try {
      return await uploadFile(c, { connId: conn.id, bucket: st.bucket, key: st.key, file: st.file, contentType: st.contentType, store: uploadStore, signal, threshold: 0, minPart: st.partSize, concurrency: s.concurrency,
        onProgress: (sent, total) => { const pct = Math.floor((sent / total) * 100); if (pct > last) { progress.report({ increment: pct - last, message: `${fmtBytes(sent)} of ${fmtBytes(total)}` }); last = pct; } } });
    } catch (e) { return { error: e }; }
  });
  tree.refresh();
  if (res && res.error) { if (!res.error.aborted) await showError(res.error, conn, 'Resume failed:'); return res; }
  info(`Uploaded s3://${st.bucket}/${st.key} (${fmtBytes(st.size)}), ${res.resumedParts} of ${res.parts} parts were already on the server.`);
  return res;
}

async function discardUploadCmd(node) {
  const st = node.state;
  const ok = await confirm.ask(vscode, 'Discard this unfinished upload?', `${keyList(st.bucket, [st.key])}\nThe parts already on the server are deleted. Your local file stays.`, 'Discard');
  if (!ok) return;
  const conn = store.get(st.connId);
  if (conn) await discardUpload(store.client(conn), uploadStore, st); else uploadStore.remove(st.id);
  tree.refresh();
}

// ---------- download ----------
async function downloadCmd(node, nodes, opts = {}) {
  const sel = selection(node, nodes).filter((n) => n.kind === 'object' || n.kind === 'prefix');
  if (!sel.length) return null;
  let target = opts.target;
  if (!target) {
    const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Download Here' });
    if (!uris || !uris.length) return null;
    target = uris[0].fsPath;
  }
  let exp;
  try { exp = await withProgress('Listing objects', (p, signal) => expandKeys(sel, signal)); } catch (e) { await showError(e, sel[0].conn, 'Could not list:'); return null; }
  const { conn, bucket, items } = exp;
  const plan = [];
  const skipped = [];
  for (const it of items) {
    if (it.key.endsWith('/') && it.size === 0) continue;
    const sp = safeLocalPath(target, it.key, it.base);
    if (sp.error) skipped.push({ key: it.key, why: sp.error }); else plan.push({ key: it.key, size: it.size, file: sp.path });
  }
  const exists = plan.filter((p) => fs.existsSync(p.file));
  if (exists.length) {
    const ok = await confirm.ask(vscode, `Replace ${fmtCount(exists.length)} file${exists.length > 1 ? 's' : ''} in ${target}?`, exists.slice(0, 15).map((p) => p.file).join('\n') + (exists.length > 15 ? `\n... and ${fmtCount(exists.length - 15)} more` : ''), 'Replace');
    if (!ok) return { cancelled: true };
  }
  const total = plan.reduce((a, b) => a + b.size, 0);
  const res = await withProgress(`Downloading ${fmtCount(plan.length)} file${plan.length === 1 ? '' : 's'}`, async (progress, signal) => {
    let done = 0, got = 0, last = 0;
    const failed = [];
    const q = plan.slice();
    const per = new Map();
    const worker = async () => {
      while (q.length && !signal.aborted) {
        const it = q.shift();
        try {
          await downloadFile(store.client(conn), bucket, it.key, it.file, { signal, onProgress: (g) => { got += g - (per.get(it.key) || 0); per.set(it.key, g); const pct = total ? Math.floor((got / total) * 100) : 0; if (pct > last) { progress.report({ increment: pct - last, message: `${fmtBytes(got)} of ${fmtBytes(total)}` }); last = pct; } } });
          done++;
        } catch (e) { if (e && e.aborted) break; failed.push({ key: it.key, error: describeError(e, conn).message }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, plan.length || 1) }, worker));
    return { done, failed, cancelled: signal.aborted };
  });
  res.skipped = skipped;
  res.target = target;
  const skipText = skipped.length ? ` Skipped ${skipped.length} key${skipped.length > 1 ? 's' : ''} that would leave the folder: ${skipped.slice(0, 3).map((x) => x.key).join(', ')}.` : '';
  if (res.failed.length) warn(`Downloaded ${fmtCount(res.done)} of ${fmtCount(plan.length)}. ${res.failed.length} failed: ${res.failed.slice(0, 3).map((f) => `${f.key} (${f.error})`).join('; ')}.${skipText}`);
  else if (!res.cancelled) {
    if (plan.length) rating.success(toUri(vscode, conn.id, bucket, plan[0].key));
    info(`Downloaded ${fmtCount(res.done)} file${res.done === 1 ? '' : 's'} (${fmtBytes(total)}) to ${target}.${skipText}`, 'Reveal').then((p) => { if (p === 'Reveal') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target)); });
  }
  return res;
}

// ---------- delete, rename, copy, move ----------
async function deleteCmd(node, nodes) {
  const sel = selection(node, nodes).filter((n) => n.kind === 'object' || n.kind === 'prefix');
  if (!sel.length) return null;
  let exp;
  try { exp = await withProgress('Listing objects to delete', (p, signal) => expandKeys(sel, signal)); } catch (e) { await showError(e, sel[0].conn, 'Could not list:'); return null; }
  const { conn, bucket, items } = exp;
  if (!items.length) { info('Nothing to delete.'); return null; }
  let versioning = 'Off';
  try { versioning = await store.client(conn).getBucketVersioning(bucket); } catch (e) { /* unknown */ }
  const total = items.reduce((a, b) => a + b.size, 0);
  const note = versioning === 'Enabled' ? '\n\nVersioning is on: S3 keeps the older versions and adds a delete marker.' : '\n\nThis cannot be undone.';
  const ok = await confirm.ask(vscode, `Delete ${fmtCount(items.length)} object${items.length > 1 ? 's' : ''} (${fmtBytes(total)}) from s3://${bucket}?`, keyList(bucket, items.map((i) => i.key)) + note, 'Delete');
  if (!ok) return { cancelled: true };
  try {
    const r = await store.client(conn).deleteObjects(bucket, items.map((i) => ({ key: i.key })));
    for (const n of sel) if (n.parent) tree.refresh(n.parent);
    tree.emitter.fire(undefined);
    if (r.errors.length) warn(`Deleted ${fmtCount(r.deleted.length)}. ${r.errors.length} failed: ${r.errors.slice(0, 3).map((e) => `${e.key} (${e.code})`).join('; ')}`);
    else info(`Deleted ${fmtCount(r.deleted.length)} object${r.deleted.length > 1 ? 's' : ''}.`);
    return r;
  } catch (e) { await showError(e, conn, 'Delete failed:'); return { error: e }; }
}

async function copyItems(conn, bucket, items, dstBucket, mapKey, { move, signal, progress }) {
  const c = store.client(conn);
  let done = 0;
  const failed = [];
  const q = items.slice();
  const worker = async () => {
    while (q.length && !(signal && signal.aborted)) {
      const it = q.shift();
      try {
        await c.copyLarge(bucket, it.key, dstBucket, mapKey(it), it.size, { signal });
        done++;
        if (progress) progress.report({ message: `${fmtCount(done)} of ${fmtCount(items.length)}` });
      } catch (e) { if (e && e.aborted) break; failed.push({ key: it.key, error: describeError(e, conn).message }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length || 1) }, worker));
  let deleted = 0;
  if (move && !(signal && signal.aborted)) {
    const ok = items.filter((it) => !failed.some((f) => f.key === it.key)).filter((it) => !(dstBucket === bucket && mapKey(it) === it.key));
    const r = await c.deleteObjects(bucket, ok.map((it) => ({ key: it.key })));
    deleted = r.deleted.length;
    for (const e of r.errors) failed.push({ key: e.key, error: e.code });
  }
  return { done, failed, deleted };
}

async function existingKeys(c, bucket, keys) {
  const out = [];
  if (keys.length <= 100) {
    await Promise.all(keys.map(async (k) => { try { await c.headObject(bucket, k); out.push(k); } catch (e) { if (e.status !== 404 && e.code !== 'NotFound') throw e; } }));
    return out;
  }
  const want = new Set(keys);
  const common = keys.reduce((a, k) => { let i = 0; while (i < a.length && a[i] === k[i]) i++; return a.slice(0, i); }, keys[0]);
  await c.listAll(bucket, parentPrefix(common + 'x'), (objs) => { for (const o of objs) if (want.has(o.key)) out.push(o.key); });
  return out;
}

async function renameCmd(node, nodes, opts = {}) {
  if (!node || (node.kind !== 'object' && node.kind !== 'prefix')) return null;
  const conn = connOf(node);
  const oldKey = node.kind === 'object' ? node.obj.key : node.prefix;
  const parent = parentPrefix(oldKey);
  const oldName = oldKey.slice(parent.length).replace(/\/$/, '');
  const newName = opts.newName || (await vscode.window.showInputBox({ prompt: `New name (you can use / to move it into a folder)`, value: oldName, valueSelection: [0, oldName.lastIndexOf('.') > 0 && node.kind === 'object' ? oldName.lastIndexOf('.') : oldName.length], validateInput: (v) => (!v.trim() ? 'Enter a name' : /(^|\/)\.\.?(\/|$)/.test(v) ? 'No . or .. segments' : '') }));
  if (!newName || newName === oldName) return null;
  const c = store.client(conn);
  if (node.kind === 'object') {
    const newKey = parent + newName;
    const clash = await existingKeys(c, node.bucket, [newKey]);
    const ok = await confirm.ask(vscode, clash.length ? `Rename and replace s3://${node.bucket}/${newKey}?` : `Rename ${oldName} to ${newName}?`,
      `S3 has no rename: the object is copied to the new key and the old key is deleted.\nFrom: s3://${node.bucket}/${oldKey}\nTo: s3://${node.bucket}/${newKey}${clash.length ? '\n\nAn object already has the new key and will be replaced.' : ''}`, clash.length ? 'Rename and Replace' : 'Rename');
    if (!ok) return { cancelled: true };
    try {
      await c.copyLarge(node.bucket, oldKey, node.bucket, newKey, node.obj.size, {});
      await c.deleteObject(node.bucket, oldKey);
      tree.refresh(node.parent);
      return { newKey };
    } catch (e) { await showError(e, conn, 'Rename failed:'); return { error: e }; }
  }
  const newPrefix = parent + newName.replace(/\/?$/, '/');
  const exp = await expandKeys([node]);
  const mapKey = (it) => newPrefix + it.key.slice(oldKey.length);
  const clash = await existingKeys(c, node.bucket, exp.items.map(mapKey));
  const ok = await confirm.ask(vscode, `Rename the folder ${oldName}/ to ${newName.replace(/\/$/, '')}/? This copies ${fmtCount(exp.items.length)} objects and deletes the originals.`,
    `${keyList(node.bucket, exp.items.map((i) => i.key))}\n\nTo s3://${node.bucket}/${newPrefix}${clash.length ? `\n\n${fmtCount(clash.length)} objects there will be replaced:\n${keyList(node.bucket, clash, 5)}` : ''}`, 'Rename');
  if (!ok) return { cancelled: true };
  const r = await withProgress(`Renaming ${oldName}/`, (progress, signal) => copyItems(conn, node.bucket, exp.items, node.bucket, mapKey, { move: true, signal, progress }));
  tree.refresh(node.parent);
  if (r.failed.length) warn(`Renamed ${r.done - r.failed.length} objects; ${r.failed.length} failed.`); else info(`Renamed ${fmtCount(r.done)} objects.`);
  return r;
}

async function copyOrMove(node, nodes, move, opts = {}) {
  const sel = selection(node, nodes).filter((n) => n.kind === 'object' || n.kind === 'prefix');
  if (!sel.length) return null;
  const conn = connOf(sel[0]);
  const c = store.client(conn);
  let dstBucket = opts.bucket;
  if (!dstBucket) {
    let buckets = [];
    try { buckets = (await c.listBuckets()).map((b) => b.name); } catch (e) { buckets = []; }
    for (const b of conn.pinned || []) if (!buckets.includes(b)) buckets.push(b);
    if (!buckets.includes(sel[0].bucket)) buckets.unshift(sel[0].bucket);
    const pick = await vscode.window.showQuickPick(buckets.map((b) => ({ label: b, description: b === sel[0].bucket ? 'this bucket' : '' })), { placeHolder: `${move ? 'Move' : 'Copy'} to which bucket?` });
    if (!pick) return null;
    dstBucket = pick.label;
  }
  let dstPrefix = opts.prefix;
  if (dstPrefix === undefined) {
    dstPrefix = await vscode.window.showInputBox({ prompt: `Destination folder in ${dstBucket} (empty for the top level)`, value: containerPrefix(sel[0]) });
    if (dstPrefix === undefined) return null;
  }
  dstPrefix = dstPrefix.replace(/^\/+/, '');
  if (dstPrefix && !dstPrefix.endsWith('/')) dstPrefix += '/';
  const exp = await expandKeys(sel);
  const mapKey = (it) => dstPrefix + it.key.slice(it.base.length);
  const same = exp.items.filter((it) => dstBucket === exp.bucket && mapKey(it) === it.key);
  if (same.length === exp.items.length) { info('The destination is the same as the source.'); return null; }
  const clash = await existingKeys(c, dstBucket, exp.items.map(mapKey));
  const verb = move ? 'Move' : 'Copy';
  const ok = await confirm.ask(vscode, `${verb} ${fmtCount(exp.items.length)} object${exp.items.length > 1 ? 's' : ''} to s3://${dstBucket}/${dstPrefix}?`,
    `${keyList(exp.bucket, exp.items.map((i) => i.key))}${move ? '\n\nThe originals are deleted after the copy.' : ''}${clash.length ? `\n\n${fmtCount(clash.length)} existing objects will be replaced:\n${keyList(dstBucket, clash, 5)}` : ''}`, clash.length ? `${verb} and Replace` : verb);
  if (!ok) return { cancelled: true };
  const r = await withProgress(`${move ? 'Moving' : 'Copying'} ${fmtCount(exp.items.length)} objects`, (progress, signal) => copyItems(conn, exp.bucket, exp.items, dstBucket, mapKey, { move, signal, progress }));
  tree.refresh();
  if (r.failed.length) warn(`${verb}: ${r.done} done, ${r.failed.length} failed: ${r.failed.slice(0, 3).map((f) => `${f.key} (${f.error})`).join('; ')}`);
  else info(`${move ? 'Moved' : 'Copied'} ${fmtCount(r.done)} object${r.done > 1 ? 's' : ''} to s3://${dstBucket}/${dstPrefix}.`);
  return r;
}

async function copyBetweenConnections(node, nodes, opts = {}) {
  const sel = selection(node, nodes).filter((n) => n.kind === 'object' || n.kind === 'prefix');
  if (!sel.length) return null;
  const g = await pro.gate('crossCopy');
  if (!g.ok) return null;
  const srcConn = connOf(sel[0]);
  let dst = opts.target;
  if (!dst) {
    const others = store.list().filter((x) => x.id !== srcConn.id);
    if (!others.length) { info('Add a second connection first (for example Cloudflare R2 or MinIO).'); return null; }
    const pc = await vscode.window.showQuickPick(others.map((x) => ({ label: x.name, description: store.describe(x), conn: x })), { placeHolder: 'Copy to which connection?' });
    if (!pc) return null;
    let buckets = [];
    try { buckets = (await store.client(pc.conn).listBuckets()).map((b) => b.name); } catch (e) { /* maybe no ListBuckets */ }
    for (const b of pc.conn.pinned || []) if (!buckets.includes(b)) buckets.push(b);
    const pb = buckets.length ? await vscode.window.showQuickPick(buckets, { placeHolder: 'Bucket' }) : await vscode.window.showInputBox({ prompt: 'Bucket name' });
    if (!pb) return null;
    const pp = await vscode.window.showInputBox({ prompt: 'Destination folder (empty for the top level)', value: containerPrefix(sel[0]) });
    if (pp === undefined) return null;
    dst = { connId: pc.conn.id, bucket: pb, prefix: pp };
  }
  const dstConn = store.get(dst.connId);
  let prefix = (dst.prefix || '').replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  const exp = await expandKeys(sel);
  const mapKey = (it) => prefix + it.key.slice(it.base.length);
  const dc = store.client(dstConn);
  const clash = await existingKeys(dc, dst.bucket, exp.items.map(mapKey));
  const ok = await confirm.ask(vscode, `Copy ${fmtCount(exp.items.length)} objects from ${srcConn.name} to ${dstConn.name} s3://${dst.bucket}/${prefix}?`,
    `${keyList(exp.bucket, exp.items.map((i) => i.key))}${clash.length ? `\n\n${fmtCount(clash.length)} existing objects will be replaced:\n${keyList(dst.bucket, clash, 5)}` : ''}${g.note ? '\n\n' + g.note : ''}`, clash.length ? 'Copy and Replace' : 'Copy');
  if (!ok) return { cancelled: true };
  const tmpDir = path.join(ctx.globalStorageUri.fsPath, 'tmp');
  const sc = store.client(srcConn);
  const s = settings();
  const r = await withProgress(`Copying to ${dstConn.name}`, async (progress, signal) => {
    let done = 0;
    const failed = [];
    for (const it of exp.items) {
      if (signal.aborted) break;
      try {
        if (it.size < 64 * MB) {
          const { body, info: h } = await sc.getObjectBuffer(exp.bucket, it.key, { signal });
          await dc.putObject(dst.bucket, mapKey(it), body, { contentType: h.contentType || contentTypeFor(it.key), metadata: h.metadata, signal });
        } else {
          const tmp = path.join(tmpDir, crypto.randomBytes(8).toString('hex'));
          try {
            await downloadFile(sc, exp.bucket, it.key, tmp, { signal });
            await uploadFile(dc, { connId: dstConn.id, bucket: dst.bucket, key: mapKey(it), file: tmp, contentType: contentTypeFor(it.key), signal, threshold: s.multipartThresholdMB * MB, minPart: s.partSizeMB * MB, concurrency: s.concurrency });
          } finally { fs.rmSync(tmp, { force: true }); }
        }
        done++;
        progress.report({ message: `${done} of ${exp.items.length}` });
      } catch (e) { if (e && e.aborted) break; failed.push({ key: it.key, error: describeError(e).message }); }
    }
    return { done, failed };
  });
  tree.refresh();
  if (r.failed.length) warn(`Copied ${r.done}; ${r.failed.length} failed: ${r.failed.slice(0, 3).map((f) => `${f.key} (${f.error})`).join('; ')}`);
  else info(`Copied ${fmtCount(r.done)} objects to ${dstConn.name}.${g.note ? ' ' + g.note : ''}`);
  return r;
}

// ---------- folders, buckets, search ----------
async function newFolder(node, nodes, opts = {}) {
  const dest = node && (node.kind === 'object' ? node.parent : node);
  if (!dest) return null;
  const conn = connOf(dest);
  const name = opts.name || (await vscode.window.showInputBox({ prompt: `New folder in s3://${dest.bucket}/${containerPrefix(dest)}`, validateInput: (v) => (!v.trim() ? 'Enter a name' : /(^|\/)\.\.?(\/|$)/.test(v) ? 'No . or .. segments' : '') }));
  if (!name) return null;
  const key = containerPrefix(dest) + name.replace(/^\/+|\/+$/g, '') + '/';
  try { await store.client(conn).putObject(dest.bucket, key, Buffer.alloc(0)); tree.refresh(dest); return key; } catch (e) { await showError(e, conn, 'Could not create the folder:'); return null; }
}

async function createBucket(node, nodes, opts = {}) {
  const conn = connOf(node);
  const name = opts.name || (await vscode.window.showInputBox({ prompt: `New bucket on ${conn.name} (region ${conn.region})`, validateInput: (v) => (/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v) ? '' : '3 to 63 lowercase letters, digits, dots and hyphens') }));
  if (!name) return null;
  try { await store.client(conn).createBucket(name); tree.refresh(node); info(`Created bucket ${name}.`); return name; } catch (e) { await showError(e, conn, 'Could not create the bucket:'); return null; }
}

async function addBucketByName(node, nodes, opts = {}) {
  const connNode = node && node.kind === 'connection' ? node : node && node.parent && node.parent.kind === 'connection' ? node.parent : node;
  const conn = connOf(connNode);
  const name = opts.name || (await vscode.window.showInputBox({ prompt: `Bucket name to show under ${conn.name} (for keys that cannot list buckets)` }));
  if (!name) return null;
  await store.pin(conn.id, name.trim());
  tree.refresh();
  return name;
}

async function filterPrefix(node, nodes, opts = {}) {
  const b = node.kind === 'bucket' ? node : null;
  if (!b) return;
  const v = opts.prefix !== undefined ? opts.prefix : await vscode.window.showInputBox({ prompt: `Show keys in ${b.bucket} that start with...`, value: tree.filterOf(b.conn.id, b.bucket), placeHolder: 'logs/2026/11/' });
  if (v === undefined) return;
  tree.setFilter(b.conn.id, b.bucket, v);
  try { await view.reveal(b, { expand: true }); } catch (e) { /* hidden */ }
}

async function findByPrefix(node) {
  const b = node && (node.kind === 'bucket' || node.kind === 'prefix') ? node : null;
  if (!b) { warn('Pick a bucket in the S3 view first.'); return; }
  const conn = connOf(b);
  const c = store.client(conn);
  const qp = vscode.window.createQuickPick();
  qp.placeholder = `Type a key prefix in ${b.bucket} (lists as you type, 200 at a time)`;
  qp.value = containerPrefix(b);
  qp.matchOnDescription = true;
  let seq = 0;
  let timer;
  const load = async (prefix) => {
    const my = ++seq;
    qp.busy = true;
    try {
      const r = await c.listObjects(b.bucket, { prefix, maxKeys: 200 });
      if (my !== seq) return;
      const items = [
        ...r.folders.map((f) => ({ label: `$(folder) ${f}`, key: f, folder: true, alwaysShow: true })),
        ...r.objects.map((o) => ({ label: `$(file) ${o.key}`, description: fmtBytes(o.size), key: o.key, obj: o, alwaysShow: true })),
      ];
      if (r.truncated) items.push({ label: '$(ellipsis) More keys match: type more of the key', key: null, alwaysShow: true });
      if (prefix) items.unshift({ label: `$(filter) Show only keys starting with "${prefix}" in the tree`, key: prefix, filter: true, alwaysShow: true });
      qp.items = items;
    } catch (e) { if (my === seq) qp.items = [{ label: `$(error) ${describeError(e, conn).message}`, key: null }]; }
    finally { if (my === seq) qp.busy = false; }
  };
  qp.onDidChangeValue((v) => { clearTimeout(timer); timer = setTimeout(() => load(v), 250); });
  qp.onDidAccept(async () => {
    const it = qp.selectedItems[0];
    if (!it || it.key === null) return;
    if (it.folder) { qp.value = it.key; load(it.key); return; }
    qp.hide();
    if (it.filter) { const bn = tree.nodes.get(`b:${conn.id}|${b.bucket}`) || b; tree.setFilter(conn.id, b.bucket, it.key); try { await view.reveal(bn, { expand: true }); } catch (e) { /* hidden */ } return; }
    openObject({ kind: 'object', conn, bucket: b.bucket, obj: it.obj });
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  load(qp.value);
}

// ---------- copy URI, presign ----------
async function copyUri(node) {
  const key = node.kind === 'object' ? node.obj.key : node.kind === 'prefix' ? node.prefix : '';
  await vscode.env.clipboard.writeText(`s3://${node.bucket}/${key}`);
  vscode.window.setStatusBarMessage(`Copied s3://${node.bucket}/${key}`, 3000);
}

async function copyKey(node) {
  const key = node.kind === 'object' ? node.obj.key : node.prefix || '';
  await vscode.env.clipboard.writeText(key);
  vscode.window.setStatusBarMessage(`Copied ${key}`, 3000);
}

async function presignFor(conn, bucket, key, method, expires, versionId) {
  let warning = '';
  if (method === 'GET') {
    try { await store.client(conn).headObject(bucket, key, versionId); } catch (e) { if (e.status === 404 || e.code === 'NotFound') warning = 'The object does not exist now, so this link answers 404 until it is uploaded.'; else throw e; }
  }
  const url = await store.client(conn).presign(method, bucket, key, expires, { versionId });
  return { url, method, until: new Date(Date.now() + expires * 1000).toLocaleString(), warning };
}

async function presignCmd(node, nodes, opts = {}) {
  const conn = connOf(node);
  const key = node.obj.key;
  const expires = opts.expires || Number((await vscode.window.showQuickPick([
    { label: '15 minutes', v: 900 }, { label: '1 hour', v: 3600 }, { label: '1 day', v: 86400 }, { label: '7 days', description: 'longest S3 allows', v: 604800 },
  ], { placeHolder: 'Presigned GET link valid for...' }) || {}).v);
  if (!expires) return null;
  try {
    const p = await presignFor(conn, node.bucket, key, 'GET', expires);
    await vscode.env.clipboard.writeText(p.url);
    if (p.warning) warn(`Copied a presigned link. ${p.warning}`); else info(`Copied a presigned GET link for ${baseName(key)}, valid until ${p.until}.`);
    return p;
  } catch (e) { await showError(e, conn, 'Could not create the link:'); return null; }
}

// ---------- details panel ----------
async function showDetails(node) {
  const conn = connOf(node);
  const bucket = node.bucket;
  const key = node.obj.key;
  const id = `${conn.id}|${bucket}|${key}`;
  let panel = detailPanels.get(id);
  if (panel) { panel.reveal(); return panel; }
  panel = vscode.window.createWebviewPanel('s3Explorer.details', baseName(key), vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: commandUris(SECTION), localResourceRoots: [] });
  panel.iconPath = new vscode.ThemeIcon('info');
  detailPanels.set(id, panel);
  const state = { key, bucket, connName: conn.name, head: null, tags: [], versions: null, versioning: '', presign: null, showLinks: showLinks(vscode, SECTION) };
  const render = () => { panel.webview.html = panels.detailsHtml(panel.webview, state); };
  const c = store.client(conn);
  const load = async () => {
    try { state.head = await c.headObject(bucket, key); state.error = ''; } catch (e) { state.error = describeError(e, conn).message; }
    try { state.tags = await c.getObjectTagging(bucket, key); state.tagsError = ''; } catch (e) { state.tagsError = 'Tags: ' + describeError(e, conn).message; }
    try { state.versioning = await c.getBucketVersioning(bucket); } catch (e) { state.versioning = ''; }
    if (state.versioning && state.versioning !== 'Off') {
      try { state.versions = (await c.listObjectVersions(bucket, { prefix: key })).versions.filter((v) => v.key === key); } catch (e) { state.versions = null; state.versionsError = describeError(e, conn).message; }
    } else { state.versions = null; if (!state.versioning) state.versionsError = 'Versions are not available with this key.'; }
    render();
  };
  panel.onDidDispose(() => detailPanels.delete(id));
  render();
  await load();
  panel.webview.onDidReceiveMessage(async (m) => {
    const objNode = { kind: 'object', conn, bucket, obj: { key, size: state.head ? state.head.size : 0 }, parent: node.parent };
    try {
      switch (m.cmd) {
        case 'open': await openObject(objNode); break;
        case 'download': await downloadCmd(objNode); break;
        case 'edit': await editAndUpload(objNode); break;
        case 'copyUri': await copyUri(objNode); break;
        case 'delete': { const r = await deleteCmd(objNode); if (r && !r.cancelled && !r.error) panel.dispose(); break; }
        case 'presign': state.presign = await presignFor(conn, bucket, key, m.method === 'PUT' ? 'PUT' : 'GET', Number(m.expires) || 3600); render(); break;
        case 'copyPresign': if (state.presign) { await vscode.env.clipboard.writeText(state.presign.url); vscode.window.setStatusBarMessage('Copied the presigned URL', 3000); } break;
        case 'saveTags': {
          const tags = (m.tags || []).filter((t) => t && t.key).slice(0, 10);
          const ok = await confirm.ask(vscode, `Replace the tags of ${baseName(key)}?`, `${keyList(bucket, [key])}\n${tags.map((t) => `${t.key} = ${t.value}`).join('\n') || '(no tags)'}`, 'Save Tags');
          if (!ok) break;
          await c.putObjectTagging(bucket, key, tags);
          state.tags = await c.getObjectTagging(bucket, key);
          render();
          break;
        }
        case 'removeTag': state.tags.splice(Number(m.i), 1); render(); break;
        case 'openVersion': await openObject({ kind: 'object', conn, bucket, key }, { versionId: m.v }); break;
        case 'downloadVersion': {
          const uris = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), baseName(key))) });
          if (uris) { await downloadFile(c, bucket, key, uris.fsPath, { versionId: m.v }); info(`Saved version to ${uris.fsPath}.`); }
          break;
        }
        case 'restoreVersion': {
          const v = (state.versions || []).find((x) => x.versionId === m.v);
          const ok = await confirm.ask(vscode, `Restore this version of ${baseName(key)}?`, `${keyList(bucket, [key])}\nVersion ${m.v} from ${v ? v.lastModified : ''} is copied over the current object. The current one stays as an older version.`, 'Restore');
          if (!ok) break;
          await c.copyObject(bucket, key, bucket, key, { versionId: m.v });
          await load();
          info('Restored.');
          break;
        }
        default: break;
      }
    } catch (e) { await showError(e, conn); }
  });
  return panel;
}

// ---------- sync ----------
async function pickContainer() {
  const conns = store.list();
  if (!conns.length) { await addConnection(); return null; }
  const pc = conns.length === 1 ? { conn: conns[0] } : await vscode.window.showQuickPick(conns.map((c) => ({ label: c.name, description: store.describe(c), conn: c })), { placeHolder: 'Connection' });
  if (!pc) return null;
  let buckets = [];
  try { buckets = (await store.client(pc.conn).listBuckets()).map((b) => b.name); } catch (e) { /* none */ }
  for (const b of pc.conn.pinned || []) if (!buckets.includes(b)) buckets.push(b);
  const b = buckets.length ? await vscode.window.showQuickPick(buckets, { placeHolder: 'Bucket' }) : await vscode.window.showInputBox({ prompt: 'Bucket name' });
  if (!b) return null;
  const prefix = await vscode.window.showInputBox({ prompt: 'Prefix (folder) in the bucket, empty for the whole bucket', value: '' });
  if (prefix === undefined) return null;
  return { kind: 'prefix', conn: pc.conn, bucket: b, prefix: prefix && !prefix.endsWith('/') ? prefix + '/' : prefix };
}

async function syncCmd(node, nodes, opts = {}) {
  const target = node && (node.kind === 'bucket' || node.kind === 'prefix') ? node : await pickContainer();
  if (!target) return null;
  const conn = connOf(target);
  const prefix = target.kind === 'bucket' ? '' : target.prefix;
  const direction = opts.direction || (await vscode.window.showQuickPick([
    { label: '$(cloud-upload) Upload: local folder to S3', description: `to s3://${target.bucket}/${prefix}`, id: 'up' },
    { label: '$(cloud-download) Download: S3 to local folder', description: `from s3://${target.bucket}/${prefix}`, id: 'down' },
  ], { placeHolder: 'Sync direction (you see the plan before anything changes)' }) || {}).id;
  if (!direction) return null;
  let root = opts.root;
  if (!root) {
    const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: direction === 'up' ? 'Sync This Folder' : 'Sync Into This Folder', defaultUri: vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].uri : undefined });
    if (!uris || !uris.length) return null;
    root = uris[0].fsPath;
  }
  let deleteExtra = opts.deleteExtra;
  if (deleteExtra === undefined) {
    const d = await vscode.window.showQuickPick([
      { label: 'Keep extra files', description: 'add and update only', id: false },
      { label: 'Mirror', description: `also delete ${direction === 'up' ? 'objects' : 'local files'} that are not in the source (listed before anything is deleted)`, id: true },
    ], { placeHolder: 'Files that exist only in the destination' });
    if (!d) return null;
    deleteExtra = d.id;
  }
  const job = { connId: conn.id, bucket: target.bucket, prefix, root, direction, deleteExtra };
  return showPlan(job, opts);
}

async function makePlan(job, signal) {
  const conn = store.get(job.connId);
  const args = { client: store.client(conn), bucket: job.bucket, prefix: job.prefix, root: job.root, excludes: settings().syncExcludes, deleteExtra: job.deleteExtra, signal };
  return job.direction === 'up' ? planUpload(args) : planDownload(args);
}

async function showPlan(job, opts = {}) {
  const conn = store.get(job.connId);
  let plan;
  try { plan = await withProgress('Comparing (dry run, nothing changes)', (p, signal) => makePlan(job, signal)); } catch (e) { if (!e.aborted) await showError(e, conn, 'Could not plan the sync:'); return null; }
  const panel = vscode.window.createWebviewPanel('s3Explorer.syncPlan', 'Sync plan', vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: commandUris(SECTION), localResourceRoots: [] });
  panel.iconPath = new vscode.ThemeIcon('sync');
  const render = () => { panel.webview.html = panels.planHtml(panel.webview, Object.assign({ showLinks: showLinks(vscode, SECTION) }, plan)); };
  render();
  const api = { panel, plan: () => plan, apply: () => applyFromPanel(), replan: async () => { plan = await makePlan(job); render(); return plan; } };
  async function applyFromPanel() {
    if (plan.remove.length) {
      const list = job.direction === 'up' ? keyList(job.bucket, plan.remove.map((x) => x.key)) : plan.remove.slice(0, 15).map((x) => x.file).join('\n') + (plan.remove.length > 15 ? `\n... and ${fmtCount(plan.remove.length - 15)} more` : '');
      const ok = await confirm.ask(vscode, `Delete ${fmtCount(plan.remove.length)} ${job.direction === 'up' ? 'objects' : 'local files'} that are not in the source?`, list, 'Delete and Sync');
      if (!ok) return { cancelled: true };
    }
    if (plan.change.length) {
      const list = job.direction === 'up' ? keyList(job.bucket, plan.change.map((x) => x.key)) : plan.change.slice(0, 15).map((x) => x.file).join('\n');
      const ok = await confirm.ask(vscode, `Replace ${fmtCount(plan.change.length)} changed ${job.direction === 'up' ? 'objects' : 'files'}?`, list, 'Replace and Sync');
      if (!ok) return { cancelled: true };
    }
    const s = settings();
    const r = await withProgress('Syncing', (progress, signal) => {
      let last = 0;
      return applyPlan(plan, { client: store.client(conn), connId: conn.id, store: uploadStore, concurrency: s.concurrency, signal, contentTypeFor,
        onProgress: (p) => { const pct = p.total ? Math.floor((p.done / p.total) * 100) : 100; if (pct > last) { progress.report({ increment: pct - last, message: `${p.done} of ${p.total}` }); last = pct; } } });
    });
    plan.applied = r.cancelled ? `Stopped after ${r.done} of ${plan.create.length + plan.change.length + plan.remove.length}.` : r.failed.length ? `Done with ${r.failed.length} errors: ${r.failed.slice(0, 3).map((f) => `${f.item.key || f.item.file} (${f.error})`).join('; ')}` : `Synced: ${plan.create.length} new, ${plan.change.length} changed, ${r.deleted} deleted.`;
    render();
    tree.refresh();
    if (!r.cancelled && !r.failed.length) rating.success(toUri(vscode, conn.id, job.bucket, job.prefix || 'sync'));
    rememberSync(job);
    return r;
  }
  panel.webview.onDidReceiveMessage(async (m) => {
    try {
      if (m.cmd === 'apply') await applyFromPanel();
      if (m.cmd === 'replan') await api.replan();
      if (m.cmd === 'schedule') await scheduleSync(job);
    } catch (e) { await showError(e, conn); }
  });
  return api;
}

function rememberSync(job) {
  const list = (ctx.globalState.get('s3x.syncs.v1') || []).filter((j) => !(j.connId === job.connId && j.bucket === job.bucket && j.prefix === job.prefix && j.root === job.root && j.direction === job.direction));
  list.unshift(Object.assign({}, job, { at: Date.now() }));
  ctx.globalState.update('s3x.syncs.v1', list.slice(0, 10));
}

async function scheduleSync(job, minutes) {
  const g = await pro.gate('schedule');
  if (!g.ok) return null;
  const every = minutes || Number((await vscode.window.showQuickPick([{ label: 'Every 5 minutes', v: 5 }, { label: 'Every 15 minutes', v: 15 }, { label: 'Every 30 minutes', v: 30 }, { label: 'Every hour', v: 60 }], { placeHolder: 'Run this sync again while VS Code is open (scheduled runs never delete)' }) || {}).v);
  if (!every) return null;
  const id = `${job.connId}|${job.bucket}|${job.prefix}|${job.root}|${job.direction}`;
  stopSchedule(id);
  const run = async () => {
    const conn = store.get(job.connId);
    if (!conn) { stopSchedule(id); return; }
    try {
      const plan = await makePlan(Object.assign({}, job, { deleteExtra: false }));
      plan.remove = [];
      const r = await applyPlan(plan, { client: store.client(conn), connId: conn.id, store: uploadStore, concurrency: 2, contentTypeFor });
      const entry = schedules.get(id);
      if (entry) { entry.last = `${new Date().toLocaleTimeString()}: ${plan.create.length + plan.change.length} changed${r.failed.length ? `, ${r.failed.length} failed` : ''}`; entry.failed = r.failed.length > 0; }
    } catch (e) {
      const entry = schedules.get(id);
      if (entry) { entry.last = `${new Date().toLocaleTimeString()}: ${describeError(e, conn).message}`; entry.failed = true; }
    }
    updateScheduleStatus();
  };
  schedules.set(id, { job, every, timer: setInterval(run, every * 60000), last: 'not run yet' });
  updateScheduleStatus();
  info(`Sync runs every ${every} minutes while VS Code is open.${g.note ? ' ' + g.note : ''}`);
  return id;
}

function stopSchedule(id) {
  const ids = id ? [id] : [...schedules.keys()];
  for (const k of ids) { const e = schedules.get(k); if (e) { clearInterval(e.timer); schedules.delete(k); } }
  updateScheduleStatus();
}

function updateScheduleStatus() {
  if (!scheduleStatus) return;
  if (!schedules.size) { scheduleStatus.hide(); return; }
  const list = [...schedules.values()];
  const failed = list.some((e) => e.failed);
  scheduleStatus.text = `${failed ? '$(warning)' : '$(sync)'} S3 sync ×${list.length}`;
  scheduleStatus.tooltip = list.map((e) => `${e.job.direction === 'up' ? e.job.root + ' → s3://' + e.job.bucket + '/' + e.job.prefix : 's3://' + e.job.bucket + '/' + e.job.prefix + ' → ' + e.job.root} every ${e.every} min. Last: ${e.last}`).join('\n') + '\nClick to stop.';
  scheduleStatus.show();
}

// ---------- size report ----------
async function sizeReport(node, nodes, opts = {}) {
  const target = node && (node.kind === 'bucket' || node.kind === 'prefix') ? node : await pickContainer();
  if (!target) return null;
  const g = await pro.gate('sizeReport');
  if (!g.ok) return null;
  const conn = connOf(target);
  const prefix = target.kind === 'bucket' ? '' : target.prefix;
  const panel = vscode.window.createWebviewPanel('s3Explorer.report', `Size: ${target.bucket}/${prefix}`, vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: commandUris(SECTION), localResourceRoots: [] });
  panel.iconPath = new vscode.ThemeIcon('graph');
  const provider = PROVIDERS[conn.provider] || PROVIDERS.other;
  const price = settings().pricePerGBMonth || (conn.endpoint && conn.provider !== 'aws' && conn.type !== 'profile' ? provider.price : 0.023);
  const t0 = Date.now();
  let acc = null;
  let done = false;
  const render = () => {
    const a = acc || panels.aggregate([], prefix);
    panel.webview.html = panels.reportHtml(panel.webview, { bucket: target.bucket, prefix, connName: conn.name, count: a.count, bytes: a.bytes, price, ms: Date.now() - t0, done,
      groups: [...a.groups.values()].sort((x, y) => y.bytes - x.bytes), classes: [...a.classes.values()].sort((x, y) => y.bytes - x.bytes), largest: a.largest, showLinks: showLinks(vscode, SECTION) });
  };
  render();
  let lastRender = 0;
  const ac = new AbortController();
  panel.onDidDispose(() => ac.abort());
  try {
    await store.client(conn).listAll(target.bucket, prefix, (objs) => {
      acc = panels.aggregate(objs, prefix, acc);
      if (Date.now() - lastRender > 700) { lastRender = Date.now(); render(); }
    }, ac.signal);
    done = true;
    render();
    if (g.note) info(g.note);
  } catch (e) { if (!e.aborted) await showError(e, conn, 'Size report stopped:'); }
  return { panel, result: () => acc, done: () => done };
}

// ---------- activation ----------
function activate(context) {
  ctx = context;
  store = new ConnectionStore({ context, settings, askMfa: (name, serial) => vscode.window.showInputBox({ prompt: `MFA code for profile ${name} (${serial})`, ignoreFocusOut: true }) });
  uploadStore = new UploadStore(path.join(context.globalStorageUri.fsPath, 'uploads'));
  tree = new S3Tree({ vscode, store, uploads: () => uploadStore.list(), settings });
  const dnd = createDnd({ vscode, onDropFiles: (uris, dest) => uploadPaths(uris.map((u) => u.fsPath), dest), onDropObjects: (objs, dest) => copyOrMove(objs[0], objs, true, { bucket: dest.bucket, prefix: containerPrefix(dest) }) });
  view = vscode.window.createTreeView('s3Explorer.buckets', { treeDataProvider: tree, dragAndDropController: dnd, canSelectMany: true, showCollapseAll: true });
  context.subscriptions.push(view, store.onDidChange(() => tree.emitter.fire(undefined)));

  const fsp = new S3FileSystem({ vscode, store, onRead: (uri, n, err) => { if (err) rating.failure(); } });
  const ro = new vscode.MarkdownString('Opened read-only from S3. To change it, use **Edit and Upload** on the object in the S3 view.');
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('s3x', fsp, { isCaseSensitive: true, isReadonly: ro }));

  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'S3 Explorer' });
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  pro = createPro({ vscode, context });

  scheduleStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  scheduleStatus.command = 's3Explorer.stopSchedules';
  context.subscriptions.push(scheduleStatus);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { await showError(e, a[0] && a[0].conn ? store.get(a[0].conn.id) : null); return undefined; }
  }));
  reg('s3Explorer.addConnection', addConnection);
  reg('s3Explorer.connectProfile', connectProfile);
  reg('s3Explorer.editConnection', editConnection);
  reg('s3Explorer.removeConnection', removeConnection);
  reg('s3Explorer.refresh', (n) => { if (n && n.kind === 'message') n = n.parent; if (n && n.kind === 'connection') store.dropClient(n.conn.id); tree.refresh(n); });
  reg('s3Explorer.loadMore', (n) => tree.loadMore(n));
  reg('s3Explorer.openObject', (n, nodes, o) => openObject(n, o));
  reg('s3Explorer.openPreview', (n) => openObject(n, { mode: 'text', largeChoice: 'head' }));
  reg('s3Explorer.showDetails', showDetails);
  reg('s3Explorer.editAndUpload', editAndUpload);
  reg('s3Explorer.upload', (n, nodes, o) => uploadCmd(n, nodes, o));
  reg('s3Explorer.uploadFolder', (n, nodes, o) => uploadCmd(n, nodes, Object.assign({ folders: true }, o)));
  reg('s3Explorer.download', downloadCmd);
  reg('s3Explorer.delete', deleteCmd);
  reg('s3Explorer.rename', renameCmd);
  reg('s3Explorer.copyTo', (n, nodes, o) => copyOrMove(n, nodes, false, o));
  reg('s3Explorer.moveTo', (n, nodes, o) => copyOrMove(n, nodes, true, o));
  reg('s3Explorer.copyBetweenConnections', copyBetweenConnections);
  reg('s3Explorer.copyUri', copyUri);
  reg('s3Explorer.copyKey', copyKey);
  reg('s3Explorer.presign', presignCmd);
  reg('s3Explorer.newFolder', newFolder);
  reg('s3Explorer.createBucket', createBucket);
  reg('s3Explorer.addBucketByName', addBucketByName);
  reg('s3Explorer.removePinnedBucket', async (n) => { await store.unpin(n.conn.id, n.bucket); tree.refresh(); });
  reg('s3Explorer.filterPrefix', filterPrefix);
  reg('s3Explorer.clearFilter', (n) => tree.setFilter(n.conn.id, n.bucket, ''));
  reg('s3Explorer.findByPrefix', findByPrefix);
  reg('s3Explorer.sync', syncCmd);
  reg('s3Explorer.syncAgain', async () => {
    const list = (ctx.globalState.get('s3x.syncs.v1') || []).filter((j) => store.get(j.connId));
    if (!list.length) { info('No sync yet. Right-click a bucket or folder and choose Sync.'); return null; }
    const p = await vscode.window.showQuickPick(list.map((j) => ({ label: j.direction === 'up' ? `${path.basename(j.root)} → s3://${j.bucket}/${j.prefix}` : `s3://${j.bucket}/${j.prefix} → ${path.basename(j.root)}`, description: j.deleteExtra ? 'mirror' : '', job: j })), { placeHolder: 'Plan a recent sync again' });
    return p ? showPlan(p.job) : null;
  });
  reg('s3Explorer.stopSchedules', async () => { if (!schedules.size) return; const ok = await vscode.window.showInformationMessage(`Stop ${schedules.size} scheduled sync${schedules.size > 1 ? 's' : ''}?`, 'Stop'); if (ok === 'Stop') stopSchedule(); });
  reg('s3Explorer.sizeReport', sizeReport);
  reg('s3Explorer.resumeUpload', resumeUpload);
  reg('s3Explorer.discardUpload', discardUploadCmd);
  reg('s3Explorer.ssoLogin', runSsoLogin);
  reg('s3Explorer.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#s3Explorer.start`, false));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((d) => { onSaveEdited(d).catch((e) => showError(e)); }));
  context.subscriptions.push({ dispose: () => { stopSchedule(); store.disposeAll(); } });

  if (process.env.ZOVO_S3X_GATE !== '1') return undefined;
  // A hook for the release gate only (VS Code started with ZOVO_S3X_GATE=1). Normal installs export nothing.
  return { _gate: {
    store, tree, view, uploadStore, confirm, gateLog, pro,
    saveConnection, openObject, uploadPaths, downloadCmd, deleteCmd, renameCmd, copyOrMove, copyBetweenConnections, presignFor,
    showDetails, showPlan, sizeReport, editAndUpload, resumeUpload, newFolder, createBucket, filterPrefix, scheduleSync, stopSchedule,
    detailPanels, editSessions, rating: () => rating,
  } };
}

function deactivate() { stopSchedule(); if (store) store.disposeAll(); }

module.exports = { activate, deactivate };
