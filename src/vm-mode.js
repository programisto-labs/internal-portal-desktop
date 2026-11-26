'use strict';

/**
 * Lasco Desktop inside the Lasco computer (a VM): `--vm` or `LASCO_DESKTOP_VM=1`. See docs/vm-mode.md.
 *
 * - Never loads the portal: no Lasco session in the VM. Commands run there (agent, prompt injection) could
 *   otherwise read it. The window shows Desktop's own browser shell (`src/vm-shell/`), web tabs only.
 * - Implies `--no-agents`: no host operation, Lasco Code or harness. The VM never reaches another computer.
 * - Settings are forced (`VM_FORCED_SETTINGS`): nothing to configure, nothing that leaves the VM by itself.
 * - Local control endpoint (127.0.0.1, token): the browser daemon of the VM opens a URL in a web tab and learns
 *   the CDP target of that tab, so it drives the page, never Desktop's own shell.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const VM_ARG = '--vm';
const VM_ENV = 'LASCO_DESKTOP_VM';
const VM_USER_AGENT_TOKEN = 'LascoVm/1';
const VM_CONTROL_HOST = '127.0.0.1';
const VM_CONTROL_DEFAULT_PORT = 9334;
const VM_CONTROL_MAX_BODY = 16 * 1024;

function isVmMode(argv = process.argv, env = process.env) {
  return (Array.isArray(argv) && argv.includes(VM_ARG)) || (env && env[VM_ENV] === '1');
}

/**
 * Forced in VM mode, whatever settings.json says. Links stay in the app (web tabs), no background mode
 * (closing the window quits: the VM restarts it), downloads in the VM's Downloads folder without a dialog
 * (an agent cannot answer one).
 */
const VM_FORCED_SETTINGS = Object.freeze({
  openLinksInApp: true,
  keepInBackground: false,
  backgroundHintShown: true,
  downloadsAskWhere: false,
  themeSource: 'light',
});

/** Features turned off in VM mode (listed in the shell's « Gérée par Lasco » panel and in docs/vm-mode.md). */
const VM_DISABLED_FEATURES = Object.freeze([
  'auto-update',
  'tray',
  'open-at-login',
  'notifications',
  'global-shortcuts',
  'protocol-client',
  'default-browser',
  'password-manager',
  'form-autofill',
  'drive-sync',
  'tab-windows',
  'settings-window',
  'portal',
]);

function applyVmSettings(settings, { downloadsDirectory } = {}) {
  return {
    ...(settings || {}),
    ...VM_FORCED_SETTINGS,
    downloadsDirectory: downloadsDirectory || (settings && settings.downloadsDirectory) || null,
    shortcuts: {},
  };
}

function controlPortFrom(env = process.env) {
  const raw = Number.parseInt(env && env.LASCO_VM_CONTROL_PORT, 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : VM_CONTROL_DEFAULT_PORT;
}

/**
 * Token of the control endpoint: random, written to a file only the VM's desktop user reads (0600).
 * The firewall of the VM already keeps the code user (lasco-code) off the port: the token is a second lock.
 */
function writeControlToken(filePath, fsImpl = fs) {
  const token = crypto.randomBytes(32).toString('hex');
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, token, { mode: 0o600 });
  fsImpl.renameSync(tmp, filePath);
  fsImpl.chmodSync(filePath, 0o600);
  return token;
}

function tokenMatches(expected, header) {
  if (typeof expected !== 'string' || !expected || typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Loopback only, and a Host header that names it: a web page cannot reach the endpoint by DNS rebinding. */
function isLocalRequest(req, port) {
  const remote = req.socket && req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1') return false;
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > VM_CONTROL_MAX_BODY) {
        reject(Object.assign(new Error('body-too-large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch (_) {
        reject(Object.assign(new Error('invalid-json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Control endpoint of the VM browser.
 *
 * - `GET  /v1/status`         → `{ ok, vm: true, tabs, activeTabId }`
 * - `GET  /v1/tabs`           → `{ ok, tabs: [{ tabId, url, title, active, targetId }] }`
 * - `POST /v1/tabs`           `{ url, activate? }` → opens a web tab → `{ ok, tabId, targetId }`
 * - `POST /v1/tabs/:id/activate` → `{ ok, tabId, targetId }`
 * - `GET  /v1/active`         → active web tab (opens a blank one when there is none) → `{ ok, tabId, targetId }`
 *
 * `targetId` is the CDP target of the tab's page (Target.getTargetInfo), never the shell's.
 *
 * @param {{ token: string, port?: number, host?: string, browser: {
 *   listTabs: () => Promise<Array<object>> | Array<object>,
 *   openTab: (input: { url: string, activate: boolean }) => Promise<object>,
 *   activateTab: (tabId: string) => Promise<object>,
 *   activeTab: () => Promise<object>,
 * } }} options
 */
function createVmControlServer({ token, port = VM_CONTROL_DEFAULT_PORT, host = VM_CONTROL_HOST, browser }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('vm control token missing');
  const send = (res, status, body) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(json),
    });
    res.end(json);
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req, port)) return send(res, 403, { ok: false, error: 'forbidden' });
      if (!tokenMatches(token, req.headers.authorization)) return send(res, 401, { ok: false, error: 'unauthorized' });
      // No browser ever sends this header on its own: a page cannot fake it without a CORS preflight, refused here.
      if (req.headers.origin) return send(res, 403, { ok: false, error: 'forbidden' });
      const url = new URL(req.url || '/', `http://${host}:${port}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1') return send(res, 404, { ok: false, error: 'not-found' });

      if (req.method === 'GET' && parts[1] === 'status' && parts.length === 2) {
        const tabs = await browser.listTabs();
        const active = tabs.find((tab) => tab.active);
        return send(res, 200, { ok: true, vm: true, tabs: tabs.length, activeTabId: active ? active.tabId : null });
      }
      if (req.method === 'GET' && parts[1] === 'tabs' && parts.length === 2) {
        return send(res, 200, { ok: true, tabs: await browser.listTabs() });
      }
      if (req.method === 'POST' && parts[1] === 'tabs' && parts.length === 2) {
        const body = await readJson(req);
        if (typeof body.url !== 'string' || !body.url.trim()) return send(res, 400, { ok: false, error: 'invalid-url' });
        const result = await browser.openTab({ url: body.url.trim(), activate: body.activate !== false });
        return send(res, result && result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && parts[1] === 'tabs' && parts[3] === 'activate' && parts.length === 4) {
        const result = await browser.activateTab(decodeURIComponent(parts[2]));
        return send(res, result && result.ok ? 200 : 404, result);
      }
      if (req.method === 'GET' && parts[1] === 'active' && parts.length === 2) {
        const result = await browser.activeTab();
        return send(res, result && result.ok ? 200 : 503, result);
      }
      return send(res, 404, { ok: false, error: 'not-found' });
    } catch (error) {
      const status = error && Number.isInteger(error.status) ? error.status : 500;
      return send(res, status, { ok: false, error: error && error.message ? error.message : 'error' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** CDP target of a page, without leaving the debugger attached (DevTools and Playwright attach later). */
async function cdpTargetIdOf(webContents) {
  if (!webContents || webContents.isDestroyed()) return null;
  const dbg = webContents.debugger;
  const wasAttached = dbg.isAttached();
  try {
    if (!wasAttached) dbg.attach('1.3');
    const info = await dbg.sendCommand('Target.getTargetInfo');
    return (info && info.targetInfo && info.targetInfo.targetId) || null;
  } catch (_) {
    return null;
  } finally {
    if (!wasAttached && dbg.isAttached()) {
      try {
        dbg.detach();
      } catch (_) {
        // already detached
      }
    }
  }
}

module.exports = {
  VM_ARG,
  VM_ENV,
  VM_USER_AGENT_TOKEN,
  VM_CONTROL_HOST,
  VM_CONTROL_DEFAULT_PORT,
  VM_FORCED_SETTINGS,
  VM_DISABLED_FEATURES,
  isVmMode,
  applyVmSettings,
  controlPortFrom,
  writeControlToken,
  tokenMatches,
  isLocalRequest,
  createVmControlServer,
  cdpTargetIdOf,
};
