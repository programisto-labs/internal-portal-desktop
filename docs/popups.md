# Fenêtres ouvertes par une page web (`window.open`)

Comme Chrome, une fenêtre ouverte par une page d'un onglet web devient un **vrai onglet relié à la page d'origine** : `window.open` renvoie une fenêtre, `window.opener` et `postMessage` marchent, `window.close()` ferme l'onglet. Exemples : « popout » d'un message Gmail (sans cela, Gmail affiche « un bloqueur de fenêtres pop-up empêche… »), connexion Google ou Apple d'un site (Riverside).

## Échange avec le portail

1. Le portail s'abonne avec `browserTabs.onOpenRequest(callback, { adoptPopups: true })`. Desktop note que ce portail sait adopter les fenêtres (`setAdoptPopups`, par fenêtre). Un portail plus ancien ne le dit pas : Desktop garde l'ancien comportement (fenêtre refusée, onglet ouvert sur l'URL), sinon chaque fenêtre ouvrirait deux onglets.
2. La page appelle `window.open` : le gestionnaire autorise la fenêtre (`createWindow`), en fait une vue (mêmes réglages que les autres onglets : session, bac à sable, préchargement des mots de passe) et envoie `browser-tab-open-request` avec `url` (`about:blank` possible), `openerTabId`, `disposition` et `adoptedTabId` (`popup-<uuid>`). La vue reste cachée.
3. Le portail ajoute l'onglet sous `adoptedTabId`, à droite de `openerTabId`, sans `create` (qui recréerait la vue), puis `select` s'il est au premier plan. `disposition: 'background-tab'` (clic molette, ⌘-clic) : il reste en arrière-plan.
4. La page se ferme (`window.close()`) : Desktop envoie `browser-tab-closed` `{ tabId }` ; le portail retire l'onglet et revient à l'onglet d'origine.

Liens vers une app (`unityhub://…`) et liens Lasco (`interceptLink`) : inchangés, jamais adoptés.
