'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createFormAutofillController,
  suggestionsFor,
  coveredBy,
  worthSaving,
} = require('../src/browser-tabs/form-autofill');
const { createPasswordPopover } = require('../src/browser-tabs/password-popover');

const marie = {
  id: 'p1',
  fields: { givenName: 'Marie', familyName: 'Curie', addressLine1: '12 rue des Écoles', postalCode: '75005', city: 'Paris', email: 'marie@example.com' },
};
const pierre = { id: 'p2', fields: { givenName: 'Pierre', familyName: 'Curie', phone: '+33 6 00 00 00 00' } };

describe('form autofill (main process)', () => {
  let events;
  let sent;
  let menus;
  let urls;
  let controller;

  beforeEach(() => {
    events = [];
    sent = [];
    menus = [];
    urls = new Map([['t1', 'https://shop.example.com/checkout']]);
    controller = createFormAutofillController({
      emit: (channel, payload) => events.push({ channel, payload }),
      getTabUrl: (tabId) => urls.get(tabId) || '',
      sendToTab: (tabId, channel, payload) => {
        if (!urls.has(tabId)) return false;
        sent.push({ tabId, channel, payload });
        return true;
      },
      popover: {
        show: (tabId, rect, model, onChoose) => menus.push({ tabId, rect, model, onChoose }),
        hide: () => undefined,
        key: () => undefined,
        isFocused: () => false,
      },
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
  });

  const rect = { x: 10, y: 20, width: 200, height: 30 };

  it('keeps nothing and shows nothing while disabled', () => {
    assert.deepEqual(controller.setProfiles({ enabled: false, profiles: [marie] }), { ok: true, enabled: false, count: 0 });
    controller.onMessage('t1', 'https://shop.example.com/checkout', 'lasco-af:field', { fieldType: 'givenName', rect });
    assert.equal(menus.length, 0);
  });

  it('lists the profiles that have a value for the focused field, then fills the form with the choice', () => {
    controller.setProfiles({ enabled: true, profiles: [marie, pierre], labels: { manage: 'Manage addresses…' } });
    controller.onMessage('t1', 'https://shop.example.com/checkout', 'lasco-af:field', { fieldType: 'city', rect });
    assert.equal(menus.length, 1);
    assert.deepEqual(
      menus[0].model.items.map((item) => item.label),
      ['Paris'],
    );
    assert.equal(menus[0].model.actions[0].label, 'Manage addresses…');
    assert.deepEqual(sent.at(-1), { tabId: 't1', channel: 'lasco-af:popover', payload: { open: true } });

    menus[0].onChoose({ type: 'fill', id: 'p1' });
    const fill = sent.find((entry) => entry.channel === 'lasco-af:fill');
    assert.equal(fill.payload.fieldType, 'city');
    assert.equal(fill.payload.fields.addressLine1, '12 rue des Écoles');

    controller.onMessage('t1', 'https://shop.example.com/checkout', 'lasco-af:fill-result', {
      requestId: fill.payload.requestId,
      filled: 5,
    });
    assert.deepEqual(events.at(-1), { channel: 'browser-tab-autofill-used', payload: { tabId: 't1', profileId: 'p1', filled: 5 } });
  });

  it('never fills another site than the one the popover was opened for', () => {
    controller.setProfiles({ enabled: true, profiles: [marie] });
    controller.onMessage('t1', 'https://shop.example.com/checkout', 'lasco-af:field', { fieldType: 'email', rect });
    urls.set('t1', 'https://evil.example.org/');
    menus[0].onChoose({ type: 'fill', id: 'p1' });
    assert.equal(sent.some((entry) => entry.channel === 'lasco-af:fill'), false);
  });

  it('ignores plain http pages and unknown field types', () => {
    controller.setProfiles({ enabled: true, profiles: [marie] });
    controller.onMessage('t1', 'http://shop.example.com/', 'lasco-af:field', { fieldType: 'city', rect });
    controller.onMessage('t1', 'https://shop.example.com/', 'lasco-af:field', { fieldType: 'password', rect });
    assert.equal(menus.length, 0);
  });

  it('offers to save a new address, not one already saved', () => {
    controller.setProfiles({ enabled: true, profiles: [marie] });
    controller.onMessage('t1', 'https://shop.example.com/checkout', 'lasco-af:capture', {
      fields: { givenName: 'marie', familyName: 'CURIE', city: 'Paris' },
    });
    assert.equal(events.length, 0);
    controller.onMessage('t1', 'https://shop.example.com/checkout', 'lasco-af:capture', {
      fields: { givenName: 'Jean', familyName: 'Dupont', addressLine1: '1 place Bellecour', city: 'Lyon', password: 'x' },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, 'browser-tab-autofill-capture');
    assert.equal(events[0].payload.host, 'shop.example.com');
    assert.equal(events[0].payload.fields.password, undefined);
    // Same form sent twice in a row: one prompt.
    controller.onMessage('t1', 'https://shop.example.com/checkout', 'lasco-af:capture', {
      fields: { givenName: 'Jean', familyName: 'Dupont', addressLine1: '1 place Bellecour', city: 'Lyon' },
    });
    assert.equal(events.length, 1);
  });

  it('fills for an agent only on the host the tab shows, and reports the filled fields', async () => {
    assert.deepEqual(await controller.fill({ tabId: 't1', host: 'other.com', fields: marie.fields }), {
      ok: false,
      error: 'host-mismatch',
    });
    urls.set('t2', 'http://plain.example.com/');
    assert.deepEqual(await controller.fill({ tabId: 't2', host: 'plain.example.com', fields: marie.fields }), {
      ok: false,
      error: 'unsupported-page',
    });
    const pending = controller.fill({ tabId: 't1', host: 'www.shop.example.com', fields: { ...marie.fields, password: 'x' } });
    const request = sent.find((entry) => entry.channel === 'lasco-af:fill');
    assert.equal(request.payload.agent, true);
    assert.equal(request.payload.fields.password, undefined);
    controller.onMessage('t1', 'https://shop.example.com/checkout', 'lasco-af:fill-result', {
      requestId: request.payload.requestId,
      filled: 3,
      types: ['givenName', 'city', 'bogus'],
    });
    assert.deepEqual(await pending, { ok: true, filled: 3, types: ['givenName', 'city'] });
    // An agent fill is recorded by the portal itself (with the agent), not as a popover use.
    assert.equal(events.some((entry) => entry.channel === 'browser-tab-autofill-used'), false);
  });

  it('manage goes to the portal', () => {
    controller.setProfiles({ enabled: true, profiles: [marie] });
    controller.onMessage('t1', 'https://shop.example.com/checkout', 'lasco-af:field', { fieldType: 'givenName', rect });
    menus[0].onChoose({ type: 'manage' });
    assert.deepEqual(events.at(-1), {
      channel: 'browser-tab-autofill-action',
      payload: { tabId: 't1', host: 'shop.example.com', action: 'manage' },
    });
  });
});

describe('form autofill helpers', () => {
  it('builds the full name and skips profiles without the field', () => {
    assert.deepEqual(
      suggestionsFor([marie, pierre], 'fullName').map((row) => row.label),
      ['Marie Curie', 'Pierre Curie'],
    );
    assert.deepEqual(suggestionsFor([marie, pierre], 'phone').map((row) => row.id), ['p2']);
  });

  it('knows when a capture is covered or worth saving', () => {
    assert.equal(coveredBy([marie], { givenName: 'Marie', city: 'PARIS' }), true);
    assert.equal(coveredBy([marie], { givenName: 'Marie', phone: '01' }), false);
    assert.equal(worthSaving({ city: 'Paris', postalCode: '75005', country: 'France' }), false);
    assert.equal(worthSaving({ givenName: 'A', city: 'B', postalCode: 'C' }), true);
  });
});

describe('shared field popover', () => {
  function makePopover() {
    const view = { visible: false, renders: [] };
    const popover = createPasswordPopover({
      createView: () => ({
        load: () => undefined,
        send: (channel, payload) => view.renders.push({ channel, payload }),
        setBounds: () => undefined,
        setVisible: (on) => {
          view.visible = on;
        },
        raise: () => undefined,
        isFocused: () => false,
        isSender: () => false,
        destroy: () => undefined,
      }),
      anchorOf: () => ({ view: { x: 0, y: 0, width: 800, height: 600 }, zoom: 1 }),
      isDark: () => false,
      focusTab: () => undefined,
      focusPortal: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    return { popover, view };
  }

  const rect = { x: 10, y: 20, width: 200, height: 30 };
  const passwordModel = { host: 'a.com', items: [], labels: { title: 'T', empty: 'E', other: 'O', manage: 'M' } };
  const autofillModel = {
    host: 'a.com',
    items: [{ id: 'p1', label: 'Paris', sub: 'Marie Curie', icon: 'pin' }],
    labels: { title: 'T' },
    actions: [{ icon: 'settings', label: 'Gérer', action: 'manage' }],
  };

  it('tells the previous owner it closed, and ignores its late hide', () => {
    const { popover, view } = makePopover();
    const closed = [];
    popover.show('t1', rect, passwordModel, (choice) => closed.push(['password', choice]), 'password');
    popover.show('t1', rect, autofillModel, (choice) => closed.push(['autofill', choice]), 'autofill');
    assert.deepEqual(closed, [['password', null]]);
    popover.hide('password');
    assert.equal(view.visible, true);
    assert.equal(popover.ownerOf(), 'autofill');
    const render = view.renders.filter((entry) => entry.channel === 'lasco-pw-popover:render').at(-1).payload;
    assert.deepEqual(render.items, [{ label: 'Paris', sub: 'Marie Curie', icon: 'pin' }]);
    assert.deepEqual(render.actions, [{ icon: 'settings', label: 'Gérer', action: 'manage' }]);
    popover.hide('autofill');
    assert.equal(view.visible, false);
  });

  it('keeps the password manager actions by default', () => {
    const { popover, view } = makePopover();
    popover.show('t1', rect, passwordModel, () => undefined);
    const render = view.renders.at(-1).payload;
    assert.deepEqual(render.actions.map((entry) => entry.action), ['pick', 'manage']);
  });
});
