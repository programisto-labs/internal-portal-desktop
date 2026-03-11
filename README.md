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

### macOS: internal deployment (no code signing, company-only)

For distributing only inside your company, use an unsigned build and a single install script so users never see the quarantine ("damaged" / "unidentified developer") message. The script can download the DMG from a URL (e.g. a GitHub release) so you only share the script.

1. **Build and publish:** Run `npm run build:mac:internal`, then create a **GitHub release** and attach the DMG from `dist/`. Use a **fixed asset name** (e.g. `Internal-Portal-mac.dmg`) so the "latest" URL always works.

2. **Set the DMG URL in the script:** Open `scripts/install-from-dmg.sh` and set `DEFAULT_DMG_URL` to your release URL, for example:
   ```bash
   DEFAULT_DMG_URL="https://github.com/YOUR_ORG/internal-portal-desktop/releases/latest/download/Internal-Portal-mac.dmg"
   ```
   Or leave it empty and have users run with the URL: `bash install-from-dmg.sh <URL>`.

3. **Share only the script** with users. They run once (macOS only):
   ```bash
   bash install-from-dmg.sh
   ```
   Or with an explicit URL: `bash install-from-dmg.sh https://.../releases/latest/download/Internal-Portal-mac.dmg`  
   The script downloads the DMG, installs the app to Applications, and removes the quarantine attribute. They can then open Internal Portal normally.

   From the project: `npm run install:mac` (optional first argument: URL or path to a local DMG).

### macOS: signed + notarized build (no “damaged” warning for users)

**Reference:** [Electron – Signature de code](https://www.electronjs.org/fr/docs/latest/tutorial/code-signing) (code signing then notarization). Prerequisites: Apple Developer Program, **Xcode** installed, **Developer ID Application** certificate (Account Holder creates it at [developer.apple.com](https://developer.apple.com/account/resources/certificates/list); install the `.cer` via Keychain or Xcode → Settings → Accounts → Manage Certificates). This project uses **electron-builder** for packaging and signing.

1. **App-specific password** (for notarization)
   - Go to [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords.
   - Create a new password, name it e.g. “Internal Portal notarize”, copy it once (it’s shown only once).

2. **Set environment variables** (don’t commit these):
   ```bash
   export APPLE_ID="your-apple-id@email.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   # Optional if you have multiple teams:
   export APPLE_TEAM_ID="8S6Z442DR3"
   ```

3. **Build** (uses your Developer ID cert from Keychain + notarizes):
   ```bash
   npm run build:mac:signed
   ```
   electron-builder will sign the app with your **Developer ID Application** certificate and submit the app/DMG to Apple for notarization, then staple the ticket so users can open it without the “damaged” dialog.

   **Using a .env file:** Copy `.env.example` to `.env`, fill in the values, then run:
   ```bash
   set -a && source .env && set +a && npm run build:mac:signed
   ```

4. **Test quarantine locally** (simulate a user who downloaded the DMG):
   ```bash
   npm run test:quarantine
   ```
   This copies the built app to `/tmp`, adds the same quarantine attribute macOS adds when downloading from the internet, and opens it. If you see the “damaged” dialog, notarization or stapling failed; if it opens, users who download the DMG should be fine.

#### Troubleshooting: “skipped code signing” / “0 valid identities” / “damaged” dialog

1. **Check what identities you have:**
   ```bash
   npm run debug:signing
   ```
   You must see at least one **“Developer ID Application: …”** (not “Mac Developer” or “Apple Development”). That’s the cert used for apps distributed outside the App Store.

2. **If you see “CSSMERR_TP_CERT_EXPIRED”**  
   The certificate (often “localhost”) is expired. Remove it from Keychain Access or create a new **Developer ID Application** cert in [Apple Developer → Certificates](https://developer.apple.com/account/resources/certificates/list) and install it.

3. **If you see “CSSMERR_TP_NOT_TRUSTED”**  
   That identity isn’t trusted for code signing (wrong type or broken chain). For distribution outside the App Store you need **Developer ID Application**. Create it in Apple Developer → Certificates → “+” → **Developer ID Application** (under the “Software” section), download the `.cer`, double‑click to add to Keychain.

4. **“unable to build chain to self-signed root” / errSecInternalComponent**  
   The Developer ID certificate chain is incomplete or not found by `codesign` when the build runs. Try in order:
   - **Install the G2 intermediate:** [Apple PKI](https://www.apple.com/certificateauthority/) → download **Developer ID - G2** (`DeveloperIDG2CA.cer`). Double‑click to add to keychain.
   - **Install Apple Root CA - G2:** Same page → download **Apple Root CA - G2** (`AppleRootCA-G2.cer`). Double‑click to add to **login** (and optionally drag a copy into **System**). This completes the chain (leaf → Developer ID G2 → Apple Root G2).
   - **Force use of login keychain during build:** Run `npm run build:mac:signed:keychain` instead of `build:mac:signed`. That sets `CSC_KEYCHAIN` to your login keychain so `codesign` uses it explicitly. If your login keychain has a different path (e.g. `login.keychain` without `-db`), set it yourself: `CSC_KEYCHAIN=$HOME/Library/Keychains/login.keychain set -a && source .env && set +a && npm run build:mac:signed`.
   - **Put the intermediate in the System keychain:** In Keychain Access, select **login** → **Certificates**. Drag **Developer ID Certification Authority** (expires Sep 2031) from the list onto **System** in the left sidebar. Enter your password. Then run a clean rebuild.
   - **Trust set to “Use System Defaults”:** If you previously set the Developer ID cert to “Always Trust”, set it back to **Use System Defaults** (double‑click cert → Trust). “Always Trust” can cause “unable to build chain to self-signed root” when `codesign` runs.
   - **Last resort – sign with a .p12 that has the full chain:** Add **Apple Root CA - G2** from [Apple PKI](https://www.apple.com/certificateauthority/) to your **login** keychain. Then in Keychain Access, export **Developer ID Application: BRUMISPHERE** as .p12 and choose **Include all certificates in the chain** so the .p12 contains leaf + intermediate + root. Save as `Certificates.p12` in the project root. In `.env` set `CSC_KEY_PASSWORD=` to your .p12 password (do not commit it). Then:
     ```bash
     rm -rf dist && set -a && source .env && set +a && npm run build:mac:p12
     ```
     The script uses `Certificates.p12` and the password from `.env`. You can add notarization env vars to `.env` as well so the same build notarizes.

5. **After fixing the certificate**, run `npm run build:mac:signed` again. The log should show signing (no “skipped”). Then run `npm run test:quarantine` again; the app should open without the “damaged” dialog (and with notarization env vars set, it will be notarized too).

6. **Blocked: certificate revoked**  
   If the **Developer ID Application** certificate shows as **Revoked** in Xcode → Accounts → Manage Certificates (or on the Apple Developer site), signing will keep failing. You need a **new** Developer ID Application cert. Only the **Account Holder** can create it at [developer.apple.com/account/resources/certificates/list](https://developer.apple.com/account/resources/certificates/list) → "+" → **Developer ID Application** (G2), using a CSR from your Mac; they send you the new `.cer`. Install it, remove the old revoked cert from Keychain, then use `build:mac:signed` or a new `.p12`. Until then, use an **unsigned** build (see below).

#### Unsigned macOS build (while waiting for a valid cert)

To build a DMG **without** code signing (e.g. for internal testing):

```bash
npm run build:mac
```

The app will be unsigned. Users may see the "damaged" dialog; they can **Right-click → Open** once, or run `xattr -cr "/Applications/Internal Portal.app"` after install. Do not distribute unsigned builds publicly.

## Optional: custom icons

Place icons for packaging:

- **macOS**: `build/icon.icns`
- **Windows**: `build/icon.ico`
- **Linux**: `build/icons/` (e.g. 256x256.png, 512x512.png)

If missing, Electron’s default icon is used.
