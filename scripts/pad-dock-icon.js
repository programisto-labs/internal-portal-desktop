#!/usr/bin/env node
/**
 * Scale artwork down and center on a square canvas so the macOS Dock / toolbar
 * icon matches Apple's visual weight (torch no longer fills the whole tile).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-source.png');
const OUT = path.join(ROOT, 'build', 'icon.png');
/** Fraction of canvas used by the logo (rest is margin). ~0.66 ≈ 17% inset per side. */
const DRAW_RATIO = 0.66;
const CANVAS = 1024;

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Missing build/icon-source.png — copy lasco-favicon.png from the frontend repo.');
    process.exit(1);
  }

  const targetMax = Math.round(CANVAS * DRAW_RATIO);
  const resized = await sharp(SRC)
    .resize(targetMax, targetMax, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();

  const meta = await sharp(resized).metadata();
  const w = meta.width;
  const h = meta.height;
  const left = Math.round((CANVAS - w) / 2);
  const top = Math.round((CANVAS - h) / 2);

  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, left, top }])
    .png()
    .toFile(OUT);

  console.log(`Wrote ${path.relative(ROOT, OUT)} (${DRAW_RATIO * 100}% max side, ${CANVAS}px canvas)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
