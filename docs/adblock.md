# Bloqueur de pubs et de traqueurs (onglets web)

Comme les boucliers de Brave : les onglets web de Lasco bloquent les publicités et les traqueurs, sans extension.

## Ce qui est bloqué

- **Moteur** : [`@ghostery/adblocker`](https://github.com/ghostery/adblocker) (version figée dans `package.json`).
- **Listes** : `adsAndTrackingLists` de Ghostery, soit EasyList, EasyPrivacy, la liste de Peter Lowe et les listes uBlock Origin (filtres, confidentialité, abus de ressources, correctifs).
- **Filtres réseau** : requête annulée (`cancel`) ou remplacée par une ressource neutre (`redirect`, ex. un `gtag.js` vide) dans `session.webRequest.onBeforeRequest`.
- **Filtres cosmétiques** : script de cadre de Ghostery (`@ghostery/adblocker-electron-preload`, enregistré par `session.registerPreloadScript`) qui demande au processus principal les styles et scriptlets de la page (`ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters')`).
- Jamais : la page elle-même (`mainFrame`), une requête sans onglet (service worker), les filtres `$csp` (l'événement `onHeadersReceived` de la session sert déjà aux Client Hints, `chrome-identity.js`).

## Où il s'applique

- Session des onglets web seulement (`persist:browser-tabs`, `getBrowserSession()` de `src/browser-tabs/manager.js`). Jamais `persist:portal`, ni la coquille, ni les fenêtres de Lasco.
- **Pages Lasco jamais filtrées**, même ouvertes dans un onglet web : `isPortalNavigationUrl` / `isApiHostNavigationUrl` de `main.js` (portail, `*.lascoapp.com`, `*.programisto.fr`, API ; `localhost` en dev). Ni la page, ni ses requêtes.
- Le script cosmétique ne répond qu'aux onglets web déclarés par un gestionnaire d'onglets (`trackTab`) de cette session.

## Listes : cache disque, une mise à jour par jour

- `userData/adblock/engine.bin` (moteur sérialisé) et `engine.json` (`{ version, fetchedAt }`).
- Démarrage : rien n'est attendu. À la création du premier onglet web, le cache est relu en asynchrone (~10 ms de désérialisation) ; tant qu'il n'est pas chargé, rien n'est bloqué.
- Pas de cache, cache de plus de 24 h ou d'une autre version du moteur : téléchargement et compilation dans un **worker thread** (`src/browser-tabs/adblock-worker.js`, ~1 s), puis le nouveau moteur remplace l'ancien sans redémarrage.
- Échec (hors ligne) : l'ancien moteur reste ; nouvel essai au plus tôt une heure plus tard. Vérification toutes les heures pour une app ouverte des jours durant.

## Réglages et exceptions

- `userData/browser-adblock.json` : `{ version: 1, enabled: true, allowedOrigins: ["https://exemple.fr"] }`.
- **Interrupteur global**, activé par défaut : Lasco > Réglages… > Bloqueur de pubs.
- **Exception par site** (origine, comme les autorisations des sites) : le bloqueur est coupé sur ce site. Posée depuis les informations du site du portail ; retirée là, ou dans Réglages > Bloqueur de pubs > Sites autorisés.
- « Effacer les données de navigation » ne touche pas aux exceptions.

## Contrat avec le portail

- **État d'un onglet** (`browser-tab-state`) : `adblock: { active, blocked }`. `active` : le bloqueur s'applique à la page (activé, pas d'exception, pas une page Lasco) ; `blocked` : requêtes bloquées depuis le début de la navigation principale (remis à 0 à chaque nouvelle page, pas pour une navigation dans la page). Poussé au plus deux fois par seconde pendant le chargement.
- **Informations du site** (`browserTabs.siteInfo`) : `adblock: { available, enabled, siteEnabled, active, blocked }`. `available` false pour une page Lasco : le portail n'affiche rien.
- `browserTabs.setSiteAdblock({ tabId, enabled })` : `enabled: false` pose l'exception pour le site de l'onglet, `true` la retire. La page est rechargée (comme Brave) si la valeur change. Renvoie les informations du site.
- Pont absent (ancien Desktop) : le portail n'affiche pas la ligne « Bloqueur ».

## Code et tests

- `src/browser-tabs/adblock.js` : réglages, chargement du moteur, filtre réseau, gestionnaires cosmétiques, service partagé par toutes les fenêtres (`sharedAdblock()` de `manager.js`).
- `src/browser-tabs/adblock-worker.js` : téléchargement et compilation.
- Tests : `scripts/test-adblock.js` (vrai moteur Ghostery sur une petite liste).
- `session.webRequest.onBeforeRequest` de la session des onglets web appartient au bloqueur : Electron n'accepte qu'un écouteur par événement. Un autre besoin (anti-phishing…) doit passer par ce filtre, pas en poser un second.
