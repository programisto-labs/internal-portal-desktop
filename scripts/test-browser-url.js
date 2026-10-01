'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeUrl,
  resolveOmniboxInput,
  sanitizeBrowserUrl,
  isSafeBrowserUrl,
} = require('../src/browser-tabs/url');

describe('desktop browser url helpers', () => {
  it('accepts only http(s)', () => {
    assert.equal(sanitizeBrowserUrl('https://example.com'), 'https://example.com/');
    assert.equal(sanitizeBrowserUrl('javascript:alert(1)'), null);
    assert.equal(sanitizeBrowserUrl('file:///tmp/x'), null);
    assert.equal(isSafeBrowserUrl('http://127.0.0.1:3000'), true);
  });

  it('resolves omnibox input to URL or Google search', () => {
    assert.equal(looksLikeUrl('example.com'), true);
    assert.equal(resolveOmniboxInput('example.com/a'), 'https://example.com/a');
    assert.equal(
      resolveOmniboxInput('hello world'),
      `https://www.google.com/search?q=${encodeURIComponent('hello world')}`,
    );
    assert.equal(resolveOmniboxInput(''), null);
  });
});
