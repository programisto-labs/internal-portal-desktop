#!/usr/bin/env bash
# Debug code signing: list identities and check if the built app is signed.
# Run this when the build says "skipped macOS application code signing" or "0 valid identities found".

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_APP="$PROJECT_DIR/dist/mac-arm64/Internal Portal.app"

echo "=== Code signing identities (need 'Developer ID Application') ==="
security find-identity -v -p codesigning
echo ""
echo "Only identities with 'Developer ID Application' are used for distribution outside the App Store."
echo "If you see 0 valid identities, or only 'Mac Developer' / 'Apple Development', create a"
echo "'Developer ID Application' certificate in Apple Developer → Certificates."
echo ""

if [[ -d "$DIST_APP" ]]; then
  echo "=== Built app code signature ==="
  if codesign -dv --verbose=2 "$DIST_APP" 2>&1; then
    echo ""
    echo "App is signed. Checking notarization staple..."
    if xcrun stapler validate "$DIST_APP" 2>/dev/null; then
      echo "Notarization ticket is stapled."
    else
      echo "No notarization ticket (or invalid). Run build with APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD."
      echo "(If you see 'stapler requires Xcode': full Xcode is needed for stapler; signing can still work with Command Line Tools.)"
    fi
  else
    echo "App is NOT signed (or signature invalid). Fix identities above and run: npm run build:mac:signed"
  fi
else
  echo "Built app not found at: $DIST_APP (run build first)"
fi
