'use strict';

// Page d'erreur des onglets web (page-errors.js). Tout vient de la query et n'est
// inséré qu'en texte : une adresse ne peut pas injecter de HTML.
(function () {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get('kind') || 'network';
  const rawUrl = params.get('url') || '';
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
  const host = params.get('host') || '';
  const code = params.get('code') || '';
  const message = params.get('message') || '';

  const COPY = {
    crashed: {
      icon: '💥',
      title: 'Cet onglet a planté',
      message: "La page s'est arrêtée de manière inattendue. Rechargez-la pour reprendre.",
      retry: 'Recharger',
    },
    network: {
      icon: '📡',
      title: 'Impossible d’ouvrir cette page',
      message: message || "La page n'a pas pu être chargée.",
      retry: 'Réessayer',
    },
    certificate: {
      icon: '⚠️',
      title: 'Votre connexion n’est pas privée',
      message:
        "Le certificat de ce site n'est pas valide. Quelqu'un pourrait tenter d'intercepter vos informations (mots de passe, messages, cartes bancaires). Lasco n'a pas ouvert la page.",
      retry: '',
    },
  };
  if (kind === 'safe-browsing') {
    renderSafeBrowsing();
    return;
  }
  const copy = COPY[kind] || COPY.network;
  document.body.dataset.kind = kind;
  document.title = host || copy.title;
  document.getElementById('icon').textContent = copy.icon;
  document.getElementById('title').textContent = copy.title;
  document.getElementById('message').textContent = copy.message;

  const detail = document.getElementById('detail');
  if (host) {
    detail.textContent = '';
    detail.append('Site : ');
    const strong = document.createElement('span');
    strong.className = 'host';
    strong.textContent = host;
    detail.append(strong);
  } else {
    detail.hidden = true;
  }
  if (code) {
    const codeEl = document.getElementById('code');
    codeEl.textContent = code;
    codeEl.hidden = false;
  }

  const retry = document.getElementById('retry');
  if (copy.retry && url) {
    retry.textContent = copy.retry;
    retry.href = url;
    retry.hidden = false;
  }
  const back = document.getElementById('back');
  if (window.history.length > 1) {
    back.hidden = false;
    back.addEventListener('click', () => window.history.back());
  }

  /**
   * « Site trompeur » / « logiciels malveillants » (docs/safe-browsing.md). Textes fournis par le
   * portail dans la langue de la personne (`texts`), français sinon. Les boutons ne naviguent pas
   * eux-mêmes : ils posent `#proceed-<jeton>` ou `#back-<jeton>` que Desktop lit et applique.
   */
  function renderSafeBrowsing() {
    const DEFAULTS = {
      phishingTitle: 'Site trompeur',
      phishingMessage:
        'Des pirates sur ce site pourraient tenter de vous inciter à faire quelque chose de dangereux, comme installer un logiciel ou révéler des informations personnelles (mots de passe, numéros de téléphone ou de carte bancaire).',
      phishingDetails:
        "Google Safe Browsing a récemment détecté de l'hameçonnage sur ce site. Les sites d'hameçonnage se font passer pour d'autres sites afin de vous tromper.",
      malwareTitle: 'Ce site contient des logiciels malveillants',
      malwareMessage:
        'Des pirates sur ce site pourraient tenter d’installer sur votre ordinateur des programmes dangereux qui volent ou suppriment vos informations (photos, mots de passe, messages, cartes bancaires).',
      malwareDetails:
        "Google Safe Browsing a récemment détecté des logiciels malveillants sur ce site. Un site habituellement sûr peut parfois être infecté.",
      unwantedTitle: 'Ce site propose des programmes dangereux',
      unwantedMessage:
        'Ce site pourrait tenter de vous faire installer des programmes qui nuisent à votre navigation (page d’accueil modifiée, publicités ajoutées).',
      unwantedDetails: 'Google Safe Browsing a récemment détecté des logiciels indésirables sur ce site.',
      back: 'Retour en lieu sûr',
      showDetails: 'Détails',
      hideDetails: 'Masquer les détails',
      proceed: 'Continuer vers ce site (non recommandé)',
      siteLabel: 'Site :',
    };
    let provided = {};
    try {
      provided = JSON.parse(params.get('texts') || '{}') || {};
    } catch (_) {
      provided = {};
    }
    const text = (key) => (typeof provided[key] === 'string' && provided[key] ? provided[key] : DEFAULTS[key]);
    const threat = ['malware', 'phishing', 'unwanted'].includes(params.get('threat')) ? params.get('threat') : 'malware';
    const token = /^[A-Za-z0-9-]+$/.test(params.get('token') || '') ? params.get('token') : '';

    document.body.dataset.kind = 'safe-browsing';
    document.title = text(`${threat}Title`);
    document.getElementById('icon').textContent = threat === 'phishing' ? '⚠️' : '☣️';
    document.getElementById('title').textContent = text(`${threat}Title`);
    document.getElementById('message').textContent = text(`${threat}Message`);

    const detail = document.getElementById('detail');
    detail.textContent = '';
    if (host) {
      detail.append(`${text('siteLabel')} `);
      const strong = document.createElement('span');
      strong.className = 'host';
      strong.textContent = host;
      detail.append(strong);
    } else {
      detail.hidden = true;
    }

    const gesture = (name) => {
      if (token) window.location.replace(`#${name}-${token}`);
    };
    const safeBack = document.getElementById('safeBack');
    safeBack.textContent = text('back');
    safeBack.hidden = false;
    safeBack.addEventListener('click', () => gesture('back'));
    safeBack.focus();

    const toggle = document.getElementById('toggleDetails');
    const details = document.getElementById('details');
    toggle.textContent = text('showDetails');
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      const open = details.hidden;
      details.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = text(open ? 'hideDetails' : 'showDetails');
    });
    document.getElementById('detailsText').textContent = text(`${threat}Details`);
    const proceed = document.getElementById('proceed');
    proceed.textContent = text('proceed');
    proceed.addEventListener('click', () => gesture('proceed'));
  }
})();
