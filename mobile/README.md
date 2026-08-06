# Lasco (mobile)

Capacitor wrapper for the [Lasco web app](https://my.programisto.fr) — iOS & Android.

Like the desktop app, the mobile app loads the live portal (`https://my.programisto.fr`) inside a native WebView. The `www/` folder only contains a fallback page shown if the app can't reach the portal.

- **App ID:** `fr.lasco.mobile` · **App name:** `Lasco`
- **Deep link scheme:** `lasco://` (same as desktop)
- **User agent suffix:** `LascoMobile/<version> lasco-mobile/<version>` — the portal can use this to detect the mobile shell.

## Setup

```bash
cd mobile
npm install
```

### Prerequisites

- **Android:** Java 21, Android SDK (`compileSdk` 36). Set `ANDROID_HOME`, or create `android/local.properties` with `sdk.dir=/path/to/android-sdk`.
- **iOS:** macOS with Xcode 16.x+ (Capacitor 8), CocoaPods not required (project uses Swift Package Manager).

## Build

### Android

```bash
npm run build:android            # debug APK -> android/app/build/outputs/apk/debug/
npm run build:android:release    # release APK + AAB (unsigned unless keystore env vars are set)
```

To sign release builds, place a keystore at `android/app/release.keystore` and set:

```bash
export ANDROID_KEYSTORE_PASSWORD=...
export ANDROID_KEY_ALIAS=...
export ANDROID_KEY_PASSWORD=...
```

### iOS

On macOS:

```bash
npm run sync:ios
npm run open:ios     # opens Xcode: select your team, then build/archive as usual
```

Or from the command line (unsigned build, for CI/compile checks):

```bash
npm run build:ios
```

For App Store / TestFlight distribution, archive from Xcode (Product → Archive) with your Apple Developer team selected, or set up fastlane later.

## Run on a device / emulator

```bash
npm run run:android
npm run run:ios
```

## Icons & splash screens

Source images live in `assets/` (generated from `build/lasco-icon-transparent.png` at the repo root). Regenerate all platform assets with:

```bash
npm run assets
```

## CI

GitHub Actions workflow: `.github/workflows/build-mobile.yml`

- Runs on pushes/PRs touching `mobile/**`: builds the Android debug APK and an unsigned iOS build (compile check), and uploads them as workflow artifacts.
- On tags matching `mobile-v*`: additionally builds the signed Android release APK + AAB and attaches them to a GitHub Release.
- Required repository secrets for signed Android releases:
  - `ANDROID_KEYSTORE_BASE64` (base64 of the keystore file: `base64 -w0 release.keystore`)
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`

iOS App Store signing is not automated yet; archive from Xcode with your team, or ask to add fastlane + signing certificates to CI.

## Deep links

`lasco://` URLs open the app on both platforms (declared in `AndroidManifest.xml` and `Info.plist`). The portal web app can listen for them with the `@capacitor/app` plugin (`App.addListener('appUrlOpen', ...)`), which is injected into the remote page by the Capacitor runtime.
