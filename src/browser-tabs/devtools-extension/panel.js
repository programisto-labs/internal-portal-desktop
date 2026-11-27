'use strict';

/*
 * Panneau « Responsive » des DevTools d'un onglet web (docs/devtools-responsive.md).
 * Il n'émule rien lui-même : il garde ses réglages et les envoie à Lasco Desktop, dans un seul
 * sens, par un message de console que Desktop ne lit que dans le cadre de cette extension.
 * Desktop redimensionne l'onglet et règle l'émulation. Rien ne tourne en tâche de fond.
 */

const MESSAGE_PREFIX = '__lasco_responsive__';

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
    statusOn: '{w} × {h} · DPR {dpr}',
    statusOff: 'Désactivé : la page occupe tout l’onglet.',
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
    statusOn: '{w} × {h} · DPR {dpr}',
    statusOff: 'Off: the page fills the whole tab.',
    hint: 'The setting lasts until DevTools close. Network throttling stays in the Network panel.',
  },
};

const lang = String(navigator.language || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';
const text = (key, params) =>
  String(STRINGS[lang][key] || STRINGS.fr[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''));

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

if (chrome.devtools.panels.themeName === 'dark') document.documentElement.classList.add('dark');
for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = text(node.dataset.i18n);
ui.rotate.title = text('rotate');
ui.rotate.setAttribute('aria-label', text('rotate'));
ui.width.setAttribute('aria-label', text('width'));
ui.height.setAttribute('aria-label', text('height'));

/** Même règle que Desktop (`responsive.js`), qui revalide de son côté. */
function normalize(catalog, raw) {
  const device = catalog.devices.find((d) => d.id === raw.device);
  const zoom = raw.zoom === 'fit' ? 'fit' : Number(raw.zoom) || 1;
  if (device) {
    const rotated = Boolean(raw.rotated);
    return {
      device: device.id,
      width: rotated ? device.height : device.width,
      height: rotated ? device.width : device.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.mobile,
      rotated,
      zoom,
    };
  }
  const size = (value, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(4000, Math.max(50, n)) : fallback;
  };
  return {
    device: 'responsive',
    width: size(raw.width, catalog.defaults.width),
    height: size(raw.height, catalog.defaults.height),
    deviceScaleFactor: Number(raw.deviceScaleFactor) || catalog.defaults.deviceScaleFactor,
    mobile: Boolean(raw.mobile),
    rotated: false,
    zoom,
  };
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = String(value);
  node.textContent = label;
  return node;
}

function start(catalog) {
  // Fermer les DevTools coupe le mode : chaque panneau commence désactivé.
  let active = false;
  let settings = normalize(catalog, catalog.defaults);

  ui.device.append(option('responsive', text('responsive')));
  for (const device of catalog.devices) {
    ui.device.append(option(device.id, `${device.name} · ${device.width} × ${device.height}`));
  }
  for (const dpr of catalog.deviceScaleFactors) ui.dpr.append(option(dpr, String(dpr)));
  ui.zoom.append(option('fit', text('fit')));
  for (const zoom of catalog.zooms) ui.zoom.append(option(zoom, `${Math.round(zoom * 100)} %`));

  const send = (message) => console.debug(MESSAGE_PREFIX + JSON.stringify(message));

  function render() {
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
    ui.status.textContent = active
      ? text('statusOn', { w: settings.width, h: settings.height, dpr: settings.deviceScaleFactor })
      : text('statusOff');
  }

  /** Toute modification active le mode, comme la barre d'appareil de Chrome. */
  function apply(patch) {
    settings = normalize(catalog, { ...settings, ...patch });
    active = true;
    send({ op: 'set', settings });
    render();
  }

  ui.toggle.addEventListener('click', () => {
    if (!active) return apply({});
    active = false;
    send({ op: 'off' });
    render();
  });
  ui.device.addEventListener('change', () => apply({ device: ui.device.value, rotated: false }));
  ui.rotate.addEventListener('click', () => {
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

  render();
}

fetch('devices.json')
  .then((response) => response.json())
  .then(start)
  .catch(() => {
    ui.status.textContent = '';
  });
