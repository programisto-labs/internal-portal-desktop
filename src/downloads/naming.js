'use strict';

const path = require('path');

const MAX_NAME_LENGTH = 200;
const FALLBACK_NAME = 'telechargement';

/**
 * File name proposed by the site, made safe for any OS: no directory part, no control or
 * reserved characters, no leading dots (hidden file) and a bounded length.
 */
function sanitizeFilename(raw) {
  let name = String(raw || '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (!name) name = FALLBACK_NAME;
  if (name.length > MAX_NAME_LENGTH) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return name;
}

/** "rapport.csv" → ["rapport", ".csv"]; "archive.tar.gz" → ["archive", ".tar.gz"]. */
function splitName(name) {
  const lower = name.toLowerCase();
  for (const double of ['.tar.gz', '.tar.bz2', '.tar.xz']) {
    if (lower.endsWith(double) && name.length > double.length) {
      return [name.slice(0, -double.length), name.slice(-double.length)];
    }
  }
  const ext = path.extname(name);
  return ext && ext !== name ? [name.slice(0, -ext.length), ext] : [name, ''];
}

/**
 * First free path for `name` in `dir`, like Chrome: "rapport.csv", "rapport (1).csv"…
 * `isTaken(fullPath)` covers existing files and downloads still being written.
 */
function uniqueSavePath(dir, name, isTaken) {
  const [base, ext] = splitName(name);
  for (let i = 0; i < 10000; i += 1) {
    const candidate = path.join(dir, i === 0 ? `${base}${ext}` : `${base} (${i})${ext}`);
    if (!isTaken(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

module.exports = { sanitizeFilename, uniqueSavePath, splitName };
