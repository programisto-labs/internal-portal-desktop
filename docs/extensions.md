# Extensions Chrome des onglets web

Lasco Desktop charge des extensions Chrome (Manifest V3) dans les **onglets web** du navigateur
intégré, comme Chrome, Brave ou Edge : 1Password, uBlock Origin Lite, Grammarly, React DevTools, Loom…

> Statut : note de design (v1), à jour de l'implémentation de la branche `feat/chrome-extensions`.

## Règles

- **Jamais dans Lasco.** Les extensions sont chargées dans la session des onglets web d'un profil
  (`persist:browser-tabs`, ou la session d'un profil de workspace), jamais dans `persist:portal` :
  la coquille et les pages du portail ne les voient pas. En plus, chaque script de contenu reçoit
  les adresses de Lasco en `exclude_matches` (manifeste effectif, voir plus bas), et les règles
  `declarativeNetRequest` ne s'appliquent jamais à une adresse de Lasco.
- **Par profil.** Une extension est installée dans un profil (une session) ; un autre profil ne la
  voit pas. Fichiers : `userData/extensions/<profil>/` ; profil par défaut : `default`.
- **Jamais en navigation privée** (sessions en mémoire : Electron ne le permet pas, et Chrome ne
  le fait pas par défaut).
- **Politique du workspace** : la coquille envoie la politique de l'administrateur
  (`setPolicy`) : extensions bloquées, ou liste autorisée seule. Une extension bloquée n'est ni
  installable ni chargée ; elle reste sur le disque et revient si la politique change.
- **Paquets vérifiés.** Un CRX du Chrome Web Store n'est installé que si sa signature CRX3 est
  valide pour l'identifiant annoncé **et** porte la preuve de publication du Web Store (clé de
  Google, comme Chrome). Archive décompressée sans chemin sortant (`..`, absolu, lien).

## Bibliothèques : pourquoi un mélange

Electron (44) charge les extensions MV3 (service worker, scripts de contenu, `chrome.storage`,
`chrome.scripting`, `chrome.runtime`, `chrome.i18n`, DevTools), mais ne connaît ni les onglets ni
les fenêtres de l'application, ni le bouton d'action, ni `declarativeNetRequest`.

| Besoin | Choix | Pourquoi |
|---|---|---|
| `chrome.tabs`, `windows`, `action` (popup), `contextMenus`, `cookies`, `notifications`, `webNavigation`, `runtime.connectNative` | **`electron-chrome-extensions`** (MIT, épinglée) | Couverture large et maintenue ; branchée sur notre modèle d'onglets par ses rappels (`createTab`, `selectTab`, `removeTab`, `createWindow`…). Réécrire ces APIs coûterait des mois pour un résultat moins testé. |
| Page du Chrome Web Store (« Ajouter à Lasco ») | **script de page** d'`electron-chrome-web-store` (MIT), **gestionnaires à nous** | Le script émule `chrome.webstorePrivate` pour la page du store (seulement sur `chromewebstore.google.com`). Son installateur ne vérifie pas la signature des CRX et installe sans demander : on garde la page, on remplace l'installation. |
| Téléchargement, vérification, mises à jour | **maison** (`src/extensions/crx.js`, `updater.js`) | Vérification CRX3 complète, preuve du Web Store, mises à jour avec nouvelles autorisations retenues jusqu'à l'accord de la personne, comme Chrome. |
| `declarativeNetRequest` | **maison** (`src/extensions/dnr/`) | Absent d'Electron, indispensable à uBlock Origin Lite et à tout bloqueur MV3. Appliqué dans la chaîne `webRequest` de la session (`web-request-hub.js`), avec le bloqueur de Lasco. |
| `chrome.identity` | **maison**, partiel | `launchWebAuthFlow` et `getRedirectURL` (fenêtre de connexion, retour sur `https://<id>.chromiumapp.org/`). `getAuthToken` (compte Google du navigateur) : impossible hors Chrome, erreur explicite. |
| Barre d'outils, popups, gestion | **coquille du portail** + pont `lascoDesktop.browserExtensions` | La barre d'outils est dans la coquille (React) : on ne reprend pas `<browser-action-list>` (protocole `crx://` à ouvrir dans `persist:portal`). Desktop envoie l'état (icônes en data URL, badge, titre) ; la popup est une fenêtre native ancrée sous le bouton. |

### Limite d'Electron : un seul écouteur `webRequest` par session

La session des onglets web a déjà des écouteurs (`onBeforeRequest` du bloqueur, en-têtes du client) :
Electron n'appelle alors plus les écouteurs `chrome.webRequest` des extensions. Les extensions MV3
n'en ont plus besoin pour bloquer (`declarativeNetRequest`), mais une extension MV3 qui *observe*
les requêtes (`webRequest` sans blocage) ne reçoit rien. `web-request-hub.js` rassemble les
écouteurs de Lasco par événement (une seule inscription auprès d'Electron).

## Accès aux sites

Comme Chrome : **Au clic**, **Sur certains sites**, **Sur tous les sites** (défaut : ce que
demande l'extension). Electron accorde au chargement les hôtes du manifeste : Desktop charge donc
un **manifeste effectif**, écrit à côté de l'original (`manifest.lasco-original.json`) :
`host_permissions` et `matches` des scripts de contenu réduits aux sites accordés, adresses de
Lasco exclues. Changer l'accès recharge l'extension. « Au clic » : l'accès au site de l'onglet est
accordé jusqu'à la navigation suivante (`activeTab`) quand la personne clique sur l'extension.

Une extension décompressée (mode développeur) est chargée depuis son dossier sans réécriture :
accès tel que déclaré, adresses de Lasco toujours exclues des règles réseau.

## Installation

1. Page du store (« Ajouter à Lasco »), identifiant ou adresse du store saisi dans la page
   Extensions, ou dossier décompressé (mode développeur).
2. Politique du workspace vérifiée, manifeste lu (depuis la page du store, puis le CRX).
3. **Demande d'autorisation** : la coquille de la fenêtre affiche « Ajouter « X » ? » avec les
   avertissements traduits (`permissionWarnings`) ; sans coquille récente, boîte native.
4. CRX téléchargé (`clients2.google.com/service/update2/crx`), vérifié, décompressé dans
   `userData/extensions/<profil>/<id>/<version>_0`, manifeste effectif écrit, extension chargée.
5. Épinglée dans la barre si elle a un bouton d'action (comme Chrome : non épinglée ; épinglée par
   défaut chez nous quand elle est la seule, voir `pinByDefault`).

Mises à jour : au démarrage (après 30 s) puis toutes les 5 h, protocole Omaha (JSON) du store.
Une mise à jour qui demande de nouvelles autorisations désactive l'extension (« Nouvelles
autorisations demandées ») jusqu'à l'accord.

## Pont `lascoDesktop.browserExtensions`

Exposé à la coquille seulement (cadre principal de la fenêtre principale ou détachée).

| Méthode | Rôle |
|---|---|
| `list()` | `{ profile, developerMode, policy, extensions: [ExtensionInfo] }` |
| `getActions({ tabId })` | boutons d'action de l'onglet : `{ id, name, title, icon, badgeText, badgeColor, pinned, hasPopup, siteAccess }` |
| `activateAction({ id, tabId, anchor })` | clic sur le bouton (popup ancrée sous `anchor`, ou `action.onClicked`) |
| `install({ idOrUrl })` / `installUnpacked()` / `uninstall({ id })` | installer, désinstaller |
| `setEnabled`, `setPinned`, `setSiteAccess({ id, mode, sites })`, `setDeveloperMode` | gestion |
| `openOptions({ id })`, `openStore()`, `checkForUpdates()` | |
| `respondInstall({ requestId, accept })` | réponse à une demande d'autorisation |
| `setPolicy({ mode, allowedIds, blockedIds })` | politique du workspace |
| `onChange(cb)`, `onInstallRequest(cb)` | événements |

`ExtensionInfo` : `id, name, version, description, icon, source ('store'|'unpacked'), enabled,
disabledReason ('user'|'policy'|'permissions'|'error'), pinned, hasAction, permissions,
hostPermissions, permissionWarnings, siteAccess, sites, optionsUrl, storeUrl, error`.

## Tests

- `scripts/test-extensions-crx.js` : CRX3 valides et falsifiés (signature, identifiant, preuve du
  store absente), archive avec chemin sortant.
- `scripts/test-extensions-dnr.js` : règles (block, allow, allowAllRequests, redirect,
  upgradeScheme, modifyHeaders), priorités, domaines, types de ressources, `regexFilter`.
- `scripts/test-extensions-registry.js` : registre par profil, politique, manifeste effectif.
- `scripts/smoke-extensions.js` (Electron, réseau) : installe la sélection de référence dans un
  profil temporaire et relève ce qui fonctionne.

## Sélection de référence

Relevé de `scripts/smoke-extensions.js` (Electron 44.5.1, Chromium 152), 28/11/2026 :

| Extension | Installation (CRX3 vérifié) | Ce qui marche | Limites connues |
|---|---|---|---|
| uBlock Origin Lite | oui | 19 057 règles DNR actives, publicité bloquée / neutralisée, popup d'action, page d'options | service worker : plantait sur le `browser` partiel d'Electron (corrigé, à revérifier) ; `userScripts` et `offscreen` absents d'Electron (filtrage cosmétique avancé) |
| Grammarly | oui | service worker, script de contenu (`grammarly-desktop-integration` dans la page), bouton | `identity.getAuthToken` absent (connexion par le site de Grammarly) ; `sidePanel` absent |
| React Developer Tools | oui | service worker, crochet `__REACT_DEVTOOLS_GLOBAL_HOOK__`, bouton | panneau DevTools à vérifier à la main |
| Loom | oui | chargée, service worker, bouton | capture d'écran (`desktopCapture`, `tabCapture`) non fournie par Electron : enregistrement probablement impossible |
| 1Password | oui | chargée, bouton, 1 règle DNR | intégration à l'app 1Password (messagerie native) : 1Password vérifie la signature du navigateur, Lasco n'est pas reconnu ; connexion dans l'extension seule à vérifier |

Page du Chrome Web Store : derrière l'écran de consentement de Google, « Ajouter à Lasco » reste à vérifier à la main.
