'use strict';

/**
 * Lasco en arrière-plan et raccourcis globaux (docs/background.md).
 *
 * - Fermer la fenêtre principale la masque (macOS, avec l'icône de la barre des menus) :
 *   le portail continue de tourner (agents, validations, notifications, icône à jour).
 * - Deux raccourcis globaux modifiables : afficher / masquer Lasco, « Demander à Lasco ».
 *
 * Ce module ne dépend pas d'Electron : validation et affichage des raccourcis, testés seuls.
 * Un raccourci est un accelerator Electron canonique (« Alt+Shift+L ») ou '' (désactivé).
 */

const SHORTCUT_IDS = Object.freeze(['toggleWindow', 'ask']);

const DEFAULT_SHORTCUTS = Object.freeze({
  toggleWindow: 'Alt+Shift+L',
  ask: 'Alt+Shift+Space',
});

/** Ordre canonique des modificateurs (celui de macOS : ⌃⌥⇧⌘). */
const MODIFIERS = Object.freeze(['Control', 'Alt', 'Shift', 'Command']);

const NAMED_KEYS = Object.freeze([
  'Space', 'Return', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'Up', 'Down', 'Left', 'Right',
]);
const PUNCTUATION_KEYS = Object.freeze(['-', '=', '[', ']', ';', "'", ',', '.', '/', '`', '\\']);

/** Touches physiques (`KeyboardEvent.code`) → touche d'accelerator. */
const CODE_TO_KEY = Object.freeze({
  Space: 'Space',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Backslash: '\\',
});

/** Raccourcis du système ou de l'app : jamais pris par Lasco. */
const RESERVED = Object.freeze([
  'Command+Q', 'Command+W', 'Command+H', 'Command+M', 'Command+Tab', 'Command+Space', 'Control+Space',
  'Alt+Command+Space', 'Shift+Command+3', 'Shift+Command+4', 'Shift+Command+5',
  'Control+Command+Q', 'Control+Command+Space', 'Control+Command+F',
  'Alt+F4', 'Alt+Tab', 'Control+Alt+Delete', 'Control+Shift+Escape',
]);

function isFunctionKey(key) {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

function isKnownKey(key) {
  return (
    /^[A-Z]$/.test(key) ||
    /^[0-9]$/.test(key) ||
    isFunctionKey(key) ||
    NAMED_KEYS.includes(key) ||
    PUNCTUATION_KEYS.includes(key)
  );
}

function canonical(modifiers, key) {
  return [...MODIFIERS.filter((m) => modifiers.has(m)), key].join('+');
}

/**
 * Lit un accelerator et le remet en forme canonique.
 * @returns {string | null} null si invalide (touche inconnue, modificateur inconnu ou répété, aucun modificateur).
 */
function parseAccelerator(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  // « Alt+- » ou « Alt++ » : la touche est le dernier élément, même si c'est un « + » (non accepté).
  const parts = value.split('+');
  const key = parts.pop();
  if (!isKnownKey(key)) return null;
  const modifiers = new Set();
  for (const raw of parts) {
    const m = { Cmd: 'Command', Ctrl: 'Control', Option: 'Alt' }[raw] || raw;
    if (!MODIFIERS.includes(m) || modifiers.has(m)) return null;
    modifiers.add(m);
  }
  // Une touche seule (ou avec Maj seulement) taperait dans toutes les apps : il faut ⌘, ⌃ ou ⌥ (sauf F1–F24).
  const strong = modifiers.has('Command') || modifiers.has('Control') || modifiers.has('Alt');
  if (!strong && !isFunctionKey(key)) return null;
  return canonical(modifiers, key);
}

/**
 * Accelerator à partir d'une frappe (enregistrement dans les Réglages).
 * La touche vient de `code` (position physique) : c'est aussi ce qu'Electron enregistre.
 * @returns {{ accelerator: string } | { error: 'modifier-only' | 'unsupported-key' | 'needs-modifier' }}
 */
function acceleratorFromKeyEvent(event, { isMac = process.platform === 'darwin' } = {}) {
  if (!event || typeof event !== 'object') return { error: 'unsupported-key' };
  const code = typeof event.code === 'string' ? event.code : '';
  if (/^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/.test(code)) return { error: 'modifier-only' };
  let key = null;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) key = m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) key = m[1];
  if (isFunctionKey(code)) key = code;
  if (!key && CODE_TO_KEY[code]) key = CODE_TO_KEY[code];
  if (!key) return { error: 'unsupported-key' };

  const modifiers = new Set();
  if (event.ctrlKey) modifiers.add('Control');
  if (event.altKey) modifiers.add('Alt');
  if (event.shiftKey) modifiers.add('Shift');
  // ⊞ Windows n'est pas proposé ; sur macOS ⌘ est la touche Command.
  if (event.metaKey && isMac) modifiers.add('Command');
  const accelerator = parseAccelerator(canonical(modifiers, key));
  return accelerator ? { accelerator } : { error: 'needs-modifier' };
}

function isReservedAccelerator(accelerator) {
  return RESERVED.includes(accelerator);
}

const MAC_SYMBOLS = Object.freeze({ Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' });
const OTHER_LABELS = Object.freeze({ Control: 'Ctrl', Alt: 'Alt', Shift: 'Maj', Command: 'Win' });
const KEY_LABELS = Object.freeze({
  Space: 'Espace',
  Return: '↩',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Home: '↖',
  End: '↘',
  PageUp: '⇞',
  PageDown: '⇟',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
});

/** Libellé affiché : « ⌥⇧L » sur macOS, « Alt+Maj+L » ailleurs. '' si vide ou invalide. */
function formatAccelerator(value, { isMac = process.platform === 'darwin' } = {}) {
  const accelerator = parseAccelerator(value);
  if (!accelerator) return '';
  const parts = accelerator.split('+');
  const key = parts.pop();
  const keyLabel = KEY_LABELS[key] || key;
  if (isMac) return `${parts.map((p) => MAC_SYMBOLS[p]).join('')}${key === 'Space' ? ' ' : ''}${keyLabel}`;
  return [...parts.map((p) => OTHER_LABELS[p]), keyLabel].join('+');
}

/** Raccourcis enregistrés : valeur valide, '' (désactivé) ou valeur par défaut. */
function normalizeShortcuts(raw) {
  const out = { ...DEFAULT_SHORTCUTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const id of SHORTCUT_IDS) {
    if (raw[id] === '') out[id] = '';
    else if (typeof raw[id] === 'string') out[id] = parseAccelerator(raw[id]) || DEFAULT_SHORTCUTS[id];
  }
  // Deux actions sur la même combinaison : la seconde est désactivée.
  if (out.toggleWindow && out.toggleWindow === out.ask) out.ask = '';
  return out;
}

/**
 * Nouveau raccourci pour une action, vérifié avant d'être enregistré.
 * @param {string | null} value accelerator, '' pour désactiver, null pour la valeur par défaut
 * @returns {{ ok: true, shortcuts: object } | { ok: false, error: 'unknown-action' | 'invalid' | 'reserved' | 'duplicate' }}
 */
function updateShortcut(shortcuts, id, value) {
  if (!SHORTCUT_IDS.includes(id)) return { ok: false, error: 'unknown-action' };
  let next;
  if (value === null) next = DEFAULT_SHORTCUTS[id];
  else if (value === '') next = '';
  else {
    next = parseAccelerator(value);
    if (!next) return { ok: false, error: 'invalid' };
    if (isReservedAccelerator(next)) return { ok: false, error: 'reserved' };
  }
  const current = normalizeShortcuts(shortcuts);
  if (next && SHORTCUT_IDS.some((other) => other !== id && current[other] === next)) {
    return { ok: false, error: 'duplicate' };
  }
  return { ok: true, shortcuts: { ...current, [id]: next } };
}

module.exports = {
  SHORTCUT_IDS,
  DEFAULT_SHORTCUTS,
  parseAccelerator,
  acceleratorFromKeyEvent,
  isReservedAccelerator,
  formatAccelerator,
  normalizeShortcuts,
  updateShortcut,
};
