#!/usr/bin/env bash
# Build the macOS app (unsigned) and print instructions for internal deployment.
# Share the DMG with your team; after they install, they run fix-quarantine.sh.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "Building macOS app (unsigned)..."
npm run build:mac

# Find the DMG (arm64 or x64 depending on machine)
DMG_DIR="$PROJECT_DIR/dist"
DMG=$(find "$DMG_DIR" -maxdepth 2 -name "*.dmg" 2>/dev/null | head -1)

echo ""
echo "=============================================="
echo "Build complete. For internal company deployment:"
echo "=============================================="
echo ""
echo "1. Share the installer with your team:"
if [[ -n "$DMG" ]]; then
  echo "   $DMG"
else
  echo "   (DMG is in $DMG_DIR)"
fi
echo ""
echo "2. Put the DMG and scripts/install-from-dmg.sh in the same folder and share with users."
echo ""
echo "3. Users run once (no need to open the DMG manually):"
echo "   bash install-from-dmg.sh"
echo "   (or from this repo: npm run install:mac)"
echo "   This installs the app to Applications and removes the quarantine message."
echo ""
