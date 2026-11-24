'use strict';

const crypto = require('crypto');

/**
 * Password manager of the web tabs, main-process side (docs/passwords.md).
 *
 * The Vault lives on the Lasco server; only the portal (the trusted main window) talks to it.
 * This controller sits between the web page (password-preload.js) and the portal:
 * - a sign-in captured in a page is kept in memory (5 min, one per tab) and announced to the
 *   portal WITHOUT the password; the portal takes it (once) if the user chooses to save it;
 * - the portal pushes, per tab, the Vault credentials of the page's site (ids and usernames
 *   only); a click on a login field opens a native menu with them;
 * - a fill is accepted only for the host the tab currently shows, over https (or a local host).
 *
 * Nothing is kept when the portal has not enabled the password manager (Vault off).
 */

const CAPTURE_TTL_MS = 5 * 60 * 1000;
const USERNAME_TTL_MS = 5 * 60 * 1000;
const FILL_RESULT_TIMEOUT_MS = 3000;
const MAX_SUGGESTIONS = 8;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost|.+\.test)$/i;

/** Host as the Vault stores it: lower case, no `www.`, no port. Null for non-web or plain http pages. */
function passwordHostOf(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (_) {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (parsed.protocol === 'https:') return hostname.replace(/^www\./, '') || null;
  if (parsed.protocol === 'http:' && LOCAL_HOST.test(hostname)) return hostname.replace(/^www\./, '');
  return null;
}

function cleanText(value, max) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function createPasswordController({ emit, getTabUrl, sendToTab, popupMenu, now = Date.now }) {
  let enabled = false;
  /** @type {Map<string, { id: string, host: string, username: string, password: string, at: number }>} */
  const captures = new Map();
  /** @type {Map<string, { host: string, username: string, at: number }>} */
  const usernames = new Map();
  /** @type {Map<string, { host: string, items: Array<{ id: string, username: string, label: string }> }>} */
  const suggestions = new Map();
  /** @type {Map<string, { resolve: (value: object) => void, timer: NodeJS.Timeout }>} */
  const pendingFills = new Map();

  function prune() {
    const at = now();
    for (const [tabId, capture] of captures) if (at - capture.at > CAPTURE_TTL_MS) captures.delete(tabId);
    for (const [tabId, entry] of usernames) if (at - entry.at > USERNAME_TTL_MS) usernames.delete(tabId);
  }

  function setEnabled({ enabled: next } = {}) {
    enabled = next === true;
    if (!enabled) {
      captures.clear();
      usernames.clear();
      suggestions.clear();
    }
    return { ok: true, enabled };
  }

  /** From the page: first step of a two-step sign-in. */
  function onUsername(tabId, frameUrl, payload) {
    const host = passwordHostOf(frameUrl);
    const username = cleanText(payload && payload.username, 320);
    if (!enabled || !host || !username) return;
    usernames.set(tabId, { host, username: username.trim(), at: now() });
  }

  /** From the page: a sign-in was submitted. The password never leaves this process unless the portal takes it. */
  function onCapture(tabId, frameUrl, payload) {
    prune();
    const host = passwordHostOf(frameUrl);
    const password = cleanText(payload && payload.password, 1024);
    let username = cleanText(payload && payload.username, 320) || '';
    if (!enabled || !host || !password) return;
    if (!username) {
      const previous = usernames.get(tabId);
      if (previous && previous.host === host) username = previous.username;
    }
    usernames.delete(tabId);
    const capture = { id: crypto.randomUUID(), host, username: username.trim(), password, at: now() };
    captures.set(tabId, capture);
    emit('browser-tab-password-capture', { tabId, captureId: capture.id, host, username: capture.username });
  }

  /** Portal: the user chose to save. Returns the password once, then forgets it. */
  function takeCapture({ tabId, captureId } = {}) {
    prune();
    const capture = captures.get(tabId);
    if (!capture || capture.id !== captureId) return { ok: false, error: 'expired' };
    captures.delete(tabId);
    return { ok: true, host: capture.host, username: capture.username, password: capture.password };
  }

  function dismissCapture({ tabId, captureId } = {}) {
    const capture = captures.get(tabId);
    if (capture && (!captureId || capture.id === captureId)) captures.delete(tabId);
    return { ok: true };
  }

  /** Portal: Vault credentials of the tab's site (metadata only). */
  function setSuggestions({ tabId, host, items } = {}) {
    if (typeof tabId !== 'string' || !tabId) return { ok: false, error: 'invalid-tab-id' };
    const list = (Array.isArray(items) ? items : [])
      .filter((item) => item && typeof item.id === 'string' && item.id)
      .slice(0, MAX_SUGGESTIONS)
      .map((item) => ({
        id: item.id,
        username: cleanText(item.username, 320) || '',
        label: cleanText(item.label, 200) || cleanText(item.username, 320) || '',
      }));
    if (!enabled || typeof host !== 'string' || list.length === 0) suggestions.delete(tabId);
    else suggestions.set(tabId, { host, items: list });
    return { ok: true };
  }

  /** From the page: a login field was clicked. Shows the native menu when the Vault has credentials. */
  function onField(tabId, frameUrl, payload) {
    const host = passwordHostOf(frameUrl);
    const entry = suggestions.get(tabId);
    if (!enabled || !host || !entry || entry.host !== host) return;
    const rect = payload && payload.rect;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    popupMenu(tabId, { x: rect.x, y: rect.y + rect.height }, entry.items, (choice) => {
      if (choice.type === 'fill') emit('browser-tab-password-fill-request', { tabId, host, secretId: choice.id });
      else emit('browser-tab-password-action', { tabId, host, action: choice.type });
    });
  }

  /** Portal: write a credential into the page, only on the host the tab shows right now. */
  function fill({ tabId, host, username, password, submit } = {}) {
    const currentHost = passwordHostOf(getTabUrl(tabId));
    if (!currentHost) return Promise.resolve({ ok: false, error: 'unsupported-page' });
    if (typeof host !== 'string' || host.toLowerCase().replace(/^www\./, '') !== currentHost) {
      return Promise.resolve({ ok: false, error: 'host-mismatch' });
    }
    const user = cleanText(username, 320) || '';
    const secret = cleanText(password, 1024) || '';
    if (!secret && !user) return Promise.resolve({ ok: false, error: 'empty' });
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingFills.delete(requestId);
        resolve({ ok: false, error: 'no-response' });
      }, FILL_RESULT_TIMEOUT_MS);
      pendingFills.set(requestId, { tabId, resolve, timer });
      const sent = sendToTab(tabId, 'lasco-pw:fill', { requestId, username: user, password: secret, submit: submit === true });
      if (!sent) {
        clearTimeout(timer);
        pendingFills.delete(requestId);
        resolve({ ok: false, error: 'unknown-tab' });
      }
    });
  }

  function onFillResult(tabId, payload) {
    const requestId = payload && payload.requestId;
    const pending = typeof requestId === 'string' ? pendingFills.get(requestId) : null;
    if (!pending || pending.tabId !== tabId) return;
    clearTimeout(pending.timer);
    pendingFills.delete(requestId);
    const filled = { username: payload.username === true, password: payload.password === true, submitted: payload.submitted === true };
    pending.resolve(filled.username || filled.password ? { ok: true, ...filled } : { ok: false, error: 'no-login-form', ...filled });
  }

  /** Tab closed or navigated to another site. */
  function forgetTab(tabId) {
    captures.delete(tabId);
    usernames.delete(tabId);
    suggestions.delete(tabId);
  }

  function onNavigate(tabId, url) {
    const host = passwordHostOf(url);
    const entry = suggestions.get(tabId);
    if (entry && entry.host !== host) suggestions.delete(tabId);
    const pending = usernames.get(tabId);
    if (pending && pending.host !== host) usernames.delete(tabId);
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    takeCapture,
    dismissCapture,
    setSuggestions,
    fill,
    forgetTab,
    onNavigate,
    onMessage(tabId, frameUrl, channel, payload) {
      if (channel === 'lasco-pw:capture') onCapture(tabId, frameUrl, payload);
      else if (channel === 'lasco-pw:username') onUsername(tabId, frameUrl, payload);
      else if (channel === 'lasco-pw:field') onField(tabId, frameUrl, payload);
      else if (channel === 'lasco-pw:fill-result') onFillResult(tabId, payload);
    },
  };
}

const PASSWORD_PAGE_CHANNELS = ['lasco-pw:capture', 'lasco-pw:username', 'lasco-pw:field', 'lasco-pw:fill-result'];

module.exports = { createPasswordController, passwordHostOf, PASSWORD_PAGE_CHANNELS };
