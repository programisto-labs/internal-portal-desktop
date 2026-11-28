'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createIpcGate, isIpcAllowed } = require('../src/security/ipc-gate');

const PORTAL = 'https://app.lascoapp.com';
const isTrustedFrameUrl = (url) => new URL(url).origin === PORTAL;

function fakeIpcMain() {
  const emitter = new EventEmitter();
  const handlers = new Map();
  emitter.handle = (channel, fn) => handlers.set(channel, fn);
  emitter.handleOnce = emitter.handle;
  emitter.invoke = (channel, event, ...args) => Promise.resolve().then(() => handlers.get(channel)(event, ...args));
  return emitter;
}

function setup(extra = {}) {
  const logs = [];
  const gate = createIpcGate({ isTrustedFrameUrl, webChannels: ['lasco-pw:field'], log: (m) => logs.push(m), ...extra });
  const ipcMain = fakeIpcMain();
  gate.install(ipcMain);
  const portalSession = {};
  const webSession = {};
  gate.trustSession(portalSession);
  const event = (ses, url) => ({ sender: { session: ses }, senderFrame: { url, isDestroyed: () => false } });
  return { gate, ipcMain, portalSession, webSession, event, logs };
}

describe('isIpcAllowed', () => {
  const base = { channel: 'x', hasSender: true, sessionTrusted: true, isTrustedFrameUrl, webChannels: new Set() };
  it('portal page in the portal session: allowed', () => {
    assert.equal(isIpcAllowed({ ...base, frameUrl: `${PORTAL}/ws/contacts` }), true);
  });
  it('Lasco file page in a trusted session: allowed', () => {
    assert.equal(isIpcAllowed({ ...base, frameUrl: 'file:///Applications/Lasco.app/settings.html' }), true);
  });
  it('OAuth provider page shown in the portal window: refused', () => {
    assert.equal(isIpcAllowed({ ...base, frameUrl: 'https://accounts.google.com/o/oauth2' }), false);
  });
  it('web session, even with a portal-looking URL: refused', () => {
    assert.equal(isIpcAllowed({ ...base, sessionTrusted: false, frameUrl: `${PORTAL}/` }), false);
  });
  it('destroyed frame (no URL): refused', () => {
    assert.equal(isIpcAllowed({ ...base, frameUrl: null }), false);
  });
  it('web channel: allowed from anywhere', () => {
    assert.equal(isIpcAllowed({ ...base, sessionTrusted: false, frameUrl: 'https://evil.test/', channel: 'w', webChannels: new Set(['w']) }), true);
  });
});

describe('createIpcGate', () => {
  it('drops messages from a web tab, delivers the portal ones', () => {
    const { ipcMain, portalSession, webSession, event, logs } = setup();
    const seen = [];
    ipcMain.on('update-install-now', (_e, v) => seen.push(v));
    ipcMain.emit('update-install-now', event(webSession, 'https://evil.test/'), 'web');
    ipcMain.emit('update-install-now', event(portalSession, `${PORTAL}/`), 'portal');
    assert.deepEqual(seen, ['portal']);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /update-install-now/);
  });

  it('rejects handle() calls from a web tab', async () => {
    const { ipcMain, portalSession, webSession, event } = setup();
    ipcMain.handle('history-list', () => 'ok');
    await assert.rejects(ipcMain.invoke('history-list', event(webSession, 'https://evil.test/')), /forbidden/);
    assert.equal(await ipcMain.invoke('history-list', event(portalSession, `${PORTAL}/`)), 'ok');
  });

  it('lets web pages reach their preload channels', () => {
    const { ipcMain, webSession, event, gate } = setup();
    const seen = [];
    ipcMain.on('lasco-pw:field', () => seen.push('pw'));
    gate.allowWebChannels(['crx-msg']);
    ipcMain.on('crx-msg', () => seen.push('crx'));
    ipcMain.emit('lasco-pw:field', event(webSession, 'https://site.test/login'));
    ipcMain.emit('crx-msg', event(webSession, 'https://site.test/'));
    assert.deepEqual(seen, ['pw', 'crx']);
  });

  it('removeListener still removes the original listener', () => {
    const { ipcMain, portalSession, event } = setup();
    const seen = [];
    const listener = () => seen.push(1);
    ipcMain.on('c', listener);
    ipcMain.removeListener('c', listener);
    ipcMain.emit('c', event(portalSession, `${PORTAL}/`));
    assert.deepEqual(seen, []);
  });
});
