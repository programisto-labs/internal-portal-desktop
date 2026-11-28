# Incrustation vidéo et appels (picture-in-picture)

Comme Chrome : une vidéo ou un appel reste visible dans une petite fenêtre au premier plan quand on
change d'onglet ou d'application.

Code : `src/browser-tabs/picture-in-picture.js` (scripts de page et règles, module pur),
`src/browser-tabs/call-float.js` (+ `call-float.html`, `call-float-preload.js` : fenêtre flottante),
`src/browser-tabs/manager.js` (section « Incrustation vidéo et fenêtre d'appel »).

## Ce que sait faire Electron 44 (Chromium 152)

Vérifié dans notre Electron (`npx electron` avec une `WebContentsView` comme celles des onglets) :

| API | Résultat |
| --- | --- |
| `document.pictureInPictureEnabled` | `true` |
| `video.requestPictureInPicture()` (YouTube, Vimeo, toute `<video>`) | fonctionne ; la fenêtre de Chromium reste ouverte quand la vue est détachée (onglet caché) |
| `navigator.mediaSession.setActionHandler('enterpictureinpicture', …)` | accepté, mais jamais appelé (pas d'incrustation automatique dans Electron) |
| `documentPictureInPicture.requestWindow()` (Document PiP, celle de Meet dans Chrome) | **absente** (`'documentPictureInPicture' in window` faux), même avec `enableBlinkFeatures: 'DocumentPictureInPictureAPI'` et `--enable-features=DocumentPictureInPictureAPI` : Electron n'implémente pas la partie navigateur |

Conséquences : Meet n'affiche pas son propre bouton d'incrustation (il le réserve à Document PiP) et ne
s'incruste pas tout seul ; Teams et Zoom web non plus. Lasco fait l'incrustation lui-même.

## Vidéo

- **Bouton** « Image dans l'image » de la barre d'outils du portail, affiché quand une vidéo lit
  (`canPictureInPicture`), et **clic droit** sur une vidéo (« Image dans l'image » / « Quitter l'image dans
  l'image », même pour une vidéo `blob:` comme YouTube ; YouTube garde son propre menu au premier clic droit).
- Lasco appelle `requestPictureInPicture()` sur la vidéo visée (sous le clic droit, sinon la plus grande qui
  lit), avec un geste utilisateur simulé : la page n'a rien à prévoir. Une vidéo `disablePictureInPicture`
  est ignorée.

## Appel : fenêtre flottante de Lasco

Un onglet est **en appel** quand la page a reçu le micro ou la caméra (docs/site-permissions.md) **et** lit
un flux en direct (`srcObject` d'un élément audio / vidéo avec une piste `live`). Le relevé tourne dans le
monde isolé du preload (999), toutes les 2 s pour les onglets qui ont le micro / la caméra ou lisent un
média ; une réunion quittée (Meet garde son adresse) n'est donc plus « en appel ».

La vue de l'onglet (sa `WebContentsView`, jamais rechargée : l'appel continue) est déplacée dans une
fenêtre sans cadre, toujours au premier plan (`floating`), sur tous les bureaux et au-dessus des apps en
plein écran, 400 × 260 en bas à droite de l'écran de Lasco (taille et place retenues pendant la session).
La page s'y met en page à cette taille (Meet affiche alors la personne qui parle). Une barre en bas :

- nom de l'onglet et point vert « En appel » ;
- **micro**, **caméra**, **raccrocher** : seulement si la page expose ces boutons. Sélecteurs connus (Teams
  web `#microphone-button`, `#video-button`, `#hangup-button` ; Zoom web `.join-audio-container__btn`,
  `.send-video-container__btn`, `.footer__leave-btn`), puis libellés (`aria-label`, `data-tooltip`, `title`)
  dans les 7 langues de Lasco ; Meet : boutons qui portent `data-is-muted`. L'état coupé vient de
  `data-is-muted`, sinon du libellé (« Activer le micro » = coupé). Lasco clique le bouton de la page :
  c'est la page qui coupe ou raccroche ;
- **Revenir à l'onglet** : la fenêtre se ferme, Lasco revient au premier plan et le portail sélectionne
  l'onglet (`tab-window-tab-action`, comme la recherche dans les onglets) ;
- **Fermer** (ou Échap) : l'onglet reste en arrière-plan, l'appel continue ; plus d'incrustation
  automatique pour cet onglet tant qu'on n'y est pas revenu.

La fenêtre se ferme aussi quand on revient sur l'onglet, quand l'appel se termine (deux relevés sans flux),
quand l'onglet navigue ailleurs ou se ferme. Pendant qu'elle est ouverte, `setVisible` / `setBounds` de la
vue sont neutralisés côté gestionnaire d'onglets (sélection d'un autre onglet, menus de la coquille) : seule
la fenêtre flottante la place.

## Incrustation automatique

Réglage : Lasco > Réglages… > Général > **Incrustation automatique** (`pictureInPictureAuto`, activé par
défaut ; coupé en mode VM). Quand on quitte un onglet web :

- **autre onglet ou page du portail** (`select`, `hide`) ;
- **autre application** : la fenêtre du portail perd le focus et aucune fenêtre de Lasco ne l'a (250 ms
  plus tard), ou elle est réduite.

alors : appel en cours → fenêtre flottante ; sinon vidéo qui lit **avec du son** (onglet audible et non
coupé, comme Chrome) → incrustation de la vidéo. Au retour (sélection de l'onglet ; retour dans Lasco pour
ce qui a été incrusté en quittant l'app), Lasco referme ce qu'il a ouvert. Une incrustation ouverte par la
personne n'est jamais refermée par Lasco.

## Veille et indicateur

- Un onglet en appel ou incrusté n'est **jamais** mis en veille (docs/tab-sleep.md), même par
  `sleep.now` : raisons `media` et `picture-in-picture`.
- Le portail affiche une caméra verte « En appel » sur l'onglet.

## Pont du portail

`browser-tab-state` porte trois champs de plus :

- `inCall` : appel en cours ;
- `canPictureInPicture` : une vidéo lit ou un appel est en cours ;
- `pictureInPicture` : `'video'` (incrustation de Chromium), `'call'` (fenêtre flottante) ou `null`.

| Méthode | Rôle |
| --- | --- |
| `browserTabs.pictureInPicture({ tabId, action? })` | `toggle` (défaut), `enter`, `exit`. Appel : fenêtre flottante ; sinon la vidéo. → `{ ok, pictureInPicture }` ou `{ ok: false, error: 'unknown-tab' \| 'no-video' \| … }` |
| `browserTabs.setPictureInPictureTexts({ texts })` | textes de la barre dans la langue de la personne : `backToTab`, `microphoneOn`, `microphoneOff`, `cameraOn`, `cameraOff`, `hangup`, `close`, `inCall` (80 caractères au plus ; français sinon) |

Un ancien Desktop n'envoie pas ces champs et n'a pas ces méthodes : le portail n'affiche rien.

## Vérifier

```bash
npx electron scripts/e2e-picture-in-picture.js
```

Vrai gestionnaire d'onglets, faux appel (caméra et micro factices de Chromium), vidéo avec du son :
fenêtre flottante au changement d'onglet et en quittant l'app, boutons de la barre, retour, raccrocher,
veille refusée, incrustation de la vidéo et retour, réglage coupé (32 vérifications). Ouvre des fenêtres
à l'écran quelques secondes. Règles : `scripts/test-picture-in-picture.js` (`npm run test:unit`).

Non vérifié automatiquement : un vrai appel Meet, Teams ou Zoom (compte et réunion nécessaires). Les
sélecteurs des boutons peuvent changer avec ces sites ; un bouton introuvable est simplement masqué.
