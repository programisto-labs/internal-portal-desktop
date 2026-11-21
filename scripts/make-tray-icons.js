'use strict';
/**
 * Windows / Linux (zone de notification, barre système) : la flamme en couleur, 16 px (+ @2x 32 px),
 * fichiers `tray.png` / `trayDot.png` ; le point est rouge, cerclé de blanc pour rester visible
 * sur une barre claire ou sombre.
 *
 * Icône de la barre des menus (macOS) : silhouette de la flamme de l'app (icône du Dock) en image « template »
 * (noir + alpha ; macOS la teinte selon le thème). Le cœur jaune de la flamme est évidé pour
 * rester lisible à 18 pt. Variante « Dot » : point en haut à droite (quelque chose attend).
 * Source : build/icon-source.png (même flamme que l'icône de l'app). Sortie : build/tray/*.png (1x et @2x).
 */
const path = require('path');
const sharp = require('sharp');

const SRC = path.join(__dirname, '..', 'build', 'icon-source.png');
const OUT = path.join(__dirname, '..', 'build', 'tray');
const HEIGHT = 18; // points
const WIDTH = 18;

async function silhouette() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    const core = r > 220 && g > 200 && b < 160; // jaune du cœur de la flamme
    out[i * 4 + 3] = a > 96 && !core ? 255 : 0;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().trim().toBuffer();
}

async function render(base, scale, dot) {
  const h = HEIGHT * scale;
  const w = WIDTH * scale;
  const glyph = await sharp(base)
    .resize({ height: h - 2 * scale, width: w - 2 * scale, fit: 'inside', kernel: 'nearest' })
    .toBuffer();
  const meta = await sharp(glyph).metadata();
  const layers = [
    { input: glyph, left: Math.round((w - meta.width) / 2) - (dot ? scale : 0), top: Math.round((h - meta.height) / 2) },
  ];
  if (dot) {
    const d = 4 * scale;
    const svg = Buffer.from(
      `<svg width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#000"/></svg>`,
    );
    layers.push({ input: svg, left: w - d, top: 0 });
  }
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
}

const COLOR_SIZE = 16; // pixels à 100 % (Windows), Linux prend le @2x

async function renderColor(scale, dot) {
  const size = COLOR_SIZE * scale;
  const glyph = await sharp(SRC)
    .trim()
    .resize({ height: size, width: size, fit: 'inside', kernel: 'nearest' })
    .toBuffer();
  const meta = await sharp(glyph).metadata();
  const layers = [{ input: glyph, left: Math.round((size - meta.width) / 2), top: Math.round((size - meta.height) / 2) }];
  if (dot) {
    const d = 7 * scale;
    const svg = Buffer.from(
      `<svg width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2 - scale / 2}" fill="#e5484d" stroke="#fff" stroke-width="${scale}"/></svg>`,
    );
    layers.push({ input: svg, left: size - d, top: 0 });
  }
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
}

(async () => {
  for (const [name, dot] of [['tray', false], ['trayDot', true]]) {
    for (const scale of [1, 2]) {
      const file = path.join(OUT, `${name}${scale === 2 ? '@2x' : ''}.png`);
      await sharp(await renderColor(scale, dot)).toFile(file);
      console.log('wrote', path.relative(process.cwd(), file));
    }
  }
  const base = await silhouette();
  for (const [name, dot] of [['trayTemplate', false], ['trayDotTemplate', true]]) {
    for (const scale of [1, 2]) {
      const file = path.join(OUT, `${name}${scale === 2 ? '@2x' : ''}.png`);
      await sharp(await render(base, scale, dot)).toFile(file);
      console.log('wrote', path.relative(process.cwd(), file));
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
