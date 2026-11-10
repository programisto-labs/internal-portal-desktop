'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildTabMenuTemplate, normalizeMenuActions, TAB_MENU_ACTIONS } = require('../src/browser-tabs/tab-menu');
const { buildBrowserOpenRequest } = require('../src/link-handling');

const byLabel = (template, label) => template.find((i) => i.label === label);

describe('tab context menu template', () => {
  it('defaults to every known action and drops unknown/duplicate ones', () => {
    assert.deepEqual(normalizeMenuActions(), [...TAB_MENU_ACTIONS]);
    assert.deepEqual(normalizeMenuActions(['close', 'close', 'bogus', 'reload']), ['close', 'reload']);
  });

  it('rejects an invalid tab id', () => {
    assert.deepEqual(buildTabMenuTemplate({ tabId: '' }), []);
    assert.deepEqual(buildTabMenuTemplate({ tabId: 42 }), []);
  });

  it('disables close-others with a single tab and close-right on the last tab', () => {
    const one = buildTabMenuTemplate({ tabId: 't1', tabCount: 1, tabIndex: 0 });
    assert.equal(byLabel(one, 'Fermer les autres onglets').enabled, false);
    assert.equal(byLabel(one, 'Fermer les onglets à droite').enabled, false);
    const many = buildTabMenuTemplate({ tabId: 't1', tabCount: 30, tabIndex: 3 });
    assert.equal(byLabel(many, 'Fermer les autres onglets').enabled, true);
    assert.equal(byLabel(many, 'Fermer les onglets à droite').enabled, true);
    const last = buildTabMenuTemplate({ tabId: 't1', tabCount: 30, tabIndex: 29 });
    assert.equal(byLabel(last, 'Fermer les onglets à droite').enabled, false);
  });

  it('invokes onAction with the clicked action and honours safe custom labels', () => {
    const seen = [];
    const t = buildTabMenuTemplate({
      tabId: 't1',
      actions: ['close'],
      labels: { close: 'Close tab' },
      onAction: (a) => seen.push(a),
    });
    byLabel(t, 'Close tab').click();
    assert.deepEqual(seen, ['close']);
    const fallback = buildTabMenuTemplate({ tabId: 't1', actions: ['close'], labels: { close: 42 } });
    assert.equal(fallback.find((i) => i.click).label, "Fermer l'onglet");
  });
});

describe('browser open request', () => {
  it('asks the web UI to reveal the browser column', () => {
    assert.deepEqual(buildBrowserOpenRequest('https://example.com/'), { url: 'https://example.com/', reveal: true });
    assert.equal(buildBrowserOpenRequest(''), null);
    assert.equal(buildBrowserOpenRequest(null), null);
  });
});
