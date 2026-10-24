#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(bash scripts/check-release-version.sh)"
name="Scribeleaf-$version"
TYPORA_RENDERER_OUT_DIR=.cache/native-dist bash scripts/build-macos.sh
mkdir -p build dist
work="$(mktemp -d "$PWD/build/package.XXXXXX")"
mount=""
cleanup() {
  if [ -n "$mount" ]; then hdiutil detach "$mount" -quiet || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/root" "$work/zip"
ditto build/Scribeleaf.app "$work/root/Scribeleaf.app"
printf 'macOS 13+; Apple Silicon and Intel. Ad-hoc signed, not notarized.\nDrag Scribeleaf.app to Applications.\n' > "$work/root/INSTALL.txt"
ln -s /Applications "$work/root/Applications"
ditto -c -k --keepParent "$work/root/Scribeleaf.app" "dist/$name.zip"
hdiutil create -volname "$name" -srcfolder "$work/root" -format UDZO -ov "dist/$name.dmg"
ditto -x -k "dist/$name.zip" "$work/zip"
python3 scripts/verify-release-app.py "$work/zip/Scribeleaf.app"
mount="$work/mount"
mkdir -p "$mount"
hdiutil attach "dist/$name.dmg" -readonly -nobrowse -mountpoint "$mount" -quiet
[ "$(readlink "$mount/Applications")" = /Applications ]
[ -f "$mount/INSTALL.txt" ]
python3 scripts/verify-release-app.py "$mount/Scribeleaf.app"
hdiutil detach "$mount" -quiet
mount=""
(cd dist && shasum -a 256 "$name.zip" "$name.dmg" > SHA256SUMS)
