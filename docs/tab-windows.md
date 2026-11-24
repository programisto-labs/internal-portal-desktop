# Fenêtres d'onglets détachées

N'importe quel onglet du navigateur interne (page du portail, page web, Lasco Code) peut quitter sa fenêtre et y revenir :

- **Nouvelle fenêtre** (⌘N / Ctrl+N, Fichier > Nouvelle fenêtre) : une fenêtre détachée sur un nouvel onglet. Le menu relaie `new-window` à la page, qui appelle `openWindow({ href })` ; l'élément n'est actif que si la page envoie `canOpenWindow: true` dans l'état du menu.
- **Menu de l'onglet** (clic droit) : « Détacher dans une nouvelle fenêtre » et, dans une fenêtre détachée, « Rattacher à la fenêtre principale ».
- **Glisser-déposer** (comme Chrome) : dès que l'onglet sort de la fenêtre (ou s'éloigne de la barre), sa nouvelle fenêtre apparaît et suit le curseur. Au lâcher : sur une autre fenêtre Lasco, l'onglet s'y rattache (la fenêtre qui suivait se ferme) ; ailleurs, la fenêtre reste ; revenu sur la barre d'origine avant de lâcher, rien ne change. Seul onglet d'une fenêtre : c'est la fenêtre qui suit le curseur.

## Fenêtres

- Chaque fenêtre du portail (`portalWindows` dans `main.js`) a son rôle (`main` ou `detached`) et ses propres vues natives d'onglets web (`createBrowserTabManager` par fenêtre, historique commun).
- Fermer la fenêtre principale promeut la plus ancienne fenêtre détachée en fenêtre principale (badge, notifications, opérations sur l'ordinateur).
- Ponts liés à la fenêtre principale seule : opérations sur l'ordinateur, harnais de code, badge, notifications, menu « Fenêtre ». Lasco Code (`code-workspace-*`, terminaux) est accepté depuis toute fenêtre du portail, puisque son onglet peut être détaché.

## Contrat avec la page (`window.lascoDesktop.tabWindows`)

Appels acceptés seulement depuis le cadre principal d'une fenêtre du portail, à l'origine du portail.

| Membre | Rôle |
| --- | --- |
| `role` | `main` ou `detached`, fixé à la création de la fenêtre (argument `--lasco-tab-window=`). |
| `initialTab` | Fenêtre détachée : l'onglet sur lequel elle s'ouvre. La fenêtre charge `locationHref`. |
| `ready()` | La page est abonnée à `onAdopt` : renvoie `{ tabs }` arrivés pendant son chargement. Un rechargement complet remet la file en attente. |
| `onAdopt(cb)` | Un onglet rattaché à cette fenêtre (ajouté et sélectionné). |
| `detach({ tab, screenX?, screenY? })` | Nouvelle fenêtre sur `tab`. La page retire l'onglet si `ok`. |
| `attach({ tab })` | Fenêtre détachée → fenêtre principale. `already-main` / `no-main-window` sinon. |
| `dragOut({ tab, screenX, screenY, onlyTab, grabOffset })` | L'onglet glissé sort de la fenêtre : nouvelle fenêtre affichée sans prendre le focus (`mode: 'window'`), ou, seul onglet, la fenêtre source (`mode: 'move'`), qui suit le curseur. |
| `dragCancel()` | Revenu sur la barre avant le lâcher : la fenêtre qui suivait se ferme. |
| `dragEnd({ screenX, screenY })` | Lâcher. `action` : `attached` (autre fenêtre sous le point), `detached` (la nouvelle fenêtre reste), `cancelled` (lâché sur la fenêtre d'origine), `moved` (seul onglet). La page retire l'onglet pour `attached` et `detached`. |
| `onDragHover(cb)` | Un onglet glissé depuis une autre fenêtre survole celle-ci : `{ tab: { id, kind, title, favicon }, screenX, screenY }`, puis `null` quand il la quitte. La page montre l'onglet dans sa barre à cet endroit (aperçu en direct) ; la fenêtre qui suivait le curseur devient transparente. Au lâcher, `onAdopt` reçoit `dropScreenX` : l'onglet est inséré là. |
| `closeWindow()` | Fenêtre détachée sans onglet : Desktop la ferme. |
| `openWindow({ href })` | ⌘N / Ctrl+N (Fichier > Nouvelle fenêtre) : Desktop ouvre une fenêtre `detached` sur `href` (chemin du nouvel onglet), décalée de 28 px de la fenêtre d'origine, même taille. Prend la réserve si elle est chargée sur `href`, sinon une fenêtre neuve ; une nouvelle réserve est préparée 3 s plus tard. Refusé depuis la réserve. |
| `prewarm({ href })` | Intention de détacher (menu de l'onglet ouvert, onglet saisi avec au moins deux onglets) : Desktop précharge la fenêtre de réserve sur `href` (chemin du nouvel onglet). Refusé depuis la réserve elle-même. |

Descripteur `tab` (`sanitizeTabDescriptor`, `src/tab-windows.js`) : `id`, `kind` (`internal` | `external`), `href` (chemin du portail, ou URL http(s) d'un onglet web), `locationHref` (chemin chargé par la fenêtre : `href` pour une page du portail, `…/new-tab` pour un onglet web), `title`, `favicon` (http(s)), `blank`.

Le menu natif n'ajoute « Détacher » / « Rattacher » que si la page envoie `windowActions: true` avec `showTabContextMenu` ; l'action revient par `onTabContextMenuAction` (`detach`, `attach`).

Un onglet web déplacé se recharge sur son URL dans la nouvelle fenêtre (la vue native n'est pas transférée). Un onglet Lasco Code rouvre son projet ; ses terminaux redémarrent.

Une fenêtre détachée s'ouvre sans barre latérale ni colonne Lasco AI (boutons pour les rouvrir) ; cet état reste propre à la fenêtre.

Côté portail : les onglets d'une fenêtre détachée sont gardés dans le `sessionStorage` de la fenêtre (rechargement compris), jamais dans la liste partagée de la fenêtre principale.

## Fenêtre de réserve (détachement instantané)

Sans réserve, une fenêtre détachée démarre à froid : nouveau processus, coquille du portail chargée en entier, puis l'onglet. Avec la réserve, seul l'onglet se charge.

- **Préchargement à l'intention** : la page appelle `prewarm({ href })` à l'ouverture du menu d'un onglet ou au début du glisser d'un onglet. Desktop crée une fenêtre `detached` **cachée** sur `href` (le nouvel onglet du workspace). Une seule réserve ; un autre `href` la remplace.
- **Détacher** (menu ou glisser) : Desktop prend la réserve, la place, l'affiche (sans focus pendant un glisser) et lui remet l'onglet par `onAdopt` avec `replaceBlank: true` : la page remplace son « Nouvel onglet » vierge par l'onglet. Sans réserve utilisable, une fenêtre neuve comme avant.
- **Réserve utilisable** (`isSpareWindowUsable`) : sa page est toujours sur `href` (ni connexion, ni page d'erreur, ni autre workspace). Un échec de chargement la détruit.
- **Après usage**, une nouvelle réserve est préparée 3 s plus tard (la personne détache souvent plusieurs onglets à la suite). Jamais avant un premier geste : pas de processus caché chez qui ne détache rien.
- La réserve n'est ni cible de dépôt, ni candidate pour devenir la fenêtre principale ; elle est détruite quand la dernière fenêtre du portail se ferme.
