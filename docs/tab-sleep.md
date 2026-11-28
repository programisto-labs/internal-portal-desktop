# Mise en veille des onglets (économiseur de mémoire)

Comme l'économiseur de mémoire de Chrome : un onglet caché depuis un moment libère sa mémoire.
Il garde son titre, son icône, son adresse, son historique et sa position, une lune s'affiche
sur son icône (« En veille, libère de la mémoire »), et il se recharge quand on le sélectionne.

Code : `src/browser-tabs/tab-sleep.js` (règles, module pur), `src/browser-tabs/manager.js`
(veille et réveil des vues), Réglages > Économiseur de mémoire (`src/settings/`).

## Réglage

Lasco > Réglages… > **Économiseur de mémoire** (`settings.json`) :

- `tabSleepMinutes` : 5, 15, **30** (défaut), 60, 120 ou 240 min ; `0` = « Jamais ».
- `tabSleepNeverSites` : sites jamais mis en veille (hôte, sous-domaines compris :
  `figma.com` couvre `www.figma.com` ; `localhost:3001` vise ce port seulement), 200 au plus.
- `LASCO_TAB_SLEEP_MS` (environnement, développement et tests) remplace le délai, ex.
  `LASCO_TAB_SLEEP_MS=20000 npm run dev`. Les Réglages l'affichent.
- Mode VM (`--vm`) : jamais de veille (le point de contrôle pilote les onglets par leur vue).

## Onglets web (Desktop)

Un relevé tourne toutes les ¼ du délai (entre 1 s et 1 min). Un onglet web est mis en veille
quand il est caché depuis le délai, **sauf** :

- l'onglet affiché (sélectionné, vues visibles) ; un onglet jamais caché ;
- un onglet qui joue du son, en plein écran, piloté par un agent (`setAgentControl`), avec les
  outils de développement ouverts, en cours de chargement ou sur une page d'erreur de Lasco ;
- une page qui a reçu le micro ou la caméra (appel en cours, même silencieux), jusqu'à sa
  navigation suivante ; un onglet en incrustation (vidéo ou fenêtre d'appel, docs/picture-in-picture.md).
  Ces deux règles valent aussi pour `sleep.now` ;
- une fenêtre ouverte par une page (`window.open` adoptée, docs/popups.md) : la détruire
  couperait `opener` (connexion OAuth) ;
- un site de `tabSleepNeverSites` ; une page qui n'est pas en http(s) ;
- une saisie en cours : le preload des onglets (`password-preload.js`) note les champs modifiés
  par la personne (événements de confiance seulement, oubliés à l'envoi du formulaire) ; juste
  avant la veille, un relevé dans le même monde isolé (999) regarde si l'un d'eux diffère encore
  de sa valeur initiale. Oui : l'onglet reste éveillé et le délai repart. Une case cochée par un
  script de la page ne compte pas.

Mise en veille : l'historique (`navigationHistory.getAllEntries()`, sans le `about:blank` de
l'identité Chrome), l'index courant, le défilement, le zoom et le son coupé sont gardés, puis la
`WebContentsView` est détruite (processus de rendu libéré). Le portail reçoit un
`browser-tab-state` avec `discarded: true` (titre, icône, adresse, retour / avancer).

Réveil : `select`, `reload`, `goBack` / `goForward` (directement sur la page voulue),
`setAgentControl({ active: true })` et `agentAction` recréent la vue et rouvrent l'historique
par `navigationHistory.restore` (Chromium rétablit défilement et champs). En cas d'échec :
chargement de l'adresse puis défilement relevé. Le portail reçoit aussitôt un état
`discarded: false, isLoading: true`. `create` sur un onglet en veille pour la même adresse
(coquille rechargée) le réveille aussi, avec son historique. `close` l'oublie.

## Pont du portail

`lascoDesktop.browserTabs.sleep` :

| Méthode | Rôle |
| --- | --- |
| `get()` | `{ ok, delayMs, minutes, neverSites }` (`delayMs` = 0 : jamais) |
| `onChange(cb)` | même instantané à chaque changement des Réglages |
| `manage()` | ouvre Réglages > Économiseur de mémoire |
| `now({ tabId })` | met l'onglet en veille tout de suite (hors onglet affiché) |

`getState({ tabId })` renvoie l'état d'un onglet en veille (`discarded: true`).

## Pages du portail

La coquille du portail applique **le même délai** à ses pages (iframes d'onglet), lu par
`sleep.get()` : page déchargée (iframe retirée), lune et info-bulle identiques, position de
défilement gardée par onglet (`sessionStorage`) et filtres de l'adresse rétablis au réveil.
Jamais Lasco Code, l'onglet affiché, une page avec une saisie, un dépôt ou un flux en cours,
ni l'onglet piloté par un agent. « Jamais » coupe la veille après délai ; au-delà de 6 pages
du portail ouvertes, les plus anciennes dorment toujours (budget de mémoire).
Ancien Desktop sans ce pont : 30 min.

## Vérifier

```bash
LASCO_TAB_SLEEP_MS=20000 npm run dev
```

Ouvrir une dizaine d'onglets web, afficher une page du portail : au bout de ~25 s, la lune
apparaît sur les onglets web, la mémoire (`app.getAppMetrics()`, Gestionnaire de tâches)
baisse, un clic rouvre l'onglet à la même position. Tests : `scripts/test-tab-sleep.js`.
