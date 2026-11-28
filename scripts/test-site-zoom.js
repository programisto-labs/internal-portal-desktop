'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSiteZoomStore,
  normalizeZoomFactor,
  nextZoomFactor,
  zoomSiteOf,
} = require('../src/browser-tabs/site-zoom');
const { pdfFilename } = require('../src/browser-tabs/page-pdf');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-zoom-')), 'browser-site-zoom.json');

describe('site zoom', () => {
  it('keys a page by its host, http(s) only', () => {
    assert.equal(zoomSiteOf('https://WWW.Example.com:8443/a?b#c'), 'www.example.com');
    assert.equal(zoomSiteOf('http://localhost:3000/'), 'localhost');
    assert.equal(zoomSiteOf('about:blank'), null);
    assert.equal(zoomSiteOf('data:text/html,x'), null);
    assert.equal(zoomSiteOf('not a url'), null);
  });

  it('snaps to Chrome levels', () => {
    assert.equal(normalizeZoomFactor(1.24), 1.25);
    assert.equal(normalizeZoomFactor(9), 5);
    assert.equal(normalizeZoomFactor(-1), null);
    assert.equal(nextZoomFactor(1, 'in'), 1.1);
    assert.equal(nextZoomFactor(1.25, 'reset'), 1);
  });

  it('remembers a zoom per site across restarts, forgets 100 %', () => {
    const filePath = tmpFile();
    const store = createSiteZoomStore({ filePath });
    assert.equal(store.get('https://example.com/'), 1);
    assert.equal(store.set('https://example.com/page', 1.25), true);
    assert.equal(store.get('https://example.com/other'), 1.25);
    assert.equal(store.get('https://sub.example.com/'), 1, 'another host keeps 100 %');

    const reopened = createSiteZoomStore({ filePath });
    assert.equal(reopened.get('https://example.com/x'), 1.25);
    reopened.set('https://example.com/', 1);
    assert.deepEqual(createSiteZoomStore({ filePath }).list(), []);
  });

  it('ignores pages without a site and invalid files', () => {
    const filePath = tmpFile();
    fs.writeFileSync(filePath, '{"sites":{"example.com":"x","ok.com":1.5,"zero.com":1}}');
    const store = createSiteZoomStore({ filePath });
    assert.deepEqual(store.list(), [{ host: 'ok.com', factor: 1.5 }]);
    assert.equal(store.set('about:blank', 2), false);
  });

  it('keeps a private window in memory only', () => {
    const store = createSiteZoomStore({});
    store.set('https://example.com/', 2);
    assert.equal(store.get('https://example.com/'), 2);
  });

  it('notifies other tabs of the site, bounded size', () => {
    const store = createSiteZoomStore({ maxSites: 2 });
    const seen = [];
    const off = store.subscribe((change) => seen.push(change));
    store.set('https://a.com/', 1.1);
    store.set('https://b.com/', 1.25);
    store.set('https://c.com/', 1.5);
    off();
    store.set('https://a.com/', 2);
    assert.deepEqual(seen.map((c) => c.host), ['a.com', 'b.com', 'c.com']);
    assert.deepEqual(store.list().map((s) => s.host), ['c.com', 'a.com']);
  });
});

describe('PDF file name', () => {
  it('uses the page title, like Chrome', () => {
    assert.equal(pdfFilename({ url: 'https://ex.com/', title: 'Rapport : Q3 / 2026' }), 'Rapport - Q3 - 2026.pdf');
  });
  it('falls back to the host, then « page »', () => {
    assert.equal(pdfFilename({ url: 'https://www.ex.com/a', title: 'https://www.ex.com/a' }), 'ex.com.pdf');
    assert.equal(pdfFilename({}), 'page.pdf');
  });
});
