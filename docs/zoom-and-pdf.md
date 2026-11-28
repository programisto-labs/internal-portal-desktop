# Zoom, impression et PDF

Comme Chrome : zoom retenu par site, impression et « Enregistrer en PDF » des onglets web.

## Zoom des onglets web

- **Échelle de Chrome** (`ZOOM_LEVELS` de `src/browser-tabs/site-zoom.js`) : 25 % à 500 %. ⌘+ / ⌘= / ⌘- / ⌘0 (Ctrl ailleurs) dans la page, ⌘ + molette ou pincement (`zoom-changed`), menu ☰ du portail, loupe de la barre d'adresse (`browserTabs.zoom({ tabId, direction: 'in' | 'out' | 'reset' })`).
- **Retenu par site** : un niveau par hôte (`www.example.com`), comme Chrome. Appliqué à chaque page de cet hôte à la navigation (`did-navigate`), dans tous les onglets et toutes les fenêtres : un changement est suivi tout de suite par les autres onglets du site (`siteZoom.subscribe`), et la barre d'adresse reçoit le nouveau `zoomFactor` (`browser-tab-state`).
- **Persistant** : `userData/browser-site-zoom.json` (`{ version: 1, sites: { host: factor } }`, 500 sites au plus, 100 % jamais écrit). Repris au redémarrage et à la sortie de veille (docs/tab-sleep.md) : le zoom du site l'emporte sur celui relevé à la mise en veille.
- **Fenêtre privée** : même règle, en mémoire seulement (docs/private-browsing.md).
- Pages sans site (`about:`, `data:`, page d'erreur) : pas de zoom retenu.

## Zoom des pages du portail

Le portail zoome **la page de l'onglet actif**, pas toute la fenêtre (barre latérale, onglets et colonne Lasco AI gardent leur taille), comme une page de Chrome. Il l'annonce par `appMenu.setState({ pageZoom: true })` : le menu Présentation remplace alors Zoom avant / Zoom arrière / Taille réelle d'Electron (qui zoomaient toute la fenêtre et décalaient les vues natives des onglets web) par des commandes envoyées à la page (`app-menu-command` : `zoom-in`, `zoom-out`, `zoom-reset`), raccourcis ⌘+ / ⌘= / ⌘- / ⌘0 compris. La page les applique à l'onglet actif : page web par `browserTabs.zoom`, page du portail par le zoom CSS de son iframe (un niveau pour toutes les pages du portail, une seule origine, retenu par la page). Portail ancien ou page de connexion : rôles d'Electron, comme avant.

Focus dans un onglet web : la vue native traite ⌘+ / ⌘- / ⌘0 elle-même (`before-input-event`), le menu ne reçoit rien.

## Impression

- Onglet web : ⌘P dans la page, clic droit > « Imprimer… », menu ☰ > « Imprimer… » (`browserTabs.print({ tabId })`, `webContents.print`). La fenêtre d'impression du système propose aussi l'enregistrement en PDF.
- Page du portail : le portail imprime le cadre de l'onglet (`print()` de l'iframe) ; Desktop n'intervient pas.

## Enregistrer en PDF (onglet web)

`webContents.printToPDF` (feuilles de style d'impression, arrière-plans, A4 sauf taille déclarée par la page), puis `saveFile` du service des téléchargements (docs/downloads.md) : dossier des Téléchargements, jamais d'écrasement (« Titre (1).pdf »), ajouté à la liste comme un téléchargement terminé (`source: 'web'`, `mimeType: 'application/pdf'`).

- Nom : titre de la page (« / », « \ » et « : » remplacés), sinon l'hôte, sinon « page » (`pdfFilename`, `src/browser-tabs/page-pdf.js`).
- Accès : menu ☰ du portail > « Enregistrer en PDF… » ; clic droit sur la page > « Enregistrer en PDF… », seulement après `pdf.ready()` du portail, qui reçoit `{ tabId, action: 'save-pdf' }` sur `browser-tab-shortcut` et affiche la notification « PDF enregistré · Ouvrir · Afficher dans le dossier ».
- Page d'erreur de Lasco : `not-web`.

### Pont `lascoDesktop.browserTabs.pdf`

Fenêtres du portail, cadre principal, origine du portail (même contrôle que les téléchargements).

| Méthode | Effet |
| --- | --- |
| `ready()` | le portail traite l'action `save-pdf` (clic droit) |
| `saveTab({ tabId })` | `{ ok, filename, item }` (`item` : élément de la liste des téléchargements) ; `unknown-tab`, `not-web`, `no-directory`, `write-failed` |

## Tests

`scripts/test-site-zoom.js` (clé par hôte, persistance, 100 % oublié, fenêtre privée, abonnement, nom du PDF), `scripts/test-app-menu.js` (menu Présentation).
