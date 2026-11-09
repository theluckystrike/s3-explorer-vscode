'use strict';
// Plain-language errors and the one confirmation dialog every delete and overwrite goes through.
const MAX_LISTED = 15;

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u[i]}`;
}

function fmtCount(n) { return Number(n).toLocaleString('en-US'); }

/** "s3://bucket/a", "s3://bucket/b", ... "and 12 more" for a confirmation detail. */
function keyList(bucket, keys, max = MAX_LISTED) {
  const shown = keys.slice(0, max).map((k) => `s3://${bucket}/${k}`);
  if (keys.length > max) shown.push(`... and ${fmtCount(keys.length - max)} more`);
  return shown.join('\n');
}

/** { message, actions: [label] } for an error, with what to do next. */
function describeError(e, conn) {
  const where = conn ? `"${conn.name}"` : 'the server';
  const code = (e && e.code) || '';
  const msg = (e && e.message) || String(e);
  switch (code) {
    case 'InvalidAccessKeyId': return { message: `${where} does not know this access key ID. Check the key, or the endpoint if the key belongs to another service.`, actions: ['Edit Connection'] };
    case 'SignatureDoesNotMatch': return { message: `The secret key does not match the access key for ${where}.`, actions: ['Edit Connection'] };
    case 'AccessDenied': case 'AllAccessDisabled': return { message: `Access denied by ${where}. The key may lack permission for this bucket or action (for example s3:ListBucket or s3:GetObject).`, actions: [] };
    case 'ExpiredToken': case 'TokenRefreshRequired': return { message: `The temporary credentials of ${where} have expired. Connect again.`, actions: ['Reconnect'] };
    case 'NoSuchBucket': return { message: `The bucket does not exist on ${where}.`, actions: [] };
    case 'NoSuchKey': case 'NotFound': return { message: 'The object does not exist (it may have been deleted).', actions: ['Refresh'] };
    case 'SsoLogin': return { message: msg, actions: ['Run aws sso login'] };
    case 'Timeout': return { message: `${msg} Check the endpoint, VPN or proxy.`, actions: ['Edit Connection'] };
    case 'ECONNREFUSED': case 'ENOTFOUND': case 'EAI_AGAIN': return { message: msg, actions: ['Edit Connection'] };
    case 'SlowDown': return { message: `${where} asked to slow down (SlowDown). Try again in a moment.`, actions: [] };
    case 'Aborted': return { message: 'Cancelled.', actions: [] };
    default: return { message: msg.length > 400 ? msg.slice(0, 400) + '...' : msg, actions: [] };
  }
}

/**
 * The confirmation used for every delete and overwrite: a modal that names the bucket and lists the keys.
 * Returns true only when the user chose the button. A test hook can replace `impl` to record and answer.
 */
const confirm = {
  impl: null,
  log: [],
  async ask(vscode, message, detail, button) {
    this.log.push({ message, detail, button, at: Date.now() });
    if (this.log.length > 200) this.log.shift();
    if (this.impl) return !!(await this.impl({ message, detail, button }));
    const r = await vscode.window.showWarningMessage(message, { modal: true, detail }, button);
    return r === button;
  },
};

module.exports = { fmtBytes, fmtCount, keyList, describeError, confirm, MAX_LISTED };
