// Real VS Code driver over CDP (copied from the wave 8 SMV release check). Launches VS Code with an isolated
// --user-data-dir and --extensions-dir, installs a .vsix, opens files, and drives the custom-editor webview.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
export const CLI = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function installVsix(work, vsix) {
  const ud = path.join(work, 'ud'), ext = path.join(work, 'ext');
  fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
  const r = spawnSync(CLI, ['--user-data-dir', ud, '--extensions-dir', ext, '--install-extension', vsix, '--force'], { encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

export async function launch(work, port, folder, settings = {}, env = process.env) {
  const ud = path.join(work, 'ud'), ext = path.join(work, 'ext');
  fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
  fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
    'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true,
    'window.zoomLevel': 0, 'workbench.colorTheme': 'Default Dark Modern', 'window.commandCenter': false, 'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false, 'workbench.tips.enabled': false, 'security.workspace.trust.enabled': false,
    'window.restoreWindows': 'none', 'workbench.enableExperiments': false, 'git.enabled': false, ...settings }, null, 1));
  const child = spawn(CODE, [`--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--user-data-dir', ud, '--extensions-dir', ext, '--skip-welcome',
    '--disable-workspace-trust', '--new-window', folder], { stdio: 'ignore', detached: false, env });
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = list.find(t => t.type === 'page' && t.url.includes('workbench')); } catch {}
  }
  if (!page) throw new Error('workbench page not found');
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const s = await Session.connect(ver.webSocketDebuggerUrl);
  const vs = new VSC(s, child, work, ud, ext, port);
  await vs.attachWorkbench();
  return vs;
}

class Session {
  static async connect(url) {
    const s = new Session(); s.ws = new WebSocket(url); s.id = 0; s.pend = new Map(); s.handlers = [];
    s.ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && s.pend.has(m.id)) { s.pend.get(m.id)(m); s.pend.delete(m.id); } else if (m.method) for (const h of s.handlers) h(m); };
    await new Promise((r, j) => { s.ws.onopen = r; s.ws.onerror = j; });
    return s;
  }
  send(method, params = {}, sessionId) {
    return new Promise((r, j) => { const i = ++this.id; const t = setTimeout(() => { this.pend.delete(i); j(new Error('timeout ' + method)); }, 30000);
      this.pend.set(i, m => { clearTimeout(t); m.error ? j(new Error(method + ': ' + JSON.stringify(m.error))) : r(m.result); });
      this.ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  on(h) { this.handlers.push(h); }
  close() { try { this.ws.close(); } catch {} }
}

export class VSC {
  constructor(s, child, work, ud, ext, port) {
    Object.assign(this, { s, child, work, ud, ext, port }); this.console = []; this.ctx = new Map(); this.attached = new Map();
    s.on(m => {
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type))
        this.console.push({ where: this.attached.get(m.sessionId)?.url?.slice(0, 80) || 'workbench', type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 600) });
      if (m.method === 'Runtime.exceptionThrown')
        this.console.push({ where: this.attached.get(m.sessionId)?.url?.slice(0, 80) || 'workbench', type: 'exception', text: (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 600) });
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
        this.console.push({ where: this.attached.get(m.sessionId)?.url?.slice(0, 80) || 'workbench', type: 'log', text: (m.params.entry.text + ' ' + (m.params.entry.url || '')).slice(0, 600) });
      if (m.method === 'Runtime.executionContextCreated') {
        const c = m.params.context; const k = m.sessionId || ''; if (!this.ctx.has(k)) this.ctx.set(k, []);
        this.ctx.get(k).push(c);
      }
      if (m.method === 'Runtime.executionContextDestroyed') {
        const k = m.sessionId || ''; this.ctx.set(k, (this.ctx.get(k) || []).filter(c => c.id !== m.params.executionContextId));
      }
      if (m.method === 'Runtime.executionContextsCleared') this.ctx.set(m.sessionId || '', []);
      if (m.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = m.params; this.attached.set(sessionId, targetInfo);
        this.s.send('Runtime.enable', {}, sessionId).catch(() => {}); this.s.send('Log.enable', {}, sessionId).catch(() => {});
        this.s.send('Page.enable', {}, sessionId).catch(() => {});
        this.s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
        this.s.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      }
      if (m.method === 'Target.detachedFromTarget') { this.attached.delete(m.params.sessionId); this.ctx.delete(m.params.sessionId); }
    });
  }
  async attachWorkbench() {
    const { targetInfos } = await this.s.send('Target.getTargets');
    const page = targetInfos.find(t => t.type === 'page' && t.url.includes('workbench'));
    const { sessionId } = await this.s.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.wb = sessionId; this.attached.set(sessionId, page);
    await this.s.send('Runtime.enable', {}, sessionId); await this.s.send('Log.enable', {}, sessionId); await this.s.send('Page.enable', {}, sessionId);
    await this.s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    await this.s.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId).catch(() => {});
  }
  // evaluate in workbench
  async wbEval(expr) {
    const r = await this.s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, this.wb);
    if (r.exceptionDetails) throw new Error('wbEval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value;
  }
  // Find the content frame of the visible webview: returns {sessionId, contextId}
  async webview() {
    for (const [sid, info] of this.attached) {
      if (sid === this.wb || info.type !== 'iframe') continue;
      const ctxs = this.ctx.get(sid) || [];
      for (const c of ctxs) {
        if (!c.auxData?.isDefault) continue;
        try {
          const r = await this.s.send('Runtime.evaluate', { expression: `location.pathname + '|' + document.visibilityState + '|' + !!document.getElementById('app') + '|' + (window.frameElement ? 1 : 0)`, contextId: c.id, returnByValue: true }, sid);
          const v = String(r.result.value);
          if (v.includes('fake.html') || v.split('|')[2] === 'true') {
            // the content frame. check it is visible (its index.html iframe visible in workbench)
            const vis = await this.s.send('Runtime.evaluate', { expression: `document.hasFocus() + '|' + (document.body ? document.body.getBoundingClientRect().width : 0) + '|' + document.title`, contextId: c.id, returnByValue: true }, sid);
            const [, w, title] = String(vis.result.value).split('|');
            if (Number(w) > 0) return { sid, cid: c.id, url: info.url, title };
          }
        } catch {}
      }
    }
    return null;
  }
  async webviews() {
    const out = [];
    for (const [sid, info] of this.attached) {
      if (sid === this.wb || info.type !== 'iframe') continue;
      for (const c of this.ctx.get(sid) || []) {
        if (!c.auxData?.isDefault) continue;
        try { const r = await this.s.send('Runtime.evaluate', { expression: `JSON.stringify({p: location.pathname, app: !!(document.getElementById('app') || document.getElementById('list')), w: document.body ? document.body.getBoundingClientRect().width : 0, title: document.title})`, contextId: c.id, returnByValue: true }, sid);
          const v = JSON.parse(r.result.value); if (v.app) out.push({ sid, cid: c.id, ...v }); } catch {}
      }
    }
    return out;
  }
  async wvEval(wv, expr) {
    const r = await this.s.send('Runtime.evaluate', { expression: expr, contextId: wv.cid, returnByValue: true, awaitPromise: true }, wv.sid);
    if (r.exceptionDetails) throw new Error('wvEval: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 400)); return r.result.value;
  }
  // absolute offset of the visible webview content in the workbench viewport
  async wvOffset() {
    return JSON.parse(await this.wbEval(`(() => { const fs = [...document.querySelectorAll('iframe.webview')].filter(f => f.getBoundingClientRect().width > 0 && getComputedStyle(f.parentElement).visibility !== 'hidden' && f.parentElement.style.display !== 'none');
      const f = fs[fs.length - 1]; if (!f) return 'null'; const b = f.getBoundingClientRect(); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, n: fs.length }); })()`));
  }
  async click(x, y, { count = 1, button = 'left', modifiers = 0 } = {}) {
    await this.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, this.wb);
    for (let k = 1; k <= count; k++) {
      await this.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: k, modifiers }, this.wb);
      await this.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: k, modifiers }, this.wb);
    }
    await sleep(150);
  }
  // click an element inside the webview by JS expression returning the element
  async wvClick(wv, elExpr, opts = {}) {
    const off = await this.wvOffset();
    const b = JSON.parse(await this.wvEval(wv, `(() => { const e = (${elExpr}); if (!e) return 'null'; e.scrollIntoView && e.scrollIntoView({block: 'nearest', inline: 'nearest'}); const b = e.getBoundingClientRect(); return JSON.stringify({ x: b.x + Math.min(${opts.dx ?? 'b.width / 2'}, b.width - 1), y: b.y + b.height / 2 }); })()`));
    if (!b) throw new Error('wvClick: element not found: ' + elExpr);
    await this.click(off.x + b.x, off.y + b.y, opts);
  }
  async type(text) { await this.s.send('Input.insertText', { text }, this.wb); await sleep(100); }
  async key(key, code, modifiers = 0, keyCode) {
    const vk = keyCode ?? ({ Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, PageDown: 34, End: 35, Home: 36 }[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0));
    await this.s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, this.wb);
    if (key.length === 1 && !(modifiers & 6)) await this.s.send('Input.dispatchKeyEvent', { type: 'char', key, text: key, modifiers }, this.wb);
    await this.s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, this.wb);
    await sleep(80);
  }
  async shot(file) {
    await this.s.send('Page.bringToFront', {}, this.wb).catch(() => {});
    await this.s.send('Emulation.setFocusEmulationEnabled', { enabled: true }, this.wb).catch(() => {});
    await sleep(500);
    let r;
    for (let i = 0; i < 3 && !r; i++) { try { r = await this.s.send('Page.captureScreenshot', { format: 'png' }, this.wb); } catch (e) { if (i === 2) throw e; await this.s.send('Page.bringToFront', {}, this.wb).catch(() => {}); } }
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file;
  }
  open(file) { spawn(CLI, ['--user-data-dir', this.ud, '--extensions-dir', this.ext, '--reuse-window', file], { stdio: 'ignore' }); }
  // run a workbench command via the command palette
  async command(label) {
    const open = () => this.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.offsetParent !== null && document.activeElement && w.contains(document.activeElement)); })()`);
    for (let i = 0; i < 3; i++) {
      // focus the workbench (not a webview iframe) so the keybinding reaches it
      await this.wbEval(`(document.querySelector('.part.statusbar') || document.body).focus && 1`);
      if (i === 0) await this.key('p', 'KeyP', 4 | 8, 80); else await this.key('F1', 'F1', 0, 112); // Cmd+Shift+P, then F1
      if (await this.waitFor(open, 2000, 100)) break;
      if (i === 2) throw new Error('command palette did not open for ' + label);
    }
    await this.type('>' === label[0] ? label.slice(1) : label); await sleep(700); await this.key('Enter', 'Enter'); await sleep(800);
  }
  async notifications() {
    return this.wbEval(`[...document.querySelectorAll('.notifications-toasts .notification-list-item, .notifications-center .notification-list-item')].map(n => n.textContent.trim().slice(0, 300))`);
  }
  async waitFor(fn, ms = 20000, step = 200) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return null; }
  extHostLogs() {
    const out = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/exthost\.log$|renderer\.log$|main\.log$|\.log$/.test(e.name)) out.push(p); } };
    try { walk(path.join(this.ud, 'logs')); } catch {}
    return out;
  }
  async close() {
    try { this.s.close(); } catch {}
    try { this.child.kill('SIGTERM'); } catch {}
    await sleep(2500);
    spawnSync('pkill', ['-f', this.ud]);
    await sleep(1000);
    spawnSync('pkill', ['-9', '-f', this.ud]);
  }
}

// Attach to a VS Code that was started with --remote-debugging-port (no launch).
export async function attach(port) {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = list.find(t => t.type === 'page' && t.url.includes('workbench')); } catch {}
  }
  if (!page) throw new Error('workbench page not found');
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const s = await Session.connect(ver.webSocketDebuggerUrl);
  const vs = new VSC(s, null, '', '', '', port);
  await vs.attachWorkbench();
  return vs;
}
