'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildApplicationMenuTemplate, normalizeAppMenuState, APP_MENU_COMMANDS } = require('../src/app-menu');

const noop = () => undefined;
const windowMenu = (state, sent = [], isMac = true) =>
  buildApplicationMenuTemplate({
    isMac,
    state,
    closeTab: noop,
    closeWindow: noop,
    openSettings: noop,
    send: (command) => sent.push(command),
  }).find((m) => m.label === 'Fenêtre').submenu;
const byLabel = (items, label) => items.find((i) => i.label === label);

describe('application menu « Fenêtre »', () => {
  it('disables the portal items until the page reports its state', () => {
    const items = windowMenu(null);
    assert.equal(byLabel(items, 'Nouvel onglet').enabled, false);
    assert.equal(byLabel(items, 'Rechercher un module').enabled, false);
    assert.equal(byLabel(items, 'Afficher le chat IA'), undefined);
    assert.ok(byLabel(items, 'Réduire'));
  });

  it('mirrors labels and checkmarks from the page state', () => {
    const items = windowMenu(
      normalizeAppMenuState({
        canCreateTab: true,
        assistantEnabled: true,
        assistantOpen: true,
        sidebarVisible: false,
        singleTabMode: true,
      }),
    );
    assert.equal(byLabel(items, 'Nouvel onglet').enabled, true);
    assert.ok(byLabel(items, 'Masquer le chat IA'));
    assert.ok(byLabel(items, 'Afficher la barre latérale'));
    assert.equal(byLabel(items, 'Mode un seul onglet').checked, true);
    assert.equal(byLabel(items, 'Mode multi-onglets').checked, false);
  });

  it('never registers accelerators for page commands (the page handles the keys)', () => {
    const state = normalizeAppMenuState({ canCreateTab: true, assistantEnabled: true });
    const pageItems = (items) => items.filter((i) => typeof i.click === 'function');
    for (const item of pageItems(windowMenu(state, [], true))) assert.equal(item.accelerator, undefined, item.label);
    const others = pageItems(windowMenu(state, [], false)).filter((i) => i.accelerator);
    assert.ok(others.length > 0);
    for (const item of others) assert.equal(item.registerAccelerator, false, item.label);
  });

  it('relays only known commands', () => {
    const sent = [];
    const items = windowMenu(normalizeAppMenuState({ canCreateTab: true, assistantEnabled: true }), sent);
    for (const item of items.filter((i) => typeof i.click === 'function')) item.click();
    assert.ok(sent.length > 0);
    for (const command of sent) assert.ok(APP_MENU_COMMANDS.includes(command), command);
  });
});
