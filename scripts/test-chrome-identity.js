'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  realPlatformVersion,
  buildChromeBrands,
  buildUserAgentMetadata,
  buildClientHintHeaders,
  createClientHintPolicy,
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

  it('announces the real OS version, never a fixed one (Akamai denies a mismatch)', () => {
    assert.equal(realPlatformVersion('darwin', '15.0.0', () => '15.8.3'), '15.8.3');
    assert.equal(realPlatformVersion('darwin', '15.0.0', () => '26.1'), '26.1.0');
    assert.equal(realPlatformVersion('darwin', '15.0.0', () => ''), '15.0.0');
    assert.equal(realPlatformVersion('linux', '6.0.0', undefined, () => '6.8.0-49-generic'), '6.8.0');
    assert.equal(realPlatformVersion('win32', '19.0.0', () => '10.0.26100'), '19.0.0');
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

describe('client hints like Chrome (Accept-CH / Critical-CH)', () => {
  const meta = buildUserAgentMetadata('152.0.7977.130', 'darwin', 'arm64');
  const cloudflare = {
    'accept-ch': ['Sec-CH-UA-Bitness, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, UA-Arch'],
    'critical-ch': ['Sec-CH-UA-Bitness, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version'],
  };
  const url = 'https://www.canva.com/oauth/authorized/google?code=x';

  it('sends only the low-entropy hints to a site that asked nothing', () => {
    const policy = createClientHintPolicy({ meta });
    assert.deepEqual(Object.keys(policy.requestHeaders(url, {})).sort(), ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
    assert.equal(policy.requestHeaders('http://example.com/', {})['sec-ch-ua'], undefined);
  });

  it('replays a navigation once when Critical-CH asks for missing hints, then sends them', () => {
    const policy = createClientHintPolicy({ meta, now: () => 1000 });
    const response = { url, method: 'GET', resourceType: 'mainFrame', responseHeaders: cloudflare };
    assert.equal(policy.onResponse(response).restart, true);
    const headers = policy.requestHeaders(url, {});
    assert.equal(headers['sec-ch-ua-full-version-list'], '"Google Chrome";v="152.0.7977.130", "Chromium";v="152.0.7977.130", "Not?A_Brand";v="24.0.0.0"');
    assert.equal(headers['sec-ch-ua-arch'], '"arm"');
    assert.equal(headers['sec-ch-ua-bitness'], '"64"');
    assert.equal(headers['sec-ch-ua-model'], undefined);
    // Hints now sent: the same answer never replays again (no loop).
    assert.equal(policy.onResponse(response).restart, false);
    // Same origin only.
    assert.equal(policy.requestHeaders('https://static.canva-cdn.com/a.js', {})['sec-ch-ua-arch'], undefined);
  });

  it('never replays a POST, a subresource or a page without Critical-CH', () => {
    const policy = createClientHintPolicy({ meta });
    assert.equal(policy.onResponse({ url, method: 'POST', resourceType: 'mainFrame', responseHeaders: cloudflare }).restart, false);
    const other = createClientHintPolicy({ meta });
    assert.equal(other.onResponse({ url, method: 'GET', resourceType: 'script', responseHeaders: cloudflare }).restart, false);
    assert.equal(other.requestHeaders(url, {})['sec-ch-ua-arch'], undefined);
    const plain = createClientHintPolicy({ meta });
    assert.equal(plain.onResponse({ url, method: 'GET', resourceType: 'mainFrame', responseHeaders: { 'Accept-CH': 'Sec-CH-UA-Arch' } }).restart, false);
    assert.equal(plain.requestHeaders(url, {})['sec-ch-ua-arch'], '"arm"');
  });

  it("replaces Chromium's own brands (no Google Chrome) and keeps other headers", () => {
    const policy = createClientHintPolicy({ meta });
    const headers = policy.requestHeaders(url, { 'Sec-CH-UA': '"Chromium";v="152"', Accept: '*/*' });
    assert.equal(headers['Sec-CH-UA'], undefined);
    assert.match(headers['sec-ch-ua'], /Google Chrome/);
    assert.equal(headers.Accept, '*/*');
  });
});
