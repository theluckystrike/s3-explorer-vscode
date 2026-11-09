'use strict';
// A small S3 client over Node's http/https, signed with SigV4. It talks only to the endpoint of one connection
// (AWS S3 in a region, or a custom S3-compatible endpoint such as MinIO, Cloudflare R2, Backblaze B2, Wasabi or
// DigitalOcean Spaces). No telemetry, no other host.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { sign, presign, uriEncode, sha256hex, EMPTY_SHA256, UNSIGNED } = require('./sigv4');
const xml = require('./xml');

class S3Error extends Error {
  constructor(message, props) {
    super(message);
    this.name = 'S3Error';
    Object.assign(this, props || {});
  }
}

const RETRY_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN', 'ENETRESET']);
const RETRY_S3 = new Set(['SlowDown', 'InternalError', 'ServiceUnavailable', 'RequestTimeout', 'Throttling', 'ThrottlingException']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when the bucket name can be a DNS label (virtual-hosted style). */
function dnsCompatible(bucket) {
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) && !bucket.includes('--');
}

function md5b64(buf) { return crypto.createHash('md5').update(buf).digest('base64'); }

/** Keys come back URL-encoded when we ask for encoding-type=url (safe for control characters in keys). */
function decodeKey(s) {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); }
}

class S3Client {
  /**
   * opts: { endpoint?: string (custom S3-compatible URL), region, pathStyle?: boolean, credentials: () => Promise<creds>,
   *         insecureTLS?: boolean, timeoutMs?: number (time to the response headers), idleMs?: number, maxRetries?: number }
   */
  constructor(opts) {
    this.region = opts.region || 'us-east-1';
    this.credentialsFn = opts.credentials;
    this.timeoutMs = opts.timeoutMs || 30000;
    this.idleMs = opts.idleMs || 60000;
    this.maxRetries = opts.maxRetries === undefined ? 3 : opts.maxRetries;
    this.bucketRegion = new Map();
    if (opts.endpoint) {
      const u = new URL(/^[a-z]+:\/\//i.test(opts.endpoint) ? opts.endpoint : 'https://' + opts.endpoint);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new S3Error('The endpoint must start with https:// or http://', { code: 'BadEndpoint' });
      this.custom = true;
      this.protocol = u.protocol;
      this.hostname = u.hostname;
      this.port = u.port ? Number(u.port) : undefined;
      this.basePath = u.pathname.replace(/\/+$/, '');
      this.pathStyle = opts.pathStyle !== false;
    } else {
      this.custom = false;
      this.protocol = 'https:';
      this.basePath = '';
      this.pathStyle = !!opts.pathStyle;
    }
    const agentOpts = { keepAlive: true, maxSockets: 16 };
    if (this.protocol === 'https:' && opts.insecureTLS) agentOpts.rejectUnauthorized = false;
    this.agent = this.protocol === 'https:' ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
    this._creds = null;
  }

  dispose() { try { this.agent.destroy(); } catch (e) { /* ignore */ } }

  async creds() {
    const c = this._creds;
    if (c && (!c.expiration || new Date(c.expiration).getTime() - Date.now() > 5 * 60000)) return c;
    this._creds = await this.credentialsFn();
    if (!this._creds || !this._creds.accessKeyId || !this._creds.secretAccessKey) throw new S3Error('No access key for this connection.', { code: 'NoCredentials' });
    return this._creds;
  }

  regionFor(bucket) { return (bucket && this.bucketRegion.get(bucket)) || this.region; }

  /** Host, port and encoded path for a bucket and key. */
  target(bucket, key) {
    const region = this.regionFor(bucket);
    const encKey = key ? '/' + uriEncode(key, false) : '';
    let hostname, path;
    if (this.custom) {
      if (!bucket) { hostname = this.hostname; path = this.basePath + '/'; }
      else if (this.pathStyle || !dnsCompatible(bucket)) { hostname = this.hostname; path = `${this.basePath}/${uriEncode(bucket)}${encKey}`; }
      else { hostname = `${bucket}.${this.hostname}`; path = `${this.basePath}${encKey || '/'}`; }
    } else {
      const base = `s3.${region}.amazonaws.com`;
      if (!bucket) { hostname = base; path = '/'; }
      else if (this.pathStyle || !dnsCompatible(bucket)) { hostname = base; path = `/${uriEncode(bucket)}${encKey}`; }
      else { hostname = `${bucket}.${base}`; path = encKey || '/'; }
    }
    const defPort = this.protocol === 'https:' ? 443 : 80;
    const port = this.port || defPort;
    const host = port === defPort ? hostname : `${hostname}:${port}`;
    return { hostname, port, host, path, region };
  }

  /**
   * One signed request. opts: { method, bucket, key, query, headers, body (Buffer|string), stream (return the
   * response stream), signal, okStatus (array), noRetry }
   * Returns { status, headers, body (Buffer) | stream }.
   */
  async request(opts) {
    let redirected = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._once(opts);
      } catch (e) {
        // Retry once in the bucket's region. Compare with the region this request was signed for: a parallel
        // request may have learned the region already.
        if (e && e.region && !redirected && opts.bucket && e.region !== e.signedRegion) {
          this.bucketRegion.set(opts.bucket, e.region);
          redirected = true;
          attempt--;
          continue;
        }
        const replayable = opts.body === undefined || Buffer.isBuffer(opts.body) || typeof opts.body === 'string';
        const retryable = (e && (RETRY_CODES.has(e.code) || RETRY_S3.has(e.code) || (e.status >= 500 && e.status <= 599))) && !e.timeout && !e.aborted;
        if (!replayable || !retryable || opts.noRetry || attempt >= this.maxRetries) throw e;
        await sleep(Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 150));
      }
    }
  }

  async _once(opts) {
    const { method = 'GET', bucket, key, query, signal } = opts;
    if (signal && signal.aborted) throw new S3Error('Cancelled', { code: 'Aborted', aborted: true });
    const creds = await this.creds();
    const t = this.target(bucket, key);
    let body = opts.body;
    if (typeof body === 'string') body = Buffer.from(body, 'utf8');
    const payloadHash = opts.payloadHash || (body ? sha256hex(body) : EMPTY_SHA256);
    const headers = Object.assign({}, opts.headers || {});
    if (body) headers['content-length'] = String(body.length);
    else if (method === 'PUT' || method === 'POST') headers['content-length'] = '0';
    const signed = sign({ method, host: t.host, path: t.path, query, headers, payloadHash, creds, region: t.region, service: 's3' });
    const qs = require('./sigv4').canonicalQuery(query);
    const lib = this.protocol === 'https:' ? https : http;
    return await new Promise((resolve, reject) => {
      let done = false;
      const fail = (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } };
      const req = lib.request({ protocol: this.protocol, hostname: t.hostname, port: t.port, method, path: t.path + (qs ? '?' + qs : ''), headers: signed, agent: this.agent });
      const timer = setTimeout(() => {
        const err = new S3Error(`No answer from ${t.host} in ${Math.round(this.timeoutMs / 1000)} seconds.`, { code: 'Timeout', timeout: true, host: t.host });
        fail(err);
        req.destroy(err);
      }, this.timeoutMs);
      req.setTimeout(this.idleMs, () => {
        const err = new S3Error(`The connection to ${t.host} stalled for ${Math.round(this.idleMs / 1000)} seconds.`, { code: 'Timeout', timeout: true, host: t.host });
        fail(err);
        req.destroy(err);
      });
      const onAbort = () => { const err = new S3Error('Cancelled', { code: 'Aborted', aborted: true }); fail(err); req.destroy(err); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      req.on('error', (e) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (done) return;
        const err = e instanceof S3Error ? e : new S3Error(networkMessage(e, t.host), { code: e.code || 'NetworkError', host: t.host, cause: e });
        fail(err);
      });
      req.on('response', (res) => {
        clearTimeout(timer);
        const status = res.statusCode;
        const ok = opts.okStatus ? opts.okStatus.includes(status) : status >= 200 && status < 300;
        if (ok && opts.stream) {
          done = true;
          if (signal) {
            res.on('close', () => signal.removeEventListener('abort', onAbort));
          }
          resolve({ status, headers: res.headers, stream: res, req });
          return;
        }
        const chunks = [];
        let size = 0;
        const cap = ok ? 64 * 1024 * 1024 : 1024 * 1024;
        res.on('data', (c) => { size += c.length; if (size <= cap) chunks.push(c); else res.destroy(); });
        res.on('error', (e) => fail(new S3Error(networkMessage(e, t.host), { code: e.code || 'NetworkError', host: t.host })));
        res.on('end', () => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (done) return;
          done = true;
          const buf = Buffer.concat(chunks);
          if (ok) { resolve({ status, headers: res.headers, body: buf }); return; }
          const err = errorFromResponse(status, res.headers, buf, method, t.host);
          err.signedRegion = t.region;
          reject(err);
        });
      });
      if (body) req.end(body); else req.end();
    });
  }

  async xmlRequest(opts) {
    const r = await this.request(opts);
    if (!r.body || !r.body.length) return null;
    return xml.parse(r.body.toString('utf8'));
  }

  // ---------- buckets ----------
  async listBuckets() {
    const doc = await this.xmlRequest({ method: 'GET' });
    const bs = xml.child(doc, 'Buckets');
    return xml.children(bs, 'Bucket').map((b) => ({ name: xml.textOf(b, 'Name'), created: xml.textOf(b, 'CreationDate') }));
  }

  async headBucket(bucket) {
    const r = await this.request({ method: 'HEAD', bucket, okStatus: [200, 301, 400, 403, 404] });
    return { status: r.status, region: r.headers['x-amz-bucket-region'] || '' };
  }

  async getBucketVersioning(bucket) {
    const doc = await this.xmlRequest({ method: 'GET', bucket, query: { versioning: '' } });
    return xml.textOf(doc, 'Status') || 'Off';
  }

  async putBucketVersioning(bucket, on) {
    const body = `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${on ? 'Enabled' : 'Suspended'}</Status></VersioningConfiguration>`;
    await this.request({ method: 'PUT', bucket, query: { versioning: '' }, body, headers: { 'content-md5': md5b64(Buffer.from(body)) } });
  }

  async createBucket(bucket) {
    let body;
    if (!this.custom && this.region !== 'us-east-1') body = `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${this.region}</LocationConstraint></CreateBucketConfiguration>`;
    await this.request({ method: 'PUT', bucket, body });
  }

  // ---------- listing ----------
  /** One page of ListObjectsV2. Returns { folders: [prefix], objects: [{key,size,lastModified,etag,storageClass}], next, truncated }. */
  async listObjects(bucket, { prefix = '', delimiter = '/', continuationToken, maxKeys = 1000, startAfter, signal } = {}) {
    const query = { 'list-type': '2', 'encoding-type': 'url', 'max-keys': String(maxKeys) };
    if (prefix) query.prefix = prefix;
    if (delimiter) query.delimiter = delimiter;
    if (continuationToken) query['continuation-token'] = continuationToken;
    if (startAfter) query['start-after'] = startAfter;
    const doc = await this.xmlRequest({ method: 'GET', bucket, query, signal });
    const enc = xml.textOf(doc, 'EncodingType') === 'url';
    const dk = (s) => (enc ? decodeKey(s) : s);
    return {
      folders: xml.children(doc, 'CommonPrefixes').map((p) => dk(xml.textOf(p, 'Prefix'))),
      objects: xml.children(doc, 'Contents').map((c) => ({
        key: dk(xml.textOf(c, 'Key')),
        size: Number(xml.textOf(c, 'Size', '0')),
        lastModified: xml.textOf(c, 'LastModified'),
        etag: xml.textOf(c, 'ETag').replace(/"/g, ''),
        storageClass: xml.textOf(c, 'StorageClass') || 'STANDARD',
      })),
      next: xml.textOf(doc, 'NextContinuationToken') || undefined,
      truncated: xml.textOf(doc, 'IsTruncated') === 'true',
    };
  }

  /** Every object under a prefix (no delimiter), page by page. onPage(objects) may return false to stop. */
  async listAll(bucket, prefix, onPage, signal) {
    let token;
    let n = 0;
    do {
      const page = await this.listObjects(bucket, { prefix, delimiter: '', continuationToken: token, signal });
      n += page.objects.length;
      if ((await onPage(page.objects)) === false) break;
      token = page.truncated ? page.next : undefined;
    } while (token);
    return n;
  }

  async listObjectVersions(bucket, { prefix = '', keyMarker, versionIdMarker, maxKeys = 1000 } = {}) {
    const query = { versions: '', 'encoding-type': 'url', 'max-keys': String(maxKeys) };
    if (prefix) query.prefix = prefix;
    if (keyMarker) query['key-marker'] = keyMarker;
    if (versionIdMarker) query['version-id-marker'] = versionIdMarker;
    const doc = await this.xmlRequest({ method: 'GET', bucket, query });
    const enc = xml.textOf(doc, 'EncodingType') === 'url';
    const dk = (s) => (enc ? decodeKey(s) : s);
    const out = [];
    for (const c of doc.children) {
      if (c.name !== 'Version' && c.name !== 'DeleteMarker') continue;
      out.push({
        key: dk(xml.textOf(c, 'Key')), versionId: xml.textOf(c, 'VersionId'), isLatest: xml.textOf(c, 'IsLatest') === 'true',
        lastModified: xml.textOf(c, 'LastModified'), size: Number(xml.textOf(c, 'Size', '0')), etag: xml.textOf(c, 'ETag').replace(/"/g, ''),
        deleteMarker: c.name === 'DeleteMarker', storageClass: xml.textOf(c, 'StorageClass'),
      });
    }
    return { versions: out, truncated: xml.textOf(doc, 'IsTruncated') === 'true', nextKeyMarker: dk(xml.textOf(doc, 'NextKeyMarker')), nextVersionIdMarker: xml.textOf(doc, 'NextVersionIdMarker') };
  }

  // ---------- objects ----------
  async headObject(bucket, key, versionId) {
    const query = versionId ? { versionId } : undefined;
    const r = await this.request({ method: 'HEAD', bucket, key, query });
    return headInfo(r.headers);
  }

  /** Returns { stream, headers, status }. range: [start, end] inclusive. */
  async getObjectStream(bucket, key, { range, versionId, signal } = {}) {
    const headers = {};
    if (range) headers.range = `bytes=${range[0]}-${range[1] === undefined ? '' : range[1]}`;
    const query = versionId ? { versionId } : undefined;
    return this.request({ method: 'GET', bucket, key, query, headers, stream: true, signal, okStatus: [200, 206] });
  }

  async getObjectBuffer(bucket, key, { range, versionId, signal } = {}) {
    const headers = {};
    if (range) headers.range = `bytes=${range[0]}-${range[1]}`;
    const query = versionId ? { versionId } : undefined;
    const r = await this.request({ method: 'GET', bucket, key, query, headers, signal, okStatus: [200, 206] });
    return { body: r.body, info: headInfo(r.headers) };
  }

  async putObject(bucket, key, body, { contentType, metadata, signal } = {}) {
    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    for (const [k, v] of Object.entries(metadata || {})) headers['x-amz-meta-' + k.toLowerCase()] = v;
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    headers['content-md5'] = md5b64(buf);
    const r = await this.request({ method: 'PUT', bucket, key, body: buf, headers, signal });
    return { etag: String(r.headers.etag || '').replace(/"/g, ''), versionId: r.headers['x-amz-version-id'] || '' };
  }

  async deleteObject(bucket, key, versionId) {
    await this.request({ method: 'DELETE', bucket, key, query: versionId ? { versionId } : undefined, okStatus: [200, 204] });
  }

  /** Deletes up to 1000 keys per call. items: [{key, versionId?}]. Returns { deleted: [key], errors: [{key, code, message}] }. */
  async deleteObjects(bucket, items) {
    const deleted = [];
    const errors = [];
    for (let i = 0; i < items.length; i += 1000) {
      const part = items.slice(i, i + 1000);
      const body = '<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>false</Quiet>'
        + part.map((it) => `<Object><Key>${xml.escapeXml(it.key)}</Key>${it.versionId ? `<VersionId>${xml.escapeXml(it.versionId)}</VersionId>` : ''}</Object>`).join('')
        + '</Delete>';
      const buf = Buffer.from(body, 'utf8');
      const doc = await this.xmlRequest({ method: 'POST', bucket, query: { delete: '' }, body: buf, headers: { 'content-md5': md5b64(buf), 'content-type': 'application/xml' } });
      for (const d of xml.children(doc, 'Deleted')) deleted.push(xml.textOf(d, 'Key'));
      for (const e of xml.children(doc, 'Error')) errors.push({ key: xml.textOf(e, 'Key'), code: xml.textOf(e, 'Code'), message: xml.textOf(e, 'Message') });
    }
    return { deleted, errors };
  }

  /** Server-side copy (up to 5 GB; larger objects use copyLarge). */
  async copyObject(srcBucket, srcKey, dstBucket, dstKey, { versionId, metadata, contentType } = {}) {
    const headers = { 'x-amz-copy-source': '/' + uriEncode(srcBucket) + '/' + uriEncode(srcKey, false) + (versionId ? '?versionId=' + encodeURIComponent(versionId) : '') };
    if (metadata || contentType) {
      headers['x-amz-metadata-directive'] = 'REPLACE';
      if (contentType) headers['content-type'] = contentType;
      for (const [k, v] of Object.entries(metadata || {})) headers['x-amz-meta-' + k.toLowerCase()] = v;
    }
    const r = await this.request({ method: 'PUT', bucket: dstBucket, key: dstKey, headers });
    const text = r.body ? r.body.toString('utf8') : '';
    if (/<Error>/.test(text)) { const d = xml.parse(text); throw new S3Error(xml.textOf(d, 'Message') || 'Copy failed', { code: xml.textOf(d, 'Code'), status: 200 }); }
    return { versionId: r.headers['x-amz-version-id'] || '' };
  }

  /** Copy that also works above 5 GB (multipart UploadPartCopy). */
  async copyLarge(srcBucket, srcKey, dstBucket, dstKey, size, { versionId, signal, onProgress } = {}) {
    if (size <= 5 * 1024 ** 3) return this.copyObject(srcBucket, srcKey, dstBucket, dstKey, { versionId });
    const partSize = Math.max(512 * 1024 ** 2, Math.ceil(size / 9000));
    const uploadId = await this.createMultipart(dstBucket, dstKey, {});
    const parts = [];
    try {
      for (let n = 1, off = 0; off < size; n++, off += partSize) {
        const end = Math.min(size, off + partSize) - 1;
        const headers = {
          'x-amz-copy-source': '/' + uriEncode(srcBucket) + '/' + uriEncode(srcKey, false) + (versionId ? '?versionId=' + encodeURIComponent(versionId) : ''),
          'x-amz-copy-source-range': `bytes=${off}-${end}`,
        };
        const doc = await this.xmlRequest({ method: 'PUT', bucket: dstBucket, key: dstKey, query: { partNumber: String(n), uploadId }, headers, signal });
        parts.push({ partNumber: n, etag: xml.textOf(doc, 'ETag').replace(/"/g, '') });
        if (onProgress) onProgress(end + 1, size);
      }
      await this.completeMultipart(dstBucket, dstKey, uploadId, parts);
    } catch (e) {
      await this.abortMultipart(dstBucket, dstKey, uploadId).catch(() => {});
      throw e;
    }
    return {};
  }

  // ---------- multipart ----------
  async createMultipart(bucket, key, { contentType } = {}) {
    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    const doc = await this.xmlRequest({ method: 'POST', bucket, key, query: { uploads: '' }, headers });
    const id = xml.textOf(doc, 'UploadId');
    if (!id) throw new S3Error('The server did not start the multipart upload.', { code: 'NoUploadId' });
    return id;
  }

  async uploadPart(bucket, key, uploadId, partNumber, buf, signal) {
    const r = await this.request({ method: 'PUT', bucket, key, query: { partNumber: String(partNumber), uploadId }, body: buf, headers: { 'content-md5': md5b64(buf) }, signal });
    return String(r.headers.etag || '').replace(/"/g, '');
  }

  async listParts(bucket, key, uploadId) {
    const parts = [];
    let marker;
    for (;;) {
      const query = { uploadId };
      if (marker) query['part-number-marker'] = marker;
      const doc = await this.xmlRequest({ method: 'GET', bucket, key, query });
      for (const p of xml.children(doc, 'Part')) parts.push({ partNumber: Number(xml.textOf(p, 'PartNumber')), etag: xml.textOf(p, 'ETag').replace(/"/g, ''), size: Number(xml.textOf(p, 'Size', '0')) });
      if (xml.textOf(doc, 'IsTruncated') !== 'true') break;
      marker = xml.textOf(doc, 'NextPartNumberMarker');
      if (!marker) break;
    }
    return parts;
  }

  async completeMultipart(bucket, key, uploadId, parts) {
    const sorted = parts.slice().sort((a, b) => a.partNumber - b.partNumber);
    const body = '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + sorted.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${xml.escapeXml(p.etag)}"</ETag></Part>`).join('')
      + '</CompleteMultipartUpload>';
    const r = await this.request({ method: 'POST', bucket, key, query: { uploadId }, body, headers: { 'content-type': 'application/xml' }, noRetry: false });
    const text = r.body ? r.body.toString('utf8') : '';
    const doc = text ? xml.parse(text) : null;
    if (doc && doc.name === 'Error') throw new S3Error(xml.textOf(doc, 'Message') || 'Could not complete the upload', { code: xml.textOf(doc, 'Code'), status: 200 });
    return { etag: doc ? xml.textOf(doc, 'ETag').replace(/"/g, '') : '' };
  }

  async abortMultipart(bucket, key, uploadId) {
    await this.request({ method: 'DELETE', bucket, key, query: { uploadId }, okStatus: [200, 204, 404] });
  }

  async listMultipartUploads(bucket, prefix = '') {
    const query = { uploads: '', 'encoding-type': 'url' };
    if (prefix) query.prefix = prefix;
    const doc = await this.xmlRequest({ method: 'GET', bucket, query });
    const enc = xml.textOf(doc, 'EncodingType') === 'url';
    return xml.children(doc, 'Upload').map((u) => ({ key: enc ? decodeKey(xml.textOf(u, 'Key')) : xml.textOf(u, 'Key'), uploadId: xml.textOf(u, 'UploadId'), initiated: xml.textOf(u, 'Initiated') }));
  }

  // ---------- tags ----------
  async getObjectTagging(bucket, key, versionId) {
    const query = { tagging: '' };
    if (versionId) query.versionId = versionId;
    const doc = await this.xmlRequest({ method: 'GET', bucket, key, query });
    const set = xml.child(doc, 'TagSet');
    return xml.children(set, 'Tag').map((t) => ({ key: xml.textOf(t, 'Key'), value: xml.textOf(t, 'Value') }));
  }

  async putObjectTagging(bucket, key, tags) {
    const body = '<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>'
      + tags.map((t) => `<Tag><Key>${xml.escapeXml(t.key)}</Key><Value>${xml.escapeXml(t.value)}</Value></Tag>`).join('')
      + '</TagSet></Tagging>';
    const buf = Buffer.from(body, 'utf8');
    await this.request({ method: 'PUT', bucket, key, query: { tagging: '' }, body: buf, headers: { 'content-md5': md5b64(buf) } });
  }

  // ---------- presign ----------
  async presign(method, bucket, key, expires, { versionId } = {}) {
    const creds = await this.creds();
    const t = this.target(bucket, key);
    return presign({ method, protocol: this.protocol, host: t.host, path: t.path, query: versionId ? { versionId } : undefined, creds, region: t.region, expires });
  }
}

function headInfo(h) {
  const metadata = {};
  for (const [k, v] of Object.entries(h)) if (k.startsWith('x-amz-meta-')) metadata[k.slice(11)] = v;
  return {
    size: Number(h['content-length'] || 0),
    totalSize: h['content-range'] ? Number(String(h['content-range']).split('/')[1]) : Number(h['content-length'] || 0),
    contentType: h['content-type'] || '',
    etag: String(h.etag || '').replace(/"/g, ''),
    lastModified: h['last-modified'] || '',
    storageClass: h['x-amz-storage-class'] || 'STANDARD',
    versionId: h['x-amz-version-id'] || '',
    cacheControl: h['cache-control'] || '',
    contentEncoding: h['content-encoding'] || '',
    contentDisposition: h['content-disposition'] || '',
    serverSideEncryption: h['x-amz-server-side-encryption'] || '',
    restore: h['x-amz-restore'] || '',
    tagCount: h['x-amz-tagging-count'] ? Number(h['x-amz-tagging-count']) : undefined,
    metadata,
  };
}

function errorFromResponse(status, headers, buf, method, host) {
  let code = '', message = '', region = headers['x-amz-bucket-region'] || '', requestId = headers['x-amz-request-id'] || '';
  const text = buf.toString('utf8');
  if (text.trim().startsWith('<')) {
    try {
      const d = xml.parse(text);
      code = xml.textOf(d, 'Code');
      message = xml.textOf(d, 'Message');
      region = region || xml.textOf(d, 'Region');
      requestId = requestId || xml.textOf(d, 'RequestId');
    } catch (e) { /* not XML */ }
  }
  if (!code) code = { 301: 'PermanentRedirect', 307: 'TemporaryRedirect', 400: 'BadRequest', 403: 'AccessDenied', 404: method === 'HEAD' ? 'NotFound' : 'NoSuchKey', 409: 'Conflict', 412: 'PreconditionFailed', 416: 'InvalidRange', 429: 'SlowDown', 500: 'InternalError', 503: 'ServiceUnavailable' }[status] || `HTTP${status}`;
  // A region hint only counts for redirects and for "wrong region" signing errors.
  const regionHint = (status === 301 || status === 307 || code === 'AuthorizationHeaderMalformed' || code === 'IllegalLocationConstraintException' || (status === 400 && region)) ? region : '';
  return new S3Error(message || `${code} (HTTP ${status})`, { code, status, region: regionHint, requestId, host });
}

function networkMessage(e, host) {
  const c = e && e.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return `Cannot find the host ${host}. Check the endpoint and your network.`;
  if (c === 'ECONNREFUSED') return `${host} refused the connection. Is the server running on that port?`;
  if (c === 'ECONNRESET') return `${host} closed the connection.`;
  if (c && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(c)) return `The TLS certificate of ${host} is not trusted (${c}). For a self-hosted server you can allow it in the connection settings.`;
  return `${(e && e.message) || 'Network error'} (${host})`;
}

module.exports = { S3Client, S3Error, dnsCompatible, decodeKey, headInfo, errorFromResponse, md5b64, UNSIGNED };
