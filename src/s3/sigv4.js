'use strict';
// AWS Signature Version 4 for S3 and STS: request headers and presigned URLs. Pure functions, no VS Code.
const crypto = require('crypto');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UNSIGNED = 'UNSIGNED-PAYLOAD';

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as S3 wants it. slash=false keeps '/' (for paths). */
function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(ch);
    if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39) || c === '-' || c === '_' || c === '.' || c === '~') out += c;
    else if (c === '/' && !encodeSlash) out += c;
    else out += '%' + ch.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function amzDate(d) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, day: iso.slice(0, 8) };
}

function signingKey(secret, day, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
}

/** Canonical query string from an object or array of [k, v] pairs. */
function canonicalQuery(query) {
  const pairs = Array.isArray(query) ? query : Object.entries(query || {});
  return pairs
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Signs a request. Returns the headers to send (includes host, x-amz-date, x-amz-content-sha256, authorization).
 * opts: { method, host, path (already encoded), query, headers, payloadHash, creds:{accessKeyId, secretAccessKey, sessionToken}, region, service, now }
 */
function sign(opts) {
  const { method, host, path, query, creds, region, service = 's3' } = opts;
  const now = opts.now || new Date();
  const { amz, day } = amzDate(now);
  const payloadHash = opts.payloadHash || EMPTY_SHA256;
  const headers = {};
  for (const [k, v] of Object.entries(opts.headers || {})) if (v !== undefined && v !== null) headers[k.toLowerCase()] = String(v);
  headers.host = host;
  headers['x-amz-date'] = amz;
  if (service === 's3') headers['x-amz-content-sha256'] = payloadHash;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const creq = [method, path, canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(creq)].join('\n');
  const sig = hmac(signingKey(creds.secretAccessKey, day, region, service), sts).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return headers;
}

/**
 * Presigned URL (query auth). expires in seconds, 1 to 604800 (7 days).
 * opts: { method, protocol, host, path, query, creds, region, expires, now }
 */
function presign(opts) {
  const { method, host, path, creds, region } = opts;
  const expires = Math.max(1, Math.min(604800, Math.floor(opts.expires || 3600)));
  const now = opts.now || new Date();
  const { amz, day } = amzDate(now);
  const scope = `${day}/${region}/s3/aws4_request`;
  const q = Object.assign({}, opts.query || {}, {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  });
  if (creds.sessionToken) q['X-Amz-Security-Token'] = creds.sessionToken;
  const cq = canonicalQuery(q);
  const creq = [method, path, cq, `host:${host}\n`, 'host', UNSIGNED].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(creq)].join('\n');
  const sig = hmac(signingKey(creds.secretAccessKey, day, region, 's3'), sts).toString('hex');
  return `${opts.protocol || 'https:'}//${host}${path}?${cq}&X-Amz-Signature=${sig}`;
}

module.exports = { sign, presign, uriEncode, canonicalQuery, sha256hex, EMPTY_SHA256, UNSIGNED, amzDate, signingKey };
