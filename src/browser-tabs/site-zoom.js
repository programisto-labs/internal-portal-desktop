'use strict';

/**
 * Zoom retenu par site, comme Chrome (docs/zoom-and-pdf.md) : un niveau par hôte
 * (`www.example.com`), appliqué à chaque page de cet hôte, dans tous les onglets et toutes
 * les fenêtres, gardé d'un lancement à l'autre (`userData/browser-site-zoom.json`).
 * 100 % n'est pas enregistré. Fenêtre privée : en mémoire seulement (pas de `filePath`).
 */

const fs = require('fs');
const path = require('path');

/** Échelle de Chrome. */
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
/** Sites retenus au plus (les plus anciens sortent). */
const MAX_SITES = 500;

function isDefaultZoom(factor) {
  return Math.abs((Number(factor) || 1) - 1) < 0.001;
}

/** Niveau de l'échelle le plus proche ; `null` pour une valeur invalide. */
function normalizeZoomFactor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return ZOOM_LEVELS.reduce((best, level) => (Math.abs(level - n) < Math.abs(best - n) ? level : best), 1);
}

/** Niveau suivant dans l'échelle (`in` / `out`), 100 % pour `reset`. */
function nextZoomFactor(current, direction) {
  if (direction === 'reset') return 1;
  if (direction === 'in') return ZOOM_LEVELS.find((level) => level > current + 0.001) ?? ZOOM_LEVELS.at(-1);
  return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? ZOOM_LEVELS[0];
}

/** Hôte d'une page http(s) (minuscules, sans port) ; `null` sinon (about:, data:, fichier…). */
function zoomSiteOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase() || null;
  } catch (_) {
    return null;
  }
}

function createSiteZoomStore({ filePath = null, fsImpl = fs, maxSites = MAX_SITES } = {}) {
  /** hôte → facteur, dans l'ordre d'usage (le plus récent en dernier). */
  let sites = null;
  const listeners = new Set();
  const notify = (host, factor) => {
    for (const listener of listeners) {
      try {
        listener({ host, factor });
      } catch (_) {
        // Un abonné en erreur ne bloque pas les autres.
      }
    }
  };

  function load() {
    if (sites) return sites;
    sites = new Map();
    if (!filePath) return sites;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      const entries = raw && typeof raw.sites === 'object' && raw.sites ? raw.sites : {};
      for (const [host, value] of Object.entries(entries)) {
        const factor = normalizeZoomFactor(value);
        if (!zoomSiteOf(`https://${host}/`) || factor === null || isDefaultZoom(factor)) continue;
        sites.set(host, factor);
      }
    } catch (_) {
      // Fichier absent ou illisible : tous les sites à 100 %.
    }
    return sites;
  }

  function save() {
    if (!filePath) return;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, sites: Object.fromEntries(load()) }));
      fsImpl.renameSync(tmp, filePath);
    } catch (_) {
      // Non enregistré : le zoom vaut jusqu'au redémarrage.
    }
  }

  return {
    /** Facteur retenu pour la page (1 sans réglage). */
    get(url) {
      const host = zoomSiteOf(url);
      return (host && load().get(host)) || 1;
    },
    /** Retient le facteur du site de la page ; 100 % l'oublie. Faux si rien n'a changé. */
    set(url, factor) {
      const host = zoomSiteOf(url);
      const next = normalizeZoomFactor(factor);
      if (!host || next === null) return false;
      const map = load();
      const previous = map.get(host) || 1;
      map.delete(host);
      if (!isDefaultZoom(next)) {
        map.set(host, next);
        while (map.size > maxSites) map.delete(map.keys().next().value);
      }
      if (Math.abs(previous - next) < 0.001 && isDefaultZoom(next)) return false;
      save();
      notify(host, next);
      return true;
    },
    /** Sites retenus, pour les Réglages ou les tests. */
    list() {
      return [...load()].map(([host, factor]) => ({ host, factor }));
    },
    clear() {
      const hosts = [...load().keys()];
      load().clear();
      save();
      for (const host of hosts) notify(host, 1);
    },
    /** `listener({ host, factor })` à chaque changement ; renvoie le désabonnement. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = {
  ZOOM_LEVELS,
  isDefaultZoom,
  normalizeZoomFactor,
  nextZoomFactor,
  zoomSiteOf,
  createSiteZoomStore,
};
