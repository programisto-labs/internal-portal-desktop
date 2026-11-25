# Moteurs de recherche du navigateur

La barre d'adresse des onglets de Lasco cherche avec un moteur choisi dans **Lasco > Réglages… > Moteur de recherche**, et peut chercher directement sur un site par son raccourci, comme Chrome et Brave.

## Réglages

- **Moteur par défaut** : Google (défaut), Bing, DuckDuckGo, Ecosia, Brave Search, Qwant, Startpage, Kagi, ou tout moteur ajouté / site repéré actif. Sert à la barre d'adresse et au « Rechercher « … » sur … » du clic droit d'une page web.
- **Moteurs ajoutés** : nom, raccourci (sans espace, unique), URL http(s) où `%s` est remplacé par la recherche (format de Chrome). Modifiables et supprimables.
- **Sites repérés** : un site qui déclare son moteur OpenSearch devient un raccourci (hôte sans `www.`, ex. `fr.wikipedia.org`). Désactiver le garde hors de la barre d'adresse ; supprimé, il revient à la visite suivante. Modifier un site en fait un moteur ajouté (le site ne le réécrit plus). Interrupteur « Ajouter les sites visités qui proposent une recherche » (activé par défaut).
- Fichier : `search-engines.json` dans `userData`, commun à toutes les fenêtres. Code : `src/browser-tabs/search-engines.js`.

## Repérage OpenSearch

- Après chaque chargement d'un onglet web (`did-finish-load`), une fois par hôte et par session, si le site n'a pas encore de raccourci : lecture, dans un monde isolé, de `<link rel="search" type="application/opensearchdescription+xml">`.
- La description est lue par le processus principal (`net.fetch`, sans cookies, 5 s, 64 Ko au plus). Seule l'URL `type="text/html"` en GET est gardée ; `{searchTerms}` → `%s`, paramètres facultatifs vidés, paramètre inconnu requis : refus.
- **Même site** : page, description (redirection comprise) et URL de recherche sur le même hôte, au `www.` près. Sinon rien n'est ajouté. 300 sites au plus (le moins utilisé part).

## Pont du portail (`lascoDesktop.browserTabs.searchEngines`)

Fenêtres du portail seulement.

- `get()` → `{ ok, defaultEngine, engines }` : moteur par défaut et moteurs actifs (`{ id, name, keyword, template, kind: 'builtin' | 'custom' | 'site', active }`).
- `onChange(callback)` : même forme (sans `ok`), à chaque changement (Réglages, site repéré).
- `markUsed({ id })` : raccourci utilisé (garde le site en cas d'éviction).
- `manage()` : ouvre Réglages > Moteur de recherche.

La barre d'adresse (portail) : texte qui n'est pas une adresse → moteur par défaut ; raccourci (ou début de raccourci) puis **Tab**, ou raccourci exact puis **Espace** → mode « Rechercher sur … » ; `raccourci recherche` puis Entrée cherche aussi sur le site.
