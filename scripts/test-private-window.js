'use strict';

/**
 * Navigation privée (docs/private-browsing.md) : session en mémoire, rien d'écrit sur le disque,
 * pas de pont du portail, adresses de Lasco renvoyées vers la fenêtre principale.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  newPrivatePartition,
  isPrivatePartition,
  assertInMemoryPartition,
  routePrivateUrl,
  isDeniedInPrivate,
  createPrivateSitePermissions,
  wipePrivateSession,
  PRIVATE_DENIED_TAB_METHODS,
} = require('../src/private-window/rules');
const { createSitePermissionStore } = require('../src/browser-tabs/site-permissions');
const { sanitizeBrowserUrl } = require('../src/browser-tabs/url');

const isPortalUrl = (url) => {
  try {
    return new URL(url).origin === 'https://app.lascoapp.com';
  } catch {
    return false;
  }
};

describe('private window: partition', () => {
  it('is always in memory (never persist:) and new for each window', () => {
    let n = 0;
    const a = newPrivatePartition(() => `id-${++n}`);
    const b = newPrivatePartition(() => `id-${++n}`);
    assert.notEqual(a, b);
    for (const name of [a, b]) {
      assert.ok(!name.startsWith('persist:'));
      assert.ok(isPrivatePartition(name));
      assert.equal(assertInMemoryPartition(name), name);
    }
  });

  it('refuses a persistent partition or an empty id', () => {
    assert.throws(() => assertInMemoryPartition('persist:browser-tabs'));
    assert.throws(() => assertInMemoryPartition('persist:lasco-private-x'));
    assert.throws(() => assertInMemoryPartition(''));
    assert.throws(() => newPrivatePartition(() => ''));
    assert.equal(isPrivatePartition('persist:portal'), false);
  });

  it('wipes cookies, cache and storage of the session', async () => {
    const calls = [];
    const ses = {
      clearStorageData: async () => calls.push('storage'),
      clearCache: async () => calls.push('cache'),
      clearAuthCache: async () => calls.push('auth'),
      clearHostResolverCache: async () => {
        throw new Error('boom');
      },
    };
    await wipePrivateSession(ses);
    assert.deepEqual(calls, ['storage', 'cache', 'auth']);
    await wipePrivateSession(null);
  });
});

describe('private window: addresses', () => {
  it('sends a Lasco address to the main window, never to the private tab', () => {
    const opts = { isPortalUrl, sanitizeBrowserUrl };
    assert.equal(routePrivateUrl('https://app.lascoapp.com/acme/contacts', opts), 'portal');
    assert.equal(routePrivateUrl('https://example.com/', opts), 'web');
    assert.equal(routePrivateUrl('javascript:alert(1)', opts), 'deny');
    assert.equal(routePrivateUrl('', opts), 'deny');
  });

  it('denies the password manager, the form autofill and agents', () => {
    for (const method of ['passwordSetEnabled', 'passwordFill', 'autofillFill', 'agentAction', 'setAgentControl', 'historyList']) {
      assert.ok(isDeniedInPrivate(method), method);
    }
    assert.equal(isDeniedInPrivate('create'), false);
    assert.equal(isDeniedInPrivate('historySuggest'), false);
  });
});

describe('private window: site permissions', () => {
  it('keeps its decisions in memory and inherits only the blocks', () => {
    const writes = [];
    const fsSpy = {
      readFileSync: () => JSON.stringify({ origins: { 'https://a.test': { geolocation: 'allow', notifications: 'block' } }, defaults: { camera: 'block' } }),
      writeFileSync: (...args) => writes.push(args),
      mkdirSync: () => undefined,
      renameSync: () => undefined,
    };
    const base = createSitePermissionStore({ filePath: '/tmp/x.json', fsImpl: fsSpy });
    const store = createPrivateSitePermissions({ memory: createSitePermissionStore({}), base });
    // Bloqué dans le navigateur normal : bloqué ici aussi. Autorisé ailleurs : redemandé.
    assert.equal(store.get('https://a.test', 'notifications'), 'block');
    assert.equal(store.get('https://a.test', 'geolocation'), null);
    assert.equal(store.getDefault('camera'), 'block');
    assert.ok(store.set('https://a.test', 'geolocation', 'allow'));
    assert.equal(store.get('https://a.test', 'geolocation'), 'allow');
    assert.deepEqual(store.list('https://a.test'), { geolocation: 'allow', notifications: 'block' });
    assert.equal(store.setDefault('camera', 'ask'), false);
    store.clearOrigin('https://a.test');
    // Rien n'a été écrit, et le navigateur normal n'a pas changé.
    assert.equal(writes.length, 0);
    assert.equal(base.get('https://a.test', 'geolocation'), 'allow');
  });
});

/**
 * Le vrai gestionnaire d'onglets en mode privé, avec un faux Electron : il ne doit ouvrir que la partition
 * privée, ne charger aucun preload dans les pages, et n'écrire aucun fichier (historique, autorisations…).
 */
describe('private window: browser tab manager', () => {
  let userData;
  const partitions = [];
  const views = [];
  const wiped = [];
  let manager;
  const diverted = [];

  /** Objet factice : toute propriété inconnue est une fonction factice, elle-même un objet factice. */
  function stub(overrides = {}) {
    return new Proxy(overrides, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'then') return undefined;
        return callable();
      },
    });
  }
  function callable() {
    return new Proxy(function fake() {}, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        return callable();
      },
      apply: () => stub(),
    });
  }

  function fakeWebContents(id) {
    const listeners = new Map();
    let url = '';
    return stub({
      id,
      listeners,
      on(name, fn) {
        listeners.set(name, fn);
      },
      once() {},
      emit(name, ...args) {
        const fn = listeners.get(name);
        if (fn) fn(...args);
      },
      isDestroyed: () => false,
      getURL: () => url,
      getTitle: () => 'Titre',
      loadURL: async (next) => {
        url = next;
      },
      navigationHistory: stub({ canGoBack: () => false, canGoForward: () => false }),
      debugger: stub({ isAttached: () => false, attach: () => undefined, sendCommand: async () => undefined }),
      getZoomFactor: () => 1,
      isAudioMuted: () => false,
      isCurrentlyAudible: () => false,
    });
  }

  before(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-private-'));
    let wcId = 0;
    const electron = {
      app: { getPath: () => userData, getPreferredSystemLanguages: () => ['fr-FR'] },
      BrowserWindow: { getFocusedWindow: () => null },
      WebContentsView: class {
        constructor(options) {
          this.options = options;
          this.webContents = fakeWebContents(++wcId);
          views.push(this);
        }
        setBackgroundColor() {}
        setVisible() {}
        setBounds() {}
      },
      session: {
        fromPartition(name) {
          partitions.push(name);
          return stub({
            clearStorageData: async () => wiped.push(['storage', name]),
            clearCache: async () => wiped.push(['cache', name]),
            clearAuthCache: async () => wiped.push(['auth', name]),
          });
        },
      },
      clipboard: stub(),
      ClipboardItem: class {},
      shell: stub(),
      dialog: stub(),
      Menu: stub(),
      nativeTheme: stub({ shouldUseDarkColors: true, on() {}, removeListener() {} }),
      net: stub(),
      systemPreferences: stub(),
    };
    const electronPath = require.resolve('electron');
    require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron };
    delete require.cache[require.resolve('../src/browser-tabs/manager')];
    const { createBrowserTabManager } = require('../src/browser-tabs/manager');
    const win = stub({ isDestroyed: () => false, webContents: stub({ send() {} }), contentView: stub() });
    manager = createBrowserTabManager({
      getMainWindow: () => win,
      partition: 'lasco-private-test',
      privateMode: true,
      isPortalUrl,
      onPortalUrl: (url) => diverted.push(url),
    });
  });

  after(() => {
    delete require.cache[require.resolve('electron')];
    delete require.cache[require.resolve('../src/browser-tabs/manager')];
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('refuses a persistent partition', () => {
    const { createBrowserTabManager } = require('../src/browser-tabs/manager');
    assert.throws(() => createBrowserTabManager({ getMainWindow: () => null, partition: 'persist:browser-tabs', privateMode: true }));
  });

  it('opens web tabs on the private partition, without the password runtime', async () => {
    const result = manager.create({ tabId: 't1', url: 'https://example.com/' });
    assert.equal(result.ok, true);
    const view = views.at(-1);
    assert.equal(view.options.webPreferences.preload, undefined);
    assert.ok(partitions.length > 0);
    assert.ok(partitions.every((name) => name === 'lasco-private-test'), partitions.join(','));
    // La page navigue, change de titre : l'historique reste en mémoire.
    view.webContents.emit('did-navigate', {}, 'https://example.com/compte');
    view.webContents.emit('page-title-updated', {}, 'Mon compte');
    const suggest = manager.historySuggest({ query: 'example' });
    assert.equal(suggest.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('never writes history, permissions or anything else to disk', async () => {
    manager.setSitePermission({ tabId: 't1', permission: 'geolocation', decision: 'allow' });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(fs.readdirSync(userData), []);
  });

  it('sends Lasco addresses to the main window', () => {
    const created = manager.create({ tabId: 't2', url: 'https://app.lascoapp.com/acme/contacts' });
    assert.equal(created.ok, false);
    assert.equal(created.diverted, true);
    const navigated = manager.navigate({ tabId: 't1', url: 'https://app.lascoapp.com/acme' });
    assert.equal(navigated.diverted, true);
    let prevented = false;
    views[0].webContents.emit('will-navigate', { preventDefault: () => (prevented = true) }, 'https://app.lascoapp.com/x');
    assert.equal(prevented, true);
    assert.deepEqual(diverted, [
      'https://app.lascoapp.com/acme/contacts',
      'https://app.lascoapp.com/acme',
      'https://app.lascoapp.com/x',
    ]);
  });

  it('denies passwords, autofill and agent control', async () => {
    for (const method of PRIVATE_DENIED_TAB_METHODS) {
      const res = await manager[method]({ tabId: 't1' });
      assert.deepEqual(res, { ok: false, error: 'private-window' }, method);
    }
    assert.equal(manager.isPrivate, true);
  });

  it('wipes its session when the window closes', async () => {
    await manager.destroySession();
    assert.deepEqual(
      wiped.map(([step]) => step),
      ['storage', 'cache', 'auth'],
    );
    assert.ok(wiped.every(([, name]) => name === 'lasco-private-test'));
  });
});

describe('private window: shell page and preload', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  it('is Desktop’s own page: no remote script, never the portal', () => {
    const html = read('src/vm-shell/private.html');
    assert.match(html, /Content-Security-Policy[^>]*default-src 'none'; script-src 'self'/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.doesNotMatch(html, /lascoapp\.com|__proxy_api/);
    assert.match(html, /Navigation privée/);
  });

  it('exposes only the web tabs: no host operations, passwords, downloads or agents', () => {
    const preload = read('src/private-window/private-preload.js');
    for (const forbidden of ['hostOps', 'codeWorkspace', 'codeHarness', 'passwords', 'autofill', 'agentAction', 'downloads', 'driveSync', 'notify', 'tabWindows', 'vault']) {
      assert.doesNotMatch(preload, new RegExp(`\\b${forbidden}\\s*:`), forbidden);
    }
    assert.match(preload, /location\.protocol === 'file:'/);
  });

  it('is never registered as a portal window', () => {
    const main = read('src/main.js');
    const fn = main.slice(main.indexOf('function openPrivateWindow('), main.indexOf("win.loadFile(path.join(__dirname, 'vm-shell', 'private.html'))"));
    assert.ok(fn.length > 0);
    assert.doesNotMatch(fn, /portalWindows\.set/);
    assert.doesNotMatch(fn, /persist:/);
    assert.match(fn, /privateMode: true/);
  });
});
