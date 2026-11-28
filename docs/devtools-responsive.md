# Mode responsive des DevTools (onglets web)

Electron n'a pas le mode appareil de Chrome (barre « Dimensions: Responsive », ⌘⇧M) : son
interface est propre au navigateur Chrome. Lasco Desktop ajoute à la place un onglet
**Responsive** aux DevTools des onglets web.

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

- La vue de l'onglet prend la taille de l'appareil, centrée sur un fond gris (petite vue statique
  qui suit le thème du système), avec une marge de 16 px. La page ne déborde jamais sur la barre
  d'adresse ni sur la colonne Lasco AI.
- Émulation par le protocole DevTools (`webContents.debugger`, gardée d'une navigation à
  l'autre, même vers un autre site) : `Emulation.setDeviceMetricsOverride` (taille, densité,
  mobile, échelle, orientation), `setTouchEmulationEnabled` + `setEmitTouchEventsForMouse`
  (mobile), `setUserAgentOverride` (Safari pour iPhone / iPad, Chrome Android pour Pixel /
  Galaxy). Couper le mode rend l'identité Chrome de bureau de Lasco (`chromeUserAgentOverride`).
- `webContents.enableDeviceEmulation` n'est pas utilisé : il est perdu à chaque navigation.
- Les en-têtes `Sec-CH-UA-*` posés par la session restent ceux du bureau.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/browser-tabs/devtools-extension/` | Extension MV3 : `devtools_page` crée l'onglet, `panel.*` l'interface (fr / en selon la langue), `service-worker.js` relaie les messages |
| `src/browser-tabs/devtools-responsive-preload.js` | Preload des service workers de la session : pose `lascoResponsive.invoke` seulement dans un service worker `chrome-extension:` |
| `src/browser-tabs/devtools-responsive.js` | Chargement de l'extension (une fois par session), canal `lasco-devtools-responsive`, contrôleur d'un onglet (vue, fond, commandes CDP) |
| `src/browser-tabs/responsive.js` | Appareils, validation des réglages, placement, identités (fonctions pures, `scripts/test-responsive.js`) |
| `src/browser-tabs/manager.js` | Route par onglet, `applyBounds`, fond sous la vue, coupure à `devtools-closed` |

Parcours : panneau → `chrome.runtime.sendMessage({ op: 'get' | 'set' | 'off', tabId, settings })`
→ service worker → `ipcRenderer.invoke('lasco-devtools-responsive')` → Desktop → état
`{ ok, active, settings, scale, devices, deviceScaleFactors, zooms }`.

## Sécurité

- L'extension n'est chargée que dans la session des onglets web (sessions des onglets web (`persist:bp-…` par profil et workspace, `persist:browser-tabs` sans profil, docs/browser-profiles.md)), jamais
  dans celle du portail.
- Desktop ne répond qu'au service worker de cette extension (portée vérifiée à chaque appel) ;
  le preload ne pose rien dans les service workers des sites.
- `tabId` = id du webContents inspecté (`chrome.devtools.inspectedWindow.tabId`) : refusé s'il
  n'est pas un onglet web de Lasco ou si ses DevTools sont fermés. Réglages validés et bornés
  par `normalizeResponsiveSettings`.
- Empaquetage : l'extension et le preload sont hors de l'archive asar (`asarUnpack`), Chromium
  ne lit pas dans l'asar.
