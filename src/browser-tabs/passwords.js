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
 *   only); focusing a login field opens Desktop's autofill popover under it (like Chrome): the
 *   site's credentials, « choose another Vault credential », « manage passwords ». Without any
 *   credential for the site, the popover opens on a click only, never on focus;
 * - a fill is accepted only for the host the tab currently shows, over https (or a local host).
 *
 * Nothing is kept when the portal has not enabled the password manager (Vault off).
 */

const CAPTURE_TTL_MS = 5 * 60 * 1000;
const USERNAME_TTL_MS = 5 * 60 * 1000;
const FILL_RESULT_TIMEOUT_MS = 3000;
const MAX_SUGGESTIONS = 8;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost|.+\.test)$/i;
/** A field that loses focus closes the popover, unless the person is clicking in it. */
const BLUR_GRACE_MS = 150;
const POPOVER_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape']);
const DEFAULT_LABELS = {
  title: 'Coffre Lasco',
  empty: 'Aucun identifiant enregistré pour ce site',
  other: 'Choisir un identifiant du Coffre…',
  manage: 'Gérer les mots de passe',
};

function cleanLabels(labels) {
  const out = { ...DEFAULT_LABELS };
  if (labels && typeof labels === 'object') {
    for (const key of Object.keys(DEFAULT_LABELS)) {
      const value = cleanText(labels[key], 120);
      if (value && value.trim()) out[key] = value.trim();
    }
  }
  return out;
}

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

/**
 * `popover` draws the autofill popover (manager.js): `show(tabId, rect, model, onChoose)` (rect in page
 * CSS pixels), `hide()`, `key(name)` → whether the key was used, `isFocused()`.
 */
function createPasswordController({
  emit,
  getTabUrl,
  sendToTab,
  popover,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let enabled = false;
  /** @type {Map<string, { id: string, host: string, username: string, password: string, at: number }>} */
  const captures = new Map();
  /** @type {Map<string, { host: string, username: string, at: number }>} */
  const usernames = new Map();
  /** @type {Map<string, { host: string, items: Array<{ id: string, username: string, label: string }> }>} */
  const suggestions = new Map();
  /** @type {Map<string, { resolve: (value: object) => void, timer: NodeJS.Timeout }>} */
  const pendingFills = new Map();
  /** Tab whose login field shows the popover. */
  let popoverTab = null;
  let blurTimer = null;

  function hidePopover(tabId) {
    if (!popoverTab || (tabId && tabId !== popoverTab)) return;
    const tab = popoverTab;
    popoverTab = null;
    clearTimer(blurTimer);
    blurTimer = null;
    popover.hide();
    sendToTab(tab, 'lasco-pw:popover', { open: false });
  }

  function prune() {
    const at = now();
    for (const [tabId, capture] of captures) if (at - capture.at > CAPTURE_TTL_MS) captures.delete(tabId);
    for (const [tabId, entry] of usernames) if (at - entry.at > USERNAME_TTL_MS) usernames.delete(tabId);
  }

  function setEnabled({ enabled: next } = {}) {
    enabled = next === true;
    if (!enabled) {
      hidePopover();
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

  /**
   * Portal: Vault credentials of the tab's site (metadata only), and the popover texts in the person's
   * language. An empty list is kept: the popover still offers another Vault credential on a click.
   */
  function setSuggestions({ tabId, host, items, labels } = {}) {
    if (typeof tabId !== 'string' || !tabId) return { ok: false, error: 'invalid-tab-id' };
    const list = (Array.isArray(items) ? items : [])
      .filter((item) => item && typeof item.id === 'string' && item.id)
      .slice(0, MAX_SUGGESTIONS)
      .map((item) => ({
        id: item.id,
        username: cleanText(item.username, 320) || '',
        label: cleanText(item.label, 200) || cleanText(item.username, 320) || '',
      }));
    const siteHost = typeof host === 'string' ? host.toLowerCase().replace(/^www\./, '') : '';
    if (!enabled || !siteHost) suggestions.delete(tabId);
    else suggestions.set(tabId, { host: siteHost, items: list, labels: cleanLabels(labels) });
    if (popoverTab === tabId) hidePopover(tabId);
    return { ok: true };
  }

  /**
   * From the page: a login field got the focus (`trigger: 'focus'`) or was clicked (`'click'`).
   * Opens the popover under it for the tab's site.
   */
  function onField(tabId, frameUrl, payload) {
    const host = passwordHostOf(frameUrl);
    const entry = suggestions.get(tabId);
    if (!enabled || !host || !entry || entry.host !== host) return;
    const rect = payload && payload.rect;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    const trigger = payload.trigger === 'focus' ? 'focus' : 'click';
    if (entry.items.length === 0 && trigger === 'focus') return;
    clearTimer(blurTimer);
    blurTimer = null;
    const model = { host, items: entry.items.map(({ id, username, label }) => ({ id, username, label })), labels: entry.labels };
    popoverTab = tabId;
    popover.show(tabId, rect, model, (choice) => {
      hidePopover(tabId);
      if (!choice) return;
      if (choice.type === 'fill' && entry.items.some((item) => item.id === choice.id)) {
        emit('browser-tab-password-fill-request', { tabId, host, secretId: choice.id });
      } else if (choice.type === 'pick' || choice.type === 'manage') {
        emit('browser-tab-password-action', { tabId, host, action: choice.type });
      }
    });
    // Not shown (field out of the view): the callback already closed it.
    if (popoverTab === tabId) sendToTab(tabId, 'lasco-pw:popover', { open: true });
  }

  /** From the page: the field lost the focus, the person typed or scrolled. */
  function onFieldLeave(tabId, payload) {
    if (popoverTab !== tabId) return;
    if (!payload || payload.reason !== 'blur') {
      hidePopover(tabId);
      return;
    }
    // The page's field loses the focus when the person clicks the popover itself: wait and look.
    clearTimer(blurTimer);
    blurTimer = setTimer(() => {
      blurTimer = null;
      if (popoverTab === tabId && !popover.isFocused()) hidePopover(tabId);
    }, BLUR_GRACE_MS);
  }

  /** From the page: arrows, Enter and Escape typed in the field while the popover is open. */
  function onKey(tabId, payload) {
    const key = payload && payload.key;
    if (popoverTab !== tabId || !POPOVER_KEYS.has(key)) return;
    if (key === 'Escape') hidePopover(tabId);
    else popover.key(key);
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
    hidePopover(tabId);
    captures.delete(tabId);
    usernames.delete(tabId);
    suggestions.delete(tabId);
  }

  function onNavigate(tabId, url) {
    hidePopover(tabId);
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
    /** The tab view moved, was hidden or covered: the popover would float over the wrong place. */
    hidePopover: () => hidePopover(),
    popoverTabId: () => popoverTab,
    onMessage(tabId, frameUrl, channel, payload) {
      if (channel === 'lasco-pw:capture') onCapture(tabId, frameUrl, payload);
      else if (channel === 'lasco-pw:username') onUsername(tabId, frameUrl, payload);
      else if (channel === 'lasco-pw:field') onField(tabId, frameUrl, payload);
      else if (channel === 'lasco-pw:field-leave') onFieldLeave(tabId, payload);
      else if (channel === 'lasco-pw:key') onKey(tabId, payload);
      else if (channel === 'lasco-pw:fill-result') onFillResult(tabId, payload);
    },
  };
}

const PASSWORD_PAGE_CHANNELS = [
  'lasco-pw:capture',
  'lasco-pw:username',
  'lasco-pw:field',
  'lasco-pw:field-leave',
  'lasco-pw:key',
  'lasco-pw:fill-result',
];

module.exports = { createPasswordController, passwordHostOf, PASSWORD_PAGE_CHANNELS };
