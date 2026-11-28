'use strict';

/**
 * Essai réel des extensions (docs/extensions.md, « Sélection de référence »). Réseau requis.
 *
 *   npx electron scripts/smoke-extensions.js [--keep] [--id=<id>…]
 *
 * Profil temporaire : installe chaque extension depuis le Chrome Web Store (téléchargement et
 * vérification CRX3), la charge dans une session d'onglets web, ouvre des pages de test et relève
 * ce qui fonctionne (service worker, bouton d'action, scripts de contenu, règles réseau).
 * Écrit le relevé en JSON sur la sortie standard (`SMOKE_RESULT …`).
 */

const { app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SELECTION = [
  { id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', name: '1Password' },
  { id: 'ddkjiahejlhfcafbddmgiahcphecmpfh', name: 'uBlock Origin Lite' },
  { id: 'kbfnbcaeplbcioakkpcpgfkobkghlhen', name: 'Grammarly' },
  { id: 'fmkadmapgofadopljbjfkapdkoienihi', name: 'React Developer Tools' },
  { id: 'liecbddmkiiihnedobmlmillhodjkdmb', name: 'Loom' },
];

const argIds = process.argv.filter((a) => a.startsWith('--id=')).map((a) => a.slice(5));
const keep = process.argv.includes('--keep');
const selection = argIds.length > 0 ? SELECTION.filter((s) => argIds.includes(s.id)) : SELECTION;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-ext-smoke-'));
app.setPath('userData', userData);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { webRequestHub } = require('../src/browser-tabs/web-request-hub');
  const { createExtensionsService } = require('../src/extensions');
  const service = createExtensionsService({
    electron: require('electron'),
    userDataDir: userData,
    chromeVersion: process.versions.chrome,
    isProtectedUrl: (url) => /^https:\/\/(app|api)\.lascoapp\.com\//.test(url),
    protectedOrigins: () => ['https://app.lascoapp.com'],
  });
  const browserSession = session.fromPartition('persist:smoke-browser-tabs');
  // Même chaîne que les onglets web : un bloqueur fictif après les règles des extensions.
  let reachedLascoBlocker = 0;
  webRequestHub(browserSession).add('onBeforeRequest', (_d, cb) => {
    reachedLascoBlocker += 1;
    cb({});
  });

  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  const tabs = [];
  const makeTab = (url) => {
    const view = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true, contextIsolation: true } });
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    tabs.push(view.webContents);
    service.addTab(browserSession, view.webContents, win);
    if (url) void view.webContents.loadURL(url).catch(() => {});
    return view.webContents;
  };
  const ctx = service.attachSession(browserSession, {
    profileId: 'smoke',
    hooks: {
      createTab: ({ url }) => ({ webContents: makeTab(url), window: win }),
      selectTab: () => {},
      removeTab: (wc) => wc.close(),
      createWindow: async () => win,
      isExtensionWindow: () => false,
      windowForWebContents: () => win,
    },
  });

  const report = [];
  for (const { id, name } of selection) {
    const started = Date.now();
    const result = await service.installFromStore(ctx, id, { consent: false });
    const row = { id, name, install: result.ok ? 'ok' : result.error, installMs: Date.now() - started };
    if (result.message) row.message = result.message;
    report.push(row);
  }

  // Extension de diagnostic (LASCO_PROBE_EXT=<dossier>) : son service worker renvoie ce qu'il voit.
  let probeReport = null;
  if (process.env.LASCO_PROBE_EXT) {
    const http = require('http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          probeReport = JSON.parse(body);
        } catch (_) {
          probeReport = body;
        }
        res.end('ok');
      });
    });
    await new Promise((r) => server.listen(47123, '127.0.0.1', r));
    service.setDeveloperMode(ctx, { enabled: true });
    const probe = await service.installUnpacked(ctx, { dir: process.env.LASCO_PROBE_EXT });
    for (let i = 0; i < 40 && !probeReport; i += 1) await delay(250);
    probeReport = { install: probe, report: probeReport };
    server.close();
  }

  // Page de test : script publicitaire connu (bloqué ou neutralisé par uBOL), React (DevTools).
  const testPage = `data:text/html,${encodeURIComponent(`<!doctype html><html><body>
    <textarea id="t" style="width:400px;height:100px">Ceci est un test</textarea>
    <script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
    </body></html>`)}`;
  const page = makeTab('https://example.com/');
  await new Promise((r) => page.once('did-finish-load', r));
  await delay(4000);
  const probe = async (wc, code) => {
    try {
      return await wc.executeJavaScript(code, true);
    } catch (error) {
      return `error: ${error.message}`;
    }
  };
  const dom = await probe(
    page,
    `({
      reactHook: typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ === 'object',
      grammarly: Boolean(document.querySelector('grammarly-desktop-integration')) || document.body.hasAttribute('data-gr-ext-installed'),
      loom: Boolean(document.querySelector('[id^="loom"], loom-container, #loom-companion-mv3')),
      onePassword: Boolean(document.querySelector('com-1password-button, com-1password-menu')) || Boolean(document.querySelector('[data-onepassword-extension]')),
      bodyAttrs: [...document.body.attributes].map(a => a.name),
      customElements: [...new Set([...document.querySelectorAll('*')].map(e => e.tagName.toLowerCase()).filter(t => t.includes('-')))],
    })`,
  );
  // uBOL : requête publicitaire depuis une page web.
  const adPage = makeTab(testPage);
  await delay(3000);
  const adProbe = await probe(adPage, `({ adsbygoogle: typeof window.adsbygoogle, push: typeof (window.adsbygoogle && window.adsbygoogle.push) })`);

  // Popup d'action (bouton de la barre d'outils) et page d'options (onglet ouvert par l'extension).
  const ui = {};
  const popupTarget = report.find((r) => r.install === 'ok' && r.id === 'ddkjiahejlhfcafbddmgiahcphecmpfh') || report.find((r) => r.install === 'ok');
  if (popupTarget) {
    const popupCreated = new Promise((resolve) => {
      ctx.extensions.once('browser-action-popup-created', (popup) => resolve(popup));
      setTimeout(() => resolve(null), 8000);
    });
    ui.activate = service.activateAction(ctx, { id: popupTarget.id, webContentsId: page.id, anchor: { x: 1100, y: 10, width: 28, height: 28 } });
    const popup = await popupCreated;
    if (popup) {
      await popup.whenReady().catch(() => {});
      await delay(1500);
      const pwc = popup.browserWindow && popup.browserWindow.webContents;
      ui.popup = pwc ? { url: pwc.getURL(), bounds: popup.browserWindow.getBounds(), text: (await probe(pwc, 'document.body.innerText.slice(0, 80)')) } : 'no-window';
      popup.destroy();
    } else ui.popup = null;
    const before = tabs.length;
    ui.options = service.openOptions(ctx, { id: popupTarget.id });
    await delay(2500);
    ui.optionsTab = tabs.length > before ? tabs[tabs.length - 1].getURL() : null;
  }
  // Page du Chrome Web Store : API du store et bouton « Ajouter à Lasco ».
  const store = makeTab('https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh?hl=fr');
  await new Promise((r) => store.once('did-finish-load', r));
  await delay(6000);
  ui.webstore = await probe(store, `({
    webstorePrivate: typeof (window.chrome && chrome.webstorePrivate && chrome.webstorePrivate.beginInstall),
    buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(t => /ajouter|add|lasco|chrome/i.test(t)).slice(0, 5),
    title: document.title,
  })`);

  const workers = browserSession.serviceWorkers.getAllRunning ? browserSession.serviceWorkers.getAllRunning() : {};
  const running = new Set(Object.values(workers).map((w) => String(w.scope || '').replace(/^chrome-extension:\/\/([a-p]{32}).*/, '$1')));
  const actions = await service.getActions(ctx, { webContentsId: page.id });
  const listed = service.list(ctx);
  for (const row of report) {
    const info = listed.extensions.find((e) => e.id === row.id);
    const loaded = browserSession.extensions.getExtension(row.id);
    row.loaded = Boolean(loaded);
    row.version = info && info.version;
    row.manifestVersion = info && info.manifestVersion;
    row.serviceWorker = running.has(row.id);
    row.action = Boolean(actions.find((a) => a.id === row.id));
    row.actionIcon = Boolean((actions.find((a) => a.id === row.id) || {}).icon);
    row.permissions = info && info.permissions;
    row.warnings = info && info.permissionWarnings.map((w) => w.key);
    row.dnrRules = ctx.dnr.ruleCount(row.id);
    row.error = info && info.error;
  }
  const output = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    report,
    dom,
    adProbe,
    ui,
    probeReport,
    dnrMatched: ctx.dnr.matchedCount,
    reachedLascoBlocker,
  };
  console.log(`SMOKE_RESULT ${JSON.stringify(output, null, 2)}`);
  if (!keep) fs.rmSync(userData, { recursive: true, force: true });
  else console.log(`profile kept in ${userData}`);
  app.exit(0);
});
