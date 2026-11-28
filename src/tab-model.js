'use strict';

/**
 * Tab model: the single list of the internal browser's tabs, held by the main process.
 *
 * One record per portal window (`key`: `main` for the main window, a generated id for a
 * detached one), and in each window one strip per scope (the workspace the page sits on, or
 * any opaque key a later feature composes, e.g. a browser profile). Each strip: ordered tabs and
 * the active tab. The page of the window is a subscribed view: it commits its strip after each
 * change and reads it back synchronously when it loads (reload, restart). Main-process changes
 * (a tab moved to another window, later `chrome.tabs` from extensions) bump the revision and are
 * pushed to the page.
 *
 * Pure (no Electron import): unit-tested by scripts/test-tab-model.js. Contract: docs/tab-model.md.
 */

const MODEL_VERSION = 1;
const MAX_TABS_PER_STRIP = 60;
const MAX_SCOPES_PER_WINDOW = 12;
const MAX_WINDOWS = 20;
const MAX_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 300;
const MAX_HREF_LENGTH = 4096;
const MAX_SCOPE_LENGTH = 300;
const MAX_FAVICON_LENGTH = 2048;
const MAIN_WINDOW_KEY = 'main';

const ID_PATTERN = /^[\w:.-]+$/;

function isPortalPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_HREF_LENGTH &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_HREF_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

function isWindowKey(value) {
  return isId(value) && value.length <= 64;
}

function isScope(value) {
  return typeof value === 'string' && value.length <= MAX_SCOPE_LENGTH && !/[\u0000-\u001f]/.test(value);
}

/**
 * A tab record sent by a page. Returns a clean copy or null.
 * `pinned` and `groupId` are kept for the pinned tabs and tab groups (not shown yet everywhere).
 */
function sanitizeTabRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isId(raw.id)) return null;
  const kind = raw.kind === 'external' ? 'external' : 'internal';
  const href = kind === 'external' ? (isHttpUrl(raw.href) ? raw.href : null) : isPortalPath(raw.href) ? raw.href : null;
  if (!href) return null;
  let favicon = null;
  if (
    typeof raw.favicon === 'string' &&
    raw.favicon.length <= MAX_FAVICON_LENGTH &&
    (isHttpUrl(raw.favicon) || isPortalPath(raw.favicon))
  ) {
    favicon = raw.favicon;
  }
  return {
    id: raw.id,
    kind,
    href,
    title: cleanText(raw.title, MAX_TITLE_LENGTH),
    favicon,
    blank: kind === 'internal' && raw.blank === true,
    lastUsedAt: Number.isFinite(raw.lastUsedAt) && raw.lastUsedAt > 0 ? Math.round(raw.lastUsedAt) : 0,
    pinned: raw.pinned === true,
    groupId: isId(raw.groupId) ? raw.groupId : null,
  };
}

/** Clean strip: valid tabs, no duplicate id, at most MAX_TABS_PER_STRIP (least recently used dropped). */
function sanitizeTabs(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tab = sanitizeTabRecord(raw);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    out.push(tab);
  }
  if (out.length <= MAX_TABS_PER_STRIP) return out;
  const keep = new Set(
    [...out]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, MAX_TABS_PER_STRIP)
      .map((tab) => tab.id),
  );
  return out.filter((tab) => keep.has(tab.id));
}

function sanitizeBounds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 200 || height < 200 || width > 20000 || height > 20000) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function emptyWindow(key, role) {
  return { key, role: role === 'detached' ? 'detached' : 'main', bounds: null, lastScope: null, strips: {} };
}

/** Copy handed to the outside (page, extensions): never the live objects. */
function cloneStrip(strip) {
  return strip
    ? { tabs: strip.tabs.map((tab) => ({ ...tab })), activeId: strip.activeId, revision: strip.revision, locationHref: strip.locationHref }
    : null;
}

/**
 * chrome.tabs-like events between two strips of the same window: created, removed, updated
 * (href, title, favicon, pinned, groupId), moved, activated. Moves between windows are reported
 * by `moveTab` as detached / attached.
 */
function diffStrips(prev, next) {
  const events = [];
  const before = prev ? prev.tabs : [];
  const after = next ? next.tabs : [];
  const beforeById = new Map(before.map((tab, index) => [tab.id, { tab, index }]));
  const afterIds = new Set(after.map((tab) => tab.id));
  for (const tab of before) {
    if (!afterIds.has(tab.id)) events.push({ type: 'removed', tabId: tab.id });
  }
  const keptBefore = before.filter((tab) => afterIds.has(tab.id)).map((tab) => tab.id);
  const keptAfter = after.filter((tab) => beforeById.has(tab.id)).map((tab) => tab.id);
  after.forEach((tab, index) => {
    const old = beforeById.get(tab.id);
    if (!old) {
      events.push({ type: 'created', tabId: tab.id, index, tab: { ...tab } });
      return;
    }
    const changes = {};
    for (const field of ['href', 'title', 'favicon', 'pinned', 'groupId', 'kind', 'blank']) {
      if (old.tab[field] !== tab[field]) changes[field] = tab[field];
    }
    if (Object.keys(changes).length > 0) events.push({ type: 'updated', tabId: tab.id, changes });
    if (keptBefore.indexOf(tab.id) !== keptAfter.indexOf(tab.id)) {
      events.push({ type: 'moved', tabId: tab.id, toIndex: index });
    }
  });
  const prevActive = prev ? prev.activeId : null;
  const nextActive = next ? next.activeId : null;
  if (nextActive && nextActive !== prevActive) events.push({ type: 'activated', tabId: nextActive });
  return events;
}

/**
 * The model. `onChange(windowKey, scope, strip, { origin })` is called after every change
 * (origin `page` for a commit, `main` for a main-process change); `onEvents(windowKey, events)`
 * with the chrome.tabs-like events; `onPersist()` when the session must be written.
 */
function createTabModel({ onChange, onEvents, onPersist, now = () => Date.now() } = {}) {
  /** @type {Map<string, ReturnType<typeof emptyWindow>>} */
  const windows = new Map();
  windows.set(MAIN_WINDOW_KEY, emptyWindow(MAIN_WINDOW_KEY, 'main'));

  const persist = () => {
    if (typeof onPersist === 'function') onPersist();
  };
  const emit = (key, scope, strip, origin, events) => {
    if (events.length > 0 && typeof onEvents === 'function') onEvents(key, events.map((e) => ({ ...e, scope })));
    if (typeof onChange === 'function') onChange(key, scope, cloneStrip(strip), { origin });
  };

  function ensureWindow(key, role = 'detached') {
    if (!isWindowKey(key)) return null;
    let win = windows.get(key);
    if (!win) {
      if (windows.size >= MAX_WINDOWS) return null;
      win = emptyWindow(key, key === MAIN_WINDOW_KEY ? 'main' : role);
      windows.set(key, win);
    }
    return win;
  }

  function writeStrip(win, scope, strip) {
    if (!win.strips[scope] && Object.keys(win.strips).length >= MAX_SCOPES_PER_WINDOW) {
      // Oldest scope out (a workspace not opened in this window for a long time).
      const oldest = Object.entries(win.strips).sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest) delete win.strips[oldest[0]];
    }
    win.strips[scope] = strip;
    win.lastScope = scope;
  }

  return {
    MAIN_WINDOW_KEY,

    /** Window record (all scopes), or null. */
    readWindow(key) {
      const win = windows.get(key);
      if (!win) return null;
      const strips = {};
      for (const [scope, strip] of Object.entries(win.strips)) strips[scope] = cloneStrip(strip);
      return { key: win.key, role: win.role, bounds: win.bounds ? { ...win.bounds } : null, lastScope: win.lastScope, strips };
    },

    readStrip(key, scope) {
      const win = windows.get(key);
      return win && isScope(scope) ? cloneStrip(win.strips[scope]) : null;
    },

    /**
     * A page commits its strip. `tabs` and `activeId` are optional (partial commit). Returns the
     * new revision, or null when refused.
     */
    commit(key, payload) {
      const p = payload && typeof payload === 'object' ? payload : {};
      if (!isScope(p.scope)) return null;
      const win = ensureWindow(key);
      if (!win) return null;
      const prev = win.strips[p.scope] || null;
      const tabs = Array.isArray(p.tabs) ? sanitizeTabs(p.tabs) : prev ? prev.tabs : [];
      let activeId = isId(p.activeId) ? p.activeId : prev ? prev.activeId : null;
      if (activeId && !tabs.some((tab) => tab.id === activeId)) activeId = tabs[0] ? tabs[0].id : null;
      const locationHref = isPortalPath(p.locationHref) ? p.locationHref : prev ? prev.locationHref : null;
      const next = {
        tabs,
        activeId,
        locationHref,
        revision: (prev ? prev.revision : 0) + 1,
        updatedAt: now(),
      };
      const events = diffStrips(prev, next);
      writeStrip(win, p.scope, next);
      emit(key, p.scope, next, 'page', events);
      persist();
      return next.revision;
    },

    /**
     * Main-process move of a tab between windows (detach, attach, drag to another window):
     * the record leaves `fromKey` and is inserted in `toKey` (same scope) at `index`, active there.
     * The record is durable even if a page reloads before committing.
     */
    moveTab({ tabId, fromKey, toKey, scope, index, tab: fallback, toRole = 'detached' }) {
      if (!isId(tabId) || !isScope(scope) || fromKey === toKey) return false;
      const from = windows.get(fromKey);
      const to = ensureWindow(toKey, toRole);
      if (!to) return false;
      let record = null;
      if (from && from.strips[scope]) {
        const prev = from.strips[scope];
        record = prev.tabs.find((tab) => tab.id === tabId) || null;
        if (record) {
          const tabs = prev.tabs.filter((tab) => tab.id !== tabId);
          const activeId = prev.activeId === tabId ? (tabs[tabs.length - 1] || {}).id || null : prev.activeId;
          const next = { ...prev, tabs, activeId, revision: prev.revision + 1, updatedAt: now() };
          writeStrip(from, scope, next);
          if (typeof onEvents === 'function') onEvents(fromKey, [{ type: 'detached', tabId, scope, toWindow: toKey }]);
          emit(fromKey, scope, next, 'main', []);
        }
      }
      if (!record) record = sanitizeTabRecord(fallback);
      if (!record) return false;
      const prev = to.strips[scope] || { tabs: [], activeId: null, revision: 0, locationHref: null, updatedAt: 0 };
      const tabs = prev.tabs.filter((tab) => tab.id !== tabId);
      const at = Number.isInteger(index) ? Math.max(0, Math.min(index, tabs.length)) : tabs.length;
      tabs.splice(at, 0, { ...record, lastUsedAt: now() });
      const next = { ...prev, tabs: tabs.slice(0, MAX_TABS_PER_STRIP), activeId: tabId, revision: prev.revision + 1, updatedAt: now() };
      writeStrip(to, scope, next);
      if (typeof onEvents === 'function') onEvents(toKey, [{ type: 'attached', tabId, scope, fromWindow: fromKey, index: at }]);
      emit(toKey, scope, next, 'main', []);
      persist();
      return true;
    },

    setBounds(key, bounds) {
      const win = windows.get(key);
      const clean = sanitizeBounds(bounds);
      if (!win || !clean) return;
      if (win.bounds && ['x', 'y', 'width', 'height'].every((k) => win.bounds[k] === clean[k])) return;
      win.bounds = clean;
      persist();
    },

    /** Window closed by the person (not at quit): its tabs go, like Chrome. The main record stays. */
    forgetWindow(key) {
      if (key === MAIN_WINDOW_KEY || !windows.has(key)) return;
      windows.delete(key);
      persist();
    },

    /** Detached windows to reopen at startup (with at least one tab), oldest first. */
    windowsToRestore() {
      const out = [];
      for (const win of windows.values()) {
        if (win.key === MAIN_WINDOW_KEY) continue;
        const strip = win.lastScope ? win.strips[win.lastScope] : null;
        if (!strip || strip.tabs.length === 0) continue;
        out.push({ key: win.key, bounds: win.bounds ? { ...win.bounds } : null, startHref: restoreHrefOf(strip) });
      }
      return out;
    },

    serialize() {
      return {
        version: MODEL_VERSION,
        windows: [...windows.values()].map((win) => ({
          key: win.key,
          role: win.role,
          bounds: win.bounds,
          lastScope: win.lastScope,
          strips: Object.fromEntries(
            Object.entries(win.strips).map(([scope, strip]) => [
              scope,
              { tabs: strip.tabs, activeId: strip.activeId, locationHref: strip.locationHref, updatedAt: strip.updatedAt },
            ]),
          ),
        })),
      };
    },

    /** Load a saved session (invalid parts dropped). */
    load(raw) {
      if (!raw || typeof raw !== 'object' || raw.version !== MODEL_VERSION || !Array.isArray(raw.windows)) return;
      for (const item of raw.windows.slice(0, MAX_WINDOWS)) {
        if (!item || typeof item !== 'object' || !isWindowKey(item.key)) continue;
        const win = emptyWindow(item.key, item.key === MAIN_WINDOW_KEY ? 'main' : 'detached');
        win.bounds = sanitizeBounds(item.bounds);
        const strips = item.strips && typeof item.strips === 'object' ? item.strips : {};
        for (const [scope, strip] of Object.entries(strips).slice(0, MAX_SCOPES_PER_WINDOW)) {
          if (!isScope(scope) || !strip || typeof strip !== 'object') continue;
          const tabs = sanitizeTabs(strip.tabs);
          const activeId = isId(strip.activeId) && tabs.some((t) => t.id === strip.activeId) ? strip.activeId : tabs[0]?.id || null;
          win.strips[scope] = {
            tabs,
            activeId,
            locationHref: isPortalPath(strip.locationHref) ? strip.locationHref : null,
            revision: 1,
            updatedAt: Number.isFinite(strip.updatedAt) ? strip.updatedAt : 0,
          };
        }
        win.lastScope = isScope(item.lastScope) && win.strips[item.lastScope] ? item.lastScope : null;
        windows.set(win.key, win);
      }
    },
  };
}

/**
 * Portal path a restored window loads: the active portal tab, or the page the strip was last
 * shown on (the new-tab page for a web tab).
 */
function restoreHrefOf(strip) {
  const active = strip.tabs.find((tab) => tab.id === strip.activeId) || strip.tabs[0];
  if (active && active.kind === 'internal') return active.href;
  return strip.locationHref || null;
}

/** New key for a detached window. */
function createWindowKey(random = Math.random) {
  return `w-${Date.now().toString(36)}-${Math.floor(random() * 1e9).toString(36)}`;
}

module.exports = {
  MODEL_VERSION,
  MAIN_WINDOW_KEY,
  MAX_TABS_PER_STRIP,
  createTabModel,
  createWindowKey,
  diffStrips,
  sanitizeTabRecord,
  sanitizeTabs,
  sanitizeBounds,
  isWindowKey,
  restoreHrefOf,
};
