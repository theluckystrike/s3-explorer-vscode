'use strict';
// Saved connections. The list (names, endpoints, regions, profile names) lives in globalState; access keys live in
// VS Code SecretStorage (the OS keychain) and never in settings files. Nothing connects until the user picks it.
const crypto = require('crypto');
const { S3Client } = require('./s3/client');
const creds = require('./s3/credentials');

const LIST_KEY = 's3x.connections.v1';
const SECRET_PREFIX = 's3x.keys.';

// Presets for S3-compatible services. {region} and {account} are filled from the user's answers.
const PROVIDERS = {
  aws: { label: 'Amazon S3 (access key)', endpoint: '', region: 'us-east-1', pathStyle: false, price: 0.023 },
  minio: { label: 'MinIO (self-hosted)', endpoint: 'http://localhost:9000', region: 'us-east-1', pathStyle: true, price: 0, askEndpoint: true },
  r2: { label: 'Cloudflare R2', endpoint: 'https://{account}.r2.cloudflarestorage.com', region: 'auto', pathStyle: true, price: 0.015, askAccount: 'Cloudflare account ID (from the R2 overview page)' },
  b2: { label: 'Backblaze B2', endpoint: 'https://s3.{region}.backblazeb2.com', region: 'us-west-004', pathStyle: true, price: 0.006, askRegion: true },
  wasabi: { label: 'Wasabi', endpoint: 'https://s3.{region}.wasabisys.com', region: 'us-east-1', pathStyle: true, price: 0.0069, askRegion: true },
  spaces: { label: 'DigitalOcean Spaces', endpoint: 'https://{region}.digitaloceanspaces.com', region: 'nyc3', pathStyle: false, price: 0.02, askRegion: true },
  other: { label: 'Other S3-compatible service', endpoint: '', region: 'us-east-1', pathStyle: true, price: 0, askEndpoint: true },
};

function fillEndpoint(tpl, { region, account }) {
  return tpl.replace('{region}', region || '').replace('{account}', account || '');
}

class ConnectionStore {
  constructor({ context, settings, askMfa, env }) {
    this.context = context;
    this.settings = settings || (() => ({}));
    this.askMfa = askMfa;
    this.env = env || process.env;
    this.clients = new Map();
    this.listeners = [];
  }

  list() { return (this.context.globalState.get(LIST_KEY) || []).slice(); }
  get(id) { return this.list().find((c) => c.id === id) || null; }
  onDidChange(fn) { this.listeners.push(fn); return { dispose: () => { this.listeners = this.listeners.filter((f) => f !== fn); } }; }
  _fire() { for (const f of this.listeners) try { f(); } catch (e) { /* ignore */ } }

  async save(list) { await this.context.globalState.update(LIST_KEY, list); this._fire(); }

  /** conn: { name, type: 'profile'|'keys'|'env', provider, profile?, endpoint?, region, pathStyle, insecureTLS }. keys: {accessKeyId, secretAccessKey, sessionToken?} */
  async add(conn, keys) {
    const id = conn.id || crypto.randomBytes(6).toString('hex');
    const c = Object.assign({ pinned: [] }, conn, { id, added: new Date().toISOString() });
    if (keys) await this.context.secrets.store(SECRET_PREFIX + id, JSON.stringify({ accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, sessionToken: keys.sessionToken || undefined }));
    const list = this.list().filter((x) => x.id !== id);
    list.push(c);
    await this.save(list);
    return c;
  }

  async update(id, patch, keys) {
    const list = this.list();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return null;
    list[i] = Object.assign({}, list[i], patch, { id });
    if (keys) await this.context.secrets.store(SECRET_PREFIX + id, JSON.stringify(keys));
    this.dropClient(id);
    await this.save(list);
    return list[i];
  }

  async remove(id) {
    await this.context.secrets.delete(SECRET_PREFIX + id);
    this.dropClient(id);
    await this.save(this.list().filter((c) => c.id !== id));
  }

  dropClient(id) { const c = this.clients.get(id); if (c) { c.dispose(); this.clients.delete(id); } }
  disposeAll() { for (const id of [...this.clients.keys()]) this.dropClient(id); }

  async keysFor(conn) {
    if (conn.type === 'keys') {
      const raw = await this.context.secrets.get(SECRET_PREFIX + conn.id);
      if (!raw) throw new creds.CredentialError(`No access key is saved for "${conn.name}". Edit the connection and enter it again.`, { code: 'NoCredentials' });
      return JSON.parse(raw);
    }
    if (conn.type === 'profile') return creds.resolveProfile(conn.profile, { env: this.env, askMfa: this.askMfa });
    if (conn.type === 'env') return creds.envCredentials(this.env);
    throw new creds.CredentialError('Unknown connection type.', { code: 'BadConnection' });
  }

  client(connOrId) {
    const conn = typeof connOrId === 'string' ? this.get(connOrId) : connOrId;
    if (!conn) throw new Error('This connection no longer exists.');
    let c = this.clients.get(conn.id);
    if (c) return c;
    const s = this.settings();
    c = new S3Client({
      endpoint: conn.endpoint || undefined,
      region: conn.region || 'us-east-1',
      pathStyle: conn.pathStyle,
      insecureTLS: !!conn.insecureTLS,
      timeoutMs: (s.requestTimeoutSeconds || 30) * 1000,
      credentials: () => this.keysFor(conn),
    });
    this.clients.set(conn.id, c);
    return c;
  }

  async pin(id, bucket) {
    const c = this.get(id);
    if (!c) return;
    const pinned = Array.from(new Set([...(c.pinned || []), bucket]));
    await this.update(id, { pinned });
  }

  async unpin(id, bucket) {
    const c = this.get(id);
    if (!c) return;
    await this.update(id, { pinned: (c.pinned || []).filter((b) => b !== bucket) });
  }

  /** AWS profiles on this computer that are not saved as connections yet (names only). */
  availableProfiles() {
    const used = new Set(this.list().filter((c) => c.type === 'profile').map((c) => c.profile));
    return creds.listProfiles(this.env).filter((p) => !used.has(p));
  }

  describe(conn) {
    if (conn.type === 'profile') return `AWS profile ${conn.profile}${conn.endpoint ? ' · ' + hostOf(conn.endpoint) : ''} · ${conn.region || 'us-east-1'}`;
    if (conn.type === 'env') return `Environment variables · ${conn.region || 'us-east-1'}`;
    const p = PROVIDERS[conn.provider] || PROVIDERS.other;
    return conn.endpoint ? `${p.label.replace(/ \(.*\)$/, '')} · ${hostOf(conn.endpoint)}` : `${p.label.replace(/ \(.*\)$/, '')} · ${conn.region}`;
  }
}

function hostOf(url) { try { return new URL(url).host; } catch (e) { return url; } }

module.exports = { ConnectionStore, PROVIDERS, fillEndpoint, LIST_KEY, SECRET_PREFIX, hostOf };
