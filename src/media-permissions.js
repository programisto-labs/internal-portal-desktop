'use strict';

/**
 * Micro de la voix des agents (dictée et mode vocal du chat Lasco AI).
 *
 * Electron accorde toute permission quand aucune règle n'est posée. Avec l'accès micro accordé à l'app par
 * macOS, n'importe quelle page aurait donc le micro sans rien demander. Règles :
 * - portail Lasco (`persist:portal`) : micro seul (pas de caméra), et seulement pour une page du portail ;
 * - onglets web du navigateur intégré (`persist:browser-tabs`) : ni micro ni caméra ;
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

/** macOS : accès micro de l'app (boîte système la première fois). Ailleurs : géré par le système. */
async function ensureSystemMicrophoneAccess(systemPreferences, platform = process.platform) {
  if (platform !== 'darwin' || !systemPreferences) return true;
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    if (status === 'denied' || status === 'restricted') return false;
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (_) {
    return false;
  }
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

/** Onglets web du navigateur intégré : ni micro ni caméra, le reste inchangé. */
function installBrowserTabMediaPermissions(targetSession) {
  targetSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission !== 'media');
  });
  targetSession.setPermissionCheckHandler((_webContents, permission) => permission !== 'media');
}

module.exports = {
  isAudioOnlyRequest,
  portalMediaAllowed,
  portalMediaCheckAllowed,
  ensureSystemMicrophoneAccess,
  installPortalMediaPermissions,
  installBrowserTabMediaPermissions,
};
