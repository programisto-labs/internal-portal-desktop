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
 * - Login field focused or clicked: its position goes to the main process, which shows the
 *   autofill popover under it (Desktop's own view, the page never sees it). Arrows, Enter and
 *   Escape typed in the field are forwarded to it while it is open.
 * - Fill: the main process sends a username / password to write into the fields.
 */
const { ipcRenderer } = require('electron');

const TEXT_TYPES = new Set(['', 'text', 'email', 'tel']);
const USERNAME_HINT = /user|login|email|mail|identifier|account|compte|identifiant|nom/i;
const CAPTURE_DEDUPE_MS = 3000;
const FIELD_MENU_THROTTLE_MS = 800;
/** A password filled from the Vault is not offered for saving when the form is sent. */
const FILLED_MEMORY_MS = 10 * 60 * 1000;

let lastCapture = { key: '', at: 0 };
/** Last password written by a Vault fill on this page. */
let lastFilled = { password: '', at: 0 };
let lastFieldMenuAt = 0;

function styleVisible(el) {
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
}

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  return styleVisible(el);
}

/**
 * Password field to fill. A page hidden for a moment (Vault window open over it) may report empty
 * boxes: fall back on the first password field that its styles do not hide.
 */
function passwordFieldToFill() {
  return (
    visiblePasswordInputs(document)[0] ||
    [...document.querySelectorAll('input[type="password" i]')].find((el) => isPasswordInput(el) && styleVisible(el)) ||
    null
  );
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

/**
 * Hidden username of a password-only step: sites that already know the account (Google, Microsoft…)
 * keep it in a hidden field with `autocomplete="username"`, as browsers recommend.
 */
function hiddenUsernameValue(passwordInput) {
  const scope = (passwordInput && passwordInput.form) || document;
  for (const el of scope.querySelectorAll('input')) {
    if (!(el instanceof HTMLInputElement) || el.disabled || !el.value) continue;
    const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.split(/\s+/).includes('username') || (inputType(el) === 'email' && !isVisible(el))) {
      const value = el.value.trim();
      if (value && value.length <= 320) return value;
    }
  }
  return '';
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
  const username = (usernameInput ? usernameInput.value.trim() : '') || hiddenUsernameValue(passwordInput);
  const password = passwordInput.value;
  if (!password || password.length > 1024 || username.length > 320) return;
  // Sign-in made with a password Lasco filled from the Vault: it is already saved.
  if (password === lastFilled.password && Date.now() - lastFilled.at < FILLED_MEMORY_MS) return;
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
    // Enter that picks a row of the popover is not a sign-in.
    if (popoverOpen && popoverHighlighted && event.target === popoverField) return;
    const target = event.target;
    if (isPasswordInput(target) || isTextInput(target)) captureFrom(target);
  },
  true,
);

/** 'username' | 'password' when the element is a login field of the page, else null. */
function loginFieldKind(target) {
  if (isPasswordInput(target)) return 'password';
  if (!isTextInput(target)) return null;
  const password = visiblePasswordInputs(scopeOf(target))[0] || visiblePasswordInputs(document)[0];
  if (password ? usernameFieldFor(password) === target : lonelyUsernameField(document) === target) return 'username';
  return null;
}

function reportField(target, trigger) {
  if (filling) return;
  const kind = loginFieldKind(target);
  if (!kind) return;
  const now = Date.now();
  if (now - lastFieldMenuAt < FIELD_MENU_THROTTLE_MS && popoverField === target) return;
  lastFieldMenuAt = now;
  popoverField = target;
  const rect = target.getBoundingClientRect();
  ipcRenderer.send('lasco-pw:field', {
    kind,
    trigger,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  });
}

function leaveField(reason) {
  if (!popoverOpen && reason !== 'blur') return;
  ipcRenderer.send('lasco-pw:field-leave', { reason });
}

/** A fill moves the focus from field to field: no popover meanwhile. */
let filling = false;
/** Login field of the page that last asked for the popover. */
let popoverField = null;
/** The main process says whether the popover is shown under that field. */
let popoverOpen = false;
/** An arrow moved the highlight: Enter then belongs to the popover, not to the form. */
let popoverHighlighted = false;

ipcRenderer.on('lasco-pw:popover', (_event, state) => {
  popoverOpen = Boolean(state && state.open === true);
  popoverHighlighted = false;
});

// Focus (Tab, autofocus, click): the popover opens under the field when the Vault has credentials
// for the site, like Chrome. A click also opens it without any credential (another Vault one).
document.addEventListener(
  'focusin',
  (event) => {
    if (event.isTrusted) reportField(event.target, 'focus');
  },
  true,
);

document.addEventListener(
  'pointerdown',
  (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    if (event.target === popoverField && popoverOpen) return;
    reportField(event.target, 'click');
  },
  true,
);

document.addEventListener(
  'focusout',
  (event) => {
    if (event.isTrusted && event.target === popoverField) leaveField('blur');
  },
  true,
);

document.addEventListener(
  'input',
  (event) => {
    if (event.isTrusted && event.target === popoverField) leaveField('input');
  },
  true,
);

window.addEventListener(
  'scroll',
  () => leaveField('scroll'),
  { capture: true, passive: true },
);

window.addEventListener('resize', () => leaveField('scroll'), { passive: true });

// ↑ ↓ Enter Escape go to the popover while it is open; the field keeps the focus.
document.addEventListener(
  'keydown',
  (event) => {
    if (!event.isTrusted || !popoverOpen || event.target !== popoverField) return;
    const key = event.key;
    if (key === 'Tab') {
      leaveField('tab');
      return;
    }
    if (key === 'Enter' && !popoverHighlighted) return;
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter' && key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === 'ArrowDown' || key === 'ArrowUp') popoverHighlighted = true;
    ipcRenderer.send('lasco-pw:key', { key });
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
  filling = true;
  try {
    const username = typeof payload.username === 'string' ? payload.username : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    const passwordInput = passwordFieldToFill();
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
    if (result.password) lastFilled = { password, at: Date.now() };
  } catch (_) {
    // Leave the page as it is; the main process reports "no login form".
  } finally {
    filling = false;
  }
  ipcRenderer.send('lasco-pw:fill-result', result);
});
