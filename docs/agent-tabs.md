# Onglets pilotés par des agents, en arrière-plan

Comme Claude dans Chrome : un agent travaille dans SES onglets sans les passer au premier plan, et la personne continue dans les siens. **Plusieurs onglets à la fois** : un tour d'agent et ses sous-agents (`delegate_tasks`) pilotent chacun leurs onglets, en parallèle. Le portail marque chaque onglet (pastille et liseré à la couleur de l'agent, bannière « {agent} travaille dans cet onglet » avec « Reprendre la main », par onglet). Voir `lib/portal-tabs/agent-tab-control.ts` du portail et `docs/specs/agent/EPIC-agent-multi-tab.md`.

## Pont

`lascoDesktop.browserTabs.setAgentControl({ tabId, active })` → `browser-tab-set-agent-control` → `manager.setAgentControl`.

- `active: true` : `webContents.setBackgroundThrottling(false)` (la page cachée garde ses minuteries à pleine vitesse et peut être capturée) et la vue prend la taille de la zone des onglets si elle n'est pas affichée (mise en page juste).
- `active: false` : ralentissement rétabli.
- L'état de l'onglet porte `agentControlled`.
- Fermer l'onglet oublie son pilotage.
- Un ensemble d'onglets (`agentControlled`) : le portail appelle `setAgentControl` pour chaque onglet piloté. Aucun n'est mis en veille (`tab-sleep.js` : raison `agent`).

## Attente de stabilité

Après chaque action d'agent (clic, saisie, touche, liste, défilement) et avant chaque instantané : fin du chargement (`waitForLoadStop`), puis DOM calme dans la page (op `settle` de `agent-dom.js` : aucune mutation pendant 400 ms, 3 s au plus), au lieu d'un délai fixe de 350 ms. Chaque onglet attend pour lui-même : plusieurs onglets avancent en parallèle. Une navigation pendant l'attente retombe sur la fin du chargement.

## Fiabilité des actions

Les clics passent par des entrées natives (`sendInputEvent` au centre de l'élément, `covered` signalé) et la saisie par `insertText` après le focus du champ : jamais `element.click()` ni une valeur posée par script. Les refs viennent de l'instantané (rôle et nom calculés selon ARIA). Suite prévue : instantané par l'arbre d'accessibilité CDP (`Accessibility.getFullAXTree`).

## Clavier

Une action d'agent (clic, saisie, touche) sur un onglet piloté qui n'est pas affiché ne fait plus `webContents.focus()` : la personne garde le clavier là où elle tape. Les clics (`sendInputEvent`) et la saisie (`insertText` après le focus du champ dans la page) atteignent une page cachée sans focus.

## Mesures (Electron 44, macOS)

Vue cachée (`setVisible(false)` ou retirée de la fenêtre), avec ralentissement : clics et saisie reçus, minuteries à 1 /s, capture impossible (« Current display surface not available »). Sans ralentissement : clics et saisie reçus, minuteries à pleine vitesse, capture correcte. D'où `setBackgroundThrottling(false)` sur l'onglet piloté seulement.

## Ancien portail ou ancien Desktop

Sans `setAgentControl`, le portail montre l'onglet web pour le piloter (comportement d'origine). Les onglets du portail (iframes) se pilotent cachés dans tous les cas.

## Tests

`scripts/test-agent-tabs.js`.
