'use strict';

/**
 * Autofill popover of the web tabs (docs/passwords.md), drawn under a login field like Chrome's.
 *
 * It is a separate native view (`file:` page, own web contents) laid over the tab view: the web page
 * can neither read, restyle nor click it. It never takes the focus by itself: the field keeps it and
 * the page runtime forwards ↑ ↓ Enter Escape. Clicks are accepted only after the popover has been
 * shown, still, for `armDelayMs` (a page cannot pop it right under a click it expects).
 */

const MIN_WIDTH = 280;
const MAX_WIDTH = 380;
const MARGIN = 8;
const GAP = 6;
const MAX_HEIGHT = 420;
const ROW_HEIGHT = 44;
const ACTION_HEIGHT = 36;
const CHROME_HEIGHT = 58;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** First guess of the height, before the page reports its own. */
function estimateHeight(model) {
  const rows = model && Array.isArray(model.items) && model.items.length > 0 ? model.items.length : 1;
  return Math.min(MAX_HEIGHT, CHROME_HEIGHT + rows * ROW_HEIGHT + 2 * ACTION_HEIGHT);
}

/**
 * Pure: popover bounds (window content pixels) for a field `rect` (page CSS pixels), the tab view
 * bounds and its zoom. Under the field, above it when there is no room, always inside the view.
 * `null` when the field is out of the view (scrolled away) or the view is too small.
 */
function popoverBounds(rect, { view, zoom = 1, height }) {
  if (!rect || !view || ![rect.x, rect.y, rect.width, rect.height].every(finite)) return null;
  if (![view.x, view.y, view.width, view.height].every(finite)) return null;
  const z = finite(zoom) && zoom > 0 ? zoom : 1;
  const fieldX = view.x + rect.x * z;
  const fieldY = view.y + rect.y * z;
  const fieldW = rect.width * z;
  const fieldH = rect.height * z;
  if (fieldY + fieldH < view.y || fieldY > view.y + view.height) return null;
  const room = view.width - 2 * MARGIN;
  if (room < MIN_WIDTH / 2 || view.height < 2 * MARGIN + 60) return null;
  const width = Math.min(room, Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, fieldW)));
  const h = Math.min(MAX_HEIGHT, Math.max(60, finite(height) ? height : MAX_HEIGHT), view.height - 2 * MARGIN);
  const x = Math.min(Math.max(fieldX, view.x + MARGIN), view.x + view.width - MARGIN - width);
  const bottom = view.y + view.height - MARGIN;
  let y = fieldY + fieldH + GAP;
  if (y + h > bottom) {
    const above = fieldY - GAP - h;
    y = above >= view.y + MARGIN ? above : bottom - h;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(h) };
}

/**
 * @param {object} deps
 * @param {() => object} deps.createView native view factory: `{ load(), send(channel, payload), setBounds(b),
 *   setVisible(on), raise(), isFocused(), isSender(webContentsId), destroy() }`
 * @param {(tabId: string) => ({ view: object, zoom: number } | null)} deps.anchorOf tab view bounds and zoom,
 *   null when the tab is not the one shown
 * @param {() => boolean} deps.isDark
 * @param {(tabId: string) => void} deps.focusTab gives the focus back to the page after a choice
 * @param {() => void} deps.focusPortal focus for the portal (another credential, manage)
 */
function createPasswordPopover({
  createView,
  anchorOf,
  isDark,
  focusTab,
  focusPortal,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  armDelayMs = 300,
}) {
  let native = null;
  /** @type {{ tabId: string, rect: object, model: object, onChoose: (choice: object|null) => void, height: number } | null} */
  let current = null;
  let armed = false;
  let armTimer = null;

  function ensureView() {
    if (!native) {
      native = createView();
      native.load();
    }
    return native;
  }

  function place() {
    if (!current) return false;
    const anchor = anchorOf(current.tabId);
    const bounds = anchor ? popoverBounds(current.rect, { view: anchor.view, zoom: anchor.zoom, height: current.height }) : null;
    if (!bounds) return false;
    native.raise();
    native.setBounds(bounds);
    native.setVisible(true);
    return true;
  }

  function show(tabId, rect, model, onChoose) {
    // A popover already open (another field) is simply replaced.
    ensureView();
    current = { tabId, rect, model, onChoose, height: estimateHeight(model) };
    clearTimer(armTimer);
    armed = false;
    native.send('lasco-pw-popover:render', {
      dark: isDark(),
      title: model.labels.title,
      host: model.host,
      empty: model.labels.empty,
      other: model.labels.other,
      manage: model.labels.manage,
      items: model.items.map((item) => ({
        label: item.label || item.username,
        sub: item.username && item.username !== item.label ? item.username : '',
      })),
    });
    if (!place()) {
      hide();
      onChoose(null);
      return;
    }
    armTimer = setTimer(() => {
      armTimer = null;
      armed = true;
    }, armDelayMs);
  }

  function hide() {
    clearTimer(armTimer);
    armTimer = null;
    armed = false;
    current = null;
    if (native) native.setVisible(false);
  }

  function choose(choice) {
    if (!current || !armed) return;
    const { tabId, onChoose } = current;
    onChoose(choice);
    if (choice && (choice.type === 'pick' || choice.type === 'manage')) focusPortal();
    else focusTab(tabId);
  }

  /** Message from the popover page (already checked to come from its own web contents). */
  function onMessage(payload) {
    if (!current || !payload || typeof payload !== 'object') return;
    if (payload.type === 'size' && finite(payload.height)) {
      const height = Math.round(payload.height);
      if (Math.abs(height - current.height) > 1) {
        current.height = height;
        if (!place()) {
          const { onChoose } = current;
          hide();
          onChoose(null);
        }
      }
    } else if (payload.type === 'choose') {
      if (payload.action === 'item' && Number.isInteger(payload.index)) {
        const item = current.model.items[payload.index];
        if (item) choose({ type: 'fill', id: item.id });
      } else if (payload.action === 'pick' || payload.action === 'manage') {
        choose({ type: payload.action });
      }
    } else if (payload.type === 'dismiss') {
      const { tabId, onChoose } = current;
      onChoose(null);
      // Escape gives the field its focus back; a click elsewhere keeps the focus where it went.
      if (payload.reason === 'escape') focusTab(tabId);
    }
  }

  /** ↑ ↓ Enter from the page's field. Enter picks the highlighted row (once armed). */
  function key(name) {
    if (!current || !native) return;
    if (name === 'Enter' && !armed) return;
    native.send('lasco-pw-popover:key', name);
  }

  return {
    show,
    hide,
    key,
    onMessage,
    isFocused: () => Boolean(native && native.isFocused()),
    isSender: (webContentsId) => Boolean(native && native.isSender(webContentsId)),
    setDark: (dark) => native && native.send('lasco-pw-popover:theme', dark === true),
    destroy() {
      hide();
      if (native) native.destroy();
      native = null;
    },
  };
}

module.exports = { createPasswordPopover, popoverBounds, estimateHeight };
