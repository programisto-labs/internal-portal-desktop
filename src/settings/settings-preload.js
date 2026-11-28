'use strict';
/**
 * Réglages de Lasco Desktop : modale dessinée par Desktop au-dessus de la fenêtre (vue `file:`
 * séparée, inaccessible au portail). Le main revérifie l'expéditeur de chaque appel.
 */
const { ipcRenderer } = require('electron');

const params = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
const STANDALONE = params.get('standalone') === '1';
const AGENTS = params.get('agents') !== '0';
const SECTIONS = ['general', 'search', 'downloads', 'memory', 'drive', 'sites', 'computer', 'permissions', 'journal', 'updates'];
const TITLES = {
  general: 'Général',
  search: 'Moteur de recherche',
  downloads: 'Téléchargements',
  memory: 'Économiseur de mémoire',
  drive: 'My Drive',
  sites: 'Autorisations des sites',
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

const SEARCH_ERRORS = {
  'name-required': 'Donnez un nom au moteur.',
  'name-too-long': 'Nom trop long (60 caractères au plus).',
  'keyword-required': 'Choisissez un raccourci.',
  'keyword-spaces': 'Le raccourci ne peut pas contenir d’espace.',
  'keyword-too-long': 'Raccourci trop long (60 caractères au plus).',
  'keyword-taken': 'Ce raccourci est déjà utilisé par un autre moteur.',
  'invalid-template': 'Adresse invalide : une URL http(s) avec %s à la place de la recherche.',
  'too-many': 'Trop de moteurs ajoutés : supprimez-en un d’abord.',
  'unknown-engine': 'Ce moteur n’existe plus.',
};
/** Formulaire ouvert : `{ id: null }` pour un ajout, `{ id }` pour une modification ; erreur affichée dedans. */
let searchForm = null;

function engineForm(engine) {
  const form = el('div', 'engine-form');
  const fields = [
    ['name', 'Nom', 'Wikipédia', engine ? engine.name : ''],
    ['keyword', 'Raccourci', 'wiki', engine ? engine.keyword : ''],
    ['template', 'URL avec %s', 'https://fr.wikipedia.org/w/index.php?search=%s', engine ? engine.template : ''],
  ];
  const inputs = {};
  for (const [key, label, placeholder, value] of fields) {
    const row = el('div', 'field');
    const id = `searchField-${key}`;
    const l = el('label', '', label);
    l.htmlFor = id;
    const input = document.createElement('input');
    input.id = id;
    input.type = key === 'template' ? 'url' : 'text';
    input.placeholder = placeholder;
    input.value = value;
    input.spellcheck = false;
    input.autocapitalize = 'off';
    if (key === 'template') input.className = 'mono';
    inputs[key] = input;
    row.append(l, input);
    form.append(row);
  }
  const actions = el('div', 'actions');
  const error = el('div', searchForm && searchForm.error ? 'hint error' : 'hint', searchForm && searchForm.error ? SEARCH_ERRORS[searchForm.error] || 'Enregistrement impossible.' : '%s est remplacé par le texte recherché.');
  const cancel = el('button', 'link', 'Annuler');
  cancel.onclick = () => {
    searchForm = null;
    document.activeElement.blur();
    render();
  };
  const save = el('button', 'btn', engine ? 'Enregistrer' : 'Ajouter');
  const submit = async () => {
    const value = { name: inputs.name.value, keyword: inputs.keyword.value, template: inputs.template.value };
    const res = engine
      ? await ipcRenderer.invoke('settings-modal-search-update', engine.id, value)
      : await ipcRenderer.invoke('settings-modal-search-add', value);
    // Sorti du formulaire : `renderSearch` ne redessine pas sous un champ qui a le focus.
    if (document.activeElement) document.activeElement.blur();
    if (res && res.ok) searchForm = null;
    else searchForm = { id: engine ? engine.id : null, error: (res && res.error) || 'invalid', draft: value };
    render();
  };
  save.onclick = submit;
  for (const input of Object.values(inputs)) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    });
  }
  if (searchForm && searchForm.draft) {
    for (const key of Object.keys(inputs)) inputs[key].value = searchForm.draft[key] || '';
  }
  actions.append(error, cancel, save);
  form.append(actions);
  requestAnimationFrame(() => inputs.name.focus());
  return form;
}

function engineRow(engine, defaultId) {
  const row = el('div', engine.active ? 'row' : 'row disabled');
  const text = el('div', 'text');
  text.append(el('div', 'label', engine.name), el('div', 'hint mono', `${engine.keyword} · ${engine.template}`));
  row.append(text);
  if (engine.id === defaultId) row.append(el('span', 'badge', 'Par défaut'));
  if (engine.kind === 'site') {
    const toggle = el('button', 'link', engine.active ? 'Désactiver' : 'Activer');
    toggle.onclick = async () => {
      await ipcRenderer.invoke('settings-modal-search-set-active', engine.id, !engine.active);
      render();
    };
    row.append(toggle);
  }
  const edit = el('button', 'link', 'Modifier');
  edit.onclick = () => {
    searchForm = { id: engine.id };
    render();
  };
  const remove = el('button', 'btn danger', 'Supprimer');
  remove.setAttribute('aria-label', `Supprimer ${engine.name}`);
  remove.onclick = async () => {
    await ipcRenderer.invoke('settings-modal-search-remove', engine.id);
    if (searchForm && searchForm.id === engine.id) searchForm = null;
    render();
  };
  row.append(edit, remove);
  return row;
}

function renderSearch(s) {
  if (!s) return;
  const select = $('searchDefault');
  // Pas de redessin pendant le choix : la liste se refermerait.
  if (document.activeElement !== select) {
    select.replaceChildren();
    const groups = [
      ['Moteurs de recherche', s.engines.filter((e) => e.kind === 'builtin')],
      ['Moteurs ajoutés', s.engines.filter((e) => e.kind === 'custom')],
      ['Sites', s.engines.filter((e) => e.kind === 'site' && e.active)],
    ];
    for (const [label, engines] of groups) {
      if (!engines.length) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const e of engines) {
        const option = document.createElement('option');
        option.value = e.id;
        option.textContent = e.name;
        group.append(option);
      }
      select.append(group);
    }
    select.value = s.defaultId;
  }
  $('searchAutoDiscover').checked = s.autoDiscover;

  // Un champ du formulaire a le focus : on ne le redessine pas sous les doigts.
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.engine-form');
  const custom = $('searchCustom');
  if (!typing || !custom.contains(document.activeElement)) {
    custom.replaceChildren();
    for (const e of s.engines.filter((x) => x.kind === 'custom')) {
      custom.append(searchForm && searchForm.id === e.id ? engineForm(e) : engineRow(e, s.defaultId));
    }
    if (searchForm && searchForm.id === null) custom.append(engineForm(null));
    else {
      const row = el('div', 'row');
      const text = el('div', 'text');
      text.append(
        el('div', 'label', 'Ajouter un moteur'),
        el('div', 'hint', 'Un nom, un raccourci et l’adresse de recherche, comme dans Chrome et Brave.'),
      );
      const add = el('button', 'btn', 'Ajouter…');
      add.onclick = () => {
        searchForm = { id: null };
        render();
      };
      row.append(text, add);
      custom.append(row);
    }
  }
  const sites = $('searchSites');
  if (!typing || !sites.contains(document.activeElement)) {
    sites.replaceChildren();
    const list = s.engines.filter((x) => x.kind === 'site');
    if (!list.length) sites.append(el('div', 'empty', 'Aucun site pour l’instant.'));
    for (const e of list) sites.append(searchForm && searchForm.id === e.id ? engineForm(e) : engineRow(e, s.defaultId));
  }
}

/** Libellé d'un délai de mise en veille (minutes, 0 = jamais). */
function tabSleepLabel(minutes) {
  if (minutes === 0) return 'Jamais';
  if (minutes < 60) return `Après ${minutes} min`;
  const hours = minutes / 60;
  return hours === 1 ? 'Après 1 heure' : `Après ${hours} heures`;
}

let tabSleepError = null;

function renderTabSleep(t) {
  if (!t) return;
  const select = $('tabSleepMinutes');
  if (document.activeElement !== select) {
    select.replaceChildren();
    for (const minutes of t.choices) {
      const option = document.createElement('option');
      option.value = String(minutes);
      option.textContent = tabSleepLabel(minutes);
      select.append(option);
    }
    select.value = String(t.minutes);
  }
  $('tabSleepHint').textContent = t.overrideMs
    ? `Délai de développement : ${Math.round(t.overrideMs / 1000)} s (LASCO_TAB_SLEEP_MS).`
    : 'Onglets web et pages de Lasco. Jamais l’onglet affiché, un onglet qui joue du son, en plein écran, en appel, piloté par un agent, avec une saisie en cours, ni Lasco Code.';
  $('tabSleepError').hidden = !tabSleepError;
  $('tabSleepError').textContent = tabSleepError || '';
  const list = $('tabSleepSites');
  list.replaceChildren();
  if (!t.neverSites.length) list.append(el('div', 'empty', 'Aucun site. Ses sous-domaines sont compris (figma.com couvre www.figma.com).'));
  for (const host of t.neverSites) {
    const row = el('div', 'row');
    const text = el('div', 'text');
    text.append(el('div', 'label mono', host));
    const remove = el('button', 'btn danger', 'Retirer');
    remove.setAttribute('aria-label', `Retirer ${host}`);
    remove.onclick = async () => {
      await ipcRenderer.invoke('settings-modal-tab-sleep-remove-site', host);
      render();
    };
    row.append(text, remove);
    list.append(row);
  }
}

async function addTabSleepSite() {
  const input = $('tabSleepSite');
  const res = await ipcRenderer.invoke('settings-modal-tab-sleep-add-site', input.value);
  if (res && res.ok) {
    input.value = '';
    tabSleepError = null;
  } else {
    tabSleepError = 'Adresse de site illisible. Exemple : figma.com';
  }
  render();
}

function renderDownloads(d) {
  if (!d) return;
  $('downloadsFolder').textContent = d.directory || '';
  $('downloadsReset').hidden = d.isDefault;
  $('downloadsAskWhere').checked = d.askWhere;
  $('downloadsError').hidden = !downloadsError;
  $('downloadsError').textContent = downloadsError || '';
}

/** Site dont toutes les autorisations sont affichées (« Modifier »). */
let expandedSite = null;
const SITE_DECISIONS = [
  ['allow', 'Autoriser'],
  ['block', 'Bloquer'],
];

function decisionSelect(label, value, options, onChange) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = text;
    select.append(option);
  }
  select.value = value;
  select.onchange = async () => {
    await onChange(select.value);
    select.blur();
    render();
  };
  return select;
}

/** Texte de « aucune décision » : le réglage par défaut, comme Chrome (« Demander (par défaut) »). */
function defaultOptionText(defaults, permission) {
  return defaults[permission] === 'block' ? 'Bloquer (par défaut)' : 'Demander (par défaut)';
}

function siteSummary(site, names) {
  const parts = [];
  for (const [permission, decision] of Object.entries(site.decisions)) {
    parts.push(`${names[permission] || permission} : ${decision === 'allow' ? 'autorisé' : 'bloqué'}`);
  }
  for (const permission of site.dismissed) parts.push(`${names[permission] || permission} : ignoré`);
  return parts.join(' · ');
}

function renderAdblock(ab) {
  if (!ab) return;
  $('adblockEnabled').checked = ab.enabled;
  const updated = ab.updatedAt
    ? `Listes mises à jour le ${new Date(ab.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`
    : 'Listes en cours de téléchargement.';
  $('adblockHint').textContent = `${updated} Le nombre de requêtes bloquées s’affiche dans les informations du site, à gauche de l’adresse.`;
  const list = $('adblockSites');
  list.replaceChildren();
  if (!ab.sites.length) {
    list.append(el('div', 'empty', 'Aucun site pour l’instant.'));
    return;
  }
  for (const site of ab.sites) {
    const row = el('div', 'row');
    const text = el('div', 'text');
    text.append(el('div', 'label', site.host));
    if (!site.origin.startsWith('https:')) text.append(el('div', 'hint mono', site.origin));
    const on = el('button', 'btn', 'Réactiver le bloqueur');
    on.setAttribute('aria-label', `Réactiver le bloqueur sur ${site.host}`);
    on.onclick = async () => {
      await ipcRenderer.invoke('settings-modal-adblock-set-site', site.origin, true);
      render();
    };
    row.append(text, on);
    list.append(row);
  }
}

function renderSites(sp) {
  if (!sp) return;
  const names = sp.names || {};
  const defaults = Object.fromEntries(sp.defaults.map((d) => [d.permission, d.value]));
  const defaultsGroup = $('siteDefaults');
  if (!defaultsGroup.contains(document.activeElement) || document.activeElement.tagName !== 'SELECT') {
    defaultsGroup.replaceChildren();
    for (const d of sp.defaults) {
      const row = el('div', 'row');
      const text = el('div', 'text');
      text.append(el('div', 'label', names[d.permission] || d.permission));
      const label = names[d.permission] || d.permission;
      const select = decisionSelect(label, d.value, [['ask', 'Demander'], ['block', 'Bloquer']], (value) =>
        ipcRenderer.invoke('settings-modal-site-set-default', d.permission, value),
      );
      row.append(text, select);
      defaultsGroup.append(row);
    }
  }

  const list = $('siteList');
  if (list.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  list.replaceChildren();
  const query = $('siteSearch').value.trim().toLowerCase();
  const sites = sp.sites.filter((site) => !query || site.origin.toLowerCase().includes(query));
  $('siteResetAll').disabled = sp.sites.length === 0;
  if (!sites.length) {
    list.append(el('div', 'empty', query ? 'Aucun site ne correspond.' : 'Aucun site pour l’instant.'));
    return;
  }
  for (const site of sites) {
    const block = el('div', 'site-block');
    const row = el('div', 'row');
    const text = el('div', 'text');
    text.append(el('div', 'label', site.host), el('div', 'hint', siteSummary(site, names)));
    if (!site.origin.startsWith('https:')) text.append(el('div', 'hint mono', site.origin));
    const open = expandedSite === site.origin;
    const toggle = el('button', 'link', open ? 'Fermer' : 'Modifier');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', `${open ? 'Fermer' : 'Modifier'} les autorisations de ${site.host}`);
    toggle.onclick = () => {
      expandedSite = open ? null : site.origin;
      render();
    };
    const remove = el('button', 'btn danger', 'Supprimer');
    remove.setAttribute('aria-label', `Supprimer les autorisations de ${site.host}`);
    remove.onclick = async () => {
      await ipcRenderer.invoke('settings-modal-site-remove', site.origin);
      if (expandedSite === site.origin) expandedSite = null;
      render();
    };
    row.append(text, toggle, remove);
    block.append(row);
    if (open) {
      const perms = el('div', 'site-perms');
      for (const d of sp.defaults) {
        const permission = d.permission;
        const line = el('div', 'site-perm');
        const name = el('div', 'name');
        name.append(el('div', '', names[permission] || permission));
        const dismissed = !site.decisions[permission] && site.dismissed.includes(permission);
        if (dismissed) name.append(el('div', 'hint', 'Ignoré jusqu’au redémarrage de Lasco'));
        line.append(name);
        if (dismissed) {
          const lift = el('button', 'link', 'Redemander');
          lift.onclick = async () => {
            await ipcRenderer.invoke('settings-modal-site-set', site.origin, permission, null);
            render();
          };
          line.append(lift);
        }
        const options = [...SITE_DECISIONS, ['ask', defaultOptionText(defaults, permission)]];
        line.append(
          decisionSelect(`${names[permission] || permission} pour ${site.host}`, site.decisions[permission] || 'ask', options, (value) =>
            ipcRenderer.invoke('settings-modal-site-set', site.origin, permission, value),
          ),
        );
        perms.append(line);
      }
      block.append(perms);
    }
    list.append(block);
  }
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
  $('safeBrowsingEnabled').checked = g.safeBrowsingEnabled !== false;
  $('pictureInPictureAuto').checked = g.pictureInPictureAuto !== false;
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
  renderTabSleep(s.tabSleep);
  renderSearch(s.searchEngines);
  renderSites(s.sitePermissions);
  renderAdblock(s.adblock);

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
  bindSwitch('safeBrowsingEnabled', 'settings-modal-set-safe-browsing');
  bindSwitch('pictureInPictureAuto', 'settings-modal-set-pip-auto');
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
  $('tabSleepMinutes').onchange = async () => {
    await ipcRenderer.invoke('settings-modal-tab-sleep-set-minutes', Number($('tabSleepMinutes').value));
    $('tabSleepMinutes').blur();
    render();
  };
  $('tabSleepAdd').onclick = () => addTabSleepSite();
  $('tabSleepSite').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTabSleepSite();
    }
  });
  bindSwitch('searchAutoDiscover', 'settings-modal-search-set-auto-discover');
  $('searchDefault').onchange = async () => {
    await ipcRenderer.invoke('settings-modal-search-set-default', $('searchDefault').value);
    $('searchDefault').blur();
    render();
  };
  bindSwitch('adblockEnabled', 'settings-modal-adblock-set-enabled');
  $('siteSearch').oninput = () => render();
  $('siteResetAll').onclick = async () => {
    const res = await ipcRenderer.invoke('settings-modal-site-reset-all');
    if (res && res.ok) expandedSite = null;
    render();
  };
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
