'use strict';

/**
 * « Enregistrer en PDF » d'un onglet web (docs/zoom-and-pdf.md) : nom du fichier, comme
 * Chrome (titre de la page, sinon hôte), le rendu restant `webContents.printToPDF`.
 */

const { sanitizeFilename } = require('../downloads/naming');

const MAX_TITLE_LENGTH = 120;

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/** « Titre de la page.pdf » ; « / » et « : » remplacés (pas de sous-dossier) ; hôte, puis « page » à défaut. */
function pdfFilename({ url, title } = {}) {
  // Page sans titre : Chromium renvoie l'adresse comme titre.
  const rawTitle = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(title || '').trim()) ? '' : String(title || '');
  const cleanTitle = rawTitle
    .replace(/[\\/:]+/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
  const base = cleanTitle || hostOf(url) || 'page';
  return sanitizeFilename(`${base}.pdf`);
}

module.exports = { pdfFilename };
