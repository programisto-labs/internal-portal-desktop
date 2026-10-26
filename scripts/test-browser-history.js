'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryStore, historyKey } = require('../src/browser-tabs/history');

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

describe('browser history store', () => {
  it('records http(s) visits only and strips fragments', () => {
    const store = createHistoryStore();
    assert.equal(store.recordVisit('https://example.com/a#top', 'A'), true);
    assert.equal(store.recordVisit('https://example.com/a#other', 'A'), true);
    assert.equal(store.recordVisit('javascript:alert(1)', 'x'), false);
    assert.equal(store.recordVisit('file:///etc/passwd', 'x'), false);
    const { items, total } = store.list();
    assert.equal(total, 1);
    assert.equal(items[0].visitCount, 2);
    assert.equal(historyKey('https://example.com/a#top'), 'https://example.com/a');
  });

  it('suggests host prefixes first, then frequent/recent pages', () => {
    let t = 1_000_000_000_000;
    const store = createHistoryStore({ now: () => t });
    store.recordVisit('https://docs.example.com/guide', 'Guide');
    store.recordVisit('https://www.example.org/', 'Example');
    store.recordVisit('https://www.example.org/', 'Example');
    store.recordVisit('https://other.net/page', 'About example things');

    const urls = store.suggest('example').map((e) => e.url);
    assert.equal(urls[0], 'https://www.example.org/');
    assert.ok(urls.includes('https://docs.example.com/guide'));
    assert.ok(urls.includes('https://other.net/page'));
    assert.deepEqual(store.suggest('zzz'), []);
    assert.deepEqual(store.suggest(''), []);
    assert.equal(store.suggest('example', 1).length, 1);
  });

  it('ignores the scheme and www when matching', () => {
    const store = createHistoryStore();
    store.recordVisit('https://www.example.org/docs', 'Docs');
    assert.equal(store.suggest('https://example.org/d').length, 1);
  });

  it('updates titles and removes entries', () => {
    const store = createHistoryStore();
    store.recordVisit('https://example.com/', '');
    assert.equal(store.updateTitle('https://example.com/', 'Home'), true);
    assert.equal(store.updateTitle('https://unknown.com/', 'Nope'), false);
    assert.equal(store.list({ query: 'home' }).total, 1);
    assert.equal(store.remove('https://example.com/'), true);
    assert.equal(store.remove('https://example.com/'), false);
    assert.equal(store.list().total, 0);
  });

  it('lists most recent first with pagination', () => {
    let t = 1000;
    const store = createHistoryStore({ now: () => t });
    for (const n of ['a', 'b', 'c']) {
      t += 10;
      store.recordVisit(`https://${n}.com/`, n);
    }
    const page = store.list({ limit: 2, offset: 1 });
    assert.equal(page.total, 3);
    assert.deepEqual(page.items.map((e) => e.title), ['b', 'a']);
  });

  it('prunes the oldest entries beyond the cap', () => {
    let t = 0;
    const store = createHistoryStore({ now: () => ++t, maxEntries: 2 });
    store.recordVisit('https://a.com/', 'a');
    store.recordVisit('https://b.com/', 'b');
    store.recordVisit('https://c.com/', 'c');
    assert.deepEqual(store.list().items.map((e) => e.title), ['c', 'b']);
  });

  it('persists on flush and reloads, tolerating corrupt files', () => {
    const fsImpl = memoryFs();
    const filePath = '/data/history.json';
    const a = createHistoryStore({ filePath, fsImpl });
    a.recordVisit('https://example.com/', 'Example');
    a.flush();
    const b = createHistoryStore({ filePath, fsImpl });
    assert.equal(b.list().items[0].title, 'Example');

    fsImpl.files.set(filePath, '{not json');
    assert.equal(createHistoryStore({ filePath, fsImpl }).list().total, 0);
  });

  it('clear empties memory and disk', () => {
    const fsImpl = memoryFs();
    const filePath = '/data/history.json';
    const store = createHistoryStore({ filePath, fsImpl });
    store.recordVisit('https://example.com/', 'Example');
    store.clear();
    assert.equal(createHistoryStore({ filePath, fsImpl }).list().total, 0);
  });
});
