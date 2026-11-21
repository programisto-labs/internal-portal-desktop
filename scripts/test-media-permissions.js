'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  portalMediaAllowed,
  portalMediaCheckAllowed,
  ensureSystemMicrophoneAccess,
  installPortalMediaPermissions,
  installBrowserTabMediaPermissions,
} = require('../src/media-permissions');

const isPortal = (u) => {
  try {
    return new URL(u).hostname === 'app.lascoapp.com';
  } catch (_) {
    return false;
  }
};

function fakeSession() {
  const handlers = {};
  return {
    handlers,
    setPermissionRequestHandler: (fn) => (handlers.request = fn),
    setPermissionCheckHandler: (fn) => (handlers.check = fn),
  };
}

const ask = (handler, wc, permission, details) =>
  new Promise((resolve) => handler(wc, permission, resolve, details));

describe('media permissions', () => {
  it('portail : micro seul, page du portail seulement', () => {
    assert.equal(portalMediaAllowed('https://app.lascoapp.com/w/ai', { mediaTypes: ['audio'] }, isPortal), true);
    assert.equal(portalMediaAllowed('https://app.lascoapp.com/w/ai', { mediaTypes: ['audio', 'video'] }, isPortal), false);
    assert.equal(portalMediaAllowed('https://app.lascoapp.com/w/ai', { mediaTypes: [] }, isPortal), false);
    assert.equal(portalMediaAllowed('https://evil.example/', { mediaTypes: ['audio'] }, isPortal), false);
    assert.equal(portalMediaCheckAllowed('https://app.lascoapp.com', { mediaType: 'audio' }, isPortal), true);
    assert.equal(portalMediaCheckAllowed('https://app.lascoapp.com', { mediaType: 'video' }, isPortal), false);
    assert.equal(portalMediaCheckAllowed('https://evil.example', { mediaType: 'audio' }, isPortal), false);
  });

  it('macOS : demande système si pas encore décidé, refus respecté', async () => {
    const prefs = (status, answer = true) => ({
      getMediaAccessStatus: () => status,
      askForMediaAccess: async () => answer,
    });
    assert.equal(await ensureSystemMicrophoneAccess(prefs('granted'), 'darwin'), true);
    assert.equal(await ensureSystemMicrophoneAccess(prefs('not-determined', true), 'darwin'), true);
    assert.equal(await ensureSystemMicrophoneAccess(prefs('not-determined', false), 'darwin'), false);
    assert.equal(await ensureSystemMicrophoneAccess(prefs('denied'), 'darwin'), false);
    assert.equal(await ensureSystemMicrophoneAccess(prefs('denied'), 'win32'), true);
  });

  it('session du portail : autres permissions inchangées, micro du portail accordé', async () => {
    const s = fakeSession();
    installPortalMediaPermissions(s, {
      isPortalUrl: isPortal,
      systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true },
    });
    const wc = { isDestroyed: () => false, getURL: () => 'https://app.lascoapp.com/w/ai' };
    assert.equal(await ask(s.handlers.request, wc, 'notifications', {}), true);
    assert.equal(await ask(s.handlers.request, wc, 'media', { mediaTypes: ['audio'] }), true);
    assert.equal(await ask(s.handlers.request, wc, 'media', { mediaTypes: ['video'] }), false);
    assert.equal(s.handlers.check(wc, 'clipboard-read', 'https://app.lascoapp.com', {}), true);
  });

  it('onglets web : ni micro ni caméra', async () => {
    const s = fakeSession();
    installBrowserTabMediaPermissions(s);
    assert.equal(await ask(s.handlers.request, {}, 'media', { mediaTypes: ['audio'] }), false);
    assert.equal(await ask(s.handlers.request, {}, 'fullscreen', {}), true);
    assert.equal(s.handlers.check({}, 'media', 'https://example.com', {}), false);
  });
});
