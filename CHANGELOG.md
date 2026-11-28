# Changelog

## [2.13.0](https://github.com/programisto-labs/internal-portal-desktop/compare/v2.12.0...v2.13.0) (2026-11-28)


### Nouveautés

* **agent-tabs:** attente de stabilité par onglet (agents multi-onglets) ([feb942c](https://github.com/programisto-labs/internal-portal-desktop/commit/feb942c18531bb25e02297a6fc89940f3b685b16))
* **agent-tabs:** attente de stabilité par onglet et contrat multi-onglets ([c52a1ac](https://github.com/programisto-labs/internal-portal-desktop/commit/c52a1acd5ccb7f2305f35c2e1dece2f79df5440d))
* **agents:** lecture par l'arbre d'accessibilité et actions CDP dans les pages web ([7b0a73f](https://github.com/programisto-labs/internal-portal-desktop/commit/7b0a73f0c13a22354b5d81f93f9982d121d19a5b))
* **agents:** lecture par l'arbre d'accessibilité et actions CDP dans les pages web ([8ea961d](https://github.com/programisto-labs/internal-portal-desktop/commit/8ea961d4aa77b97c5bf511b9f2f05b06721910a8))
* **browser:** « Incruster l'onglet » pour toute page web ou page de Lasco ([1113d81](https://github.com/programisto-labs/internal-portal-desktop/commit/1113d814c99acbedcc877df27f06a57a8aa10e3a))
* **browser:** incrustation vidéo et fenêtre flottante des appels ([fc271e3](https://github.com/programisto-labs/internal-portal-desktop/commit/fc271e3866025f36fb66e30f804f600a94a563ed))
* **browser:** incrustation vidéo et fenêtre flottante des appels ([fa1bfc5](https://github.com/programisto-labs/internal-portal-desktop/commit/fa1bfc5130b22a86c63c63009de4eb9e9c8020cc))
* **browser:** profils de navigation et une session par workspace ([00d1f61](https://github.com/programisto-labs/internal-portal-desktop/commit/00d1f614ac796c7f4aaf28555b1e3d6362a1c89c))
* **browser:** profils de navigation et une session par workspace ([df21dc6](https://github.com/programisto-labs/internal-portal-desktop/commit/df21dc613a9cbd71abd69b3fbd7a0ffa69e28667))
* **browser:** zoom retenu par site, « Enregistrer en PDF », zoom de la page du portail ([536ca34](https://github.com/programisto-labs/internal-portal-desktop/commit/536ca34183d4ce0569b147d6cb46707a2de6ae07))
* **browser:** zoom retenu par site, « Enregistrer en PDF », zoom de la page du portail ([216822f](https://github.com/programisto-labs/internal-portal-desktop/commit/216822fb4cc7ea7f4a33dd282f2038e65741f466))
* **extensions:** extensions Chrome des onglets web ([3e1619f](https://github.com/programisto-labs/internal-portal-desktop/commit/3e1619f78325a4415519b67c67363cf6c72c2101))
* **extensions:** extensions Chrome des onglets web (installation vérifiée, DNR, barre d'outils, politique) ([5c53d15](https://github.com/programisto-labs/internal-portal-desktop/commit/5c53d151097f86960b15be5506370e2e3224091b))
* **onglets:** liste des onglets tenue par Desktop, fenêtres détachées restaurées ([72dc879](https://github.com/programisto-labs/internal-portal-desktop/commit/72dc8799d8a62b11bf8158009070377b08a57dbd))
* **onglets:** liste des onglets tenue par Desktop, fenêtres détachées restaurées ([4047ad0](https://github.com/programisto-labs/internal-portal-desktop/commit/4047ad0c013d8a28a6c2c12fb2fbb8a192649235))
* **onglets:** onglets web épinglés ([ed0e807](https://github.com/programisto-labs/internal-portal-desktop/commit/ed0e80758f4d0c58f18eef7b7d79f7e5a1a44571))
* **onglets:** onglets web épinglés (menu natif, liens vers un autre site) ([5bcf5d1](https://github.com/programisto-labs/internal-portal-desktop/commit/5bcf5d1cbd2df54dd80571cb8c0fc4fcd3f83f73))
* **onglets:** setPinned accepte { pinned, pinnedUrl } (même appel que la garde de veille) ([5c1ca2d](https://github.com/programisto-labs/internal-portal-desktop/commit/5c1ca2def056089a6948a6177f4b0876f1db047b))


### Corrections

* **browser-profiles:** empreinte du compte en base 36 (accessTokenOwner du portail) ([68b9d78](https://github.com/programisto-labs/internal-portal-desktop/commit/68b9d7862d574d1e27593e56e98fa0d8b08b8112))
* **security:** barrière IPC, fusibles, HTTPS d'abord, version minimale et Electron 44.11.6 ([ee0c19f](https://github.com/programisto-labs/internal-portal-desktop/commit/ee0c19fca299f5c9d9c28fe356b3c4b2e1cbdf0e))
* **security:** barrière IPC, fusibles, HTTPS d'abord, version minimale, Electron 44.11.6 ([2cd3b24](https://github.com/programisto-labs/internal-portal-desktop/commit/2cd3b246676fdcbe4427b5966a5a7bffd45268b2))


### Performances

* **onglets:** budget d'onglets vivants, relevé agrégé et banc 50-100 onglets ([06021d1](https://github.com/programisto-labs/internal-portal-desktop/commit/06021d1380b8912e277f831fc5badebaf649f16f))
* **onglets:** budget d'onglets vivants, relevé agrégé, banc 50-100 onglets ([15491a5](https://github.com/programisto-labs/internal-portal-desktop/commit/15491a5ab595397b5e576a845a90acec2fa55300))

## [2.12.0](https://github.com/programisto-labs/internal-portal-desktop/compare/v2.11.0...v2.12.0) (2026-11-27)


### Nouveautés

* **devtools:** onglet « Responsive » dans les DevTools des onglets web ([03f8bd6](https://github.com/programisto-labs/internal-portal-desktop/commit/03f8bd6066c55459ca1b01cb2acad92c9bb13b51))
* **navigateur:** bloqueur de pubs et de traqueurs des onglets web ([5810422](https://github.com/programisto-labs/internal-portal-desktop/commit/5810422bcd3eb959d9faa4a54387e4aaf9cefc79))
* **navigateur:** bloqueur de pubs et de traqueurs des onglets web ([80c580d](https://github.com/programisto-labs/internal-portal-desktop/commit/80c580d9341faf16a90901e96ebb8a19ad1841e8))
* **navigateur:** capture d'écran de la page entière ou de la partie visible ([39e0bee](https://github.com/programisto-labs/internal-portal-desktop/commit/39e0bee001cb8e32540ef95b941198407db070b4))
* **navigateur:** capture d'écran de la page entière ou de la partie visible ([e724330](https://github.com/programisto-labs/internal-portal-desktop/commit/e724330b2e84d187509b6078536e223986713353))
* **navigateur:** fenêtre de navigation privée ([c441fe3](https://github.com/programisto-labs/internal-portal-desktop/commit/c441fe389f19608fb0b26fdca95e1dd809ff05f0))
* **navigateur:** fenêtre de navigation privée ([f718a1b](https://github.com/programisto-labs/internal-portal-desktop/commit/f718a1b23deedc898fc0205cc5b2b725214d7c14))
* **navigateur:** importer favoris, historique et mots de passe d'un autre navigateur ([873b235](https://github.com/programisto-labs/internal-portal-desktop/commit/873b235737a490060247f8c63a54308df8318a0a))
* **navigateur:** importer favoris, historique et mots de passe d'un autre navigateur ([c2e8989](https://github.com/programisto-labs/internal-portal-desktop/commit/c2e89898ac9f13cc9e899ee294cd5af88199de4f))
* **navigateur:** protection contre les sites dangereux (Safe Browsing) ([ad8d572](https://github.com/programisto-labs/internal-portal-desktop/commit/ad8d57272b4e190775035a6ee5547b75859e5f38))
* **navigateur:** protection contre les sites dangereux (Safe Browsing) ([2c851fc](https://github.com/programisto-labs/internal-portal-desktop/commit/2c851fcb4a8569b659d11ea7fe64662f7dba67c9))
* **navigateur:** recherche dans les onglets (⌘⇧A) ([f493966](https://github.com/programisto-labs/internal-portal-desktop/commit/f493966742649937f86af30e8861831f1892ff82))
* **onglets:** mise en veille des onglets web inactifs (économiseur de mémoire) ([5a96bec](https://github.com/programisto-labs/internal-portal-desktop/commit/5a96bec2c6f172bf114086366bd55639c3ec7d6b))
* **onglets:** mise en veille des onglets web inactifs (économiseur de mémoire) ([8ab7925](https://github.com/programisto-labs/internal-portal-desktop/commit/8ab7925fe356722325637f8da5812ae16cc261bc))


### Corrections

* **import navigateur:** distinguer une demande du trousseau restée sans réponse ([19da93a](https://github.com/programisto-labs/internal-portal-desktop/commit/19da93a9ad252d5fe85f3d69baf9a1f17ce1ca02))

## [2.11.0](https://github.com/programisto-labs/internal-portal-desktop/compare/v2.10.3...v2.11.0) (2026-11-27)


### Nouveautés

* **onglets web:** réglages des autorisations des sites, comme Chrome / Brave ([c77865a](https://github.com/programisto-labs/internal-portal-desktop/commit/c77865ab257a423bf271a0aa3bb177aee5aa5ac3))
* **onglets web:** réglages des autorisations des sites, comme Chrome / Brave ([7466f5c](https://github.com/programisto-labs/internal-portal-desktop/commit/7466f5ca0bbb065eda7a9f0ba43afd4e8927b908))

## [2.10.3](https://github.com/programisto-labs/internal-portal-desktop/compare/v2.10.2...v2.10.3) (2026-11-27)


### Corrections

* **onglets web:** Meet demande la caméra (vérification pan/tilt/zoom) ([4fe3ace](https://github.com/programisto-labs/internal-portal-desktop/commit/4fe3acef73f40d0337a991b5ec9faa717014d72f))
* **onglets web:** Meet demande la caméra (vérification pan/tilt/zoom) ([a55cedf](https://github.com/programisto-labs/internal-portal-desktop/commit/a55cedfe8f3387adfacf881e5cf38e363e4dbbfd))

## [2.10.2](https://github.com/programisto-labs/internal-portal-desktop/compare/v2.10.1...v2.10.2) (2026-11-27)


### Corrections

* **onglets web:** Google Meet pose enfin la question micro et caméra ([0824c36](https://github.com/programisto-labs/internal-portal-desktop/commit/0824c36e8dd8c5b7ae68487fea712dfb3b3cb693))
* **onglets web:** Google Meet pose enfin la question micro et caméra ([1a17900](https://github.com/programisto-labs/internal-portal-desktop/commit/1a179002c6c2e3cce443065bfff9c1300cdb375f))
