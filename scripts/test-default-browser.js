'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyIncomingUrl,
  isDefaultBrowserAvailable,
  defaultBrowserSnapshot,
  setAsDefaultBrowser,
  createPendingWebUrls,
} = require('../src/default-browser');

function fakeApp({ isPackaged = true, defaults = [], accept = true } = {}) {
  const set = [];
  return {
    isPackaged,
    set,
    isDefaultProtocolClient: (scheme) => defaults.includes(scheme),
    setAsDefaultProtocolClient: (scheme) => {
      set.push(scheme);
      return accept;
    },
  };
}

describe('Lasco as default browser', () => {
  it('classifies URLs handed over by the OS', () => {
    assert.equal(classifyIncomingUrl('lasco://open/clad/contacts'), 'lasco');
    assert.equal(classifyIncomingUrl('https://www.google.com/search?q=x'), 'web');
    assert.equal(classifyIncomingUrl('http://example.com'), 'web');
    assert.equal(classifyIncomingUrl('file:///etc/passwd'), null);
    assert.equal(classifyIncomingUrl('javascript:alert(1)'), null);
    assert.equal(classifyIncomingUrl('not a url'), null);
  });

  it('is only offered by the installed macOS app', () => {
    assert.equal(isDefaultBrowserAvailable({ platform: 'darwin', isPackaged: true }), true);
    assert.equal(isDefaultBrowserAvailable({ platform: 'darwin', isPackaged: false }), false);
    assert.equal(isDefaultBrowserAvailable({ platform: 'win32', isPackaged: true }), false);
  });

  it('reports default only when both http and https point to Lasco', () => {
    assert.deepEqual(defaultBrowserSnapshot(fakeApp({ defaults: ['http', 'https'] }), 'darwin'), {
      available: true,
      isDefault: true,
    });
    assert.equal(defaultBrowserSnapshot(fakeApp({ defaults: ['https'] }), 'darwin').isDefault, false);
    assert.deepEqual(defaultBrowserSnapshot(fakeApp({ isPackaged: false }), 'darwin'), {
      available: false,
      isDefault: false,
    });
  });

  it('registers http and https, never from the dev binary', () => {
    const app = fakeApp();
    assert.equal(setAsDefaultBrowser(app, 'darwin'), true);
    assert.deepEqual(app.set, ['http', 'https']);
    const dev = fakeApp({ isPackaged: false });
    assert.equal(setAsDefaultBrowser(dev, 'darwin'), false);
    assert.deepEqual(dev.set, []);
  });

  it('keeps links received during startup, bounded', () => {
    const pending = createPendingWebUrls(2);
    pending.push('https://a.test');
    pending.push('https://b.test');
    pending.push('https://c.test');
    assert.deepEqual(pending.drain(), ['https://a.test', 'https://b.test']);
    assert.equal(pending.size, 0);
  });
});
