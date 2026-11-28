'use strict';

/** Registre par profil, politique, manifeste effectif, référence du store, répartiteur webRequest. */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExtensionRegistry, normalizePolicy, policyBlockReason } = require('../src/extensions/registry');
const { addedWarnings, effectiveManifest, permissionWarnings, writeEffectiveManifest } = require('../src/extensions/manifest');
const { isAllowedDownloadUrl, parseStoreReference } = require('../src/extensions/store-client');
const { createSessionHub } = require('../src/browser-tabs/web-request-hub');
const { profileIdForPartition } = require('../src/extensions/wiring');

const UBOL = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const GRAMMARLY = 'kbfnbcaeplbcioakkpcpgfkobkghlhen';

describe('registre des extensions', () => {
  it('garde les extensions par profil, sur le disque', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-ext-reg-'));
    const a = createExtensionRegistry({ rootDir: root, profileId: 'default' });
    a.put({ id: UBOL, source: 'store', path: '/x', version: '1', pinned: true });
    a.setDeveloperMode(true);
    const again = createExtensionRegistry({ rootDir: root, profileId: 'default' });
    assert.equal(again.get(UBOL).pinned, true);
    assert.equal(again.developerMode, true);
    const other = createExtensionRegistry({ rootDir: root, profileId: 'owner1-bp_0123456789abcdef' });
    assert.equal(other.list().length, 0);
    assert.throws(() => a.put({ id: 'not-an-id', path: '/x' }), /invalid/);
    a.update(UBOL, { sites: ['https://a.com/path', 'javascript:alert(1)'], siteAccess: 'specific' });
    assert.deepEqual(a.get(UBOL).sites, ['https://a.com']);
  });

  it('profil des partitions de profils de navigation, sinon le profil par défaut', () => {
    assert.equal(profileIdForPartition('persist:browser-tabs'), 'default');
    assert.equal(profileIdForPartition('persist:bp-a1b2c3d4e5f6-bp_0123456789abcdef-acme'), 'a1b2c3d4e5f6-bp_0123456789abcdef');
    assert.equal(profileIdForPartition('persist:bp-a1b2c3d4e5f6-default-acme'), 'a1b2c3d4e5f6-default');
    assert.equal(profileIdForPartition(undefined), 'default');
  });
});

describe('politique du workspace', () => {
  it('liste bloquée, liste autorisée, mode développeur', () => {
    assert.equal(policyBlockReason(null, UBOL), null);
    assert.equal(policyBlockReason(normalizePolicy({ blockedIds: [UBOL] }), UBOL), 'blocked');
    const allow = normalizePolicy({ mode: 'allowlist', allowedIds: [GRAMMARLY] });
    assert.equal(policyBlockReason(allow, UBOL), 'not_allowed');
    assert.equal(policyBlockReason(allow, GRAMMARLY), null);
    assert.equal(normalizePolicy({ allowDeveloperMode: false }).allowDeveloperMode, false);
    assert.deepEqual(normalizePolicy({ blockedIds: ['x', UBOL, UBOL] }).blockedIds, [UBOL]);
  });
});

describe('manifeste effectif', () => {
  const original = {
    manifest_version: 3,
    name: 'Ext',
    version: '1',
    permissions: ['storage', 'tabs', 'cookies'],
    host_permissions: ['<all_urls>'],
    content_scripts: [{ matches: ['<all_urls>'], js: ['c.js'] }, { matches: ['https://github.com/*'], js: ['gh.js'] }],
  };
  const lasco = ['https://app.lascoapp.com'];

  it('exclut toujours les adresses de Lasco des scripts de contenu', () => {
    const m = effectiveManifest(original, { siteAccess: 'all', protectedOrigins: lasco });
    assert.deepEqual(m.host_permissions, ['<all_urls>']);
    for (const script of m.content_scripts) assert.ok(script.exclude_matches.includes('https://app.lascoapp.com/*'));
  });

  it('« Sur certains sites » réduit les hôtes et les scripts aux sites accordés', () => {
    const m = effectiveManifest(original, { siteAccess: 'specific', sites: ['https://github.com'], protectedOrigins: lasco });
    assert.deepEqual(m.host_permissions, ['https://github.com/*', 'https://*.github.com/*']);
    assert.deepEqual(m.content_scripts.map((s) => s.js[0]), ['c.js', 'gh.js']);
    assert.deepEqual(m.content_scripts[0].matches, ['https://github.com/*', 'https://*.github.com/*']);
  });

  it('« Au clic » : aucun hôte au chargement, scripts retirés', () => {
    const m = effectiveManifest(original, { siteAccess: 'click', protectedOrigins: lasco });
    assert.deepEqual(m.host_permissions, []);
    assert.deepEqual(m.content_scripts, []);
  });

  it("garde le manifeste de l'éditeur à côté et repart toujours de lui", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-ext-man-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(original));
    writeEffectiveManifest(dir, { siteAccess: 'click', protectedOrigins: lasco });
    writeEffectiveManifest(dir, { siteAccess: 'all', protectedOrigins: lasco });
    const loaded = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(loaded.host_permissions, ['<all_urls>']);
    assert.equal(loaded.content_scripts.length, 2);
  });

  it("avertissements d'installation et nouvelles autorisations d'une mise à jour", () => {
    assert.deepEqual(permissionWarnings(original).map((w) => w.key), ['allHosts', 'tabs', 'cookies']);
    const narrow = { manifest_version: 3, host_permissions: ['https://*.github.com/*'], permissions: ['storage'] };
    assert.deepEqual(permissionWarnings(narrow), [{ key: 'hosts', hosts: ['github.com'], fallback: 'Lire et modifier vos données sur certains sites : github.com' }]);
    assert.deepEqual(addedWarnings(narrow, { ...narrow, permissions: ['storage', 'nativeMessaging'] }).map((w) => w.key), ['nativeMessaging']);
    assert.deepEqual(addedWarnings(original, { ...original, version: '2' }), []);
  });
});

describe('Chrome Web Store', () => {
  it('reconnaît un identifiant ou une adresse du store', () => {
    assert.equal(parseStoreReference(UBOL), UBOL);
    assert.equal(parseStoreReference(`https://chromewebstore.google.com/detail/ublock-origin-lite/${UBOL}`), UBOL);
    assert.equal(parseStoreReference(`https://evil.com/detail/${UBOL}`), null);
  });

  it('ne télécharge que depuis les serveurs de Google, en HTTPS', () => {
    assert.equal(isAllowedDownloadUrl('https://clients2.googleusercontent.com/crx/blobs/x/'), true);
    assert.equal(isAllowedDownloadUrl('http://clients2.googleusercontent.com/crx/blobs/x/'), false);
    assert.equal(isAllowedDownloadUrl('https://googleusercontent.com.evil.org/x'), false);
  });
});

describe('répartiteur webRequest', () => {
  function fakeSession() {
    const listeners = {};
    return {
      listeners,
      webRequest: new Proxy({}, { get: (_t, event) => (_filter, fn) => (listeners[event] = fn) }),
    };
  }
  const call = (fn, details) => new Promise((resolve) => fn(details, resolve));

  it('une seule inscription par événement ; le premier qui annule l’emporte', async () => {
    const session = fakeSession();
    const hub = createSessionHub(session);
    const seen = [];
    hub.add('onBeforeRequest', (d, cb) => {
      seen.push('lasco');
      cb({});
    });
    hub.add('onBeforeRequest', (d, cb) => {
      seen.push('dnr');
      cb({ cancel: true });
    }, { first: true });
    assert.deepEqual(await call(session.listeners.onBeforeRequest, { url: 'https://a.com/' }), { cancel: true });
    assert.deepEqual(seen, ['dnr']);
  });

  it('les en-têtes passent d’un gestionnaire au suivant ; filtre par schéma', async () => {
    const session = fakeSession();
    const hub = createSessionHub(session);
    hub.add('onBeforeSendHeaders', (d, cb) => cb({ requestHeaders: { ...d.requestHeaders, A: '1' } }), { urls: ['https://*/*'] });
    hub.add('onBeforeSendHeaders', (d, cb) => cb({ requestHeaders: { ...d.requestHeaders, B: d.requestHeaders.A || 'none' } }));
    assert.deepEqual(await call(session.listeners.onBeforeSendHeaders, { url: 'https://a.com/', requestHeaders: {} }), {
      requestHeaders: { A: '1', B: '1' },
    });
    assert.deepEqual(await call(session.listeners.onBeforeSendHeaders, { url: 'http://a.com/', requestHeaders: {} }), {
      requestHeaders: { B: 'none' },
    });
  });
});
