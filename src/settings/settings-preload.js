'use strict';
/**
 * Réglages de Lasco Desktop : modale dessinée par Desktop au-dessus de la fenêtre (vue `file:`
 * séparée, inaccessible au portail). Le main revérifie l'expéditeur de chaque appel.
 */
const { ipcRenderer } = require('electron');

const params = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
const STANDALONE = params.get('standalone') === '1';
const AGENTS = params.get('agents') !== '0';
const SECTIONS = ['general', 'downloads', 'drive', 'computer', 'permissions', 'journal', 'updates'];
const TITLES = {
  general: 'Général',
  downloads: 'Téléchargements',
  drive: 'My Drive',
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
const IS_MAC = process.platform === 'darwin';
/** Où vit l'icône Lasco (même libellé que src/tray/tray-platform.js : le preload sandboxé ne peut pas l'importer). */
const TRAY_PLACE = IS_MAC ? 'la barre des menus' : process.platform === 'win32' ? 'la zone de notification' : 'la barre système';
const QUIT_HINT = IS_MAC ? '⌘Q quitte Lasco.' : '« Quitter Lasco » dans le menu de l’icône quitte Lasco.';

/** Raccourcis globaux (docs/background.md). */
const SHORTCUT_TEXT = {
  toggleWindow: { label: 'Afficher / masquer Lasco', hint: 'Fait passer Lasco devant, ou le masque s’il est déjà devant.' },
  ask: { label: 'Demander à Lasco', hint: 'Ouvre Lasco sur une nouvelle conversation.' },
};
const SHORTCUT_ERRORS = {
  'needs-modifier': IS_MAC ? 'Ajoutez ⌘, ⌃ ou ⌥ à la touche.' : 'Ajoutez Ctrl ou Alt à la touche.',
  'unsupported-key': 'Cette touche ne peut pas servir de raccourci.',
  reserved: 'Raccourci réservé par le système ou par Lasco.',
  duplicate: 'Déjà utilisé par l’autre raccourci.',
  unavailable: 'Déjà pris par une autre app : choisissez une autre combinaison.',
  invalid: 'Raccourci invalide.',
};
/** Action en cours d'enregistrement ({ id, button }) ; les raccourcis globaux sont suspendus pendant ce temps. */
let recording = null;
/** Dernière erreur par action, affichée sous la ligne jusqu'au prochain changement. */
const shortcutErrors = {};

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
  stopRecording();
  ipcRenderer.send('settings-modal-close');
}

function stopRecording() {
  if (!recording) return;
  const { button } = recording;
  recording = null;
  document.removeEventListener('keydown', onRecordKey, true);
  button.classList.remove('recording');
  ipcRenderer.invoke('settings-modal-shortcut-recording', false);
  render();
}

function startRecording(id, button) {
  if (recording) stopRecording();
  recording = { id, button };
  delete shortcutErrors[id];
  button.classList.add('recording');
  button.textContent = 'Tapez…';
  document.addEventListener('keydown', onRecordKey, true);
  ipcRenderer.invoke('settings-modal-shortcut-recording', true);
}

async function onRecordKey(e) {
  if (!recording) return;
  // Avant le gestionnaire « Échap ferme les réglages » et les raccourcis de la page.
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    stopRecording();
    return;
  }
  const { id } = recording;
  const res = await ipcRenderer.invoke('settings-modal-set-shortcut', id, {
    code: e.code,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
  });
  if (!recording || recording.id !== id) return;
  // Modificateur seul : on attend la touche.
  if (res && res.error === 'modifier-only') return;
  if (res && !res.ok && !res.saved) {
    // Combinaison refusée : on reste en enregistrement pour en taper une autre.
    shortcutErrors[id] = SHORTCUT_ERRORS[res.error] || SHORTCUT_ERRORS.invalid;
    const hint = document.querySelector(`[data-shortcut-hint="${id}"]`);
    if (hint) {
      hint.textContent = shortcutErrors[id];
      hint.classList.add('error');
    }
    return;
  }
  // Enregistré : l'erreur d'une frappe refusée juste avant disparaît (sauf « pris par une autre app »).
  if (res && res.error) shortcutErrors[id] = SHORTCUT_ERRORS[res.error] || SHORTCUT_ERRORS.invalid;
  else delete shortcutErrors[id];
  stopRecording();
}

async function setShortcut(id, value) {
  delete shortcutErrors[id];
  const res = await ipcRenderer.invoke('settings-modal-set-shortcut', id, value);
  if (res && res.error) shortcutErrors[id] = SHORTCUT_ERRORS[res.error] || SHORTCUT_ERRORS.invalid;
  render();
}

function renderShortcuts(list) {
  const group = $('shortcuts');
  group.replaceChildren();
  for (const sc of list) {
    const copy = SHORTCUT_TEXT[sc.id];
    if (!copy) continue;
    const row = el('div', 'row');
    const text = el('div', 'text');
    const error = shortcutErrors[sc.id] || (sc.status === 'unavailable' ? SHORTCUT_ERRORS.unavailable : '');
    const hint = el('div', error ? 'hint error' : 'hint', error || copy.hint);
    hint.dataset.shortcutHint = sc.id;
    text.append(el('div', 'label', copy.label), hint);
    row.append(text);
    if (!sc.isDefault) {
      const reset = el('button', 'link', `Rétablir ${sc.defaultLabel}`);
      reset.onclick = () => setShortcut(sc.id, null);
      row.append(reset);
    }
    if (sc.accelerator) {
      const off = el('button', 'link', 'Désactiver');
      off.onclick = () => setShortcut(sc.id, '');
      row.append(off);
    }
    const keys = el('button', sc.accelerator ? 'keys' : 'keys off', sc.label || 'Aucun');
    keys.setAttribute('aria-label', `${copy.label} : ${sc.label || 'aucun raccourci'}. Modifier`);
    keys.onclick = () => startRecording(sc.id, keys);
    row.append(keys);
    group.append(row);
  }
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

/** Mêmes messages que le portail (lib/desktop-drive-sync/engine.ts). */
const DRIVE_ERRORS = {
  'desktop-unavailable': 'Synchronisation indisponible.',
  'no-folder': 'Choisissez un dossier de destination.',
  'permission-denied': 'Lasco n’a pas l’autorisation d’écrire dans ce dossier. Choisissez-en un autre ou autorisez l’accès dans les réglages du système.',
  'folder-not-found': 'Le dossier est introuvable (déplacé, supprimé ou disque déconnecté).',
  'folder-not-writable': 'Le dossier n’est pas accessible en écriture.',
  'disk-full': 'Le disque est plein : libérez de l’espace pour poursuivre la synchronisation.',
  'path-escape': 'Un chemin a été refusé car il sortait du dossier choisi.',
  network: 'Connexion interrompue. La synchronisation reprendra automatiquement.',
  unauthorized: 'Session expirée : reconnectez-vous à Lasco.',
  'account-mismatch': 'Ce dossier est déjà synchronisé pour un autre compte. Choisissez un autre dossier pour ce compte.',
  unknown: 'Erreur inattendue pendant la synchronisation.',
};
const DRIVE_NOTICES = {
  'remote-missing': 'Des fichiers ne sont plus dans My Drive ; leurs copies sont conservées.',
  'native-document-skipped': 'Les documents Lasco (texte, présentation, tableur) ne sont pas encore copiés.',
  'conflict-kept': 'Un fichier existant a été gardé ; la version Lasco porte un autre nom.',
  'path-rejected': 'Des noms de fichiers inutilisables sur cet ordinateur ont été ignorés.',
};
/** Erreur d'une action des réglages (choix du dossier), affichée jusqu'au prochain changement. */
let driveActionError = null;

function renderDrive(d) {
  if (!d) return;
  $('driveEnabled').checked = d.enabled;
  $('driveFolder').textContent = d.rootPath || 'Aucun dossier choisi';
  $('driveChooseFolder').textContent = d.rootPath ? 'Changer…' : 'Choisir…';
  $('driveOpenFolder').hidden = !d.rootPath;
  const run = d.lastRun;
  let status = 'Désactivée.';
  if (d.enabled && !d.bound) status = 'En attente : connectez-vous à Lasco dans cette fenêtre.';
  else if (d.enabled && !run) status = 'Première synchronisation en cours…';
  else if (d.enabled && run) {
    const when = run.at ? new Date(run.at).toLocaleString() : '';
    if (run.status === 'error') status = `Dernier essai ${when} : échec.`;
    else if (run.status === 'syncing') status = 'Synchronisation en cours…';
    else status = `À jour (${when})${run.downloaded ? ` · ${run.downloaded} fichier(s) copié(s)` : ''}.`;
  }
  if (d.enabled && d.ownerLabel) status += ` Compte : ${d.ownerLabel}.`;
  $('driveStatus').textContent = status;
  const kinds = d.enabled && run ? run.noticeKinds || [] : [];
  const notices = kinds.map((k) => DRIVE_NOTICES[k]).filter(Boolean);
  $('driveNotices').hidden = notices.length === 0;
  $('driveNotices').textContent = notices.join(' ');
  const code =
    driveActionError || (d.enabled && d.rejected ? 'account-mismatch' : null) || (d.enabled && run && run.status === 'error' ? run.error : null);
  $('driveError').hidden = !code;
  $('driveError').textContent = code ? DRIVE_ERRORS[code] || DRIVE_ERRORS.unknown : '';
}

async function driveAction(channel, arg) {
  const res = await ipcRenderer.invoke(channel, arg);
  driveActionError = res && !res.ok && !res.cancelled ? res.error || 'unknown' : null;
  render();
}

/** Erreur du choix du dossier des téléchargements, affichée jusqu'au prochain changement. */
let downloadsError = null;

function renderDownloads(d) {
  if (!d) return;
  $('downloadsFolder').textContent = d.directory || '';
  $('downloadsReset').hidden = d.isDefault;
  $('downloadsAskWhere').checked = d.askWhere;
  $('downloadsError').hidden = !downloadsError;
  $('downloadsError').textContent = downloadsError || '';
}

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
  const browser = s.general.defaultBrowser || { available: false };
  $('defaultBrowserRow').hidden = !browser.available;
  $('defaultBrowserSet').hidden = browser.isDefault === true;
  $('defaultBrowserHint').textContent = browser.isDefault
    ? 'Lasco est votre navigateur par défaut : les liens web s’ouvrent dans un onglet de Lasco.'
    : 'Les liens web ouverts ailleurs (e-mails, autres apps) s’ouvriront dans un onglet de Lasco.';
  const g = s.general;
  $('keepInBackgroundRow').hidden = !g.backgroundAvailable;
  $('keepInBackground').checked = g.keepInBackground;
  const login = g.loginItem || { available: false };
  $('openAtLoginRow').classList.toggle('disabled', !login.available);
  $('openAtLogin').disabled = !login.available;
  $('openAtLogin').checked = login.enabled === true;
  $('openAtLoginHint').textContent = !login.available
    ? 'Disponible dans la version installée de Lasco.'
    : g.backgroundAvailable && g.keepInBackground
      ? `Lasco démarre masqué, dans ${TRAY_PLACE}.`
      : 'Lasco démarre avec l’ordinateur.';
  $('openAtLoginApproval').hidden = !(login.enabled && login.requiresApproval);
  $('openLoginItems').hidden = !(login.enabled && login.requiresApproval);
  // Pas de redessin pendant l'enregistrement : le bouton « Tapez… » resterait sinon sans écouteur.
  if (!recording) renderShortcuts(g.shortcuts || []);
  renderUpdate(s.update);
  renderDrive(s.driveSync);
  renderDownloads(s.downloads);

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
  $('keepInBackgroundLabel').textContent = `Garder Lasco ouvert dans ${TRAY_PLACE}`;
  $('keepInBackground').setAttribute('aria-label', `Garder Lasco ouvert dans ${TRAY_PLACE}`);
  $('keepInBackgroundHint').textContent =
    `Fermer la fenêtre la masque : les agents, les validations et les notifications continuent. ${QUIT_HINT}`;
  if (!IS_MAC) {
    $('shortcutsIntro').textContent =
      'Disponibles partout, même quand Lasco est masqué. Cliquez sur un raccourci puis tapez la nouvelle combinaison (avec Ctrl ou Alt). Échap annule.';
  }
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
  $('defaultBrowserSet').onclick = async () => {
    // macOS asks for confirmation; its answer is only known once the window regains focus.
    await ipcRenderer.invoke('settings-modal-set-default-browser');
    render();
    window.addEventListener('focus', () => render(), { once: true });
  };
  bindSwitch('keepInBackground', 'settings-modal-set-keep-in-background');
  bindSwitch('openAtLogin', 'settings-modal-set-open-at-login');
  $('openLoginItems').onclick = () => ipcRenderer.invoke('settings-modal-open-login-items');
  $('downloadsChoose').onclick = async () => {
    const res = await ipcRenderer.invoke('settings-modal-downloads-choose');
    downloadsError = res && res.error === 'not-writable' ? 'Lasco ne peut pas écrire dans ce dossier. Choisissez-en un autre.' : null;
    render();
  };
  $('downloadsReset').onclick = async () => {
    downloadsError = null;
    await ipcRenderer.invoke('settings-modal-downloads-reset');
    render();
  };
  $('downloadsOpen').onclick = () => ipcRenderer.invoke('settings-modal-downloads-open');
  bindSwitch('downloadsAskWhere', 'settings-modal-downloads-set-ask');
  $('driveEnabled').onchange = () => driveAction('settings-modal-drive-set-enabled', $('driveEnabled').checked);
  $('driveChooseFolder').onclick = () => driveAction('settings-modal-drive-choose-folder');
  $('driveOpenFolder').onclick = () => ipcRenderer.invoke('settings-modal-drive-open-folder');
  // La vue perd le focus pendant un enregistrement : on l'arrête (raccourcis globaux rétablis).
  window.addEventListener('blur', () => stopRecording());
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
