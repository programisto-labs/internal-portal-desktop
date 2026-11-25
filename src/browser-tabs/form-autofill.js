'use strict';

const crypto = require('crypto');
const { passwordHostOf } = require('./passwords');

/**
 * Form autofill of the web tabs, main-process side (docs/form-autofill.md): names, addresses, e-mail,
 * phone, like Chrome's « Addresses and more ». Never passwords (password manager) nor payment cards.
 *
 * The person's profiles live on the Lasco server; the portal (trusted main window) pushes them here,
 * kept in memory only, never on disk. Then, like Chrome:
 * - an address field of a page that gets the focus opens Desktop's popover under it, listing the
 *   profiles that have a value for that field; a choice fills the whole form (page runtime);
 * - an address form submitted with values that are not saved yet is announced to the portal, which
 *   asks whether to save them (« Enregistrer l'adresse ? »).
 *
 * https only (plus local development hosts), main frame only, like the password manager.
 */

const MAX_PROFILES = 50;
const MAX_POPOVER_ITEMS = 6;
const CAPTURE_DEDUPE_MS = 30 * 1000;
const FILL_RESULT_TIMEOUT_MS = 3000;
const BLUR_GRACE_MS = 150;
const POPOVER_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape']);
const OWNER = 'autofill';

const PROFILE_FIELDS = [
  'givenName',
  'familyName',
  'organization',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'city',
  'region',
  'country',
  'email',
  'phone',
];

/** Field types the page reports (`fullName` and `streetAddress` are derived from the profile). */
const FIELD_TYPES = new Set([...PROFILE_FIELDS, 'fullName', 'streetAddress']);

const DEFAULT_LABELS = { title: 'Lasco', manage: 'Gérer les adresses…' };

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? '' : text;
}

/** Profile fields as the page may fill them: known keys, one-line text, bounded. */
function cleanFields(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of PROFILE_FIELDS) {
    const value = cleanText(input[key], 320);
    if (value) out[key] = value;
  }
  return out;
}

function cleanLabels(labels) {
  const out = { ...DEFAULT_LABELS };
  if (labels && typeof labels === 'object') {
    for (const key of Object.keys(DEFAULT_LABELS)) {
      const value = cleanText(labels[key], 120);
      if (value) out[key] = value;
    }
  }
  return out;
}

function fullName(fields) {
  return [fields.givenName, fields.familyName].filter(Boolean).join(' ');
}

/** Value of a field type for a profile (what the popover shows first, like Chrome). */
function valueFor(fields, type) {
  if (type === 'fullName') return fullName(fields);
  if (type === 'streetAddress') return [fields.addressLine1, fields.addressLine2].filter(Boolean).join(', ');
  return fields[type] || '';
}

function iconFor(type) {
  if (type === 'email') return 'mail';
  if (type === 'phone') return 'phone';
  if (type === 'organization') return 'building';
  if (['addressLine1', 'addressLine2', 'streetAddress', 'postalCode', 'city', 'region', 'country'].includes(type)) return 'pin';
  return 'user';
}

/** Second line of a suggestion: the rest of the profile, short (« 12 rue des Écoles, Paris »). */
function summaryFor(fields, type) {
  const main = valueFor(fields, type);
  const parts = [fullName(fields), fields.addressLine1, fields.city, fields.email, fields.phone].filter(
    (part) => part && part !== main,
  );
  return parts.slice(0, 2).join(', ');
}

/** Pure: popover rows for a field type, profiles that have a value for it, most used first (portal order). */
function suggestionsFor(profiles, type) {
  const seen = new Set();
  const rows = [];
  for (const profile of profiles) {
    const label = valueFor(profile.fields, type);
    if (!label) continue;
    const sub = summaryFor(profile.fields, type);
    const key = `${label}\u0000${sub}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: profile.id, label, sub, icon: iconFor(type) });
    if (rows.length >= MAX_POPOVER_ITEMS) break;
  }
  return rows;
}

/**
 * Pure: is a submitted form already covered by a profile? Same rule as the server merge: no field filled
 * on both sides differs (case, accents, punctuation ignored) and the form adds nothing.
 */
function comparable(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@+]/g, '');
}

function coveredBy(profiles, fields) {
  return profiles.some((profile) => {
    let shared = 0;
    for (const key of PROFILE_FIELDS) {
      const left = comparable(profile.fields[key]);
      const right = comparable(fields[key]);
      if (!right) continue;
      if (!left || left !== right) return false;
      shared += 1;
    }
    return shared > 0;
  });
}

/** A capture worth offering: three values, among them a name or an address line. */
function worthSaving(fields) {
  const count = Object.keys(fields).length;
  return count >= 3 && Boolean(fields.givenName || fields.familyName || fields.addressLine1);
}

/**
 * @param {object} deps
 * @param {(channel: string, payload: object) => void} deps.emit to the portal window
 * @param {(tabId: string) => string} deps.getTabUrl
 * @param {(tabId: string, channel: string, payload: object) => boolean} deps.sendToTab
 * @param {object} deps.popover shared popover (password-popover.js) bound by manager.js:
 *   `show(tabId, rect, model, onChoose)`, `hide()`, `key(name)`, `isFocused()`
 */
function createFormAutofillController({
  emit,
  getTabUrl,
  sendToTab,
  popover,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let enabled = false;
  /** @type {Array<{ id: string, fields: object }>} */
  let profiles = [];
  let labels = { ...DEFAULT_LABELS };
  let popoverTab = null;
  let blurTimer = null;
  /** @type {Map<string, { key: string, at: number }>} */
  const lastCaptures = new Map();
  /** @type {Map<string, { tabId: string, resolve: (value: object) => void, timer: NodeJS.Timeout }>} */
  const pendingFills = new Map();

  function hidePopover(tabId) {
    if (!popoverTab || (tabId && tabId !== popoverTab)) return;
    const tab = popoverTab;
    popoverTab = null;
    clearTimer(blurTimer);
    blurTimer = null;
    popover.hide();
    sendToTab(tab, 'lasco-af:popover', { open: false });
  }

  /**
   * Portal: autofill on or off (the person's setting), the profiles (most used first) and the popover
   * texts in the person's language. Off drops everything.
   */
  function setProfiles({ enabled: next, profiles: list, labels: texts } = {}) {
    enabled = next === true;
    if (!enabled) {
      hidePopover();
      profiles = [];
      lastCaptures.clear();
      return { ok: true, enabled: false, count: 0 };
    }
    profiles = (Array.isArray(list) ? list : [])
      .filter((profile) => profile && typeof profile.id === 'string' && profile.id && profile.id.length <= 64)
      .slice(0, MAX_PROFILES)
      .map((profile) => ({ id: profile.id, fields: cleanFields(profile.fields) }))
      .filter((profile) => Object.keys(profile.fields).length > 0);
    labels = cleanLabels(texts);
    if (popoverTab) hidePopover();
    return { ok: true, enabled: true, count: profiles.length };
  }

  function fillTab(tabId, profile, fieldType) {
    const requestId = crypto.randomUUID();
    const timer = setTimer(() => pendingFills.delete(requestId), FILL_RESULT_TIMEOUT_MS);
    pendingFills.set(requestId, { tabId, profileId: profile.id, timer });
    const sent = sendToTab(tabId, 'lasco-af:fill', { requestId, fieldType, fields: { ...profile.fields } });
    if (!sent) {
      clearTimer(timer);
      pendingFills.delete(requestId);
    }
  }

  /** From the page: an address field got the focus or was clicked. */
  function onField(tabId, frameUrl, payload) {
    const host = passwordHostOf(frameUrl);
    if (!enabled || !host || profiles.length === 0) return;
    const type = payload && payload.fieldType;
    if (!FIELD_TYPES.has(type)) return;
    const rect = payload.rect;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    const items = suggestionsFor(profiles, type);
    if (items.length === 0) return;
    clearTimer(blurTimer);
    blurTimer = null;
    const model = {
      host,
      items,
      labels: { title: labels.title, manage: labels.manage, empty: '', other: '' },
      actions: [{ icon: 'settings', label: labels.manage, action: 'manage' }],
    };
    popoverTab = tabId;
    popover.show(tabId, rect, model, (choice) => {
      hidePopover(tabId);
      if (!choice) return;
      if (choice.type === 'fill') {
        const profile = profiles.find((entry) => entry.id === choice.id);
        // The page may have navigated meanwhile: fill only the site the popover was opened for.
        if (profile && passwordHostOf(getTabUrl(tabId)) === host) fillTab(tabId, profile, type);
      } else if (choice.type === 'manage') {
        emit('browser-tab-autofill-action', { tabId, host, action: 'manage' });
      }
    });
    if (popoverTab === tabId) sendToTab(tabId, 'lasco-af:popover', { open: true });
  }

  function onFieldLeave(tabId, payload) {
    if (popoverTab !== tabId) return;
    if (!payload || payload.reason !== 'blur') {
      hidePopover(tabId);
      return;
    }
    clearTimer(blurTimer);
    blurTimer = setTimer(() => {
      blurTimer = null;
      if (popoverTab === tabId && !popover.isFocused()) hidePopover(tabId);
    }, BLUR_GRACE_MS);
  }

  function onKey(tabId, payload) {
    const key = payload && payload.key;
    if (popoverTab !== tabId || !POPOVER_KEYS.has(key)) return;
    if (key === 'Escape') hidePopover(tabId);
    else popover.key(key);
  }

  function onFillResult(tabId, payload) {
    const requestId = payload && payload.requestId;
    const pending = typeof requestId === 'string' ? pendingFills.get(requestId) : null;
    if (!pending || pending.tabId !== tabId) return;
    clearTimer(pending.timer);
    pendingFills.delete(requestId);
    const count = Number.isInteger(payload.filled) ? payload.filled : 0;
    if (count > 0) emit('browser-tab-autofill-used', { tabId, profileId: pending.profileId, filled: count });
  }

  /** From the page: an address form was submitted. Offered to the portal unless already saved. */
  function onCapture(tabId, frameUrl, payload) {
    const host = passwordHostOf(frameUrl);
    if (!enabled || !host) return;
    const fields = cleanFields(payload && payload.fields);
    if (!worthSaving(fields) || coveredBy(profiles, fields)) return;
    const key = PROFILE_FIELDS.map((field) => comparable(fields[field])).join('|');
    const previous = lastCaptures.get(tabId);
    if (previous && previous.key === key && now() - previous.at < CAPTURE_DEDUPE_MS) return;
    lastCaptures.set(tabId, { key, at: now() });
    emit('browser-tab-autofill-capture', { tabId, captureId: crypto.randomUUID(), host, fields });
  }

  function forgetTab(tabId) {
    hidePopover(tabId);
    lastCaptures.delete(tabId);
  }

  return {
    setProfiles,
    isEnabled: () => enabled,
    forgetTab,
    onNavigate: (tabId) => hidePopover(tabId),
    hidePopover: () => hidePopover(),
    popoverTabId: () => popoverTab,
    onMessage(tabId, frameUrl, channel, payload) {
      if (channel === 'lasco-af:field') onField(tabId, frameUrl, payload);
      else if (channel === 'lasco-af:field-leave') onFieldLeave(tabId, payload);
      else if (channel === 'lasco-af:key') onKey(tabId, payload);
      else if (channel === 'lasco-af:fill-result') onFillResult(tabId, payload);
      else if (channel === 'lasco-af:capture') onCapture(tabId, frameUrl, payload);
    },
  };
}

const FORM_AUTOFILL_PAGE_CHANNELS = [
  'lasco-af:field',
  'lasco-af:field-leave',
  'lasco-af:key',
  'lasco-af:fill-result',
  'lasco-af:capture',
];

module.exports = {
  createFormAutofillController,
  suggestionsFor,
  coveredBy,
  worthSaving,
  FORM_AUTOFILL_PAGE_CHANNELS,
  FORM_AUTOFILL_OWNER: OWNER,
};
