'use strict';

/**
 * Detached tab windows: any tab of the internal browser (portal page, web page, Lasco Code)
 * can move to its own window and back, from the tab menu or by dragging the tab out of the
 * window (or onto another Lasco window).
 *
 * Pure helpers (no Electron import) so they are unit-testable. Contract: docs/tab-windows.md.
 */

const TAB_WINDOW_ARG_PREFIX = '--lasco-tab-window=';
const MAX_TITLE_LENGTH = 300;
const MAX_HREF_LENGTH = 4096;
const MAX_ID_LENGTH = 200;
const MAX_FAVICON_LENGTH = 2048;

/** A portal path: `/…`, never protocol-relative (`//host`) nor a backslash trick. */
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

/**
 * Validate a tab descriptor sent by a portal page. Returns a clean copy or null.
 * - internal: `href` is a portal path, `locationHref` is the same path.
 * - external: `href` is an http(s) URL accepted by `sanitizeBrowserUrl`; `locationHref`
 *   is the portal path the shell sits on (`…/new-tab`).
 */
function sanitizeTabDescriptor(raw, { sanitizeBrowserUrl }) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || id.length > MAX_ID_LENGTH || !/^[\w:.-]+$/.test(id)) return null;
  const kind = raw.kind === 'external' ? 'external' : 'internal';
  let href;
  if (kind === 'external') {
    href = typeof sanitizeBrowserUrl === 'function' ? sanitizeBrowserUrl(raw.href) : null;
    if (!href) return null;
  } else {
    if (!isPortalPath(raw.href)) return null;
    href = raw.href;
  }
  const locationHref = kind === 'internal' ? href : raw.locationHref;
  if (!isPortalPath(locationHref)) return null;
  const title =
    typeof raw.title === 'string' ? raw.title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) : '';
  let favicon = null;
  if (typeof raw.favicon === 'string' && raw.favicon.length <= MAX_FAVICON_LENGTH && /^https?:\/\//i.test(raw.favicon)) {
    favicon = raw.favicon;
  }
  return { id, kind, href, locationHref, title, favicon, blank: raw.blank === true && kind === 'internal' };
}

/** Window identity handed to the page through `additionalArguments` (read synchronously by the preload). */
function encodeTabWindowArg({ role, initialTab }) {
  const payload = { role: role === 'detached' ? 'detached' : 'main', initialTab: initialTab || null };
  return TAB_WINDOW_ARG_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodeTabWindowArg(argv, { decodeBase64 } = {}) {
  if (!Array.isArray(argv)) return null;
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith(TAB_WINDOW_ARG_PREFIX));
  if (!arg) return null;
  try {
    const raw = arg.slice(TAB_WINDOW_ARG_PREFIX.length);
    const json = decodeBase64 ? decodeBase64(raw) : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      role: parsed.role === 'detached' ? 'detached' : 'main',
      initialTab: parsed.initialTab && typeof parsed.initialTab === 'object' ? parsed.initialTab : null,
    };
  } catch (_) {
    return null;
  }
}

function pointInBounds(point, bounds) {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x < bounds.x + bounds.width &&
    point.y < bounds.y + bounds.height
  );
}

/**
 * The Lasco window under a screen point, other than the source. `windows` is ordered
 * front to back when the caller knows it (focused first); the first match wins.
 * Minimized / hidden windows are skipped.
 */
function findWindowAtPoint(windows, point, excludeId) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  for (const w of windows) {
    if (!w || w.id === excludeId || w.minimized || w.visible === false) continue;
    if (w.bounds && pointInBounds(point, w.bounds)) return w;
  }
  return null;
}

/**
 * Bounds of a new detached window: same size as the source window, the tab strip under
 * the pointer (like Chrome), kept inside the display work area.
 */
function buildDetachedWindowBounds({ point, size, workArea }) {
  const width = Math.max(800, Math.round(size?.width || 1100));
  const height = Math.max(500, Math.round(size?.height || 760));
  let x;
  let y;
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    x = Math.round(point.x - Math.min(160, width / 4));
    y = Math.round(point.y - 20);
  } else if (workArea) {
    x = Math.round(workArea.x + (workArea.width - width) / 2);
    y = Math.round(workArea.y + (workArea.height - height) / 2);
  }
  if (workArea && Number.isFinite(x) && Number.isFinite(y)) {
    x = Math.min(Math.max(x, workArea.x), Math.max(workArea.x, workArea.x + workArea.width - width));
    y = Math.min(Math.max(y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - height));
  }
  return {
    width: workArea ? Math.min(width, workArea.width) : width,
    height: workArea ? Math.min(height, workArea.height) : height,
    ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {}),
  };
}

/** Offset of a new window from the window it was opened from (⌘N), like Chrome. */
const NEW_WINDOW_CASCADE_PX = 28;

/**
 * Bounds of a window opened by ⌘N: same size as `sourceBounds`, shifted down-right, kept in the
 * work area (back to its top-left corner when the shift would leave it). Centred without a source.
 */
function buildNewWindowBounds({ sourceBounds, workArea }) {
  if (!sourceBounds || !Number.isFinite(sourceBounds.x) || !Number.isFinite(sourceBounds.y)) {
    return buildDetachedWindowBounds({ size: sourceBounds, workArea });
  }
  const width = Math.max(800, Math.round(sourceBounds.width || 1100));
  const height = Math.max(500, Math.round(sourceBounds.height || 760));
  let x = Math.round(sourceBounds.x + NEW_WINDOW_CASCADE_PX);
  let y = Math.round(sourceBounds.y + NEW_WINDOW_CASCADE_PX);
  if (workArea) {
    if (x + width > workArea.x + workArea.width) x = workArea.x;
    if (y + height > workArea.y + workArea.height) y = workArea.y;
  }
  return {
    width: workArea ? Math.min(width, workArea.width) : width,
    height: workArea ? Math.min(height, workArea.height) : height,
    x,
    y,
  };
}

/**
 * Where a tab dragged out of `sourceId` lands when released at `point`:
 * another Lasco window (attach there), back over its own window (cancel), or nowhere (keep the
 * new window). The window that follows the cursor (`floatingId`) is never a target.
 */
function resolveTabDropTarget({ windows, point, sourceId, floatingId }) {
  const others = (windows || []).filter((w) => w && w.id !== floatingId);
  const hit = findWindowAtPoint(others, point, null);
  if (!hit) return { kind: 'none' };
  if (hit.id === sourceId) return { kind: 'source' };
  return { kind: 'window', id: hit.id };
}

/** Top-left of a window that follows the cursor, the grabbed point staying under it. */
function followPosition(cursor, offset) {
  return { x: Math.round(cursor.x - offset.x), y: Math.round(cursor.y - offset.y) };
}

/**
 * Tabs waiting for a window's page to be ready. A page subscribes, then calls `ready`,
 * which returns what arrived before; later tabs are sent right away. A reload makes the
 * page not ready again until it asks.
 */
function createAdoptQueue({ send }) {
  /** @type {Map<number, { ready: boolean, pending: object[] }>} */
  const states = new Map();
  const stateOf = (windowId) => {
    let s = states.get(windowId);
    if (!s) {
      s = { ready: false, pending: [] };
      states.set(windowId, s);
    }
    return s;
  };
  return {
    deliver(windowId, tab) {
      const s = stateOf(windowId);
      if (s.ready) send(windowId, tab);
      else s.pending.push(tab);
    },
    ready(windowId) {
      const s = stateOf(windowId);
      s.ready = true;
      const out = s.pending;
      s.pending = [];
      return out;
    },
    reset(windowId) {
      stateOf(windowId).ready = false;
    },
    forget(windowId) {
      states.delete(windowId);
    },
    pendingCount(windowId) {
      return states.get(windowId)?.pending.length ?? 0;
    },
  };
}

/**
 * Spare detached window (pre-loaded, hidden): usable only while its page still sits on the
 * portal path it was opened on (not on the login page, an error page or another workspace).
 */
function isSpareWindowUsable({ url, href, origin }) {
  if (!isPortalPath(href) || typeof url !== 'string') return false;
  try {
    const current = new URL(url);
    const expected = new URL(href, origin);
    return current.origin === expected.origin && current.pathname === expected.pathname;
  } catch (_) {
    return false;
  }
}

module.exports = {
  TAB_WINDOW_ARG_PREFIX,
  isSpareWindowUsable,
  isPortalPath,
  sanitizeTabDescriptor,
  encodeTabWindowArg,
  decodeTabWindowArg,
  findWindowAtPoint,
  buildDetachedWindowBounds,
  buildNewWindowBounds,
  createAdoptQueue,
  resolveTabDropTarget,
  followPosition,
};
