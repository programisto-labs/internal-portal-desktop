'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SHORTCUTS,
  parseAccelerator,
  acceleratorFromKeyEvent,
  isReservedAccelerator,
  formatAccelerator,
  normalizeShortcuts,
  updateShortcut,
} = require('../src/background-mode');

const key = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('accelerators', () => {
  it('parses and puts modifiers in canonical order', () => {
    assert.equal(parseAccelerator('Shift+Alt+L'), 'Alt+Shift+L');
    assert.equal(parseAccelerator('Cmd+Shift+K'), 'Shift+Command+K');
    assert.equal(parseAccelerator('Option+Space'), 'Alt+Space');
    assert.equal(parseAccelerator('F5'), 'F5');
    assert.equal(parseAccelerator('Control+-'), 'Control+-');
  });

  it('rejects unknown keys, repeated or missing modifiers', () => {
    assert.equal(parseAccelerator('L'), null);
    assert.equal(parseAccelerator('Shift+L'), null);
    assert.equal(parseAccelerator('Alt+Alt+L'), null);
    assert.equal(parseAccelerator('Hyper+L'), null);
    assert.equal(parseAccelerator('Alt+Escape'), null);
    assert.equal(parseAccelerator('Alt+'), null);
    assert.equal(parseAccelerator(''), null);
    assert.equal(parseAccelerator(42), null);
  });

  it('builds an accelerator from a keystroke (physical key)', () => {
    assert.deepEqual(acceleratorFromKeyEvent(key('KeyL', { altKey: true, shiftKey: true }), { isMac: true }), {
      accelerator: 'Alt+Shift+L',
    });
    assert.deepEqual(acceleratorFromKeyEvent(key('Space', { metaKey: true, shiftKey: true }), { isMac: true }), {
      accelerator: 'Shift+Command+Space',
    });
    assert.deepEqual(acceleratorFromKeyEvent(key('Digit1', { ctrlKey: true }), { isMac: false }), {
      accelerator: 'Control+1',
    });
    assert.deepEqual(acceleratorFromKeyEvent(key('F9'), { isMac: true }), { accelerator: 'F9' });
  });

  it('waits for a key, refuses keys without modifier', () => {
    assert.deepEqual(acceleratorFromKeyEvent(key('AltLeft', { altKey: true })), { error: 'modifier-only' });
    assert.deepEqual(acceleratorFromKeyEvent(key('KeyA', { shiftKey: true })), { error: 'needs-modifier' });
    assert.deepEqual(acceleratorFromKeyEvent(key('NumpadAdd', { altKey: true })), { error: 'unsupported-key' });
    // ⊞ Windows is not offered outside macOS.
    assert.deepEqual(acceleratorFromKeyEvent(key('KeyL', { metaKey: true }), { isMac: false }), { error: 'needs-modifier' });
  });

  it('formats for each platform', () => {
    assert.equal(formatAccelerator('Alt+Shift+L', { isMac: true }), '⌥⇧L');
    assert.equal(formatAccelerator('Alt+Shift+Space', { isMac: true }), '⌥⇧ Espace');
    assert.equal(formatAccelerator('Control+Alt+Up', { isMac: false }), 'Ctrl+Alt+↑');
    assert.equal(formatAccelerator('Shift+Command+K', { isMac: true }), '⇧⌘K');
    assert.equal(formatAccelerator('', { isMac: true }), '');
  });

  it('knows reserved combinations', () => {
    assert.equal(isReservedAccelerator('Command+Q'), true);
    assert.equal(isReservedAccelerator('Alt+Shift+L'), false);
  });
});

describe('shortcut settings', () => {
  it('defaults, keeps valid values and disabled ones', () => {
    assert.deepEqual(normalizeShortcuts(null), DEFAULT_SHORTCUTS);
    assert.deepEqual(normalizeShortcuts({ toggleWindow: 'Shift+Alt+K', ask: '' }), { toggleWindow: 'Alt+Shift+K', ask: '' });
    assert.deepEqual(normalizeShortcuts({ toggleWindow: 'nope' }), DEFAULT_SHORTCUTS);
  });

  it('never keeps the same combination for both actions', () => {
    assert.deepEqual(normalizeShortcuts({ toggleWindow: 'Alt+K', ask: 'Alt+K' }), { toggleWindow: 'Alt+K', ask: '' });
  });

  it('updates one action with checks', () => {
    const base = normalizeShortcuts(null);
    assert.deepEqual(updateShortcut(base, 'ask', 'Control+Alt+K'), {
      ok: true,
      shortcuts: { toggleWindow: DEFAULT_SHORTCUTS.toggleWindow, ask: 'Control+Alt+K' },
    });
    assert.deepEqual(updateShortcut(base, 'ask', ''), { ok: true, shortcuts: { ...base, ask: '' } });
    assert.deepEqual(updateShortcut({ ...base, ask: '' }, 'ask', null), { ok: true, shortcuts: base });
    assert.deepEqual(updateShortcut(base, 'ask', 'Command+Q'), { ok: false, error: 'reserved' });
    assert.deepEqual(updateShortcut(base, 'ask', DEFAULT_SHORTCUTS.toggleWindow), { ok: false, error: 'duplicate' });
    assert.deepEqual(updateShortcut(base, 'ask', 'L'), { ok: false, error: 'invalid' });
    assert.deepEqual(updateShortcut(base, 'quit', ''), { ok: false, error: 'unknown-action' });
  });
});
