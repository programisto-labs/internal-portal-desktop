'use strict';

/**
 * Incrustation vidéo (picture-in-picture) des onglets web (docs/picture-in-picture.md).
 *
 * Electron 44 (Chromium 152) sait faire l'incrustation d'une vidéo (`video.requestPictureInPicture()`),
 * mais pas Document Picture-in-Picture (`documentPictureInPicture` absent, même avec le flag Blink) : c'est
 * ce que Meet utilise dans Chrome. Pour un appel, Lasco déplace donc la vue de l'onglet dans une petite
 * fenêtre native toujours au premier plan (call-float.js), avec retour à l'onglet, micro, caméra et
 * raccrocher quand la page expose ces boutons.
 *
 * Ce module est pur (aucun import d'Electron) : scripts lancés dans le monde isolé du preload et décisions.
 */

/** Monde isolé du preload des onglets web (même que tab-sleep.js) : la page ne voit pas nos scripts. */
const PIP_WORLD_ID = 999;

/**
 * Recherche des boutons d'appel dans la page, partagée par le relevé et le clic. Sélecteurs connus
 * (Teams web : `#microphone-button`… ; Zoom web : `.join-audio-container__btn`…), puis libellés
 * (`aria-label`, `data-tooltip`, `title`) dans les langues proposées par Lasco. Meet : ses boutons micro
 * et caméra portent `data-is-muted`.
 */
const FIND_CALL_CONTROLS_SOURCE = `
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.getAttribute('title'), el.textContent]
    .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
  const first = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (visible(el)) return el;
    }
    return null;
  };
  const MIC = /(micro|microphone|\\bmic\\b|\\bmute|unmute|muet|stummschalt|silenci|silenzi|dempen)/i;
  const CAM = /(cam[eé]ra|kamera|c[aá]mara|\\bvideo|vid[eé]o)/i;
  const HANG = /(raccrocher|quitter l.appel|quitter la r[eé]union|leave call|leave meeting|end call|hang up|\\bleave\\b|auflegen|verlassen|colgar|salir de|riaggancia|abbandona|ophangen|verlaten|encerrar|sair da)/i;
  const findControl = (kind) => {
    if (kind === 'microphone') {
      return first(['#microphone-button', 'button[data-tid="toggle-mute"]', '.join-audio-container__btn'])
        || buttons.find((b) => b.hasAttribute('data-is-muted') && MIC.test(labelOf(b)) && !CAM.test(labelOf(b)))
        || buttons.find((b) => MIC.test(labelOf(b)) && !CAM.test(labelOf(b)) && !HANG.test(labelOf(b)))
        || null;
    }
    if (kind === 'camera') {
      return first(['#video-button', 'button[data-tid="toggle-video"]', '.send-video-container__btn'])
        || buttons.find((b) => b.hasAttribute('data-is-muted') && CAM.test(labelOf(b)))
        || buttons.find((b) => CAM.test(labelOf(b)) && !MIC.test(labelOf(b)) && !HANG.test(labelOf(b)))
        || null;
    }
    if (kind === 'hangup') {
      return first(['#hangup-button', 'button[data-tid="call-hangup"]', '.footer__leave-btn'])
        || buttons.find((b) => HANG.test(labelOf(b)))
        || null;
    }
    return null;
  };
`;

/**
 * Relevé de la page, dans le monde isolé (le DOM et les MediaStream sont partagés avec la page) :
 * - `liveMedia` : un élément audio / vidéo lit un flux vivant (`srcObject` avec une piste `live`),
 *   donc un appel en cours (WebRTC) ou l'aperçu de la caméra. Disparaît quand on raccroche.
 * - `video` : une vidéo lit, assez grande, sans `disablePictureInPicture` (incrustation possible).
 * - `videoPip` : une vidéo de la page est en incrustation.
 * - `controls` : boutons micro, caméra, raccrocher trouvés dans la page, et leur état (`off`).
 */
const PAGE_MEDIA_PROBE_SCRIPT = `(() => {
  ${FIND_CALL_CONTROLS_SOURCE}
  const media = [...document.querySelectorAll('video, audio')];
  const liveMedia = media.some((el) => {
    try {
      const s = el.srcObject;
      return Boolean(s && typeof s.getTracks === 'function' && s.getTracks().some((t) => t.readyState === 'live'));
    } catch (_) {
      return false;
    }
  });
  const video = media.some((v) => v.tagName === 'VIDEO' && !v.paused && !v.ended && v.readyState >= 2
    && !v.disablePictureInPicture && v.videoWidth > 0 && v.clientWidth * v.clientHeight >= 160 * 90);
  // Coupé ? data-is-muted (Meet), sinon le libellé (« Activer le micro » = coupé), sinon aria-pressed.
  const offOf = (el) => {
    if (!el) return null;
    const flag = el.getAttribute('data-is-muted');
    if (flag === 'true' || flag === 'false') return flag === 'true';
    const label = labelOf(el);
    if (/(unmute|r[eé]activer|\\bactiver|turn on|\\bstart|einschalten|aktivieren|activar|attiva|inschakelen|ativar)/i.test(label)) return true;
    if (/(\\bmute|couper|d[eé]sactiver|turn off|\\bstop|ausschalten|desactivar|disattiva|uitschakelen|desativar)/i.test(label)) return false;
    return null;
  };
  const one = (el) => (el ? { available: true, off: offOf(el) } : { available: false, off: null });
  return {
    liveMedia,
    video,
    videoPip: Boolean(document.pictureInPictureElement),
    controls: {
      microphone: one(findControl('microphone')),
      camera: one(findControl('camera')),
      hangup: Boolean(findControl('hangup')),
    },
  };
})()`;

const CALL_CONTROLS = Object.freeze(['microphone', 'camera', 'hangup']);

/** Clic sur le bouton d'appel demandé (`microphone` | `camera` | `hangup`). */
function callControlScript(control) {
  if (!CALL_CONTROLS.includes(control)) return null;
  return `(() => {
  ${FIND_CALL_CONTROLS_SOURCE}
  const el = findControl(${JSON.stringify(control)});
  if (!el) return { ok: false, error: 'not-found' };
  el.click();
  return { ok: true };
})()`;
}

/**
 * Incrustation de la plus grande vidéo qui lit (ou de la vidéo sous le clic droit, `point`).
 * Lancé avec un geste utilisateur (`executeJavaScript(code, true)`) : la page n'a pas à l'avoir demandé.
 */
function videoPipEnterScript(point = null) {
  const x = point && Number.isFinite(point.x) ? Math.round(point.x) : null;
  const y = point && Number.isFinite(point.y) ? Math.round(point.y) : null;
  return `(async () => {
  if (!document.pictureInPictureEnabled) return { ok: false, error: 'unsupported' };
  const videos = [...document.querySelectorAll('video')].filter((v) => !v.disablePictureInPicture && v.readyState >= 1 && v.videoWidth > 0);
  let target = null;
  const x = ${JSON.stringify(x)}, y = ${JSON.stringify(y)};
  if (x !== null && y !== null) {
    target = videos.find((v) => { const r = v.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }) || null;
  }
  if (!target) {
    const area = (v) => v.clientWidth * v.clientHeight;
    const playing = videos.filter((v) => !v.paused && !v.ended);
    target = (playing.length ? playing : videos).sort((a, b) => area(b) - area(a))[0] || null;
  }
  if (!target) return { ok: false, error: 'no-video' };
  try {
    await target.requestPictureInPicture();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.name) || 'failed' };
  }
})()`;
}

const VIDEO_PIP_EXIT_SCRIPT = `(async () => {
  if (!document.pictureInPictureElement) return { ok: true, active: false };
  try { await document.exitPictureInPicture(); } catch (_) {}
  return { ok: true, active: false };
})()`;

/** Appel en cours : micro ou caméra accordés à la page, et un flux vivant lu par la page. */
function isInCall({ capturingMedia, probe }) {
  return Boolean(capturingMedia && probe && probe.liveMedia);
}

/**
 * Incrustation automatique d'un onglet qu'on quitte (autre onglet, page du portail, autre app) :
 * - `call` : appel en cours (fenêtre flottante native) ;
 * - `video` : une vidéo lit, avec du son (comme Chrome : pas une vidéo muette en fond de page) ;
 * - null : rien (réglage coupé, déjà en incrustation).
 */
function autoPipKind({ enabled, inCall, probe, audible, alreadyFloating }) {
  if (!enabled || alreadyFloating) return null;
  if (inCall) return 'call';
  if (probe && probe.video && !probe.videoPip && audible) return 'video';
  return null;
}

/** État des contrôles affiché par la fenêtre flottante (sans le DOM). */
function floatControlsState(probe) {
  const controls = (probe && probe.controls) || {};
  const one = (c) => ({ available: Boolean(c && c.available), off: c && typeof c.off === 'boolean' ? c.off : null });
  return {
    microphone: one(controls.microphone),
    camera: one(controls.camera),
    hangup: Boolean(controls.hangup),
  };
}

/** Textes de la fenêtre flottante : fournis par le portail (langue de la personne), français par défaut. */
const DEFAULT_PIP_TEXTS = Object.freeze({
  backToTab: "Revenir à l'onglet",
  microphoneOff: 'Activer le micro',
  microphoneOn: 'Couper le micro',
  cameraOff: 'Activer la caméra',
  cameraOn: 'Couper la caméra',
  hangup: 'Raccrocher',
  close: "Fermer l'incrustation",
  inCall: 'En appel',
});

function normalizePipTexts(raw) {
  const out = { ...DEFAULT_PIP_TEXTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_PIP_TEXTS)) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() && value.length <= 80) out[key] = value.trim();
  }
  return out;
}

/** Taille et place de la fenêtre flottante : en bas à droite de l'écran, gardées dans la zone de travail. */
const FLOAT_DEFAULT_SIZE = Object.freeze({ width: 400, height: 260 });
const FLOAT_MIN_SIZE = Object.freeze({ width: 260, height: 180 });
const FLOAT_MARGIN = 16;

function floatBounds(workArea, previous = null) {
  const area = workArea || { x: 0, y: 0, width: 1440, height: 900 };
  const width = Math.min(area.width, Math.max(FLOAT_MIN_SIZE.width, (previous && previous.width) || FLOAT_DEFAULT_SIZE.width));
  const height = Math.min(area.height, Math.max(FLOAT_MIN_SIZE.height, (previous && previous.height) || FLOAT_DEFAULT_SIZE.height));
  let x = previous && Number.isFinite(previous.x) ? previous.x : area.x + area.width - width - FLOAT_MARGIN;
  let y = previous && Number.isFinite(previous.y) ? previous.y : area.y + area.height - height - FLOAT_MARGIN;
  x = Math.min(Math.max(area.x, x), area.x + area.width - width);
  y = Math.min(Math.max(area.y, y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

module.exports = {
  PIP_WORLD_ID,
  CALL_CONTROLS,
  PAGE_MEDIA_PROBE_SCRIPT,
  VIDEO_PIP_EXIT_SCRIPT,
  DEFAULT_PIP_TEXTS,
  FLOAT_DEFAULT_SIZE,
  FLOAT_MIN_SIZE,
  callControlScript,
  videoPipEnterScript,
  isInCall,
  autoPipKind,
  floatControlsState,
  normalizePipTexts,
  floatBounds,
};
