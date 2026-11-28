# Sécurité du navigateur de Lasco Desktop

Audit du 28/11/2026 (Lasco 2.12.0) et règles qui en découlent. Lasco Desktop est un navigateur utilisé
au quotidien, et des agents IA y lisent et agissent dans les pages : une faille de Chromium y vaut une
faille de Chrome, avec en plus l'accès à la coquille du portail et aux opérations sur l'ordinateur.

## 1. Electron et Chromium

### État au 28/11/2026

| | Version | Chromium | Publiée |
| --- | --- | --- | --- |
| Lasco 2.12.0 (avant cet audit) | Electron 44.5.1 | 152.0.7977.130 | 29/09/2026 |
| Après cet audit | Electron 44.11.6 | 152.0.7977.169 | 24/11/2026 |
| Dernière ligne stable d'Electron | 45.5.0 | 156.0.8078.109 | 24/11/2026 |
| Chrome stable | | 159.0.8154.34 | 24/11/2026 |

- Lasco avait **8 semaines et ~40 versions de correctif de retard** sur sa propre ligne (44.5.1 → 44.11.6) :
  autant de lots de correctifs de sécurité de Chromium rétroportés par Electron, non livrés.
- Electron suit Chromium avec ~3 versions majeures de décalage par construction et ne maintient que ses
  **3 dernières lignes** (45, 44, 43 aujourd'hui) ; chaque ligne reçoit les correctifs de sécurité de
  Chromium dans ses versions de correctif, en général sous quelques jours après Chrome.
- Conséquence : la bonne cible n'est pas « la Chromium de Chrome » (impossible avec Electron), mais
  **le dernier correctif d'une ligne maintenue**, livré vite.

### Politique

1. **Toute version de correctif d'Electron de la ligne embarquée est livrée dans une release de Lasco
   sous 3 jours** (correctif de sécurité de Chromium présumé : les notes d'Electron ne les signalent pas
   toutes). **Faille exploitée « in the wild » (Chrome la signale dans son billet de version)** :
   release le jour même, puis version minimale relevée (§ 2).
2. **Ligne majeure** : passer à la ligne suivante dans le mois de sa sortie stable ; jamais sur une
   ligne qu'Electron ne maintient plus (le contrôle quotidien échoue).
3. Une montée d'Electron passe par la même CI que le reste (tests unitaires + build macOS empaqueté
   avec ses fusibles) ; une montée de ligne majeure ajoute un essai manuel des onglets web, de Lasco
   Code (node-pty suit l'ABI d'Electron) et des mots de passe.

### Automatisation

- **Dependabot** (`.github/dependabot.yml`) : npm chaque jour, PR groupée `electron` + `electron-updater`,
  préfixe `fix` (release-please en fait une version de correctif de Lasco à la fusion).
- **CI** (`.github/workflows/ci.yml`, nouvelle) : chaque PR lance `npm run test:unit` et un build macOS
  non signé qui vérifie les fusibles et que l'Electron empaqueté est celui du `package-lock`.
- **Veille** (`.github/workflows/electron-freshness.yml`) : chaque jour, `scripts/check-electron-freshness.js`
  compare l'Electron du dépôt à `releases.electronjs.org` (et affiche la Chromium de Chrome stable) ; en
  retard sur la politique, il ouvre ou complète une issue `security`.

## 2. Mises à jour de Lasco

Chaîne existante (docs/updates.md) : vérification au lancement puis toutes les heures, téléchargement
automatique, installation 1 min après, repoussée au plus 2 h pendant un travail d'agent. Une release
atteint donc le parc en **1 à 3 h** pour une app ouverte.

Manquait : un moyen de forcer une version après une faille critique, et un recours quand la mise à
jour automatique échoue (ShipIt bloqué, droits, release partielle). Ajouté :

- **Version minimale** : `security/minimum-version.json` sur `main`, lu par chaque Lasco à chaque
  vérification (`src/security/minimum-version.js`, `raw.githubusercontent.com`, 16 Ko au plus, 10 s).
  Sous ce plancher : vérification toutes les 15 min, installation au plus 10 min après le téléchargement
  même pendant un travail, notification « Mise à jour de sécurité ». Au bout de 6 h sans mise à jour
  installable : fenêtre « Mettez Lasco à jour » avec le lien de téléchargement (une fois par lancement).
- Le fichier ne contient qu'un numéro : il ne peut que hâter l'installation d'une release signée déjà
  publiée, jamais faire installer autre chose. Illisible ou absent : rien ne change.
- **Relever le plancher** : workflow « Security floor » (`.github/workflows/security-floor.yml`,
  manuel : version + raison). Il vérifie que la release est publiée avec `latest-mac.yml` et
  `latest.yml`, puis ouvre la PR qui modifie le fichier. **Jamais avant la publication** : les postes
  sous le plancher afficheraient « Mettez Lasco à jour » sans rien à installer.

## 3. Configuration des WebContents

| Point | Constat | Action |
| --- | --- | --- |
| `sandbox`, `contextIsolation`, `nodeIntegration` | Bons partout (portail, onglets web, fenêtres filles, popovers, réglages, cartes, tray, privé). | Garde `scripts/test-electron-security.js` : toute vue sans `sandbox: true` + `contextIsolation: true`, ou un `webSecurity: false`, `allowRunningInsecureContent`, `webviewTag`, `enableBlinkFeatures`, `--no-sandbox`, `ignore-certificate-errors`… fait échouer les tests. |
| Isolation des sites | Activée par défaut (Electron) ; onglets web dans leur propre session `persist:browser-tabs`, séparée du portail. | — |
| `<webview>` | Jamais utilisé. | Refus global de `will-attach-webview` (`app.on('web-contents-created')`). |
| `setWindowOpenHandler` / `will-navigate` | Présents sur chaque surface ; les vues locales refusent toute navigation. Fenêtres filles des onglets web adoptées avec les mêmes `webPreferences`. | — |
| **IPC accessible depuis une page web** | **Faille.** ~145 gestionnaires `ipcMain`, dont beaucoup sans contrôle de l'expéditeur (`update-install-now`, `update-check-now`, réglages, historique…). Un renderer d'onglet web compromis (faille Chromium) pouvait les appeler, ainsi qu'une page OAuth tierce chargée dans la fenêtre du portail (le preload du portail y est exposé). | **Barrière IPC** (`src/security/ipc-gate.js`), posée avant tout gestionnaire : seuls la session du portail, la session par défaut (vues locales) et la coquille d'une fenêtre privée, **et** un cadre chargé depuis le portail ou un fichier de Lasco, atteignent les gestionnaires. Tout le reste (onglets web, fenêtres ouvertes par un site, OAuth, sous-cadres d'autres sites, toute future partition d'onglets) n'atteint que les canaux de ses preloads : `lasco-pw:*`, `lasco-af:*` (mots de passe, saisie auto) et les deux canaux cosmétiques du bloqueur. Refus journalisé `[ipc-gate]`. **Nouveau canal appelé par une page web** : `ipcGate.allowWebChannels([...])`, et son gestionnaire vérifie l'onglet émetteur. |
| Preloads exposés aux pages web | `password-preload.js` (monde isolé, n'expose rien à la page ; envoie champ, frappe, capture), preload cosmétique de Ghostery, `agent-dom.js` exécuté en monde isolé à la demande de l'agent. Aucun `contextBridge` vers la page. | Canaux limités par la barrière ; les gestionnaires vérifient déjà l'onglet (`handlePasswordMessage`, `isBrowserTabSender`). |
| Protocoles externes | Onglets web : liste noire `NEVER_LAUNCH_SCHEMES` + confirmation native par site et par schéma (bon). **Fenêtre du portail : `openUrlInDefaultBrowser` passait tout schéma sauf `javascript:`/`data:`/`blob:` à l'OS** (`file:`, `smb:` — fuite NTLM sous Windows —, réglages système…), depuis n'importe quel lien d'une page du portail (wiki, CRM). | Même règle que les onglets : http(s) ou schéma d'application accepté par `parseExternalAppUrl`, sinon refusé. |
| Autorisations | Portail : micro seulement (`media-permissions.js`). Onglets web : question par site (`site-permissions.js`). **Session par défaut (réglages, popovers, cartes) : tout accordé par défaut** (comportement d'Electron). | Session par défaut : seulement `clipboard-sanitized-write` et `fullscreen`. |
| CSP des pages de Lasco | `default-src 'none'` sur réglages, cartes, popovers, tray ; `tab-error.html` : `script-src file:`. `error.html` sans CSP (page sans script ni donnée). La CSP de la coquille est celle du portail (nonces, mode bloquant, docs du portail). | À faire : CSP sur `error.html` ; à terme, un protocole `lasco://` pour les pages locales au lieu de `file:` (permettra de couper le fusible `GrantFileProtocolExtraPrivileges`). |
| Certificats | Aucun gestionnaire `certificate-error` ni `setCertificateVerifyProc` : Electron refuse le certificat, Lasco affiche sa page « Votre connexion n'est pas privée » **sans bouton pour continuer** (plus strict que Chrome) et l'état « Dangereux ». | Garde dans `test-electron-security.js` (aucun `callback(true)` dans un gestionnaire de certificat). |

### Fusibles d'Electron

Aucun n'était posé. `build/hooks/after-pack-fuses.js` (`afterPack` d'electron-builder, avant la
signature), vérifié par la CI :

| Fusible | Valeur | Pourquoi |
| --- | --- | --- |
| `EnableNodeOptionsEnvironmentVariable` | **coupé** | `NODE_OPTIONS=--require x.js` exécutait du code dans Lasco, **avec ses autorisations macOS** (micro, caméra, accès complet au disque accordé pour l'import Safari). |
| `EnableNodeCliInspectArguments` | **coupé** | Même chose avec `--inspect`. |
| `OnlyLoadAppFromAsar` | activé | L'app ne charge que `app.asar`. |
| `EnableEmbeddedAsarIntegrityValidation` | activé (macOS) | Empreinte de `app.asar` vérifiée au lancement. Windows : electron-builder 25 n'écrit pas l'empreinte (bloquerait le lancement) — à activer avec electron-builder 26 (`electronFuses`). |
| `RunAsNode` | **gardé** | Le serveur d'autorisation des harnais de code lance le binaire avec `ELECTRON_RUN_AS_NODE=1`. Tant qu'il est là, un programme local peut lancer Lasco en Node et hériter de ses autorisations macOS. **À couper** quand ce serveur aura son binaire (ou passera par un utilitaire `utilityProcess`). |
| `EnableCookieEncryption` | **pas encore** | Testé : sur un build non signé, la clé du trousseau est demandée avant le premier chargement et la page attend indéfiniment. À activer après un essai de mise à jour signée d'une 2.x installée. |
| `GrantFileProtocolExtraPrivileges` | gardé | Pages locales en `file:` (voir CSP). |

## 4. Sites dangereux

- **D'où vient `dangerous`** (`src/browser-tabs/page-errors.js`) : certificat refusé ou site signalé
  par la protection Safe Browsing (`src/safe-browsing/`, docs/safe-browsing.md, livrée en 2.12.0) :
  listes Google Safe Browsing v4 en préfixes de hachage gardées sur le disque, adresse hachée en local,
  confirmation d'un préfixe trouvé par le relais de l'API, page d'avertissement rouge plein écran,
  sous-cadres bloqués, téléchargements « Dangereux » avec « Conserver quand même ».
- **Constat** : en production, le relais répond **404** (`/__proxy_api/safe-browsing/v4/*`, testé le
  28/11/2026) : la route est sur `develop` du portail, pas encore sur `main`. **La protection ne bloque
  donc rien aujourd'hui en production** (jamais bloquante en cas d'échec, par construction). À faire :
  déployer le relais et poser `SAFE_BROWSING_API_KEY` sur l'API de production.
- **Licence** : Safe Browsing v4 est réservé par Google à un usage non commercial. Pour Lasco (produit
  payant), passer à **Web Risk API** (même format de listes, payante) dans ce seul relais ; le client de
  Desktop ne change pas.

## 5. HTTPS d'abord

Electron n'a pas les « HTTPS-Upgrades » de Chrome (couche `chrome/`). Ajouté
(`src/browser-tabs/https-first.js`, Réglages > Général > Sécurité, activé par défaut) :

- une page `http://` d'un site public est demandée d'abord en `https://`, avant toute requête en clair :
  liens, formulaires, scripts (`will-frame-navigate`), redirections (`will-redirect`), barre d'adresse
  et ouverture d'onglet (`create` / `navigate`) ;
- repli en `http://` (marqué « Non sécurisé ») si la version sécurisée échoue, ne répond pas en 5 s ou
  renvoie vers http ; le site n'est plus essayé jusqu'à la fermeture de Lasco (fenêtre privée : liste
  propre à la fenêtre) ;
- jamais pour `localhost`, un nom sans point, `.local`, `.test`, `.internal`, `.lan`, `.corp`…, une
  adresse IP ou un port explicite (intranets, appareils du réseau) ;
- limite connue : un formulaire `POST` vers une page http est relancé en `GET` https ; rare (un site
  qui a https y envoie ses formulaires).
- Ne **jamais** relancer une navigation (`stop` + `loadURL`) depuis `did-start-navigation` : Electron
  44 plante (trap natif, constaté pendant cet audit). Toujours un événement annulable, ou au tour suivant.

## 6. Reste à faire

1. Déployer le relais Safe Browsing en production (clé API), puis passer à Web Risk (§ 4).
2. Passer à Electron 45 (Chromium 156) dans le mois : PR Dependabot à valider avec l'essai manuel du § 1.
3. Couper `RunAsNode` (binaire dédié au serveur d'autorisation des harnais), activer
   `EnableCookieEncryption` après essai signé, intégrité de l'asar sur Windows (electron-builder 26).
4. Pages locales sur un protocole `lasco://` (puis couper `GrantFileProtocolExtraPrivileges`), CSP sur
   `error.html`.
5. Revue des gestionnaires IPC du portail : la barrière filtre l'expéditeur, chaque gestionnaire valide
   encore ses arguments (types, tailles) ; ceux qui touchent l'ordinateur le font déjà (`host-ops`).

## Tests

`scripts/test-ipc-gate.js`, `scripts/test-electron-security.js`, `scripts/test-minimum-version.js`,
`scripts/test-https-first.js`, `scripts/test-electron-freshness.js`. Vérifié à la main sur un build
macOS empaqueté (fusibles posés) : portail chargé, pont `lascoDesktop` actif, aucun refus `[ipc-gate]`
légitime, `http://example.com` ouvert en `https://`, `http://neverssl.com` replié en http.
