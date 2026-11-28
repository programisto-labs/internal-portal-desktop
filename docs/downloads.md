# Téléchargements

Lasco Desktop enregistre lui-même les fichiers téléchargés depuis les onglets web **et** depuis les pages du portail (exports CSV, PDF…), comme un navigateur. Le portail affiche l'icône de progression à gauche du menu ☰, la bulle des derniers fichiers et la page `/downloads`.

## Où

- `src/downloads/naming.js` : nom de fichier sûr (`sanitizeFilename`), chemin libre « rapport (1).csv » (`uniqueSavePath`).
- `src/downloads/store.js` : liste persistée (`userData/downloads.json`, 1 000 entrées au plus). Un téléchargement en cours quand Lasco quitte revient en `interrupted` / `shutdown`.
- `src/downloads/service.js` : `will-download` des sessions des onglets web (`source: 'web'`, une par profil et workspace, docs/browser-profiles.md ; `profileId` et `partition` gardés sur l'entrée) et `persist:portal` (`source: 'portal'`), progression (envoi toutes les 250 ms au plus), actions par identifiant.
- `src/main.js` : branchement, IPC, Réglages ; progression dans le Dock / la barre des tâches (`setProgressBar`), rebond de la pile Téléchargements (`app.dock.downloadFinished`).

## Fichiers créés par Lasco

Une capture d'écran (docs/page-capture.md) et « Enregistrer en PDF » d'un onglet web (docs/zoom-and-pdf.md) passent par `saveFile` du service : même dossier, même nommage sans écraser, ajoutée à la liste comme un téléchargement terminé.

## Onglet ouvert seulement pour un fichier

Un lien `target="_blank"` vers un fichier (aperçu d'image du portail, lien S3…) ouvre un onglet web dont la navigation devient un téléchargement : aucune page ne s'y affiche. Comme Chrome, cet onglet est fermé dès le début du téléchargement (`closeIfBlankAfterDownload` du gestionnaire d'onglets, appelé par `onStarted` du service) et le portail revient à l'onglet d'origine (`browser-tab-closed`, comme un `window.close()`). Le téléchargement continue : il appartient à la session. Un onglet qui affichait déjà une page, ou qui en a une derrière (Précédent), reste ouvert.

## Réglages (Réglages > Téléchargements)

- **Emplacement** : `settings.downloadsDirectory` (chemin absolu, `null` = dossier Téléchargements du système). Choisi par un sélecteur natif, dossier vérifié en écriture. Un dossier disparu (disque débranché) retombe sur celui du système.
- **Demander où enregistrer chaque fichier** : `settings.downloadsAskWhere` (défaut `false`). « Enregistrer sous » natif ; un dialogue annulé n'apparaît pas dans la liste.
- Sinon le fichier va dans le dossier, sans jamais écraser : « nom (1).ext », « nom (2).ext »… y compris pour deux téléchargements simultanés du même nom.

## Pont `lascoDesktop.downloads`

Exposé aux fenêtres du portail (principale et détachées), cadre principal, origine du portail ; le main revérifie chaque appel (`downloadsSender`). La page agit **par identifiant**, jamais par chemin.

| Méthode | Effet |
| --- | --- |
| `list({ query?, limit?, offset? })` | `{ ok, items, total, directory }`, plus récents d'abord |
| `pause(id)` / `resume(id)` / `cancel(id)` | téléchargement en cours |
| `retry(id)` | relance une adresse http(s) dans la même session ; `not-retryable` pour un export `blob:` / `data:` |
| `keepDangerous(id)` | « Conserver quand même » d'un fichier signalé dangereux (docs/safe-browsing.md) : téléchargé de nouveau sans vérification |
| `open(id)` | ouvre le fichier terminé ; `missing` s'il n'est plus sur le disque |
| `show(id)` | l'affiche dans le Finder / l'Explorateur (le dossier s'il a disparu) |
| `remove(id)` / `clear()` | retire de la liste (jamais un téléchargement en cours) ; les fichiers restent |
| `openDirectory()` / `openSettings()` | dossier des téléchargements / Réglages > Téléchargements |
| `onChanged(cb)` | `{ type: 'upsert', item }`, `{ type: 'remove', ids }`, `{ type: 'clear', ids }` |

Un élément : `id, url, filename, savePath, mimeType, totalBytes, receivedBytes, state ('progressing' | 'completed' | 'cancelled' | 'interrupted'), paused, canResume, bytesPerSecond, startTime, endTime, source ('web' | 'portal'), error ('network' | 'failed' | 'shutdown' | 'dangerous' | null), danger ('malware' | 'phishing' | 'unwanted' | null), exists` (fichier présent, pour un téléchargement terminé).

## Fichiers dangereux

Un fichier dont l'adresse ou la page d'origine est signalée par la protection contre les sites dangereux n'est jamais écrit : annulé, gardé dans la liste avec `error: 'dangerous'` (voir docs/safe-browsing.md).

## Raccourci

⌘⇧J (macOS) / Ctrl+J : page Téléchargements. Depuis une page web, la vue native renvoie `{ action: 'downloads' }` sur `browser-tab-shortcut`.

## Tests

`scripts/test-downloads.js` (nommage, liste, service avec un faux `DownloadItem`).
