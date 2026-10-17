#!/bin/sh
# Builds archive/pult with SwiftPM and assembles build/Pult.app (menu bar app, no Dock icon).
# Usage: archive/pult/scripts/build-pult-app.sh [--run]
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/archive/pult"
swift build -c release --product Pult
APP="$ROOT/build/Pult.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Fonts"
cp .build/release/Pult "$APP/Contents/MacOS/Pult"
cp "$ROOT"/ios/CallAssistant/Resources/Fonts/*.ttf "$APP/Contents/Resources/Fonts/" 2>/dev/null || true
cp "$ROOT"/archive/pult/Resources/AppIcon.icns "$ROOT"/archive/pult/Resources/MenuBarIcon*.png "$ROOT"/archive/pult/Resources/*-logo*.png "$APP/Contents/Resources/"   # archive/pult/scripts/make-pult-icons.swift
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Волна: Пульт</string>
  <key>CFBundleDisplayName</key><string>Волна: Пульт</string>
  <key>CFBundleIdentifier</key><string>dev.prototype.volna.pult</string>
  <key>CFBundleExecutable</key><string>Pult</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Прототип</string>
</dict></plist>
PLIST
# A real identity keeps the Accessibility grant across rebuilds: macOS ties it to the signature's designated requirement,
# and an ad-hoc signature changes with every build. PULT_SIGN_IDENTITY overrides; without any identity, ad-hoc as before.
IDENTITY="${PULT_SIGN_IDENTITY:-$(security find-identity -p codesigning -v 2>/dev/null | awk '/Apple Development/ {print $2; exit}')}"
if [ -n "$IDENTITY" ] && codesign --force --sign "$IDENTITY" "$APP" >/dev/null 2>&1; then
  echo "signed with $(codesign -dvv "$APP" 2>&1 | awk -F= '/^TeamIdentifier/ {print "team " $2}')"
else
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
  echo "signed ad-hoc: Accessibility must be granted again after every rebuild"
fi
echo "built $APP"
if [ "$1" = "--run" ]; then
  pkill -x Pult >/dev/null 2>&1 || true
  open "$APP"
fi
