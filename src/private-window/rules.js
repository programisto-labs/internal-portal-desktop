'use strict';

/**
 * Navigation privée (docs/private-browsing.md) : une fenêtre qui ne contient que des onglets web,
 * sur une session Electron en mémoire, propre à la fenêtre et effacée à sa fermeture.
 *
 * Règles pures (aucun import d'Electron) pour être testables : nom de la partition, adresses
 * acceptées dans un onglet privé, appels du pont refusés.
 */

/** Préfixe des partitions privées. Jamais `persist:` : Electron garde alors tout en mémoire. */
const PRIVATE_PARTITION_PREFIX = 'lasco-private-';

/** Argument passé à la page de la fenêtre privée (lu par son preload). */
const PRIVATE_WINDOW_ARG = '--lasco-private-window';

/** Couleur de fond de la fenêtre (anthracite violet), avant que la page ne s'affiche. */
const PRIVATE_WINDOW_BACKGROUND = '#1b1724';

/**
 * Une partition neuve pour une fenêtre privée. `randomId` est injecté (crypto.randomUUID en vrai).
 * Toujours en mémoire : le nom ne peut pas commencer par `persist:`.
 */
function newPrivatePartition(randomId) {
  const raw = String(typeof randomId === 'function' ? randomId() : '').replace(/[^\w-]/g, '');
  if (!raw) throw new Error('private partition needs a random id');
  return PRIVATE_PARTITION_PREFIX + raw;
}

function isPrivatePartition(name) {
  return typeof name === 'string' && name.startsWith(PRIVATE_PARTITION_PREFIX) && !name.startsWith('persist:');
}

/** Garde : une session privée n'est jamais persistante. Lève une erreur sinon. */
function assertInMemoryPartition(name) {
  if (!isPrivatePartition(name)) {
    throw new Error(`not an in-memory private partition: ${String(name)}`);
  }
  return name;
}

/**
 * Où va une adresse ouverte dans une fenêtre privée :
 * - `portal` : une page de Lasco, ouverte dans la fenêtre principale (jamais dans un onglet privé) ;
 * - `web` : une page web, dans l'onglet privé ;
 * - `deny` : rien (adresse invalide).
 */
function routePrivateUrl(url, { isPortalUrl, sanitizeBrowserUrl }) {
  if (typeof url !== 'string' || !url) return 'deny';
  if (typeof isPortalUrl === 'function' && isPortalUrl(url)) return 'portal';
  const safe = typeof sanitizeBrowserUrl === 'function' ? sanitizeBrowserUrl(url) : null;
  return safe ? 'web' : 'deny';
}

/**
 * Appels du gestionnaire d'onglets refusés à une fenêtre privée : gestionnaire de mots de passe,
 * saisie automatique, pilotage par un agent, historique et données du navigateur normal.
 */
const PRIVATE_DENIED_TAB_METHODS = Object.freeze([
  'passwordSetEnabled',
  'passwordSetSuggestions',
  'passwordTakeCapture',
  'passwordDismissCapture',
  'passwordFill',
  'autofillSetProfiles',
  'autofillFill',
  'agentAction',
  'setAgentControl',
  'historyList',
  'historyRemove',
  'historyClear',
  'clearBrowsingData',
  'openDevTools',
]);

function isDeniedInPrivate(method) {
  return PRIVATE_DENIED_TAB_METHODS.includes(method);
}

/**
 * Autorisations des sites d'une fenêtre privée, comme Chrome : en mémoire seulement, jamais écrites.
 * Les blocages du navigateur normal (réglages par défaut, sites bloqués) s'appliquent aussi ; ses
 * autorisations, jamais (un site autorisé ailleurs redemande en privé).
 * `memory` : un magasin sans fichier (createSitePermissionStore({})) ; `base` : le magasin partagé.
 */
function createPrivateSitePermissions({ memory, base }) {
  const inheritedBlock = (origin, permission) => Boolean(base && base.get(origin, permission) === 'block');
  return {
    ...memory,
    get(origin, permission) {
      return memory.get(origin, permission) || (inheritedBlock(origin, permission) ? 'block' : null);
    },
    list(origin) {
      const own = memory.list(origin);
      const inherited = base ? base.list(origin) : {};
      for (const [permission, decision] of Object.entries(inherited)) {
        if (decision === 'block' && !own[permission]) own[permission] = 'block';
      }
      return own;
    },
    getDefault(permission) {
      return base && base.getDefault(permission) === 'block' ? 'block' : memory.getDefault(permission);
    },
    // Réglages par défaut : ceux du navigateur normal, jamais modifiés depuis une fenêtre privée.
    setDefault: () => false,
  };
}

/** Effacer tout ce qu'une session privée a pu garder en mémoire (fermeture de la fenêtre). */
async function wipePrivateSession(ses) {
  if (!ses) return;
  const steps = [
    () => ses.clearStorageData(),
    () => ses.clearCache(),
    () => ses.clearAuthCache(),
    () => (typeof ses.clearHostResolverCache === 'function' ? ses.clearHostResolverCache() : undefined),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (_) {
      // Au mieux : la partition n'est de toute façon jamais écrite sur le disque.
    }
  }
}

module.exports = {
  PRIVATE_PARTITION_PREFIX,
  PRIVATE_WINDOW_ARG,
  PRIVATE_WINDOW_BACKGROUND,
  PRIVATE_DENIED_TAB_METHODS,
  newPrivatePartition,
  isPrivatePartition,
  assertInMemoryPartition,
  routePrivateUrl,
  isDeniedInPrivate,
  createPrivateSitePermissions,
  wipePrivateSession,
};
