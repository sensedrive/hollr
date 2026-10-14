#!/usr/bin/env bash
# Archive Hollr and upload it to TestFlight.
# Auth: App Store Connect API key – cloud signing, no Xcode login needed.
#   ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH from the environment or Config/asc.env (gitignored).
#   DEVELOPMENT_TEAM from Config/Local.xcconfig.
# Bump the build: CURRENT_PROJECT_VERSION in project.yml (or BUILD=<n> ./scripts/testflight.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/usr/bin:$PATH" # Homebrew rsync breaks -exportArchive

[ -f Config/asc.env ] && source Config/asc.env
: "${ASC_KEY_ID:?ASC_KEY_ID fehlt (Config/asc.env)}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID fehlt (Config/asc.env)}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

if [ -n "${BUILD:-}" ]; then
  sed -i '' -E "s/CURRENT_PROJECT_VERSION: \"[0-9]+\"/CURRENT_PROJECT_VERSION: \"$BUILD\"/" project.yml
fi
VERSION=$(grep -E 'MARKETING_VERSION' project.yml | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
BUILD_NO=$(grep -E 'CURRENT_PROJECT_VERSION' project.yml | grep -oE '[0-9]+')
echo "▶ Hollr $VERSION ($BUILD_NO)"

xcodegen generate --quiet
rm -rf build/Hollr.xcarchive build/export
xcodebuild -scheme Hollr -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath build/dd-release -archivePath build/Hollr.xcarchive "${AUTH[@]}" archive -quiet
xcodebuild -exportArchive -archivePath build/Hollr.xcarchive -exportOptionsPlist ExportOptions-TestFlight.plist \
  -exportPath build/export "${AUTH[@]}"
echo "✔ Hochgeladen. Verarbeitung in App Store Connect dauert ca. 5–15 Minuten."
