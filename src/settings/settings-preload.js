'use strict';
/**
 * Réglages de Lasco Desktop : modale dessinée par Desktop au-dessus de la fenêtre (vue `file:`
 * séparée, inaccessible au portail). Le main revérifie l'expéditeur de chaque appel.
 */
const { ipcRenderer } = require('electron');

const params = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
const STANDALONE = params.get('standalone') === '1';
const AGENTS = params.get('agents') !== '0';
const SECTIONS = ['general', 'computer', 'permissions', 'journal', 'updates'];
const TITLES = {
  general: 'Général',
  computer: 'Cet ordinateur',
  permissions: 'Autorisations',
  journal: 'Journal',
  updates: 'Mises à jour',
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

let current = 'general';

function showSection(name) {
  const wanted = SECTIONS.includes(name) ? name : 'general';
  current = !AGENTS && ['computer', 'permissions', 'journal'].includes(wanted) ? 'general' : wanted;
  for (const b of document.querySelectorAll('nav button[data-section]')) {
    if (b.dataset.section === current) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== current;
  $('pageTitle').textContent = TITLES[current];
  document.querySelector('main').scrollTop = 0;
  render();
}

function close() {
  ipcRenderer.send('settings-modal-close');
}

function bindSwitch(id, channel) {
  const input = $(id);
  input.onchange = async () => {
    await ipcRenderer.invoke(channel, input.checked);
    render();
  };
}

function grantScope(g) {
  if (g.operation === 'shell.run') {
    return `Commande « ${(g.commandPrefix || []).join(' ')} … » dans ${(g.cwdRoots || []).join(', ')}`;
  }
  if (g.operation === 'code.delegate') return `Lancer ${g.harness} dans ${(g.destinationRoots || []).join(', ')}`;
  if (g.operation === 'code.write') return `Modifier les fichiers de ${(g.destinationRoots || []).join(', ')}`;
  return `${g.operation} : ${[...(g.sourceRoots || []), ...(g.destinationRoots || [])].join(', ')}`;
}

const UPDATE_LABELS = {
  idle: 'À jour.',
  checking: 'Recherche d’une mise à jour…',
  downloading: 'Téléchargement de la mise à jour…',
  downloaded: 'Mise à jour prête.',
  disabled: 'Mises à jour automatiques indisponibles pour cette version.',
  error: 'La recherche de mise à jour a échoué.',
};

function renderUpdate(u) {
  $('version').textContent = u.currentVersion || '';
  let text = UPDATE_LABELS[u.status] || '';
  if (u.status === 'downloading' && u.progressPercent) text = `Téléchargement de la mise à jour… ${Math.round(u.progressPercent)} %`;
  if (u.status === 'downloaded' && u.downloadedVersion) text = `Version ${u.downloadedVersion} prête à installer.`;
  $('updateStatus').textContent = text;
  $('updateCheck').hidden = u.status === 'downloaded';
  $('updateCheck').disabled = u.status === 'checking' || u.status === 'downloading' || u.status === 'disabled';
  $('updateInstall').hidden = u.status !== 'downloaded';
}

async function render() {
  const s = await ipcRenderer.invoke('settings-modal-state');
  if (!s) return;

  for (const b of $('theme').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.value === s.general.themeSource));
  }
  $('openLinksInApp').checked = s.general.openLinksInApp;
  renderUpdate(s.update);

  if (!s.hostOps) return;
  const h = s.hostOps;
  const setRow = (id, checked, disabled) => {
    $(id).checked = checked;
    $(id).disabled = disabled;
    document.querySelector(`[data-row="${id}"]`).classList.toggle('disabled', disabled);
  };
  setRow('enabled', h.enabled, false);
  setRow('shellEnabled', h.shellEnabled, !h.enabled);
  setRow('codeEnabled', h.codeEnabled, !h.enabled);
  setRow('harnessEnabled', h.harnessEnabled === true, !h.enabled || !h.codeEnabled);

  const grants = $('grants');
  grants.replaceChildren();
  if (!h.grants.length) grants.append(el('div', 'empty', 'Aucune autorisation permanente.'));
  for (const g of h.grants) {
    const row = el('div', 'row');
    const text = el('div', 'text');
    text.append(el('div', 'label', g.agentName || g.agentId || 'Agent'), el('div', 'hint mono', grantScope(g)));
    const revoke = el('button', 'btn danger', 'Révoquer');
    revoke.onclick = async () => {
      await ipcRenderer.invoke('host-ops-admin-revoke', g.id);
      render();
    };
    row.append(text, revoke);
    grants.append(row);
  }

  const journal = $('journal');
  journal.replaceChildren();
  if (!h.journal.length) journal.append(el('div', 'empty', 'Journal vide.'));
  for (const j of h.journal) {
    const row = el('div', 'row');
    row.append(el('div', 'when', new Date(j.ts).toLocaleString()));
    const text = el('div', 'text');
    const failed = /^(denied|refused|error|failed|cancel)/i.test(String(j.outcome || ''));
    const head = el('div', 'label');
    head.append(
      document.createTextNode(`${j.operation} · `),
      el('span', failed ? 'outcome-ko' : '', `${j.outcome}${j.errorCode ? ` (${j.errorCode})` : ''}`),
      document.createTextNode(j.agentName ? ` · ${j.agentName}` : ''),
    );
    text.append(head);
    const where = [j.source, j.destination].filter(Boolean).join(' → ');
    if (where) text.append(el('div', 'hint mono', where));
    row.append(text);
    journal.append(row);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  if (STANDALONE) document.body.classList.add('standalone');
  if (!AGENTS) for (const n of document.querySelectorAll('[data-agents]')) n.remove();

  for (const b of document.querySelectorAll('nav button[data-section]')) {
    b.onclick = () => showSection(b.dataset.section);
  }
  for (const b of $('theme').querySelectorAll('button')) {
    b.onclick = async () => {
      await ipcRenderer.invoke('settings-modal-set-theme', b.dataset.value);
      render();
    };
  }
  bindSwitch('openLinksInApp', 'settings-modal-set-open-links');
  if (AGENTS) {
    bindSwitch('enabled', 'host-ops-admin-set-enabled');
    bindSwitch('shellEnabled', 'host-ops-admin-set-shell-enabled');
    bindSwitch('codeEnabled', 'host-ops-admin-set-code-enabled');
    bindSwitch('harnessEnabled', 'host-ops-admin-set-harness-enabled');
  }
  $('updateCheck').onclick = async () => {
    renderUpdate({ ...(await ipcRenderer.invoke('settings-modal-state')).update, status: 'checking' });
    await ipcRenderer.invoke('settings-modal-update-check');
    render();
  };
  $('updateInstall').onclick = () => ipcRenderer.invoke('settings-modal-update-install');

  $('close').onclick = close;
  $('backdrop').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget && !STANDALONE) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  showSection(params.get('section') || 'general');
  requestAnimationFrame(() => document.body.classList.add('shown'));
});

// Reopened on another section (⌘, or profil > « Cet ordinateur »), or state changed elsewhere.
ipcRenderer.on('settings-modal-show', (_e, section) => showSection(section || current));
ipcRenderer.on('settings-modal-refresh', () => render());
