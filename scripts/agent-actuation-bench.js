'use strict';

/**
 * Banc des actions d'agent dans une page web (docs/agent-actuation.md) : joue chaque scénario avec l'ancien
 * moteur (DOM du monde isolé + sendInputEvent) et le nouveau (CDP : arbre d'accessibilité, Input.*), dans un
 * vrai Electron, onglet caché comme un onglet piloté en arrière-plan.
 *
 *   npx electron scripts/agent-actuation-bench.js [--json]
 *
 * Un scénario réussit si l'effet attendu est constaté dans la page ET si le moteur ne s'est pas trompé en route
 * (succès annoncé à tort, valeur sensible lue). Les pages sont dans scripts/agent-actuation-fixtures.js.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BaseWindow, WebContentsView } = require('electron');
const { createAgentCdp } = require('../src/browser-tabs/agent-cdp');
const { buildPageAgentScript } = require('../src/browser-tabs/agent-dom');
const { FIXTURES, SCENARIOS } = require('./agent-actuation-fixtures');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JSON_OUTPUT = process.argv.includes('--json');

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/slow')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: ['Alpha', 'Bêta', 'Gamma'] }));
      }, 1200);
      return;
    }
    const name = url.pathname.replace(/^\//, '').replace(/\.html$/, '');
    const body = FIXTURES[name];
    if (!body) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function waitForLoadStop(wc, maxMs = 8000) {
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    wc.once('did-stop-loading', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    }),
  ]);
}

/** Ancien moteur, tel qu'il était dans manager.js (DOM du monde isolé, sendInputEvent, attente fixe). */
function legacyDriver(wc) {
  const run = (command) => withTimeout(wc.executeJavaScriptInIsolatedWorld(1001, [{ code: buildPageAgentScript(command) }], false), 10_000, 'script');
  const settle = async () => {
    await delay(350);
    await waitForLoadStop(wc);
    try {
      return await run({ op: 'snapshot', maxElements: 120, maxText: 3000 });
    } catch (_) {
      await delay(500);
      return run({ op: 'snapshot', maxElements: 120, maxText: 3000 });
    }
  };
  const click = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  };
  return {
    name: 'dom',
    snapshot: async () => run({ op: 'snapshot', maxElements: 150, maxText: 12000 }),
    click: async (ref) => {
      const located = await run({ op: 'locate', ref });
      if (!located || !located.ok) return { ok: false, error: located?.error || 'stale-ref' };
      await click(located.x, located.y);
      return { ok: true, ...(located.covered ? { warning: 'element-covered' } : {}), page: await settle() };
    },
    type: async (ref, text, { submit = false } = {}) => {
      const located = await run({ op: 'locate', ref });
      if (!located || !located.ok) return { ok: false, error: located?.error || 'stale-ref' };
      await click(located.x, located.y);
      const focused = await run({ op: 'focus', ref, clear: true });
      if (!focused?.ok) return { ok: false, error: focused?.error || 'focus-failed' };
      if (text) await wc.insertText(text);
      if (submit) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
      return { ok: true, page: await settle() };
    },
    press: async (key) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode: key });
      if (key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key });
      return { ok: true, page: await settle() };
    },
    select: async (ref, value) => {
      const result = await run({ op: 'select', ref, value });
      if (!result?.ok) return result;
      return { ok: true, page: await settle() };
    },
    scroll: async (opts) => {
      const result = await run({ op: 'scroll', ...opts });
      if (!result?.ok) return result;
      return { ok: true, page: await settle() };
    },
    upload: async () => ({ ok: false, error: 'unsupported' }),
    dialog: async () => ({ ok: false, error: 'unsupported' }),
  };
}

/** Nouveau moteur. Une écriture demande la validation : le banc la note, puis la rejoue validée (comme l'API). */
function cdpDriver(wc, approvals) {
  const cdp = createAgentCdp(wc);
  const guard = { writeGate: true, approved: false };
  const guarded = async (label, fn) => {
    try {
      return await fn(guard);
    } catch (error) {
      if (error && error.code === 'approval-required') {
        approvals.push({ label, approval: error.details.approval });
        return fn({ writeGate: true, approved: true }).catch(toFailure);
      }
      return toFailure(error);
    }
  };
  const toFailure = (error) => ({ ok: false, error: (error && error.code) || (error && error.message) || 'failed', ...((error && error.details) || {}) });
  return {
    name: 'cdp',
    snapshot: () => cdp.snapshot({ maxElements: 150, maxText: 12000 }),
    click: (ref) => guarded('click', (g) => cdp.click(ref, { guard: g })),
    type: (ref, text, opts = {}) => guarded('type', (g) => cdp.type(ref, text, { ...opts, guard: g })),
    press: (key, opts = {}) => guarded('press', (g) => cdp.press(key, { ...opts, guard: g })),
    select: (ref, value) => cdp.select(ref, value).catch(toFailure),
    scroll: (opts) => cdp.scroll(opts).catch(toFailure),
    upload: (ref, file) => guarded('upload', (g) => cdp.upload(ref, file, { guard: g })),
    dialog: (opts) => guarded('dialog', async (g) => cdp.planDialog({ ...opts, guard: g })),
  };
}

let sharedWindow = null;
/** Fenêtre hôte des onglets des scénarios (jamais affichée). */
function benchWindow() {
  if (sharedWindow) return sharedWindow;
  sharedWindow = new BaseWindow({ width: 1100, height: 800, show: false });
  return sharedWindow;
}

async function runScenario(scenario, driverName, port) {
  const win = benchWindow();
  // Rendu hors écran : la page se croit affichée et reçoit les entrées sans fenêtre au premier plan (un Electron lancé
  // depuis un terminal a ses fenêtres masquées pour Chromium). Le comportement d'un onglet caché du vrai Desktop est
  // décrit dans docs/agent-tabs.md.
  const view = new WebContentsView({ webPreferences: { offscreen: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1100, height: 800 });
  const wc = view.webContents;
  wc.setBackgroundThrottling(false);
  const approvals = [];
  const started = Date.now();
  let outcome;
  try {
    await wc.loadURL('about:blank');
    // Comme l'identité Chrome : débogueur attaché et Page activé sur chaque onglet.
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.enable');
    await wc.loadURL(`http://127.0.0.1:${port}/${scenario.fixture}`);
    await waitForLoadStop(wc);
    await delay(Number(process.env.BENCH_SETTLE_MS || 150));
    const driver = driverName === 'cdp' ? cdpDriver(wc, approvals) : legacyDriver(wc);
    const evaluate = (code) => withTimeout(wc.executeJavaScript(code, true), 4000, 'evaluate');
    const context = {
      driver,
      evaluate,
      uploadFile: scenario.needsFile ? writeUploadFile() : null,
      find: (page, role, name) => findElement(page, role, name),
    };
    const result = await withTimeout(scenario.run(context), 25_000, 'scenario');
    const check = await scenario.check({ evaluate, result, approvals: approvals.map((entry) => entry.approval && entry.approval.reason), driver: driverName });
    outcome = { ok: check === true, ...(check === true ? {} : { reason: String(check) }) };
    if (process.env.BENCH_DEBUG) console.log(driverName, scenario.id, JSON.stringify(result).slice(0, 300), await evaluate("JSON.stringify(window.__r)"), await evaluate("typeof __r"));
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach();
    } catch (_) {
      // déjà détaché
    }
    win.contentView.removeChildView(view);
    wc.close();
  }
  return { ...outcome, ms: Date.now() - started, approvals: approvals.map((entry) => entry.approval && entry.approval.reason) };
}

function writeUploadFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-bench-'));
  const file = path.join(dir, 'devis.pdf');
  fs.writeFileSync(file, '%PDF-1.4 bench');
  return file;
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Élément par rôle et nom (insensible à la casse et aux accents). */
function findElement(page, role, name) {
  const elements = (page && page.elements) || [];
  const roles = Array.isArray(role) ? role : [role];
  const wanted = normalize(name);
  return elements.find((element) => roles.includes(element.role) && normalize(element.name).includes(wanted)) || null;
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const rows = [];
  const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7);
  for (const scenario of SCENARIOS.filter((entry) => !only || only.split(',').includes(entry.id))) {
    const row = { id: scenario.id, label: scenario.label };
    for (const driverName of ['dom', 'cdp']) {
      row[driverName] = await runScenario(scenario, driverName, port);
    }
    rows.push(row);
    if (!JSON_OUTPUT) {
      const mark = (result) => (result.ok ? 'OK ' : 'KO ');
      console.log(`${mark(row.dom)}${mark(row.cdp)} ${scenario.id.padEnd(22)} dom:${row.dom.reason || ''} cdp:${row.cdp.reason || ''}${row.cdp.approvals.length ? ` [validation: ${row.cdp.approvals.join(', ')}]` : ''}`);
    }
  }
  const score = (driverName) => rows.filter((row) => row[driverName].ok).length;
  const summary = { total: rows.length, dom: score('dom'), cdp: score('cdp') };
  if (JSON_OUTPUT) console.log(JSON.stringify({ summary, rows }, null, 2));
  else console.log(`\nRéussite : ancien moteur ${summary.dom}/${summary.total}, nouveau moteur ${summary.cdp}/${summary.total}`);
  server.close();
  app.exit(summary.cdp === summary.total ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(2);
});
