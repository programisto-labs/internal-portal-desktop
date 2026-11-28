'use strict';

/**
 * Banc « beaucoup d'onglets » (docs/many-tabs-perf.md). Reproductible, sans compte ni réseau :
 *
 *   npx electron scripts/bench-many-tabs.js --web=50 --portal=50
 *   npx electron scripts/bench-many-tabs.js --web=50 --portal=50 --max-live=10 --portal-live=6
 *   npx electron scripts/bench-many-tabs.js --portal-url=http://localhost:3001/login
 *
 * - Onglets web : le vrai gestionnaire (src/browser-tabs/manager.js), une WebContentsView par onglet,
 *   sur des pages locales « réalistes » (≈ 2 000 nœuds, 4 Mo de tas, minuterie toutes les secondes
 *   comme une régie publicitaire ou une mesure d'audience).
 * - Pages du portail : iframes de même origine dans la fenêtre hôte, comme la coquille du portail ;
 *   `--portal-live` en garde autant de vivantes (le reste est retiré, comme la veille du portail).
 *   Par défaut une page locale qui simule un bundle Next (≈ 6 Mo de tas) ; `--portal-url` charge une
 *   vraie page (le portail en dev par exemple).
 *
 * Mesures : mémoire (workingSetSize) et CPU par type de processus (`app.getAppMetrics()`), CPU au
 * repos sur 10 s, temps de bascule vers un onglet vivant et vers un onglet en veille (sélection →
 * première image peinte). Sortie : tableau lisible puis une ligne JSON (`BENCH_RESULT …`).
 */

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, value = 'true'] = arg.slice(2).split('=');
      return [key, value];
    }),
);
const WEB = Number(args.web ?? 50);
const PORTAL = Number(args.portal ?? 50);
const PORTAL_LIVE = Number(args['portal-live'] ?? 6);
const MAX_LIVE = args['max-live'] === undefined ? null : Number(args['max-live']);
const SETTLE_MS = Number(args.settle ?? 8000);
const IDLE_MS = Number(args.idle ?? 10000);
const SWITCHES = Number(args.switches ?? 10);
const PORTAL_URL = args['portal-url'] || null;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-bench-'));
app.setPath('userData', userData);

const WEB_PAGE = (i) => `<!doctype html><html><head><meta charset="utf-8"><title>Site ${i}</title>
<style>body{font:14px system-ui;margin:0}.card{padding:6px;border-bottom:1px solid #eee}</style></head>
<body><h1>Site ${i}</h1><main id="m"></main><script>
  const heap = []; for (let k = 0; k < 64; k++) heap.push(new Array(8192).fill(k + ${i}));
  const m = document.getElementById('m');
  for (let k = 0; k < 2000; k++) { const d = document.createElement('div'); d.className='card'; d.textContent='Article ' + k; m.appendChild(d); }
  setInterval(() => { let s = 0; for (let k = 0; k < 20000; k++) s += k; window.__tick = s; }, 1000);
</script></body></html>`;

const PORTAL_PAGE = (i) => `<!doctype html><html><head><meta charset="utf-8"><title>Portail ${i}</title></head>
<body><div id="root"></div><script>
  // Simule un bundle Next + React + caches de la page : ≈ 6 Mo de tas, 3 000 nœuds, un relevé toutes les 2 s.
  const modules = []; for (let k = 0; k < 96; k++) modules.push(new Array(8192).fill('m' + k));
  const root = document.getElementById('root');
  for (let k = 0; k < 3000; k++) { const r = document.createElement('div'); r.textContent = 'Ligne ' + k + ' / onglet ${i}'; root.appendChild(r); }
  setInterval(() => { window.__poll = Date.now(); }, 2000);
</script></body></html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    const [, kind, id] = req.url.split('/');
    if (kind === 'shell') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body style="margin:0"><div id="frames"></div></body></html>');
      return;
    }
    const page = kind === 'web' ? WEB_PAGE(id) : kind === 'portal' ? PORTAL_PAGE(id) : null;
    if (!page) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function metricsByType() {
  const out = {};
  for (const proc of app.getAppMetrics()) {
    const type = proc.type === 'Tab' ? 'Renderer' : proc.type;
    const bucket = out[type] || (out[type] = { count: 0, memoryMb: 0, cpuPercent: 0 });
    bucket.count += 1;
    bucket.memoryMb += (proc.memory && proc.memory.workingSetSize ? proc.memory.workingSetSize : 0) / 1024;
    bucket.cpuPercent += proc.cpu ? proc.cpu.percentCPUUsage : 0;
  }
  for (const bucket of Object.values(out)) {
    bucket.memoryMb = Math.round(bucket.memoryMb);
    bucket.cpuPercent = Math.round(bucket.cpuPercent * 10) / 10;
  }
  return out;
}

const total = (byType, field) => Object.values(byType).reduce((sum, bucket) => sum + bucket[field], 0);

async function waitLoaded(wc, timeoutMs = 15000) {
  if (!wc.isLoading()) return;
  await Promise.race([new Promise((resolve) => wc.once('did-stop-loading', resolve)), delay(timeoutMs)]);
}

async function firstPaint(wc) {
  await waitLoaded(wc);
  if (wc.isDestroyed()) return;
  // Une image composée de la vue (capturePage attend la prochaine image) : rAF ne tourne pas dans une
  // fenêtre masquée par une autre sous macOS, la capture si.
  await Promise.race([wc.capturePage().catch(() => {}), delay(5000)]);
}

const progress = (message) => process.stderr.write(`[bench] ${message}\n`);

async function main() {
  // Garde-fou : un banc bloqué ne doit pas tourner indéfiniment.
  setTimeout(() => {
    progress('délai dépassé');
    app.exit(2);
  }, Number(args.timeout ?? 600000)).unref();
  await app.whenReady();
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { backgroundThrottling: true } });
  win.focus();
  await win.loadURL(`${origin}/shell`);

  const { createBrowserTabManager } = require('../src/browser-tabs/manager');
  const { createHistoryStore } = require('../src/browser-tabs/history');
  const settings = { tabSleepMinutes: 30, tabSleepNeverSites: [], ...(MAX_LIVE !== null ? { tabSleepMaxLive: MAX_LIVE } : {}) };
  const manager = createBrowserTabManager({
    getMainWindow: () => win,
    history: createHistoryStore({}),
    interceptLink: () => false,
    getTabSleepSettings: () => settings,
  });
  manager.setBounds({ x: 0, y: 40, width: 1280, height: 760 });

  const t0 = Date.now();
  const ids = [];
  for (let i = 0; i < WEB; i++) {
    const tabId = `web-${i}`;
    ids.push(tabId);
    manager.create({ tabId, url: `${origin}/web/${i}` });
    manager.select({ tabId });
    const wc = manager.webContentsOf(tabId);
    if (wc) await waitLoaded(wc);
    if (i % 10 === 9) progress(`${i + 1} onglets web`);
  }
  const portalSrc = (i) => PORTAL_URL || `${origin}/portal/${i}`;
  // Chaque page du portail ouverte puis quittée : seules les `PORTAL_LIVE` plus récentes restent.
  for (let i = 0; i < PORTAL; i++) {
    await Promise.race([delay(25000), win.webContents.executeJavaScript(`new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.src = ${JSON.stringify(portalSrc(i))};
      f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden';
      f.onload = () => resolve(true);
      setTimeout(() => resolve(false), 20000);
      document.getElementById('frames').appendChild(f);
      const all = document.querySelectorAll('#frames iframe');
      if (all.length > ${PORTAL_LIVE}) all[0].remove();
    })`)]);
    if (i % 10 === 9) progress(`${i + 1} pages du portail`);
  }
  const openMs = Date.now() - t0;
  progress('repos');

  // L'onglet affiché : le dernier web. Les autres sont cachés depuis l'ouverture.
  await delay(SETTLE_MS);
  let slept = 0;
  if (MAX_LIVE !== null && typeof manager.runLiveBudgetCheck === 'function') {
    await manager.runLiveBudgetCheck({ minHiddenMs: 0 });
    slept = manager.sleepingTabIds().length;
    await delay(2000);
  }
  metricsByType(); // remet à zéro le compteur de CPU (percentCPUUsage = depuis le relevé précédent)
  await delay(IDLE_MS);
  const idle = metricsByType();
  progress('bascules');

  // Bascules : vers un onglet récent (vivant) puis vers un ancien (en veille si le budget s'applique).
  const switchLive = [];
  const switchOld = [];
  for (let k = 0; k < SWITCHES; k++) {
    const recent = ids[ids.length - 2 - (k % 4)];
    const old = ids[k];
    for (const [tabId, out] of [
      [recent, switchLive],
      [old, switchOld],
    ]) {
      const start = performance.now();
      manager.select({ tabId });
      const wc = manager.webContentsOf(tabId);
      if (wc) await firstPaint(wc);
      out.push(performance.now() - start);
    }
  }
  const median = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    return Math.round(sorted[Math.floor(sorted.length / 2)] || 0);
  };

  const result = {
    web: WEB,
    portal: PORTAL,
    portalLive: PORTAL_LIVE,
    maxLive: MAX_LIVE,
    webSleeping: slept,
    openSeconds: Math.round(openMs / 100) / 10,
    memoryMb: total(idle, 'memoryMb'),
    idleCpuPercent: Math.round(total(idle, 'cpuPercent') * 10) / 10,
    processes: total(idle, 'count'),
    byType: idle,
    switchLiveMs: median(switchLive),
    switchOldMs: median(switchOld),
    electron: process.versions.electron,
    platform: `${process.platform}-${process.arch}`,
    systemMemory: process.getSystemMemoryInfo(),
  };
  console.log('\n=== Banc beaucoup d’onglets ===');
  console.log(`${WEB} web + ${PORTAL} portail (${PORTAL_LIVE} vivantes), budget web : ${MAX_LIVE ?? 'aucun'}`);
  console.log(`Ouverture : ${result.openSeconds} s, web en veille : ${slept}`);
  console.log(`Mémoire : ${result.memoryMb} Mo, ${result.processes} processus, CPU au repos : ${result.idleCpuPercent} %`);
  for (const [type, bucket] of Object.entries(idle)) {
    console.log(`  ${type.padEnd(12)} ${String(bucket.count).padStart(3)} proc ${String(bucket.memoryMb).padStart(6)} Mo  ${bucket.cpuPercent} %`);
  }
  console.log(`Bascule vers un onglet récent : ${result.switchLiveMs} ms, vers un ancien : ${result.switchOldMs} ms`);
  console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
  manager.destroyAll();
  server.close();
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
