'use strict';

/**
 * Confirmations of agent operations shown as a card in the Lasco AI chat, drawn by Desktop.
 *
 * The portal only reserves the space: it renders a placeholder in the chat and reports where it is.
 * Desktop draws its own native view (separate web contents, `file:` page) on top of that spot, with the
 * text built here from the operation plan and the buttons. A portal script cannot read, change or
 * click that view: the decision still comes from Desktop alone.
 *
 * Guards:
 * - the card is shown only on a valid spot (large enough, fully inside the window, reported visible);
 * - buttons are armed only after the card has stayed still for `armDelayMs`: a page cannot slide the
 *   card under the cursor right before a click;
 * - no valid spot within `placementWaitMs` (chat closed, older portal, tab hidden), or the spot lost for
 *   `placementWaitMs`: the regular native dialog takes over, for the same request.
 */

const crypto = require('crypto');
const { buildConfirmDialog } = require('./confirm');

const MIN_WIDTH = 280;
const MIN_HEIGHT = 96;
const MAX_HEIGHT = 560;
const DEFAULT_HEIGHT = 200;
const MOVE_TOLERANCE = 2;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}

/**
 * Pure: the bounds of the native card for a placement reported by the page, or `null` when it may not
 * be shown there. `placement` is in window content pixels (already multiplied by the zoom factor).
 */
function cardBounds(placement, { contentWidth, contentHeight, cardHeight }) {
  if (!placement || placement.visible !== true) return null;
  const x = Math.round(num(placement.x));
  const y = Math.round(num(placement.y));
  const width = Math.round(num(placement.width));
  const slot = Math.round(num(placement.height));
  if (![x, y, width, slot].every(Number.isFinite)) return null;
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(cardHeight || DEFAULT_HEIGHT)));
  if (width < MIN_WIDTH || slot < height - 4) return null;
  if (x < 0 || y < 0 || x + width > contentWidth || y + height > contentHeight) return null;
  return { x, y, width, height };
}

function sameBounds(a, b) {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) <= MOVE_TOLERANCE &&
    Math.abs(a.y - b.y) <= MOVE_TOLERANCE &&
    Math.abs(a.width - b.width) <= MOVE_TOLERANCE &&
    a.height === b.height
  );
}

function createInlineConfirm({
  /** Regular native dialog (`createConfirm`), used when the chat cannot host the card. */
  fallback,
  /** Sends an event to the portal page; returns false when there is no portal to host the card. */
  notifyPortal,
  /** Creates the native card for one request: `{ render(spec), setBounds(b), hide(), arm(on), destroy() }`. */
  createCard,
  /** Window content size in pixels, or `null` when the window is gone or minimized. */
  getContentSize,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  placementWaitMs = 1500,
  armDelayMs = 600,
}) {
  const pending = new Map();

  function finish(entry, decision) {
    if (entry.done) return;
    entry.done = true;
    clearTimer(entry.armTimer);
    clearTimer(entry.lostTimer);
    pending.delete(entry.id);
    try {
      entry.card && entry.card.destroy();
    } catch (_) {
      // the window may already be gone
    }
    notifyPortal({ type: 'resolved', id: entry.id });
    entry.resolve(decision);
  }

  function toFallback(entry) {
    if (entry.done) return;
    entry.done = true;
    clearTimer(entry.armTimer);
    clearTimer(entry.lostTimer);
    pending.delete(entry.id);
    try {
      entry.card && entry.card.destroy();
    } catch (_) {
      // ignore
    }
    notifyPortal({ type: 'resolved', id: entry.id });
    Promise.resolve(fallback(entry.req)).then(entry.resolve, () => entry.resolve('deny'));
  }

  function disarm(entry) {
    clearTimer(entry.armTimer);
    entry.armTimer = null;
    if (entry.armed) {
      entry.armed = false;
      entry.card && entry.card.arm(false);
    }
  }

  function scheduleArm(entry) {
    disarm(entry);
    entry.armTimer = setTimer(() => {
      entry.armTimer = null;
      if (entry.done || !entry.bounds) return;
      entry.armed = true;
      entry.card && entry.card.arm(true);
    }, armDelayMs);
  }

  function startLostTimer(entry) {
    if (entry.lostTimer) return;
    entry.lostTimer = setTimer(() => {
      entry.lostTimer = null;
      if (!entry.bounds) toFallback(entry);
    }, placementWaitMs);
  }

  function apply(entry, placement) {
    const size = getContentSize();
    const bounds = size ? cardBounds(placement, { ...size, cardHeight: entry.cardHeight }) : null;
    if (!bounds) {
      if (entry.bounds) {
        entry.bounds = null;
        disarm(entry);
        entry.card && entry.card.hide();
      }
      startLostTimer(entry);
      return;
    }
    clearTimer(entry.lostTimer);
    entry.lostTimer = null;
    if (sameBounds(entry.bounds, bounds)) return;
    if (!entry.card) {
      entry.card = createCard(entry.id, {
        onDecide: (index) => decide(entry.id, index),
        onSize: (height) => resize(entry.id, height),
      });
      entry.card.render(entry.spec);
    }
    entry.bounds = bounds;
    entry.card.setBounds(bounds);
    scheduleArm(entry);
  }

  /** Same contract as `createConfirm`: resolves to 'deny' | 'once' | 'always' | 'run' (harness: whole run). */
  function confirm(req) {
    return new Promise((resolve) => {
      const spec = buildConfirmDialog(req);
      const id = typeof req.requestId === 'string' && ID_RE.test(req.requestId) && !pending.has(req.requestId)
        ? req.requestId
        : `c-${crypto.randomUUID()}`;
      const entry = {
        id,
        req,
        spec,
        resolve: (answer) => resolve(answer === 'once' || answer === 'always' || answer === 'run' ? answer : 'deny'),
        card: null,
        bounds: null,
        armed: false,
        armTimer: null,
        lostTimer: null,
        cardHeight: DEFAULT_HEIGHT,
        done: false,
      };
      const hosted = notifyPortal({
        type: 'request',
        id,
        title: spec.title,
        agentName: typeof req.agentName === 'string' ? req.agentName.slice(0, 120) : '',
        height: entry.cardHeight,
      });
      if (!hosted) {
        Promise.resolve(fallback(req)).then(entry.resolve, () => entry.resolve('deny'));
        return;
      }
      pending.set(id, entry);
      startLostTimer(entry);
      if (req.signal) {
        if (req.signal.aborted) finish(entry, 'deny');
        else req.signal.addEventListener('abort', () => finish(entry, 'deny'), { once: true });
      }
    });
  }

  /** The page reports where its placeholder is (window content pixels). */
  function place(id, placement) {
    const entry = pending.get(id);
    if (!entry || entry.done) return false;
    apply(entry, placement);
    return true;
  }

  /** A button of the native card (the caller checked the sender is that card). */
  function decide(id, index) {
    const entry = pending.get(id);
    if (!entry || entry.done || !entry.armed || !entry.bounds) return false;
    if (!Number.isInteger(index) || index < 0 || index >= entry.spec.decisions.length) return false;
    finish(entry, entry.spec.decisions[index]);
    return true;
  }

  /** The card measured its content: the placeholder takes that height. */
  function resize(id, height) {
    const entry = pending.get(id);
    const h = Math.round(num(height));
    if (!entry || entry.done || !Number.isFinite(h)) return;
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h));
    if (next === entry.cardHeight) return;
    entry.cardHeight = next;
    notifyPortal({ type: 'size', id, height: next });
    // The current spot no longer fits until the page reports the new one.
    if (entry.bounds && entry.bounds.height !== next) {
      entry.bounds = null;
      disarm(entry);
      entry.card && entry.card.hide();
      startLostTimer(entry);
    }
  }

  /** Window hidden, minimized or resized: hide until the page reports a valid spot again. */
  function invalidateAll() {
    for (const entry of pending.values()) {
      if (!entry.bounds) continue;
      entry.bounds = null;
      disarm(entry);
      entry.card && entry.card.hide();
      startLostTimer(entry);
    }
  }

  /** Pending requests, for a page that (re)loads while a confirmation is waiting. */
  function list() {
    return [...pending.values()].map((e) => ({
      type: 'request',
      id: e.id,
      title: e.spec.title,
      agentName: typeof e.req.agentName === 'string' ? e.req.agentName.slice(0, 120) : '',
      height: e.cardHeight,
    }));
  }

  return { confirm, place, decide, resize, invalidateAll, list };
}

module.exports = { createInlineConfirm, cardBounds, MIN_WIDTH, MIN_HEIGHT, MAX_HEIGHT };
