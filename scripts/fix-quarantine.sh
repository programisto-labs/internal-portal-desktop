#!/usr/bin/env bash
# Remove macOS quarantine attribute from Internal Portal so it opens without
# the "damaged" / "unidentified developer" dialog. For internal company use.
# Run this once after installing the app (e.g. after dragging from the DMG to Applications).

set -e

APP_PATH="/Applications/Internal Portal.app"

if [[ ! -d "$APP_PATH" ]]; then
  echo "Internal Portal is not installed at: $APP_PATH"
  echo "Please install the app first (drag it from the DMG to Applications), then run this script again."
  exit 1
fi

echo "Removing quarantine attribute from Internal Portal..."
xattr -cr "$APP_PATH"
echo "Done. You can now open Internal Portal normally (no more quarantine message)."
