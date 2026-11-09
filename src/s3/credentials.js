'use strict';
// AWS shared config and credentials files. Rules:
// - Listing profiles reads only the section names, never a key.
// - A profile's keys are read only when the user connects with that profile (the "default" profile too: it is
//   never picked automatically, and AWS_PROFILE / AWS_ACCESS_KEY_ID in the environment are ignored unless the user
//   adds an "Environment variables" connection).
// - SSO profiles reuse the token the AWS CLI already saved (aws sso login); no browser callback here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const { sign } = require('./sigv4');
const xml = require('./xml');

class CredentialError extends Error {
  constructor(message, props) { super(message); this.name = 'CredentialError'; Object.assign(this, props || {}); }
}

function home(env) { return (env && env.HOME) || os.homedir(); }
function configPath(env = process.env) { return env.AWS_CONFIG_FILE || path.join(home(env), '.aws', 'config'); }
function credentialsPath(env = process.env) { return env.AWS_SHARED_CREDENTIALS_FILE || path.join(home(env), '.aws', 'credentials'); }

/** INI parser for AWS files. Returns { sectionName: { key: value } }. Nested (indented) values are joined. */
function parseIni(text) {
  const out = {};
  let cur = null;
  let lastKey = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\s*[#;]/.test(raw) || !raw.trim()) continue;
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (sec) { cur = out[sec[1].trim()] = out[sec[1].trim()] || {}; lastKey = null; continue; }
    if (!cur) continue;
    if (/^\s+/.test(raw) && lastKey && !raw.includes('=')) { cur[lastKey] += '\n' + raw.trim(); continue; }
    const kv = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(raw);
    if (kv) {
      if (/^\s+/.test(raw) && lastKey && cur[lastKey] === '') { cur[lastKey + '.' + kv[1].trim()] = kv[2].trim(); continue; }
      lastKey = kv[1].trim();
      cur[lastKey] = kv[2].replace(/\s+[#;].*$/, '').trim();
    }
  }
  return out;
}

function readIni(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return {};
    return parseIni(fs.readFileSync(file, 'utf8'));
  } catch (e) { return {}; }
}

/** Names of the profiles in both files (section names only; no key is read into memory beyond the parse). */
function listProfiles(env = process.env) {
  const names = new Set();
  const cfg = readIni(configPath(env));
  for (const s of Object.keys(cfg)) {
    if (s === 'default') names.add('default');
    else if (s.startsWith('profile ')) names.add(s.slice(8).trim());
  }
  for (const s of Object.keys(readIni(credentialsPath(env)))) names.add(s.trim());
  return [...names].sort((a, b) => (a === 'default' ? 1 : b === 'default' ? -1 : a.localeCompare(b)));
}

/** The merged settings of one profile (config file first, credentials file wins for keys). */
function profileSettings(name, env = process.env) {
  const cfg = readIni(configPath(env));
  const creds = readIni(credentialsPath(env));
  const fromCfg = cfg[name === 'default' ? 'default' : `profile ${name}`] || (name === 'default' ? {} : cfg[name]) || {};
  const merged = Object.assign({}, fromCfg, creds[name] || {});
  if (merged.sso_session) {
    const s = cfg[`sso-session ${merged.sso_session}`] || {};
    merged._ssoSession = s;
  }
  // services sections can set endpoint_url for s3
  if (merged.services) {
    const s = cfg[`services ${merged.services}`] || {};
    if (s['s3.endpoint_url']) merged.s3_endpoint_url = s['s3.endpoint_url'];
  }
  return { exists: !!(cfg[name === 'default' ? 'default' : `profile ${name}`] || creds[name]), settings: merged };
}

/** What a profile needs, for display: 'keys', 'sso', 'process', 'role', 'web-identity' or 'unknown'. */
function profileKind(s) {
  if (s.role_arn && (s.source_profile || s.credential_source)) return 'role';
  if (s.role_arn && s.web_identity_token_file) return 'web-identity';
  if (s.sso_session || s.sso_start_url) return 'sso';
  if (s.credential_process) return 'process';
  if (s.aws_access_key_id) return 'keys';
  return 'unknown';
}

function httpsJson(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, body, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function httpsPost(url, headers, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function ssoCacheFile(s, env) {
  const keyName = s.sso_session ? s.sso_session : (s.sso_start_url || '');
  const hash = crypto.createHash('sha1').update(keyName).digest('hex');
  return path.join(home(env), '.aws', 'sso', 'cache', `${hash}.json`);
}

async function ssoCredentials(name, s, env, deps) {
  const sess = s._ssoSession || {};
  const region = sess.sso_region || s.sso_region;
  const accountId = s.sso_account_id;
  const role = s.sso_role_name;
  if (!region || !accountId || !role) throw new CredentialError(`Profile "${name}" uses SSO but lacks sso_region, sso_account_id or sso_role_name.`, { code: 'SsoConfig', profile: name });
  let token;
  try { token = JSON.parse(fs.readFileSync(ssoCacheFile(s, env), 'utf8')); } catch (e) { token = null; }
  const expired = !token || !token.accessToken || (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now() + 60000);
  if (expired) throw new CredentialError(`The SSO sign-in for profile "${name}" has ended. Run "aws sso login --profile ${name}" in a terminal, then connect again.`, { code: 'SsoLogin', profile: name, loginCommand: `aws sso login --profile ${name}` });
  const url = `https://portal.sso.${region}.amazonaws.com/federation/credentials?account_id=${encodeURIComponent(accountId)}&role_name=${encodeURIComponent(role)}`;
  const r = await (deps.httpsJson || httpsJson)(url, { 'x-amz-sso_bearer_token': token.accessToken });
  if (r.status === 401 || r.status === 403) throw new CredentialError(`AWS SSO refused the saved sign-in for "${name}". Run "aws sso login --profile ${name}" and connect again.`, { code: 'SsoLogin', profile: name, loginCommand: `aws sso login --profile ${name}` });
  const rc = r.body && r.body.roleCredentials;
  if (!rc) throw new CredentialError(`AWS SSO gave no credentials for "${name}" (HTTP ${r.status}).`, { code: 'SsoFailed' });
  return { accessKeyId: rc.accessKeyId, secretAccessKey: rc.secretAccessKey, sessionToken: rc.sessionToken, expiration: new Date(rc.expiration).toISOString() };
}

function processCredentials(name, cmd, deps) {
  return new Promise((resolve, reject) => {
    const run = deps.execFile || execFile;
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
    run(shell, args, { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) { reject(new CredentialError(`credential_process of profile "${name}" failed: ${String(err.message).split('\n')[0]}`, { code: 'ProcessFailed' })); return; }
      try {
        const j = JSON.parse(String(stdout));
        if (!j.AccessKeyId || !j.SecretAccessKey) throw new Error('missing keys');
        resolve({ accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.SessionToken, expiration: j.Expiration });
      } catch (e) {
        reject(new CredentialError(`credential_process of profile "${name}" did not print the expected JSON.`, { code: 'ProcessFailed' }));
      }
    });
  });
}

async function assumeRole(name, s, source, deps) {
  const region = s.region || 'us-east-1';
  const host = s.sts_regional_endpoints === 'legacy' ? 'sts.amazonaws.com' : `sts.${region}.amazonaws.com`;
  const params = new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: s.role_arn, RoleSessionName: s.role_session_name || `zovo-s3-${Date.now()}`, DurationSeconds: s.duration_seconds || '3600' });
  if (s.external_id) params.set('ExternalId', s.external_id);
  if (s.mfa_serial) {
    const code = deps.askMfa ? await deps.askMfa(name, s.mfa_serial) : undefined;
    if (!code) throw new CredentialError(`Profile "${name}" needs an MFA code.`, { code: 'MfaCancelled' });
    params.set('SerialNumber', s.mfa_serial);
    params.set('TokenCode', code);
  }
  const body = params.toString();
  const { sha256hex } = require('./sigv4');
  const headers = sign({ method: 'POST', host, path: '/', query: {}, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, payloadHash: sha256hex(body), creds: source, region, service: 'sts' });
  headers['content-length'] = String(Buffer.byteLength(body));
  const r = await (deps.httpsPost || httpsPost)(`https://${host}/`, headers, body);
  let doc;
  try { doc = xml.parse(r.text); } catch (e) { doc = null; }
  if (r.status !== 200 || !doc) throw new CredentialError(`AssumeRole for profile "${name}" failed: ${(doc && xml.textOf(xml.child(doc, 'Error'), 'Message')) || 'HTTP ' + r.status}`, { code: 'AssumeRoleFailed' });
  const c = xml.child(xml.child(doc, 'AssumeRoleResult'), 'Credentials');
  return { accessKeyId: xml.textOf(c, 'AccessKeyId'), secretAccessKey: xml.textOf(c, 'SecretAccessKey'), sessionToken: xml.textOf(c, 'SessionToken'), expiration: xml.textOf(c, 'Expiration') };
}

/**
 * Credentials for a profile the user picked. deps: { env, askMfa, httpsJson, httpsPost, execFile }.
 * Returns { accessKeyId, secretAccessKey, sessionToken?, expiration? }.
 */
async function resolveProfile(name, deps = {}, depth = 0) {
  const env = deps.env || process.env;
  if (depth > 4) throw new CredentialError('The source_profile chain is too long or loops.', { code: 'RoleLoop' });
  const { exists, settings: s } = profileSettings(name, env);
  if (!exists) throw new CredentialError(`Profile "${name}" is not in ${configPath(env)} or ${credentialsPath(env)}.`, { code: 'NoProfile', profile: name });
  const kind = profileKind(s);
  if (kind === 'role') {
    let source;
    if (s.source_profile) source = await resolveProfile(s.source_profile, deps, depth + 1);
    else if (s.credential_source === 'Environment') source = envCredentials(env);
    else throw new CredentialError(`Profile "${name}" uses credential_source ${s.credential_source}, which works only on AWS compute.`, { code: 'Unsupported' });
    return assumeRole(name, s, source, deps);
  }
  if (kind === 'sso') return ssoCredentials(name, s, env, deps);
  if (kind === 'process') return processCredentials(name, s.credential_process, deps);
  if (kind === 'keys') return { accessKeyId: s.aws_access_key_id, secretAccessKey: s.aws_secret_access_key, sessionToken: s.aws_session_token || undefined };
  if (kind === 'web-identity') throw new CredentialError(`Profile "${name}" uses web identity, which is not supported yet.`, { code: 'Unsupported' });
  throw new CredentialError(`Profile "${name}" has no keys, SSO or credential_process.`, { code: 'NoKeys', profile: name });
}

/** Region and endpoint of a profile (read when the user picks it). */
function profileRegion(name, env = process.env) {
  const { settings: s } = profileSettings(name, env);
  return { region: s.region || '', endpoint: s.s3_endpoint_url || s.endpoint_url || '', kind: profileKind(s) };
}

function envCredentials(env = process.env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new CredentialError('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set in the environment of VS Code.', { code: 'NoEnv' });
  return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined };
}

module.exports = { parseIni, listProfiles, profileSettings, profileKind, resolveProfile, profileRegion, envCredentials, configPath, credentialsPath, ssoCacheFile, CredentialError };
