# Protection contre les sites dangereux (Safe Browsing)

Comme Chrome et Brave, Lasco Desktop vérifie chaque page ouverte dans un onglet web contre les listes de **Google Safe Browsing** : hameçonnage (« Site trompeur »), logiciels malveillants, logiciels indésirables. Un site signalé n'est pas chargé : une page rouge plein écran le remplace. Les fichiers d'un site signalé ne sont pas écrits sur le disque.

Réglage : Lasco > Réglages… > Général > Sécurité, « Protection contre les sites dangereux » (`settings.safeBrowsingEnabled`, **activé par défaut**). Coupé : aucune vérification, les listes ne sont plus mises à jour.

## Source : Google Safe Browsing v4, base locale (Update API)

- **Pourquoi l'Update API et pas la Lookup API** : la Lookup API envoie chaque adresse visitée à Google. L'Update API télécharge les listes sous forme de **préfixes de hachage** (SHA-256 tronqué à 4 octets le plus souvent) ; l'adresse est hachée sur l'ordinateur et comparée localement. Seul un préfixe trouvé dans la liste (rare : presque toujours un vrai site dangereux) part vers le serveur pour obtenir les hachages complets. L'adresse elle-même ne quitte jamais l'ordinateur. C'est le mode « Standard » de Chrome.
- **Pourquoi un relais de l'API Lasco** (`POST <portail>/__proxy_api/safe-browsing/v4/threat-list-updates` et `…/full-hashes`, module `safe-browsing` de l'API, dépôt internal-portal-front) : la clé d'API reste sur le serveur (`SAFE_BROWSING_API_KEY`), jamais dans l'application distribuée ; l'API met en cache les mises à jour (des milliers de Desktop au même état reçoivent la même réponse, Google n'est appelé qu'une fois) ; et le fournisseur peut changer côté serveur sans nouvelle version de Desktop (voir « Licence »). Le relais est public (le processus principal n'a pas de session), limité par IP, et reconstruit le corps en liste blanche : ni cookie, ni session, ni adresse.
- **Développement** : `LASCO_SAFE_BROWSING_API_KEY=<clé>` (variable d'environnement de Desktop) parle directement à `safebrowsing.googleapis.com/v4` ; `LASCO_SAFE_BROWSING_URL=<base>` remplace l'adresse du relais (faux serveur de test).
- **Licence** : les API Safe Browsing v4 sont réservées par Google à un usage non commercial ; pour un usage commercial, Google oriente vers **Web Risk** (même principe : `threatLists.computeDiff` / `hashes.search`). Le relais est le seul endroit à adapter si Lasco passe à Web Risk : Desktop parle toujours le format v4 au relais.

Listes suivies : `MALWARE`, `SOCIAL_ENGINEERING`, `UNWANTED_SOFTWARE`, plateforme `ANY_PLATFORM`, type `URL`.

## Où

- `src/safe-browsing/url-hashes.js` : canonicalisation de l'adresse (spécification « URLs and Hashing » de Google : décodage des `%XX`, hôte en minuscules, adresses IP normalisées, chemin résolu), puis jusqu'à 5 suffixes d'hôte × 6 préfixes de chemin, hachés en SHA-256.
- `src/safe-browsing/prefix-set.js` : préfixes d'une liste, triés comme le serveur (ordre lexicographique, toutes tailles confondues) ; 4 octets dans un `Uint32Array` (4 Mo par million de préfixes), recherche dichotomique ; retraits par position, ajouts RAW, checksum SHA-256.
- `src/safe-browsing/service.js` : mises à jour (`threatListUpdates:fetch`, compression RAW, `minimumWaitDuration` respecté, 30 min par défaut ; échec : 15 min × 2ⁿ, 8 h au plus), contrôle du checksum (faux : liste vidée et redemandée en entier), caches des hachages complets (`cacheDuration`) et des préfixes sans danger (`negativeCacheDuration`), « Continuer » de la session.
- `src/safe-browsing/transport.js` : relais ou Google, `net.fetch` sans cookies, réponse de 32 Mo au plus ; fichier `userData/safe-browsing.json` (écriture atomique, checksum relu au démarrage).
- `src/safe-browsing/downloads.js` : verdict d'un téléchargement.
- `src/browser-tabs/manager.js` : vérification des navigations ; `src/browser-tabs/page-errors.js`, `tab-error.html`, `tab-error.js` : page d'avertissement.

## Décision

`classify(url)`, sans réseau : `safe` (rien dans les listes, protection coupée, site autorisé pour la session, listes pas encore téléchargées), `dangerous` (hachage complet connu) ou `check` (un préfixe correspond). `check(url)` interroge alors le relais (5 s au plus) et rend `safe` ou `dangerous`.

**Jamais bloquant** : listes absentes, relais injoignable, clé non configurée (503) → la page s'ouvre, l'échec est seulement journalisé (`[safe-browsing]`).

## Navigations vérifiées

- **Cadre principal** : barre d'adresse et liens du portail (`create` / `navigate`), liens suivis, formulaires et scripts de la page (`will-frame-navigate`), redirections (`will-redirect`), Précédent / Suivant / Actualiser (`did-start-navigation` : arrêt puis page d'avertissement). Un préfixe à vérifier retient la navigation le temps de la réponse (quelques centaines de ms), puis la relance (`loadURL`) si le site est sûr.
- **Sous-cadres** (iframes) : bloqués dès que leur adresse est connue comme dangereuse. Un préfixe à vérifier ne retient pas le cadre (sa navigation ne peut pas être relancée) : la vérification part en arrière-plan et vaut pour la suite.

## Page d'avertissement

- `pageError: 'safe-browsing'` dans l'état de l'onglet, `threat` : `phishing` | `malware` | `unwanted`, `security: 'dangerous'` (cadenas rouge « Dangereux » du portail). L'adresse de l'onglet reste celle du site.
- Rouge plein écran : titre (« Site trompeur », « Ce site contient des logiciels malveillants », « Ce site propose des programmes dangereux »), explication, bouton principal **Retour en lieu sûr**, lien **Détails** qui déplie l'explication et **Continuer vers ce site (non recommandé)**.
- **Retour en lieu sûr** : dernière page de l'historique de l'onglet qui n'est ni une page d'avertissement ni un site signalé ; rien avant (onglet ouvert pour ce lien) : l'onglet est fermé (`browser-tab-closed`) et le portail revient à l'onglet d'origine.
- **Continuer** : retenu pour l'hôte (sans `www.`) jusqu'à la fin de la session, jamais sur le disque.
- Les boutons ne naviguent pas eux-mêmes : la page pose `#proceed-<jeton>` / `#back-<jeton>` avec `location.replace`, Desktop le lit (`did-navigate-in-page`) et agit. Le jeton est tiré au hasard à chaque avertissement.
- Une page d'avertissement retrouvée par Précédent reprend son site et ses boutons (`safeBrowsingPageFromUrl`).

### Textes

Fournis par le portail dans la langue de la personne : `browserTabs.setSafeBrowsingTexts(texts)` (une fois au montage de la coquille). Clés : `phishingTitle`, `phishingMessage`, `phishingDetails`, `malwareTitle`, `malwareMessage`, `malwareDetails`, `unwantedTitle`, `unwantedMessage`, `unwantedDetails`, `back`, `showDetails`, `hideDetails`, `proceed`, `siteLabel`. Clés inconnues ignorées, 800 caractères au plus, insérés en texte (jamais en HTML). Sans textes (ancien portail) : français.

## Téléchargements

Le fichier (redirections comprises, `getURLChain`) et la page qui le propose sont vérifiés à `will-download`. Signalé : le téléchargement est annulé avant d'écrire quoi que ce soit, l'élément reste dans la liste avec `error: 'dangerous'` et `danger` (`malware` | `phishing` | `unwanted`). Préfixe à vérifier : le téléchargement est mis en pause le temps de la réponse.

`lascoDesktop.downloads.keepDangerous(id)` (« Conserver quand même ») télécharge de nouveau l'adresse sans vérification, une fois. Voir `docs/downloads.md`.

## Vérifier

Avec une clé (`LASCO_SAFE_BROWSING_API_KEY` ou relais configuré), les pages de test de Google : `https://testsafebrowsing.appspot.com/` (`/s/phishing.html`, `/s/malware.html`, `/s/unwanted.html`, `/s/malware_in_iframe.html`, téléchargements `/s/badrep.exe` selon la liste). Sans clé : `LASCO_SAFE_BROWSING_URL` vers un faux serveur v4 qui renvoie les préfixes voulus.

## Tests

`scripts/test-safe-browsing.js` (canonicalisation avec les vecteurs de Google, expressions, préfixes, décision, caches, panne du serveur, checksum, page d'avertissement), `scripts/test-downloads.js` (fichiers dangereux).
