# Téléchargements

Lasco Desktop enregistre lui-même les fichiers téléchargés depuis les onglets web **et** depuis les pages du portail (exports CSV, PDF…), comme un navigateur. Le portail affiche l'icône de progression à gauche du menu ☰, la bulle des derniers fichiers et la page `/downloads`.

## Où

- `src/downloads/naming.js` : nom de fichier sûr (`sanitizeFilename`), chemin libre « rapport (1).csv » (`uniqueSavePath`).
- `src/downloads/store.js` : liste persistée (`userData/downloads.json`, 1 000 entrées au plus). Un téléchargement en cours quand Lasco quitte revient en `interrupted` / `shutdown`.
- `src/downloads/service.js` : `will-download` des sessions `persist:browser-tabs` (`source: 'web'`) et `persist:portal` (`source: 'portal'`), progression (envoi toutes les 250 ms au plus), actions par identifiant.
- `src/main.js` : branchement, IPC, Réglages ; progression dans le Dock / la barre des tâches (`setProgressBar`), rebond de la pile Téléchargements (`app.dock.downloadFinished`).

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
| `open(id)` | ouvre le fichier terminé ; `missing` s'il n'est plus sur le disque |
| `show(id)` | l'affiche dans le Finder / l'Explorateur (le dossier s'il a disparu) |
| `remove(id)` / `clear()` | retire de la liste (jamais un téléchargement en cours) ; les fichiers restent |
| `openDirectory()` / `openSettings()` | dossier des téléchargements / Réglages > Téléchargements |
| `onChanged(cb)` | `{ type: 'upsert', item }`, `{ type: 'remove', ids }`, `{ type: 'clear', ids }` |

Un élément : `id, url, filename, savePath, mimeType, totalBytes, receivedBytes, state ('progressing' | 'completed' | 'cancelled' | 'interrupted'), paused, canResume, bytesPerSecond, startTime, endTime, source ('web' | 'portal'), error ('network' | 'failed' | 'shutdown' | null), exists` (fichier présent, pour un téléchargement terminé).

## Raccourci

⌘⇧J (macOS) / Ctrl+J : page Téléchargements. Depuis une page web, la vue native renvoie `{ action: 'downloads' }` sur `browser-tab-shortcut`.

## Tests

`scripts/test-downloads.js` (nommage, liste, service avec un faux `DownloadItem`).
