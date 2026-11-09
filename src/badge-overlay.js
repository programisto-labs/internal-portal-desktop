'use strict';

const zlib = require('zlib');

const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function pngFromRgba(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function normalizeBadgeCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 9999);
}

function badgeLabel(count) {
  const n = normalizeBadgeCount(count);
  if (n <= 0) return '';
  return n >= 100 ? '99+' : String(n);
}

function renderBadgeRgba(count, size = 32) {
  const label = badgeLabel(count);
  const rgba = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size / 2 - 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      if (dx * dx + dy * dy > radius * radius) continue;
      const index = (y * size + x) * 4;
      rgba[index] = 220;
      rgba[index + 1] = 38;
      rgba[index + 2] = 38;
      rgba[index + 3] = 255;
    }
  }
  if (!label) return rgba;
  const glyphW = 5;
  const glyphH = 7;
  const gap = 1;
  const textW = label.length * glyphW + (label.length - 1) * gap;
  const scale = textW * 2 <= size - 8 ? 2 : 1;
  const originX = Math.floor((size - textW * scale) / 2);
  const originY = Math.floor((size - glyphH * scale) / 2);
  for (let charIndex = 0; charIndex < label.length; charIndex += 1) {
    const glyph = FONT[label[charIndex]];
    if (!glyph) continue;
    const glyphX = originX + charIndex * (glyphW + gap) * scale;
    for (let gy = 0; gy < glyphH; gy += 1) {
      for (let gx = 0; gx < glyphW; gx += 1) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const x = glyphX + gx * scale + sx;
            const y = originY + gy * scale + sy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const index = (y * size + x) * 4;
            rgba[index] = 255;
            rgba[index + 1] = 255;
            rgba[index + 2] = 255;
            rgba[index + 3] = 255;
          }
        }
      }
    }
  }
  return rgba;
}

function renderBadgePng(count) {
  return pngFromRgba(32, 32, renderBadgeRgba(count, 32));
}

module.exports = {
  badgeLabel,
  normalizeBadgeCount,
  renderBadgePng,
  renderBadgeRgba,
};
