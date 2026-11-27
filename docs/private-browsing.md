# Navigation privée

Une fenêtre de navigation privée ne contient que des onglets web, comme une fenêtre de navigation privée de Chrome ou de Brave. Rien de ce qui s'y passe n'est gardé après sa fermeture.

## Ouvrir

- **⌘⇧N** (macOS) / **Ctrl+Maj+N** (Windows, Linux) : Fichier > « Nouvelle fenêtre de navigation privée », raccourci natif du menu de l'app, actif même quand le focus est dans une page web ou que le portail n'a pas fini de charger.
- **Menu ☰ du navigateur du portail** : « Nouvelle fenêtre de navigation privée », par le pont `lascoDesktop.privateBrowsing.openWindow()` (cadre principal d'une fenêtre du portail, origine du portail).
- **Depuis une fenêtre privée** : ⌘⇧N ou son menu ☰ ouvrent une autre fenêtre privée, avec sa propre session.
- Pas en mode VM (`--vm`).

## Ce que contient la fenêtre

La page de la fenêtre est la coquille de Desktop (`src/vm-shell/private.html`, même code que la coquille de la VM, `vm-shell.js`, avec le thème `private.css`), jamais le portail :

- ni barre latérale, ni colonne Lasco AI, ni agents, ni session Lasco ;
- onglets web seulement (barre d'onglets, adresse, précédent / suivant / actualiser, informations du site, recherche dans la page, zoom, impression) ;
- thème sombre violet / anthracite, masque et libellé « Navigation privée » dans la barre d'onglets ;
- un nouvel onglet affiche la page « Navigation privée » (ce qui est gardé ou non), sans vue native ; fermer le dernier onglet ferme la fenêtre.

Une adresse de Lasco (origine du portail) tapée, ouverte par un lien, une redirection ou une fenêtre fille ne se charge jamais dans un onglet privé : elle s'ouvre dans la fenêtre principale (onglet du portail), qui est affichée.

## Session

- Chaque fenêtre a sa partition `lasco-private-<uuid>` (sans `persist:`) : Electron garde cookies, cache, stockage local, IndexedDB et service workers en mémoire, jamais sur le disque. La page de la coquille a sa propre partition en mémoire (`…-shell`).
- Deux fenêtres privées ne partagent rien, ni entre elles ni avec les onglets web normaux (`persist:browser-tabs`) ou le portail (`persist:portal`).
- À la fermeture de la fenêtre (et à la fin de Lasco), ses vues sont détruites puis sa session est vidée (`clearStorageData`, `clearCache`, `clearAuthCache`). Rouvrir une fenêtre privée part d'une session vide : on n'y est plus connecté à aucun site.
- Règles et garde : `src/private-window/rules.js` (`assertInMemoryPartition` refuse toute partition `persist:`). Le gestionnaire d'onglets (`createBrowserTabManager({ partition, privateMode: true })`) le vérifie à sa création.

## Rien d'écrit

| Donnée | Fenêtre privée |
| --- | --- |
| Historique | En mémoire, pour les suggestions de la barre d'adresse de cette fenêtre ; jamais dans `browser-history.json`. |
| Cookies, cache, stockage des sites | Session en mémoire, vidée à la fermeture. |
| Mots de passe | Pas de runtime dans les pages (`password-preload.js` absent) : ni capture, ni proposition, ni remplissage depuis le Coffre. |
| Saisie automatique des formulaires | Absente. |
| Autorisations des sites | En mémoire. Les blocages du navigateur normal (réglages par défaut, sites bloqués) s'appliquent ; ses autorisations, non (le site redemande). Les réglages par défaut ne se changent pas depuis une fenêtre privée. |
| Applications externes (`zoommtg:`…) | « Toujours autoriser » en mémoire. |
| Moteurs de recherche des sites (OpenSearch) | Jamais découverts ni ajoutés. Le moteur par défaut est lu, pas modifié. |
| Téléchargements | Le fichier est enregistré dans le dossier des Réglages (comme Chrome), mais la liste de Lasco ne le montre pas et `downloads.json` n'est pas écrit. |

## Pont de la page (`src/private-window/private-preload.js`)

Exposé seulement sur la page `file:` d'une fenêtre lancée avec `--lasco-private-window` : `lascoDesktop.browserTabs` (création, navigation, sélection, fermeture, historique de la fenêtre, informations du site, zoom, recherche, impression, capture, menu des onglets) et `lascoDesktop.privateWindow` (`getInfo`, `openWindow`).

Jamais : `hostOps`, `codeWorkspace`, `codeHarness`, mots de passe, saisie automatique, `agentAction` / `setAgentControl`, téléchargements, My Drive, Coffre, notifications, badge, fenêtres détachées, icône de la barre des menus.

Côté processus principal, une fenêtre privée n'est jamais dans `portalWindows` : tous les ponts réservés au portail (opérations sur l'ordinateur, Lasco Code, harnais, téléchargements, Coffre, My Drive, menu « Fenêtre », icône de la barre des menus, notifications) la refusent. Les appels du gestionnaire d'onglets interdits en privé (`PRIVATE_DENIED_TAB_METHODS`) répondent `{ ok: false, error: 'private-window' }`, dans le processus principal et dans le gestionnaire lui-même.

## Tests

`scripts/test-private-window.js` : partition toujours en mémoire et neuve par fenêtre, adresses de Lasco renvoyées à la fenêtre principale, autorisations en mémoire (blocages hérités), gestionnaire d'onglets réel avec un faux Electron (partition privée seule, aucun preload, aucun fichier écrit, appels interdits refusés, session vidée à la fermeture), page et preload (aucun script distant, aucun pont du portail).
