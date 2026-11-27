'use strict';
/*
 * Relais entre le panneau « Responsive » et Lasco Desktop. `lascoResponsive` est posé par le
 * preload de service worker de Desktop (src/browser-tabs/devtools-responsive-preload.js) ;
 * Desktop ne répond qu'au service worker de cette extension.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const bridge = self.lascoResponsive;
  if (!bridge || typeof bridge.invoke !== 'function') {
    sendResponse({ ok: false, error: 'unavailable' });
    return false;
  }
  bridge.invoke(message).then(
    (reply) => sendResponse(reply),
    () => sendResponse({ ok: false, error: 'unavailable' }),
  );
  return true;
});
