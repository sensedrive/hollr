#!/usr/bin/env bash
# CI build of the Mac app (Mac Catalyst) for one architecture, ad-hoc signed, as DMG.
#   ARCH=arm64|x86_64 ios/scripts/mac-dmg-ci.sh   → ios/build/Hollr-<version>-mac-<arch>.dmg
# No Apple credentials needed. First start on a Mac: right-click → Open.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${ARCH:?ARCH=arm64 oder x86_64}"
VERSION="${VERSION:-$(grep -E 'MARKETING_VERSION' project.yml | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')}"
LABEL=$([ "$ARCH" = arm64 ] && echo "apple-silicon" || echo "intel")

xcodegen generate --quiet
xcodebuild -project Hollr.xcodeproj -scheme Hollr -configuration Release \
  -destination 'generic/platform=macOS,variant=Mac Catalyst' \
  ARCHS="$ARCH" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath "build/dd-$ARCH" build -quiet

APP=$(find "build/dd-$ARCH/Build/Products" -maxdepth 2 -name Hollr.app -path "*maccatalyst*" | head -1)
[ -d "$APP" ] || { echo "Hollr.app nicht gefunden"; exit 1; }
lipo -info "$APP/Contents/MacOS/Hollr"
codesign --force --deep --sign - --options runtime --entitlements Sources/Hollr/HollrMac.entitlements "$APP"
codesign --verify --deep --strict "$APP"

STAGE="build/dmg-$ARCH"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
DMG="build/Hollr-$VERSION-mac-$LABEL.dmg"
rm -f "$DMG"
hdiutil create -volname "Hollr" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
echo "✔ $DMG"
