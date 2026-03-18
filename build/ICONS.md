# App icons

| File | Role |
|------|------|
| **`icon-source.png`** | Raw asset — copy from `internal-portal-front/apps/frontend/public/lasco-favicon.png` when the web favicon changes. |
| **`icon.png`** | **Generated** — inset torch (~66% of tile) for correct Dock/toolbar visual weight. Run `npm run icons:pad` or any `build:*` / `prebuild`. |
| **`lasco-icon-transparent.png`** | Optional copy from frontend `lasco-icon-transparent.png`. |

After updating the favicon:

```bash
cp ../internal-portal-front/apps/frontend/public/lasco-favicon.png ./build/icon-source.png
npm run icons:pad
```

To make the logo smaller or larger in the Dock, edit `DRAW_RATIO` in `scripts/pad-dock-icon.js` (lower = more margin).
