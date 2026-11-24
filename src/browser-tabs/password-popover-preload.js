'use strict';

/**
 * Autofill popover page (password-popover.html). Text only, through textContent: nothing received is
 * parsed as HTML. The main process decides what a choice does (and ignores it until armed).
 */
const { ipcRenderer } = require('electron');

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  key: ['M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z', 'M16.5 7.5h.01'],
  search: ['M21 21l-4.34-4.34', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z'],
  settings: ['M20 7h-9', 'M14 17H5', 'M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
};

/** Rows that can be highlighted, in order: credentials, then the two actions. */
let rows = [];
let active = -1;

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  const wrap = document.createElement('span');
  wrap.className = 'icon';
  wrap.append(svg);
  return wrap;
}

function setActive(index) {
  active = index;
  rows.forEach((row, i) => {
    row.el.classList.toggle('active', i === index);
    row.el.setAttribute('aria-selected', i === index ? 'true' : 'false');
  });
  if (rows[index]) rows[index].el.scrollIntoView({ block: 'nearest' });
}

function choose(row) {
  if (row) ipcRenderer.send('lasco-pw-popover', { type: 'choose', ...row.choice });
}

function makeRow({ iconName, label, sub, action, choice }) {
  const el = document.createElement('button');
  el.type = 'button';
  el.tabIndex = -1;
  el.className = action ? 'row action' : 'row';
  el.setAttribute('role', 'option');
  el.append(icon(iconName));
  const text = document.createElement('span');
  text.className = 'text';
  const main = document.createElement('span');
  main.className = 'label';
  main.textContent = label;
  text.append(main);
  if (sub) {
    const second = document.createElement('span');
    second.className = 'sub';
    second.textContent = sub;
    text.append(second);
  }
  el.append(text);
  const row = { el, choice };
  // mousedown, not click: the choice is made before any focus change can close the popover.
  el.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    choose(row);
  });
  el.addEventListener('mouseenter', () => setActive(rows.indexOf(row)));
  return row;
}

function render(spec) {
  document.documentElement.dataset.theme = spec.dark ? 'dark' : 'light';
  const head = document.getElementById('head');
  head.replaceChildren();
  const title = document.createElement('b');
  title.textContent = String(spec.title || '');
  head.append(title, document.createTextNode(` · ${String(spec.host || '')}`));

  rows = [];
  active = -1;
  const list = document.getElementById('list');
  list.replaceChildren();
  const items = Array.isArray(spec.items) ? spec.items.slice(0, 8) : [];
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = String(spec.empty || '');
    list.append(empty);
  }
  items.forEach((item, index) => {
    const row = makeRow({
      iconName: 'key',
      label: String(item.label || ''),
      sub: String(item.sub || ''),
      choice: { action: 'item', index },
    });
    rows.push(row);
    list.append(row.el);
  });

  const actions = document.getElementById('actions');
  actions.replaceChildren();
  for (const [iconName, label, action] of [
    ['search', spec.other, 'pick'],
    ['settings', spec.manage, 'manage'],
  ]) {
    const row = makeRow({ iconName, label: String(label || ''), action: true, choice: { action } });
    rows.push(row);
    actions.append(row.el);
  }
  requestAnimationFrame(reportSize);
}

function reportSize() {
  const panel = document.getElementById('panel');
  if (panel) ipcRenderer.send('lasco-pw-popover', { type: 'size', height: Math.ceil(panel.getBoundingClientRect().height) });
}

ipcRenderer.on('lasco-pw-popover:render', (_event, spec) => {
  if (spec && typeof spec === 'object') render(spec);
});

ipcRenderer.on('lasco-pw-popover:theme', (_event, dark) => {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
});

ipcRenderer.on('lasco-pw-popover:key', (_event, key) => {
  if (rows.length === 0) return;
  if (key === 'ArrowDown') setActive(active < rows.length - 1 ? active + 1 : 0);
  else if (key === 'ArrowUp') setActive(active > 0 ? active - 1 : rows.length - 1);
  else if (key === 'Enter' && rows[active]) choose(rows[active]);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') ipcRenderer.send('lasco-pw-popover', { type: 'dismiss', reason: 'escape' });
});

window.addEventListener('blur', () => {
  ipcRenderer.send('lasco-pw-popover', { type: 'dismiss', reason: 'blur' });
});

window.addEventListener('DOMContentLoaded', () => {
  const panel = document.getElementById('panel');
  if (panel && typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(panel);
});
