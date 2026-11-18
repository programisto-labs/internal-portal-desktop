'use strict';

/**
 * Historique local des exécutions de harnais (carte « sous-agent » du chat) : survit au redémarrage de
 * Lasco Desktop. Fichier dans le dossier de données de l'app, lisible par l'utilisateur seul ; écriture
 * atomique (fichier temporaire puis renommage). Aucun identifiant de connexion n'y est jamais écrit.
 */

const fs = require('fs');
const path = require('path');

const MAX_RUNS = 40;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function createRunHistory(file, { now = Date.now } = {}) {
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data?.runs) ? data.runs.filter((r) => r && typeof r.runId === 'string') : [];
    } catch {
      return [];
    }
  }

  function save(runs) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // historique indisponible : la carte vit le temps de la session
    }
  }

  return { load, save, now };
}

/** Pur : exécutions à garder (les plus récentes, 7 jours au plus). */
function pruneRuns(runs, now = Date.now()) {
  return runs
    .filter((r) => now - (r.startedAt + (r.result?.durationMs ?? 0)) < MAX_AGE_MS)
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-MAX_RUNS);
}

module.exports = { createRunHistory, pruneRuns, MAX_RUNS, MAX_AGE_MS };
