# Onglets épinglés

Comme Chrome : un onglet épinglé reste à gauche de la barre, réduit à son icône, n'est pas fermé
par ⌘W et revient au redémarrage. **Le portail décide de tout** (état sur l'onglet, ordre,
enregistrement par espace) ; Desktop ne fait que deux choses.

## Menu natif de l'onglet

Le portail ajoute à `browserTabs.showTabContextMenu({ actions })` :

| Action | Libellé par défaut | Quand |
| --- | --- | --- |
| `pin` | Épingler | onglet non épinglé (pas un « Nouvel onglet » vierge) |
| `unpin` | Détacher l'épingle | onglet épinglé |
| `pinned-url` | Revenir à l'URL épinglée | onglet épinglé qui a quitté son adresse d'origine |

Groupe à part (séparateurs), libellés traduits fournis par la page (`labels`). Le choix revient par
`onTabContextMenuAction` comme les autres entrées. Un ancien Desktop ignore ces actions : le portail
garde son menu HTML pour les onglets du portail.

## Liens d'un onglet web épinglé

`browserTabs.setPinned({ tabId, pinned, pinnedUrl })` (`browser-tab-set-pinned`) : `pinnedUrl` =
adresse http(s) au moment de l'épinglage, `pinned: false` = détaché. C'est le même appel que la garde
de l'économiseur de mémoire (`pinned`, branche `perf/many-tabs`) : la seconde PR mergée fusionne les
deux `setPinned` du gestionnaire. Gardé par `tabId` hors de la vue (survit à la
veille et à la recréation), vidé quand la coquille se recharge (la page renvoie ses épingles).

Une navigation de la page (`will-navigate` : lien, formulaire, `location`) vers **un autre site**
(domaine enregistrable différent, `src/browser-tabs/pinned.js`) est annulée et envoyée en
`browser-tab-open-request` `{ url, openerTabId }` : le portail l'ouvre dans un nouvel onglet au
premier plan, juste après la zone épinglée. Même site (`mail.google.com` → `accounts.google.com`),
redirections serveur et navigations lancées par le portail (`navigate`) : inchangées.

Tests : `scripts/test-pinned-tabs.js`.

## Liste des onglets tenue par Desktop (`src/tab-model.js`)

La page envoie aussi `pinnedHref` sur chaque onglet épinglé de la liste. `sanitizeTabRecord` doit le
garder (chaîne http(s) ou chemin du portail, seulement si `pinned`) ; sinon « Revenir à l'URL
épinglée » repart de l'adresse actuelle après un redémarrage.
