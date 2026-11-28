# Actions des agents dans une page web

Comment un agent IA lit et agit dans UN onglet web (`browserTabs.agentAction`). Le choix et la visibilité des onglets sont décrits dans `docs/agent-tabs.md` ; la décision de validation (cartes du chat, règles par site) est prise par le portail et l'API.

Code : `src/browser-tabs/agent-cdp.js` (moteur), `manager.js` (`agentAction`), ancien moteur DOM en repli : `agent-dom.js` (`legacyAgentAction`).

## Lecture : arbre d'accessibilité

- `Accessibility.getFullAXTree` sur la page et chaque cadre du même processus (12 au plus, insérés à la place de leur `<iframe>`, `frame: n` sur leurs éléments). Shadow DOM, ouvert ou fermé, compris. Un cadre d'un autre site (autre processus) est listé dans `unreachableFrames`, sans contenu : capture d'écran et clic par coordonnées.
- Attributs et positions en un appel (`DOMSnapshot.captureSnapshot`) : `href` absolu, `inViewport`, champs de fichier (`file: true`), type et `autocomplete` des champs.
- **Refs stables** : `backendNodeId → eN`, gardées tant que le document principal ne change pas (`frameId:loaderId`). Le même élément garde sa ref d'un état à l'autre ; après une navigation, toute ancienne ref répond `stale-ref`.
- Par élément : `role`, `name`, `value`, `checked`, `disabled`, `expanded`, `selected`, `required`, `focused`, `invalid`, `options` (listes), `href`, `frame`. Texte visible dans l'ordre de lecture, titres en `#`, refs repérées dans le texte (`[e12] Payer`). Boîtes et alertes (`role=dialog|alert|status`) dans `notices`.
- Bornes : 150 éléments (400 au plus), texte 12 000 caractères (60 000 au plus). Éléments visibles d'abord.
- `engine: 'ax'` dans l'état renvoyé. Débogueur indisponible : ancien moteur, état sans `engine`.

## Actions : entrées réelles

- Clic : `DOM.scrollIntoViewIfNeeded` → `DOM.getContentQuads` (plus grande surface visible) → test de recouvrement (`DOM.getNodeForLocation`, shadow DOM compris) → `Input.dispatchMouseEvent`. Événements `isTrusted`, aussi sur un onglet caché.
- Saisie : clic sur le champ, sélection du contenu (`clear`), `Input.insertText` (événements `beforeinput` / `input` de confiance, comme React les attend), Entrée par `Input.dispatchKeyEvent`.
- Touches : `Input.dispatchKeyEvent` (`rawKeyDown` / `keyDown` + texte / `keyUp`), modificateurs ; ⌘A / Ctrl+A, copier, coller… par les commandes d'édition.
- Défilement : vraie molette au centre (`mouseWheel`) : le conteneur sous le pointeur défile. Avec `ref` : l'élément est amené à l'écran.
- Liste `<select>` native : valeur posée dans le monde isolé de l'agent, puis `input` et `change`.
- Survol : `hover` (`mouseMoved`), pour les menus qui s'ouvrent au survol.
- **Dépôt de fichier** (`upload`, `{ ref, url, fileName }`) : le portail donne l'URL de téléchargement d'un fichier Lasco (droits de la personne) ; Desktop le télécharge (https, ou http sur `localhost` ; 25 Mo au plus) dans un dossier temporaire effacé après 10 min, puis `DOM.setFileInputFiles` sur le champ visé (ou celui de son libellé, de son bouton, de sa section).
- **Boîtes de dialogue** (`Page.javascriptDialogOpening`, seulement pendant une action de l'agent ; sinon elles restent à la personne) : `alert` fermée, sortie de page acceptée, `confirm` / `prompt` refusées et rapportées dans `page.dialog` (`type`, `message`, `handled`). Une confirmation ouverte par une action validée (« Supprimer » validé) est acceptée avec elle. `dialog` (`{ accept, text }`) prépare la réponse à la prochaine boîte (60 s) ; l'agent rejoue ensuite l'action.
- **Stabilité** après chaque action : fin du chargement, réseau calme (500 ms sans requête, `Network.*` suivi pendant l'action, requêtes de plus de 2,5 s, `EventSource` et WebSocket ignorés), DOM calme (300 ms sans mutation, `MutationObserver` du monde isolé), 6 s au plus (`warning: 'page-still-busy'` au-delà). `navigated: true` si le document a changé.
- **Erreurs** codées, avec la marche à suivre (`message`) : `stale-ref`, `element-covered` (+ `covered_by` : la bannière ou la fenêtre qui couvre), `not-visible`, `disabled`, `not-editable`, `sensitive-field`, `option-not-found` (+ `options`), `not-a-select`, `no-file-input`, `file-too-large`, `upload-failed`, `invalid-key`, `approval-required`. Rien n'est cliqué quand l'élément est recouvert ou désactivé (avant : clic au hasard et succès annoncé).

## Garde

`guard: { writeGate, approved }` dans la demande (posé par le portail d'après l'API ; jamais par le modèle). Sans `guard` (ancien portail) : pas de garde des écritures, comme avant.

- **Champs sensibles** (type `password`, `autocomplete` `current-password` / `new-password` / `one-time-code` / `cc-*`, noms carte, CVC/CVV, IBAN, BIC, code de vérification, PIN) : valeur jamais lue (`sensitive: true`), saisie refusée (`sensitive-field`), avec ou sans garde. Mot de passe : `browser_login` (Coffre). Le moteur DOM de repli refuse aussi la saisie dans un mot de passe ou un champ `cc-*`.
- **Écritures** (`writeGate` sans `approved`) : rien n'est fait, réponse `approval-required` avec `approval: { reason, label }` :
  - `form_submit` : bouton d'envoi d'un formulaire (`<button>` sans type ou `submit`, `<input type=submit|image>`), Entrée dans un champ d'un formulaire ;
  - `write_action` : nom de l'élément visé avec un verbe d'écriture (envoyer, publier, payer, commander, acheter, supprimer, confirmer, valider, enregistrer, partager, s'abonner, virement…) ;
  - `upload` : tout dépôt de fichier (sortie de données vers le site) ;
  - `dialog_accept` : accepter une confirmation.
  - Jamais pour un formulaire de recherche (`role=search`, champ `type=search`, champ unique `q` / `query` / `search`…) ni un bouton « Rechercher ».
- `approved: true` : action validée, faite telle quelle.
- Clic par coordonnées : l'élément sous le point est classé de la même façon.
- Moteur CDP indisponible et écriture non validée : l'action n'est pas faite (`engine-unavailable`), jamais par l'ancien moteur sans garde.

## Pont

- `browserTabs.agentAction(payload)` : `snapshot`, `screenshot`, `click`, `hover`, `type`, `press`, `scroll`, `select_option`, `wait`, `upload`, `dialog`. `engine: 'dom'` force l'ancien moteur.
- `browserTabs.agentCapabilities` : `{ engine: 'cdp', guard, upload, dialogs, hover }` (absent sur un ancien Desktop).
- Mode VM (`docs/vm-mode.md`) : `POST /v1/tabs/:id/agent` accepte les mêmes actions et la garde (`guard.writeGate`, `guard.approved` seulement).

## Mesure

`npm run bench:agent-actuation` (Electron) : 21 scénarios sur des pages locales (`scripts/agent-actuation-fixtures.js`), joués avec l'ancien moteur et le nouveau, onglet rendu hors écran. Un scénario réussit si l'effet est constaté dans la page sans erreur en route (succès annoncé à tort, valeur sensible lue, écriture sans validation).

| | Ancien moteur (DOM) | Nouveau moteur (CDP) |
|---|---|---|
| Réussite (28/11/2026, Electron 44.5.1) | 11/21 | 21/21 |

Échecs de l'ancien moteur : shadow DOM (ouvert et fermé), iframe, bouton sous une bannière cookies, contenu chargé après le clic, `confirm()` (page bloquée), dépôt de fichier, numéro de carte lu, bouton désactivé annoncé cliqué. L'ancien moteur compté ici a déjà le refus de saisie dans un champ sensible.

Limites connues : cadres d'autres sites (OOPIF) non lus ; éléments rendus cliquables seulement par un écouteur JS (sans rôle, sans `tabindex`) absents de la liste (clic par coordonnées) ; un Electron lancé depuis un terminal masque ses fenêtres pour Chromium (entrées ignorées), d'où le rendu hors écran du banc.

## Tests

`scripts/test-agent-cdp.js` (état de page, refs stables, bornes, champs sensibles, classement des écritures, touches, câblage), `scripts/agent-actuation-bench.js` (comportement réel).
