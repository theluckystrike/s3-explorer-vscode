'use strict';
// Read-only file system for "s3x:" URIs, so text objects open in a normal editor tab without a local copy.
// URI: s3x://<connection id>/<bucket>/<key>?head=<bytes>&version=<id>. head= reads only the first bytes (range GET).
const { baseName } = require('./s3/paths');

function toUri(vscode, connId, bucket, key, { head, version } = {}) {
  const q = [];
  if (head) q.push('head=' + head);
  if (version) q.push('version=' + encodeURIComponent(version));
  return vscode.Uri.from({ scheme: 's3x', authority: connId, path: '/' + bucket + '/' + key, query: q.join('&') });
}

function fromUri(uri) {
  const p = uri.path.replace(/^\//, '');
  const i = p.indexOf('/');
  const bucket = i < 0 ? p : p.slice(0, i);
  const key = i < 0 ? '' : p.slice(i + 1);
  const q = new URLSearchParams(uri.query || '');
  return { connId: uri.authority, bucket, key, head: q.get('head') ? Number(q.get('head')) : 0, version: q.get('version') || undefined };
}

class S3FileSystem {
  constructor({ vscode, store, onRead }) {
    this.vscode = vscode;
    this.store = store;
    this.onRead = onRead || (() => {});
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
  }

  watch() { return { dispose() {} }; }

  async stat(uri) {
    const v = this.vscode;
    const r = fromUri(uri);
    if (!r.key || r.key.endsWith('/')) return { type: v.FileType.Directory, ctime: 0, mtime: 0, size: 0, permissions: v.FilePermission ? v.FilePermission.Readonly : undefined };
    try {
      const h = await this.store.client(r.connId).headObject(r.bucket, r.key, r.version);
      const size = r.head ? Math.min(r.head, h.size) : h.size;
      const mtime = Date.parse(h.lastModified) || 0;
      return { type: v.FileType.File, ctime: mtime, mtime, size, permissions: v.FilePermission ? v.FilePermission.Readonly : undefined };
    } catch (e) {
      if (e.code === 'NotFound' || e.code === 'NoSuchKey' || e.status === 404) throw v.FileSystemError.FileNotFound(uri);
      throw v.FileSystemError.Unavailable(e.message);
    }
  }

  async readFile(uri) {
    const v = this.vscode;
    const r = fromUri(uri);
    try {
      const c = this.store.client(r.connId);
      const range = r.head ? [0, r.head - 1] : undefined;
      const { body } = await c.getObjectBuffer(r.bucket, r.key, { range, versionId: r.version });
      this.onRead(uri, body.length, null);
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } catch (e) {
      this.onRead(uri, 0, e);
      if (e.code === 'NoSuchKey' || e.status === 404) throw v.FileSystemError.FileNotFound(uri);
      throw v.FileSystemError.Unavailable(e.message);
    }
  }

  async readDirectory(uri) {
    const v = this.vscode;
    const r = fromUri(uri);
    const prefix = r.key && !r.key.endsWith('/') ? r.key + '/' : r.key;
    const page = await this.store.client(r.connId).listObjects(r.bucket, { prefix, maxKeys: 1000 });
    return [
      ...page.folders.map((f) => [baseName(f), v.FileType.Directory]),
      ...page.objects.filter((o) => o.key !== prefix).map((o) => [baseName(o.key), v.FileType.File]),
    ];
  }

  createDirectory(uri) { throw this.vscode.FileSystemError.NoPermissions(uri); }
  writeFile(uri) { throw this.vscode.FileSystemError.NoPermissions('Objects open read-only. Use "Edit and Upload" to change one.'); }
  delete(uri) { throw this.vscode.FileSystemError.NoPermissions(uri); }
  rename(uri) { throw this.vscode.FileSystemError.NoPermissions(uri); }
}

module.exports = { S3FileSystem, toUri, fromUri };
