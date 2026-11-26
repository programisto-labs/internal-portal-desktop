'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  isVmMode,
  applyVmSettings,
  controlPortFrom,
  writeControlToken,
  tokenMatches,
  createVmControlServer,
  VM_FORCED_SETTINGS,
} = require('../src/vm-mode');

function request(port, { method = 'GET', pathname = '/v1/status', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('VM mode: detection and forced settings', () => {
  it('is on with --vm or LASCO_DESKTOP_VM=1 only', () => {
    assert.equal(isVmMode(['electron', '.', '--vm'], {}), true);
    assert.equal(isVmMode(['electron', '.'], { LASCO_DESKTOP_VM: '1' }), true);
    assert.equal(isVmMode(['electron', '.', '--no-agents'], { LASCO_DESKTOP_VM: '0' }), false);
  });

  it('forces the settings whatever settings.json says', () => {
    const forced = applyVmSettings(
      { openLinksInApp: false, keepInBackground: true, downloadsAskWhere: true, themeSource: 'dark', shortcuts: { a: 'b' } },
      { downloadsDirectory: '/home/lasco/Downloads' }
    );
    for (const [key, value] of Object.entries(VM_FORCED_SETTINGS)) assert.equal(forced[key], value, key);
    assert.equal(forced.downloadsDirectory, '/home/lasco/Downloads');
    assert.deepEqual(forced.shortcuts, {});
  });

  it('control port: 9334 by default, env override when valid', () => {
    assert.equal(controlPortFrom({}), 9334);
    assert.equal(controlPortFrom({ LASCO_VM_CONTROL_PORT: '9400' }), 9400);
    assert.equal(controlPortFrom({ LASCO_VM_CONTROL_PORT: 'x' }), 9334);
  });
});

describe('VM mode: control token', () => {
  it('is random, 64 hex chars, in a 0600 file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-vm-'));
    const file = path.join(dir, 'sub', 'vm-control-token');
    const a = writeControlToken(file);
    const b = writeControlToken(file);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
    assert.equal(fs.readFileSync(file, 'utf8'), b);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('is compared as a whole Bearer value', () => {
    const token = 'a'.repeat(64);
    assert.equal(tokenMatches(token, `Bearer ${token}`), true);
    assert.equal(tokenMatches(token, `Bearer ${token}x`), false);
    assert.equal(tokenMatches(token, token), false);
    assert.equal(tokenMatches(token, undefined), false);
    assert.equal(tokenMatches('', 'Bearer '), false);
  });

  it('refuses to start without a strong token', () => {
    assert.throws(() => createVmControlServer({ token: 'short', browser: {} }));
  });
});

describe('VM mode: control endpoint', () => {
  const token = 'b'.repeat(64);
  const opened = [];
  const tabs = [{ tabId: 't1', url: 'https://a.test/', title: 'A', active: true, targetId: 'TARGET-1' }];
  let control;
  let port;
  const auth = () => ({ authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` });

  before(async () => {
    // Free port picked by the OS, then reused for the server (Host check needs it).
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    port = probe.address().port;
    await new Promise((r) => probe.close(r));
    control = createVmControlServer({
      token,
      port,
      browser: {
        listTabs: () => tabs,
        openTab: async ({ url, activate }) => {
          opened.push({ url, activate });
          return { ok: true, tabId: 't2', url, active: activate, targetId: 'TARGET-2' };
        },
        activateTab: async (tabId) =>
          tabId === 't1' ? { ok: true, tabId, targetId: 'TARGET-1' } : { ok: false, error: 'unknown-tab' },
        activeTab: async () => ({ ok: true, tabId: 't1', targetId: 'TARGET-1' }),
      },
    });
    const address = await control.listen();
    assert.equal(address.address, '127.0.0.1');
  });

  after(() => control.close());

  it('needs the token', async () => {
    assert.equal((await request(port, { headers: { host: `127.0.0.1:${port}` } })).status, 401);
    const wrong = await request(port, { headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${'c'.repeat(64)}` } });
    assert.equal(wrong.status, 401);
  });

  it('refuses a web page (Origin header) and DNS rebinding (foreign Host)', async () => {
    assert.equal((await request(port, { headers: { ...auth(), origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(port, { headers: { ...auth(), host: `evil.test:${port}` } })).status, 403);
  });

  it('reports the tabs with their CDP target', async () => {
    const status = await request(port, { headers: auth() });
    assert.deepEqual(status.body, { ok: true, vm: true, tabs: 1, activeTabId: 't1' });
    const list = await request(port, { pathname: '/v1/tabs', headers: auth() });
    assert.equal(list.body.tabs[0].targetId, 'TARGET-1');
    const active = await request(port, { pathname: '/v1/active', headers: auth() });
    assert.equal(active.body.targetId, 'TARGET-1');
  });

  it('opens and activates tabs', async () => {
    const res = await request(port, {
      method: 'POST',
      pathname: '/v1/tabs',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: { url: 'https://b.test/', activate: false },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.targetId, 'TARGET-2');
    assert.deepEqual(opened.at(-1), { url: 'https://b.test/', activate: false });
    const bad = await request(port, { method: 'POST', pathname: '/v1/tabs', headers: auth(), body: {} });
    assert.equal(bad.status, 400);
    const notJson = await request(port, { method: 'POST', pathname: '/v1/tabs', headers: auth(), body: '{' });
    assert.equal(notJson.status, 400);
    assert.equal((await request(port, { method: 'POST', pathname: '/v1/tabs/t1/activate', headers: auth() })).status, 200);
    assert.equal((await request(port, { method: 'POST', pathname: '/v1/tabs/nope/activate', headers: auth() })).status, 404);
  });

  it('refuses large bodies and unknown routes', async () => {
    const big = await request(port, { method: 'POST', pathname: '/v1/tabs', headers: auth(), body: JSON.stringify({ url: 'x'.repeat(20000) }) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    assert.equal((await request(port, { pathname: '/v2/x', headers: auth() })).status, 404);
  });
});

describe('VM mode: shell page', () => {
  const root = path.join(__dirname, '..', 'src');
  it('loads no remote script and never the portal', () => {
    const html = fs.readFileSync(path.join(root, 'vm-shell', 'index.html'), 'utf8');
    assert.match(html, /default-src 'none'; script-src 'self'/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.match(main, /if \(VM_MODE\) \{\n\s+\/\/ Desktop's own browser shell[^\n]*\n\s+win\.loadFile\(path\.join\(__dirname, 'vm-shell', 'index\.html'\)\)/);
    assert.match(main, /const NO_AGENTS = VM_MODE \|\|/);
  });

  it('the preload gives the shell its bridge only on a file: page, and never host operations', () => {
    const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    assert.match(preload, /exposeVmShell = vmMode && Boolean\(globalThis\.location\) && globalThis\.location\.protocol === 'file:'/);
    assert.match(preload, /const exposeHostOps =\n\s+!vmMode && !noAgents/);
  });
});
