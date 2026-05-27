#!/usr/bin/env bash
#
# Postgly installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://postgly.app/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/alissonpelizaro/postgly/main/scripts/install.sh | bash
#
# Optional:
#   POSTGLY_VERSION=v0.1.0  # pin a specific release (default: latest)
#
set -euo pipefail

REPO="alissonpelizaro/postgly"
VERSION="${POSTGLY_VERSION:-latest}"

# --- helpers ---------------------------------------------------------------

c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

die() { c_red "error: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

# --- detect platform -------------------------------------------------------

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *) die "unsupported OS: $OS (use install.ps1 on Windows)" ;;
esac

case "$PLATFORM:$ARCH" in
  macos:arm64)        ASSET="Postgly-macos-arm64.dmg" ;;
  macos:x86_64)       ASSET="Postgly-macos-x64.dmg" ;;
  linux:x86_64)       ASSET="Postgly-linux-x86_64.AppImage" ;;
  linux:aarch64)      die "linux arm64 not yet published — open an issue if you need it" ;;
  *) die "unsupported arch: $ARCH on $PLATFORM" ;;
esac

need curl

# --- resolve version -------------------------------------------------------

if [ "$VERSION" = "latest" ]; then
  c_dim "Resolving latest release..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -n1 | cut -d'"' -f4)"
  [ -n "$VERSION" ] || die "could not resolve latest release"
fi

URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
TMP="$(mktemp -d)"
cleanup() {
  if [ -d "${TMP:-}" ]; then
    c_dim "Cleaning up downloaded files..."
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

c_blue "Postgly installer"
echo "  Platform : $PLATFORM ($ARCH)"
echo "  Version  : $VERSION"
echo "  Asset    : $ASSET"
echo

# --- download --------------------------------------------------------------

c_dim "Downloading..."
curl -fL --progress-bar "$URL" -o "$TMP/$ASSET" \
  || die "download failed — check release exists at $URL"

# --- install ---------------------------------------------------------------

if [ "$PLATFORM" = "macos" ]; then
  need hdiutil

  c_dim "Mounting DMG..."
  MOUNT_OUT="$(hdiutil attach "$TMP/$ASSET" -nobrowse -readonly)"
  MOUNT_POINT="$(echo "$MOUNT_OUT" | tail -n1 | awk -F'\t' '{print $NF}' | sed 's/^ *//')"
  [ -d "$MOUNT_POINT" ] || die "could not locate mount point"

  APP_SRC="$(find "$MOUNT_POINT" -maxdepth 2 -name 'Postgly.app' -print -quit)"
  [ -n "$APP_SRC" ] || { hdiutil detach "$MOUNT_POINT" -quiet || true; die "Postgly.app not found in DMG"; }

  APP_DEST="/Applications/Postgly.app"
  if [ -d "$APP_DEST" ]; then
    c_dim "Removing previous install at $APP_DEST..."
    rm -rf "$APP_DEST"
  fi

  c_dim "Copying to /Applications..."
  cp -R "$APP_SRC" "$APP_DEST"

  hdiutil detach "$MOUNT_POINT" -quiet || true

  c_dim "Clearing quarantine attribute..."
  xattr -cr "$APP_DEST" 2>/dev/null || true

  c_green "✓ Postgly installed at $APP_DEST"
  echo
  echo "Launch with:"
  echo "  open -a Postgly"

elif [ "$PLATFORM" = "linux" ]; then
  BIN_DIR="${POSTGLY_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$BIN_DIR"
  DEST="$BIN_DIR/postgly"

  c_dim "Installing AppImage to $DEST..."
  mv "$TMP/$ASSET" "$DEST"
  chmod +x "$DEST"

  # Desktop integration: extract icon + create .desktop so Postgly
  # shows up in Ubuntu/GNOME launcher, KDE menu, etc.
  ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
  APPS_DIR="$HOME/.local/share/applications"
  DESKTOP_FILE="$APPS_DIR/postgly.desktop"
  ICON_DEST="$ICON_DIR/postgly.png"

  mkdir -p "$ICON_DIR" "$APPS_DIR"

  c_dim "Extracting icon from AppImage..."
  EXTRACT_DIR="$TMP/extract"
  mkdir -p "$EXTRACT_DIR"
  (cd "$EXTRACT_DIR" && "$DEST" --appimage-extract '*.png' >/dev/null 2>&1) || true

  ICON_SRC="$(find "$EXTRACT_DIR/squashfs-root" -maxdepth 3 -type f -name '*.png' \
    2>/dev/null | head -n1)"

  if [ -n "$ICON_SRC" ] && [ -f "$ICON_SRC" ]; then
    cp "$ICON_SRC" "$ICON_DEST"
  else
    c_dim "Icon not found in AppImage — launcher entry will use generic icon."
    ICON_DEST="postgly"
  fi

  c_dim "Creating desktop entry at $DESKTOP_FILE..."
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Postgly
Comment=Postgly
Exec=$DEST %U
Icon=$ICON_DEST
Terminal=false
Categories=Development;Utility;
StartupWMClass=postgly
EOF
  chmod +x "$DESKTOP_FILE"

  command -v update-desktop-database >/dev/null 2>&1 \
    && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 \
    && gtk-update-icon-cache "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

  c_green "✓ Postgly installed at $DEST"
  c_green "✓ Launcher entry created — search 'Postgly' in your app menu"
  echo
  case ":$PATH:" in
    *":$BIN_DIR:"*) echo "Launch from terminal: postgly" ;;
    *) echo "Add $BIN_DIR to your PATH, then launch with: postgly"
       echo "  e.g. echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc" ;;
  esac
fi
