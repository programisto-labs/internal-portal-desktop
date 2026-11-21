'use strict';

/**
 * Popover de l'icône Lasco (barre des menus). Vue `file:` séparée, sans accès au portail.
 * Rendu en `textContent` uniquement : rien de ce qui vient du portail n'est lu comme du HTML.
 * Chaque clic part au main (`tray-popover-action`), qui le revérifie contre la vue affichée.
 */
const { ipcRenderer } = require('electron');

const COLORS = ['#ff6a13', '#2f80ed', '#9b51e0', '#27ae60', '#eb5757', '#f2994a', '#00a3a3', '#6e6e73'];

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function initials(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

function colorFor(key) {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function avatar(name, key) {
  const a = el('div', 'avatar', initials(name));
  a.style.background = colorFor(key || name);
  return a;
}

function relativeTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const minutes = Math.round((Date.now() - t) / 60000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const date = new Date(t);
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function send(action) {
  ipcRenderer.send('tray-popover-action', action);
}

function section(title, count, attention) {
  const s = el('section');
  const h = el('h2', attention ? 'attention' : '');
  h.append(el('span', '', title));
  if (count) h.append(el('span', 'count', String(count)));
  s.append(h);
  return s;
}

function row({ clickable, onClick, children }) {
  const r = el('div', clickable ? 'row clickable' : 'row');
  if (clickable) r.addEventListener('click', onClick);
  r.append(...children);
  return r;
}

function button(label, primary, onClick) {
  const b = el('button', primary ? 'btn primary' : 'btn', label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    b.disabled = true;
    onClick();
  });
  return b;
}

function render(view) {
  document.documentElement.dataset.theme = view.dark ? 'dark' : 'light';
  const list = document.getElementById('list');
  list.replaceChildren();

  const pending = view.hostConfirms.length + view.approvals.length;
  const running = view.working.length + view.harnessRuns.length;
  const bits = [];
  if (pending) bits.push(`${pending} à valider`);
  if (running) bits.push(`${running} en cours`);
  if (view.unreadTotal) bits.push(`${view.unreadTotal} non lu${view.unreadTotal > 1 ? 's' : ''}`);
  document.getElementById('summary').textContent = bits.join(' · ');

  const ask = document.getElementById('ask');
  ask.hidden = !view.canAsk;
  ask.replaceChildren(document.createTextNode('Demander à Lasco…'));
  if (view.askShortcut) ask.append(el('span', 'kbd', view.askShortcut));

  if (pending) {
    const s = section('À valider', pending, true);
    for (const c of view.hostConfirms) {
      const content = el('div', 'content');
      const title = el('div', 'title');
      title.append(el('strong', '', c.agentName || 'Cet ordinateur'));
      content.append(title, el('div', 'line', c.title));
      const actions = el('div', 'actions');
      actions.append(button('Voir dans Lasco', true, () => send({ type: 'show-host-confirm', id: c.id })));
      content.append(actions);
      s.append(row({ children: [avatar(c.agentName || 'Cet ordinateur', c.agentName), content] }));
    }
    for (const a of view.approvals) {
      const content = el('div', 'content');
      const title = el('div', 'title');
      title.append(el('strong', '', a.agentName));
      content.append(title, el('div', 'line', a.label));
      const actions = el('div', 'actions');
      actions.append(
        button('Refuser', false, () => send({ type: 'deny', conversationId: a.conversationId, callId: a.callId })),
        button('Voir', false, () => send({ type: 'open-approval', conversationId: a.conversationId, callId: a.callId })),
        button('Autoriser', true, () => send({ type: 'approve', conversationId: a.conversationId, callId: a.callId })),
      );
      content.append(actions);
      s.append(row({ children: [avatar(a.agentName, a.agentId), content] }));
    }
    list.append(s);
  }

  if (running) {
    const s = section('En cours', running, false);
    for (const w of view.working) {
      const content = el('div', 'content');
      const title = el('div', 'title');
      title.append(el('strong', '', w.agentName));
      content.append(title, el('div', 'line', w.status === 'writing' ? 'Écrit sa réponse…' : 'Réfléchit…'));
      s.append(
        row({
          clickable: true,
          onClick: () => send({ type: 'open-conversation', conversationId: w.conversationId }),
          children: [el('div', 'spinner'), content],
        }),
      );
    }
    for (const r of view.harnessRuns) {
      const content = el('div', 'content');
      const title = el('div', 'title');
      title.append(el('strong', '', r.label));
      content.append(title, el('div', 'line', r.detail || 'Modifie le code…'));
      s.append(
        row({
          clickable: true,
          onClick: () => send({ type: 'show-harness', runId: r.runId }),
          children: [el('div', 'spinner'), content],
        }),
      );
    }
    list.append(s);
  }

  if (view.unread.length) {
    const s = section('Non lus', view.unreadTotal, false);
    for (const u of view.unread) {
      const content = el('div', 'content');
      const title = el('div', 'title');
      title.append(el('strong', '', u.agentName), el('span', 'time', relativeTime(u.at)));
      content.append(title, el('div', 'line', u.preview || 'Nouveau message'));
      s.append(
        row({
          clickable: true,
          onClick: () => send({ type: 'open-conversation', conversationId: u.conversationId }),
          children: [avatar(u.agentName, u.agentId), content, el('div', 'badge', String(u.count))],
        }),
      );
    }
    list.append(s);
  }

  if (!list.childElementCount) {
    const message = !view.connected
      ? 'Connectez-vous à Lasco pour voir vos agents ici.'
      : 'Rien à valider, rien de nouveau.';
    list.append(el('div', 'empty', message));
  }

  const footer = document.getElementById('footer');
  footer.replaceChildren();
  const item = (label, hint, action) => {
    const b = el('button');
    b.type = 'button';
    b.append(el('span', '', label));
    if (hint) b.append(el('span', 'hint', hint));
    b.addEventListener('click', () => send(action));
    return b;
  };
  footer.append(item('Ouvrir Lasco', '', { type: 'show-main' }));
  if (view.hostOpsEnabled) {
    footer.append(item('Suspendre les opérations sur cet ordinateur', '', { type: 'pause-host-ops' }));
  }
  footer.append(item('Réglages…', '⌘,', { type: 'settings' }), el('hr'), item('Quitter Lasco', '⌘Q', { type: 'quit' }));

  requestAnimationFrame(() => {
    const panel = document.querySelector('.panel');
    const header = panel.querySelector('header').getBoundingClientRect().height;
    const askHeight = ask.hidden ? 0 : ask.getBoundingClientRect().height + 10;
    const footerHeight = footer.getBoundingClientRect().height;
    let content = 0;
    for (const child of list.children) content += child.getBoundingClientRect().height;
    ipcRenderer.send('tray-popover-size', Math.ceil(header + askHeight + content + footerHeight + 4));
  });
}

ipcRenderer.on('tray-popover-render', (_event, view) => {
  if (!view || typeof view !== 'object') return;
  render(view);
});

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ask').addEventListener('click', () => send({ type: 'ask' }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') send({ type: 'close' });
  });
  ipcRenderer.send('tray-popover-ready');
});
