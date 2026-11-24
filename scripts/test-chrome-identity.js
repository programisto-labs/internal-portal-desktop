'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildChromeBrands,
  buildUserAgentMetadata,
  buildClientHintHeaders,
  CHROME_OBJECT_SCRIPT,
  PASSKEY_FALLBACK_SCRIPT,
} = require('../src/browser-tabs/chrome-identity');

describe('browser tab Chrome identity', () => {
  it('announces Google Chrome, like branded Chrome', () => {
    assert.deepEqual(
      buildChromeBrands('152.0.7977.130').map((b) => b.brand),
      ['Google Chrome', 'Chromium', 'Not?A_Brand'],
    );
  });

  it('builds full user agent metadata', () => {
    const meta = buildUserAgentMetadata('152.0.7977.130', 'darwin', 'arm64');
    assert.equal(meta.platform, 'macOS');
    assert.equal(meta.architecture, 'arm');
    assert.equal(meta.mobile, false);
    assert.equal(meta.fullVersionList[0].version, '152.0.7977.130');
    assert.equal(buildUserAgentMetadata('152.0.1.2', 'win32', 'x64').platform, 'Windows');
  });

  it('formats Sec-CH-UA headers', () => {
    assert.deepEqual(buildClientHintHeaders('152.0.7977.130', 'darwin', 'arm64'), {
      'sec-ch-ua': '"Google Chrome";v="152", "Chromium";v="152", "Not?A_Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    });
  });

  it('fills window.chrome without throwing', () => {
    const window = { chrome: {} };
    const performance = { timeOrigin: 1000, now: () => 5 };
    new Function('window', 'performance', CHROME_OBJECT_SCRIPT)(window, performance);
    assert.equal(typeof window.chrome.csi, 'function');
    assert.equal(typeof window.chrome.loadTimes, 'function');
    assert.equal(window.chrome.app.isInstalled, false);
  });

  it('refuses passkey requests at once instead of hanging', async () => {
    const calls = [];
    const navigator = { credentials: { get: (o) => { calls.push(o); return Promise.resolve('password'); }, create: () => Promise.resolve('x') } };
    const window = { PublicKeyCredential: function PublicKeyCredential() {} };
    class DOMException extends Error {
      constructor(message, name) { super(message); this.name = name; }
    }
    new Function('navigator', 'window', 'DOMException', PASSKEY_FALLBACK_SCRIPT)(navigator, window, DOMException);
    await assert.rejects(navigator.credentials.get({ publicKey: {} }), { name: 'NotAllowedError' });
    await assert.rejects(navigator.credentials.create({ publicKey: {} }), { name: 'NotAllowedError' });
    assert.equal(await navigator.credentials.get({ password: true }), 'password');
    assert.equal(calls.length, 1);
    assert.equal(await window.PublicKeyCredential.isConditionalMediationAvailable(), false);
  });
});
