#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(bash scripts/check-release-version.sh)"
SCRIBELEAF_EDITION=all TYPORA_RENDERER_OUT_DIR=.cache/native-dist bash scripts/build-macos.sh
python3 scripts/verify-edition-pair.py build/Lite/Scribeleaf.app build/Scribeleaf.app
# Keep release assets apart from renderer output and previous single-edition artifacts.
dist="$PWD/dist/packages"
mkdir -p "$dist" build
work="$(mktemp -d "$PWD/build/package.XXXXXX")"
mount=""
cleanup() {
  if [ -n "$mount" ]; then hdiutil detach "$mount" -quiet || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
assets=()
for edition in Lite Full; do
  name="Scribeleaf-$edition-$version-universal"
  app="build/Scribeleaf.app"
  if [ "$edition" = Lite ]; then app="build/Lite/Scribeleaf.app"; fi
  mkdir -p "$work/$edition/root" "$work/$edition/zip"
  root="$work/$edition/root"
  ditto "$app" "$root/Scribeleaf.app"
  cat > "$root/INSTALL.txt" <<GUIDE
Scribeleaf $edition $version — macOS 13+ Universal (arm64 + x86_64)
Drag Scribeleaf.app to Applications. Lite and Full use the same app name and bundle ID.
Choose one edition; replacing an existing app requires quitting it and protecting unsaved documents first.
Preferences and document associations are shared. This package does not change the default app automatically.
Lite has no bundled Pandoc. Word/EPUB and other conversion features require Full or a trusted existing Pandoc configured in Export Settings.
Basic Markdown editing and native HTML/PDF/PNG export are included in both editions.
No dependencies are downloaded automatically at runtime.
Ad-hoc signed; no Developer ID signature or Apple notarization. macOS security warnings may appear.
GUIDE
  ln -s /Applications "$root/Applications"
  ditto -c -k --keepParent "$root/Scribeleaf.app" "$dist/$name.zip"
  hdiutil create -volname "Scribeleaf-$edition-$version" -srcfolder "$root" -format UDZO -ov "$dist/$name.dmg"
  ditto -x -k "$dist/$name.zip" "$work/$edition/zip"
  python3 scripts/verify-release-app.py "$work/$edition/zip/Scribeleaf.app" "$edition"
  mount="$work/$edition/mount"
  mkdir -p "$mount"
  hdiutil attach "$dist/$name.dmg" -readonly -nobrowse -mountpoint "$mount" -quiet
  [ "$(readlink "$mount/Applications")" = /Applications ]
  [ -s "$mount/INSTALL.txt" ]
  python3 scripts/verify-release-app.py "$mount/Scribeleaf.app" "$edition"
  hdiutil detach "$mount" -quiet
  mount=""
  assets+=("$name.zip" "$name.dmg")
done
(cd "$dist" && shasum -a 256 "${assets[@]}" > SHA256SUMS)
python3 scripts/verify-package-set.py "$dist" "$version"
