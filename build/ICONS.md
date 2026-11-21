# App icons

| File | Role |
|------|------|
| **`icon-source.png`** | Raw asset — copy from `internal-portal-front/apps/frontend/public/lasco-favicon.png` when the web favicon changes. |
| **`icon.png`** | **Generated** — gradient macOS squircle (black bottom → lighter charcoal top), **inset ~80%** of the canvas (transparent gutter so Dock optical size matches Cursor), flame ~70% of the tile. Run `npm run icons:pad` or any `build:*` / `prebuild`. |
| **`lasco-icon-transparent.png`** | Optional copy from frontend `lasco-icon-transparent.png`. |

After updating the favicon:

```bash
cp ../internal-portal-front/apps/frontend/public/lasco-favicon.png ./build/icon-source.png
npm run icons:pad
```

In `scripts/pad-dock-icon.js`:
- `TILE_RATIO` — overall plate size in the Dock (lower = smaller tile vs Cursor).
- `DRAW_RATIO` — flame size inside the plate.
- `GRADIENT_TOP` / `GRADIENT_BOTTOM` — plate vertical gradient colors.

## Menu bar icon (macOS)

`build/tray/trayTemplate.png` / `trayDotTemplate.png` (+ `@2x`) are **generated** from `icon-source.png` (same flame as the app icon): black silhouette on transparent, macOS « template » image (tinted for light / dark menu bars), yellow core cut out so the flame stays readable at 18 pt. The `Dot` variant adds a point when something waits or is unread. Regenerate with `npm run icons:tray` after changing `icon-source.png`.

## Tray icon (Windows / Linux)

`build/tray/tray.png` / `trayDot.png` (+ `@2x`) are **generated** by the same script: the flame in color, 16 px (32 px @2x), nearest-neighbour (pixel art). The `Dot` variant adds a red point ringed in white (readable on light and dark taskbars).
