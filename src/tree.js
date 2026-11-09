'use strict';
// The S3 Buckets tree: connections > buckets > folders (prefixes) > objects. Lists one page at a time
// (ListObjectsV2, 1,000 keys by default) and adds a "Load more" row, so a bucket with millions of keys opens at
// once. Nothing is listed until the user expands a node.
const { fmtBytes, fmtCount, describeError } = require('./ui');
const { baseName } = require('./s3/paths');

const DND_MIME = 'application/vnd.code.tree.s3explorer.connections';

class S3Tree {
  constructor({ vscode, store, uploads, settings }) {
    this.vscode = vscode;
    this.store = store;
    this.uploads = uploads; // () => [unfinished upload states]
    this.settings = settings;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.pages = new Map(); // container id -> { folders, objects, token, truncated, error, loading }
    this.buckets = new Map(); // conn id -> { list, error }
    this.filters = new Map(); // conn|bucket -> prefix filter
    this.nodes = new Map();
    this.stats = { listCalls: 0, lastListMs: 0 };
  }

  refresh(node) {
    if (!node) { this.pages.clear(); this.buckets.clear(); this.emitter.fire(undefined); return; }
    if (node.kind === 'connection') { this.buckets.delete(node.conn.id); for (const k of [...this.pages.keys()]) if (k.startsWith(node.conn.id + '|')) this.pages.delete(k); }
    else if (node.kind === 'bucket' || node.kind === 'prefix') { for (const k of [...this.pages.keys()]) if (k.startsWith(this.cid(node))) this.pages.delete(k); }
    // Fire only with an element the tree created (same id); otherwise refresh everything.
    const real = node.id ? this.nodes.get(node.id) : null;
    this.emitter.fire(real || undefined);
  }

  cid(node) { return `${node.conn.id}|${node.bucket}|${node.kind === 'bucket' ? this.filterOf(node.conn.id, node.bucket) : node.prefix}`; }
  filterOf(connId, bucket) { return this.filters.get(`${connId}|${bucket}`) || ''; }
  setFilter(connId, bucket, prefix) {
    const k = `${connId}|${bucket}`;
    if (prefix) this.filters.set(k, prefix); else this.filters.delete(k);
    for (const key of [...this.pages.keys()]) if (key.startsWith(k + '|')) this.pages.delete(key);
    const n = this.nodes.get(`b:${connId}|${bucket}`);
    this.emitter.fire(n || undefined);
  }

  node(n) { this.nodes.set(n.id, n); return n; }

  getParent(n) { return n.parent; }

  // ---------- tree items ----------
  getTreeItem(n) {
    const v = this.vscode;
    const C = v.TreeItemCollapsibleState;
    let it;
    switch (n.kind) {
      case 'connection': {
        it = new v.TreeItem(n.conn.name, C.Collapsed);
        it.description = this.store.describe(n.conn);
        it.iconPath = new v.ThemeIcon(n.conn.type === 'profile' ? 'account' : 'server');
        it.contextValue = 'connection';
        it.tooltip = `${n.conn.name}\n${this.store.describe(n.conn)}`;
        break;
      }
      case 'profiles': {
        it = new v.TreeItem(`AWS profiles on this computer (${n.names.length})`, C.Collapsed);
        it.iconPath = new v.ThemeIcon('key');
        it.tooltip = 'Profiles found in ~/.aws/config and ~/.aws/credentials. Only names are read. Nothing connects until you pick one; the "default" profile is never used on its own.';
        it.contextValue = 'profiles';
        break;
      }
      case 'profile': {
        it = new v.TreeItem(n.name, C.None);
        it.description = n.name === 'default' ? 'click to connect (never used on its own)' : 'click to connect';
        it.iconPath = new v.ThemeIcon('plug');
        it.command = { command: 's3Explorer.connectProfile', title: 'Connect', arguments: [n.name] };
        it.contextValue = 'profile';
        break;
      }
      case 'uploads': {
        it = new v.TreeItem(`Unfinished uploads (${n.states.length})`, C.Expanded);
        it.iconPath = new v.ThemeIcon('cloud-upload');
        it.contextValue = 'uploads';
        break;
      }
      case 'upload': {
        const s = n.state;
        it = new v.TreeItem(baseName(s.key), C.None);
        it.description = `s3://${s.bucket}/${s.key} · ${fmtBytes(s.size)}`;
        it.tooltip = `Started ${s.started}. Resume continues with the parts already on the server; Discard deletes them.`;
        it.iconPath = new v.ThemeIcon('debug-pause');
        it.contextValue = 'upload';
        it.command = { command: 's3Explorer.resumeUpload', title: 'Resume', arguments: [n] };
        break;
      }
      case 'bucket': {
        const f = this.filterOf(n.conn.id, n.bucket);
        it = new v.TreeItem(n.bucket, C.Collapsed);
        it.description = f ? `filter: ${f}` : (n.pinned ? 'added by name' : '');
        it.iconPath = new v.ThemeIcon('database');
        it.contextValue = ['bucket', f ? 'filtered' : '', n.pinned ? 'pinned' : ''].filter(Boolean).join(' ');
        it.tooltip = `s3://${n.bucket}/${f ? `\nShowing keys that start with "${f}"` : ''}`;
        break;
      }
      case 'prefix': {
        it = new v.TreeItem(n.label, C.Collapsed);
        it.iconPath = v.ThemeIcon.Folder;
        it.contextValue = 'prefix';
        it.tooltip = `s3://${n.bucket}/${n.prefix}`;
        it.resourceUri = v.Uri.parse(`s3x-icon:/${encodeURIComponent(n.label)}/`);
        break;
      }
      case 'object': {
        const o = n.obj;
        it = new v.TreeItem(n.label, C.None);
        it.description = `${fmtBytes(o.size)}${o.storageClass && o.storageClass !== 'STANDARD' ? ' · ' + o.storageClass : ''}`;
        it.tooltip = `s3://${n.bucket}/${o.key}\n${fmtBytes(o.size)} · ${o.lastModified}\n${o.storageClass || ''}`;
        it.resourceUri = v.Uri.parse(`s3x-icon:/${encodeURIComponent(n.label)}`);
        it.iconPath = v.ThemeIcon.File;
        it.contextValue = 'object';
        it.command = { command: 's3Explorer.openObject', title: 'Open', arguments: [n] };
        break;
      }
      case 'more': {
        it = new v.TreeItem(n.loading ? 'Loading...' : `Load ${fmtCount(this.pageSize())} more`, C.None);
        it.description = `${fmtCount(n.shown)} shown`;
        it.iconPath = new v.ThemeIcon(n.loading ? 'loading~spin' : 'ellipsis');
        it.command = { command: 's3Explorer.loadMore', title: 'Load more', arguments: [n] };
        it.contextValue = 'more';
        break;
      }
      case 'message': {
        it = new v.TreeItem(n.text, C.None);
        it.iconPath = new v.ThemeIcon(n.error ? 'error' : 'info');
        it.tooltip = n.detail || n.text;
        if (n.command) it.command = n.command;
        it.contextValue = n.error ? 'error' : 'message';
        break;
      }
      default:
        it = new v.TreeItem('?');
    }
    it.id = n.id;
    return it;
  }

  pageSize() { return Math.max(100, Math.min(1000, (this.settings().pageSize || 1000))); }

  // ---------- children ----------
  async getChildren(n) {
    if (!n) return this.roots();
    if (n.kind === 'connection') return this.bucketChildren(n);
    if (n.kind === 'profiles') return n.names.map((name) => this.node({ kind: 'profile', id: `p:${name}`, name, parent: n }));
    if (n.kind === 'uploads') return n.states.map((s) => this.node({ kind: 'upload', id: `u:${s.id}`, state: s, parent: n }));
    if (n.kind === 'bucket' || n.kind === 'prefix') return this.listChildren(n);
    return [];
  }

  roots() {
    const out = this.store.list().map((conn) => this.node({ kind: 'connection', id: `c:${conn.id}`, conn }));
    const ups = this.uploads();
    if (ups.length) out.push(this.node({ kind: 'uploads', id: 'uploads', states: ups }));
    if (this.settings().showAwsProfiles !== false) {
      const names = this.store.availableProfiles();
      if (names.length) out.push(this.node({ kind: 'profiles', id: 'profiles', names }));
    }
    return out;
  }

  async bucketChildren(n) {
    const conn = this.store.get(n.conn.id) || n.conn;
    let entry = this.buckets.get(conn.id);
    if (!entry) {
      entry = { list: [], error: null };
      try {
        const t0 = Date.now();
        entry.list = await this.store.client(conn).listBuckets();
        this.stats.lastListMs = Date.now() - t0;
      } catch (e) {
        entry.error = e;
      }
      this.buckets.set(conn.id, entry);
    }
    const names = new Set(entry.list.map((b) => b.name));
    const out = [];
    for (const b of entry.list) out.push(this.node({ kind: 'bucket', id: `b:${conn.id}|${b.name}`, conn, bucket: b.name, parent: n }));
    for (const b of conn.pinned || []) if (!names.has(b)) out.push(this.node({ kind: 'bucket', id: `b:${conn.id}|${b}`, conn, bucket: b, pinned: true, parent: n }));
    if (entry.error) {
      const d = describeError(entry.error, conn);
      const denied = entry.error.code === 'AccessDenied';
      out.push(this.node({ kind: 'message', id: `e:${conn.id}`, error: !denied || !out.length, parent: n,
        text: denied ? 'This key cannot list buckets. Add a bucket by name.' : d.message.split('. ')[0] + '.', detail: d.message,
        command: denied ? { command: 's3Explorer.addBucketByName', title: 'Add bucket', arguments: [n] } : { command: 's3Explorer.refresh', title: 'Retry', arguments: [n] } }));
      if (d.actions.includes('Run aws sso login')) out.push(this.node({ kind: 'message', id: `sso:${conn.id}`, text: 'Run aws sso login in a terminal', parent: n, command: { command: 's3Explorer.ssoLogin', title: 'SSO', arguments: [entry.error.loginCommand] } }));
    } else if (!out.length) {
      out.push(this.node({ kind: 'message', id: `none:${conn.id}`, text: 'No buckets. Create one or add one by name.', parent: n, command: { command: 's3Explorer.addBucketByName', title: 'Add', arguments: [n] } }));
    }
    return out;
  }

  async listChildren(n) {
    const key = this.cid(n);
    let page = this.pages.get(key);
    if (!page) {
      page = { folders: [], objects: [], token: undefined, truncated: false, error: null };
      this.pages.set(key, page);
      await this.fetchPage(n, page);
    }
    return this.renderPage(n, page);
  }

  async fetchPage(n, page) {
    const prefix = n.kind === 'bucket' ? this.filterOf(n.conn.id, n.bucket) : n.prefix;
    const t0 = Date.now();
    try {
      this.stats.listCalls++;
      const r = await this.store.client(n.conn).listObjects(n.bucket, { prefix, continuationToken: page.token, maxKeys: this.pageSize() });
      page.folders.push(...r.folders);
      page.objects.push(...r.objects.filter((o) => o.key !== prefix || o.size > 0));
      page.token = r.next;
      page.truncated = r.truncated && !!r.next;
      page.error = null;
    } catch (e) {
      page.error = e;
    }
    this.stats.lastListMs = Date.now() - t0;
  }

  renderPage(n, page) {
    const base = n.kind === 'bucket' ? this.filterOf(n.conn.id, n.bucket) : n.prefix;
    const cut = (k) => {
      // With a filter like "logs/20", show the rest of the key after the last "/" of the filter.
      const from = base.lastIndexOf('/') + 1;
      return k.slice(from);
    };
    const out = [];
    for (const p of page.folders) out.push(this.node({ kind: 'prefix', id: `f:${n.conn.id}|${n.bucket}|${p}`, conn: n.conn, bucket: n.bucket, prefix: p, label: cut(p).replace(/\/$/, '') || '/', parent: n }));
    for (const o of page.objects) out.push(this.node({ kind: 'object', id: `o:${n.conn.id}|${n.bucket}|${o.key}`, conn: n.conn, bucket: n.bucket, obj: o, label: cut(o.key) || o.key, parent: n }));
    if (page.error) {
      const d = describeError(page.error, n.conn);
      out.push(this.node({ kind: 'message', id: `e:${this.cid(n)}`, error: true, text: d.message.split('. ')[0] + '.', detail: d.message, parent: n, command: { command: 's3Explorer.refresh', title: 'Retry', arguments: [n] } }));
    } else if (page.truncated) {
      out.push(this.node({ kind: 'more', id: `m:${this.cid(n)}`, parent: n, container: n, shown: page.folders.length + page.objects.length, loading: !!page.loading }));
    } else if (!out.length) {
      out.push(this.node({ kind: 'message', id: `empty:${this.cid(n)}`, text: base ? `Nothing starts with "${base}".` : 'Empty bucket. Drop files here to upload.', parent: n }));
    }
    return out;
  }

  async loadMore(moreNode) {
    const n = moreNode.container;
    const page = this.pages.get(this.cid(n));
    if (!page || !page.truncated || page.loading) return;
    page.loading = true;
    this.emitter.fire(n);
    try { await this.fetchPage(n, page); } finally { page.loading = false; }
    this.emitter.fire(n);
  }

  /** Objects currently shown under a container (for tests and "select all"). */
  shown(n) { const p = this.pages.get(this.cid(n)); return p ? { folders: p.folders.length, objects: p.objects.length, truncated: p.truncated } : null; }
}

/** Drag and drop: files from the Explorer or the OS onto a bucket or folder upload; tree objects onto a folder move. */
function createDnd({ vscode, onDropFiles, onDropObjects }) {
  return {
    dragMimeTypes: [DND_MIME],
    dropMimeTypes: [DND_MIME, 'text/uri-list', 'files'],
    handleDrag(source, dt) {
      const objs = source.filter((n) => n.kind === 'object' || n.kind === 'prefix');
      if (objs.length) dt.set(DND_MIME, new vscode.DataTransferItem(objs));
    },
    async handleDrop(target, dt) {
      if (!target) return;
      const dest = target.kind === 'object' ? target.parent : target;
      if (!dest || (dest.kind !== 'bucket' && dest.kind !== 'prefix')) return;
      const internal = dt.get(DND_MIME);
      if (internal && Array.isArray(internal.value) && internal.value.length) { await onDropObjects(internal.value, dest); return; }
      const uris = [];
      const list = dt.get('text/uri-list');
      if (list) {
        const text = await list.asString();
        for (const line of text.split(/\r?\n/)) { const l = line.trim(); if (l && !l.startsWith('#')) { try { uris.push(vscode.Uri.parse(l)); } catch (e) { /* skip */ } } }
      }
      if (!uris.length) {
        dt.forEach((item) => { const f = item.asFile && item.asFile(); if (f && f.uri) uris.push(f.uri); });
      }
      const files = uris.filter((u) => u.scheme === 'file');
      if (files.length) await onDropFiles(files, dest);
    },
  };
}

module.exports = { S3Tree, createDnd, DND_MIME };
