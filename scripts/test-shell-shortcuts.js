const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRelayedShellShortcut } = require('../src/browser-tabs/shell-shortcuts');

const mac = (input) => resolveRelayedShellShortcut(input, true);
const win = (input) => resolveRelayedShellShortcut(input, false);

test('selects a tab by its physical digit (AZERTY)', () => {
  assert.equal(mac({ key: '&', code: 'Digit1', meta: true }), 'select-tab-1');
  assert.equal(mac({ key: '8', code: 'Digit8', meta: true }), 'select-tab-8');
  assert.equal(mac({ key: '9', code: 'Digit9', meta: true }), 'select-last-tab');
  assert.equal(win({ key: '2', code: 'Digit2', control: true }), 'select-tab-2');
  assert.equal(mac({ key: '1', code: 'Digit1', control: true }), null);
});

test('moves to the next and previous tab', () => {
  assert.equal(mac({ key: 'Tab', control: true }), 'next-tab');
  assert.equal(mac({ key: 'Tab', control: true, shift: true }), 'previous-tab');
  assert.equal(mac({ key: 'ArrowRight', meta: true, alt: true }), 'next-tab');
  assert.equal(mac({ key: 'ArrowLeft', meta: true, alt: true }), 'previous-tab');
  assert.equal(mac({ key: '}', code: 'BracketRight', meta: true, shift: true }), 'next-tab');
  assert.equal(win({ key: 'Tab', control: true }), 'next-tab');
});

test('opens an agent with ⌘⌥N on macOS and Ctrl+Shift+N elsewhere, never Ctrl+Alt (AltGr)', () => {
  assert.equal(mac({ key: '¡', code: 'Digit1', meta: true, alt: true }), 'agent-1');
  assert.equal(win({ key: '!', code: 'Digit1', control: true, shift: true }), 'agent-1');
  assert.equal(win({ key: '~', code: 'Digit2', control: true, alt: true }), null);
});

test('relays favourite, history and the shortcut list, leaves the rest', () => {
  assert.equal(mac({ key: 'd', meta: true }), 'toggle-favorite');
  assert.equal(mac({ key: 'y', meta: true }), 'open-history');
  assert.equal(mac({ key: '/', meta: true, shift: true }), 'show-shortcuts');
  assert.equal(mac({ key: 'r', meta: true }), null);
  assert.equal(mac({ key: 'f', meta: true }), null);
  assert.equal(mac({ key: 'w', meta: true }), null);
  assert.equal(mac({ key: 'd' }), null);
});
