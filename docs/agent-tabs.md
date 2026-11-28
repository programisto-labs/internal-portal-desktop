# Onglet piloté par un agent, en arrière-plan

Lecture et actions dans la page (arbre d’accessibilité, entrées CDP, garde des écritures) : `docs/agent-actuation.md`.

Comme Claude dans Chrome : l'agent travaille dans SON onglet sans le passer au premier plan, et la personne continue dans les siens. Le portail marque l'onglet (icône sur l'onglet, bannière « {agent} travaille dans cet onglet » avec « Reprendre la main »). Voir `lib/portal-tabs/agent-tab-control.ts` du portail.

## Pont

`lascoDesktop.browserTabs.setAgentControl({ tabId, active })` → `browser-tab-set-agent-control` → `manager.setAgentControl`.

- `active: true` : `webContents.setBackgroundThrottling(false)` (la page cachée garde ses minuteries à pleine vitesse et peut être capturée) et la vue prend la taille de la zone des onglets si elle n'est pas affichée (mise en page juste).
- `active: false` : ralentissement rétabli.
- L'état de l'onglet porte `agentControlled`.
- Fermer l'onglet oublie son pilotage.

## Clavier

Une action d'agent (clic, saisie, touche) sur un onglet piloté qui n'est pas affiché ne fait plus `webContents.focus()` : la personne garde le clavier là où elle tape. Les clics (`sendInputEvent`) et la saisie (`insertText` après le focus du champ dans la page) atteignent une page cachée sans focus.

## Mesures (Electron 44, macOS)

Vue cachée (`setVisible(false)` ou retirée de la fenêtre), avec ralentissement : clics et saisie reçus, minuteries à 1 /s, capture impossible (« Current display surface not available »). Sans ralentissement : clics et saisie reçus, minuteries à pleine vitesse, capture correcte. D'où `setBackgroundThrottling(false)` sur l'onglet piloté seulement.

## Ancien portail ou ancien Desktop

Sans `setAgentControl`, le portail montre l'onglet web pour le piloter (comportement d'origine). Les onglets du portail (iframes) se pilotent cachés dans tous les cas.

## Tests

`scripts/test-agent-tabs.js`.
