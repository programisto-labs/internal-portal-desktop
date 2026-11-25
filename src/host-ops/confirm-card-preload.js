'use strict';

/**
 * Native confirmation card (drawn by Desktop over the chat placeholder). Text only, through
 * textContent: nothing from the request is ever parsed as HTML. Buttons stay disabled until main arms
 * them (card still and visible for a moment).
 */
const { ipcRenderer } = require('electron');

let decisions = [];

function isCodeLine(line, previous) {
  return /^[+-] /.test(line) || previous === 'Commande :';
}

function renderBody(container, message) {
  container.replaceChildren();
  const lines = String(message || '').split('\n');
  let previous = '';
  for (const line of lines) {
    if (isCodeLine(line, previous)) {
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = line;
      container.append(code);
    } else {
      container.append(document.createTextNode(`${line}\n`));
    }
    previous = line.trim();
  }
}

const OPERATORS = new Set(['&&', '||', '|', ';', '&', '|&', '>', '>>', '<', '2>', '2>&1', '&>']);
const COMMAND_START = new Set(['&&', '||', '|', ';', '&', '|&']);

/**
 * Découpe une ligne de commande en mots pour la colorer (affichage seulement : rien n'est exécuté ni
 * interprété ici). Garde les guillemets dans le mot, sépare les opérateurs.
 */
function tokenizeCommandLine(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j += 1;
      tokens.push({ kind: 'space', text: line.slice(i, j) });
      i = j;
      continue;
    }
    const op = ['2>&1', '&&', '||', '|&', '>>', '&>', '2>', '|', ';', '&', '>', '<'].find((o) => line.startsWith(o, i));
    if (op) {
      tokens.push({ kind: 'op', text: op });
      i += op.length;
      continue;
    }
    let j = i;
    let quote = null;
    while (j < line.length) {
      const c = line[j];
      if (quote) {
        if (c === '\\' && quote === '"') j += 1;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '\\') j += 1;
      else if (c === ' ' || c === '\t' || '|;&<>'.includes(c)) break;
      j += 1;
    }
    tokens.push({ kind: 'word', text: line.slice(i, Math.min(j, line.length)) });
    i = Math.max(j, i + 1);
  }
  let expectProgram = true;
  for (const token of tokens) {
    if (token.kind === 'op') expectProgram = COMMAND_START.has(token.text);
    else if (token.kind === 'word') {
      if (expectProgram && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) {
        token.kind = 'program';
        expectProgram = false;
      } else if (token.kind === 'word' && token.text.startsWith('-')) token.kind = 'flag';
    }
  }
  return tokens;
}

function renderCommand(command) {
  const block = document.createElement('div');
  block.className = 'term';
  const pre = document.createElement('pre');
  pre.tabIndex = 0;
  const lines = String(command || '').split('\n');
  lines.forEach((line, index) => {
    const prompt = document.createElement('span');
    prompt.className = 'prompt';
    prompt.textContent = index === 0 ? '$ ' : '  ';
    pre.append(prompt);
    for (const token of tokenizeCommandLine(line)) {
      const span = document.createElement('span');
      span.className = `t-${OPERATORS.has(token.text) && token.kind === 'op' ? 'op' : token.kind}`;
      span.textContent = token.text;
      pre.append(span);
    }
    if (index < lines.length - 1) pre.append(document.createTextNode('\n'));
  });
  block.append(pre);
  return block;
}

/** Carte d'une commande : informations, bloc terminal, notes. */
function renderCommandCard(container, card) {
  container.replaceChildren();
  container.classList.add('structured');
  const meta = document.createElement('dl');
  meta.className = 'meta';
  for (const item of Array.isArray(card.meta) ? card.meta.slice(0, 6) : []) {
    const dt = document.createElement('dt');
    dt.textContent = String(item.label || '');
    const dd = document.createElement('dd');
    dd.textContent = String(item.value || '');
    dd.title = String(item.value || '');
    meta.append(dt, dd);
  }
  container.append(meta, renderCommand(card.command));
  for (const note of Array.isArray(card.notes) ? card.notes.slice(0, 4) : []) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = String(note);
    container.append(p);
  }
}

function reportSize() {
  const card = document.getElementById('card');
  if (!card) return;
  ipcRenderer.send('confirm-card-size', Math.ceil(card.getBoundingClientRect().height) + 2);
}

ipcRenderer.on('confirm-card-render', (_event, spec) => {
  if (!spec || typeof spec !== 'object') return;
  document.documentElement.dataset.theme = spec.dark ? 'dark' : 'light';
  document.getElementById('title').textContent = String(spec.title || '');
  const body = document.getElementById('body');
  body.classList.remove('structured');
  if (spec.card && typeof spec.card === 'object' && typeof spec.card.command === 'string') renderCommandCard(body, spec.card);
  else renderBody(body, spec.message);
  decisions = Array.isArray(spec.decisions) ? spec.decisions.slice(0, 4) : [];
  const actions = document.getElementById('actions');
  actions.replaceChildren();
  const buttons = Array.isArray(spec.buttons) ? spec.buttons.slice(0, 4) : [];
  buttons.forEach((label, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(label);
    button.disabled = true;
    if (decisions[index] === 'once') button.className = 'primary';
    // « Refuser » first, then « Toujours autoriser » / « Tout autoriser pour ce lancement », then the primary
    // « une fois » on the right.
    button.style.order = decisions[index] === 'deny' ? '0' : decisions[index] === 'always' || decisions[index] === 'run' ? '1' : '2';
    button.addEventListener('click', () => {
      if (button.disabled) return;
      ipcRenderer.send('confirm-card-decide', index);
    });
    actions.append(button);
  });
  requestAnimationFrame(reportSize);
});

ipcRenderer.on('confirm-card-arm', (_event, armed) => {
  for (const button of document.querySelectorAll('#actions button')) button.disabled = armed !== true;
});

ipcRenderer.on('confirm-card-theme', (_event, dark) => {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
});

window.addEventListener('DOMContentLoaded', () => {
  const card = document.getElementById('card');
  if (card && typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(card);
});
