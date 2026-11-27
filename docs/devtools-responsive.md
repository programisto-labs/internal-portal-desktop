# Mode responsive des DevTools (onglets web)

Electron n'a pas le mode appareil de Chrome (barre « Dimensions: Responsive », ⌘⇧M). Lasco
Desktop ajoute à la place un onglet **Responsive** aux DevTools des onglets web.

## Pourquoi pas le mode appareil natif

Dans Chrome et Brave, le mode appareil fait partie des DevTools :

- **DevTools ancrés** : la page est posée dans une zone que les DevTools dessinent (fond gris,
  règles). C'est `setInspectedPageBounds`, puis `Emulation.setDeviceMetricsOverride` avec
  `dontSetVisibleSize`.
- **DevTools détachés** : Chrome ouvre dans l'onglet une seconde page DevTools, la
  « toolbox », qui affiche la barre d'appareil.

Electron n'a pas cette toolbox : en mode détaché, le bouton ne fait rien
([electron/electron#28463](https://github.com/electron/electron/issues/28463), ouvert). Lasco
ouvre ses DevTools en mode `detach`, qui masque le bouton (`can_dock` vide).

On ne peut pas non plus les ancrer : dans un `WebContentsView`, des DevTools ancrés figent la
taille de la page. Elle ne suit plus les redimensionnements de l'onglet, même après la
fermeture des DevTools (constaté sur Electron 44).

## Utilisation

DevTools d'un onglet web (menu ☰ ou clic droit > Inspecter), onglet **Responsive** (derrière
`»` si la fenêtre est étroite) :

- **Appareil** : iPhone SE, iPhone 15 Pro / Pro Max, Pixel 8, Galaxy S24, iPad Mini,
  iPad Pro 13", Laptop, Desktop HD, ou « Responsive » (largeur × hauteur libres, 50 à 4000 px).
- **Pivoter**, **Type** (Mobile tactile / Ordinateur), **Densité (DPR)**, **Zoom** (Ajuster ou
  25 à 200 %, jamais plus grand que la place disponible).
- Toute modification active le mode ; le bouton de gauche l'active ou le coupe.
- Fermer les DevTools rend la page à tout l'onglet (comme Chrome).

Le throttling réseau et CPU est déjà dans les DevTools (Network, Performance) ; l'émulation des
préférences CSS (thème, mouvement réduit) dans ⌘⇧P > « Show Rendering ».

## Ce que fait Desktop

- La vue de l'onglet prend la taille de l'appareil, comme dans Chrome. Elle est centrée sur un
  fond gris, avec une marge de 16 px. Ce fond est une petite page statique, sans JavaScript, qui
  suit le thème du système ; elle n'existe que pendant l'émulation. La page ne déborde jamais sur la barre
  d'adresse ni sur la colonne Lasco AI.
- Émulation par le protocole DevTools (`webContents.debugger`, gardée d'une navigation à
  l'autre, même vers un autre site) : `Emulation.setDeviceMetricsOverride` (taille, densité,
  mobile, échelle, orientation, `dontSetVisibleSize` comme Chrome), `setTouchEmulationEnabled` + `setEmitTouchEventsForMouse`
  (mobile), `setUserAgentOverride` (Safari pour iPhone / iPad, Chrome Android pour Pixel /
  Galaxy). Couper le mode rend l'identité Chrome de bureau de Lasco (`chromeUserAgentOverride`).
- `webContents.enableDeviceEmulation` n'est pas utilisé : il est perdu à chaque navigation.
- Les en-têtes `Sec-CH-UA-*` posés par la session restent ceux du bureau.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/browser-tabs/devtools-extension/` | Extension MV3 sans service worker. `devtools_page` crée l'onglet. `panel.*` porte l'interface (fr / en selon la langue). `devices.json` liste les appareils, densités et zooms, lue aussi par Desktop |
| `src/browser-tabs/devtools-responsive.js` | Chargement de l'extension (une fois par session), écoute du panneau, contrôleur d'un onglet (vue, fond, commandes CDP) |
| `src/browser-tabs/responsive.js` | Validation des réglages, placement, identités (fonctions pures, `scripts/test-responsive.js`) |
| `src/browser-tabs/manager.js` | `applyBounds`, fond sous la vue, coupure à `devtools-closed` |

Parcours, dans un seul sens :

1. Le panneau garde ses réglages.
2. À chaque changement, il écrit `__lasco_responsive__{ "op": "set", "settings": … }` ou
   `{ "op": "off" }` dans sa console (`console.debug`).
3. Desktop lit l'événement `console-message` des DevTools de l'onglet, seulement pendant qu'ils
   sont ouverts.

Le panneau commence désactivé à chaque ouverture des DevTools : leur fermeture coupe le mode.

## Coût

Rien ne tourne quand le panneau ne sert pas :

- pas de service worker ;
- aucun script injecté dans les pages ni dans les service workers des sites ;
- pas de relevé périodique.

Charger l'extension ne lance aucun processus. L'écoute existe seulement pendant que les DevTools
d'un onglet sont ouverts. Le fond gris est le seul processus ajouté, et seulement pendant
l'émulation.

## Sécurité

- **Session** : l'extension n'est chargée que dans la session des onglets web
  (`persist:browser-tabs`), jamais dans celle du portail.
- **Origine des messages** : Desktop ne prend que les messages dont le cadre a l'origine de
  l'extension (`chrome-extension://<id>`), dans les DevTools de cet onglet. Une page web n'écrit
  jamais dans la console des DevTools. Ses `console.log` passent par le protocole et ne sont
  qu'affichés.
- **Onglet visé** : c'est celui des DevTools, le panneau ne le nomme pas.
- **Contenu des messages** : longueur bornée, seuls `set` et `off` sont acceptés. Les réglages
  sont validés et bornés par `normalizeResponsiveSettings`.
- **Empaquetage** : l'extension est hors de l'archive asar (`asarUnpack`), car Chromium ne lit
  pas dans l'asar.
