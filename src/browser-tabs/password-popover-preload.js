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
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  pin: [
    'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0',
    'M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
  mail: ['M22 7l-8.991 5.727a2 2 0 0 1-2.009 0L2 7', 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  phone: [
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z',
  ],
  building: ['M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18z', 'M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2', 'M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2', 'M10 6h4', 'M10 10h4', 'M10 14h4', 'M10 18h4'],
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
      iconName: ICONS[item.icon] ? item.icon : 'key',
      label: String(item.label || ''),
      sub: String(item.sub || ''),
      choice: { action: 'item', index },
    });
    rows.push(row);
    list.append(row.el);
  });

  const actions = document.getElementById('actions');
  actions.replaceChildren();
  const actionList = Array.isArray(spec.actions)
    ? spec.actions.slice(0, 4)
    : [
        { icon: 'search', label: spec.other, action: 'pick' },
        { icon: 'settings', label: spec.manage, action: 'manage' },
      ];
  for (const entry of actionList) {
    if (!entry || typeof entry.action !== 'string') continue;
    const iconName = ICONS[entry.icon] ? entry.icon : 'settings';
    const row = makeRow({ iconName, label: String(entry.label || ''), action: true, choice: { action: entry.action } });
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
