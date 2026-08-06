# App icons

| File | Role |
|------|------|
| **`icon-source.png`** | Raw asset — copy from `internal-portal-front/apps/frontend/public/lasco-favicon.png` when the web favicon changes. |
| **`icon.png`** | **Generated** — black macOS squircle **inset ~80%** of the canvas (transparent gutter so Dock optical size matches Cursor), flame ~70% of the tile. Run `npm run icons:pad` or any `build:*` / `prebuild`. |
| **`lasco-icon-transparent.png`** | Optional copy from frontend `lasco-icon-transparent.png`. |

After updating the favicon:

```bash
cp ../internal-portal-front/apps/frontend/public/lasco-favicon.png ./build/icon-source.png
npm run icons:pad
```

In `scripts/pad-dock-icon.js`:
- `TILE_RATIO` — overall black plate size in the Dock (lower = smaller tile vs Cursor).
- `DRAW_RATIO` — flame size inside the plate.
