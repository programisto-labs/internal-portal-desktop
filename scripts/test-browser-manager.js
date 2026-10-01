'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseKeyCombo,
  nextZoomFactor,
  buildChromiumUserAgent,
  buildAcceptLanguages,
} = require('../src/browser-tabs/manager');
const { buildPageAgentScript } = require('../src/browser-tabs/agent-dom');

describe('desktop browser manager helpers', () => {
  it('parses agent key combos', () => {
    assert.deepEqual(parseKeyCombo('Enter'), { keyCode: 'Enter', modifiers: [] });
    assert.deepEqual(parseKeyCombo('ArrowDown'), { keyCode: 'Down', modifiers: [] });
    assert.deepEqual(parseKeyCombo('Control+Shift+k'), { keyCode: 'k', modifiers: ['control', 'shift'] });
    assert.equal(parseKeyCombo('Hyper+x'), null);
    assert.equal(parseKeyCombo('NotAKey'), null);
    assert.equal(parseKeyCombo(''), null);
  });

  it('walks the Chrome zoom ladder', () => {
    assert.equal(nextZoomFactor(1, 'in'), 1.1);
    assert.equal(nextZoomFactor(1, 'out'), 0.9);
    assert.equal(nextZoomFactor(5, 'in'), 5);
    assert.equal(nextZoomFactor(0.25, 'out'), 0.25);
    assert.equal(nextZoomFactor(1.75, 'reset'), 1);
    assert.equal(nextZoomFactor(1.05, 'in'), 1.1);
  });

  it('sends the same reduced user agent as Chrome for the engine version', () => {
    assert.equal(
      buildChromiumUserAgent('darwin', '130.0.6723.191'),
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    );
    assert.match(buildChromiumUserAgent('win32', '146.0.1.2'), /\(Windows NT 10\.0; Win64; x64\).*Chrome\/146\.0\.0\.0/);
    assert.doesNotMatch(buildChromiumUserAgent(), /Electron|Lasco/i);
  });

  it('builds Accept-Language from the system languages', () => {
    assert.equal(buildAcceptLanguages(['fr-FR', 'en-US', 'fr-FR']), 'fr-FR,en-US');
    assert.equal(buildAcceptLanguages([]), 'fr-FR,fr,en-US,en');
  });

  it('serializes the page agent runtime as a self-invoking script', () => {
    const script = buildPageAgentScript({ op: 'snapshot', maxText: 10 });
    assert.match(script, /^\(function pageAgentRuntime\(command\)/);
    assert.match(script, /\{"op":"snapshot","maxText":10\}\)$/);
    assert.doesNotThrow(() => new Function(script));
  });
});
