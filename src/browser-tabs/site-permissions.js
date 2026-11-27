'use strict';

/**
 * Autorisations des sites ouverts dans les onglets web (docs/site-permissions.md).
 *
 * Comme Chrome : un site demande (position, notifications, presse-papiers…), Lasco pose la
 * question une fois et retient « Autoriser » / « Bloquer » pour son origine. Rien n'est
 * accordé sans réponse. Micro et caméra (demande `media` d'Electron) sont demandés et retenus
 * séparément (`microphone`, `camera`), comme Chrome ; les permissions sans risque (plein écran, verrouillage du pointeur, écriture du presse-papiers
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
  microphone: 'utiliser votre micro',
  camera: 'utiliser votre caméra',
  geolocation: 'connaître votre position',
  notifications: 'vous envoyer des notifications',
  'clipboard-read': 'lire le contenu de votre presse-papiers',
  midi: 'utiliser vos appareils MIDI',
  midiSysex: 'contrôler et reprogrammer vos appareils MIDI',
  'idle-detection': 'savoir quand vous utilisez votre ordinateur',
  'window-management': 'gérer les fenêtres sur tous vos écrans',
  fileSystem: 'modifier les fichiers et dossiers que vous lui ouvrez',
};

/** Nom court d'une permission (informations du site, Réglages > Autorisations des sites). */
const PERMISSION_NAMES = {
  microphone: 'Micro',
  camera: 'Caméra',
  geolocation: 'Position',
  notifications: 'Notifications',
  'clipboard-read': 'Lecture du presse-papiers',
  midi: 'Appareils MIDI',
  midiSysex: 'Contrôle des appareils MIDI',
  'idle-detection': "Détection d'inactivité",
  'window-management': 'Gestion des fenêtres',
  fileSystem: 'Modification de fichiers',
};

/** Réglage par défaut d'une permission sans décision pour le site : `ask` (question) ou `block` (refus sans question). */
const DEFAULTS = new Set(['ask', 'block']);

/** Demande `media` d'Electron → permissions retenues (`audio` → micro, `video` → caméra). */
const MEDIA_TYPE_PERMISSIONS = { audio: 'microphone', video: 'camera' };

/**
 * Permissions visées par une demande `media`. Null : demande refusée (type absent ou inconnu,
 * comme une capture d'écran demandée par `getDisplayMedia`, qui passe par un autre chemin).
 */
function mediaRequestPermissions(details) {
  const types = Array.isArray(details && details.mediaTypes) ? details.mediaTypes : [];
  if (!types.length) return null;
  const permissions = [];
  for (const type of types) {
    const permission = MEDIA_TYPE_PERMISSIONS[type];
    if (!permission) return null;
    if (!permissions.includes(permission)) permissions.push(permission);
  }
  return permissions;
}

/** Libellé d'une question qui porte sur plusieurs permissions (micro et caméra). */
function combinedLabel(permissions) {
  if (permissions.length === 2 && permissions.includes('microphone') && permissions.includes('camera')) {
    return 'utiliser votre micro et votre caméra';
  }
  return permissions.map(permissionLabel).join(' et ');
}

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

/**
 * Décisions retenues : `{ version: 1, origins: { "https://x": { geolocation: "allow" } }, defaults: { camera: "block" } }`.
 * `defaults` ne garde que les permissions réglées sur « Bloquer » (sinon : demander).
 */
function createSitePermissionStore({ filePath, fsImpl = fs } = {}) {
  let origins = null;
  /** permission → 'block' (absente : 'ask'). Lu avec `origins`. */
  const defaults = new Map();
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
      const rawDefaults = raw && typeof raw.defaults === 'object' && raw.defaults ? raw.defaults : {};
      for (const [permission, value] of Object.entries(rawDefaults)) {
        if (permissionPolicy(permission) === 'ask' && value === 'block') defaults.set(permission, 'block');
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
      fsImpl.writeFileSync(
        tmp,
        JSON.stringify({ version: 1, origins: payload, defaults: Object.fromEntries(defaults) }),
      );
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
    /** Levée d'un « Ignorer » sans toucher à la décision (aucune). */
    undismiss(origin, permission) {
      return dismissed.delete(dismissKey(origin, permission));
    },
    list(origin) {
      const decisions = load().get(origin);
      return decisions ? Object.fromEntries(decisions) : {};
    },
    /** Permissions ignorées pour un site (jusqu'au redémarrage). */
    listDismissed(origin) {
      return PROMPTABLE_PERMISSIONS.filter((permission) => dismissed.has(dismissKey(origin, permission)));
    },
    /**
     * Sites avec au moins une décision ou un « Ignorer », triés par hôte :
     * `[{ origin, host, decisions: { camera: 'allow' }, dismissed: ['geolocation'] }]`.
     */
    listSites() {
      const all = new Set(load().keys());
      for (const key of dismissed) all.add(key.slice(0, key.indexOf('\n')));
      return [...all]
        .map((origin) => ({
          origin,
          host: siteHost(origin),
          decisions: this.list(origin),
          dismissed: this.listDismissed(origin),
        }))
        .sort((a, b) => a.host.localeCompare(b.host) || a.origin.localeCompare(b.origin));
    },
    getDefault(permission) {
      load();
      return defaults.get(permission) || 'ask';
    },
    /** `value` : 'ask' ou 'block'. */
    setDefault(permission, value) {
      if (permissionPolicy(permission) !== 'ask' || !DEFAULTS.has(value)) return false;
      load();
      if (value === 'block') defaults.set(permission, 'block');
      else defaults.delete(permission);
      save();
      return true;
    },
    listDefaults() {
      return PROMPTABLE_PERMISSIONS.map((permission) => ({ permission, value: this.getDefault(permission) }));
    },
    clearOrigin(origin) {
      for (const key of [...dismissed]) if (key.startsWith(`${origin}\n`)) dismissed.delete(key);
      if (load().delete(origin)) save();
    },
    /** Oublie toutes les décisions des sites ; les réglages par défaut restent. */
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
function createSitePermissionHandlers({ store, ask, ensureSystemMediaAccess = async () => true, onMediaGranted = null }) {
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

  /**
   * Une question pour toutes les permissions encore sans décision (micro + caméra : une seule
   * question, comme Chrome). Accordé seulement si chacune est autorisée.
   */
  async function decidePermissions(webContents, permissions, details) {
    // Chrome rattache la permission au site affiché (un cadre intégré n'en a qu'avec la
    // délégation Permissions-Policy, déjà vérifiée par Chromium avant d'arriver ici).
    const origin = topOriginOf(webContents, details && details.requestingUrl);
    if (!origin) return false;
    const undecided = [];
    for (const permission of permissions) {
      const stored = store.get(origin, permission);
      if (stored === 'block') return false;
      if (stored === 'allow') continue;
      if (store.isDismissed && store.isDismissed(origin, permission)) return false;
      // Réglage par défaut « Bloquer » (Réglages > Autorisations des sites) : refusé sans question.
      if (store.getDefault && store.getDefault(permission) === 'block') return false;
      undecided.push(permission);
    }
    if (!undecided.length) return true;
    const key = `${origin}\n${undecided.join('+')}`;
    let question = pending.get(key);
    if (!question) {
      const permission = undecided.length === 1 ? undecided[0] : undecided.join('+');
      const label = undecided.length === 1 ? permissionLabel(undecided[0]) : combinedLabel(undecided);
      question = Promise.resolve()
        .then(() => ask({ origin, permission, permissions: undecided, label, webContents }))
        .catch(() => 'dismiss')
        .finally(() => pending.delete(key));
      pending.set(key, question);
    }
    const answer = await question;
    let granted = true;
    for (const permission of undecided) {
      const stored = store.get(origin, permission);
      if (stored) {
        if (stored !== 'allow') granted = false;
      } else if (answer === 'allow' || answer === 'block') {
        store.set(origin, permission, answer);
        if (answer !== 'allow') granted = false;
      } else {
        if (store.dismiss) store.dismiss(origin, permission);
        granted = false;
      }
    }
    return granted;
  }

  async function decide(webContents, permission, details) {
    if (permission === 'media') {
      const permissions = mediaRequestPermissions(details);
      if (!permissions) return false;
      if (!(await decidePermissions(webContents, permissions, details))) return false;
      // macOS : l'app elle-même doit avoir l'accès (boîte système la première fois).
      for (const media of permissions) {
        if (!(await ensureSystemMediaAccess(media))) return false;
      }
      return true;
    }
    const policy = permissionPolicy(permission);
    if (policy !== 'ask') return policy === 'allow';
    return decidePermissions(webContents, [permission], details);
  }

  function request(webContents, permission, callback, details) {
    decide(webContents, permission, details).then(
      (granted) => {
        // Micro ou caméra accordés : la page est peut-être en appel, la mise en veille l'épargne.
        if (granted && permission === 'media' && typeof onMediaGranted === 'function') {
          try {
            onMediaGranted(webContents);
          } catch (_) {
            // jamais bloquant
          }
        }
        callback(Boolean(granted));
      },
      () => callback(false),
    );
  }

  /** Lecture synchrone (Notification.permission, navigator.permissions.query) : jamais de question. */
  function check(webContents, permission, requestingOrigin, details) {
    const origin = () =>
      siteOrigin(details && details.embeddingOrigin) ||
      topOriginOf(webContents, null) ||
      siteOrigin(requestingOrigin);
    if (permission === 'media') {
      // `mediaType` : `audio`, `video`, ou absent.
      const site = origin();
      if (!site) return false;
      const type = details && details.mediaType;
      // `navigator.permissions.query({ name: 'camera' | 'microphone' })` est le seul appel qui
      // porte `embeddingOrigin`. Sans `mediaType`, c'est la caméra avec pan/tilt/zoom
      // (`{ name: 'camera', panTiltZoom: true }`), que Google Meet interroge : elle suit la caméra.
      const isQuery = Boolean(details && details.embeddingOrigin);
      if (isQuery) {
        const target = MEDIA_TYPE_PERMISSIONS[type] || 'camera';
        const stored = store.get(site, target);
        if (stored) return stored === 'allow';
        // Electron ne sait répondre que « accordé » ou « refusé », jamais « à demander ». Sans
        // décision, « refusé » faisait conclure à Google Meet que l'accès était bloqué : il
        // n'appelait jamais getUserMedia, donc la question de Lasco n'apparaissait pas. Tant que
        // rien n'est bloqué ni ignoré, on répond « accordé » : le site appelle getUserMedia et la
        // demande passe par `request`, qui pose la question.
        if (store.getDefault && store.getDefault(target) === 'block') return false;
        return !(store.isDismissed && store.isDismissed(site, target));
      }
      // Noms des appareils (enumerateDevices) : cachés jusqu'à « Autoriser ».
      const wanted = MEDIA_TYPE_PERMISSIONS[type] ? [MEDIA_TYPE_PERMISSIONS[type]] : ['microphone', 'camera'];
      return wanted.some((p) => store.get(site, p) === 'allow');
    }
    const policy = permissionPolicy(permission);
    if (policy !== 'ask') return policy === 'allow';
    const site = origin();
    return Boolean(site) && store.get(site, permission) === 'allow';
  }

  return { request, check };
}

/** Une session (partagée par toutes les fenêtres) ne reçoit ses gestionnaires qu'une fois. */
const installedSessions = new WeakSet();

function installSitePermissions(targetSession, { store, ask, ensureSystemMediaAccess, onMediaGranted }) {
  if (installedSessions.has(targetSession)) return false;
  installedSessions.add(targetSession);
  const handlers = createSitePermissionHandlers({ store, ask, ensureSystemMediaAccess, onMediaGranted });
  targetSession.setPermissionRequestHandler(handlers.request);
  targetSession.setPermissionCheckHandler(handlers.check);
  return true;
}

/**
 * Ce que les informations du site affichent : une ligne par permission demandable, décidée ou non.
 * `decision` : 'allow' | 'block' | 'ask' (aucune décision : le réglage par défaut s'applique) ;
 * `dismissed` : « Ignorer » en mémoire jusqu'au redémarrage ; `defaultDecision` : 'ask' | 'block'.
 */
function describeSitePermissions(store, origin) {
  const decisions = store.list(origin);
  return PROMPTABLE_PERMISSIONS.map((permission) => ({
    permission,
    decision: decisions[permission] || 'ask',
    dismissed: !decisions[permission] && Boolean(store.isDismissed && store.isDismissed(origin, permission)),
    defaultDecision: store.getDefault ? store.getDefault(permission) : 'ask',
  }));
}

module.exports = {
  ALWAYS_ALLOWED,
  PROMPTABLE,
  PROMPTABLE_PERMISSIONS,
  PERMISSION_NAMES,
  siteOrigin,
  siteHost,
  permissionLabel,
  permissionPolicy,
  mediaRequestPermissions,
  createSitePermissionStore,
  createSitePermissionHandlers,
  installSitePermissions,
  describeSitePermissions,
};
