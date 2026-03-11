#!/usr/bin/env bash
# Install Internal Portal from a .dmg: download from GitHub release, mount, copy to Applications, remove quarantine.
#
# Usage:
#   bash install-from-dmg.sh
#     Downloads the latest DMG from GitHub releases and installs.
#   bash install-from-dmg.sh /path/to/file.dmg
#     Uses the given local DMG file.
#   bash install-from-dmg.sh https://...
#     Downloads from the given URL, then installs.

set -e

# GitHub release DMG URL. Override with INTERNAL_PORTAL_DMG_URL env var if needed.
DEFAULT_DMG_URL="${INTERNAL_PORTAL_DMG_URL:-https://github.com/programisto-labs/internal-portal-desktop/releases/download/v1.0.0/Internal.Portal-1.0.0-arm64.dmg}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Internal Portal.app"
APPLICATIONS="/Applications"
TEMP_DMG=""
MOUNT_POINT=""

cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  fi
  if [[ -n "$TEMP_DMG" && -f "$TEMP_DMG" ]]; then
    rm -f "$TEMP_DMG"
  fi
}
trap cleanup EXIT

# Resolve DMG: explicit arg (URL or path), else find .dmg in script dir, then current dir, else default URL
DMG_PATH=""
if [[ -n "$1" ]]; then
  if [[ "$1" == http://* || "$1" == https://* ]]; then
    echo "Downloading from $1 ..."
    TEMP_DMG=$(mktemp -t InternalPortal.XXXXXX.dmg)
    if ! curl -sSLf -o "$TEMP_DMG" "$1"; then
      echo "Download failed."
      exit 1
    fi
    DMG_PATH="$TEMP_DMG"
  elif [[ -f "$1" ]]; then
    DMG_PATH="$1"
  else
    echo "Not found or invalid: $1"
    exit 1
  fi
else
  # No argument: download from default GitHub release URL
  echo "Downloading from $DEFAULT_DMG_URL ..."
  TEMP_DMG=$(mktemp -t InternalPortal.XXXXXX.dmg)
  if ! curl -sSLf -o "$TEMP_DMG" "$DEFAULT_DMG_URL"; then
    echo "Download failed. You can try: $0 <URL> or $0 /path/to/file.dmg"
    exit 1
  fi
  DMG_PATH="$TEMP_DMG"
fi

echo "Using DMG: $DMG_PATH"
echo "Mounting..."
MOUNT_OUTPUT=$(hdiutil attach "$DMG_PATH" -nobrowse -readonly 2>&1) || true

# Find the mount point: look for a /Volumes/... path in hdiutil output, or find app under /Volumes
MOUNT_POINT=""
if echo "$MOUNT_OUTPUT" | grep -q "/Volumes/"; then
  MOUNT_POINT=$(echo "$MOUNT_OUTPUT" | grep -o "/Volumes/[^[:space:]]*" | head -1)
fi
if [[ -z "$MOUNT_POINT" || ! -d "$MOUNT_POINT" ]]; then
  for vol in /Volumes/*/; do
    if [[ -d "$vol$APP_NAME" ]]; then
      MOUNT_POINT="${vol%/}"
      break
    fi
  done
fi
if [[ -z "$MOUNT_POINT" || ! -d "$MOUNT_POINT" ]]; then
  echo "Failed to mount the DMG."
  echo "$MOUNT_OUTPUT"
  exit 1
fi

# Find the app on the volume (root or one level)
SOURCE_APP=""
if [[ -d "$MOUNT_POINT/$APP_NAME" ]]; then
  SOURCE_APP="$MOUNT_POINT/$APP_NAME"
else
  SOURCE_APP=$(find "$MOUNT_POINT" -maxdepth 2 -name "$APP_NAME" -type d 2>/dev/null | head -1)
fi

if [[ -z "$SOURCE_APP" || ! -d "$SOURCE_APP" ]]; then
  echo "Could not find '$APP_NAME' inside the DMG."
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  exit 1
fi

echo "Installing to $APPLICATIONS..."
rm -rf "$APPLICATIONS/$APP_NAME"
cp -R "$SOURCE_APP" "$APPLICATIONS/"

echo "Unmounting DMG..."
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
MOUNT_POINT=""

echo "Removing quarantine attribute..."
xattr -cr "$APPLICATIONS/$APP_NAME"

echo "Done. Internal Portal is installed and ready to open (no quarantine message)."
