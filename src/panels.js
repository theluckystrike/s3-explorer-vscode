'use strict';
// Webview panels: object details (metadata, tags, versions, presigned URLs), the sync plan, and the size report.
// CSP: default-src 'none'; scripts and styles only by nonce; no network from the webview.
const crypto = require('crypto');
const { fmtBytes, fmtCount } = require('./ui');
const support = require('./support');

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:14px 20px 40px;margin:0}
h1{font-size:1.25em;font-weight:600;margin:0 0 2px;word-break:break-all}
h2{font-size:1.02em;font-weight:600;margin:20px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
.sub{color:var(--vscode-descriptionForeground);margin-bottom:12px;word-break:break-all}
table{border-collapse:collapse;width:100%;max-width:980px}
td,th{text-align:left;padding:4px 10px 4px 0;vertical-align:top;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.15))}
th{font-weight:600;color:var(--vscode-descriptionForeground);white-space:nowrap;width:1%}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
code,.mono{font-family:var(--vscode-editor-font-family);font-size:.95em;word-break:break-all}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 12px;border-radius:2px;cursor:pointer;font:inherit;margin:0 6px 6px 0}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.link{background:none;color:var(--vscode-textLink-foreground);padding:0 6px 0 0;margin:0}
button:disabled{opacity:.5;cursor:default}
input,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:4px 6px;font:inherit}
input:focus,select:focus,button:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.tag{display:inline-block;padding:0 6px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:.85em}
.warn{color:var(--vscode-editorWarning-foreground)}
.err{color:var(--vscode-errorForeground)}
.ok{color:var(--vscode-testing-iconPassed,#3fb950)}
.muted{color:var(--vscode-descriptionForeground)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
.url{margin-top:8px;padding:8px;background:var(--vscode-textCodeBlock-background);border-radius:3px;word-break:break-all;font-family:var(--vscode-editor-font-family);font-size:.9em;max-width:980px}
.barcol{width:40%}
.bar{height:8px;background:var(--vscode-progressBar-background);border-radius:2px;min-width:1px}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 4px}
.tile{padding:8px 14px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:4px;min-width:110px}
.tile b{display:block;font-size:1.35em;font-weight:600}
.pro{font-size:.8em;padding:0 5px;border:1px solid var(--vscode-descriptionForeground);border-radius:3px;color:var(--vscode-descriptionForeground);margin-left:4px}
details summary{cursor:pointer;margin:6px 0}
${support.FOOTER_CSS}
`;

function page(webview, title, body, script) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style nonce="${nonce}">${CSS}</style></head>
<body>${body}<script nonce="${nonce}">const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (!b) return; e.preventDefault(); const d = Object.assign({}, b.dataset); vscode.postMessage(d); });
${script || ''}</script></body></html>`;
}

function footer(showLinks) { return support.footerHtml('s3Explorer', showLinks, ''); }

// ---------------- object details ----------------
function detailsHtml(webview, d) {
  const h = d.head || {};
  const rows = [
    ['Size', `${fmtBytes(h.size)} <span class="muted">(${fmtCount(h.size || 0)} bytes)</span>`],
    ['Last modified', esc(h.lastModified)],
    ['Content type', esc(h.contentType) || '<span class="muted">none</span>'],
    ['Storage class', esc(h.storageClass)],
    ['ETag', `<code>${esc(h.etag)}</code>${String(h.etag).includes('-') ? ' <span class="muted">(multipart)</span>' : ''}`],
  ];
  if (h.versionId && h.versionId !== 'null') rows.push(['Version ID', `<code>${esc(h.versionId)}</code>`]);
  if (h.serverSideEncryption) rows.push(['Encryption', esc(h.serverSideEncryption)]);
  if (h.cacheControl) rows.push(['Cache-Control', esc(h.cacheControl)]);
  if (h.contentEncoding) rows.push(['Content-Encoding', esc(h.contentEncoding)]);
  if (h.contentDisposition) rows.push(['Content-Disposition', esc(h.contentDisposition)]);
  if (h.restore) rows.push(['Restore', esc(h.restore)]);
  const meta = Object.entries(h.metadata || {});
  const tags = d.tags || [];
  const versions = d.versions || null;
  const presign = d.presign;
  const body = `
<h1>${esc(d.key.split('/').pop() || d.key)}</h1>
<div class="sub"><span class="mono">s3://${esc(d.bucket)}/${esc(d.key)}</span> · ${esc(d.connName)}</div>
<div class="row">
  <button data-cmd="open">Open</button>
  <button class="secondary" data-cmd="download">Download...</button>
  <button class="secondary" data-cmd="edit">Edit and Upload...</button>
  <button class="secondary" data-cmd="copyUri">Copy S3 URI</button>
  <button class="secondary" data-cmd="delete">Delete...</button>
</div>
${d.error ? `<p class="err">${esc(d.error)}</p>` : ''}
<h2>Object</h2>
<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>
<h2>Metadata</h2>
${meta.length ? `<table>${meta.map(([k, v]) => `<tr><th class="mono">x-amz-meta-${esc(k)}</th><td class="mono">${esc(v)}</td></tr>`).join('')}</table>` : '<p class="muted">No user metadata.</p>'}
<h2>Tags</h2>
<table id="tags">${tags.map((t, i) => `<tr><td><input data-tk="${i}" value="${esc(t.key)}" aria-label="Tag key"></td><td><input data-tv="${i}" value="${esc(t.value)}" aria-label="Tag value"></td><td><button class="link" data-cmd="removeTag" data-i="${i}">Remove</button></td></tr>`).join('')}
<tr><td><input id="nk" placeholder="key" aria-label="New tag key"></td><td><input id="nv" placeholder="value" aria-label="New tag value"></td><td></td></tr></table>
<div class="row"><button class="secondary" id="saveTags">Save tags</button>${d.tagsError ? `<span class="muted">${esc(d.tagsError)}</span>` : ''}</div>
<h2>Presigned URL</h2>
<div class="row">
  <select id="pm" aria-label="Method"><option value="GET">GET (download)</option><option value="PUT">PUT (upload)</option></select>
  <select id="pe" aria-label="Expires in">
    <option value="900">15 minutes</option><option value="3600" selected>1 hour</option><option value="43200">12 hours</option><option value="86400">1 day</option><option value="604800">7 days (longest S3 allows)</option>
  </select>
  <button id="presign">Create URL</button>
</div>
${presign ? `<div class="url" id="purl">${esc(presign.url)}</div><div class="row"><button class="secondary" data-cmd="copyPresign">Copy URL</button><span class="muted">${esc(presign.method)}, ends ${esc(presign.until)}. Anyone with this link can ${presign.method === 'PUT' ? 'upload to this key' : 'download this object'} until then.</span>${presign.warning ? `<span class="warn">${esc(presign.warning)}</span>` : ''}</div>` : ''}
<h2>Versions</h2>
${versions === null ? `<p class="muted">${esc(d.versioning === 'Off' ? 'Versioning is off for this bucket.' : d.versionsError || 'Loading...')}</p>` : versions.length ? `<table><tr><th>Modified</th><th class="num">Size</th><th>Version ID</th><th></th></tr>${versions.map((v) => `<tr><td>${esc(v.lastModified)}${v.isLatest ? ' <span class="tag">current</span>' : ''}${v.deleteMarker ? ' <span class="tag">delete marker</span>' : ''}</td><td class="num">${v.deleteMarker ? '' : fmtBytes(v.size)}</td><td><code>${esc(v.versionId)}</code></td><td>${v.deleteMarker ? '' : `<button class="link" data-cmd="openVersion" data-v="${esc(v.versionId)}">Open</button><button class="link" data-cmd="downloadVersion" data-v="${esc(v.versionId)}">Download</button>${v.isLatest ? '' : `<button class="link" data-cmd="restoreVersion" data-v="${esc(v.versionId)}">Restore</button>`}`}</td></tr>`).join('')}</table>` : '<p class="muted">No versions.</p>'}
${footer(d.showLinks)}`;
  const script = `
const $ = (id) => document.getElementById(id);
$('presign').addEventListener('click', () => vscode.postMessage({ cmd: 'presign', method: $('pm').value, expires: Number($('pe').value) }));
$('saveTags').addEventListener('click', () => {
  const tags = [];
  document.querySelectorAll('[data-tk]').forEach((el) => { const i = el.dataset.tk; const v = document.querySelector('[data-tv="' + i + '"]'); if (el.value.trim()) tags.push({ key: el.value.trim(), value: v ? v.value : '' }); });
  if ($('nk').value.trim()) tags.push({ key: $('nk').value.trim(), value: $('nv').value });
  vscode.postMessage({ cmd: 'saveTags', tags });
});`;
  return page(webview, d.key, body, script);
}

// ---------------- sync plan ----------------
function planHtml(webview, p) {
  const up = p.direction === 'up';
  const src = up ? p.root : `s3://${p.bucket}/${p.prefix}`;
  const dst = up ? `s3://${p.bucket}/${p.prefix}` : p.root;
  const rows = (items, label, cls) => items.slice(0, 500).map((x) => `<tr><td><span class="${cls}">${label}</span></td><td class="mono">${esc(up ? x.key : (x.key || x.file))}</td><td class="num">${fmtBytes(x.size)}</td></tr>`).join('');
  const more = (n) => (n > 500 ? `<tr><td></td><td class="muted">... and ${fmtCount(n - 500)} more</td><td></td></tr>` : '');
  const nothing = !p.create.length && !p.change.length && !p.remove.length;
  const body = `
<h1>Sync plan (dry run)</h1>
<div class="sub">${esc(src)} &rarr; ${esc(dst)}</div>
<div class="tiles">
  <div class="tile"><b>${fmtCount(p.create.length)}</b>new</div>
  <div class="tile"><b>${fmtCount(p.change.length)}</b>changed</div>
  <div class="tile"><b class="${p.remove.length ? 'warn' : ''}">${fmtCount(p.remove.length)}</b>to delete</div>
  <div class="tile"><b>${fmtCount(p.same)}</b>unchanged</div>
  <div class="tile"><b>${fmtBytes(p.bytes)}</b>to ${up ? 'upload' : 'download'}</div>
</div>
${p.skipped.length ? `<p class="warn">${fmtCount(p.skipped.length)} skipped: ${esc(p.skipped.slice(0, 5).map((s) => `${s.key || s.path} (${s.why})`).join('; '))}${p.skipped.length > 5 ? '; ...' : ''}</p>` : ''}
<p class="muted">Nothing has changed yet. ${p.remove.length ? `Apply deletes ${fmtCount(p.remove.length)} ${up ? 'objects' : 'local files'} that are not in the source, after one more confirmation that lists them.` : 'Nothing will be deleted.'}</p>
<div class="row">${p.applied ? `<span class="ok">${esc(p.applied)}</span>` : `<button data-cmd="apply" ${nothing ? 'disabled' : ''}>Apply</button><button class="secondary" data-cmd="replan">Plan again</button>`}<button class="secondary" data-cmd="schedule">Repeat on a schedule...<span class="pro">Pro</span></button></div>
${nothing ? '<p class="ok">Already in sync.</p>' : `<table><tr><th>Change</th><th>${up ? 'Key' : 'Key / file'}</th><th class="num">Size</th></tr>${rows(p.create, 'new', 'ok')}${more(p.create.length)}${rows(p.change, 'changed', '')}${more(p.change.length)}${rows(p.remove, 'delete', 'warn')}${more(p.remove.length)}</table>`}
${footer(p.showLinks)}`;
  return page(webview, 'Sync plan', body, '');
}

// ---------------- size report ----------------
function reportHtml(webview, r) {
  const max = Math.max(1, ...r.groups.map((g) => g.bytes));
  const body = `
<h1>Size and cost: s3://${esc(r.bucket)}/${esc(r.prefix)}</h1>
<div class="sub">${esc(r.connName)} · ${r.done ? `listed ${fmtCount(r.count)} objects in ${(r.ms / 1000).toFixed(1)} s` : `listing... ${fmtCount(r.count)} objects so far`}</div>
<div class="tiles">
  <div class="tile"><b>${fmtBytes(r.bytes)}</b>total</div>
  <div class="tile"><b>${fmtCount(r.count)}</b>objects</div>
  <div class="tile"><b>${r.price ? '$' + (r.bytes / 1024 ** 3 * r.price).toFixed(2) : 'n/a'}</b>per month (estimate)</div>
</div>
<p class="muted">${r.price ? `Estimate at $${r.price} per GB-month for storage only (setting s3Explorer.pricePerGBMonth). Requests, transfer and minimum durations are not included.` : 'Set s3Explorer.pricePerGBMonth to see a storage cost estimate.'}</p>
<h2>By folder</h2>
<table><tr><th>Folder</th><th class="num">Objects</th><th class="num">Size</th><th class="barcol"></th></tr>
${r.groups.slice(0, 200).map((g) => `<tr><td class="mono">${esc(g.name)}</td><td class="num">${fmtCount(g.count)}</td><td class="num">${fmtBytes(g.bytes)}</td><td><div class="bar" data-w="${Math.max(0.5, (g.bytes / max) * 100).toFixed(1)}"></div></td></tr>`).join('')}</table>
<h2>By storage class</h2>
<table><tr><th>Class</th><th class="num">Objects</th><th class="num">Size</th></tr>${r.classes.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${fmtCount(c.count)}</td><td class="num">${fmtBytes(c.bytes)}</td></tr>`).join('')}</table>
<h2>Largest objects</h2>
<table><tr><th>Key</th><th class="num">Size</th><th>Modified</th></tr>${r.largest.map((o) => `<tr><td class="mono">${esc(o.key)}</td><td class="num">${fmtBytes(o.size)}</td><td>${esc(o.lastModified)}</td></tr>`).join('')}</table>
${footer(r.showLinks)}`;
  return page(webview, 'Size report', body, "document.querySelectorAll('[data-w]').forEach((el) => { el.style.width = el.dataset.w + '%'; });");
}

/** Groups objects by the next folder level under prefix. Pure, for tests. */
function aggregate(objects, prefix, acc) {
  const a = acc || { count: 0, bytes: 0, groups: new Map(), classes: new Map(), largest: [] };
  for (const o of objects) {
    a.count++;
    a.bytes += o.size;
    const rest = o.key.slice(prefix.length);
    const i = rest.indexOf('/');
    const name = i < 0 ? '(files here)' : rest.slice(0, i + 1);
    const g = a.groups.get(name) || { name, count: 0, bytes: 0 };
    g.count++; g.bytes += o.size; a.groups.set(name, g);
    const cn = o.storageClass || 'STANDARD';
    const c = a.classes.get(cn) || { name: cn, count: 0, bytes: 0 };
    c.count++; c.bytes += o.size; a.classes.set(cn, c);
    if (a.largest.length < 20 || o.size > a.largest[a.largest.length - 1].size) {
      a.largest.push({ key: o.key, size: o.size, lastModified: o.lastModified });
      a.largest.sort((x, y) => y.size - x.size);
      if (a.largest.length > 20) a.largest.pop();
    }
  }
  return a;
}

module.exports = { detailsHtml, planHtml, reportHtml, aggregate, esc, page };
