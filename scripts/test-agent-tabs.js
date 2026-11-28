'use strict';

/**
 * Onglet piloté par un agent en arrière-plan (docs/agent-tabs.md). Le gestionnaire d'onglets a besoin d'Electron :
 * ce test vérifie le câblage ; le comportement de Chromium (page cachée non ralentie, clics et saisie sans focus,
 * capture) a été mesuré dans Electron 44 et est décrit dans la doc.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

describe('onglet piloté par un agent', () => {
  it('le portail le déclare par le pont, Desktop l’applique sur l’onglet', () => {
    assert.match(read('preload.js'), /setAgentControl: \(payload\) => invokeBrowserTab\('browser-tab-set-agent-control', payload\)/);
    assert.match(read('main.js'), /'browser-tab-set-agent-control': 'setAgentControl'/);
    const manager = read('browser-tabs/manager.js');
    assert.match(manager, /function setAgentControl\(\{ tabId, active \}\)/);
    assert.match(manager, /wc\.setBackgroundThrottling\(false\)/);
    assert.match(manager, /agentControlled: agentControlled\.has\(tabId\)/);
  });

  it('une action sur un onglet caché ne prend jamais le clavier', () => {
    const manager = read('browser-tabs/manager.js');
    assert.match(manager, /if \(tabId && agentControlled\.has\(tabId\) && !\(viewsVisible && activeTabId === tabId\)\) return fn\(\);/);
    assert.equal((manager.match(/\}, tabId\);|combo\), tabId\);/g) || []).length, 3, 'clic, saisie et touche');
  });

  it('fermer l’onglet oublie son pilotage', () => {
    assert.match(read('browser-tabs/manager.js'), /tabs\.delete\(tabId\);\n    agentControlled\.delete\(tabId\);/);
  });
});

describe('attente de stabilité par onglet (agents multi-onglets)', () => {
  const { pageAgentRuntime } = require('../src/browser-tabs/agent-dom');

  function withFakePage(fn) {
    const observers = [];
    const saved = { window: global.window, document: global.document, MutationObserver: global.MutationObserver };
    global.window = {};
    global.document = { documentElement: {} };
    global.MutationObserver = class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    };
    return Promise.resolve(fn(observers)).finally(() => Object.assign(global, saved));
  }

  it('page calme : rendu après le délai sans mutation', () =>
    withFakePage(async (observers) => {
      const result = await pageAgentRuntime({ op: 'settle', quietMs: 50, maxMs: 1000 });
      assert.equal(result.stable, true);
      assert.ok(observers[0].disconnected);
    }));

  it('page qui change sans cesse : rendu au plus tard à maxMs, non stable', () =>
    withFakePage(async (observers) => {
      const pending = pageAgentRuntime({ op: 'settle', quietMs: 50, maxMs: 200 });
      const timer = setInterval(() => observers[0].callback([]), 20);
      const result = await pending;
      clearInterval(timer);
      assert.equal(result.stable, false);
      assert.ok(result.waitedMs >= 190);
    }));

  it('chaque action attend la stabilité de son onglet avant l’instantané', () => {
    const manager = read('browser-tabs/manager.js');
    assert.match(manager, /async function settleAndSnapshot\(wc\) \{\n    await waitForStablePage\(wc\);/);
    assert.match(manager, /op: 'settle', quietMs: AGENT_QUIET_MS, maxMs: AGENT_QUIET_MAX_MS/);
  });

  it('plusieurs onglets pilotés à la fois (un ensemble, pas un seul onglet)', () => {
    assert.match(read('browser-tabs/manager.js'), /const agentControlled = new Set\(\);/);
  });
});
