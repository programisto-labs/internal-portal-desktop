'use strict';

/**
 * Relevé agrégé de la mémoire et du CPU de Lasco Desktop (docs/many-tabs-perf.md). Module pur :
 * `app.getAppMetrics()` et l'état des onglets lui sont donnés. Aucune donnée personnelle : ni
 * adresse, ni titre, ni identifiant d'onglet ; seulement des totaux par type de processus et
 * des nombres d'onglets, arrondis.
 */

/** Types de processus d'Electron regroupés : `Tab` (pages) et `Renderer` vont ensemble. */
function processKind(type) {
  if (type === 'Browser') return 'browser';
  if (type === 'GPU') return 'gpu';
  if (type === 'Tab' || type === 'Renderer') return 'renderer';
  if (type === 'Utility' || type === 'Zygote' || type === 'Sandbox helper') return 'utility';
  return 'other';
}

/** Mo arrondis au Mo (Electron donne des Ko). */
const toMb = (kb) => Math.round((Number(kb) || 0) / 1024);

/**
 * Instantané : `{ processes, memoryMb, cpuPercent, byKind: { browser, gpu, renderer, utility, other },
 * tabs: { webLive, webSleeping } }`. `metrics` : `app.getAppMetrics()` ; `percentCPUUsage` y est la
 * moyenne depuis le relevé précédent.
 */
function summarizeAppMetrics(metrics, { webLive = 0, webSleeping = 0 } = {}) {
  const byKind = {};
  let memoryKb = 0;
  let cpu = 0;
  let processes = 0;
  for (const proc of Array.isArray(metrics) ? metrics : []) {
    if (!proc) continue;
    const kind = processKind(proc.type);
    const bucket = byKind[kind] || (byKind[kind] = { count: 0, memoryMb: 0, cpuPercent: 0, _kb: 0 });
    const kb = proc.memory && Number(proc.memory.workingSetSize) > 0 ? Number(proc.memory.workingSetSize) : 0;
    const procCpu = proc.cpu && Number(proc.cpu.percentCPUUsage) > 0 ? Number(proc.cpu.percentCPUUsage) : 0;
    bucket.count += 1;
    bucket._kb += kb;
    bucket.cpuPercent += procCpu;
    memoryKb += kb;
    cpu += procCpu;
    processes += 1;
  }
  for (const bucket of Object.values(byKind)) {
    bucket.memoryMb = toMb(bucket._kb);
    bucket.cpuPercent = Math.round(bucket.cpuPercent * 10) / 10;
    delete bucket._kb;
  }
  return {
    processes,
    memoryMb: toMb(memoryKb),
    cpuPercent: Math.round(cpu * 10) / 10,
    byKind,
    tabs: { webLive: Math.max(0, webLive | 0), webSleeping: Math.max(0, webSleeping | 0) },
  };
}

module.exports = { processKind, summarizeAppMetrics };
