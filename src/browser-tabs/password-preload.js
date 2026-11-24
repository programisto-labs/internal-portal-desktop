'use strict';

/**
 * Password manager runtime of the web tabs (docs/passwords.md).
 *
 * Runs as the preload of every external browser view, in the main frame only, inside
 * Electron's isolated world (contextIsolation + sandbox): the page shares the DOM but can
 * never reach this script or `ipcRenderer`. Nothing is exposed with contextBridge.
 *
 * - Sign-in detection: when a form with a filled password field is submitted (submit event,
 *   click on a button, Enter), the username and password are sent once to the main process,
 *   which keeps them in memory until the portal asks the user whether to save them.
 * - Two-step sign-ins (Google, Microsoft…): the identifier typed on the first page is sent
 *   on its own and paired with the password of the next page by the main process.
 * - Login field clicked: its position goes to the main process, which shows the native
 *   suggestions menu when the Vault has credentials for this site.
 * - Fill: the main process sends a username / password to write into the fields.
 */
const { ipcRenderer } = require('electron');

const TEXT_TYPES = new Set(['', 'text', 'email', 'tel']);
const USERNAME_HINT = /user|login|email|mail|identifier|account|compte|identifiant|nom/i;
const CAPTURE_DEDUPE_MS = 3000;
const FIELD_MENU_THROTTLE_MS = 800;

let lastCapture = { key: '', at: 0 };
let lastFieldMenuAt = 0;

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
}

function inputType(el) {
  return String(el.getAttribute('type') || '').toLowerCase();
}

function isPasswordInput(el) {
  return el instanceof HTMLInputElement && inputType(el) === 'password' && !el.disabled;
}

function isTextInput(el) {
  return el instanceof HTMLInputElement && TEXT_TYPES.has(inputType(el)) && !el.disabled && !el.readOnly;
}

function visiblePasswordInputs(scope) {
  return [...(scope || document).querySelectorAll('input[type="password" i]')].filter(
    (el) => isPasswordInput(el) && isVisible(el),
  );
}

function looksLikeUsername(el) {
  const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
  if (autocomplete.includes('username') || autocomplete.includes('email')) return true;
  if (inputType(el) === 'email') return true;
  const hint = `${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`;
  return USERNAME_HINT.test(hint);
}

/** Username field of a sign-in form: hinted field, otherwise the last text field before the password. */
function usernameFieldFor(passwordInput) {
  const scope = (passwordInput && passwordInput.form) || document;
  const candidates = [...scope.querySelectorAll('input')].filter((el) => isTextInput(el) && isVisible(el));
  if (candidates.length === 0) return null;
  const hinted = candidates.filter(looksLikeUsername);
  const before = (el) =>
    !passwordInput || Boolean(el.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING);
  const pick = (list) => list.filter(before).pop() || null;
  return pick(hinted) || pick(candidates) || hinted[0] || null;
}

/** Username-only step (no visible password field yet). */
function lonelyUsernameField(scope) {
  if (visiblePasswordInputs(document).length > 0) return null;
  const candidates = [...(scope || document).querySelectorAll('input')].filter(
    (el) => isTextInput(el) && isVisible(el) && looksLikeUsername(el),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/** The password of a sign-in or sign-up form. Change-password forms keep the new one. */
function passwordToSave(scope) {
  const filled = visiblePasswordInputs(scope).filter((el) => el.value);
  if (filled.length === 0) return null;
  if (filled.length === 1) return filled[0];
  const last = filled[filled.length - 1];
  const previous = filled[filled.length - 2];
  return last.value === previous.value ? last : filled[0];
}

function scopeOf(target) {
  const el = target instanceof Element ? target : null;
  return (el && (el.closest('form') || (el.form instanceof HTMLFormElement ? el.form : null))) || document;
}

function captureFrom(target) {
  const scope = scopeOf(target);
  const passwordInput = passwordToSave(scope) || (scope !== document ? passwordToSave(document) : null);
  if (!passwordInput) {
    const usernameInput = lonelyUsernameField(scope);
    const username = usernameInput ? usernameInput.value.trim() : '';
    if (username) ipcRenderer.send('lasco-pw:username', { username });
    return;
  }
  const usernameInput = usernameFieldFor(passwordInput);
  const username = usernameInput ? usernameInput.value.trim() : '';
  const password = passwordInput.value;
  if (!password || password.length > 1024 || username.length > 320) return;
  const key = `${username}\u0000${password}`;
  const now = Date.now();
  if (lastCapture.key === key && now - lastCapture.at < CAPTURE_DEDUPE_MS) return;
  lastCapture = { key, at: now };
  ipcRenderer.send('lasco-pw:capture', { username, password });
}

function isSubmitControl(el) {
  if (!(el instanceof Element)) return false;
  const control = el.closest('button, input[type="submit" i], input[type="image" i], [role="button"]');
  if (!control) return false;
  if (control instanceof HTMLButtonElement) return (control.getAttribute('type') || 'submit').toLowerCase() === 'submit' || !control.form;
  return true;
}

document.addEventListener(
  'submit',
  (event) => {
    if (event.isTrusted) captureFrom(event.target);
  },
  true,
);

document.addEventListener(
  'click',
  (event) => {
    if (!event.isTrusted || !isSubmitControl(event.target)) return;
    captureFrom(event.target);
  },
  true,
);

document.addEventListener(
  'keydown',
  (event) => {
    if (!event.isTrusted || event.key !== 'Enter') return;
    const target = event.target;
    if (isPasswordInput(target) || isTextInput(target)) captureFrom(target);
  },
  true,
);

/** Field clicked by the user: show the native suggestions menu under it (main process decides). */
document.addEventListener(
  'pointerdown',
  (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    const target = event.target;
    let kind = null;
    if (isPasswordInput(target)) kind = 'password';
    else if (isTextInput(target)) {
      const password = visiblePasswordInputs(scopeOf(target))[0] || visiblePasswordInputs(document)[0];
      if (password ? usernameFieldFor(password) === target : lonelyUsernameField(document) === target) kind = 'username';
    }
    if (!kind) return;
    const now = Date.now();
    if (now - lastFieldMenuAt < FIELD_MENU_THROTTLE_MS) return;
    lastFieldMenuAt = now;
    const rect = target.getBoundingClientRect();
    ipcRenderer.send('lasco-pw:field', {
      kind,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    });
  },
  true,
);

/** Writes a value the way a person typing would be seen by the page's framework. */
function setFieldValue(el, value) {
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function submitFrom(el) {
  const form = el.form || el.closest('form');
  if (form) {
    const button = form.querySelector('button[type="submit" i], input[type="submit" i], button:not([type])');
    if (button && isVisible(button) && !button.disabled) {
      button.click();
      return true;
    }
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return true;
    }
  }
  return false;
}

ipcRenderer.on('lasco-pw:fill', (_event, payload) => {
  const requestId = payload && payload.requestId;
  const result = { requestId, username: false, password: false, submitted: false };
  try {
    const username = typeof payload.username === 'string' ? payload.username : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    const passwordInput = visiblePasswordInputs(document)[0] || null;
    const usernameInput = passwordInput ? usernameFieldFor(passwordInput) : lonelyUsernameField(document);
    if (usernameInput && username) {
      setFieldValue(usernameInput, username);
      result.username = true;
    }
    if (passwordInput && password) {
      setFieldValue(passwordInput, password);
      result.password = true;
    }
    if (payload.submit === true && (result.password || result.username)) {
      result.submitted = submitFrom(passwordInput || usernameInput);
    }
    // Saving what was just filled from the Vault would only re-offer the same login.
    if (result.password) lastCapture = { key: `${username}\u0000${password}`, at: Date.now() };
  } catch (_) {
    // Leave the page as it is; the main process reports "no login form".
  }
  ipcRenderer.send('lasco-pw:fill-result', result);
});
