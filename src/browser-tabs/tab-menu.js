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

const TAB_MENU_ACTION_SET = new Set(TAB_MENU_ACTIONS);

const DEFAULT_LABELS = Object.freeze({
  reload: 'Actualiser',
  duplicate: 'Dupliquer',
  close: "Fermer l'onglet",
  'close-others': 'Fermer les autres onglets',
  'close-right': 'Fermer les onglets à droite',
});

function isValidTabId(tabId) {
  return typeof tabId === 'string' && tabId.length > 0 && tabId.length <= 200;
}

/** Keep only known actions, drop duplicates, preserve order. */
function normalizeMenuActions(actions) {
  const source = Array.isArray(actions) && actions.length ? actions : TAB_MENU_ACTIONS;
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
    if (action === 'close' && template.length && list.includes('close')) {
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
  normalizeMenuActions,
  buildTabMenuTemplate,
  isValidTabId,
};
