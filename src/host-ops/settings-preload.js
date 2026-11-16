'use strict';
const { ipcRenderer } = require('electron');

const el = (tag, text) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};

async function render() {
  const s = await ipcRenderer.invoke('host-ops-admin-state');
  const box = document.getElementById('enabled');
  box.checked = s.enabled;
  box.onchange = async () => {
    await ipcRenderer.invoke('host-ops-admin-set-enabled', box.checked);
    render();
  };
  const shell = document.getElementById('shellEnabled');
  shell.checked = s.shellEnabled;
  shell.disabled = !s.enabled;
  shell.onchange = async () => {
    await ipcRenderer.invoke('host-ops-admin-set-shell-enabled', shell.checked);
    render();
  };
  const grants = document.getElementById('grants');
  grants.replaceChildren();
  if (!s.grants.length) grants.append(el('li', 'Aucune autorisation permanente.'));
  for (const g of s.grants) {
    const scope =
      g.operation === 'shell.run'
        ? `commande « ${(g.commandPrefix || []).join(' ')} … » — dossier : ${(g.cwdRoots || []).join(', ')}`
        : `dossiers : ${[...g.sourceRoots, ...g.destinationRoots].join(', ')}`;
    const li = el('li', `${g.operation} — agent ${g.agentName || g.agentId} — ${scope} `);
    const b = el('button', 'Révoquer');
    b.onclick = async () => {
      await ipcRenderer.invoke('host-ops-admin-revoke', g.id);
      render();
    };
    li.append(b);
    grants.append(li);
  }
  const journal = document.getElementById('journal');
  journal.replaceChildren();
  if (!s.journal.length) journal.append(el('li', 'Journal vide.'));
  for (const j of s.journal) {
    journal.append(el('li', `${new Date(j.ts).toLocaleString()} — ${j.operation} — ${j.outcome}${j.errorCode ? ` (${j.errorCode})` : ''} — ${j.agentName || ''} — ${j.source || ''} → ${j.destination || ''}`));
  }
}

window.addEventListener('DOMContentLoaded', render);
