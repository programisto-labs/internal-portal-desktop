'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { httpsUpgradeUrl, isUpgradeableHost, createHttpsFirst, DOWNGRADE_WINDOW_MS } = require('../src/browser-tabs/https-first');

describe('httpsUpgradeUrl', () => {
  it('upgrades public http sites, keeps path and query', () => {
    assert.equal(httpsUpgradeUrl('http://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  });
  it('never local, intranet, IP, explicit port or non-http', () => {
    for (const url of [
      'http://localhost:3001/',
      'http://intranet/',
      'http://nas.local/',
      'http://app.test/',
      'http://192.168.1.10/',
      'http://[::1]/',
      'http://example.com:8080/',
      'https://example.com/',
      'ftp://example.com/',
      'not a url',
    ]) {
      assert.equal(httpsUpgradeUrl(url), null, url);
    }
    assert.equal(isUpgradeableHost('printer.corp'), false);
  });
});

describe('createHttpsFirst', () => {
  it('upgrade, then fallback to http on failure and remember the site', () => {
    const h = createHttpsFirst({ isEnabled: () => true });
    const target = h.upgrade('http://old-site.org/page');
    assert.equal(target, 'https://old-site.org/page');
    assert.equal(h.fallbackFor(target), 'http://old-site.org/page');
    assert.equal(h.fallbackFor(target), null);
    assert.equal(h.upgrade('http://old-site.org/other'), null);
    assert.equal(h.isException('old-site.org'), true);
  });
  it('a redirect back to http (before the https page shows) stops the loop', () => {
    let t = 0;
    const h = createHttpsFirst({ isEnabled: () => true, now: () => t });
    assert.ok(h.upgrade('http://loop-site.org/'));
    t = 200;
    assert.equal(h.upgrade('http://loop-site.org/'), null);
    assert.equal(h.isException('loop-site.org'), true);
  });
  it('after a successful upgrade, later http links on the site are upgraded too', () => {
    let t = 0;
    const h = createHttpsFirst({ isEnabled: () => true, now: () => t });
    const target = h.upgrade('http://ok-site.org/');
    h.committed(target);
    t = 100;
    assert.equal(h.upgrade('http://ok-site.org/next'), 'https://ok-site.org/next');
    t += DOWNGRADE_WINDOW_MS + 1;
    assert.equal(h.isException('ok-site.org'), false);
  });
  it('disabled: nothing is upgraded', () => {
    const h = createHttpsFirst({ isEnabled: () => false });
    assert.equal(h.upgrade('http://example.com/'), null);
  });
});
