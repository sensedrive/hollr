#!/usr/bin/env bash
# Build Hollr for the Mac (Mac Catalyst), sign with Developer ID (cloud-managed via the
# App Store Connect API key), notarize, staple and pack a drag-to-Applications DMG.
#   ./scripts/mac-dmg.sh            → build/Hollr-<version>.dmg
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/usr/bin:$PATH"

[ -f Config/asc.env ] && source Config/asc.env
: "${ASC_KEY_ID:?ASC_KEY_ID fehlt (Config/asc.env)}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID fehlt (Config/asc.env)}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

VERSION=$(grep -E 'MARKETING_VERSION' project.yml | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
BUILD_NO=$(grep -E 'CURRENT_PROJECT_VERSION' project.yml | grep -oE '[0-9]+')
echo "▶ Hollr for Mac $VERSION ($BUILD_NO)"

xcodegen generate --quiet
rm -rf build/mac
mkdir -p build/mac
xcodebuild -scheme Hollr -configuration Release -destination 'generic/platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath build/dd-mac -archivePath build/mac/Hollr.xcarchive "${AUTH[@]}" archive -quiet
NOTARIZE=1
if ! xcodebuild -exportArchive -archivePath build/mac/Hollr.xcarchive -exportOptionsPlist ExportOptions-DeveloperID.plist \
  -exportPath build/mac/export "${AUTH[@]}" >build/mac/export.log 2>&1; then
  # no Developer ID certificate in the team yet (only the Account Holder can create one):
  # ship an ad-hoc signed app – runs on any Mac, first start via right-click → Open
  echo "⚠ Kein Developer-ID-Zertifikat – baue ad-hoc-signierte DMG (nicht notarisiert)"
  NOTARIZE=0
  mkdir -p build/mac/export
  cp -R build/mac/Hollr.xcarchive/Products/Applications/Hollr.app build/mac/export/
  codesign --force --deep --sign - --options runtime --entitlements Sources/Hollr/HollrMac.entitlements build/mac/export/Hollr.app
fi
APP="build/mac/export/Hollr.app"
codesign --verify --deep --strict "$APP"

if [ "$NOTARIZE" = 1 ]; then
  echo "▶ notarize app"
  ditto -c -k --keepParent "$APP" build/mac/Hollr.zip
  xcrun notarytool submit build/mac/Hollr.zip --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait
  xcrun stapler staple "$APP"
fi

echo "▶ dmg"
STAGE=build/mac/dmg
mkdir -p "$STAGE" && cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
SUFFIX=$([ "$NOTARIZE" = 1 ] && echo "" || echo "-adhoc")
DMG="build/Hollr-$VERSION-$BUILD_NO$SUFFIX.dmg"
rm -f "$DMG"
hdiutil create -volname "Hollr" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
if [ "$NOTARIZE" = 1 ]; then
  codesign --sign "Developer ID Application" --timestamp "$DMG"
  xcrun notarytool submit "$DMG" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait
  xcrun stapler staple "$DMG"
else
  echo "  Erster Start: Rechtsklick auf Hollr → Öffnen (oder: xattr -dr com.apple.quarantine /Applications/Hollr.app)"
fi
echo "✔ $DMG"
