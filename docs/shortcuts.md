# Raccourcis clavier

La page du portail gère ses raccourcis (`lib/portal-tabs/shortcuts.ts` du portail). Quand le focus est dans une page web (vue native), elle ne voit pas le clavier : Desktop intercepte les touches dans `before-input-event` (`src/browser-tabs/manager.js`).

| Touches (macOS / Windows, Linux) | Action | Où |
| --- | --- | --- |
| ⌘N / Ctrl+N | Nouvelle fenêtre sur un nouvel onglet | Menu Fichier (vrai raccourci natif) |
| ⌘1–8, ⌘9 / Ctrl+1–8, Ctrl+9 | Onglet N, dernier onglet | Relayé |
| ⌃Tab, ⌃⇧Tab, ⌘⌥→ / ⌘⌥←, ⌘⇧] / ⌘⇧[ | Onglet suivant / précédent | Relayé |
| ⌘⌥1–9 / Ctrl+Maj+1–9 | Agent N de la colonne Lasco AI | Relayé |
| ⌘D, ⌘Y, ⌘/ | Favori, historique, liste des raccourcis | Relayé |
| ⌘⇧R | Recharger sans le cache | Vue native |
| ⌘⇧J / Ctrl+J | Téléchargements | Relayé (`downloads`) |
| ⌘F, ⌘G / ⌘⇧G | Rechercher dans la page : `findInPage` de la vue pour une page web ; sur une page du portail, la page cherche elle-même dans son DOM (`lib/portal-tabs/dom-find.ts` du portail) | Vue native ou page |
| ⌘L, ⌘T, ⌘P, ⌘R, zoom, ⌘[ ⌘] | Inchangés | Vue native ou relayé |

**Relayé** : `resolveRelayedShellShortcut` (`src/browser-tabs/shell-shortcuts.js`) envoie l'action sur `browser-tab-shortcut` (`{ tabId, action }`) après avoir rendu le focus à la page du portail, qui l'exécute quel que soit l'onglet. La touche physique (`input.code`) compte : sur un clavier AZERTY, ⌘1 donne `key` = « & ».

Les agents utilisent Ctrl+Maj hors macOS : Ctrl+Alt est AltGr sur un clavier AZERTY (`#`, `@`, `~`).

Tests : `scripts/test-shell-shortcuts.js`.
