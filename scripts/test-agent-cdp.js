'use strict';

/**
 * Moteur CDP des actions d'agent (docs/agent-actuation.md) : fonctions pures. Le comportement dans un vrai
 * Chromium est mesuré par scripts/agent-actuation-bench.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  buildAxPage,
  classifyWrite,
  createRefRegistry,
  indexDomSnapshot,
  isSensitiveField,
  parseCdpKeyCombo,
} = require('../src/browser-tabs/agent-cdp');

const node = (nodeId, role, name, extra = {}) => ({
  nodeId: String(nodeId),
  role: { value: role },
  name: { value: name },
  ignored: false,
  ...extra,
});

function sampleFrames() {
  return [
    {
      frameId: 'main',
      url: 'https://shop.example/cart',
      nodes: [
        node(1, 'RootWebArea', 'Panier', { childIds: ['2', '3', '4', '5', '6', '9'] }),
        node(2, 'heading', 'Votre panier', { parentId: '1', properties: [{ name: 'level', value: { value: 1 } }] }),
        node(3, 'button', 'Payer', { parentId: '1', backendDOMNodeId: 30, childIds: ['31'] }),
        node(31, 'StaticText', 'Payer', { parentId: '3' }),
        node(4, 'textbox', 'Numéro de carte', { parentId: '1', backendDOMNodeId: 40, value: { value: '4111111111111111' } }),
        node(5, 'textbox', 'Nom', { parentId: '1', backendDOMNodeId: 50, value: { value: 'Alice' } }),
        node(6, 'combobox', 'Taille', { parentId: '1', backendDOMNodeId: 60, childIds: ['7'] }),
        node(7, 'MenuListPopup', '', { parentId: '6', childIds: ['8'] }),
        node(8, 'MenuListOption', 'Grande', { parentId: '7', backendDOMNodeId: 80 }),
        node(9, 'Iframe', '', { parentId: '1', backendDOMNodeId: 90 }),
      ],
    },
    {
      frameId: 'child',
      url: 'https://shop.example/frame',
      ownerBackendId: 90,
      nodes: [
        node(100, 'RootWebArea', 'Cadre', { childIds: ['101'] }),
        node(101, 'link', 'Conditions', { parentId: '100', backendDOMNodeId: 1010 }),
      ],
    },
  ];
}

const dom = {
  byBackend: new Map([
    [40, { attributes: { __tag: 'INPUT', autocomplete: 'cc-number' }, bounds: null, doc: 0 }],
    [50, { attributes: { __tag: 'INPUT', name: 'fullname' }, bounds: [10, 2000, 100, 20], doc: 0 }],
    [1010, { attributes: { __tag: 'A', href: '/cgv' }, bounds: null, doc: 1 }],
  ]),
  docs: [{ scrollX: 0, scrollY: 0 }, { scrollX: 0, scrollY: 0 }],
};

describe('état de page par l’arbre d’accessibilité', () => {
  it('liste les éléments, cadres compris, sans jamais lire un champ sensible', () => {
    const page = buildAxPage({
      frames: sampleFrames(),
      dom,
      viewport: { width: 1000, height: 800 },
      title: 'Panier',
      url: 'https://shop.example/cart',
      registry: createRefRegistry(),
    });
    const byName = Object.fromEntries(page.elements.map((element) => [element.name, element]));
    assert.equal(byName['Numéro de carte'].sensitive, true);
    assert.equal(byName['Numéro de carte'].value, undefined);
    assert.ok(!JSON.stringify(page).includes('4111111111111111'));
    assert.equal(byName.Nom.value, 'Alice');
    assert.deepEqual(byName.Taille.options, ['Grande']);
    assert.equal(byName.Conditions.frame, 1);
    assert.equal(byName.Conditions.href, 'https://shop.example/cgv');
    assert.match(page.text, /^# Votre panier/);
    // Hors écran : en fin de liste.
    assert.equal(page.elements.at(-1).name, 'Nom');
    assert.equal(byName.Nom.inViewport, false);
  });

  it('garde la même ref pour le même élément tant que le document ne change pas', () => {
    const registry = createRefRegistry();
    registry.sync('doc-1');
    const first = buildAxPage({ frames: sampleFrames(), dom, title: '', url: '', registry });
    registry.sync('doc-1');
    const second = buildAxPage({ frames: sampleFrames().map((frame, index) => (index === 0 ? { ...frame, nodes: frame.nodes.filter((entry) => entry.nodeId !== '5') } : frame)), dom, title: '', url: '', registry });
    const refOf = (page, name) => page.elements.find((element) => element.name === name).ref;
    assert.equal(refOf(first, 'Payer'), refOf(second, 'Payer'));
    assert.equal(refOf(first, 'Conditions'), refOf(second, 'Conditions'));
    registry.sync('doc-2');
    assert.equal(registry.lookup(refOf(first, 'Payer')), null);
  });

  it('borne le nombre d’éléments et la taille du texte', () => {
    const nodes = [node(1, 'RootWebArea', '', { childIds: [] })];
    for (let index = 0; index < 600; index += 1) {
      nodes[0].childIds.push(String(index + 2));
      nodes.push(node(index + 2, 'link', `Lien ${index} ${'x'.repeat(50)}`, { parentId: '1', backendDOMNodeId: 1000 + index }));
    }
    const page = buildAxPage({ frames: [{ frameId: 'main', url: 'https://a.example', nodes }], title: '', url: '', registry: createRefRegistry(), maxElements: 9999, maxText: 500 });
    assert.equal(page.elements.length, 400);
    assert.equal(page.totalInteractive, 600);
    assert.ok(page.text.length <= 500);
    assert.equal(page.textTruncated, true);
  });
});

describe('index DOMSnapshot', () => {
  it('lit attributs et positions par backendNodeId', () => {
    const snapshot = {
      strings: ['https://a.example/', 'INPUT', 'type', 'password', 'main'],
      documents: [
        {
          documentURL: 0,
          frameId: 4,
          nodes: { backendNodeId: [7], nodeName: [1], attributes: [[2, 3]] },
          layout: { nodeIndex: [0], bounds: [[1, 2, 3, 4]] },
        },
      ],
    };
    const index = indexDomSnapshot(snapshot);
    assert.deepEqual(index.byBackend.get(7).attributes, { __tag: 'INPUT', type: 'password' });
    assert.deepEqual(index.byBackend.get(7).bounds, [1, 2, 3, 4]);
  });
});

describe('champs sensibles', () => {
  it('mots de passe, cartes, codes, IBAN', () => {
    assert.equal(isSensitiveField({ __tag: 'input', type: 'password' }), true);
    assert.equal(isSensitiveField({ __tag: 'input', autocomplete: 'cc-number' }), true);
    assert.equal(isSensitiveField({ __tag: 'input', autocomplete: 'one-time-code' }), true);
    assert.equal(isSensitiveField({ __tag: 'input', name: 'cvc' }), true);
    assert.equal(isSensitiveField({ __tag: 'input', placeholder: 'Votre IBAN' }), true);
    assert.equal(isSensitiveField({ __tag: 'input', 'aria-label': 'Mot de passe' }), true);
  });
  it('les champs ordinaires restent lisibles', () => {
    assert.equal(isSensitiveField({ __tag: 'input', name: 'email' }), false);
    assert.equal(isSensitiveField({ __tag: 'input', name: 'fullname', autocomplete: 'name' }), false);
    assert.equal(isSensitiveField({ __tag: 'input', type: 'checkbox', name: 'remember-password' }), false);
  });
});

describe('écritures à faire valider', () => {
  it('envoi de formulaire, achat, suppression, dépôt, confirmation', () => {
    assert.equal(classifyWrite('click', { tag: 'button', type: '', inForm: true, name: 'Continuer' }).reason, 'form_submit');
    assert.equal(classifyWrite('click', { tag: 'button', name: 'Payer 49 €' }).reason, 'write_action');
    assert.equal(classifyWrite('click', { tag: 'a', name: 'Supprimer le compte' }).reason, 'write_action');
    assert.equal(classifyWrite('click', { tag: 'button', name: 'Envoyer' }).reason, 'write_action');
    assert.equal(classifyWrite('upload', { name: 'Justificatif' }).reason, 'upload');
    assert.equal(classifyWrite('dialog_accept', {}, { message: 'Supprimer ?' }).reason, 'dialog_accept');
    assert.equal(classifyWrite('submit', { inForm: true, searchForm: false, name: 'Commentaire' }).reason, 'form_submit');
  });
  it('lecture, navigation, recherche : sans validation', () => {
    assert.equal(classifyWrite('click', { tag: 'a', name: 'Voir les détails' }), null);
    assert.equal(classifyWrite('click', { tag: 'button', type: 'button', inForm: true, name: 'Afficher le mot de passe' }), null);
    assert.equal(classifyWrite('click', { tag: 'button', type: 'submit', inForm: true, searchForm: true, name: 'OK' }), null);
    assert.equal(classifyWrite('click', { tag: 'button', type: 'submit', inForm: true, name: 'Rechercher' }), null);
    assert.equal(classifyWrite('submit', { inForm: true, searchForm: true }), null);
    assert.equal(classifyWrite('submit', { inForm: false }), null);
    assert.equal(classifyWrite('click', { tag: 'button', name: 'Continuer sans accepter' }), null);
  });
});

describe('touches', () => {
  it('Entrée, flèches, lettres, raccourcis d’édition', () => {
    assert.deepEqual(
      { key: parseCdpKeyCombo('Enter').key, text: parseCdpKeyCombo('Enter').text, printable: parseCdpKeyCombo('Enter').printable },
      { key: 'Enter', text: '\r', printable: true },
    );
    assert.equal(parseCdpKeyCombo('ArrowDown').keyCode, 40);
    assert.equal(parseCdpKeyCombo('Shift+a').key, 'A');
    const selectAll = parseCdpKeyCombo('Mod+a', 'darwin');
    assert.equal(selectAll.modifiers, 4);
    assert.deepEqual(selectAll.commands, ['selectAll']);
    assert.equal(selectAll.printable, false);
    assert.equal(parseCdpKeyCombo('Control+a', 'linux').modifiers, 2);
    assert.equal(parseCdpKeyCombo('Hyper+a'), null);
    assert.equal(parseCdpKeyCombo('Banana'), null);
  });
});

describe('câblage', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  it('le portail voit le moteur, la VM transmet la garde', () => {
    assert.match(read('src/preload.js'), /agentCapabilities: Object\.freeze\(\{ engine: 'cdp', guard: true/);
    assert.match(read('src/vm-mode.js'), /out\.guard = \{ writeGate: body\.guard\.writeGate === true, approved: body\.guard\.approved === true \}/);
    assert.match(read('src/browser-tabs/manager.js'), /async function legacyAgentAction\(payload\)/);
  });
  it('le débogueur de l’onglet n’est jamais détaché par le moteur', () => {
    assert.doesNotMatch(read('src/browser-tabs/agent-cdp.js'), /\.detach\(/);
  });
});
