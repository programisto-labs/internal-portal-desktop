'use strict';

/**
 * Version minimale imposée (docs/security.md, « Version minimale »).
 *
 * Après une faille critique (correctif de sécurité de Chromium, d'Electron ou de Lasco), l'équipe
 * publie la version corrigée puis relève `security/minimum-version.json` sur `main` (workflow
 * « Security floor »). Chaque Lasco relit ce fichier à chaque vérification de mise à jour :
 * - version installée sous le plancher : vérification toutes les 15 min, installation 1 min après
 *   le téléchargement, même pendant un travail (10 min d'attente au plus au lieu de 2 h) ;
 * - pas de mise à jour trouvée au bout de 6 h (mise à jour automatique cassée sur ce poste) :
 *   fenêtre « Mettez Lasco à jour » avec le lien de téléchargement, une fois par lancement.
 *
 * Le fichier ne donne qu'un numéro : il ne peut que hâter l'installation d'une release signée
 * publiée sur GitHub, jamais installer autre chose. Fichier illisible ou absent : rien ne change.
 */

const MINIMUM_VERSION_URL =
  'https://raw.githubusercontent.com/programisto-labs/internal-portal-desktop/main/security/minimum-version.json';
const SECURITY_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const SECURITY_MAX_DEFER_MS = 10 * 60 * 1000;
const MANUAL_UPDATE_AFTER_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;

/** -1, 0 ou 1 ; null si une version est illisible. Les préversions (`-beta`) sont ignorées. */
function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a || '').trim().replace(/^v/, '').split('-')[0]);
  const pb = SEMVER.exec(String(b || '').trim().replace(/^v/, '').split('-')[0]);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `{ minimumVersion, reason }` validé, sinon null. */
function parseMinimumVersion(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const minimumVersion = typeof data.minimumVersion === 'string' ? data.minimumVersion.trim().replace(/^v/, '') : '';
  if (!SEMVER.test(minimumVersion)) return null;
  const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 300) : '';
  return { minimumVersion, reason };
}

/** La version installée est-elle sous le plancher ? */
function isBelowMinimum(currentVersion, floor) {
  if (!floor || !floor.minimumVersion) return false;
  return compareVersions(currentVersion, floor.minimumVersion) === -1;
}

/**
 * Lit le plancher. `fetchImpl` = `net.fetch` d'Electron (proxy du système) ou `fetch`.
 * @returns {Promise<{ minimumVersion: string, reason: string } | null>}
 */
async function fetchMinimumVersion({ fetchImpl, url = MINIMUM_VERSION_URL, timeoutMs = FETCH_TIMEOUT_MS }) {
  if (typeof fetchImpl !== 'function') return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchImpl(url, { cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
    if (!res || !res.ok) return null;
    const text = await res.text();
    if (typeof text !== 'string' || text.length > MAX_BODY_BYTES) return null;
    return parseMinimumVersion(text);
  } catch (_) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * État du plancher pour cette instance.
 * @param {{ currentVersion: string, now?: () => number }} deps
 */
function createSecurityFloor({ currentVersion, now = Date.now }) {
  let floor = null;
  let belowSince = null;
  let manualPromptShown = false;

  return {
    /** Nouveau plancher lu (ou null : on garde le dernier connu pendant ce lancement). */
    update(next) {
      if (next) floor = next;
      if (isBelowMinimum(currentVersion, floor)) {
        if (belowSince === null) belowSince = now();
      } else {
        belowSince = null;
      }
    },
    required: () => belowSince !== null,
    floor: () => floor,
    /** Délai d'attente maximal avant l'installation d'une version téléchargée. */
    maxDeferMs: (normalMs) => (belowSince !== null ? Math.min(normalMs, SECURITY_MAX_DEFER_MS) : normalMs),
    /** Proposer le téléchargement manuel (mise à jour automatique qui n'aboutit pas) ? Une fois par lancement. */
    shouldPromptManualUpdate({ updateDownloaded }) {
      if (belowSince === null || manualPromptShown || updateDownloaded) return false;
      if (now() - belowSince < MANUAL_UPDATE_AFTER_MS) return false;
      manualPromptShown = true;
      return true;
    },
  };
}

module.exports = {
  MINIMUM_VERSION_URL,
  SECURITY_CHECK_INTERVAL_MS,
  SECURITY_MAX_DEFER_MS,
  MANUAL_UPDATE_AFTER_MS,
  compareVersions,
  parseMinimumVersion,
  isBelowMinimum,
  fetchMinimumVersion,
  createSecurityFloor,
};
