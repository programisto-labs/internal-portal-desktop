'use strict';

/**
 * Nombre dessiné sur la flamme de la zone de notification (Windows) et de la barre système (Linux),
 * où l'on ne peut pas écrire de texte à côté de l'icône (`setTitle` est propre à macOS).
 * Pastille rouge cerclée de blanc en haut à droite, chiffres blancs (police 5 × 7 du badge
 * de la barre des tâches). Pas de dépendance à Electron : testé seul.
 */
const { FONT } = require('../badge-overlay');

const GLYPH_W = 5;
const GLYPH_H = 7;
const RED = [229, 72, 77];
const WHITE = [255, 255, 255];

/**
 * Texte de la pastille selon la taille de l'image : 16 px n'a la place que d'un chiffre
 * (« + » au-delà de 9) ; 32 px en prend deux (« + » au-delà de 99). L'info-bulle donne le nombre exact.
 */
function trayBadgeText(count, scale = 1) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0) return '';
  const max = scale >= 2 ? 99 : 9;
  return n > max ? '+' : String(n);
}

/**
 * Dessine la pastille dans une image brute (modifiée en place).
 * @param {Buffer} pixels image `width` × `height`, 4 octets par pixel
 * @param {{ width: number, height: number, text: string, scale?: number, order?: 'rgba' | 'bgra' }} options
 *   `order` : ordre des canaux (`nativeImage.toBitmap()` rend du BGRA sous Windows et Linux).
 */
function drawTrayBadge(pixels, { width, height, text, scale = 1, order = 'rgba' }) {
  if (!text) return pixels;
  const s = Math.max(1, Math.floor(scale));
  const gap = s;
  const textW = text.length * GLYPH_W * s + (text.length - 1) * gap;
  const textH = GLYPH_H * s;
  const pad = s; // marge rouge autour des chiffres
  const border = s; // liseré blanc, lisible sur barre claire ou sombre
  const pillH = Math.min(height, textH + 2 * (pad + border));
  const pillW = Math.min(width, Math.max(pillH, textW + 2 * (pad + border)));
  const left = width - pillW;
  const top = 0;
  const radius = pillH / 2;

  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    const [r, g, b] = rgb;
    pixels[i] = order === 'bgra' ? b : r;
    pixels[i + 1] = g;
    pixels[i + 2] = order === 'bgra' ? r : b;
    pixels[i + 3] = 255;
  };
  // Distance au segment central de la pilule (rectangle aux bouts arrondis).
  const distance = (px, py) => {
    const cy = top + radius;
    const x1 = left + radius;
    const x2 = left + pillW - radius;
    const cx = Math.max(x1, Math.min(px, x2));
    return Math.hypot(px - cx, py - cy);
  };

  for (let y = top; y < top + pillH; y += 1) {
    for (let x = left; x < left + pillW; x += 1) {
      const d = distance(x + 0.5, y + 0.5);
      if (d > radius) continue;
      put(x, y, d > radius - border ? WHITE : RED);
    }
  }

  const originX = left + Math.round((pillW - textW) / 2);
  const originY = top + Math.round((pillH - textH) / 2);
  for (let c = 0; c < text.length; c += 1) {
    const glyph = FONT[text[c]];
    if (!glyph) continue;
    const gx0 = originX + c * (GLYPH_W * s + gap);
    for (let gy = 0; gy < GLYPH_H; gy += 1) {
      for (let gx = 0; gx < GLYPH_W; gx += 1) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < s; sy += 1) {
          for (let sx = 0; sx < s; sx += 1) put(gx0 + gx * s + sx, originY + gy * s + sy, WHITE);
        }
      }
    }
  }
  return pixels;
}

module.exports = { trayBadgeText, drawTrayBadge };
