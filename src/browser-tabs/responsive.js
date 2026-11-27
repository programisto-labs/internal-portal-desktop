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
const DEVICE_SCALE_FACTORS = [1, 1.5, 2, 2.625, 3];
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
/** Marge entre l'appareil et le bord de la zone de l'onglet (px). */
const FRAME_PADDING = 16;

/** `ua` : identité de navigateur annoncée par l'appareil (null = celle de Lasco, Chrome de bureau). */
const DEVICES = Object.freeze([
  { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667, deviceScaleFactor: 2, mobile: true, ua: 'iphone' },
  { id: 'iphone-15-pro', name: 'iPhone 15 Pro', width: 393, height: 852, deviceScaleFactor: 3, mobile: true, ua: 'iphone' },
  { id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', width: 430, height: 932, deviceScaleFactor: 3, mobile: true, ua: 'iphone' },
  { id: 'pixel-8', name: 'Pixel 8', width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, ua: 'android' },
  { id: 'galaxy-s24', name: 'Galaxy S24', width: 360, height: 780, deviceScaleFactor: 3, mobile: true, ua: 'android' },
  { id: 'ipad-mini', name: 'iPad Mini', width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, ua: 'ipad' },
  { id: 'ipad-pro-13', name: 'iPad Pro 13"', width: 1032, height: 1376, deviceScaleFactor: 2, mobile: true, ua: 'ipad' },
  { id: 'laptop', name: 'Laptop', width: 1280, height: 800, deviceScaleFactor: 2, mobile: false, ua: null },
  { id: 'desktop-hd', name: 'Desktop HD', width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, ua: null },
]);

const DEFAULT_SETTINGS = Object.freeze({
  device: 'responsive',
  width: 400,
  height: 800,
  deviceScaleFactor: 2,
  mobile: true,
  zoom: 'fit',
});

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
    screenWidth: settings.width,
    screenHeight: settings.height,
    screenOrientation: settings.width > settings.height
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 },
  };
}

/** Liste envoyée au panneau (pas de chaîne d'identité). */
function publicDevices() {
  return DEVICES.map(({ id, name, width, height, deviceScaleFactor, mobile }) => ({
    id,
    name,
    width,
    height,
    deviceScaleFactor,
    mobile,
  }));
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
  publicDevices,
};
