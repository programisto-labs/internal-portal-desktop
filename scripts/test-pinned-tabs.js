'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isPinnedCrossSiteNavigation, normalizePinnedUrl } = require('../src/browser-tabs/pinned');
const { buildTabMenuTemplate, normalizeMenuActions } = require('../src/browser-tabs/tab-menu');

describe('pinned tabs', () => {
  it('keeps same-site navigations in the pinned tab', () => {
    assert.equal(isPinnedCrossSiteNavigation('https://mail.google.com/', 'https://accounts.google.com/x'), false);
    assert.equal(isPinnedCrossSiteNavigation('https://www.bbc.co.uk/', 'https://news.bbc.co.uk/'), false);
  });

  it('sends another site to a new tab', () => {
    assert.equal(isPinnedCrossSiteNavigation('https://mail.google.com/', 'https://example.com/'), true);
    assert.equal(isPinnedCrossSiteNavigation('https://a.github.io/', 'https://b.github.io/'), true);
  });

  it('ignores non-web addresses and invalid pinned urls', () => {
    assert.equal(isPinnedCrossSiteNavigation('https://example.com/', 'about:blank'), false);
    assert.equal(normalizePinnedUrl('javascript:alert(1)'), null);
    assert.equal(normalizePinnedUrl(42), null);
    assert.equal(normalizePinnedUrl('https://example.com/a'), 'https://example.com/a');
  });

  it('shows pin entries only when the page sends them, with their own group', () => {
    assert.equal(normalizeMenuActions().includes('pin'), false);
    const template = buildTabMenuTemplate({
      tabId: 't1',
      actions: ['reload', 'unpin', 'pinned-url', 'close'],
      onAction: () => {},
    });
    const labels = template.map((item) => item.label || item.type);
    assert.deepEqual(labels, ['Actualiser', 'separator', "Détacher l'épingle", "Revenir à l'URL épinglée", 'separator', "Fermer l'onglet"]);
  });
});
