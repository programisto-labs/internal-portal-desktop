'use strict';

/**
 * Pages de test et scénarios du banc des actions d'agent (scripts/agent-actuation-bench.js). Chaque scénario
 * joue ce qu'un agent ferait (lire, trouver l'élément par son nom, agir, suivre l'indication d'une erreur),
 * puis vérifie l'effet dans la page.
 */

const page = (title, body, script = '') =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:20px} .box{height:120px;overflow:auto;border:1px solid #999} .spacer{height:900px}</style>
</head><body>${body}<script>window.__r = {};${script}</script></body></html>`;

const FIXTURES = {
  basic: page('Basique', `<h1>Commande</h1><button onclick="__r.clicked = event.isTrusted">Continuer</button>`),

  'shadow-closed': page(
    'Shadow',
    `<h1>Composant</h1><lasco-widget></lasco-widget>`,
    `customElements.define('lasco-widget', class extends HTMLElement { connectedCallback() {
      const root = this.attachShadow({ mode: 'closed' });
      root.innerHTML = '<label>Ville <input id="city"></label><button>Valider la ville</button>';
      root.querySelector('button').addEventListener('click', (e) => { __r.city = root.querySelector('input').value; __r.trusted = e.isTrusted; });
    }});`
  ),

  iframe: page(
    'Cadre',
    `<h1>Inscription</h1><iframe id="f" style="width:500px;height:200px" srcdoc="<label>Prénom <input id=n></label><button onclick=&quot;parent.__r.name=document.getElementById('n').value&quot;>Suivant</button>"></iframe>`
  ),

  covered: page(
    'Bannière',
    `<h1>Article</h1><button id="t" onclick="__r.target = true">Lire la suite</button>
     <div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div style="background:#fff;margin:200px auto;width:300px;padding:20px">
       Nous utilisons des cookies. <button onclick="__r.cookies='accepted';document.getElementById('banner').remove()">Tout accepter</button>
       <button onclick="__r.cookies='refused';document.getElementById('banner').remove()">Continuer sans accepter</button></div></div>`
  ),

  async: page(
    'Chargement',
    `<h1>Résultats</h1><button onclick="load()">Charger les résultats</button><ul id="list"></ul>`,
    `async function load(){ const r = await fetch('/api/slow'); const d = await r.json(); for (const i of d.items) { const li = document.createElement('li'); li.textContent = 'Résultat ' + i; document.getElementById('list').appendChild(li); } }`
  ),

  'scroll-container': page(
    'Défilement',
    `<h1>Liste</h1><div class="box"><div style="height:600px">…</div><button onclick="__r.bottom = true">Tout en bas</button></div>`
  ),

  'custom-select': page(
    'Liste personnalisée',
    `<h1>Pays</h1><div role="combobox" aria-expanded="false" aria-label="Pays" tabindex="0" id="cb" onclick="document.getElementById('lb').hidden=false;this.setAttribute('aria-expanded','true')">Choisir…</div>
     <div role="listbox" id="lb" hidden><div role="option" onclick="__r.country='FR';document.getElementById('lb').hidden=true">France</div><div role="option" onclick="__r.country='BE'">Belgique</div></div>`
  ),

  'native-select': page(
    'Select',
    `<label>Taille <select id="s" onchange="__r.size=this.value"><option value="">—</option><option value="m">Moyenne</option><option value="l">Grande</option></select></label>`
  ),

  contenteditable: page(
    'Éditeur',
    `<h1>Note</h1><div contenteditable="true" role="textbox" aria-label="Corps de la note" id="ed" oninput="__r.text=this.innerText" style="min-height:60px;border:1px solid #999"></div>`
  ),

  'icon-button': page(
    'Icônes',
    `<button aria-label="Ajouter aux favoris" onclick="__r.fav=true"><svg width="16" height="16"><circle cx="8" cy="8" r="6"/></svg></button>`
  ),

  'confirm-unflagged': page(
    'Confirmation',
    `<h1>Brouillon</h1><button onclick="if (confirm('Vraiment ?')) { __r.done = true; }">Nettoyer</button>`
  ),

  confirm: page(
    'Confirmation',
    `<h1>Brouillon</h1><button onclick="if (confirm('Supprimer ce brouillon ?')) { __r.deleted = true; document.title = 'Supprimé'; }">Supprimer le brouillon</button>`
  ),

  upload: page(
    'Dépôt',
    `<h1>Pièce jointe</h1><label>Justificatif <input type="file" id="file" onchange="__r.file=this.files[0]&&this.files[0].name"></label>`
  ),

  sensitive: page(
    'Paiement',
    `<form><label>Numéro de carte <input autocomplete="cc-number" value="4111111111111111"></label>
     <label>Mot de passe <input type="password" value="hunter2"></label>
     <label>Code CVC <input name="cvc" value="123"></label><label>Nom <input name="fullname" value="Alice Martin"></label></form>`
  ),

  'shadow-open-form': page(
    'Formulaire composant',
    `<h1>Contact</h1><contact-form></contact-form>`,
    `customElements.define('contact-form', class extends HTMLElement { connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<label>Votre e-mail <input id="mail" type="email"></label>';
      root.querySelector('input').addEventListener('input', (e) => { __r.mail = e.target.value; });
    }});`
  ),

  disabled: page('Désactivé', `<button disabled onclick="__r.clicked=true">Payer maintenant</button><p>Remplissez le formulaire.</p>`),

  'delayed-nav': page(
    'Départ',
    `<h1>Départ</h1><button onclick="setTimeout(() => { location.href = '/basic' }, 250)">Aller plus loin</button>`
  ),

  'search-vs-comment': page(
    'Formulaires',
    `<form role="search" onsubmit="event.preventDefault(); __r.searched = this.q.value"><input name="q" type="search" aria-label="Rechercher"></form>
     <form onsubmit="event.preventDefault(); __r.comment = this.c.value"><label>Commentaire <input name="c"></label><button>Publier</button></form>`
  ),

  'react-like': page(
    'Contrôlé',
    `<label>Quantité <input id="q"></label><button onclick="__r.qty = window.state">Ajouter</button>`,
    // Comme React : l'état suit les événements input de confiance seulement.
    `window.state = ''; document.getElementById('q').addEventListener('input', (e) => { if (e.isTrusted) window.state = e.target.value; });`
  ),
};

/** Clique sur un élément trouvé par son nom ; si l'outil dit qu'il est recouvert, ferme la bannière et recommence. */
async function clickByName(ctx, role, name, { closeWith = /continuer sans|fermer|refuser/i } = {}) {
  let snapshot = await ctx.driver.snapshot();
  let element = ctx.find(snapshot, role, name);
  if (!element) return { ok: false, error: 'not-found' };
  let result = await ctx.driver.click(element.ref);
  if (!result.ok && result.error === 'element-covered') {
    const closer = (snapshot.elements || []).find((el) => el.role === 'button' && closeWith.test(el.name));
    if (!closer) return result;
    await ctx.driver.click(closer.ref);
    snapshot = await ctx.driver.snapshot();
    element = ctx.find(snapshot, role, name);
    result = element ? await ctx.driver.click(element.ref) : { ok: false, error: 'not-found' };
  }
  return result;
}

async function typeByName(ctx, role, name, text, opts) {
  const snapshot = await ctx.driver.snapshot();
  const element = ctx.find(snapshot, role, name);
  if (!element) return { ok: false, error: 'not-found' };
  return ctx.driver.type(element.ref, text, opts);
}

const read = (ctx, key) => ctx.evaluate(`window.__r[${JSON.stringify(key)}]`);

const SCENARIOS = [
  {
    id: 'basic-click',
    label: 'Clic simple (événement de confiance)',
    fixture: 'basic',
    run: (ctx) => clickByName(ctx, 'button', 'Continuer'),
    check: async (ctx) => ((await read(ctx, 'clicked')) === true ? true : 'pas de clic'),
  },
  {
    id: 'shadow-closed',
    label: 'Shadow DOM fermé : saisie + bouton',
    fixture: 'shadow-closed',
    run: async (ctx) => {
      const typed = await typeByName(ctx, 'textbox', 'Ville', 'Lyon');
      if (!typed.ok) return typed;
      return clickByName(ctx, 'button', 'Valider la ville');
    },
    check: async (ctx) => ((await read(ctx, 'city')) === 'Lyon' ? true : 'ville absente'),
  },
  {
    id: 'iframe',
    label: 'Formulaire dans une iframe',
    fixture: 'iframe',
    run: async (ctx) => {
      const typed = await typeByName(ctx, 'textbox', 'Prénom', 'Alice');
      if (!typed.ok) return typed;
      return clickByName(ctx, 'button', 'Suivant');
    },
    check: async (ctx) => ((await read(ctx, 'name')) === 'Alice' ? true : 'prénom absent'),
  },
  {
    id: 'covered',
    label: 'Bouton sous une bannière cookies',
    fixture: 'covered',
    run: (ctx) => clickByName(ctx, 'button', 'Lire la suite'),
    check: async (ctx) => {
      if ((await read(ctx, 'cookies')) === 'accepted') return 'cookies acceptés par erreur';
      return (await read(ctx, 'target')) === true ? true : 'cible non cliquée';
    },
  },
  {
    id: 'async-content',
    label: 'Contenu chargé après le clic (réseau)',
    fixture: 'async',
    run: (ctx) => clickByName(ctx, 'button', 'Charger les résultats'),
    check: async (ctx) => (/Résultat Gamma/.test((ctx.result && ctx.result.page && ctx.result.page.text) || '') ? true : "résultats absents de l'état renvoyé"),
  },
  {
    id: 'scroll-container',
    label: 'Bouton au fond d’un conteneur qui défile',
    fixture: 'scroll-container',
    run: (ctx) => clickByName(ctx, 'button', 'Tout en bas'),
    check: async (ctx) => ((await read(ctx, 'bottom')) === true ? true : 'pas de clic'),
  },
  {
    id: 'custom-select',
    label: 'Liste personnalisée (role=listbox)',
    fixture: 'custom-select',
    run: async (ctx) => {
      const opened = await clickByName(ctx, 'combobox', 'Pays');
      if (!opened.ok) return opened;
      return clickByName(ctx, 'option', 'France');
    },
    check: async (ctx) => ((await read(ctx, 'country')) === 'FR' ? true : 'pays non choisi'),
  },
  {
    id: 'native-select',
    label: 'Liste <select> native',
    fixture: 'native-select',
    run: async (ctx) => {
      const snapshot = await ctx.driver.snapshot();
      const element = ctx.find(snapshot, 'combobox', 'Taille');
      return element ? ctx.driver.select(element.ref, 'Grande') : { ok: false, error: 'not-found' };
    },
    check: async (ctx) => ((await read(ctx, 'size')) === 'l' ? true : 'taille non choisie'),
  },
  {
    id: 'contenteditable',
    label: 'Éditeur contenteditable',
    fixture: 'contenteditable',
    run: (ctx) => typeByName(ctx, 'textbox', 'Corps de la note', 'Bonjour'),
    check: async (ctx) => (/Bonjour/.test((await read(ctx, 'text')) || '') ? true : 'texte absent'),
  },
  {
    id: 'icon-button',
    label: 'Bouton icône (aria-label)',
    fixture: 'icon-button',
    run: (ctx) => clickByName(ctx, 'button', 'Ajouter aux favoris'),
    check: async (ctx) => ((await read(ctx, 'fav')) === true ? true : 'pas de clic'),
  },
  {
    id: 'confirm-dialog',
    label: 'Suppression avec confirm()',
    fixture: 'confirm',
    run: async (ctx) => {
      // « Supprimer » est validé par la personne : la confirmation qu'il ouvre est acceptée avec lui.
      const first = await clickByName(ctx, 'button', 'Supprimer le brouillon');
      const dialog = first && first.page && first.page.dialog;
      if (!dialog || dialog.handled === 'accepted') return first;
      // Confirmation refusée (action non validée) : l'agent la fait valider et rejoue le clic.
      const planned = await ctx.driver.dialog({ accept: true, message: dialog.message });
      if (!planned.ok) return planned;
      return clickByName(ctx, 'button', 'Supprimer le brouillon');
    },
    check: async (ctx) => {
      if ((await read(ctx, 'deleted')) !== true) return 'non supprimé';
      return ctx.driver !== 'cdp' || ctx.approvals.length >= 1 ? true : 'suppression sans validation';
    },
  },
  {
    id: 'confirm-unflagged',
    label: 'confirm() ouvert par un bouton ordinaire',
    fixture: 'confirm-unflagged',
    run: async (ctx) => {
      const first = await clickByName(ctx, 'button', 'Nettoyer');
      const dialog = first && first.page && first.page.dialog;
      if (!dialog) return first;
      if (dialog.handled === 'accepted') return { ok: false, error: 'accepted-without-approval' };
      const planned = await ctx.driver.dialog({ accept: true, message: dialog.message });
      if (!planned.ok) return planned;
      return clickByName(ctx, 'button', 'Nettoyer');
    },
    check: async (ctx) => {
      if ((await read(ctx, 'done')) !== true) return 'non fait';
      return ctx.driver !== 'cdp' || ctx.approvals.includes('dialog_accept') ? true : 'confirmation acceptée sans validation';
    },
  },
  {
    id: 'upload',
    label: 'Dépôt de fichier',
    fixture: 'upload',
    needsFile: true,
    run: async (ctx) => {
      const snapshot = await ctx.driver.snapshot();
      const element = (snapshot.elements || []).find((el) => el.file || /justificatif/i.test(el.name));
      return element ? ctx.driver.upload(element.ref, ctx.uploadFile) : { ok: false, error: 'not-found' };
    },
    check: async (ctx) => {
      if ((await read(ctx, 'file')) !== 'devis.pdf') return 'fichier absent';
      return ctx.approvals.includes('upload') ? true : 'dépôt sans validation';
    },
  },
  {
    id: 'sensitive-read',
    label: 'Carte, mot de passe, CVC jamais lus',
    fixture: 'sensitive',
    run: (ctx) => ctx.driver.snapshot(),
    check: async (ctx) => {
      const dump = JSON.stringify(ctx.result || {});
      if (/4111111111111111|hunter2|"123"/.test(dump)) return 'valeur sensible lue';
      return /Alice Martin/.test(dump) ? true : 'champ ordinaire non lu';
    },
  },
  {
    id: 'sensitive-type',
    label: 'Saisie refusée dans un champ carte',
    fixture: 'sensitive',
    run: (ctx) => typeByName(ctx, 'textbox', 'Numéro de carte', '5555444433331111'),
    check: async (ctx) => {
      const value = await ctx.evaluate(`document.querySelector('[autocomplete=cc-number]').value`);
      return value === '4111111111111111' && ctx.result && ctx.result.error === 'sensitive-field' ? true : 'champ carte rempli';
    },
  },
  {
    id: 'shadow-open-input',
    label: 'Champ dans un shadow DOM ouvert',
    fixture: 'shadow-open-form',
    run: (ctx) => typeByName(ctx, 'textbox', 'Votre e-mail', 'a@b.fr'),
    check: async (ctx) => ((await read(ctx, 'mail')) === 'a@b.fr' ? true : 'e-mail absent'),
  },
  {
    id: 'disabled-button',
    label: 'Bouton désactivé signalé (pas de faux succès)',
    fixture: 'disabled',
    run: (ctx) => clickByName(ctx, 'button', 'Payer maintenant'),
    check: async (ctx) => (ctx.result && ctx.result.ok === false && ctx.result.error === 'disabled' ? true : 'succès annoncé à tort'),
  },
  {
    id: 'delayed-navigation',
    label: 'Navigation lancée après le clic',
    fixture: 'delayed-nav',
    run: (ctx) => clickByName(ctx, 'button', 'Aller plus loin'),
    check: async (ctx) => (ctx.result && ctx.result.page && /\/basic$/.test(ctx.result.page.url) ? true : "ancienne page dans l'état renvoyé"),
  },
  {
    id: 'search-enter',
    label: 'Entrée dans une recherche : sans validation',
    fixture: 'search-vs-comment',
    run: (ctx) => typeByName(ctx, 'searchbox', 'Rechercher', 'chaussures', { submit: true }),
    check: async (ctx) => {
      if ((await read(ctx, 'searched')) !== 'chaussures') return 'recherche non lancée';
      return ctx.approvals.length === 0 ? true : 'validation demandée pour une recherche';
    },
  },
  {
    id: 'comment-submit',
    label: 'Publier un commentaire : validation',
    fixture: 'search-vs-comment',
    run: async (ctx) => {
      const typed = await typeByName(ctx, 'textbox', 'Commentaire', 'Merci !');
      if (!typed.ok) return typed;
      return clickByName(ctx, 'button', 'Publier');
    },
    check: async (ctx) => {
      if ((await read(ctx, 'comment')) !== 'Merci !') return 'commentaire non publié';
      return ctx.driver !== 'cdp' || ctx.approvals.includes('form_submit') ? true : 'publication sans validation';
    },
  },
  {
    id: 'react-like-input',
    label: 'Champ contrôlé (événements de confiance)',
    fixture: 'react-like',
    run: async (ctx) => {
      const typed = await typeByName(ctx, 'textbox', 'Quantité', '3');
      if (!typed.ok) return typed;
      return clickByName(ctx, 'button', 'Ajouter');
    },
    check: async (ctx) => ((await read(ctx, 'qty')) === '3' ? true : 'état non mis à jour'),
  },
];

module.exports = { FIXTURES, SCENARIOS };
