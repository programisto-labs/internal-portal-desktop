#!/usr/bin/env node
'use strict';

/**
 * Electron est-il à jour de ses correctifs de sécurité ? (docs/security.md, « Electron et Chromium »)
 *
 *   node scripts/check-electron-freshness.js            → code 1 si en retard sur la politique
 *   node scripts/check-electron-freshness.js --markdown → rapport Markdown (issue GitHub)
 *   node scripts/check-electron-freshness.js --report   → affiche seulement, code 0 (CI des PR)
 *
 * Politique : chaque version de correctif d'Electron embarque les correctifs de sécurité de Chromium.
 * Une version de correctif de la ligne installée publiée depuis plus de PATCH_GRACE_DAYS jours, ou une
 * ligne qu'Electron ne maintient plus (seules les 3 dernières le sont), est un retard.
 */

const fs = require('fs');
const path = require('path');

const RELEASES_URL = 'https://releases.electronjs.org/releases.json';
const CHROME_STABLE_URL = 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1';
const PATCH_GRACE_DAYS = 3;
const SUPPORTED_MAJORS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ''));
  return m ? m.slice(1).map(Number) : null;
}

function cmp(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * @param {{ installed: string, releases: Array<{ version: string, date: string, chrome?: string }>, now: number }} input
 */
function assessElectron({ installed, releases, now }) {
  const stable = releases.filter((r) => parseVersion(r.version));
  const majors = [...new Set(stable.map((r) => parseVersion(r.version)[0]))].sort((a, b) => b - a);
  const supported = majors.slice(0, SUPPORTED_MAJORS);
  const major = parseVersion(installed) ? parseVersion(installed)[0] : null;
  const current = stable.find((r) => r.version === installed) || null;
  const line = stable.filter((r) => parseVersion(r.version)[0] === major).sort((a, b) => cmp(b.version, a.version));
  const latestPatch = line[0] || null;
  const newest = stable.filter((r) => parseVersion(r.version)[0] === majors[0]).sort((a, b) => cmp(b.version, a.version))[0] || null;
  const missed = line.filter((r) => cmp(r.version, installed) > 0);
  const oldestMissed = missed.length ? missed[missed.length - 1] : null;
  const overdueDays = oldestMissed ? Math.floor((now - Date.parse(oldestMissed.date)) / DAY_MS) : 0;
  const problems = [];
  if (major === null) problems.push(`version installée illisible (${installed})`);
  else if (!supported.includes(major)) problems.push(`Electron ${major} n'est plus maintenu (lignes maintenues : ${supported.join(', ')})`);
  if (oldestMissed && overdueDays > PATCH_GRACE_DAYS) {
    problems.push(`${missed.length} version(s) de correctif manquée(s) ; la plus ancienne (${oldestMissed.version}) date de ${overdueDays} jours (délai : ${PATCH_GRACE_DAYS})`);
  }
  return {
    installed,
    installedDate: current ? current.date : null,
    installedChrome: current ? current.chrome : null,
    latestPatch: latestPatch ? latestPatch.version : null,
    latestPatchChrome: latestPatch ? latestPatch.chrome : null,
    newest: newest ? newest.version : null,
    newestChrome: newest ? newest.chrome : null,
    supported,
    missed: missed.map((r) => r.version),
    overdue: problems.length > 0,
    problems,
  };
}

function toMarkdown(a, chromeStable) {
  const lines = [
    `**Electron installé** : ${a.installed} (Chromium ${a.installedChrome || '?'}, publié le ${a.installedDate || '?'})`,
    `**Dernier correctif de la ligne** : ${a.latestPatch} (Chromium ${a.latestPatchChrome || '?'})`,
    `**Dernière ligne stable** : ${a.newest} (Chromium ${a.newestChrome || '?'})`,
    `**Lignes maintenues par Electron** : ${a.supported.join(', ')}`,
  ];
  if (chromeStable) lines.push(`**Chrome stable** : ${chromeStable}`);
  lines.push('');
  if (a.overdue) {
    lines.push('### En retard sur la politique de sécurité (docs/security.md)', '', ...a.problems.map((p) => `- ${p}`), '');
    lines.push('Fusionner la PR Dependabot « electron » (ou `npm install -D electron@' + a.latestPatch + '`), puis publier une version de correctif.');
  } else {
    lines.push('À jour.');
  }
  return lines.join('\n');
}

async function main(argv) {
  const mode = argv.includes('--markdown') ? 'markdown' : argv.includes('--report') ? 'report' : 'check';
  let installed;
  try {
    installed = require(path.join(__dirname, '..', 'node_modules', 'electron', 'package.json')).version;
  } catch (_) {
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
    installed = lock.packages['node_modules/electron'].version;
  }
  let releases;
  try {
    const res = await fetch(RELEASES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    releases = await res.json();
  } catch (error) {
    console.error(`[electron-freshness] releases indisponibles : ${error.message}`);
    return mode === 'report' ? 0 : 2;
  }
  let chromeStable = null;
  try {
    const res = await fetch(CHROME_STABLE_URL);
    if (res.ok) chromeStable = (await res.json())[0].version;
  } catch (_) {
    // information seulement
  }
  const a = assessElectron({ installed, releases, now: Date.now() });
  console.log(toMarkdown(a, chromeStable));
  if (mode === 'report') return 0;
  return a.overdue ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = { assessElectron, toMarkdown, PATCH_GRACE_DAYS };
