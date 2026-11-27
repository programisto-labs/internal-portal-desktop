'use strict';

/**
 * Mise en veille des onglets web (économiseur de mémoire, comme Chrome). Docs : docs/tab-sleep.md.
 *
 * Un onglet web caché depuis le délai réglé voit sa WebContentsView détruite (le processus de rendu
 * et sa mémoire sont libérés). L'onglet garde son URL, son titre, son icône, son historique et sa
 * position de défilement ; il se recharge quand on le sélectionne. Module pur : le gestionnaire
 * d'onglets (manager.js) lui fournit l'état de chaque onglet.
 */

/** Délais proposés dans Réglages > Économiseur de mémoire (minutes ; 0 = jamais). */
const TAB_SLEEP_DELAY_CHOICES = Object.freeze([0, 5, 15, 30, 60, 120, 240]);
const DEFAULT_TAB_SLEEP_MINUTES = 30;
/** Sites à ne jamais mettre en veille : au plus 200, 253 caractères chacun. */
const MAX_NEVER_SITES = 200;

/**
 * Hôte normalisé d'une saisie « Ajouter un site » : `https://www.figma.com/file/…`, `figma.com`,
 * `*.figma.com` → `figma.com` ; `localhost:3001` → `localhost:3001`. Null si illisible.
 */
function normalizeSiteHost(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^\*\./, '');
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    let host = url.host.replace(/^www\./, '');
    if (!host || host.length > 253 || !/^[a-z0-9.-]+(:\d+)?$/.test(host) || host.startsWith('.')) return null;
    return host;
  } catch (_) {
    return null;
  }
}

/** Réglages lus dans settings.json : `tabSleepMinutes` (0 = jamais), `tabSleepNeverSites` (hôtes). */
function normalizeTabSleepSettings(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const minutes = TAB_SLEEP_DELAY_CHOICES.includes(obj.tabSleepMinutes)
    ? obj.tabSleepMinutes
    : DEFAULT_TAB_SLEEP_MINUTES;
  const sites = [];
  for (const site of Array.isArray(obj.tabSleepNeverSites) ? obj.tabSleepNeverSites : []) {
    const host = normalizeSiteHost(site);
    if (host && !sites.includes(host)) sites.push(host);
    if (sites.length >= MAX_NEVER_SITES) break;
  }
  return { tabSleepMinutes: minutes, tabSleepNeverSites: sites };
}

/** Un site de la liste couvre son hôte et ses sous-domaines (`figma.com` → `www.figma.com`). */
function isNeverSleepSite(url, sites) {
  if (!Array.isArray(sites) || sites.length === 0) return false;
  let host;
  let hostname;
  try {
    const parsed = new URL(url);
    host = parsed.host.toLowerCase();
    hostname = parsed.hostname.toLowerCase();
  } catch (_) {
    return false;
  }
  return sites.some((site) => {
    if (site.includes(':')) return host === site;
    return hostname === site || hostname.endsWith(`.${site}`);
  });
}

/**
 * Délai effectif en ms. `LASCO_TAB_SLEEP_MS` (environnement, développement et tests) l'emporte
 * sur le réglage, pour vérifier la mise en veille sans attendre 30 min.
 */
function resolveTabSleepDelayMs(settings, env = process.env) {
  const override = Number(env && env.LASCO_TAB_SLEEP_MS);
  if (Number.isFinite(override) && override > 0) return Math.max(1000, Math.round(override));
  const { tabSleepMinutes } = normalizeTabSleepSettings(settings);
  return tabSleepMinutes * 60 * 1000;
}

/** Raison pour laquelle un onglet reste éveillé, ou null s'il peut dormir. */
function tabSleepBlocker(tab, { now, delayMs, activeTabId, neverSites }) {
  if (!tab || tab.discarded) return 'discarded';
  if (!(delayMs > 0)) return 'disabled';
  if (tab.tabId === activeTabId) return 'active';
  if (typeof tab.hiddenSince !== 'number') return 'shown';
  if (now - tab.hiddenSince < delayMs) return 'recent';
  if (tab.audible) return 'audible';
  if (tab.htmlFullscreen) return 'fullscreen';
  if (tab.agentControlled) return 'agent';
  // Fenêtre ouverte par une page (`window.open`) : la détruire couperait `opener` (connexion OAuth).
  if (tab.hasOpener) return 'opener';
  if (tab.devToolsOpened) return 'devtools';
  if (tab.loading) return 'loading';
  if (tab.capturingMedia) return 'media';
  if (!/^https?:\/\//i.test(tab.url || '')) return 'not-web';
  if (isNeverSleepSite(tab.url, neverSites)) return 'never-site';
  return null;
}

/**
 * Onglets à mettre en veille maintenant. `tabs` : `{ tabId, url, hiddenSince, audible, htmlFullscreen,
 * agentControlled, hasOpener, devToolsOpened, loading, capturingMedia, discarded }`. Le formulaire modifié
 * est vérifié ensuite dans la page (PAGE_SLEEP_PROBE_SCRIPT), juste avant de détruire la vue.
 */
function selectTabsToSleep(tabs, options) {
  const out = [];
  for (const tab of tabs || []) {
    if (tabSleepBlocker(tab, options) === null) out.push(tab.tabId);
  }
  return out;
}

/** Fréquence du relevé : le quart du délai, entre 1 s et 1 min. */
function tabSleepCheckIntervalMs(delayMs) {
  return Math.max(1000, Math.min(60_000, Math.floor(delayMs / 4)));
}

/**
 * Monde isolé du preload des onglets web (Electron : 999). Le relevé y tourne pour lire les champs
 * modifiés par la personne, notés par password-preload.js (`__lascoSleepEditedFields`).
 */
const PRELOAD_WORLD_ID = 999;

/**
 * Relevé d'avant veille : position de défilement et saisie en cours. Seuls comptent les champs
 * modifiés par la personne (pas une case cochée par un script de la page) dont la valeur diffère
 * encore de la valeur initiale ; un champ vidé, un formulaire envoyé ne comptent plus.
 */
const PAGE_SLEEP_PROBE_SCRIPT = `(() => {
  const edited = globalThis.__lascoSleepEditedFields;
  const isDirty = (el) => {
    if (!el || !el.isConnected || el.disabled) return false;
    if (el.isContentEditable && !('value' in el)) return Boolean((el.textContent || '').trim());
    if (el.tagName === 'SELECT') return [...el.options].some((o) => o.selected !== o.defaultSelected);
    const type = (el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return el.checked !== el.defaultChecked;
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file', 'search'].includes(type)) return false;
    return el.value !== el.defaultValue && String(el.value).trim() !== '';
  };
  const dirty = edited instanceof Set ? [...edited].some(isDirty) : false;
  return { dirty, tracked: edited instanceof Set, scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 };
})()`;

module.exports = {
  TAB_SLEEP_DELAY_CHOICES,
  DEFAULT_TAB_SLEEP_MINUTES,
  MAX_NEVER_SITES,
  PAGE_SLEEP_PROBE_SCRIPT,
  PRELOAD_WORLD_ID,
  normalizeSiteHost,
  normalizeTabSleepSettings,
  isNeverSleepSite,
  resolveTabSleepDelayMs,
  tabSleepBlocker,
  selectTabsToSleep,
  tabSleepCheckIntervalMs,
};
