#!/bin/sh
# Растеризует helm.svg: AppIcon-1024.png (полный квадрат, для iOS и исходник) и AppIcon.icns (macOS: поля и скругление 824/1024).
# Запуск: sh docs/design/icons/helm/make-icons.sh (нужен Google Chrome).
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d)
SVG="file://$PWD/helm.svg"
shot() { "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 \
  --window-size=1024,1024 --virtual-time-budget=1000 --screenshot="$2" "file://$1" 2>/dev/null; }
printf '<html><body style="margin:0"><img src="%s" width="1024" height="1024" style="display:block"></body></html>' "$SVG" > "$TMP/ios.html"
printf '<html><body style="margin:0;background:transparent"><div style="position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:184px;overflow:hidden"><img src="%s" width="824" height="824" style="display:block"></div></body></html>' "$SVG" > "$TMP/mac.html"
shot "$TMP/ios.html" AppIcon-1024.png
shot "$TMP/mac.html" "$TMP/mac-1024.png"
mkdir "$TMP/AppIcon.iconset"
for pair in 16x16:16 16x16@2x:32 32x32:32 32x32@2x:64 128x128:128 128x128@2x:256 256x256:256 256x256@2x:512 512x512:512 512x512@2x:1024; do
  sips -z "${pair#*:}" "${pair#*:}" "$TMP/mac-1024.png" --out "$TMP/AppIcon.iconset/icon_${pair%%:*}.png" >/dev/null
done
iconutil -c icns "$TMP/AppIcon.iconset" -o AppIcon.icns
rm -rf "$TMP"
echo "icons written to $PWD"
