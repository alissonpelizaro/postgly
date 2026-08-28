#!/usr/bin/env bash
#
# Build a Mac App Store submission package (.pkg) for Postgly.
#
# Tauri has no first-class MAS target, so this does the three things the
# tauri-action pipeline does not: embed the provisioning profile, re-sign
# the bundle with sandbox entitlements, and wrap it in an installer
# package signed with the Mac Installer Distribution certificate.
#
# Required environment:
#   TEAM_ID            Apple Developer Team ID (App Store Connect → Membership)
#   MAS_PROFILE        Path to the Mac App Store .provisionprofile
# Optional:
#   MAS_APP_CERT       Defaults to the first "Apple Distribution" identity
#   MAS_INSTALLER_CERT Defaults to the first "3rd Party Mac Developer Installer"
#
# Usage: TEAM_ID=ABCDE12345 MAS_PROFILE=~/Postgly_MAS.provisionprofile make mas

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUNDLE_ID="$(node -p "require('./src-tauri/tauri.conf.json').identifier")"
PRODUCT="$(node -p "require('./src-tauri/tauri.conf.json').productName")"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TARGET="universal-apple-darwin"
APP="src-tauri/target/$TARGET/release/bundle/macos/$PRODUCT.app"
OUT="src-tauri/target/mas"
PKG="$OUT/$PRODUCT-$VERSION.pkg"

die() { echo "error: $*" >&2; exit 1; }

[[ -n "${TEAM_ID:-}" ]] || die "TEAM_ID is not set (App Store Connect → Membership details)."
[[ -n "${MAS_PROFILE:-}" ]] || die "MAS_PROFILE is not set (path to the .provisionprofile)."
[[ -f "$MAS_PROFILE" ]] || die "provisioning profile not found: $MAS_PROFILE"

find_identity() {
  security find-identity -v | grep -m1 "$1" | sed -E 's/.*"(.*)"/\1/' || true
}
APP_CERT="${MAS_APP_CERT:-$(find_identity 'Apple Distribution')}"
INSTALLER_CERT="${MAS_INSTALLER_CERT:-$(find_identity '3rd Party Mac Developer Installer')}"

[[ -n "$APP_CERT" ]] || die "no 'Apple Distribution' certificate in the keychain."
[[ -n "$INSTALLER_CERT" ]] || die "no '3rd Party Mac Developer Installer' certificate in the keychain."

echo "==> bundle    $BUNDLE_ID ($VERSION)"
echo "==> app cert  $APP_CERT"
echo "==> pkg cert  $INSTALLER_CERT"

# --- build -------------------------------------------------------------------
# Universal binary: the App Store serves one bundle to both architectures.
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

# `--bundles app` skips the DMG; the App Store only ever wants the .app.
# Signing is deliberately left off here so the manual pass below is the
# only thing that touches the signature.
APPLE_SIGNING_IDENTITY="" npm run tauri build -- --bundles app --target "$TARGET"

[[ -d "$APP" ]] || die "expected bundle not found at $APP"

# --- embed the provisioning profile ------------------------------------------
cp "$MAS_PROFILE" "$APP/Contents/embedded.provisionprofile"

# --- entitlements ------------------------------------------------------------
mkdir -p "$OUT"
ENTITLEMENTS="$OUT/entitlements.plist"
sed "s/__TEAM_ID__/$TEAM_ID/g" src-tauri/entitlements.mas.plist > "$ENTITLEMENTS"

# Sanity check: the identifier in the entitlements has to match the bundle,
# otherwise the upload is rejected long after the slow build finished.
grep -q "$TEAM_ID\.$BUNDLE_ID" "$ENTITLEMENTS" \
  || die "entitlements application-identifier does not match $BUNDLE_ID"

# --- sign --------------------------------------------------------------------
# Nested code first, outermost bundle last, or the outer signature is
# invalidated by the inner ones.
while IFS= read -r nested; do
  echo "==> sign (nested) ${nested#"$APP/"}"
  codesign --force --timestamp --sign "$APP_CERT" "$nested"
done < <(find "$APP/Contents" \( -name '*.dylib' -o -name '*.framework' \) -print)

echo "==> sign $PRODUCT.app"
codesign --force --timestamp --sign "$APP_CERT" \
  --entitlements "$ENTITLEMENTS" "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"

# --- package -----------------------------------------------------------------
rm -f "$PKG"
productbuild --component "$APP" /Applications --sign "$INSTALLER_CERT" "$PKG"

echo
echo "Package ready: $PKG"
echo
echo "Validate, then upload:"
echo "  xcrun altool --validate-app -f \"$PKG\" -t macos -u <apple-id> -p <app-specific-password>"
echo "  xcrun altool --upload-app   -f \"$PKG\" -t macos -u <apple-id> -p <app-specific-password>"
echo "(or drag the .pkg into Transporter.app)"
