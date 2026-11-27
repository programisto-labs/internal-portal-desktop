'use strict';

/*
 * Panneau « Responsive » des DevTools d'un onglet web (docs/devtools-responsive.md).
 * Il n'émule rien lui-même : il envoie les réglages à Lasco Desktop (via le service worker de
 * l'extension), qui redimensionne l'onglet et règle l'émulation. Desktop renvoie l'état réel.
 */

const STRINGS = {
  fr: {
    on: 'Responsive activé',
    off: 'Activer le mode responsive',
    device: 'Appareil',
    responsive: 'Responsive (taille libre)',
    type: 'Type',
    mobile: 'Mobile (tactile)',
    desktop: 'Ordinateur',
    dpr: 'Densité (DPR)',
    zoom: 'Zoom',
    fit: 'Ajuster',
    rotate: 'Pivoter',
    width: 'Largeur',
    height: 'Hauteur',
    statusOn: '{w} × {h} · DPR {dpr} · affiché à {scale} %',
    statusOff: 'Désactivé : la page occupe tout l’onglet.',
    unavailable: 'Mode responsive indisponible pour cet onglet.',
    hint: 'Le réglage tient jusqu’à la fermeture des DevTools. Le throttling réseau reste dans l’onglet Network.',
  },
  en: {
    on: 'Responsive on',
    off: 'Turn on responsive mode',
    device: 'Device',
    responsive: 'Responsive (free size)',
    type: 'Type',
    mobile: 'Mobile (touch)',
    desktop: 'Desktop',
    dpr: 'Device pixel ratio',
    zoom: 'Zoom',
    fit: 'Fit',
    rotate: 'Rotate',
    width: 'Width',
    height: 'Height',
    statusOn: '{w} × {h} · DPR {dpr} · shown at {scale}%',
    statusOff: 'Off: the page fills the whole tab.',
    unavailable: 'Responsive mode is not available for this tab.',
    hint: 'The setting lasts until DevTools close. Network throttling stays in the Network panel.',
  },
};

const lang = String(navigator.language || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';
const text = (key, params) =>
  String(STRINGS[lang][key] || STRINGS.fr[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''));

const tabId = chrome.devtools.inspectedWindow.tabId;
const $ = (id) => document.getElementById(id);
const ui = {
  toggle: $('toggle'),
  toggleLabel: $('toggle-label'),
  device: $('device'),
  width: $('width'),
  height: $('height'),
  rotate: $('rotate'),
  mobile: $('mobile'),
  dpr: $('dpr'),
  zoom: $('zoom'),
  status: $('status'),
};

let state = null;
let optionsBuilt = false;

if (chrome.devtools.panels.themeName === 'dark') document.documentElement.classList.add('dark');
for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = text(node.dataset.i18n);
ui.rotate.title = text('rotate');
ui.rotate.setAttribute('aria-label', text('rotate'));
ui.width.setAttribute('aria-label', text('width'));
ui.height.setAttribute('aria-label', text('height'));

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ ...message, tabId }, (reply) => {
        if (chrome.runtime.lastError || !reply) resolve({ ok: false });
        else resolve(reply);
      });
    } catch (_) {
      resolve({ ok: false });
    }
  });
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = String(value);
  node.textContent = label;
  return node;
}

function buildOptions(reply) {
  if (optionsBuilt) return;
  optionsBuilt = true;
  ui.device.append(option('responsive', text('responsive')));
  for (const device of reply.devices) {
    ui.device.append(option(device.id, `${device.name} · ${device.width} × ${device.height}`));
  }
  for (const dpr of reply.deviceScaleFactors) ui.dpr.append(option(dpr, String(dpr)));
  ui.zoom.append(option('fit', text('fit')));
  for (const zoom of reply.zooms) ui.zoom.append(option(zoom, `${Math.round(zoom * 100)} %`));
}

function render(reply) {
  if (!reply || !reply.ok) {
    ui.status.textContent = text('unavailable');
    ui.status.classList.add('error');
    for (const control of [ui.toggle, ui.device, ui.width, ui.height, ui.rotate, ui.mobile, ui.dpr, ui.zoom]) {
      control.disabled = true;
    }
    return;
  }
  buildOptions(reply);
  state = reply;
  const { settings, active } = reply;
  const isDevice = settings.device !== 'responsive';
  ui.toggle.setAttribute('aria-pressed', String(active));
  ui.toggleLabel.textContent = active ? text('on') : text('off');
  ui.device.value = settings.device;
  if (document.activeElement !== ui.width) ui.width.value = String(settings.width);
  if (document.activeElement !== ui.height) ui.height.value = String(settings.height);
  ui.width.disabled = isDevice;
  ui.height.disabled = isDevice;
  ui.mobile.value = settings.mobile ? '1' : '0';
  ui.mobile.disabled = isDevice;
  ui.dpr.value = String(settings.deviceScaleFactor);
  ui.dpr.disabled = isDevice;
  ui.zoom.value = String(settings.zoom);
  ui.status.classList.remove('error');
  ui.status.textContent = active
    ? text('statusOn', {
        w: settings.width,
        h: settings.height,
        dpr: settings.deviceScaleFactor,
        scale: Math.round((reply.scale || 1) * 100),
      })
    : text('statusOff');
}

/** Toute modification active le mode, comme la barre d'appareil de Chrome. */
async function apply(patch) {
  const base = state ? state.settings : {};
  render(await send({ op: 'set', settings: { ...base, ...patch } }));
}

ui.toggle.addEventListener('click', async () => {
  if (state && state.active) render(await send({ op: 'off' }));
  else apply({});
});
ui.device.addEventListener('change', () => apply({ device: ui.device.value, rotated: false }));
ui.rotate.addEventListener('click', () => {
  const settings = state ? state.settings : null;
  if (!settings) return;
  if (settings.device !== 'responsive') apply({ rotated: !settings.rotated });
  else apply({ width: settings.height, height: settings.width });
});
for (const input of [ui.width, ui.height]) {
  input.addEventListener('change', () => apply({ device: 'responsive', width: ui.width.value, height: ui.height.value }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
}
ui.mobile.addEventListener('change', () => apply({ mobile: ui.mobile.value === '1' }));
ui.dpr.addEventListener('change', () => apply({ deviceScaleFactor: Number(ui.dpr.value) }));
ui.zoom.addEventListener('change', () => apply({ zoom: ui.zoom.value === 'fit' ? 'fit' : Number(ui.zoom.value) }));

async function refresh() {
  render(await send({ op: 'get' }));
}

// L'échelle « ajustée » suit la taille de la fenêtre : relue tant que le panneau est visible.
setInterval(() => {
  if (document.visibilityState === 'visible') void refresh();
}, 1500);
void refresh();
