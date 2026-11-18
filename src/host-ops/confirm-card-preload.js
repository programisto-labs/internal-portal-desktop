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

function reportSize() {
  const card = document.getElementById('card');
  if (!card) return;
  ipcRenderer.send('confirm-card-size', Math.ceil(card.getBoundingClientRect().height) + 2);
}

ipcRenderer.on('confirm-card-render', (_event, spec) => {
  if (!spec || typeof spec !== 'object') return;
  document.documentElement.dataset.theme = spec.dark ? 'dark' : 'light';
  document.getElementById('title').textContent = String(spec.title || '');
  renderBody(document.getElementById('body'), spec.message);
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
    // « Refuser » first, then « Toujours autoriser », then the primary « une fois » on the right.
    button.style.order = decisions[index] === 'deny' ? '0' : decisions[index] === 'always' ? '1' : '2';
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
