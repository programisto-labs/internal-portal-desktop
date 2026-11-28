'use strict';

/**
 * Barre de la fenêtre d'incrustation (call-float.html) : nom de l'onglet, micro, caméra, raccrocher,
 * retour à l'onglet, fermer. Textes posés par textContent ; le processus principal décide de chaque action.
 */
const { ipcRenderer } = require('electron');

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  microphone: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  microphoneOff: ['M2 2l20 20', 'M18.89 13.23A7.12 7.12 0 0 0 19 12v-2', 'M5 10v2a7 7 0 0 0 12 5', 'M15 9.34V5a3 3 0 0 0-5.68-1.33', 'M9 9v3a3 3 0 0 0 5.12 2.12', 'M12 19v3'],
  camera: ['M16 13l5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5', 'M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z'],
  cameraOff: ['M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196', 'M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2', 'M2 2l20 20'],
  hangup: ['M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473', 'M22 2L2 22'],
  back: ['M15 3h6v6', 'M10 14L21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
};

function setIcon(button, name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  button.replaceChildren(svg);
}

function label(button, text) {
  button.setAttribute('aria-label', text);
  button.title = text;
}

function render(state) {
  const s = state && typeof state === 'object' ? state : {};
  const t = s.texts || {};
  const c = s.controls || {};
  const $ = (id) => document.getElementById(id);
  $('name').textContent = typeof s.title === 'string' ? s.title : '';
  $('dot').hidden = s.kind !== 'call';
  if (s.kind === 'call') $('dot').title = t.inCall || '';

  const mic = $('microphone');
  const micState = c.microphone || {};
  mic.hidden = !micState.available;
  mic.classList.toggle('off', micState.off === true);
  setIcon(mic, micState.off === true ? 'microphoneOff' : 'microphone');
  label(mic, micState.off === true ? t.microphoneOff || '' : t.microphoneOn || '');

  const cam = $('camera');
  const camState = c.camera || {};
  cam.hidden = !camState.available;
  cam.classList.toggle('off', camState.off === true);
  setIcon(cam, camState.off === true ? 'cameraOff' : 'camera');
  label(cam, camState.off === true ? t.cameraOff || '' : t.cameraOn || '');

  const hang = $('hangup');
  hang.hidden = !c.hangup;
  setIcon(hang, 'hangup');
  label(hang, t.hangup || '');

  setIcon($('back'), 'back');
  label($('back'), t.backToTab || '');
  setIcon($('close'), 'close');
  label($('close'), t.close || '');
}

window.addEventListener('DOMContentLoaded', () => {
  for (const id of ['microphone', 'camera', 'hangup', 'back', 'close']) {
    document.getElementById(id).addEventListener('click', () => ipcRenderer.send('lasco-call-float', { action: id }));
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') ipcRenderer.send('lasco-call-float', { action: 'close' });
  });
  ipcRenderer.on('lasco-call-float-state', (_event, state) => render(state));
  ipcRenderer.send('lasco-call-float', { action: 'ready' });
});
