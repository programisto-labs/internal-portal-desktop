'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createInlineConfirm, cardBounds } = require('../src/host-ops/inline-confirm');

/** Manual clock: timers fire only on `tick`. */
function makeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    tick(ms) {
      now += ms;
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

let timers;
let events;
let cards;
let fallbacks;
let hosted;
let size;

function mk() {
  return createInlineConfirm({
    fallback: async (req) => {
      fallbacks.push(req);
      return 'once';
    },
    notifyPortal: (event) => {
      events.push(event);
      return hosted;
    },
    createCard: (id, callbacks) => {
      const card = { id, callbacks, bounds: null, visible: false, armed: false, spec: null, destroyed: false };
      card.render = (spec) => (card.spec = spec);
      card.setBounds = (b) => {
        card.bounds = b;
        card.visible = true;
      };
      card.hide = () => (card.visible = false);
      card.arm = (on) => (card.armed = on);
      card.destroy = () => (card.destroyed = true);
      cards.push(card);
      return card;
    },
    getContentSize: () => size,
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (id) => timers.clearTimer(id),
    placementWaitMs: 1500,
    armDelayMs: 600,
  });
}

const shellReq = (extra = {}) => ({
  requestId: 'call_1',
  agentName: 'Lasco AI',
  operation: 'shell.run',
  command: 'bash hello-world.sh',
  cwd: '/Users/me/project',
  timeoutMs: 120000,
  allowPersistent: false,
  notRememberableReason: '« bash » est une commande sensible : confirmée à chaque fois.',
  scope: { commandPrefix: ['bash'], cwdRoots: ['/Users/me/project'] },
  ...extra,
});

const spot = (extra = {}) => ({ visible: true, x: 20, y: 300, width: 400, height: 200, ...extra });

beforeEach(() => {
  timers = makeTimers();
  events = [];
  cards = [];
  fallbacks = [];
  hosted = true;
  size = { contentWidth: 1400, contentHeight: 900 };
});

describe('inline confirm (card drawn by Desktop in the chat)', () => {
  it('announces the request with the tool call id, then draws the card where the page reserved it', async () => {
    const inline = mk();
    const answer = inline.confirm(shellReq());
    assert.deepEqual(events[0], { type: 'request', id: 'call_1', title: 'Un agent demande à exécuter une commande', agentName: 'Lasco AI', height: 200 });
    assert.equal(inline.place('call_1', spot()), true);
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0].bounds, { x: 20, y: 300, width: 400, height: 200 });
    assert.match(cards[0].spec.message, /bash hello-world\.sh/);
    // Not armed yet: a click is ignored.
    assert.equal(inline.decide('call_1', 1), false);
    timers.tick(600);
    assert.equal(cards[0].armed, true);
    assert.equal(inline.decide('call_1', 1), true); // « Exécuter une fois »
    assert.equal(await answer, 'once');
    assert.equal(cards[0].destroyed, true);
    assert.deepEqual(events.at(-1), { type: 'resolved', id: 'call_1' });
  });

  it('a moving card is disarmed: the page cannot slide it under the cursor', async () => {
    const inline = mk();
    void inline.confirm(shellReq());
    inline.place('call_1', spot());
    timers.tick(600);
    assert.equal(cards[0].armed, true);
    inline.place('call_1', spot({ y: 320 }));
    assert.equal(cards[0].armed, false);
    assert.equal(inline.decide('call_1', 1), false);
    timers.tick(599);
    assert.equal(cards[0].armed, false);
    timers.tick(1);
    assert.equal(cards[0].armed, true);
    // Tiny jitter (scroll rounding) keeps it armed.
    inline.place('call_1', spot({ y: 321 }));
    assert.equal(cards[0].armed, true);
  });

  it('invalid spots are never used: too small, outside the window, hidden', () => {
    const limits = { contentWidth: 1000, contentHeight: 800, cardHeight: 200 };
    assert.equal(cardBounds(spot({ width: 200 }), limits), null);
    assert.equal(cardBounds(spot({ height: 120 }), limits), null);
    assert.equal(cardBounds(spot({ y: 700 }), limits), null);
    assert.equal(cardBounds(spot({ x: -1 }), limits), null);
    assert.equal(cardBounds(spot({ visible: false }), limits), null);
    assert.equal(cardBounds({ ...spot(), x: 'a' }, limits), null);
    assert.deepEqual(cardBounds(spot(), limits), { x: 20, y: 300, width: 400, height: 200 });
  });

  it('no spot in time: the regular native dialog takes over the same request', async () => {
    const inline = mk();
    const answer = inline.confirm(shellReq());
    timers.tick(1500);
    assert.equal(await answer, 'once');
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].command, 'bash hello-world.sh');
    assert.deepEqual(events.at(-1), { type: 'resolved', id: 'call_1' });
    assert.equal(inline.place('call_1', spot()), false);
  });

  it('spot lost (chat closed, scrolled away) for too long: native dialog', async () => {
    const inline = mk();
    const answer = inline.confirm(shellReq());
    inline.place('call_1', spot());
    inline.place('call_1', spot({ visible: false }));
    assert.equal(cards[0].visible, false);
    timers.tick(1000);
    inline.place('call_1', spot());
    timers.tick(1000);
    assert.equal(fallbacks.length, 0);
    inline.place('call_1', spot({ visible: false }));
    timers.tick(1500);
    assert.equal(await answer, 'once');
    assert.equal(fallbacks.length, 1);
    assert.equal(cards[0].destroyed, true);
  });

  it('no portal to host the card: native dialog right away', async () => {
    hosted = false;
    const answer = mk().confirm(shellReq());
    assert.equal(await answer, 'once');
    assert.equal(fallbacks.length, 1);
  });

  it('cancelled by the agent turn: the card goes away and the answer is deny', async () => {
    const inline = mk();
    const controller = new AbortController();
    const answer = inline.confirm(shellReq({ signal: controller.signal }));
    inline.place('call_1', spot());
    controller.abort();
    assert.equal(await answer, 'deny');
    assert.equal(cards[0].destroyed, true);
  });

  it('the card measures itself: the page is told the height, the card waits for the new spot', async () => {
    const inline = mk();
    void inline.confirm(shellReq());
    inline.place('call_1', spot());
    timers.tick(600);
    cards[0].callbacks.onSize(260);
    assert.deepEqual(events.at(-1), { type: 'size', id: 'call_1', height: 260 });
    assert.equal(cards[0].visible, false);
    assert.equal(inline.decide('call_1', 1), false);
    inline.place('call_1', spot({ height: 260 }));
    assert.equal(cards[0].bounds.height, 260);
    timers.tick(600);
    assert.equal(inline.decide('call_1', 0), true);
  });

  it('a bad id from the agent gets a generated one; buttons out of range are ignored', async () => {
    const inline = mk();
    void inline.confirm(shellReq({ requestId: 'bad id with spaces' }));
    const id = events[0].id;
    assert.match(id, /^c-/);
    inline.place(id, spot());
    timers.tick(600);
    assert.equal(inline.decide(id, 9), false);
    assert.equal(inline.list().length, 1);
    await flush();
  });
});
