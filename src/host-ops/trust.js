'use strict';

/**
 * Native, frontend-independent sender check for host operations.
 * Only the main frame of the main Lasco window, loaded from the exact portal origin.
 */
function isTrustedHostOpsSender({ isMainWindow, isMainFrame, frameUrl, allowedOrigins }) {
  if (!isMainWindow || !isMainFrame || typeof frameUrl !== 'string') return false;
  let origin;
  try {
    const u = new URL(frameUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    origin = u.origin;
  } catch (_) {
    return false;
  }
  return Array.isArray(allowedOrigins) && allowedOrigins.includes(origin);
}

module.exports = { isTrustedHostOpsSender };
