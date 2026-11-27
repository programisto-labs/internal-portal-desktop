# Capture d'écran

Comme Brave / Edge : « Capturer la page entière » et « Capturer la partie visible » d'un onglet web, et la partie visible d'une page du portail. L'image (PNG) est copiée dans le presse-papiers et enregistrée dans le dossier des Téléchargements de Lasco ; elle apparaît dans la liste des téléchargements (docs/downloads.md).

## Où

- `src/browser-tabs/page-capture.js` : plan de découpage (`planFullPageCapture`), assemblage des morceaux (`stitchBitmaps`), nom du fichier (`captureFilename`), captures (`captureFullPage`, `captureVisible`, `capturePageImage`).
- `src/browser-tabs/manager.js` : `captureImage({ tabId, mode })`, entrées du menu contextuel, ⌘⇧S.
- `src/downloads/service.js` : `saveFile({ name, data, mimeType, url, source })`, fichier écrit par Lasco, même nommage sans écraser, ajouté à la liste comme un téléchargement terminé.
- `src/main.js` : IPC, presse-papiers.

## Page entière

Protocole DevTools (`webContents.debugger`) : `Page.getLayoutMetrics` donne la taille du contenu, puis `Page.captureScreenshot` avec `captureBeyondViewport: true` capture au-delà de la fenêtre, **sans défiler la page**.

- **Morceaux** : au plus 8 192 pixels d'écran de haut par morceau (sous la limite des textures GPU, 16 384 en général), assemblés de haut en bas en BGRA puis réencodés en PNG. Une page courte : un seul appel, PNG tel quel.
- **Très grande page** : 100 millions de pixels au plus. Au-delà, l'image est réduite (jusqu'à la moitié de la résolution de l'écran), puis la hauteur est coupée (`truncated: true`).
- **Débogueur** : attaché pour la capture puis détaché, seulement s'il a été attaché ici. Les DevTools ouverts n'utilisent pas `webContents.debugger` et ne sont pas gênés ; un autre client déjà attaché garde le sien.
- **Repli** : protocole refusé ou page plantée → partie visible (`fallback: true`).

## Partie visible

`webContents.capturePage()` de la vue de l'onglet. Page du portail : `capturePage(rect)` de la fenêtre, `rect` = cadre de l'onglet (iframe) dans la fenêtre, borné à la fenêtre. Pas de page entière pour une page du portail.

## Nom du fichier

« Capture <site> <AAAA-MM-JJ> <HH.MM.SS>.png » : hôte sans `www.` pour une page web, titre de la page du portail sinon (« / » et « : » remplacés), « page » à défaut. Jamais d'écrasement : « … (1).png ».

## Accès

- Menu ☰ du navigateur (portail) : « Capture d'écran » > page entière, partie visible, « Envoyer à Lasco AI ».
- Clic droit sur une page web : « Capturer la page entière », « Capturer la partie visible ».
- ⌘⇧S (macOS) / Ctrl+Shift+S : page entière (partie visible sur une page du portail). ⌘S seul reste à la page.

Le menu contextuel et ⌘⇧S n'apparaissent qu'après `screenshots.ready()` du portail : un portail qui ne sait pas enregistrer la capture ne les reçoit pas. Ils envoient `{ tabId, action: 'capture-full-page' | 'capture-visible' }` sur `browser-tab-shortcut` ; le portail appelle `captureTab` et affiche la notification « Capture enregistrée · Ouvrir · Afficher dans le dossier » (actions `downloads.open(id)` / `downloads.show(id)`).

## Pont `lascoDesktop.browserTabs.screenshots`

Fenêtres du portail, cadre principal, origine du portail (même contrôle que les téléchargements).

| Méthode | Effet |
| --- | --- |
| `ready()` | le portail traite les actions de capture |
| `captureTab({ tabId, mode: 'full' \| 'visible', target? })` | onglet web |
| `capturePortal({ rect, title, target? })` | partie visible d'une page du portail |

`target` : `'file'` (défaut) enregistre et copie ; réponse `{ ok, item, copied, filename, width, height, mode, truncated, fallback }`, `item` = élément de la liste des téléchargements. `'assistant'` : rien sur le disque, `data` (PNG, `Uint8Array`) pour la pièce jointe du chat Lasco AI.

## Tests

`scripts/test-page-capture.js` (découpage, assemblage, nommage, débogueur détaché, repli, `saveFile`).
