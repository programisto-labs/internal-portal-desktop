'use strict';

/**
 * Lecture et actions des agents IA dans une page web, par le protocole DevTools (docs/agent-actuation.md).
 *
 * - Lecture : arbre d'accessibilité (`Accessibility.getFullAXTree`), cadres du même processus compris, shadow
 *   DOM compris ; attributs et positions par `DOMSnapshot.captureSnapshot`. Chaque élément garde la même ref
 *   (`e12`) d'un état de page à l'autre tant que le document ne change pas.
 * - Actions : événements d'entrée réels (`Input.*`, `isTrusted`) aux coordonnées de l'élément, après l'avoir
 *   amené à l'écran et vérifié qu'il n'est pas recouvert. Attente de stabilité (chargement, réseau, DOM).
 * - Garde : champs sensibles jamais lus ni remplis ; une écriture (envoi de formulaire, achat, suppression,
 *   dépôt de fichier, accepter une confirmation) n'est pas faite sans `guard.approved` : la réponse
 *   `approval-required` la décrit, l'API la fait valider puis la rejoue.
 *
 * Le débogueur est celui que l'identité Chrome attache à chaque onglet : il n'est jamais détaché ici.
 * Les fonctions pures (snapshot, classement, touches) sont exportées pour les tests.
 */

const AGENT_WORLD_NAME = 'lasco-agent';
const OBJECT_GROUP = 'lasco-agent';
const MAX_FRAMES = 12;
const DEFAULT_MAX_ELEMENTS = 150;
const DEFAULT_MAX_TEXT = 12_000;
const MAX_OPTIONS = 25;
const STABLE_MAX_MS = 6_000;
const NETWORK_QUIET_MS = 500;
const DOM_QUIET_MS = 300;
const LONG_REQUEST_MS = 2_500;
const DIALOG_PLAN_TTL_MS = 60_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'MenuListOption',
  'PopUpButton', 'ToggleButton', 'DisclosureTriangle', 'textField', 'TextField', 'SearchBox', 'ComboBoxGrouping',
  'ComboBoxMenuButton', 'ComboBoxSelect', 'Date', 'DateTime', 'InputTime', 'ColorWell', 'scrollbar',
]);
const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'TextField', 'SearchBox', 'Date', 'DateTime', 'InputTime']);
const BLOCK_ROLES = new Set([
  'heading', 'paragraph', 'listitem', 'row', 'cell', 'gridcell', 'columnheader', 'rowheader', 'article', 'section',
  'region', 'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'form', 'dialog', 'alertdialog', 'alert',
  'status', 'list', 'table', 'group', 'blockquote', 'figure', 'LineBreak', 'DescriptionListTerm', 'DescriptionListDetail',
]);
const NOTICE_ROLES = new Set(['dialog', 'alertdialog', 'alert', 'status']);
const SKIP_TEXT_ROLES = new Set(['InlineTextBox', 'LineBreak']);

const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  'cc-name', 'cc-given-name', 'cc-family-name', 'cc-type',
]);
const SENSITIVE_NAME = /(passw|mot[\s_-]*de[\s_-]*passe|\bpwd\b|card[\s_-]*num|cardnumber|num[ée]ro[\s_-]*de[\s_-]*carte|\bcvc\b|\bcvv\b|\bcsc\b|security[\s_-]*code|cryptogramme|\biban\b|\bbic\b|\bswift\b|\botp\b|one[\s_-]*time[\s_-]*(code|password)|code[\s_-]*(de[\s_-]*)?v[ée]rification|\bpin\b)/i;

/**
 * Verbes d'une écriture (français et anglais, sans accents) : envoi, paiement, achat, suppression, publication.
 * Nom de l'élément visé, pas le texte de la page.
 */
const WRITE_VERBS = /\b(envo(i|ie|ier|yer|yez)|send|submit|soumettre|post(er)?|publi(er|ez|sh)|tweet|repondre|reply|commenter|comment|pay(er|ez)?|paiement|payment|checkout|commander|commande|order|place order|acheter|achat|buy|purchase|souscrire|subscribe|s'?abonner|reserver|book|confirm(er|ez)?|valider|validez|approuv(er|ez)|approve|signer|sign|supprim(er|ez)|delete|effacer|remove|retirer|archiver|archive|vider|empty|resilier|cancel subscription|desabonner|unsubscribe|transfer(er)?|virement|transfer|donate|faire un don|enregistrer|save|sauvegarder|mettre a jour|update|appliquer|apply|creer|create|inviter|invite|partager|share|merger?|merge|deployer|deploy|bloquer|block|signaler|report|rembourser|refund)\b/;
const SEARCH_NAME = /\b(search|recherch|chercher|rechercher|find|trouver|filtr|filter|go)\b/;

const KEY_DEFINITIONS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
for (let index = 1; index <= 12; index += 1) {
  KEY_DEFINITIONS[`f${index}`] = { key: `F${index}`, code: `F${index}`, keyCode: 111 + index };
}

const MODIFIER_BITS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

const collapse = (value, max) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return max && text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const fold = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** "Enter", "Control+a", "Mod+Shift+K" → événement CDP (`Input.dispatchKeyEvent`). `null` si invalide. */
function parseCdpKeyCombo(combo, platform = process.platform) {
  const parts = String(combo || '').split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const raw = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const lower = part.toLowerCase();
    const bit = lower === 'mod' ? (platform === 'darwin' ? 4 : 2) : MODIFIER_BITS[lower];
    if (!bit) return null;
    modifiers |= bit;
  }
  const named = KEY_DEFINITIONS[raw.toLowerCase()];
  let definition;
  if (named) {
    definition = { ...named };
  } else if (raw.length === 1) {
    const upper = raw.toUpperCase();
    const isLetter = /[a-z]/i.test(raw);
    const isDigit = /[0-9]/.test(raw);
    definition = {
      key: modifiers & 8 && isLetter ? upper : raw,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${raw}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: raw,
    };
  } else {
    return null;
  }
  // Avec Ctrl / Cmd / Alt, une lettre ne s'écrit pas ; ⌘A, ⌘C… passent par les commandes d'édition.
  const commandKey = platform === 'darwin' ? 4 : 2;
  const commands = [];
  if (modifiers === commandKey && raw.length === 1 && EDIT_COMMANDS[raw.toLowerCase()]) {
    commands.push(EDIT_COMMANDS[raw.toLowerCase()]);
  }
  const printable = Boolean(definition.text) && (modifiers & ~8) === 0;
  return { ...definition, modifiers, commands, printable };
}

/** Champ dont la valeur ne doit jamais être lue ni remplie par le modèle (mot de passe, carte, code). */
function isSensitiveField(attributes = {}) {
  const tag = String(attributes.__tag || '').toLowerCase();
  const type = String(attributes.type || '').toLowerCase();
  if (type === 'password') return true;
  if (tag && tag !== 'input' && tag !== 'textarea' && !attributes.contenteditable) return false;
  if (['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'hidden', 'file', 'range', 'color'].includes(type)) return false;
  const autocomplete = String(attributes.autocomplete || '').toLowerCase().split(/\s+/);
  if (autocomplete.some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) return true;
  const haystack = [attributes.name, attributes.id, attributes['aria-label'], attributes.placeholder, attributes['data-testid']]
    .filter(Boolean)
    .join(' ');
  return SENSITIVE_NAME.test(fold(haystack));
}

/**
 * Une action d'agent est-elle une écriture à faire valider ? `info` vient de la page (`describeNodeScript`).
 * Renvoie `{ reason, label }` ou `null` (lecture, navigation, saisie sans envoi).
 */
function classifyWrite(action, info = {}, extra = {}) {
  const name = collapse(info.name || '', 80);
  const folded = fold(name);
  const quoted = name ? `« ${name} »` : 'cet élément';
  if (action === 'upload') return { reason: 'upload', label: `Déposer un fichier dans ${quoted}` };
  if (action === 'dialog_accept') return { reason: 'dialog_accept', label: `Accepter « ${collapse(extra.message || '', 80)} »` };
  const inForm = Boolean(info.inForm);
  const searchForm = Boolean(info.searchForm);
  if (action === 'submit') {
    if (!inForm || searchForm) return null;
    return { reason: 'form_submit', label: `Envoyer le formulaire${name ? ` (${quoted})` : ''}` };
  }
  if (action !== 'click') return null;
  const tag = String(info.tag || '').toLowerCase();
  const type = String(info.type || '').toLowerCase();
  const submitLike =
    (tag === 'button' && (type === '' || type === 'submit') && inForm) ||
    (tag === 'input' && (type === 'submit' || type === 'image') && inForm);
  if (submitLike && !searchForm && !SEARCH_NAME.test(folded)) {
    return { reason: 'form_submit', label: `Cliquer sur ${quoted} (envoi de formulaire)` };
  }
  if (folded && WRITE_VERBS.test(folded) && !SEARCH_NAME.test(folded)) {
    return { reason: 'write_action', label: `Cliquer sur ${quoted}` };
  }
  return null;
}

/** Index des nœuds d'un `DOMSnapshot.captureSnapshot` : backendNodeId → { attributes, bounds, doc }. */
function indexDomSnapshot(snapshot) {
  const byBackend = new Map();
  if (!snapshot || !Array.isArray(snapshot.documents)) return { byBackend, docs: [] };
  const strings = snapshot.strings || [];
  const docs = [];
  snapshot.documents.forEach((doc, docIndex) => {
    docs.push({
      url: strings[doc.documentURL] || '',
      frameId: strings[doc.frameId] || '',
      scrollX: doc.scrollOffsetX || 0,
      scrollY: doc.scrollOffsetY || 0,
      contentWidth: doc.contentWidth || 0,
      contentHeight: doc.contentHeight || 0,
    });
    const nodes = doc.nodes || {};
    const backendIds = nodes.backendNodeId || [];
    const attrs = nodes.attributes || [];
    const names = nodes.nodeName || [];
    const boundsByNode = new Map();
    const layout = doc.layout || {};
    (layout.nodeIndex || []).forEach((nodeIndex, layoutIndex) => {
      if (!boundsByNode.has(nodeIndex)) boundsByNode.set(nodeIndex, (layout.bounds || [])[layoutIndex]);
    });
    for (let index = 0; index < backendIds.length; index += 1) {
      const pairs = attrs[index] || [];
      const attributes = { __tag: strings[names[index]] || '' };
      for (let pair = 0; pair + 1 < pairs.length; pair += 2) {
        attributes[String(strings[pairs[pair]] || '').toLowerCase()] = strings[pairs[pair + 1]] || '';
      }
      byBackend.set(backendIds[index], { attributes, bounds: boundsByNode.get(index) || null, doc: docIndex });
    }
  });
  return { byBackend, docs };
}

function axValue(node, key) {
  const field = node[key];
  return field && field.value != null ? field.value : '';
}

function axProperty(node, name) {
  const property = (node.properties || []).find((entry) => entry.name === name);
  return property && property.value ? property.value.value : undefined;
}

/** Registre des refs d'un onglet : la même ref pour le même élément tant que le document ne change pas. */
function createRefRegistry() {
  let docKey = null;
  let seq = 0;
  let byBackend = new Map();
  let byRef = new Map();
  return {
    reset(nextDocKey) {
      docKey = nextDocKey;
      seq = 0;
      byBackend = new Map();
      byRef = new Map();
    },
    sync(nextDocKey) {
      if (nextDocKey !== docKey) this.reset(nextDocKey);
    },
    docKey: () => docKey,
    refFor(backendNodeId, frameId) {
      let ref = byBackend.get(backendNodeId);
      if (!ref) {
        seq += 1;
        ref = `e${seq}`;
        byBackend.set(backendNodeId, ref);
      }
      byRef.set(ref, { backendNodeId, frameId });
      return ref;
    },
    lookup(ref) {
      return byRef.get(String(ref || '')) || null;
    },
  };
}

/**
 * Construit l'état de page à partir des arbres AX des cadres (`frames` : `[{ frameId, url, nodes, ownerBackendId }]`,
 * le premier est la page) et de l'index DOMSnapshot. Pur : testé sans Electron.
 */
function buildAxPage({ frames, dom, viewport, title, url, registry, maxElements, maxText, includeText = true }) {
  const elementLimit = Math.max(10, Math.min(Number(maxElements) || DEFAULT_MAX_ELEMENTS, 400));
  const textLimit = Math.max(0, Math.min(Number(maxText) || DEFAULT_MAX_TEXT, 60_000));
  const index = dom || { byBackend: new Map(), docs: [] };
  const frameByOwner = new Map();
  frames.slice(1).forEach((frame, position) => {
    if (frame.ownerBackendId) frameByOwner.set(frame.ownerBackendId, { ...frame, index: position + 1 });
  });
  const visited = new Set();
  const inView = [];
  const offView = [];
  const notices = [];
  const textParts = [];
  let totalInteractive = 0;
  const pushText = (value, block) => {
    if (!includeText) return;
    const text = collapse(value);
    if (!text) return;
    if (block && textParts.length && textParts[textParts.length - 1] !== '\n') textParts.push('\n');
    textParts.push(text);
  };

  const describe = (node, frame) => {
    const role = axValue(node, 'role');
    const backendNodeId = node.backendDOMNodeId;
    const domInfo = index.byBackend.get(backendNodeId);
    const attributes = (domInfo && domInfo.attributes) || {};
    const entry = { ref: registry.refFor(backendNodeId, frame.frameId), role, name: collapse(axValue(node, 'name'), 100) };
    const sensitive = EDITABLE_ROLES.has(role) && isSensitiveField(attributes);
    const value = axValue(node, 'value');
    if (sensitive) {
      entry.sensitive = true;
    } else if (value !== '' && value != null && role !== 'link') {
      entry.value = attributes['data-lasco-autofill'] != null ? '(filled by Lasco from a saved address)' : collapse(value, 120);
      if (attributes['data-lasco-autofill'] != null) entry.autofilled = true;
    }
    if (role === 'link' && attributes.href) {
      try {
        entry.href = collapse(new URL(attributes.href, frame.url || url).href, 160);
      } catch (_) {
        entry.href = collapse(attributes.href, 160);
      }
    }
    if (String(attributes.type || '').toLowerCase() === 'file') entry.file = true;
    const checked = axProperty(node, 'checked');
    if (checked === 'true' || checked === true) entry.checked = true;
    else if (checked === 'false' || checked === false) entry.checked = false;
    else if (checked === 'mixed') entry.checked = 'mixed';
    if (axProperty(node, 'disabled') === true) entry.disabled = true;
    const expanded = axProperty(node, 'expanded');
    if (typeof expanded === 'boolean') entry.expanded = expanded;
    if (axProperty(node, 'selected') === true) entry.selected = true;
    if (axProperty(node, 'required') === true) entry.required = true;
    if (axProperty(node, 'focused') === true) entry.focused = true;
    if (axProperty(node, 'invalid') && axProperty(node, 'invalid') !== 'false') entry.invalid = true;
    if (frame.index) entry.frame = frame.index;
    const bounds = domInfo && domInfo.bounds;
    const doc = domInfo ? index.docs[domInfo.doc] : null;
    if (bounds && doc && !frame.index && viewport) {
      const [x, y, width, height] = bounds;
      const top = y - doc.scrollY;
      const left = x - doc.scrollX;
      entry.inViewport = width > 0 && height > 0 && top + height > 0 && left + width > 0 && top < viewport.height && left < viewport.width;
    }
    return entry;
  };

  const optionsOf = (node, nodesById) => {
    const options = [];
    const stack = [...(node.childIds || [])];
    while (stack.length && options.length < MAX_OPTIONS) {
      const child = nodesById.get(stack.shift());
      if (!child) continue;
      const role = axValue(child, 'role');
      if (role === 'option' || role === 'MenuListOption') options.push(collapse(axValue(child, 'name'), 60));
      else stack.push(...(child.childIds || []));
    }
    return options;
  };

  const walkFrame = (frame) => {
    const nodesById = new Map((frame.nodes || []).map((node) => [node.nodeId, node]));
    const root = (frame.nodes || []).find((node) => !node.parentId) || (frame.nodes || [])[0];
    if (!root) return;
    const walk = (node, insideInteractive) => {
      if (!node || visited.has(`${frame.frameId}:${node.nodeId}`)) return;
      visited.add(`${frame.frameId}:${node.nodeId}`);
      const role = axValue(node, 'role');
      const childFrame = node.backendDOMNodeId ? frameByOwner.get(node.backendDOMNodeId) : null;
      if (childFrame) {
        walkFrame(childFrame);
        return;
      }
      if (!node.ignored) {
        if (INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId && !insideInteractive) {
          totalInteractive += 1;
          const entry = describe(node, frame);
          if (role === 'combobox' || role === 'listbox' || role === 'PopUpButton') {
            const options = optionsOf(node, nodesById);
            if (options.length) entry.options = options;
          }
          (entry.inViewport === false ? offView : inView).push(entry);
          pushText(`[${entry.ref}] ${entry.name}`, false);
          // Options natives d'un <select> : déjà dans `options`.
          if (role === 'combobox' || role === 'PopUpButton') return;
          // Une liste garde ses options comme éléments (chacune a sa ref) ; un bouton, un lien couvrent leur texte.
          if (role !== 'listbox') insideInteractive = true;
        } else if (role === 'StaticText' && !insideInteractive) {
          pushText(axValue(node, 'name'), false);
        } else if (role === 'heading') {
          const level = axProperty(node, 'level');
          pushText(`${'#'.repeat(Math.min(Number(level) || 2, 6))} ${collapse(axValue(node, 'name'), 200)}`, true);
          pushText('', true);
          return;
        } else if (role === 'image' && axValue(node, 'name') && !insideInteractive) {
          pushText(`[image: ${collapse(axValue(node, 'name'), 80)}]`, false);
        } else if (BLOCK_ROLES.has(role)) {
          pushText('', true);
          if (NOTICE_ROLES.has(role) && axValue(node, 'name')) notices.push({ role, name: collapse(axValue(node, 'name'), 160) });
        }
      }
      for (const childId of node.childIds || []) walk(nodesById.get(childId), insideInteractive);
      if (!node.ignored && BLOCK_ROLES.has(role)) pushText('', true);
    };
    walk(root, false);
  };
  walkFrame({ ...frames[0], index: 0 });

  const elements = [...inView, ...offView].slice(0, elementLimit);
  const text = textParts
    .join(' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const unreachable = frames.filter((frame) => frame.unreachable).map((frame) => collapse(frame.url, 120));
  return {
    engine: 'ax',
    url,
    title,
    viewport,
    elements,
    totalInteractive,
    ...(notices.length ? { notices: notices.slice(0, 5) } : {}),
    ...(frames.length > 1 ? { frames: frames.length - 1 } : {}),
    ...(unreachable.length ? { unreachableFrames: unreachable } : {}),
    ...(includeText && textLimit > 0 ? { text: text.slice(0, textLimit), textTruncated: text.length > textLimit } : {}),
  };
}

/** Script du monde isolé : décrit l'élément (`this`) pour le classement des écritures et la saisie. */
const DESCRIBE_NODE_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return { missing: true };
  const tag = el.tagName.toLowerCase();
  const form = el.form || (el.closest && el.closest('form'));
  const text = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const name = text(el.getAttribute('aria-label') || (tag === 'input' ? el.value || el.getAttribute('placeholder') : '') || el.innerText || el.getAttribute('title') || el.getAttribute('alt')).slice(0, 120);
  let searchForm = false;
  if (form) {
    const formText = [form.getAttribute('role'), form.getAttribute('action'), form.getAttribute('id'), form.getAttribute('name'), form.getAttribute('class'), form.getAttribute('aria-label')].join(' ').toLowerCase();
    searchForm = /search|recherche|query/.test(formText) || Boolean(form.querySelector('input[type="search"]')) || Boolean(el.closest('[role="search"]'));
    if (!searchForm && !form.querySelector('input[type="password"], textarea, input[type="file"]')) {
      const fields = Array.from(form.elements || []).filter((field) => /^(input|select|textarea)$/i.test(field.tagName) && !/^(hidden|submit|button|image|reset)$/i.test(field.type || ''));
      searchForm = fields.length === 1 && /(^|[^a-z])(q|query|search|s|recherche|keywords?)([^a-z]|$)/i.test([fields[0].name, fields[0].id, fields[0].getAttribute('placeholder')].join(' '));
    }
  }
  const editable = el.isContentEditable || (tag === 'textarea') || (tag === 'input' && !/^(checkbox|radio|submit|button|reset|image|file|range|color|hidden)$/i.test(el.type || ''));
  return {
    tag,
    type: (el.getAttribute('type') || '').toLowerCase(),
    name,
    inForm: Boolean(form),
    searchForm,
    editable,
    contentEditable: Boolean(el.isContentEditable),
    disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
    readOnly: Boolean(el.readOnly),
    attributes: {
      __tag: tag,
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      placeholder: el.getAttribute('placeholder') || '',
      'aria-label': el.getAttribute('aria-label') || '',
      contenteditable: el.isContentEditable ? 'true' : '',
    },
  };
}`;

/** Cible composée : `hit` est l'élément ou un de ses descendants (shadow DOM compris). */
const CONTAINS_FN = `function (hit) {
  if (!hit) return false;
  let node = hit;
  while (node) {
    if (node === this) return true;
    node = node.parentNode || node.host || null;
  }
  return false;
}`;

const DESCRIBE_COVER_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return '';
  const box = el.closest('[role="dialog"], dialog, [aria-modal="true"], [id*="cookie" i], [class*="cookie" i], [class*="consent" i], [class*="modal" i], [class*="overlay" i]') || el;
  const label = box.getAttribute('aria-label') || (box.innerText || '').replace(/\\s+/g, ' ').trim();
  return (box.tagName.toLowerCase() + (label ? ' « ' + label.slice(0, 80) + ' »' : '')).slice(0, 120);
}`;

const SELECT_FN = `function (wanted) {
  const el = this;
  if (!el || el.tagName.toLowerCase() !== 'select') return { ok: false, error: 'not-a-select' };
  const norm = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim().toLowerCase();
  const target = norm(wanted);
  const options = Array.from(el.options);
  const option = options.find((opt) => norm(opt.value) === target || norm(opt.text) === target) || options.find((opt) => norm(opt.text).includes(target));
  if (!option) return { ok: false, error: 'option-not-found', options: options.slice(0, 25).map((opt) => norm(opt.text)) };
  el.removeAttribute('data-lasco-autofill');
  el.focus();
  el.value = option.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, selected: option.text.replace(/\\s+/g, ' ').trim().slice(0, 80) };
}`;

const FOCUS_SELECT_FN = `function (clear) {
  const el = this;
  el.removeAttribute && el.removeAttribute('data-lasco-autofill');
  el.focus();
  if (!clear) return document.activeElement === el || el.contains(document.activeElement);
  if (typeof el.select === 'function') {
    el.select();
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}`;

const FILE_INPUT_FN = `function () {
  const el = this;
  if (el.tagName && el.tagName.toLowerCase() === 'input' && (el.type || '').toLowerCase() === 'file') return el;
  if (el.tagName && el.tagName.toLowerCase() === 'label' && el.control && el.control.type === 'file') return el.control;
  const inside = el.querySelector && el.querySelector('input[type="file"]');
  if (inside) return inside;
  const scope = el.closest && el.closest('form, [role="dialog"], section, div');
  return (scope && scope.querySelector('input[type="file"]')) || null;
}`;

const MUTATION_WATCH_SCRIPT = `(() => {
  const state = window.__lascoAgentMutations || (window.__lascoAgentMutations = { last: Date.now(), observer: null });
  if (!state.observer && document.documentElement) {
    state.observer = new MutationObserver(() => { state.last = Date.now(); });
    state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  return Date.now() - state.last;
})()`;

class AgentActionError extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details || {};
  }
}

const ERROR_HINTS = {
  'stale-ref': "Cette ref n'existe plus (la page a changé) : relis la page avec browser_get_page et réessaie avec la nouvelle ref.",
  'element-covered': "L'élément est recouvert (bannière, fenêtre, menu) : ferme d'abord ce qui le couvre, puis réessaie.",
  'not-visible': "L'élément n'a pas de surface visible : fais défiler, ouvre son menu ou sa section, puis relis la page.",
  disabled: "L'élément est désactivé : remplis d'abord les champs requis ou attends qu'il s'active.",
  'not-editable': "Cet élément n'accepte pas de saisie : choisis un champ de texte (textbox, searchbox).",
  'sensitive-field': "Champ sensible (mot de passe, carte, code) : tu ne peux ni le lire ni le remplir. Mot de passe : browser_login. Carte bancaire ou code : l'utilisateur le saisit lui-même.",
  'option-not-found': "Aucune option ne correspond : choisis une des options listées.",
  'not-a-select': "Ce n'est pas une liste <select> native : clique sur le déclencheur puis sur l'option.",
  'no-file-input': "Pas de champ de dépôt de fichier ici : vise le champ « fichier » ou son bouton.",
  'frame-unreachable': "Élément dans un cadre d'un autre site, inaccessible : utilise une capture d'écran et un clic par coordonnées.",
  'approval-required': "Action à faire valider.",
  'no-dialog': "Aucune boîte de dialogue en attente.",
  timeout: "La page ne répond pas assez vite : attends (browser_wait) puis relis-la.",
};

/**
 * Moteur CDP d'un onglet. `wc` : webContents ; `isAgentBusy()` : une action d'agent est en cours sur l'onglet
 * (les boîtes de dialogue de ce moment sont gérées ici, les autres restent à la personne).
 */
function createAgentCdp(wc, { now = () => Date.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const dbg = wc.debugger;
  const registry = createRefRegistry();
  const worlds = new Map();
  const inflight = new Map();
  let lastNetworkEvent = 0;
  let listening = false;
  let busy = 0;
  let approvedDepth = 0;
  let lastDialog = null;
  let dialogPlan = null;

  const send = async (method, params, sessionId) => {
    if (wc.isDestroyed()) throw new AgentActionError('tab-closed');
    if (!dbg.isAttached()) dbg.attach('1.3');
    return sessionId ? dbg.sendCommand(method, params || {}, sessionId) : dbg.sendCommand(method, params || {});
  };

  const onMessage = (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      if (params.type === 'EventSource' || params.type === 'WebSocket' || params.type === 'Ping') return;
      inflight.set(params.requestId, now());
      lastNetworkEvent = now();
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      if (inflight.delete(params.requestId)) lastNetworkEvent = now();
    } else if (method === 'Page.javascriptDialogOpening') {
      if (busy <= 0) return;
      void handleDialog(params);
    } else if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      worlds.clear();
    } else if (method === 'Runtime.executionContextsCleared') {
      worlds.clear();
    }
  };

  function ensureListening() {
    if (listening) return;
    listening = true;
    dbg.on('message', onMessage);
    wc.once('destroyed', () => {
      try {
        dbg.removeListener('message', onMessage);
      } catch (_) {
        // déjà détruit
      }
    });
  }

  async function handleDialog(params) {
    const type = params.type;
    const approvedAction = approvedDepth > 0;
    const message = collapse(params.message, 300);
    const plan = dialogPlan && dialogPlan.expires > now() ? dialogPlan : null;
    dialogPlan = null;
    let accept;
    let promptText;
    if (plan) {
      accept = plan.accept;
      promptText = plan.text;
    } else {
      // Sans consigne : une alerte se ferme, une sortie de page est acceptée (onglet de l'agent). Une confirmation
      // ouverte par une action validée (« Supprimer » validé par la personne) est acceptée ; sinon elle est refusée
      // et rapportée à l'agent, qui la fera valider (browser_handle_dialog).
      accept = type === 'alert' || type === 'beforeunload' || (type === 'confirm' && approvedAction);
    }
    lastDialog = { type, message, handled: accept ? 'accepted' : 'dismissed', ...(type === 'prompt' ? { defaultPrompt: collapse(params.defaultPrompt, 120) } : {}) };
    try {
      await send('Page.handleJavaScriptDialog', { accept, ...(accept && promptText != null ? { promptText: String(promptText) } : {}) });
    } catch (_) {
      // Fermée entre-temps.
    }
  }

  async function mainFrame() {
    const { frameTree } = await send('Page.getFrameTree');
    return frameTree;
  }

  async function syncRegistry() {
    const tree = await mainFrame();
    registry.sync(`${tree.frame.id}:${tree.frame.loaderId}`);
    return tree;
  }

  async function isolatedContext(frameId) {
    const cached = worlds.get(frameId);
    if (cached) return cached;
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: AGENT_WORLD_NAME, grantUniveralAccess: false });
    worlds.set(frameId, executionContextId);
    return executionContextId;
  }

  async function resolveObject(target) {
    try {
      const contextId = await isolatedContext(target.frameId);
      const { object } = await send('DOM.resolveNode', { backendNodeId: target.backendNodeId, executionContextId: contextId, objectGroup: OBJECT_GROUP });
      return object.objectId;
    } catch (error) {
      worlds.delete(target.frameId);
      try {
        const contextId = await isolatedContext(target.frameId);
        const { object } = await send('DOM.resolveNode', { backendNodeId: target.backendNodeId, executionContextId: contextId, objectGroup: OBJECT_GROUP });
        return object.objectId;
      } catch (_) {
        throw new AgentActionError('stale-ref');
      }
    }
  }

  async function callOn(objectId, functionDeclaration, args = [], returnByValue = true) {
    const result = await send('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args, returnByValue, awaitPromise: true });
    if (result.exceptionDetails) throw new AgentActionError('page-script-error');
    return returnByValue ? result.result.value : result.result;
  }

  async function target(ref) {
    if (!ref) throw new AgentActionError('missing-target');
    await syncRegistry();
    const found = registry.lookup(ref);
    if (!found) throw new AgentActionError('stale-ref');
    return found;
  }

  async function describeTarget(found) {
    const objectId = await resolveObject(found);
    const info = await callOn(objectId, DESCRIBE_NODE_FN);
    if (!info || info.missing) throw new AgentActionError('stale-ref');
    return { objectId, info };
  }

  async function viewportSize() {
    const metrics = await send('Page.getLayoutMetrics');
    const visual = metrics.cssVisualViewport || metrics.visualViewport || {};
    const layout = metrics.cssLayoutViewport || metrics.layoutViewport || {};
    return {
      width: Math.round(visual.clientWidth || layout.clientWidth || 0),
      height: Math.round(visual.clientHeight || layout.clientHeight || 0),
      scrollX: Math.round(visual.pageX || layout.pageX || 0),
      scrollY: Math.round(visual.pageY || layout.pageY || 0),
      scrollHeight: Math.round((metrics.cssContentSize || metrics.contentSize || {}).height || 0),
    };
  }

  /** Centre visible de l'élément (CSS px de la page), après l'avoir amené à l'écran. */
  async function pointOf(found, objectId) {
    try {
      await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: found.backendNodeId });
    } catch (_) {
      // Élément sans boîte : traité plus bas.
    }
    let quads;
    try {
      ({ quads } = await send('DOM.getContentQuads', { backendNodeId: found.backendNodeId }));
    } catch (_) {
      throw new AgentActionError('not-visible');
    }
    const viewport = await viewportSize();
    const candidates = (quads || [])
      .map((quad) => {
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        const left = Math.max(0, Math.min(...xs));
        const right = Math.min(viewport.width || Infinity, Math.max(...xs));
        const top = Math.max(0, Math.min(...ys));
        const bottom = Math.min(viewport.height || Infinity, Math.max(...ys));
        return { x: (left + right) / 2, y: (top + bottom) / 2, area: Math.max(0, right - left) * Math.max(0, bottom - top) };
      })
      .filter((candidate) => candidate.area >= 1)
      .sort((a, b) => b.area - a.area);
    if (!candidates.length) throw new AgentActionError('not-visible');
    const point = { x: candidates[0].x, y: candidates[0].y };
    // Recouvrement : l'élément sous le point doit être la cible ou dedans (shadow DOM compris).
    try {
      const hit = await send('DOM.getNodeForLocation', {
        x: Math.round(point.x),
        y: Math.round(point.y),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: true,
      });
      if (hit && hit.backendNodeId && hit.backendNodeId !== found.backendNodeId) {
        const hitObject = await resolveObject({ backendNodeId: hit.backendNodeId, frameId: hit.frameId || found.frameId }).catch(() => null);
        if (hitObject) {
          const inside = await callOn(objectId, CONTAINS_FN, [{ objectId: hitObject }]).catch(() => true);
          const around = inside ? true : await callOn(hitObject, CONTAINS_FN, [{ objectId }]).catch(() => false);
          if (!inside && !around) {
            const cover = await callOn(hitObject, DESCRIBE_COVER_FN).catch(() => '');
            throw new AgentActionError('element-covered', cover ? { covered_by: cover } : {});
          }
        }
      }
    } catch (error) {
      if (error instanceof AgentActionError) throw error;
    }
    return point;
  }

  async function mouseClick(point, clickCount = 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    for (let count = 1; count <= clickCount; count += 1) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: count });
      // Une confirmation ouverte par le clic bloque la page jusqu'à sa réponse (handleDialog).
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: count });
    }
  }

  async function pressKey(definition) {
    const base = {
      modifiers: definition.modifiers || 0,
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
    };
    const commands = definition.commands && definition.commands.length ? { commands: definition.commands } : {};
    if (definition.printable) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: definition.text, unmodifiedText: definition.text, ...commands });
    } else {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...commands });
    }
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async function focusedTarget() {
    // Élément qui a le focus : pour classer « Entrée » (envoi de formulaire ?) quand l'agent ne vise rien.
    try {
      const tree = await syncRegistry();
      const contextId = await isolatedContext(tree.frame.id);
      const { result } = await send('Runtime.evaluate', {
        expression: `(() => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el; })()`,
        contextId,
        objectGroup: OBJECT_GROUP,
      });
      if (!result || !result.objectId) return null;
      return await callOn(result.objectId, DESCRIBE_NODE_FN);
    } catch (_) {
      return null;
    }
  }

  async function startWatching() {
    ensureListening();
    inflight.clear();
    lastNetworkEvent = now();
    try {
      await send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    } catch (_) {
      // Sans réseau suivi : seulement le chargement et le DOM.
    }
    try {
      const tree = await mainFrame();
      const contextId = await isolatedContext(tree.frame.id);
      await send('Runtime.evaluate', { expression: MUTATION_WATCH_SCRIPT, contextId, returnByValue: true });
    } catch (_) {
      // Page en cours de chargement.
    }
  }

  async function stopWatching() {
    try {
      await send('Network.disable');
    } catch (_) {
      // onglet fermé
    }
    try {
      await send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP });
    } catch (_) {
      // onglet fermé
    }
  }

  /** Attend que la page soit calme : chargement fini, réseau calme, DOM calme ; 6 s au plus. */
  async function waitForStable(maxMs = STABLE_MAX_MS) {
    const startedAt = now();
    await delay(120);
    while (now() - startedAt < maxMs) {
      if (wc.isDestroyed()) return { stable: false };
      const loading = wc.isLoading();
      const current = now();
      const active = [...inflight.values()].filter((since) => current - since < LONG_REQUEST_MS).length;
      const networkQuiet = active === 0 && current - lastNetworkEvent >= NETWORK_QUIET_MS;
      let domQuietFor = DOM_QUIET_MS;
      if (!loading && networkQuiet) {
        try {
          const tree = await mainFrame();
          const contextId = await isolatedContext(tree.frame.id);
          const { result } = await send('Runtime.evaluate', { expression: MUTATION_WATCH_SCRIPT, contextId, returnByValue: true });
          domQuietFor = Number(result && result.value) || 0;
        } catch (_) {
          worlds.clear();
          domQuietFor = 0;
        }
        if (domQuietFor >= DOM_QUIET_MS) return { stable: true, waitedMs: now() - startedAt };
      }
      await delay(100);
    }
    return { stable: false, waitedMs: now() - startedAt };
  }

  async function collectFrames(tree) {
    const flat = [];
    const visit = (node) => {
      if (flat.length >= MAX_FRAMES) return;
      flat.push(node.frame);
      for (const child of node.childFrames || []) visit(child);
    };
    visit(tree);
    const frames = [];
    for (const [position, frame] of flat.entries()) {
      try {
        const { nodes } = await send('Accessibility.getFullAXTree', position === 0 ? {} : { frameId: frame.id });
        let ownerBackendId = null;
        if (position > 0) {
          const owner = await send('DOM.getFrameOwner', { frameId: frame.id }).catch(() => null);
          ownerBackendId = owner ? owner.backendNodeId : null;
        }
        frames.push({ frameId: frame.id, url: frame.url, nodes, ownerBackendId });
      } catch (_) {
        if (position === 0) throw new AgentActionError('snapshot-failed');
        // Cadre d'un autre processus (autre site) : signalé, pas lu.
        frames.push({ frameId: frame.id, url: frame.url, nodes: [], unreachable: true });
      }
    }
    return frames;
  }

  async function snapshot(opts = {}) {
    ensureListening();
    const tree = await syncRegistry();
    const frames = await collectFrames(tree);
    let dom = null;
    try {
      dom = indexDomSnapshot(await send('DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: false }));
    } catch (_) {
      dom = null;
    }
    const viewport = await viewportSize().catch(() => null);
    const page = buildAxPage({
      frames,
      dom,
      viewport,
      title: wc.getTitle(),
      url: wc.getURL(),
      registry,
      maxElements: opts.maxElements,
      maxText: opts.maxText,
      includeText: opts.includeText !== false,
    });
    if (lastDialog) {
      page.dialog = lastDialog;
      lastDialog = null;
    }
    return page;
  }

  function requireApproval(guard, classification) {
    if (!classification) return;
    if (!guard || !guard.writeGate || guard.approved === true) return;
    throw new AgentActionError('approval-required', { approval: classification });
  }

  /** Une action, puis l'état de page stable. `approved` : action validée par une personne (garde). */
  async function act(fn, { settle = true, approved = false } = {}) {
    busy += 1;
    if (approved) approvedDepth += 1;
    let extra = {};
    let before = null;
    try {
      before = (await mainFrame().catch(() => null)) || null;
      await startWatching();
      extra = (await fn()) || {};
      const stability = settle ? await waitForStable() : { stable: true };
      const after = await mainFrame().catch(() => null);
      const navigated = Boolean(before && after && before.frame.loaderId !== after.frame.loaderId);
      // Petite marge : une confirmation ouverte juste après l'action est encore gérée ici.
      await delay(50);
      const page = await snapshot({ maxElements: 120, maxText: 4000 }).catch(async () => {
        await delay(400);
        return snapshot({ maxElements: 120, maxText: 4000 });
      });
      return { ok: true, ...extra, ...(navigated ? { navigated: true } : {}), ...(stability.stable ? {} : { warning: 'page-still-busy' }), page };
    } finally {
      busy -= 1;
      if (approved) approvedDepth -= 1;
      await stopWatching();
    }
  }

  const isApproved = (guard) => Boolean(guard && guard.approved === true);

  return {
    snapshot,
    errorHint: (code) => ERROR_HINTS[code] || null,

    async click(ref, { doubleClick = false, guard } = {}) {
      const found = await target(ref);
      const { objectId, info } = await describeTarget(found);
      if (info.disabled) throw new AgentActionError('disabled');
      requireApproval(guard, classifyWrite('click', info));
      return act(async () => {
        const point = await pointOf(found, objectId);
        await mouseClick(point, doubleClick ? 2 : 1);
      }, { approved: isApproved(guard) });
    },

    async clickPoint(point, { guard } = {}) {
      // Clic par coordonnées (capture d'écran) : l'élément visé est lu sous le point, pour la garde.
      if (guard && guard.writeGate && guard.approved !== true) {
        const hit = await send('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), ignorePointerEventsNone: true }).catch(() => null);
        if (hit && hit.backendNodeId) {
          const objectId = await resolveObject({ backendNodeId: hit.backendNodeId, frameId: hit.frameId || (await mainFrame()).frame.id }).catch(() => null);
          const info = objectId ? await callOn(objectId, `function(){ const el = (this.nodeType === 1 ? this : this.parentElement); return el && el.closest('button, a, input, [role="button"], [role="link"]'); }`, [], false).then((ref) => (ref && ref.objectId ? callOn(ref.objectId, DESCRIBE_NODE_FN) : null)).catch(() => null) : null;
          if (info) requireApproval(guard, classifyWrite('click', info));
        }
      }
      return act(async () => mouseClick(point, 1), { approved: isApproved(guard) });
    },

    async hover(ref) {
      const found = await target(ref);
      const { objectId } = await describeTarget(found);
      return act(async () => {
        const point = await pointOf(found, objectId);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
      });
    },

    async type(ref, text, { clear = true, submit = false, guard } = {}) {
      let info = null;
      let found = null;
      let objectId = null;
      if (ref) {
        found = await target(ref);
        ({ objectId, info } = await describeTarget(found));
      } else {
        info = await focusedTarget();
      }
      if (info && isSensitiveField(info.attributes)) throw new AgentActionError('sensitive-field');
      if (ref && info && !info.editable) throw new AgentActionError('not-editable');
      if (info && info.disabled) throw new AgentActionError('disabled');
      if (submit) requireApproval(guard, classifyWrite('submit', info || {}));
      return act(async () => {
        if (found) {
          const point = await pointOf(found, objectId);
          await mouseClick(point, 1);
          await callOn(objectId, FOCUS_SELECT_FN, [{ value: Boolean(clear) }]);
        } else if (clear) {
          await pressKey(parseCdpKeyCombo('Mod+a'));
        }
        if (text) await send('Input.insertText', { text: String(text) });
        else if (clear) await pressKey(parseCdpKeyCombo('Backspace'));
        if (submit) await pressKey(parseCdpKeyCombo('Enter'));
      }, { approved: isApproved(guard) });
    },

    async press(combo, { ref, guard } = {}) {
      const definition = parseCdpKeyCombo(combo);
      if (!definition) throw new AgentActionError('invalid-key');
      let found = null;
      let objectId = null;
      let info = null;
      if (ref) {
        found = await target(ref);
        ({ objectId, info } = await describeTarget(found));
      } else {
        info = await focusedTarget();
      }
      if (definition.key === 'Enter') {
        // Entrée sur un bouton = clic sur ce bouton ; dans un champ = envoi du formulaire.
        const isButton = info && (info.tag === 'button' || ['submit', 'button', 'image'].includes(info.type));
        requireApproval(guard, classifyWrite(isButton ? 'click' : 'submit', info || {}));
      }
      return act(async () => {
        if (found) await callOn(objectId, 'function(){ this.focus(); return true; }');
        await pressKey(definition);
      }, { approved: isApproved(guard) });
    },

    async select(ref, value) {
      const found = await target(ref);
      const { objectId, info } = await describeTarget(found);
      if (info.disabled) throw new AgentActionError('disabled');
      return act(async () => {
        const result = await callOn(objectId, SELECT_FN, [{ value: String(value == null ? '' : value) }]);
        if (!result || !result.ok) throw new AgentActionError((result && result.error) || 'option-not-found', result && result.options ? { options: result.options } : {});
        return { selected: result.selected };
      });
    },

    async scroll({ ref, direction, amount } = {}) {
      if (ref) {
        const found = await target(ref);
        return act(async () => {
          try {
            await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: found.backendNodeId });
          } catch (_) {
            throw new AgentActionError('not-visible');
          }
        });
      }
      const viewport = await viewportSize();
      const distance = Number(amount) || Math.round((viewport.height || 600) * 0.8);
      const deltaY = direction === 'up' ? -distance : direction === 'down' || !direction ? distance : 0;
      const deltaX = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
      // Vraie molette au centre : fait défiler le conteneur sous le pointeur, comme une personne.
      return act(async () => {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round((viewport.width || 800) / 2),
          y: Math.round((viewport.height || 600) / 2),
          deltaX,
          deltaY,
        });
      });
    },

    async upload(ref, filePath, { guard } = {}) {
      const found = await target(ref);
      const { objectId, info } = await describeTarget(found);
      requireApproval(guard, classifyWrite('upload', info));
      const input = await callOn(objectId, FILE_INPUT_FN, [], false);
      if (!input || !input.objectId) throw new AgentActionError('no-file-input');
      return act(async () => {
        await send('DOM.setFileInputFiles', { files: [filePath], objectId: input.objectId });
      });
    },

    /** Prépare la réponse à la prochaine boîte de dialogue ; l'agent rejoue ensuite l'action qui l'ouvre. */
    planDialog({ accept, text, message, guard } = {}) {
      if (accept === true) requireApproval(guard, classifyWrite('dialog_accept', {}, { message }));
      dialogPlan = { accept: accept === true, text: typeof text === 'string' ? text : undefined, expires: now() + DIALOG_PLAN_TTL_MS };
      return { ok: true, planned: dialogPlan.accept ? 'accept' : 'dismiss' };
    },

    async wait(ms) {
      busy += 1;
      try {
        await startWatching();
        await delay(Math.min(Math.max(Number(ms) || 1000, 0), 10_000));
        await waitForStable(3_000);
      } finally {
        busy -= 1;
        await stopWatching();
      }
      return { ok: true, page: await snapshot({ maxElements: 120, maxText: 4000 }) };
    },
  };
}

module.exports = {
  createAgentCdp,
  buildAxPage,
  indexDomSnapshot,
  createRefRegistry,
  classifyWrite,
  isSensitiveField,
  parseCdpKeyCombo,
  AgentActionError,
  ERROR_HINTS,
  MAX_UPLOAD_BYTES,
};
