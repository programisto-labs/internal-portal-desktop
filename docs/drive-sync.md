# Synchronisation My Drive → dossier de l'ordinateur

Copie les fichiers My Drive de la personne connectée dans un dossier de l'ordinateur (internal-portal#2399). Code : `src/drive-sync/` ; côté portail : `lib/desktop-drive-sync/` et `components/desktop/desktop-drive-sync-host.tsx`.

## Réglage

- **Lasco > Réglages… (⌘,) > My Drive** : interrupteur, dossier (« Choisir… », « Afficher »), état de la dernière synchro. Désactivé par défaut. Activer sans dossier ouvre le sélecteur.
- Stocké dans `userData/drive-sync.json` (`enabled`, `rootPath`, compte lié, dernier passage). Les manifestes (fichier distant → chemin local) sont dans `userData/drive-sync/`, jamais dans le dossier de l'utilisateur.
- **Un dossier = un compte** : le premier compte qui synchronise le dossier le garde (`ownerUserId`). Un autre compte connecté sur ce Desktop est refusé (« déjà synchronisé pour un autre compte ») jusqu'à ce que l'utilisateur choisisse un autre dossier.

## Qui fait quoi

- **Le portail** (coquille de la fenêtre principale) lit My Drive avec la session de la personne, calcule les copies à faire et demande chaque écriture. Il tourne toutes les 60 s et à chaque changement du réglage, tant que Lasco est ouvert et connecté.
- **Desktop** écrit sur le disque, seulement dans le dossier choisi dans les Réglages, activé et lié au compte. La page ne choisit jamais un chemin absolu.

## Pont `window.lascoDesktop.driveSync`

Exposé au cadre principal de la fenêtre principale chargé depuis l'origine du portail (pas aux fenêtres détachées), revérifié dans le main à chaque appel. Indépendant des agents (`--no-agents` ne le coupe pas).

| Méthode | Rôle |
| --- | --- |
| `getConfig()` | `{ enabled, rootPath, ownerUserId }` |
| `onConfigChange(cb)` | Réglage modifié dans Desktop |
| `bind({ userId, label })` | Lie le dossier au compte ; `account-mismatch` si un autre compte le tient |
| `report({ userId, summary })` | État du dernier passage, affiché dans les Réglages |
| `openSettings()` / `chooseFolder()` | Ouvrent Réglages > My Drive (le dossier ne se choisit pas depuis la page) |
| `validateFolder`, `readManifest`, `writeManifest`, `stat`, `writeFile` | Contrat de `lib/desktop-drive-sync/types.ts` du portail |

## Garanties

- **Jamais d'écrasement, jamais de suppression** : téléchargement dans `<nom>.<aléa>.lasco-part`, puis création exclusive du nom final (lien physique, sinon copie `COPYFILE_EXCL`) ; nom déjà pris → `exists`, repris au passage suivant sous un autre nom.
- **Confinement** : chemins relatifs sans `.`, `..`, `\`, lettre de lecteur ; chaque dossier intermédiaire vérifié par `lstat` (aucun lien symbolique traversé), `realpath` du parent revérifié sous la racine.
- **Téléchargement** : URL `https` seulement (`http` si le portail lui-même est en `http`, en développement), sans identifiants dans l'URL, 10 min et 5 Go au plus par fichier.
- Erreurs disque traduites en codes du portail : `permission-denied`, `folder-not-found`, `folder-not-writable`, `disk-full`, `path-escape`, `network`.

Tests : `scripts/test-drive-sync.js`.
