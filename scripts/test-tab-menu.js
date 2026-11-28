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

  it('adds mute / unmute only when the page asks for it', () => {
    assert.equal(normalizeMenuActions().includes('mute'), false);
    assert.deepEqual(normalizeMenuActions(['reload', 'mute', 'close']), ['reload', 'mute', 'close']);
    const template = buildTabMenuTemplate({ tabId: 't1', actions: ['unmute', 'close'], onAction: () => {} });
    assert.ok(byLabel(template, "Réactiver le son de l'onglet"));
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

describe('« Incruster l’onglet »', () => {
  it('est gardé quand la page le demande, avec son libellé par défaut', () => {
    assert.deepEqual(normalizeMenuActions(['reload', 'picture-in-picture', 'close']), ['reload', 'picture-in-picture', 'close']);
    const template = buildTabMenuTemplate({ tabId: 't1', actions: ['picture-in-picture'], onAction: () => {} });
    assert.ok(byLabel(template, "Incruster l'onglet"));
  });
});
