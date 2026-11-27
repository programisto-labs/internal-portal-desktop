/**
 * Raccourcis de la coquille du portail tapés pendant que le focus est dans une page web
 * (vue native) : la page du portail ne les voit pas. Desktop les relaie sur `browser-tab-shortcut`
 * et le portail les exécute (`DESKTOP_RELAYED_SHELL_SHORTCUTS`, components/portal-browser-tabs.tsx).
 *
 * Mêmes touches que `resolvePortalTabShortcut` (lib/portal-tabs/shortcuts.ts du portail) :
 * - ⌘1–8 / ⌘9 : onglet N / dernier onglet ;
 * - ⌃Tab, ⌃⇧Tab, ⌘⌥→ / ⌘⌥←, ⌘⇧] / ⌘⇧[ : onglet suivant / précédent ;
 * - ⌘⌥1–9 (macOS) / Ctrl+Maj+1–9 : agent N de la colonne ;
 * - ⌘D favori, ⌘Y historique, ⌘/ liste des raccourcis ;
 * - ⌘⇧A / Ctrl+Maj+A : rechercher dans les onglets (comme Chrome).
 * La touche physique (`input.code`) compte : sur un clavier AZERTY, ⌘1 donne `key` = « & ».
 */

function digitOf(input) {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(String(input.code || ''));
  if (match) return Number(match[1]);
  return /^[0-9]$/.test(String(input.key || '')) ? Number(input.key) : null;
}

/**
 * @param {{ key?: string, code?: string, meta?: boolean, control?: boolean, alt?: boolean, shift?: boolean }} input
 * @param {boolean} isMac
 * @returns {string | null} action relayed to the portal shell
 */
function resolveRelayedShellShortcut(input, isMac) {
  if (!input) return null;
  const meta = Boolean(input.meta);
  const control = Boolean(input.control);
  const alt = Boolean(input.alt);
  const shift = Boolean(input.shift);
  const mod = isMac ? meta : control;
  const key = String(input.key || '').toLowerCase();
  const digit = digitOf(input);

  if (digit !== null && digit >= 1) {
    const agentCombo = isMac ? meta && alt && !control && !shift : control && shift && !alt && !meta;
    if (agentCombo) return `agent-${digit}`;
    if (mod && !alt && !shift && !(isMac && control)) {
      return digit === 9 ? 'select-last-tab' : `select-tab-${digit}`;
    }
  }
  if (key === 'tab' && control && !meta && !alt) return shift ? 'previous-tab' : 'next-tab';
  if (!mod) return null;
  if (alt && !shift) {
    if (key === 'arrowright') return 'next-tab';
    if (key === 'arrowleft') return 'previous-tab';
    return null;
  }
  if (alt) return null;
  if (key === '/') return 'show-shortcuts';
  if (shift) {
    if (key === 'a') return 'search-tabs';
    if (input.code === 'BracketRight' || key === '}') return 'next-tab';
    if (input.code === 'BracketLeft' || key === '{') return 'previous-tab';
    return null;
  }
  if (key === 'd') return 'toggle-favorite';
  if (key === 'y') return 'open-history';
  return null;
}

module.exports = { resolveRelayedShellShortcut };
