'use strict';

/**
 * Micro de la voix des agents (dictée et mode vocal du chat Lasco AI).
 *
 * Electron accorde toute permission quand aucune règle n'est posée. Avec l'accès micro accordé à l'app par
 * macOS, n'importe quelle page aurait donc le micro sans rien demander. Règles :
 * - portail Lasco (`persist:portal`) : micro seul (pas de caméra), et seulement pour une page du portail ;
 * - onglets web du navigateur intégré (`persist:browser-tabs`) : micro et caméra demandés par site
 *   (src/browser-tabs/site-permissions.js, docs/site-permissions.md) ;
 * - autres permissions : inchangées (accordées, comme avant).
 *
 * macOS : la première demande déclenche la boîte système (texte `NSMicrophoneUsageDescription`).
 */

/** Demande limitée au micro (`mediaTypes` vide = non précisé : refusé). */
function isAudioOnlyRequest(details) {
  const types = Array.isArray(details && details.mediaTypes) ? details.mediaTypes : [];
  return types.length > 0 && types.every((type) => type === 'audio');
}

/** Décision pour une demande `media` du portail. */
function portalMediaAllowed(requestingUrl, details, isPortalUrl) {
  return Boolean(requestingUrl) && isPortalUrl(requestingUrl) && isAudioOnlyRequest(details);
}

/** Vérification synchrone (`navigator.permissions`, énumération des micros) du portail. */
function portalMediaCheckAllowed(requestingOrigin, details, isPortalUrl) {
  if (!requestingOrigin || !isPortalUrl(requestingOrigin)) return false;
  const type = details && details.mediaType;
  return !type || type === 'audio' || type === 'unknown';
}

/**
 * macOS : accès de l'app au micro ou à la caméra (`media` : `microphone` | `camera`), boîte
 * système la première fois. Ailleurs : géré par le système.
 */
async function ensureSystemMediaAccess(systemPreferences, media, platform = process.platform) {
  if (platform !== 'darwin' || !systemPreferences) return true;
  if (media !== 'microphone' && media !== 'camera') return false;
  try {
    const status = systemPreferences.getMediaAccessStatus(media);
    if (status === 'granted') return true;
    if (status === 'denied' || status === 'restricted') return false;
    return await systemPreferences.askForMediaAccess(media);
  } catch (_) {
    return false;
  }
}

/** macOS : accès micro de l'app (boîte système la première fois). Ailleurs : géré par le système. */
function ensureSystemMicrophoneAccess(systemPreferences, platform = process.platform) {
  return ensureSystemMediaAccess(systemPreferences, 'microphone', platform);
}

function requestingUrlOf(webContents, details) {
  if (details && typeof details.requestingUrl === 'string' && details.requestingUrl) return details.requestingUrl;
  try {
    return webContents && !webContents.isDestroyed() ? webContents.getURL() : '';
  } catch (_) {
    return '';
  }
}

/** Session du portail : micro pour le portail seulement, le reste inchangé. */
function installPortalMediaPermissions(targetSession, { isPortalUrl, systemPreferences }) {
  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(true);
      return;
    }
    if (!portalMediaAllowed(requestingUrlOf(webContents, details), details, isPortalUrl)) {
      callback(false);
      return;
    }
    ensureSystemMicrophoneAccess(systemPreferences).then(callback, () => callback(false));
  });
  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission !== 'media') return true;
    return portalMediaCheckAllowed(requestingOrigin, details, isPortalUrl);
  });
}

module.exports = {
  isAudioOnlyRequest,
  portalMediaAllowed,
  portalMediaCheckAllowed,
  ensureSystemMediaAccess,
  ensureSystemMicrophoneAccess,
  installPortalMediaPermissions,
};
