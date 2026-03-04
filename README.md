# Internal Portal Desktop

Electron desktop app for [Programisto internal portal](https://my.programisto.fr) (Mac, Windows, Linux).

## Setup

```bash
cd internal-portal-desktop
npm install
```

## Run

```bash
npm run dev
# or
npm start
```

## Build installers

- **macOS**: `npm run build:mac` → `dist/` (dmg, zip)
- **Windows**: `npm run build:win` → `dist/` (nsis installer, portable)
- **Linux**: `npm run build:linux` → `dist/` (AppImage, deb)

Or build for current OS: `npm run build`.

## Optional: custom icons

Place icons for packaging:

- **macOS**: `build/icon.icns`
- **Windows**: `build/icon.ico`
- **Linux**: `build/icons/` (e.g. 256x256.png, 512x512.png)

If missing, Electron’s default icon is used.
