'use strict';

/**
 * Contexte web d'une fenêtre du portail (docs/browser-profiles.md) : (compte Lasco, profil de navigation,
 * workspace). Chaque contexte a sa session Electron `persist:` (cookies, cache, stockage des sites) ;
 * chaque (compte, profil) a ses fichiers (historique, autorisations des sites, applis externes).
 *
 * Pur Node : aucune API d'Electron, testé par scripts/test-browser-profiles.js.
 */

const path = require('path');

/** Session d'avant les profils : celle du profil par défaut, copiée une fois dans chaque workspace. */
const LEGACY_BROWSER_PARTITION = 'persist:browser-tabs';
const DEFAULT_PROFILE_ID = 'default';
const PROFILE_ID_PATTERN = /^(default|bp_[0-9a-f]{16})$/;
/** Empreinte du compte (sujet du JWT haché par le portail) : hexadécimal, 12 caractères gardés. */
const OWNER_PATTERN = /^[0-9a-f]{12,128}$/;
const WORKSPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function normalizeOwner(value) {
  const owner = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return OWNER_PATTERN.test(owner) ? owner.slice(0, 12) : null;
}

function normalizeProfileId(value) {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value) ? value : DEFAULT_PROFILE_ID;
}

function normalizeWorkspace(value) {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return WORKSPACE_PATTERN.test(slug) ? slug : null;
}

/**
 * `{ owner, profileId, workspace }` envoyé par le portail → contexte complet, ou null (valeurs invalides :
 * la fenêtre garde la session d'avant les profils).
 */
function resolveBrowserContext(input, { userDataDir } = {}) {
  if (!input || typeof input !== 'object') return null;
  const owner = normalizeOwner(input.owner);
  const workspace = normalizeWorkspace(input.workspace);
  if (!owner || !workspace) return null;
  const profileId = normalizeProfileId(input.profileId);
  const isDefault = profileId === DEFAULT_PROFILE_ID;
  return {
    owner,
    profileId,
    workspace,
    isDefault,
    /** Clé du contexte : une session Electron par clé. */
    key: `${owner}/${profileId}/${workspace}`,
    partition: `persist:bp-${owner}-${profileId}-${workspace}`,
    /** Clé des fichiers du profil (historique, autorisations…). */
    profileKey: `${owner}/${profileId}`,
    /**
     * Dossier des fichiers du profil. Profil par défaut : null, il garde les fichiers d'avant les profils
     * (`browser-history.json`…), donc rien n'est perdu à la mise à jour.
     */
    dataDir: isDefault || !userDataDir ? null : path.join(userDataDir, 'browser-profiles', `${owner}-${profileId}`),
  };
}

/** Deux contextes identiques (même session) ? Null = session d'avant les profils. */
function sameBrowserContext(a, b) {
  return (a ? a.key : null) === (b ? b.key : null);
}

/**
 * Copie, une fois, les cookies de l'ancienne session partagée dans le contexte d'un workspace du profil par
 * défaut : on y reste connecté aux sites, puis chaque contexte vit sa vie. Ni le stockage local ni le cache ne
 * sont copiés. `migrated` : ensemble persistant des partitions déjà traitées.
 */
async function migrateLegacyCookies({ context, legacySession, targetSession, migrated }) {
  if (!context || !context.isDefault || migrated.has(context.partition)) return { copied: 0, skipped: true };
  // L'ancienne session appartient au premier compte qui passe aux profils : jamais copiée chez un autre compte.
  if (!migrated.claimLegacy(context.owner)) {
    migrated.add(context.partition);
    return { copied: 0, skipped: true };
  }
  let copied = 0;
  try {
    const cookies = await legacySession.cookies.get({});
    for (const cookie of cookies) {
      const details = cookieSetDetails(cookie);
      if (!details) continue;
      try {
        await targetSession.cookies.set(details);
        copied += 1;
      } catch (_) {
        // Cookie refusé par Chromium (attributs incohérents) : on continue avec les autres.
      }
    }
    if (typeof targetSession.cookies.flushStore === 'function') await targetSession.cookies.flushStore();
  } finally {
    // Même en échec partiel : jamais une seconde copie par-dessus un contexte qui a vécu.
    migrated.add(context.partition);
  }
  return { copied, skipped: false };
}

/** Cookie lu par `cookies.get` → détails acceptés par `cookies.set`. */
function cookieSetDetails(cookie) {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.domain !== 'string') return null;
  const host = cookie.domain.replace(/^\./, '');
  if (!host) return null;
  const scheme = cookie.secure ? 'https' : 'http';
  const details = {
    url: `${scheme}://${host}${cookie.path || '/'}`,
    name: cookie.name,
    value: typeof cookie.value === 'string' ? cookie.value : '',
    path: cookie.path || '/',
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
  };
  // Cookie d'hôte (`__Host-`, sans attribut Domain) : ne pas en faire un cookie de domaine.
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (!cookie.session && typeof cookie.expirationDate === 'number') details.expirationDate = cookie.expirationDate;
  if (cookie.sameSite && cookie.sameSite !== 'unspecified') details.sameSite = cookie.sameSite;
  return details;
}

/** Partitions déjà migrées : petit fichier JSON, écrit à chaque ajout. */
function createMigratedPartitionsStore({ filePath, fsImpl = require('fs') } = {}) {
  const set = new Set();
  let legacyOwner = null;
  if (filePath) {
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      if (raw && Array.isArray(raw.migrated)) for (const p of raw.migrated) if (typeof p === 'string') set.add(p);
      if (raw && typeof raw.legacyOwner === 'string') legacyOwner = raw.legacyOwner;
    } catch (_) {
      // Pas encore de fichier.
    }
  }
  const write = () => {
    if (!filePath) return;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, legacyOwner, migrated: [...set] }));
      fsImpl.renameSync(tmp, filePath);
    } catch (_) {
      // Disque plein : la copie pourra être refaite, sans conséquence (cookies déjà présents écrasés).
    }
  };
  return {
    has: (partition) => set.has(partition),
    add(partition) {
      if (set.has(partition)) return;
      set.add(partition);
      write();
    },
    /** Vrai si l'ancienne session revient à ce compte (le premier qui la réclame). */
    claimLegacy(owner) {
      if (!legacyOwner) {
        legacyOwner = owner;
        write();
      }
      return legacyOwner === owner;
    },
  };
}

module.exports = {
  LEGACY_BROWSER_PARTITION,
  DEFAULT_PROFILE_ID,
  resolveBrowserContext,
  sameBrowserContext,
  migrateLegacyCookies,
  cookieSetDetails,
  createMigratedPartitionsStore,
};
