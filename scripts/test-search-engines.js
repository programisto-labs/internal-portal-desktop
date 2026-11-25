'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSearchEngineStore,
  buildSearchUrl,
  validateTemplate,
  parseOpenSearchDescription,
  discoveryKeyword,
  discoverSiteSearchEngine,
} = require('../src/browser-tabs/search-engines');
const { resolveOmniboxInput } = require('../src/browser-tabs/url');

function memoryFs() {
  const files = new Map();
  return {
    files,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, data) => files.set(p, data),
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    mkdirSync: () => {},
  };
}

const WIKIPEDIA_OSDD = `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Wikipédia (fr)</ShortName>
  <Url type="application/x-suggestions+json" method="get" template="https://fr.wikipedia.org/w/api.php?action=opensearch&amp;search={searchTerms}"/>
  <Url type="text/html" method="get" template="https://fr.wikipedia.org/w/index.php?title=Sp%C3%A9cial:Recherche&amp;search={searchTerms}&amp;offset={startIndex?}"/>
</OpenSearchDescription>`;

describe('search engine store', () => {
  it('defaults to Google and lists the proposed engines', () => {
    const store = createSearchEngineStore();
    const { defaultId, engines } = store.list();
    assert.equal(defaultId, 'google');
    for (const id of ['google', 'bing', 'duckduckgo', 'ecosia', 'brave', 'qwant']) {
      assert.ok(engines.some((e) => e.id === id && e.kind === 'builtin'), id);
    }
    assert.equal(buildSearchUrl(store.getDefault(), 'a b&c'), 'https://www.google.com/search?q=a%20b%26c');
  });

  it('changes the default engine and keeps it on disk', () => {
    const fsImpl = memoryFs();
    const store = createSearchEngineStore({ filePath: '/x/se.json', fsImpl, saveDelayMs: 0 });
    assert.equal(store.setDefault('ecosia').ok, true);
    assert.equal(store.setDefault('nope').ok, false);
    store.flush();
    const again = createSearchEngineStore({ filePath: '/x/se.json', fsImpl });
    assert.equal(again.getDefault().id, 'ecosia');
  });

  it('validates custom engines like Chrome (name, shortcut, URL with %s)', () => {
    const store = createSearchEngineStore();
    assert.equal(store.addCustom({ name: 'Wiki', keyword: 'w', template: 'https://fr.wikipedia.org/?search=%s' }).ok, true);
    assert.equal(store.addCustom({ name: 'X', keyword: 'w', template: 'https://x.com/?q=%s' }).error, 'keyword-taken');
    assert.equal(store.addCustom({ name: 'X', keyword: 'google.com', template: 'https://x.com/?q=%s' }).error, 'keyword-taken');
    assert.equal(store.addCustom({ name: 'X', keyword: 'a b', template: 'https://x.com/?q=%s' }).error, 'keyword-spaces');
    assert.equal(store.addCustom({ name: 'X', keyword: 'x', template: 'https://x.com/' }).error, 'invalid-template');
    assert.equal(store.addCustom({ name: 'X', keyword: 'x', template: 'javascript:alert(%s)' }).error, 'invalid-template');
    assert.equal(store.addCustom({ name: '', keyword: 'x', template: 'https://x.com/?q=%s' }).error, 'name-required');
    const wiki = store.list().engines.find((e) => e.keyword === 'w');
    assert.equal(store.setDefault(wiki.id).ok, true);
    assert.equal(store.remove(wiki.id).ok, true);
    assert.equal(store.getDefault().id, 'google');
  });

  it('notifies subscribers on change', () => {
    const store = createSearchEngineStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.setDefault('bing');
    store.setDefault('bing');
    assert.equal(calls, 1);
  });
});

describe('templates and OpenSearch', () => {
  it('keeps %s and rejects non http(s) templates', () => {
    assert.equal(validateTemplate('https://a.com/s?q=%s&x=1'), 'https://a.com/s?q=%s&x=1');
    assert.equal(validateTemplate('ftp://a.com/%s'), null);
    assert.equal(validateTemplate('https://user:pw@a.com/?q=%s'), null);
  });

  it('reads the HTML search URL of an OpenSearch description', () => {
    const parsed = parseOpenSearchDescription(WIKIPEDIA_OSDD);
    assert.equal(parsed.name, 'Wikipédia (fr)');
    assert.equal(parsed.template, 'https://fr.wikipedia.org/w/index.php?title=Sp%C3%A9cial:Recherche&search=%s&offset=');
    assert.equal(parseOpenSearchDescription('<OpenSearchDescription><Url type="text/html" template="https://a.com/?q={searchTerms}&k={unknown}"/></OpenSearchDescription>'), null);
    assert.equal(parseOpenSearchDescription('<OpenSearchDescription><Url type="text/html" method="post" template="https://a.com/?q={searchTerms}"/></OpenSearchDescription>'), null);
  });

  it('only accepts a search that stays on the site', () => {
    assert.equal(discoveryKeyword('https://fr.wikipedia.org/wiki/X', 'https://fr.wikipedia.org/w/opensearch.xml', 'https://fr.wikipedia.org/?q=%s'), 'fr.wikipedia.org');
    assert.equal(discoveryKeyword('https://www.a.com/', 'https://a.com/os.xml', 'https://www.a.com/?q=%s'), 'a.com');
    assert.equal(discoveryKeyword('https://a.com/', 'https://a.com/os.xml', 'https://evil.com/?q=%s'), null);
    assert.equal(discoveryKeyword('https://a.com/', 'https://evil.com/os.xml', 'https://a.com/?q=%s'), null);
  });

  it('adds a discovered site once, unless discovery is off', async () => {
    const store = createSearchEngineStore();
    let fetches = 0;
    const run = () =>
      discoverSiteSearchEngine({
        store,
        pageUrl: 'https://fr.wikipedia.org/wiki/Lascaux',
        readLink: async () => ({ href: 'https://fr.wikipedia.org/w/opensearch_desc.php', title: 'Wikipédia' }),
        fetchText: async () => {
          fetches++;
          return WIKIPEDIA_OSDD;
        },
      });
    assert.equal((await run()).ok, true);
    assert.equal((await run()).error, 'exists');
    assert.equal(fetches, 1);
    const site = store.snapshot().engines.find((e) => e.keyword === 'fr.wikipedia.org');
    assert.equal(site.kind, 'site');
    assert.equal(store.setActive(site.id, false).ok, true);
    assert.ok(!store.snapshot().engines.some((e) => e.id === site.id));

    const off = createSearchEngineStore();
    off.setAutoDiscover(false);
    const res = await discoverSiteSearchEngine({
      store: off,
      pageUrl: 'https://fr.wikipedia.org/',
      readLink: async () => assert.fail('must not read the page'),
      fetchText: async () => '',
    });
    assert.equal(res.error, 'skipped');
  });

  it('turns a site engine edited by hand into an own engine', async () => {
    const store = createSearchEngineStore();
    await discoverSiteSearchEngine({
      store,
      pageUrl: 'https://fr.wikipedia.org/',
      readLink: async () => ({ href: 'https://fr.wikipedia.org/os.xml' }),
      fetchText: async () => WIKIPEDIA_OSDD,
    });
    const site = store.list().engines.find((e) => e.kind === 'site');
    const res = store.update(site.id, { keyword: 'wiki' });
    assert.equal(res.ok, true);
    assert.equal(res.engine.kind, 'custom');
    assert.equal(res.engine.keyword, 'wiki');
  });

  it('resolveOmniboxInput searches with the given template', () => {
    assert.equal(resolveOmniboxInput('chat noir', 'https://www.ecosia.org/search?q=%s'), 'https://www.ecosia.org/search?q=chat%20noir');
    assert.equal(resolveOmniboxInput('example.com', 'https://www.ecosia.org/search?q=%s'), 'https://example.com/');
  });
});
