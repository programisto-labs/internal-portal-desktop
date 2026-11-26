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
