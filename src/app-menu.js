/**
 * Native application menu (menu bar). The « Fenêtre » menu repeats the options of the
 * burger menu in the internal browser bar (new tab, module search, AI chat, sidebar,
 * tab mode). The page owns the behaviour: Desktop only relays the chosen command
 * (`app-menu-command`) and redraws labels and checkmarks from the state the page reports.
 */

/** Commands Desktop may send to the page. Anything else is ignored on both sides. */
const APP_MENU_COMMANDS = Object.freeze([
  'new-tab',
  'new-window',
  'search-module',
  'toggle-assistant',
  'toggle-sidebar',
  'single-tab-mode-off',
  'single-tab-mode-on',
]);

/** Page state shown in the menu. `null` = no portal shell reported yet (login, older portal). */
function normalizeAppMenuState(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    canCreateTab: input.canCreateTab === true,
    canOpenWindow: input.canOpenWindow === true,
    assistantEnabled: input.assistantEnabled === true,
    assistantOpen: input.assistantOpen === true,
    sidebarVisible: input.sidebarVisible !== false,
    singleTabMode: input.singleTabMode === true,
  };
}

/**
 * The page already handles ⌘T / ⌘K / ⌘B / ⇧⌘B. A registered accelerator would fire a second
 * time, and ⌘B would steal bold from editors. Windows / Linux: shown, not registered
 * (`registerAccelerator: false`). macOS ignores that option, so no accelerator there.
 */
function buildWindowMenuItems({ isMac, state, send }) {
  const shown = (accelerator) => (isMac ? {} : { accelerator, registerAccelerator: false });
  const enabled = Boolean(state);
  const s = state || normalizeAppMenuState({});
  return [
    {
      label: 'Nouvel onglet',
      ...shown('CmdOrCtrl+T'),
      enabled: enabled && s.canCreateTab,
      click: () => send('new-tab'),
    },
    {
      label: 'Rechercher un module',
      ...shown('CmdOrCtrl+K'),
      enabled,
      click: () => send('search-module'),
    },
    { type: 'separator' },
    ...(s.assistantEnabled
      ? [
          {
            label: s.assistantOpen ? 'Masquer le chat IA' : 'Afficher le chat IA',
            ...shown('CmdOrCtrl+B'),
            enabled,
            click: () => send('toggle-assistant'),
          },
        ]
      : []),
    {
      label: s.sidebarVisible ? 'Masquer la barre latérale' : 'Afficher la barre latérale',
      ...shown('CmdOrCtrl+Shift+B'),
      enabled,
      click: () => send('toggle-sidebar'),
    },
    { type: 'separator' },
    {
      label: 'Mode multi-onglets',
      type: 'radio',
      checked: !s.singleTabMode,
      enabled,
      click: () => send('single-tab-mode-off'),
    },
    {
      label: 'Mode un seul onglet',
      type: 'radio',
      checked: s.singleTabMode,
      enabled,
      click: () => send('single-tab-mode-on'),
    },
  ];
}

/**
 * Full menu bar template. Callbacks are injected so the template stays testable:
 * `closeTab(win)`, `closeWindow(win)`, `openSettings()`, `send(command)`, `openPrivateWindow(win)`.
 */
function buildApplicationMenuTemplate({ isMac, state, closeTab, closeWindow, openSettings, send, openPrivateWindow }) {
  return [
    ...(isMac
      ? [
          {
            role: 'appMenu',
            submenu: [
              { role: 'about', label: 'À propos de Lasco' },
              { type: 'separator' },
              { label: 'Réglages…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
              { type: 'separator' },
              { role: 'services', label: 'Services' },
              { type: 'separator' },
              { role: 'hide', label: 'Masquer Lasco' },
              { role: 'hideOthers', label: 'Masquer les autres' },
              { role: 'unhide', label: 'Tout afficher' },
              { type: 'separator' },
              { role: 'quit', label: 'Quitter Lasco' },
            ],
          },
        ]
      : []),
    {
      label: 'Fichier',
      submenu: [
        // ⌘N / Ctrl+N : vrai raccourci natif (la page ne gère pas ⌘N). La page ouvre la fenêtre
        // sur son nouvel onglet (`tabWindows.openWindow`), comme un détachement.
        {
          label: 'Nouvelle fenêtre',
          accelerator: 'CmdOrCtrl+N',
          enabled: Boolean(state && state.canOpenWindow),
          click: () => send('new-window'),
        },
        // Navigation privée (docs/private-browsing.md) : Desktop seul, sans attendre la page du portail.
        ...(typeof openPrivateWindow === 'function'
          ? [
              {
                label: 'Nouvelle fenêtre de navigation privée',
                accelerator: 'CmdOrCtrl+Shift+N',
                click: (_item, win) => openPrivateWindow(win),
              },
            ]
          : []),
        { type: 'separator' },
        { label: "Fermer l'onglet", accelerator: 'CmdOrCtrl+W', click: (_item, win) => closeTab(win) },
        { label: 'Fermer la fenêtre', accelerator: 'CmdOrCtrl+Shift+W', click: (_item, win) => closeWindow(win) },
        // macOS : Lasco > Réglages… (⌘,). Ailleurs : Fichier > Réglages… (Ctrl+,).
        // Sans agents (#2373), les Réglages n'ont que Général et Mises à jour.
        ...(isMac
          ? []
          : [{ type: 'separator' }, { label: 'Réglages…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() }]),
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Quitter' }]),
      ],
    },
    { role: 'editMenu', label: 'Édition' },
    { role: 'viewMenu', label: 'Présentation' },
    {
      label: 'Fenêtre',
      submenu: [
        ...buildWindowMenuItems({ isMac, state, send }),
        { type: 'separator' },
        { role: 'minimize', label: 'Réduire' },
        { role: 'zoom', label: 'Zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: 'Tout ramener au premier plan' }] : []),
      ],
    },
  ];
}

module.exports = {
  APP_MENU_COMMANDS,
  normalizeAppMenuState,
  buildWindowMenuItems,
  buildApplicationMenuTemplate,
};
