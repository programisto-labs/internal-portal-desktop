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
 * - Form autofill (end of this file, docs/form-autofill.md): names, addresses, e-mail and phone
 *   fields of forms without a password field. Sandboxed preloads cannot require local files, hence
 *   one file for both.
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
  // An address form (no password field) belongs to the form autofill below.
  if (reportAddressField(target, trigger)) return;
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

/* ------------------------------------------------------------------------------------------------
 * Form autofill (docs/form-autofill.md): names, addresses, e-mail, phone, like Chrome's
 * « Addresses and more ». Same isolation as the password manager above: this world only, trusted
 * events only, the popover is Desktop's own view. Never a password, a card or a one-time code.
 * ---------------------------------------------------------------------------------------------- */

/** `autocomplete` tokens (WHATWG) → field type. `section-*`, `shipping`, `billing`, `home`… are skipped. */
const AUTOCOMPLETE_TYPES = {
  name: 'fullName',
  'given-name': 'givenName',
  'family-name': 'familyName',
  organization: 'organization',
  'street-address': 'streetAddress',
  'address-line1': 'addressLine1',
  'address-line2': 'addressLine2',
  'postal-code': 'postalCode',
  'address-level2': 'city',
  'address-level1': 'region',
  country: 'country',
  'country-name': 'country',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
};
/** Tokens that mean « not an address field », whatever the name says. */
const AUTOCOMPLETE_NEVER = /^(cc-|current-password|new-password|one-time-code|username|webauthn|bday|sex|url|photo|transaction-|language|impp|nickname|honorific)/;

/** Hints read in name, id, placeholder, aria-label and label text, in the languages Lasco ships. */
const NEVER_HINT = /search|recherche|suche|buscar|cerca|captcha|coupon|promo|voucher|gift|card.?num|carte|cvc|cvv|iban|bic\b|swift|password|mot.?de.?passe|passwort|contrase|otp|verification|code.?sms|siret|siren|tva|vat|birth|naissance|date/i;
const FIELD_HINTS = [
  ['email', /e-?mail|courriel|correo/i],
  ['phone', /phone|t[ée]l[ée]phone|\btel\b|\btél\b|mobile|portable|cellulaire|\bgsm\b|telefon|tel[eé]fono|cellulare/i],
  ['addressLine2', /address.?(line)?.?2|adresse.?2|addr.?2|line.?2|compl[ée]ment|appartement|apartment|\bapt\b|\bsuite\b|b[aâ]timent|building|etage|étage|zusatz/i],
  ['postalCode', /zip|postal|post.?code|code.?postal|\bcp\b|\bplz\b|\bcap\b|c[oó]digo.?postal/i],
  ['city', /city|town|ville|localit|commune|\bstadt\b|\bort\b|ciudad|citt[aà]|comune|municipio/i],
  ['country', /country|\bpays\b|\bland\b|pa[ií]s|paese|nazione/i],
  ['region', /\bstate\b|province|r[ée]gion|d[ée]partement|county|bundesland|provincia|estado/i],
  ['organization', /company|organi[sz]ation|soci[ée]t[ée]|entreprise|employer|employeur|firma|unternehmen|empresa|azienda|raison.?sociale/i],
  ['givenName', /first.?name|given.?name|\bfname\b|forename|pr[ée]nom|vorname|nombre(?!.*apellido)|nome(?!.*cognome)/i],
  ['familyName', /last.?name|family.?name|surname|\blname\b|nom.?de.?famille|nachname|apellido|cognome|\bnom\b/i],
  ['fullName', /full.?name|your.?name|nom.?complet|\bname\b|\bnom\b/i],
  ['addressLine1', /address|adresse|street|\brue\b|stra(ss|ß)e|direcci[oó]n|indirizzo|line.?1|\baddr\b|voie/i],
];
const ADDRESS_INPUT_TYPES = new Set(['', 'text', 'email', 'tel']);
const AF_FIELD_THROTTLE_MS = 800;
/** Values filled from a profile on this page: the form sent with them is already saved. */
const AF_FILLED_MEMORY_MS = 10 * 60 * 1000;

let afFilling = false;
let afField = null;
let afOpen = false;
let afHighlighted = false;
let afLastFieldAt = 0;
let afLastFilled = { key: '', at: 0 };

function labelTextOf(el) {
  const parts = [];
  if (el.labels) for (const label of el.labels) parts.push(label.textContent || '');
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const node = id ? document.getElementById(id) : null;
      if (node) parts.push(node.textContent || '');
    }
  }
  return parts.join(' ').slice(0, 200);
}

function isAddressCandidate(el) {
  if (el instanceof HTMLInputElement) {
    return ADDRESS_INPUT_TYPES.has(inputType(el)) && !el.disabled && !el.readOnly;
  }
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLSelectElement) return !el.disabled;
  return false;
}

/** Field type of an element, or null. `autocomplete` first, then the hints, like browsers do. */
function addressFieldType(el) {
  if (!isAddressCandidate(el)) return null;
  const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1] || '';
  if (last && AUTOCOMPLETE_NEVER.test(last)) return null;
  if (last && AUTOCOMPLETE_TYPES[last]) {
    const type = AUTOCOMPLETE_TYPES[last];
    return el instanceof HTMLSelectElement && type !== 'country' && type !== 'region' ? null : type;
  }
  if (el instanceof HTMLInputElement && inputType(el) === 'email') return 'email';
  if (el instanceof HTMLInputElement && inputType(el) === 'tel') return 'phone';
  const hint = `${el.name || ''} ${el.id || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${labelTextOf(el)}`;
  if (!hint.trim() || NEVER_HINT.test(hint)) return null;
  for (const [type, pattern] of FIELD_HINTS) {
    if (!pattern.test(hint)) continue;
    if (el instanceof HTMLSelectElement) return type === 'country' || type === 'region' ? type : null;
    if (el instanceof HTMLTextAreaElement) return type === 'addressLine1' ? 'streetAddress' : null;
    return type;
  }
  return null;
}

/**
 * Address fields of a form (or of the page outside any form): visible, typed. « Nom » alone (no first
 * name field) is the full name. A form with a password field belongs to the password manager.
 */
function addressFieldsOf(scope) {
  if (visiblePasswordInputs(scope).length > 0) return [];
  const fields = [];
  for (const el of scope.querySelectorAll('input, textarea, select')) {
    if (scope === document && el.form) continue;
    if (!isVisible(el)) continue;
    const type = addressFieldType(el);
    if (type) fields.push({ el, type });
  }
  const types = new Set(fields.map((field) => field.type));
  if (!types.has('givenName')) {
    for (const field of fields) if (field.type === 'familyName' && /\bnom\b/i.test(`${field.el.name} ${field.el.id} ${labelTextOf(field.el)}`) && !/famille/i.test(labelTextOf(field.el))) field.type = 'fullName';
  }
  return fields;
}

/** An address form: two kinds of address fields at least, or a field the site marked with `autocomplete`. */
function addressFormFor(target) {
  const scope = scopeOf(target);
  const fields = addressFieldsOf(scope);
  const field = fields.find((entry) => entry.el === target);
  if (!field) return null;
  const kinds = new Set(fields.map((entry) => entry.type));
  const declared = Boolean(AUTOCOMPLETE_TYPES[String(target.getAttribute('autocomplete') || '').toLowerCase().trim().split(/\s+/).pop()]);
  if (kinds.size < 2 && !declared) return null;
  return { scope, fields, field };
}

/** Focus or click on an address field: the main process shows the profiles under it. True when handled. */
function reportAddressField(target, trigger) {
  if (afFilling || filling) return false;
  const form = addressFormFor(target);
  if (!form) return false;
  if (trigger === 'click' && afOpen && afField === target) return true;
  const at = Date.now();
  if (at - afLastFieldAt < AF_FIELD_THROTTLE_MS && afField === target) return true;
  afLastFieldAt = at;
  afField = target;
  const rect = target.getBoundingClientRect();
  ipcRenderer.send('lasco-af:field', {
    fieldType: form.field.type,
    trigger,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  });
  return true;
}

function afLeave(reason) {
  if (!afOpen && reason !== 'blur') return;
  ipcRenderer.send('lasco-af:field-leave', { reason });
}

ipcRenderer.on('lasco-af:popover', (_event, state) => {
  afOpen = Boolean(state && state.open === true);
  afHighlighted = false;
});

function valueForType(fields, type) {
  if (type === 'fullName') return [fields.givenName, fields.familyName].filter(Boolean).join(' ');
  if (type === 'streetAddress') return [fields.addressLine1, fields.addressLine2].filter(Boolean).join('\n');
  return fields[type] || '';
}

function plain(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Option of a country / region list matching the value (text or value, accents ignored). */
function selectOption(select, value) {
  const wanted = plain(value);
  if (!wanted) return null;
  const options = [...select.options];
  return (
    options.find((option) => plain(option.value) === wanted || plain(option.textContent) === wanted) ||
    options.find((option) => wanted.length >= 3 && plain(option.textContent).startsWith(wanted)) ||
    null
  );
}

function setAnyValue(el, value) {
  if (el instanceof HTMLSelectElement) {
    const option = selectOption(el, value);
    if (!option) return false;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, option.value);
  } else {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function fieldsKey(fields) {
  return Object.keys(fields)
    .sort()
    .map((key) => `${key}=${plain(fields[key])}`)
    .join('|');
}

/**
 * Fill the form of the field that opened the popover: that field, and every empty address field of the
 * same form (like Chrome, a value the person already typed elsewhere is kept).
 */
ipcRenderer.on('lasco-af:fill', (_event, payload) => {
  const requestId = payload && payload.requestId;
  const fields = payload && payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  let filled = 0;
  const types = [];
  // An agent (no popover): the form the person is in, else the page's largest address form.
  const origin = payload && payload.agent === true ? null : afField;
  afFilling = true;
  try {
    const form = origin ? (origin.isConnected ? addressFormFor(origin) : null) : formForAgent();
    if (form) {
      for (const { el, type } of form.fields) {
        const value = valueForType(fields, type);
        if (!value) continue;
        if (el !== origin && el.value && !(el instanceof HTMLSelectElement)) continue;
        if (setAnyValue(el, value)) {
          filled += 1;
          if (!types.includes(type)) types.push(type);
          // Agent fill: the page snapshot shows « filled », never the value (agent-dom.js).
          if (!origin) el.setAttribute('data-lasco-autofill', '');
        }
      }
      if (origin && origin.isConnected) origin.focus();
      else if (document.activeElement instanceof HTMLElement && types.length > 0) document.activeElement.blur();
      afLastFilled = { key: fieldsKey(readAddressForm(form.fields)), at: Date.now() };
    }
  } catch (_) {
    // Leave the page as it is.
  } finally {
    afFilling = false;
  }
  ipcRenderer.send('lasco-af:fill-result', { requestId, filled, types });
});

/** Address form an agent fills: where the focus is, else the one with the most kinds of address fields. */
function formForAgent() {
  const active = document.activeElement;
  if (active && active !== document.body) {
    const form = addressFormFor(active);
    if (form) return form;
  }
  let best = null;
  for (const scope of [...document.forms, document]) {
    const fields = addressFieldsOf(scope);
    const kinds = new Set(fields.map((field) => field.type)).size;
    if (kinds >= 2 && (!best || kinds > best.kinds)) best = { scope, fields, kinds };
  }
  return best ? { scope: best.scope, fields: best.fields, field: null } : null;
}

/** Values typed in an address form, as profile fields (« Nom complet » split, street on two lines). */
function readAddressForm(fields) {
  const out = {};
  for (const { el, type } of fields) {
    let value = el instanceof HTMLSelectElement ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent : '') : el.value;
    value = String(value || '').trim();
    if (!value || value.length > 320) continue;
    if (el instanceof HTMLSelectElement && el.selectedIndex <= 0 && !el.value) continue;
    if (type === 'fullName') {
      const parts = value.split(/\s+/);
      if (!out.givenName) out.givenName = parts.shift();
      if (parts.length && !out.familyName) out.familyName = parts.join(' ');
    } else if (type === 'streetAddress') {
      const lines = value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      if (lines[0] && !out.addressLine1) out.addressLine1 = lines[0];
      if (lines.length > 1 && !out.addressLine2) out.addressLine2 = lines.slice(1).join(', ');
    } else if (!out[type]) {
      out[type] = value.replace(/\s+/g, ' ');
    }
  }
  return out;
}

/** An address form was sent: its values go to the main process, which asks the portal to offer saving them. */
function captureAddressFrom(target) {
  const scope = scopeOf(target);
  const fields = addressFieldsOf(scope);
  if (new Set(fields.map((field) => field.type)).size < 3) return;
  const values = readAddressForm(fields);
  if (Object.keys(values).length < 3) return;
  if (fieldsKey(values) === afLastFilled.key && Date.now() - afLastFilled.at < AF_FILLED_MEMORY_MS) return;
  ipcRenderer.send('lasco-af:capture', { fields: values });
}

document.addEventListener(
  'submit',
  (event) => {
    if (event.isTrusted) captureAddressFrom(event.target);
  },
  true,
);

document.addEventListener(
  'click',
  (event) => {
    if (event.isTrusted && isSubmitControl(event.target)) captureAddressFrom(event.target);
  },
  true,
);

document.addEventListener(
  'focusout',
  (event) => {
    if (event.isTrusted && event.target === afField) afLeave('blur');
  },
  true,
);

document.addEventListener(
  'input',
  (event) => {
    if (!event.isTrusted) return;
    // Typed by the person (or by the agent, as keystrokes): the value is no longer the saved one.
    if (event.target instanceof Element) event.target.removeAttribute('data-lasco-autofill');
    if (event.target === afField) afLeave('input');
  },
  true,
);

window.addEventListener('scroll', () => afLeave('scroll'), { capture: true, passive: true });
window.addEventListener('resize', () => afLeave('scroll'), { passive: true });

// ↑ ↓ Enter Escape go to the popover while it is open; the field keeps the focus. Enter without a
// highlighted row sends the form as usual (and may offer to save it).
document.addEventListener(
  'keydown',
  (event) => {
    if (!event.isTrusted) return;
    if (afOpen && event.target === afField) {
      const key = event.key;
      if (key === 'Tab') {
        afLeave('tab');
        return;
      }
      if (key === 'Enter' && afHighlighted) {
        event.preventDefault();
        event.stopImmediatePropagation();
        ipcRenderer.send('lasco-af:key', { key });
        return;
      }
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (key !== 'Escape') afHighlighted = true;
        ipcRenderer.send('lasco-af:key', { key });
        return;
      }
    }
    if (event.key === 'Enter' && isAddressCandidate(event.target) && !(event.target instanceof HTMLTextAreaElement)) {
      captureAddressFrom(event.target);
    }
  },
  true,
);

// --- Mise en veille des onglets (docs/tab-sleep.md) ---
// Champs que la personne a modifiés (événements de confiance seulement : un script de la page qui
// coche une case ne compte pas). Lu par le relevé d'avant veille, exécuté dans ce même monde isolé
// (999) : une saisie en cours garde l'onglet éveillé. Rien n'est exposé à la page.
const sleepEditedFields = new Set();
globalThis.__lascoSleepEditedFields = sleepEditedFields;
window.addEventListener(
  'input',
  (event) => {
    const target = event.target;
    if (!event.isTrusted || !target || target.nodeType !== 1) return;
    if (target.matches('input, textarea, select') || target.isContentEditable) sleepEditedFields.add(target);
  },
  true,
);
// Formulaire envoyé ou remis à zéro : sa saisie n'est plus en cours.
const forgetSleepEditedFields = (event) => {
  const form = event.target;
  if (!form || typeof form.contains !== 'function') return;
  for (const field of [...sleepEditedFields]) if (form.contains(field)) sleepEditedFields.delete(field);
};
window.addEventListener('submit', forgetSleepEditedFields, true);
window.addEventListener('reset', forgetSleepEditedFields, true);
