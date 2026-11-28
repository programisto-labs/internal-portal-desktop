'use strict';

/**
 * Vérification de bout en bout de l'incrustation (docs/picture-in-picture.md), dans Electron, avec le vrai
 * gestionnaire d'onglets et un faux appel (caméra et micro factices de Chromium) :
 *
 *   npx electron scripts/e2e-picture-in-picture.js
 *
 * Ouvre des fenêtres à l'écran quelques secondes. Code de sortie 0 si tout passe.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'lasco-pip-e2e-')));

const FIXTURES = path.join(__dirname, 'fixtures', 'picture-in-picture');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await delay(150);
  }
  return false;
}

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(FIXTURES, path.basename(req.url.split('?')[0]) || 'blank.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Autre onglet</title><p>Autre onglet</p>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const { createBrowserTabManager, sharedSitePermissions } = require('../src/browser-tabs/manager');
  for (const permission of ['microphone', 'camera']) sharedSitePermissions().set(origin, permission, 'allow');

  const win = new BrowserWindow({ width: 1000, height: 700, show: true });
  await win.loadURL('data:text/html,<title>Portail</title>');
  const sent = [];
  const originalSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    sent.push({ channel, payload });
    return originalSend(channel, payload);
  };
  let pipAuto = true;
  const manager = createBrowserTabManager({
    getMainWindow: () => (win.isDestroyed() ? null : win),
    getPictureInPictureAuto: () => pipAuto,
  });
  manager.setBounds({ x: 0, y: 40, width: 1000, height: 660 });
  const floats = () => BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed() && w.isVisible());

  try {
    manager.create({ tabId: 'call', url: `${origin}/call.html` });
    manager.select({ tabId: 'call' });
    const callWc = manager.webContentsOf('call');
    await until(async () => (await callWc.executeJavaScript('typeof window.callReady').catch(() => '')) === 'object');
    const ready = await callWc.executeJavaScript('window.callReady');
    check('le faux appel reçoit micro et caméra', ready === true, String(ready));
    check('onglet « en appel »', await until(() => manager.stateOf('call').inCall), JSON.stringify(manager.stateOf('call').inCall));

    manager.create({ tabId: 'other', url: `${origin}/other.html` });
    manager.select({ tabId: 'other' });
    check('changer d’onglet ouvre la fenêtre flottante', await until(() => floats().length === 1));
    check('état : incrustation « call »', manager.stateOf('call').pictureInPicture === 'call');
    const float = floats()[0];
    if (float) {
      check('fenêtre toujours au premier plan', float.isAlwaysOnTop());
      const children = float.contentView.children;
      check('la vue de l’appel est dans la fenêtre flottante', children.some((v) => v.webContents === callWc));
      const bar = children.find((v) => v.webContents !== callWc);
      await until(async () => bar && !(await bar.webContents.executeJavaScript("document.getElementById('microphone').hidden")));
      const shown = await bar.webContents.executeJavaScript(
        "['microphone','camera','hangup','back','close'].filter((id) => !document.getElementById(id).hidden)",
      );
      check('barre : micro, caméra, raccrocher, retour, fermer', shown.length === 5, shown.join(','));
      await bar.webContents.executeJavaScript("document.getElementById('microphone').click()");
      const muted = await until(async () =>
        (await callWc.executeJavaScript("document.getElementById('mic').getAttribute('data-is-muted')")) === 'true');
      check('le bouton micro de la barre coupe le micro de la page', muted);
      const barMuted = await until(async () =>
        bar.webContents.executeJavaScript("document.getElementById('microphone').classList.contains('off')"));
      check('la barre montre le micro coupé', barMuted);
    }
    const sleep = await manager.sleep({ tabId: 'call' });
    check('l’onglet en appel n’est pas mis en veille', !sleep.ok, sleep.error);

    manager.select({ tabId: 'call' });
    check('revenir sur l’onglet ferme la fenêtre flottante', await until(() => floats().length === 0));
    check('la vue revient dans la fenêtre du portail (sans rechargement)', win.contentView.children.some((v) => v.webContents === callWc));
    check('état : plus d’incrustation', manager.stateOf('call').pictureInPicture === null);

    // Bouton « Revenir à l'onglet » : le portail reçoit la sélection de l'onglet.
    manager.select({ tabId: 'other' });
    await until(() => floats().length === 1);
    const bar2 = floats()[0] && floats()[0].contentView.children.find((v) => v.webContents !== callWc);
    if (bar2) {
      await delay(300);
      await bar2.webContents.executeJavaScript("document.getElementById('back').click()");
      check('« Revenir à l’onglet » ferme la fenêtre', await until(() => floats().length === 0));
      check('… et demande au portail de sélectionner l’onglet',
        sent.some((m) => m.channel === 'tab-window-tab-action' && m.payload.tabId === 'call' && m.payload.action === 'select'));
    }
    manager.select({ tabId: 'call' });

    // Fermer à la main : plus d'incrustation automatique tant qu'on n'est pas revenu sur l'onglet.
    await manager.pictureInPicture({ tabId: 'call' });
    check('bouton du portail : fenêtre flottante pour un appel', await until(() => floats().length === 1));
    await manager.pictureInPicture({ tabId: 'call' });
    check('… et la referme', await until(() => floats().length === 0));

    // Raccrocher depuis la barre : l'appel se termine dans la page, la fenêtre se ferme.
    manager.select({ tabId: 'other' });
    await until(() => floats().length === 1);
    const bar3 = floats()[0] && floats()[0].contentView.children.find((v) => v.webContents !== callWc);
    if (bar3) {
      await delay(300);
      await bar3.webContents.executeJavaScript("document.getElementById('hangup').click()");
      check('raccrocher ferme la fenêtre', await until(() => floats().length === 0));
      check('… et termine l’appel dans la page', (await callWc.getTitle()) === 'Appel terminé');
      check('… l’onglet n’est plus « en appel »', await until(() => !manager.stateOf('call').inCall));
    }

    // Vidéo avec du son : incrustation de la vidéo en changeant d'onglet, refermée au retour.
    manager.create({ tabId: 'video', url: `${origin}/video.html` });
    manager.select({ tabId: 'video' });
    const videoWc = manager.webContentsOf('video');
    await until(async () => (await videoWc.executeJavaScript('typeof window.startVideo').catch(() => '')) === 'function');
    await videoWc.executeJavaScript('window.startVideo()', true);
    check('vidéo incrustable', await until(() => manager.stateOf('video').canPictureInPicture));
    check('une vidéo n’est pas un appel', !manager.stateOf('video').inCall);
    await until(() => videoWc.isCurrentlyAudible());
    manager.select({ tabId: 'other' });
    check('changer d’onglet incruste la vidéo', await until(() => manager.stateOf('video').pictureInPicture === 'video'));
    check('… sans fenêtre flottante Lasco', floats().length === 0);
    manager.select({ tabId: 'video' });
    check('revenir sur l’onglet referme l’incrustation', await until(() => manager.stateOf('video').pictureInPicture === null));

    // Réglage coupé : rien d'automatique.
    pipAuto = false;
    manager.select({ tabId: 'other' });
    await delay(1200);
    check('réglage coupé : pas d’incrustation automatique', manager.stateOf('video').pictureInPicture === null);
    pipAuto = true;
    // Manuel (bouton du portail, menu de la vidéo).
    const manual = await manager.pictureInPicture({ tabId: 'video' });
    check('bouton du portail : incrustation de la vidéo', manual.ok && manager.stateOf('video').pictureInPicture === 'video', JSON.stringify(manual));
    await manager.pictureInPicture({ tabId: 'video', action: 'exit' });
    check('… et sortie', manager.stateOf('video').pictureInPicture === null);

    // « Incruster l'onglet » : n'importe quelle page web, sans rechargement.
    const otherWc = manager.webContentsOf('other');
    await otherWc.executeJavaScript('window.__lascoMarker = 42');
    manager.select({ tabId: 'video' });
    const page = await manager.pictureInPicture({ tabId: 'other', action: 'enter', mode: 'page' });
    check('incruster une page web', page.ok && page.pictureInPicture === 'page' && (await until(() => floats().length === 1)), JSON.stringify(page));
    check('… la page n’est pas rechargée', (await otherWc.executeJavaScript('window.__lascoMarker')) === 42);
    const pageBar = floats()[0] && floats()[0].contentView.children.find((v) => v.webContents !== otherWc);
    if (pageBar) {
      await until(async () => (await pageBar.webContents.executeJavaScript("document.body.dataset.kind")) === 'page');
      const visible = await pageBar.webContents.executeJavaScript(
        "['microphone','camera','hangup','back','close'].filter((id) => !document.getElementById(id).hidden)",
      );
      check('… barre sans contrôles d’appel', visible.join(',') === 'back,close', visible.join(','));
      await pageBar.webContents.executeJavaScript("document.getElementById('close').click()");
      check('… fermer rend la page à son onglet', await until(() => floats().length === 0 && manager.stateOf('other').pictureInPicture === null));
    }

    // Autre application pendant un appel : fenêtre flottante, refermée au retour dans Lasco.
    manager.create({ tabId: 'call2', url: `${origin}/call.html` });
    manager.select({ tabId: 'call2' });
    const call2 = manager.webContentsOf('call2');
    await until(async () => (await call2.executeJavaScript('typeof window.callReady').catch(() => '')) === 'object');
    await call2.executeJavaScript('window.callReady');
    await until(() => manager.stateOf('call2').inCall);
    const realFocused = BrowserWindow.getFocusedWindow;
    BrowserWindow.getFocusedWindow = () => null; // aucune fenêtre de Lasco n'a le focus
    win.emit('blur');
    check('quitter Lasco pendant un appel ouvre la fenêtre flottante', await until(() => floats().length === 1));
    BrowserWindow.getFocusedWindow = realFocused;
    win.emit('focus');
    check('revenir dans Lasco la referme', await until(() => floats().length === 0));
    check('… la vue de l’appel est de nouveau affichée', win.contentView.children.some((v) => v.webContents === call2));
    // Navigation de l'onglet incrusté : la fenêtre se ferme.
    manager.select({ tabId: 'other' });
    await until(() => floats().length === 1);
    manager.navigate({ tabId: 'call2', url: `${origin}/other.html` });
    check('naviguer ailleurs ferme la fenêtre flottante', await until(() => floats().length === 0));
    // Fermer l'onglet incrusté.
    manager.select({ tabId: 'call' });
    manager.close({ tabId: 'call2' });
  } catch (error) {
    check('exception', false, error && error.stack);
  }

  manager.destroyAll();
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications passées`);
  app.exit(failed ? 1 : 0);
});
