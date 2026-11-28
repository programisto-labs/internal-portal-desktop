'use strict';

/**
 * Barrière des messages IPC (docs/security.md, « IPC »).
 *
 * Un onglet web est un site quelconque : son preload (mots de passe, saisie automatique,
 * filtres cosmétiques du bloqueur) ne parle qu'à quelques canaux. Mais un renderer compromis
 * (faille de Chromium) peut envoyer n'importe quel message sur n'importe quel canal. Avant cette
 * barrière, beaucoup de gestionnaires ne vérifiaient pas l'expéditeur (`update-install-now`,
 * réglages, historique…).
 *
 * Règle, appliquée à TOUS les gestionnaires `ipcMain` (posée avant qu'aucun ne soit enregistré) :
 * - expéditeur de confiance = session de confiance (portail, session par défaut des vues de
 *   Lasco, coquille d'une fenêtre privée) ET cadre émetteur chargé depuis le portail ou un
 *   fichier de Lasco (`file:`) ;
 * - tout autre expéditeur (onglet web, fenêtre ouverte par un site, page d'un fournisseur OAuth
 *   affichée dans la fenêtre du portail, sous-cadre d'un autre site) n'atteint que les canaux de
 *   `webChannels`. Un message refusé est ignoré (`on`) ou rejeté (`handle`) et journalisé une
 *   fois par canal.
 *
 * Une session est « web » par défaut : toute nouvelle partition d'onglets (profils, extensions…)
 * est donc fermée sans rien faire. Un nouveau canal appelé par une page web s'ajoute avec
 * `allowWebChannels`, et son gestionnaire vérifie lui-même l'onglet émetteur.
 */

const LISTENER_METHODS = ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener'];
const HANDLER_METHODS = ['handle', 'handleOnce'];
const REMOVE_METHODS = ['removeListener', 'off'];

/**
 * Décision pure (testable sans Electron).
 * @param {{ channel: string, hasSender: boolean, sessionTrusted: boolean, frameUrl: string | null,
 *   isTrustedFrameUrl: (url: string) => boolean, webChannels: Set<string> }} input
 * @returns {boolean}
 */
function isIpcAllowed({ channel, hasSender, sessionTrusted, frameUrl, isTrustedFrameUrl, webChannels }) {
  if (webChannels.has(channel)) return true;
  if (!hasSender || !sessionTrusted) return false;
  if (typeof frameUrl !== 'string' || !frameUrl) return false;
  let protocol;
  try {
    protocol = new URL(frameUrl).protocol;
  } catch (_) {
    return false;
  }
  if (protocol === 'file:') return true;
  try {
    return Boolean(isTrustedFrameUrl(frameUrl));
  } catch (_) {
    return false;
  }
}

/**
 * @param {{ isTrustedFrameUrl: (url: string) => boolean, webChannels?: Iterable<string>,
 *   log?: (message: string) => void }} options
 */
function createIpcGate({ isTrustedFrameUrl, webChannels = [], log = (m) => console.warn(m) }) {
  const allowedWebChannels = new Set(webChannels);
  const trustedSessions = new WeakSet();
  const reported = new Set();
  /** Écouteur d'origine → écouteur filtré, par canal (pour `removeListener`). */
  const wrappedByChannel = new Map();
  let installed = false;

  function senderInfo(event) {
    const sender = event && event.sender;
    if (!sender || typeof sender !== 'object') return { hasSender: false, sessionTrusted: false, frameUrl: null };
    let sessionTrusted = false;
    try {
      sessionTrusted = Boolean(sender.session && trustedSessions.has(sender.session));
    } catch (_) {
      sessionTrusted = false;
    }
    let frameUrl = null;
    try {
      const frame = event.senderFrame;
      frameUrl = frame && !frame.isDestroyed?.() ? frame.url : null;
    } catch (_) {
      frameUrl = null;
    }
    return { hasSender: true, sessionTrusted, frameUrl };
  }

  function allows(event, channel) {
    const info = senderInfo(event);
    const ok = isIpcAllowed({ channel, ...info, isTrustedFrameUrl, webChannels: allowedWebChannels });
    if (!ok && !reported.has(channel)) {
      reported.add(channel);
      let origin = 'inconnue';
      try {
        origin = info.frameUrl ? new URL(info.frameUrl).origin : origin;
      } catch (_) {
        // origine illisible
      }
      log(`[ipc-gate] message « ${channel} » refusé (origine ${origin})`);
    }
    return ok;
  }

  function wrapListener(channel, listener) {
    return function gatedListener(event, ...args) {
      if (!allows(event, channel)) return undefined;
      return listener.call(this, event, ...args);
    };
  }

  function remember(channel, listener, wrapped) {
    if (!wrappedByChannel.has(channel)) wrappedByChannel.set(channel, new Map());
    wrappedByChannel.get(channel).set(listener, wrapped);
  }

  /** Pose la barrière sur `ipcMain`. À appeler avant tout `ipcMain.on` / `ipcMain.handle`. */
  function install(ipcMain) {
    if (installed) return;
    installed = true;
    for (const method of LISTENER_METHODS) {
      const original = ipcMain[method];
      if (typeof original !== 'function') continue;
      ipcMain[method] = function gatedRegister(channel, listener) {
        if (typeof listener !== 'function') return original.call(this, channel, listener);
        const wrapped = wrapListener(channel, listener);
        remember(channel, listener, wrapped);
        return original.call(this, channel, wrapped);
      };
    }
    for (const method of HANDLER_METHODS) {
      const original = ipcMain[method];
      if (typeof original !== 'function') continue;
      ipcMain[method] = function gatedHandle(channel, handler) {
        if (typeof handler !== 'function') return original.call(this, channel, handler);
        return original.call(this, channel, (event, ...args) => {
          if (!allows(event, channel)) throw new Error('forbidden');
          return handler(event, ...args);
        });
      };
    }
    for (const method of REMOVE_METHODS) {
      const original = ipcMain[method];
      if (typeof original !== 'function') continue;
      ipcMain[method] = function gatedRemove(channel, listener) {
        const byListener = wrappedByChannel.get(channel);
        const wrapped = byListener && byListener.get(listener);
        if (wrapped) byListener.delete(listener);
        return original.call(this, channel, wrapped || listener);
      };
    }
  }

  return {
    install,
    /** Session dont les pages sont à Lasco (portail, vues locales). Toute autre est « web ». */
    trustSession(ses) {
      if (ses && typeof ses === 'object') trustedSessions.add(ses);
    },
    isTrustedSession: (ses) => Boolean(ses && trustedSessions.has(ses)),
    /** Canaux qu'une page web peut appeler (son gestionnaire vérifie l'onglet émetteur). */
    allowWebChannels(channels) {
      for (const channel of channels || []) if (typeof channel === 'string' && channel) allowedWebChannels.add(channel);
    },
    allows,
  };
}

module.exports = { createIpcGate, isIpcAllowed };
