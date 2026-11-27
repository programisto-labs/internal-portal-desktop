'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FiltersEngine, Request } = require('@ghostery/adblocker');
const {
  DAY_MS,
  createAdblockSettingsStore,
  createAdblockEngineLoader,
  createAdblockRequestFilter,
  createCosmeticHandlers,
  adblockActiveFor,
} = require('../src/browser-tabs/adblock');

const FILTERS = ['||ads.example.net^', '||tracker.example.org^$third-party', 'example.com##.ad-banner'].join('\n');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-adblock-'));
}

function run(filter, details) {
  let result;
  filter(details, (r) => {
    result = r;
  });
  return result;
}

const lasco = (url) => /^https:\/\/([a-z0-9-]+\.)*lascoapp\.com\//.test(url);

function setup({ pageUrl = 'https://news.example.com/article', enabled = true, allowed = [] } = {}) {
  const settings = createAdblockSettingsStore();
  settings.setEnabled(enabled);
  for (const origin of allowed) settings.setSiteAllowed(origin, true);
  const engine = FiltersEngine.parse(FILTERS);
  const blocked = [];
  const filter = createAdblockRequestFilter({
    getEngine: () => engine,
    settings,
    isProtectedUrl: lasco,
    pageUrlFor: () => pageUrl,
    onBlocked: (id, details) => blocked.push([id, details.url]),
    Request,
  });
  return { settings, filter, blocked, engine };
}

const req = (url, extra = {}) => ({ id: 1, url, resourceType: 'script', webContentsId: 7, ...extra });

describe('adblock settings store', () => {
  it('is enabled by default, keeps site exceptions and survives a reload', () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'browser-adblock.json');
    const store = createAdblockSettingsStore({ filePath });
    assert.equal(store.isEnabled(), true);
    assert.equal(store.setSiteAllowed('https://www.lemonde.fr', true), true);
    assert.equal(store.setSiteAllowed('https://www.lemonde.fr/page', true), false, 'origin only');
    assert.equal(store.setSiteAllowed('file:///tmp', true), false);
    store.setEnabled(false);
    const again = createAdblockSettingsStore({ filePath });
    assert.equal(again.isEnabled(), false);
    assert.equal(again.isSiteAllowed('https://www.lemonde.fr'), true);
    assert.deepEqual(again.listSites(), [{ origin: 'https://www.lemonde.fr', host: 'www.lemonde.fr' }]);
    again.setSiteAllowed('https://www.lemonde.fr', false);
    assert.deepEqual(createAdblockSettingsStore({ filePath }).listSites(), []);
  });

  it('notifies listeners on change only', () => {
    const store = createAdblockSettingsStore();
    let calls = 0;
    store.onChange(() => calls++);
    store.setEnabled(true);
    store.setSiteAllowed('https://a.fr', true);
    store.setSiteAllowed('https://a.fr', true);
    assert.equal(calls, 1);
  });

  it('reads a corrupt file as the defaults', () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'browser-adblock.json');
    fs.writeFileSync(filePath, '{not json');
    const store = createAdblockSettingsStore({ filePath });
    assert.equal(store.isEnabled(), true);
    assert.deepEqual(store.listSites(), []);
  });
});

describe('adblock request filter', () => {
  it('blocks ads and third-party trackers, counts them', () => {
    const { filter, blocked } = setup();
    assert.deepEqual(run(filter, req('https://ads.example.net/banner.js')), { cancel: true });
    assert.deepEqual(run(filter, req('https://tracker.example.org/pixel.gif', { resourceType: 'image' })), {
      cancel: true,
    });
    assert.deepEqual(run(filter, req('https://cdn.example.com/app.js')), {});
    assert.deepEqual(blocked, [
      [7, 'https://ads.example.net/banner.js'],
      [7, 'https://tracker.example.org/pixel.gif'],
    ]);
  });

  it('never blocks the main frame', () => {
    const { filter } = setup();
    assert.deepEqual(run(filter, req('https://ads.example.net/', { resourceType: 'mainFrame' })), {});
  });

  it('respects the global switch and the site exception', () => {
    assert.deepEqual(run(setup({ enabled: false }).filter, req('https://ads.example.net/a.js')), {});
    const { filter, blocked } = setup({ allowed: ['https://news.example.com'] });
    assert.deepEqual(run(filter, req('https://ads.example.net/a.js')), {});
    assert.equal(blocked.length, 0);
  });

  it('never filters Lasco pages nor requests to Lasco', () => {
    const onLasco = setup({ pageUrl: 'https://app.lascoapp.com/ws/contacts' });
    assert.deepEqual(run(onLasco.filter, req('https://ads.example.net/a.js')), {});
    const toLasco = setup();
    assert.deepEqual(run(toLasco.filter, req('https://api.lascoapp.com/ads.example.net^')), {});
  });

  it('lets requests without a tab through', () => {
    const { filter } = setup();
    assert.deepEqual(run(filter, req('https://ads.example.net/a.js', { webContentsId: undefined })), {});
  });

  it('lets everything through while the engine is not loaded', () => {
    const settings = createAdblockSettingsStore();
    const filter = createAdblockRequestFilter({
      getEngine: () => null,
      settings,
      pageUrlFor: () => 'https://news.example.com/',
      Request,
    });
    assert.deepEqual(run(filter, req('https://ads.example.net/a.js')), {});
  });

  it('decides activity per page', () => {
    const settings = createAdblockSettingsStore();
    assert.equal(adblockActiveFor({ settings, isProtectedUrl: lasco }, 'https://www.lemonde.fr/'), true);
    assert.equal(adblockActiveFor({ settings, isProtectedUrl: lasco }, 'about:blank'), false);
    assert.equal(adblockActiveFor({ settings, isProtectedUrl: lasco }, 'https://app.lascoapp.com/'), false);
  });
});

describe('adblock cosmetic handlers', () => {
  function sender(url, id = 7) {
    return { id, getURL: () => url, isDestroyed: () => false };
  }

  it('injects only for web tabs with the blocker active', async () => {
    const settings = createAdblockSettingsStore();
    let calls = 0;
    const engine = { config: { enableMutationObserver: true }, onInjectCosmeticFilters: async () => calls++ };
    const handlers = createCosmeticHandlers({
      getEngine: () => engine,
      settings,
      isProtectedUrl: lasco,
      isBrowserTabSender: (s) => s.id === 7,
    });
    await handlers.injectCosmeticFilters({ sender: sender('https://example.com/') }, 'https://example.com/');
    assert.equal(calls, 1);
    await handlers.injectCosmeticFilters({ sender: sender('https://example.com/', 8) }, 'https://example.com/');
    await handlers.injectCosmeticFilters({ sender: sender('https://app.lascoapp.com/') }, 'https://app.lascoapp.com/');
    settings.setSiteAllowed('https://example.com', true);
    await handlers.injectCosmeticFilters({ sender: sender('https://example.com/') }, 'https://example.com/');
    assert.equal(calls, 1);
    assert.equal(await handlers.isMutationObserverEnabled({ sender: sender('https://example.com/') }), false);
    assert.equal(await handlers.isMutationObserverEnabled({ sender: sender('https://other.fr/') }), true);
  });
});

describe('adblock engine loader', () => {
  function makeLoader({ dir, at, compile, version = 'v1' }) {
    const clock = { t: at };
    const loader = createAdblockEngineLoader({
      cacheDir: dir,
      compile,
      deserialize: (bytes) => FiltersEngine.deserialize(bytes),
      now: () => clock.t,
      version,
      log: () => {},
    });
    return { loader, clock };
  }

  it('compiles once, then reuses the disk cache for a day', async () => {
    const dir = tmpDir();
    let compiles = 0;
    const compile = async () => {
      compiles++;
      return FiltersEngine.parse(FILTERS).serialize();
    };
    const first = makeLoader({ dir, at: 1000, compile });
    await first.loader.start();
    assert.equal(compiles, 1);
    assert.ok(first.loader.getEngine());
    assert.equal(first.loader.getFetchedAt(), 1000);

    const second = makeLoader({ dir, at: 1000 + DAY_MS - 1, compile });
    await second.loader.start();
    assert.equal(compiles, 1, 'fresh cache: no download');
    assert.ok(second.loader.getEngine().match(Request.fromRawDetails({ url: 'https://ads.example.net/x.js', type: 'script', sourceUrl: 'https://a.fr/' })).match);

    second.clock.t = 1000 + DAY_MS;
    await second.loader.maybeRefresh();
    assert.equal(compiles, 2, 'a day later: refreshed');
  });

  it('keeps the cached engine and waits an hour after a failed download', async () => {
    const dir = tmpDir();
    const ok = makeLoader({ dir, at: 0, compile: async () => FiltersEngine.parse(FILTERS).serialize() });
    await ok.loader.start();
    let attempts = 0;
    const failing = makeLoader({
      dir,
      at: 2 * DAY_MS,
      compile: async () => {
        attempts++;
        throw new Error('offline');
      },
    });
    await failing.loader.start();
    assert.equal(attempts, 1);
    assert.ok(failing.loader.getEngine(), 'old lists still used');
    failing.clock.t += 10 * 60 * 1000;
    await failing.loader.maybeRefresh();
    assert.equal(attempts, 1);
    failing.clock.t += 60 * 60 * 1000;
    await failing.loader.maybeRefresh();
    assert.equal(attempts, 2);
  });

  it('ignores a cache built by another engine version', async () => {
    const dir = tmpDir();
    let compiles = 0;
    const compile = async () => {
      compiles++;
      return FiltersEngine.parse(FILTERS).serialize();
    };
    await makeLoader({ dir, at: 0, compile, version: 'old' }).loader.start();
    await makeLoader({ dir, at: 1, compile, version: 'new' }).loader.start();
    assert.equal(compiles, 2);
  });
});
