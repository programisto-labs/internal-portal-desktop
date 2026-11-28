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

  it('« Nouvelle fenêtre » (⌘N) is a real accelerator, enabled only when the page can open a window', () => {
    const fileMenu = (state, sent = []) =>
      buildApplicationMenuTemplate({
        isMac: true,
        state,
        closeTab: noop,
        closeWindow: noop,
        openSettings: noop,
        send: (command) => sent.push(command),
      }).find((m) => m.label === 'Fichier').submenu;
    assert.equal(byLabel(fileMenu(null), 'Nouvelle fenêtre').enabled, false);
    assert.equal(byLabel(fileMenu(normalizeAppMenuState({ canCreateTab: true })), 'Nouvelle fenêtre').enabled, false);
    const sent = [];
    const item = byLabel(fileMenu(normalizeAppMenuState({ canOpenWindow: true }), sent), 'Nouvelle fenêtre');
    assert.equal(item.enabled, true);
    assert.equal(item.accelerator, 'CmdOrCtrl+N');
    assert.equal(item.registerAccelerator, undefined);
    item.click();
    assert.deepEqual(sent, ['new-window']);
    assert.ok(APP_MENU_COMMANDS.includes('new-window'));
  });

  it('« Nouvelle fenêtre de navigation privée » (⌘⇧N) is opened by Desktop, without waiting for the page', () => {
    const opened = [];
    const fileMenu = buildApplicationMenuTemplate({
      isMac: false,
      state: null,
      closeTab: noop,
      closeWindow: noop,
      openSettings: noop,
      send: noop,
      openPrivateWindow: (win) => opened.push(win),
    }).find((m) => m.label === 'Fichier').submenu;
    const item = byLabel(fileMenu, 'Nouvelle fenêtre de navigation privée');
    assert.equal(item.accelerator, 'CmdOrCtrl+Shift+N');
    assert.notEqual(item.enabled, false);
    item.click(null, 'source-window');
    assert.deepEqual(opened, ['source-window']);
    // Sans le rappel (mode VM), pas d'entrée.
    const vmMenu = buildApplicationMenuTemplate({ isMac: true, state: null, closeTab: noop, closeWindow: noop, openSettings: noop, send: noop });
    assert.equal(byLabel(vmMenu.find((m) => m.label === 'Fichier').submenu, 'Nouvelle fenêtre de navigation privée'), undefined);
  });
});

describe('application menu « Présentation »', () => {
  const viewMenu = (state, sent = []) =>
    buildApplicationMenuTemplate({
      isMac: true,
      state,
      closeTab: noop,
      closeWindow: noop,
      openSettings: noop,
      send: (command) => sent.push(command),
    }).find((m) => m.label === 'Présentation');

  it("keeps Electron's window zoom for an older portal", () => {
    assert.equal(viewMenu(null).role, 'viewMenu');
    assert.equal(viewMenu(normalizeAppMenuState({ canCreateTab: true })).role, 'viewMenu');
  });

  it('relays zoom to the page when it zooms the active tab', () => {
    const sent = [];
    const menu = viewMenu(normalizeAppMenuState({ pageZoom: true }), sent);
    assert.equal(menu.role, undefined);
    const zoomItems = menu.submenu.filter((i) => typeof i.click === 'function');
    assert.deepEqual(
      zoomItems.map((i) => i.accelerator),
      ['CmdOrCtrl+0', 'CmdOrCtrl+Plus', 'CmdOrCtrl+=', 'CmdOrCtrl+-'],
    );
    for (const item of zoomItems) item.click();
    assert.deepEqual(sent, ['zoom-reset', 'zoom-in', 'zoom-in', 'zoom-out']);
    for (const command of sent) assert.ok(APP_MENU_COMMANDS.includes(command), command);
    assert.ok(menu.submenu.some((i) => i.role === 'reload'));
    assert.ok(menu.submenu.some((i) => i.role === 'togglefullscreen'));
  });
});
