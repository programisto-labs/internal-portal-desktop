'use strict';

/**
 * Autorisations des sites ouverts dans les onglets web (docs/site-permissions.md).
 *
 * Comme Chrome : un site demande (position, notifications, presse-papiers…), Lasco pose la
 * question une fois et retient « Autoriser » / « Bloquer » pour son origine. Rien n'est
 * accordé sans réponse. Micro et caméra restent refusés (docs/microphone.md) ; les
 * permissions sans risque (plein écran, verrouillage du pointeur, écriture du presse-papiers
 * déclenchée par un geste, DRM) sont accordées sans question ; tout le reste est refusé.
 */

const fs = require('fs');
const path = require('path');

/** Accordées sans question, comme Chrome. */
const ALWAYS_ALLOWED = new Set([
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'mediaKeySystem',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
]);

/** Demandées à la personne, puis retenues par origine. Libellé : « <site> souhaite … ». */
const PROMPTABLE = {
  geolocation: 'connaître votre position',
  notifications: 'vous envoyer des notifications',
  'clipboard-read': 'lire le contenu de votre presse-papiers',
  midi: 'utiliser vos appareils MIDI',
  midiSysex: 'contrôler et reprogrammer vos appareils MIDI',
  'idle-detection': 'savoir quand vous utilisez votre ordinateur',
  'window-management': 'gérer les fenêtres sur tous vos écrans',
  fileSystem: 'modifier les fichiers et dossiers que vous lui ouvrez',
};

/** Ordre d'affichage dans les informations du site. */
const PROMPTABLE_PERMISSIONS = Object.keys(PROMPTABLE);

const DECISIONS = new Set(['allow', 'block']);

/** `https://exemple.fr` pour une adresse http(s), sinon null. */
function siteOrigin(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function siteHost(origin) {
  try {
    return new URL(origin).host;
  } catch (_) {
    return String(origin || '');
  }
}

function permissionLabel(permission) {
  return PROMPTABLE[permission] || null;
}

/** Ce que fait Lasco d'une permission sans décision : `allow`, `ask` ou `deny`. */
function permissionPolicy(permission) {
  if (ALWAYS_ALLOWED.has(permission)) return 'allow';
  if (Object.prototype.hasOwnProperty.call(PROMPTABLE, permission)) return 'ask';
  return 'deny';
}

/** Décisions retenues : `{ version: 1, origins: { "https://x": { geolocation: "allow" } } }`. */
function createSitePermissionStore({ filePath, fsImpl = fs } = {}) {
  let origins = null;
  /**
   * « Ignorer » : refusé sans question jusqu'au redémarrage de Lasco (jamais écrit sur le disque).
   * Sans lui, un site qui redemande à chaque refus (position relue en boucle) reposait la question sans fin.
   * Effacé par toute décision ou réinitialisation depuis les informations du site.
   */
  const dismissed = new Set();
  const dismissKey = (origin, permission) => `${origin}\n${permission}`;

  function load() {
    if (origins) return origins;
    origins = new Map();
    if (!filePath) return origins;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      const entries = raw && typeof raw.origins === 'object' && raw.origins ? raw.origins : {};
      for (const [origin, decisions] of Object.entries(entries)) {
        if (siteOrigin(origin) !== origin || !decisions || typeof decisions !== 'object') continue;
        const valid = new Map();
        for (const [permission, decision] of Object.entries(decisions)) {
          if (permissionPolicy(permission) === 'ask' && DECISIONS.has(decision)) valid.set(permission, decision);
        }
        if (valid.size) origins.set(origin, valid);
      }
    } catch (_) {
      // Fichier absent ou illisible : aucune décision, chaque site redemande.
    }
    return origins;
  }

  function save() {
    if (!filePath) return;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = {};
      for (const [origin, decisions] of load()) payload[origin] = Object.fromEntries(decisions);
      const tmp = `${filePath}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, origins: payload }));
      fsImpl.renameSync(tmp, filePath);
    } catch (_) {
      // Non enregistré : la question reviendra.
    }
  }

  return {
    get(origin, permission) {
      return load().get(origin)?.get(permission) || null;
    },
    /** `decision` null : oublier (le site redemandera). */
    set(origin, permission, decision) {
      if (siteOrigin(origin) !== origin || permissionPolicy(permission) !== 'ask') return false;
      if (decision !== null && !DECISIONS.has(decision)) return false;
      dismissed.delete(dismissKey(origin, permission));
      const map = load();
      if (decision === null) {
        const decisions = map.get(origin);
        if (!decisions || !decisions.delete(permission)) return true;
        if (!decisions.size) map.delete(origin);
      } else {
        if (!map.has(origin)) map.set(origin, new Map());
        map.get(origin).set(permission, decision);
      }
      save();
      return true;
    },
    dismiss(origin, permission) {
      if (siteOrigin(origin) !== origin || permissionPolicy(permission) !== 'ask') return false;
      dismissed.add(dismissKey(origin, permission));
      return true;
    },
    isDismissed(origin, permission) {
      return dismissed.has(dismissKey(origin, permission));
    },
    list(origin) {
      const decisions = load().get(origin);
      return decisions ? Object.fromEntries(decisions) : {};
    },
    clearOrigin(origin) {
      for (const key of [...dismissed]) if (key.startsWith(`${origin}\n`)) dismissed.delete(key);
      if (load().delete(origin)) save();
    },
    clear() {
      dismissed.clear();
      load().clear();
      save();
    },
  };
}

/**
 * Gestionnaires de la session des onglets web.
 * `ask({ origin, permission, label, webContents })` → Promise<'allow' | 'block' | 'dismiss'>.
 */
function createSitePermissionHandlers({ store, ask }) {
  /** Une seule question à la fois par site et par permission : les demandes suivantes attendent la réponse. */
  const pending = new Map();

  function topOriginOf(webContents, fallbackUrl) {
    try {
      if (webContents && !webContents.isDestroyed()) {
        const origin = siteOrigin(webContents.getURL());
        if (origin) return origin;
      }
    } catch (_) {
      // webContents détruit pendant la demande
    }
    return siteOrigin(fallbackUrl);
  }

  async function decide(webContents, permission, details) {
    const policy = permissionPolicy(permission);
    if (policy !== 'ask') return policy === 'allow';
    // Chrome rattache la permission au site affiché (un cadre intégré n'en a qu'avec la
    // délégation Permissions-Policy, déjà vérifiée par Chromium avant d'arriver ici).
    const origin = topOriginOf(webContents, details && details.requestingUrl);
    if (!origin) return false;
    const stored = store.get(origin, permission);
    if (stored) return stored === 'allow';
    if (store.isDismissed && store.isDismissed(origin, permission)) return false;
    const key = `${origin}\n${permission}`;
    let question = pending.get(key);
    if (!question) {
      question = Promise.resolve()
        .then(() => ask({ origin, permission, label: permissionLabel(permission), webContents }))
        .catch(() => 'dismiss')
        .finally(() => pending.delete(key));
      pending.set(key, question);
    }
    const answer = await question;
    if (answer === 'allow' || answer === 'block') {
      if (!store.get(origin, permission)) store.set(origin, permission, answer);
      return answer === 'allow';
    }
    if (store.dismiss && !store.get(origin, permission)) store.dismiss(origin, permission);
    return false;
  }

  function request(webContents, permission, callback, details) {
    decide(webContents, permission, details).then(
      (granted) => callback(Boolean(granted)),
      () => callback(false),
    );
  }

  /** Lecture synchrone (Notification.permission, navigator.permissions.query) : jamais de question. */
  function check(webContents, permission, requestingOrigin, details) {
    const policy = permissionPolicy(permission);
    if (policy !== 'ask') return policy === 'allow';
    const origin =
      siteOrigin(details && details.embeddingOrigin) ||
      topOriginOf(webContents, null) ||
      siteOrigin(requestingOrigin);
    return Boolean(origin) && store.get(origin, permission) === 'allow';
  }

  return { request, check };
}

/** Une session (partagée par toutes les fenêtres) ne reçoit ses gestionnaires qu'une fois. */
const installedSessions = new WeakSet();

function installSitePermissions(targetSession, { store, ask }) {
  if (installedSessions.has(targetSession)) return false;
  installedSessions.add(targetSession);
  const handlers = createSitePermissionHandlers({ store, ask });
  targetSession.setPermissionRequestHandler(handlers.request);
  targetSession.setPermissionCheckHandler(handlers.check);
  return true;
}

/** Ce que les informations du site affichent : une ligne par permission demandable. */
function describeSitePermissions(store, origin) {
  const decisions = store.list(origin);
  return PROMPTABLE_PERMISSIONS.filter((permission) => decisions[permission]).map((permission) => ({
    permission,
    decision: decisions[permission],
  }));
}

module.exports = {
  ALWAYS_ALLOWED,
  PROMPTABLE,
  PROMPTABLE_PERMISSIONS,
  siteOrigin,
  siteHost,
  permissionLabel,
  permissionPolicy,
  createSitePermissionStore,
  createSitePermissionHandlers,
  installSitePermissions,
  describeSitePermissions,
};
