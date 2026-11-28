'use strict';

/**
 * Connexions sécurisées d'abord (docs/security.md, « HTTPS d'abord ») — comme les « HTTPS-Upgrades »
 * de Chrome, qu'Electron n'a pas (la fonction vit dans la couche `chrome/`).
 *
 * Une page `http://` d'un site public est d'abord demandée en `https://` (même adresse). Si la
 * version sécurisée échoue (connexion, certificat, délai de 5 s) ou redirige vers `http://`, Lasco
 * ouvre la page en `http://` (marquée « Non sécurisé ») et n'essaie plus ce site jusqu'à la
 * fermeture de Lasco. Jamais pour une adresse locale ou d'intranet (nom sans point, `.local`,
 * `.localhost`, `.test`, `.internal`…), une adresse IP ou un port explicite.
 *
 * Réglage : Lasco > Réglages… > Général > Sécurité, activé par défaut.
 */

const UPGRADE_TIMEOUT_MS = 5000;
/** Un `http://` revu si vite après une montée en `https://` = redirection vers http : le site n'a pas d'https. */
const DOWNGRADE_WINDOW_MS = 10 * 1000;
const MAX_EXCEPTIONS = 500;

const LOCAL_SUFFIXES = ['.local', '.localhost', '.test', '.internal', '.lan', '.home', '.corp', '.intranet', '.example', '.invalid', '.arpa'];

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');
}

/** Le site peut-il être essayé en https ? */
function isUpgradeableHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.')) return false;
  if (host === 'localhost' || isIpLiteral(host)) return false;
  return !LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Adresse https à essayer pour `url`, sinon null. */
function httpsUpgradeUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'http:' || parsed.port || parsed.username || parsed.password) return null;
  if (!isUpgradeableHost(parsed.hostname)) return null;
  parsed.protocol = 'https:';
  return parsed.href;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * État partagé par les onglets d'une fenêtre (en mémoire seulement).
 * @param {{ isEnabled: () => boolean, now?: () => number }} deps
 */
function createHttpsFirst({ isEnabled, now = Date.now }) {
  /** Sites sans https utilisable : ouverts en http jusqu'au redémarrage. */
  const exceptions = new Set();
  /** Montées en cours : adresse https → adresse http d'origine. */
  const pending = new Map();
  /** Dernière montée par site (détection d'une redirection vers http). */
  const upgradedAt = new Map();

  function addException(host) {
    if (!host) return;
    if (exceptions.size >= MAX_EXCEPTIONS) exceptions.delete(exceptions.values().next().value);
    exceptions.add(host);
  }

  return {
    /** Navigation vers `url` (cadre principal) : adresse https à charger à la place, sinon null. */
    upgrade(url) {
      if (!isEnabled()) return null;
      const target = httpsUpgradeUrl(url);
      if (!target) return null;
      const host = hostOf(target);
      if (exceptions.has(host)) return null;
      const last = upgradedAt.get(host);
      if (last !== undefined && now() - last < DOWNGRADE_WINDOW_MS) {
        // La version https, pas encore affichée, renvoie vers http : le site ne sert pas d'https.
        addException(host);
        upgradedAt.delete(host);
        for (const [key, value] of pending) if (hostOf(value) === host) pending.delete(key);
        return null;
      }
      pending.set(target, String(url));
      upgradedAt.set(host, now());
      return target;
    },
    /** Chargement de `url` échoué (ou trop long) : adresse http à ouvrir à la place, sinon null. */
    fallbackFor(url) {
      const original = pending.get(String(url || ''));
      if (!original) return null;
      pending.delete(String(url));
      addException(hostOf(original));
      return original;
    },
    /** La page s'est affichée : la montée a réussi (ou une autre navigation l'a remplacée). */
    committed(url) {
      pending.delete(String(url || ''));
      upgradedAt.delete(hostOf(url));
    },
    isPending: (url) => pending.has(String(url || '')),
    isException: (host) => exceptions.has(String(host || '').toLowerCase()),
  };
}

module.exports = {
  UPGRADE_TIMEOUT_MS,
  DOWNGRADE_WINDOW_MS,
  isUpgradeableHost,
  httpsUpgradeUrl,
  createHttpsFirst,
};
