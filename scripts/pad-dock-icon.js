#!/usr/bin/env node
/**
 * Build Dock / taskbar icon: flame on a black macOS squircle, inset in the
 * canvas. Native Dock icons leave transparent gutter around the tile; a
 * edge-to-edge squircle (via Electron dock.setIcon) reads much larger than
 * Cursor. We bake both the mask and that outer margin.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-source.png');
const OUT = path.join(ROOT, 'build', 'icon.png');
/**
 * Tile size vs full canvas. ~0.80 matches Apple's macOS icon grid gutter so the
 * black plate sits at the same optical size as Cursor / system apps in the Dock.
 */
const TILE_RATIO = 0.8;
/** Flame size vs the black tile (not the full canvas). */
const DRAW_RATIO = 0.7;
const CANVAS = 1024;
/** ~22.37% — Apple Big Sur / Ventura app-icon continuous-corner approximation. */
const CORNER_RATIO = 0.2237;
const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

function squircleMaskSvg(size) {
  const r = Math.round(size * CORNER_RATIO);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/>` +
      `</svg>`
  );
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Missing build/icon-source.png — copy lasco-favicon.png from the frontend repo.');
    process.exit(1);
  }

  const tile = Math.round(CANVAS * TILE_RATIO);
  const targetMax = Math.round(tile * DRAW_RATIO);
  const resized = await sharp(SRC)
    .ensureAlpha()
    .resize(targetMax, targetMax, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();

  const meta = await sharp(resized).metadata();
  const left = Math.round((tile - meta.width) / 2);
  const top = Math.round((tile - meta.height) / 2);

  const plate = await sharp({
    create: {
      width: tile,
      height: tile,
      channels: 4,
      background: BLACK,
    },
  })
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer();

  const masked = await sharp(plate)
    .composite([{ input: squircleMaskSvg(tile), blend: 'dest-in' }])
    .png()
    .toBuffer();

  const inset = Math.round((CANVAS - tile) / 2);
  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: CLEAR,
    },
  })
    .composite([{ input: masked, left: inset, top: inset }])
    .png()
    .toFile(OUT);

  console.log(
    `Wrote ${path.relative(ROOT, OUT)} (tile ${Math.round(TILE_RATIO * 100)}% of canvas, flame ${Math.round(DRAW_RATIO * 100)}% of tile)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
