'use strict';

/**
 * Capture d'écran des onglets web (docs/page-capture.md) : page entière sans défiler
 * visiblement (protocole DevTools, `captureBeyondViewport`), ou partie visible (`capturePage`).
 *
 * Le découpage, l'assemblage et le nommage sont purs (testés par scripts/test-page-capture.js) ;
 * Electron (`webContents`, `nativeImage`) est injecté.
 */

const { sanitizeFilename } = require('../downloads/naming');

/** Hauteur d'un morceau en pixels de l'écran : sous la taille de texture GPU (16 384 en général). */
const MAX_TILE_DEVICE_PX = 8192;
/** Pixels de l'image finale au plus (~400 Mo en BGRA pendant l'assemblage). */
const MAX_TOTAL_DEVICE_PIXELS = 100_000_000;
/** En dessous, l'image serait illisible : on coupe la page plutôt que de réduire encore. */
const MIN_SCALE = 0.5;
/** Largeur CSS au plus (page qui déborde à l'horizontale sans fin). */
const MAX_CSS_WIDTH = 8192;
const DEBUGGER_PROTOCOL = '1.3';

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Plan de capture de la page entière, en pixels CSS.
 * `scale` (≤ 1) réduit une très grande page pour tenir dans `maxTotalDevicePixels` ;
 * au-delà de `minScale`, la hauteur est coupée (`truncated`).
 * Chaque morceau fait au plus `maxTileDevicePx` pixels d'écran de haut.
 */
function planFullPageCapture({
  contentWidth,
  contentHeight,
  viewportWidth = 0,
  deviceScaleFactor = 1,
  maxTileDevicePx = MAX_TILE_DEVICE_PX,
  maxTotalDevicePixels = MAX_TOTAL_DEVICE_PIXELS,
  minScale = MIN_SCALE,
  maxCssWidth = MAX_CSS_WIDTH,
} = {}) {
  const dsf = positive(deviceScaleFactor, 1);
  const width = Math.min(maxCssWidth, Math.max(1, Math.ceil(Math.max(positive(contentWidth, 1), positive(viewportWidth, 0)))));
  let height = Math.max(1, Math.ceil(positive(contentHeight, 1)));
  let scale = Math.min(1, Math.sqrt(maxTotalDevicePixels / (width * height * dsf * dsf)));
  let truncated = false;
  if (scale < minScale) {
    scale = minScale;
    const maxHeight = Math.floor(maxTotalDevicePixels / (width * dsf * dsf * scale * scale));
    if (maxHeight < height) {
      height = Math.max(1, maxHeight);
      truncated = true;
    }
  }
  const tileHeight = Math.max(1, Math.floor(maxTileDevicePx / (dsf * scale)));
  const tiles = [];
  for (let y = 0; y < height; y += tileHeight) {
    tiles.push({ x: 0, y, width, height: Math.min(tileHeight, height - y) });
  }
  return { width, height, scale, tiles, truncated };
}

/**
 * Empile des morceaux BGRA (`{ bitmap, width, height }`) de haut en bas. Largeurs différentes
 * (arrondis) : la plus petite est gardée.
 */
function stitchBitmaps(parts) {
  const list = (parts || []).filter((p) => p && p.width > 0 && p.height > 0 && p.bitmap);
  if (!list.length) return null;
  const width = Math.min(...list.map((p) => p.width));
  const height = list.reduce((sum, p) => sum + p.height, 0);
  const rowBytes = width * 4;
  const out = Buffer.alloc(rowBytes * height);
  let offset = 0;
  for (const part of list) {
    const srcRow = part.width * 4;
    if (srcRow === rowBytes) {
      part.bitmap.copy(out, offset, 0, rowBytes * part.height);
      offset += rowBytes * part.height;
      continue;
    }
    for (let row = 0; row < part.height; row += 1) {
      part.bitmap.copy(out, offset, row * srcRow, row * srcRow + rowBytes);
      offset += rowBytes;
    }
  }
  return { bitmap: out, width, height };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** « lemonde.fr », sinon le titre, sinon « page ». */
function captureSiteLabel({ url, title } = {}) {
  try {
    const parsed = new URL(String(url || ''));
    if (/^https?:$/.test(parsed.protocol) && parsed.hostname) return parsed.hostname.replace(/^www\./i, '');
  } catch (_) {
    // Adresse illisible : titre.
  }
  // « / » couperait le nom (sanitizeFilename ne garde que la fin d'un chemin).
  const fromTitle = String(title || '')
    .replace(/[\\/:]+/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return fromTitle || 'page';
}

/** « Capture lemonde.fr 2026-11-27 14.05.32.png » (sans « : », refusé par Windows et le Finder). */
function captureFilename({ url, title, date = new Date() } = {}) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(
    d.getMinutes(),
  )}.${pad(d.getSeconds())}`;
  return sanitizeFilename(`Capture ${captureSiteLabel({ url, title })} ${stamp}.png`);
}

/** Partie visible : `capturePage` (même rendu que l'écran). */
async function captureVisible(webContents, rect) {
  const image = rect
    ? await webContents.capturePage(rect, { stayHidden: true })
    : await webContents.capturePage(undefined, { stayHidden: true });
  if (!image || image.isEmpty()) return { ok: false, error: 'empty-capture' };
  const size = image.getSize();
  return { ok: true, png: image.toPNG(), width: size.width, height: size.height, mode: 'visible', truncated: false };
}

/**
 * Page entière par le protocole DevTools, sans défiler la page. Le débogueur est détaché
 * ensuite, seulement s'il a été attaché ici (un autre client garde le sien ; les DevTools
 * ouverts n'utilisent pas `webContents.debugger` et ne sont pas gênés).
 */
async function captureFullPage(webContents, { nativeImage, limits = {} } = {}) {
  const dbg = webContents.debugger;
  let attachedHere = false;
  if (!dbg.isAttached()) {
    dbg.attach(DEBUGGER_PROTOCOL);
    attachedHere = true;
  }
  try {
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
    const content = metrics.cssContentSize || metrics.contentSize || {};
    const viewport = metrics.cssLayoutViewport || metrics.layoutViewport || {};
    let dsf = 1;
    try {
      const evaluated = await dbg.sendCommand('Runtime.evaluate', {
        expression: 'window.devicePixelRatio',
        returnByValue: true,
      });
      dsf = positive(evaluated && evaluated.result && evaluated.result.value, 1);
    } catch (_) {
      // Ratio inconnu : 1 (le découpage reste prudent).
    }
    const plan = planFullPageCapture({
      contentWidth: content.width,
      contentHeight: content.height,
      viewportWidth: viewport.clientWidth,
      deviceScaleFactor: dsf,
      ...limits,
    });
    const parts = [];
    for (const tile of plan.tiles) {
      const shot = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { ...tile, scale: plan.scale },
      });
      const png = Buffer.from(shot.data, 'base64');
      if (plan.tiles.length === 1) {
        const size = nativeImage.createFromBuffer(png).getSize();
        return { ok: true, png, width: size.width, height: size.height, mode: 'full', truncated: plan.truncated };
      }
      const image = nativeImage.createFromBuffer(png);
      const size = image.getSize();
      parts.push({ bitmap: image.toBitmap(), width: size.width, height: size.height });
    }
    const stitched = stitchBitmaps(parts);
    if (!stitched) return { ok: false, error: 'empty-capture' };
    const image = nativeImage.createFromBitmap(stitched.bitmap, { width: stitched.width, height: stitched.height });
    return {
      ok: true,
      png: image.toPNG(),
      width: stitched.width,
      height: stitched.height,
      mode: 'full',
      truncated: plan.truncated,
    };
  } finally {
    if (attachedHere) {
      try {
        dbg.detach();
      } catch (_) {
        // Déjà détaché (page fermée pendant la capture).
      }
    }
  }
}

/**
 * Capture d'un onglet web. Page entière impossible (page plantée, protocole refusé) :
 * partie visible, `fallback: true`.
 */
async function capturePageImage(webContents, { mode = 'full', nativeImage, limits } = {}) {
  if (mode === 'visible') return captureVisible(webContents);
  try {
    return await captureFullPage(webContents, { nativeImage, limits });
  } catch (_) {
    const visible = await captureVisible(webContents);
    return visible.ok ? { ...visible, fallback: true } : visible;
  }
}

module.exports = {
  planFullPageCapture,
  stitchBitmaps,
  captureFilename,
  captureSiteLabel,
  captureVisible,
  captureFullPage,
  capturePageImage,
  MAX_TILE_DEVICE_PX,
  MAX_TOTAL_DEVICE_PIXELS,
};
