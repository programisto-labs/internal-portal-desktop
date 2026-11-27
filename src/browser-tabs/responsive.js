'use strict';

/**
 * Mode « Responsive » des onglets web (docs/devtools-responsive.md) : la page s'affiche à la
 * taille d'un appareil, centrée sur un fond gris, comme le mode appareil de Chrome.
 *
 * Electron n'a pas le mode appareil de Chrome (⌘⇧M) : le panneau « Responsive » des DevTools
 * (extension `devtools-extension/`) envoie ses réglages, que ce module valide et traduit en
 * commandes du protocole DevTools (`Emulation.*`, gardées d'une navigation à l'autre).
 */

const MIN_SIZE = 50;
const MAX_SIZE = 4000;
/**
 * Appareils, densités et zooms : `devtools-extension/devices.json`, lu aussi par le panneau
 * (une seule liste). `ua` : identité de navigateur annoncée (null = celle de Lasco, Chrome de bureau).
 */
const CATALOG = require('./devtools-extension/devices.json');
const DEVICE_SCALE_FACTORS = Object.freeze([...CATALOG.deviceScaleFactors]);
const ZOOMS = Object.freeze([...CATALOG.zooms]);
/** Marge entre l'appareil et le bord de la zone de l'onglet (px). */
const FRAME_PADDING = 16;
const DEVICES = Object.freeze(CATALOG.devices.map((device) => Object.freeze({ ...device })));
const DEFAULT_SETTINGS = Object.freeze({ ...CATALOG.defaults });

function clampSize(value, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
}

function nearest(list, value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return list.reduce((best, item) => (Math.abs(item - n) < Math.abs(best - n) ? item : best), list[0]);
}

/**
 * Réglages reçus du panneau (donnée non fiable) → réglages sûrs. Un appareil connu impose
 * son écran, sa densité et son type ; « responsive » garde les valeurs saisies.
 * La rotation se fait en échangeant largeur et hauteur (`rotated`).
 */
function normalizeResponsiveSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const device = DEVICES.find((d) => d.id === raw.device) || null;
  const zoom = raw.zoom === 'fit' || raw.zoom === undefined ? 'fit' : nearest(ZOOMS, raw.zoom, 1);
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
  return {
    device: 'responsive',
    width: clampSize(raw.width, DEFAULT_SETTINGS.width),
    height: clampSize(raw.height, DEFAULT_SETTINGS.height),
    deviceScaleFactor: nearest(DEVICE_SCALE_FACTORS, raw.deviceScaleFactor, DEFAULT_SETTINGS.deviceScaleFactor),
    mobile: raw.mobile === undefined ? DEFAULT_SETTINGS.mobile : Boolean(raw.mobile),
    rotated: false,
    zoom,
  };
}

/**
 * Place de l'appareil dans la zone de l'onglet : centré, réduit pour tenir en entier.
 * Un zoom choisi plus grand que la place disponible est ramené à « ajusté » : la page ne
 * déborde jamais sur la barre d'adresse ni sur la colonne Lasco AI.
 */
function responsiveLayout(area, settings) {
  const availableWidth = Math.max(1, area.width - FRAME_PADDING * 2);
  const availableHeight = Math.max(1, area.height - FRAME_PADDING * 2);
  const fit = Math.min(1, availableWidth / settings.width, availableHeight / settings.height);
  const wanted = settings.zoom === 'fit' ? 1 : settings.zoom;
  const scale = Math.max(0.05, Math.min(wanted, fit));
  const width = Math.max(1, Math.round(settings.width * scale));
  const height = Math.max(1, Math.round(settings.height * scale));
  return {
    scale,
    bounds: {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + Math.max(FRAME_PADDING, (area.height - height) / 2)),
      width,
      height,
    },
  };
}

function iosVersion() {
  return '18_5';
}

/**
 * Identité annoncée par l'appareil : `null` garde celle de Lasco (Chrome de bureau).
 * iPhone / iPad : Safari (pas de `userAgentData`) ; Android : Chrome mobile.
 */
function deviceUserAgent(deviceId, chromeVersion = process.versions.chrome) {
  const device = DEVICES.find((d) => d.id === deviceId);
  if (!device || !device.ua) return null;
  const ios = iosVersion();
  const safari = `AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ios.replace('_', '.')} Mobile/15E148 Safari/604.1`;
  if (device.ua === 'iphone') {
    return { userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS ${ios} like Mac OS X) ${safari}`, platform: 'iPhone' };
  }
  if (device.ua === 'ipad') {
    return { userAgent: `Mozilla/5.0 (iPad; CPU OS ${ios} like Mac OS X) ${safari}`, platform: 'iPad' };
  }
  const full = String(chromeVersion || '0.0.0.0');
  const major = full.split('.')[0] || '0';
  const brands = [
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
    { brand: 'Not?A_Brand', version: '24' },
  ];
  return {
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    platform: 'Linux armv81',
    userAgentMetadata: {
      brands,
      fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === 'Not?A_Brand' ? '24.0.0.0' : full })),
      fullVersion: full,
      platform: 'Android',
      platformVersion: '14.0.0',
      architecture: '',
      model: device.name,
      mobile: true,
      bitness: '',
      wow64: false,
    },
  };
}

/** Paramètres de `Emulation.setDeviceMetricsOverride` pour ces réglages et cette échelle. */
function deviceMetrics(settings, scale) {
  return {
    width: settings.width,
    height: settings.height,
    deviceScaleFactor: settings.deviceScaleFactor,
    mobile: settings.mobile,
    scale,
    // Comme les DevTools de Chrome : la vue a déjà la bonne taille. Sans ce drapeau, la taille
    // visible reste figée sur l'appareil après `clearDeviceMetricsOverride`.
    dontSetVisibleSize: true,
    screenWidth: settings.width,
    screenHeight: settings.height,
    screenOrientation: settings.width > settings.height
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 },
  };
}

module.exports = {
  DEVICES,
  DEVICE_SCALE_FACTORS,
  ZOOMS,
  DEFAULT_SETTINGS,
  FRAME_PADDING,
  normalizeResponsiveSettings,
  responsiveLayout,
  deviceUserAgent,
  deviceMetrics,
};
