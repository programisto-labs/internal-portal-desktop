'use strict';

/**
 * Native tab context menu. Browser tabs are native WebContentsViews stacked above the
 * portal HTML, so an HTML menu can never be drawn over them. A native menu is always
 * rendered above every view and is not clipped by the window edges.
 */

const TAB_MENU_ACTIONS = Object.freeze([
  'reload',
  'duplicate',
  'close',
  'close-others',
  'close-right',
]);

/** Window actions, shown only when the page handles them (`windowActions: true`). */
const TAB_WINDOW_ACTIONS = Object.freeze(['detach', 'attach']);

/** Son de l'onglet : seulement quand la page les demande (onglet qui joue du son ou coupé). */
const TAB_SOUND_ACTIONS = Object.freeze(['mute', 'unmute']);

/** « Incruster l'onglet » (docs/picture-in-picture.md) : seulement quand la page le demande. */
const TAB_PIP_ACTIONS = Object.freeze(['picture-in-picture']);

/** Onglets épinglés : seulement quand la page les demande (docs/pinned-tabs.md). */
const TAB_PIN_ACTIONS = Object.freeze(['pin', 'unpin', 'pinned-url']);

const TAB_MENU_ACTION_SET = new Set([
  ...TAB_MENU_ACTIONS,
  ...TAB_WINDOW_ACTIONS,
  ...TAB_SOUND_ACTIONS,
  ...TAB_PIP_ACTIONS,
  ...TAB_PIN_ACTIONS,
]);

const DEFAULT_LABELS = Object.freeze({
  reload: 'Actualiser',
  duplicate: 'Dupliquer',
  mute: "Couper le son de l'onglet",
  unmute: "Réactiver le son de l'onglet",
  'picture-in-picture': "Incruster l'onglet",
  close: "Fermer l'onglet",
  'close-others': 'Fermer les autres onglets',
  'close-right': 'Fermer les onglets à droite',
  detach: 'Détacher dans une nouvelle fenêtre',
  attach: 'Rattacher à la fenêtre principale',
  pin: 'Épingler',
  unpin: "Détacher l'épingle",
  'pinned-url': "Revenir à l'URL épinglée",
});

/**
 * Menu actions for a window. `windowActions` is true only when the page handles
 * detach / attach (older portal builds never receive them).
 * - Main window: « Détacher » (needs another tab to keep the window open).
 * - Detached window: « Rattacher », and « Détacher » when it holds several tabs.
 */
function resolveWindowMenuActions({ actions, windowActions, role, tabCount }) {
  const base = normalizeMenuActions(actions).filter((a) => !TAB_WINDOW_ACTIONS.includes(a));
  if (!windowActions) return base;
  const count = Number.isFinite(tabCount) ? tabCount : 1;
  const extra = [];
  if (role === 'detached') {
    extra.push('attach');
    if (count > 1) extra.push('detach');
  } else if (count > 1) {
    extra.push('detach');
  }
  if (!extra.length) return base;
  // Window actions sit right before the « Fermer… » group.
  const closeIndex = base.indexOf('close');
  const at = closeIndex < 0 ? base.length : closeIndex;
  return [...base.slice(0, at), ...extra, ...base.slice(at)];
}

function isValidTabId(tabId) {
  return typeof tabId === 'string' && tabId.length > 0 && tabId.length <= 200;
}

/** Keep only known actions, drop duplicates, preserve order. */
function normalizeMenuActions(actions) {
  const source = Array.isArray(actions) && actions.length ? actions : TAB_MENU_ACTIONS;
  // Window actions are only added by resolveWindowMenuActions.
  const seen = new Set();
  const out = [];
  for (const action of source) {
    if (TAB_MENU_ACTION_SET.has(action) && !seen.has(action)) {
      seen.add(action);
      out.push(action);
    }
  }
  return out;
}

/** Sanitize renderer-provided labels (strings only, bounded length). */
function resolveLabel(action, labels) {
  const custom = labels && typeof labels === 'object' ? labels[action] : null;
  if (typeof custom === 'string' && custom.trim() && custom.length <= 80) return custom.trim();
  return DEFAULT_LABELS[action];
}

/** Separators between page actions, window actions and « Fermer… » actions. */
function menuGroup(action) {
  if (TAB_WINDOW_ACTIONS.includes(action)) return 'window';
  if (TAB_PIN_ACTIONS.includes(action)) return 'pin';
  if (action === 'close' || action === 'close-others' || action === 'close-right') return 'close';
  return 'page';
}

/**
 * Build a menu template. `onAction(action)` is invoked on click.
 * Items that cannot apply are disabled (e.g. "close others" with a single tab).
 */
function buildTabMenuTemplate({ tabId, actions, labels, tabCount = 1, tabIndex = 0, onAction }) {
  if (!isValidTabId(tabId)) return [];
  const list = normalizeMenuActions(actions);
  const count = Number.isFinite(tabCount) ? tabCount : 1;
  const index = Number.isFinite(tabIndex) ? tabIndex : 0;
  const template = [];
  for (const action of list) {
    let enabled = true;
    if (action === 'close-others') enabled = count > 1;
    if (action === 'close-right') enabled = index < count - 1;
    const previous = template.length ? list[list.indexOf(action) - 1] : null;
    if (previous && menuGroup(previous) !== menuGroup(action)) {
      template.push({ type: 'separator' });
    }
    template.push({
      label: resolveLabel(action, labels),
      enabled,
      click: () => {
        if (typeof onAction === 'function') onAction(action);
      },
    });
  }
  return template;
}

module.exports = {
  TAB_MENU_ACTIONS,
  TAB_WINDOW_ACTIONS,
  TAB_SOUND_ACTIONS,
  TAB_PIN_ACTIONS,
  resolveWindowMenuActions,
  normalizeMenuActions,
  buildTabMenuTemplate,
  isValidTabId,
};
