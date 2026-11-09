'use strict';
// Maps object keys to local paths without ever leaving the chosen folder. A key like "../../.ssh/config",
// "/etc/passwd", "C:\\x" or "a/../../b" is refused (or, for odd characters, made safe), and the final path is
// checked against the target folder after resolving.
const path = require('path');

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Local relative path for a key, relative to a base prefix. Returns { rel } or { error }.
 * platform: 'win32' makes Windows-unsafe characters safe too (default: process.platform).
 */
function keyToRelative(key, basePrefix = '', platform = process.platform) {
  if (typeof key !== 'string' || !key) return { error: 'empty key' };
  let k = key;
  if (basePrefix && k.startsWith(basePrefix)) k = k.slice(basePrefix.length);
  if (!k || k.endsWith('/')) return { error: 'folder marker' };
  if (k.includes('\0')) return { error: 'key contains a NUL character' };
  // Backslashes count as separators too, so "..\\x" cannot climb on Windows.
  const parts = k.split(/[\\/]+/).filter((p) => p !== '');
  if (!parts.length) return { error: 'empty path' };
  const out = [];
  for (let p of parts) {
    if (p === '.' || p === '..') return { error: `key has a "${p}" segment` };
    if (/^[a-zA-Z]:$/.test(p) && out.length === 0) return { error: 'key starts with a drive letter' };
    p = p.replace(/[\x00-\x1f]/g, '_');
    if (platform === 'win32') {
      p = p.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
      if (WIN_RESERVED.test(p)) p = '_' + p;
    }
    if (Buffer.byteLength(p) > 255) return { error: 'a path segment is longer than 255 bytes' };
    out.push(p);
  }
  return { rel: out.join(path.sep) };
}

/** Absolute local path for a key under root, or { error }. Checked after path.resolve. */
function safeLocalPath(root, key, basePrefix = '', platform = process.platform) {
  const r = keyToRelative(key, basePrefix, platform);
  if (r.error) return r;
  const absRoot = path.resolve(root);
  const full = path.resolve(absRoot, r.rel);
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (!full.startsWith(rootWithSep)) return { error: 'path would leave the target folder' };
  return { path: full };
}

/** Object key for a local file under root, uploaded to prefix. Always uses "/". */
function localToKey(root, file, prefix = '') {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return null;
  const p = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
  return p + rel;
}

/** Last segment of a key, for titles. */
function baseName(key) {
  const k = key.endsWith('/') ? key.slice(0, -1) : key;
  return k.slice(k.lastIndexOf('/') + 1) || k;
}

/** Parent prefix of a key ("a/b/c.txt" -> "a/b/", "a/" -> ""). */
function parentPrefix(key) {
  const k = key.endsWith('/') ? key.slice(0, -1) : key;
  const i = k.lastIndexOf('/');
  return i < 0 ? '' : k.slice(0, i + 1);
}

module.exports = { keyToRelative, safeLocalPath, localToKey, baseName, parentPrefix };
