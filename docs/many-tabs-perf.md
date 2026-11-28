# Beaucoup d'onglets (50 à 100) sans ralentir la machine

Chaque onglet web a sa `WebContentsView`, donc son processus de rendu (60 à 70 Mo pour une page
moyenne, bien plus pour Gmail ou Figma). Les pages du portail sont des iframes de même origine
dans la fenêtre du portail : un seul processus, mais chaque page garde son React et ses caches.
Ce document décrit comment Lasco tient 50 à 100 onglets : budget d'onglets vivants, relevé
agrégé, banc de mesure. Veille après délai : [tab-sleep.md](tab-sleep.md).

## Budget d'onglets vivants (comme l'économiseur de mémoire de Chrome)

Lasco > Réglages… > Économiseur de mémoire :

- **Onglets gardés actifs en arrière-plan** (`tabSleepMaxLive`) : 5, **10** (défaut), 20, 40, ou
  « Sans limite » (0). Au-delà, les onglets web quittés depuis plus de **2 min** sont mis en
  veille sans attendre le délai, les plus anciennement quittés d'abord. Indépendant du délai :
  « Jamais » pour le délai n'enlève pas le budget.
- **Mémoire de l'ordinateur presque pleine** (moins de 8 % et moins de 1,5 Go disponibles,
  `process.getSystemMemoryInfo()`, cache de fichiers et mémoire purgeable comptés comme
  disponibles) : budget de 3, onglets quittés depuis 30 s, même avec « Sans limite ».
- **Mettre aussi en veille les onglets épinglés** (`tabSleepPinned`, désactivé par défaut) : un
  onglet épinglé (`browserTabs.setPinned({ tabId, pinned })`, envoyé par le portail) reste
  éveillé.
- Mêmes exceptions que la veille après délai : onglet affiché, son, plein écran, appel (micro,
  caméra, partage d'écran), piloté par un agent, saisie en cours, fenêtre ouverte par une page,
  outils de développement, chargement, sites de la liste « Jamais ». Un onglet exempté compte
  dans le budget mais ne dort jamais : le suivant le plus ancien dort à sa place.
- Relevé toutes les 15 s au plus (`runLiveBudgetCheck`, `selectTabsOverLiveBudget` dans
  `src/browser-tabs/tab-sleep.js`). Mise en veille et réveil : ceux de la veille après délai
  (historique, défilement, zoom gardés, lune sur l'onglet).
- Mode VM : aucun budget.

`browserTabs.sleep.get()` renvoie aussi `maxLive` et `sleepPinned`. Les pages du portail gardent
leur propre plafond (6 pages vivantes, `MAX_LIVE_TAB_PAGES` de la coquille).

## Relevé agrégé (production)

`lascoDesktop.perf.snapshot()` (fenêtre du portail seulement, `src/perf-metrics.js`) :

```json
{ "ok": true, "processes": 16, "memoryMb": 1032, "cpuPercent": 0.4,
  "byKind": { "browser": { "count": 1, "memoryMb": 117, "cpuPercent": 0 },
              "gpu": {…}, "renderer": { "count": 13, "memoryMb": 837, "cpuPercent": 0.4 }, "utility": {…} },
  "tabs": { "webLive": 11, "webSleeping": 39 } }
```

Totaux de `app.getAppMetrics()` par type de processus, arrondis au Mo, et nombres d'onglets.
Jamais d'adresse, de titre, de pid ni d'identifiant d'onglet. `cpuPercent` : moyenne depuis le
relevé précédent. Le portail l'envoie à PostHog toutes les 30 min (`tabs_perf_sampled`, voir
`lib/portal-tabs/tabs-perf-report.ts` du portail).

## Banc de mesure

```bash
npx electron scripts/bench-many-tabs.js --web=50 --portal=50 --max-live=10
```

Le vrai gestionnaire d'onglets, sur des pages locales (≈ 2 000 nœuds, 4 Mo de tas, minuterie
chaque seconde) ; pages du portail simulées en iframes (≈ 6 Mo de tas, 6 vivantes). Mesure la
mémoire et le CPU par type de processus après 8 s de repos, puis le temps de bascule (sélection
→ image composée) vers un onglet récent et vers un ancien. Options : `--portal-live`,
`--settle`, `--idle`, `--switches`, `--portal-url`. Sortie lisible puis `BENCH_RESULT {json}`.

Chiffres (MacBook Apple Silicon, 24 Go, Electron 44.5.1, 28/11/2026) :

| Cas | Mémoire | Processus | CPU au repos | Bascule récent / ancien |
| --- | --- | --- | --- | --- |
| 50 web + 50 portail, avant | 3 603 Mo | 55 | 0,2 % | 12 ms / 2 ms |
| 50 web + 50 portail, budget 10 | **1 032 Mo** | 16 | 0 % | 20 ms / 50 ms |
| 100 web + 20 portail, avant | 6 737 Mo | 105 | 0,2 % | 28 ms / 2 ms |
| 100 web + 20 portail, budget 10 | **1 079 Mo** | 16 | 0 % | 15 ms / 51 ms |

La mémoire ne dépend plus du nombre d'onglets ouverts mais du budget. Prix : un onglet ancien se
recharge à la bascule (≈ 50 ms sur une page locale, le temps de chargement du site en vrai). Les
pages locales sont légères : sur de vrais sites (régies, mesure d'audience, vidéos), l'écart de
mémoire et de CPU au repos est plus grand.

## Fuites vérifiées

- Fermeture et veille d'un onglet web : vue détachée, `webContents.close()`, tables par
  `webContents` (`tabIdsByWebContents`, `tabWindowGetters`, `mediaCapturingWebContents`, routes du
  mode responsive) vidées à `destroyed` ; épinglés, onglets pilotés et mots de passe oubliés.
  `pinnedTabs` est vidé à la fermeture et par `destroyAll`.
- Portail : une page d'onglet mise en veille (iframe retirée) n'est pas démontée par React. Tout
  écouteur posé par l'onglet sur la coquille doit se retirer à `pagehide`
  (`listenOnPortalHost`), sinon la coquille garde tout le document de l'onglet.
