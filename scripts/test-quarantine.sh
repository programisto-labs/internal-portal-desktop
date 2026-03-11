#!/usr/bin/env bash
# Simulate "downloaded from internet" so you can test Gatekeeper locally.
# Copies the built app, adds the quarantine attribute, then opens it.
# If notarization is correct, it will open. If not, you'll see the "damaged" dialog.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_APP="$PROJECT_DIR/dist/mac-arm64/Internal Portal.app"
TEST_APP="/tmp/Internal-Portal-Quarantine-Test.app"

if [[ ! -d "$DIST_APP" ]]; then
  echo "Built app not found at: $DIST_APP"
  echo "Run 'npm run build:mac:signed' first."
  exit 1
fi

echo "Copying app to $TEST_APP and adding quarantine attribute..."
rm -rf "$TEST_APP"
cp -R "$DIST_APP" "$TEST_APP"

# Same attribute macOS adds when you download from Safari
xattr -w com.apple.quarantine "0001;$(date +%s);Safari;" "$TEST_APP"

echo "Opening app. If you see 'damaged' dialog, notarization/stapling may be missing or failed."
open "$TEST_APP"
