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
})();
