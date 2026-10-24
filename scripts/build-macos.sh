#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
edition="${SCRIBELEAF_EDITION:-Full}"
case "$edition" in Lite|Full|all) ;; *) echo 'SCRIBELEAF_EDITION must be Lite, Full or all' >&2; exit 2 ;; esac
npm run typecheck
renderer_dir="${TYPORA_RENDERER_OUT_DIR:-.cache/native-dist}"
npm run build -- --outDir "$renderer_dir"
node scripts/verify-bundle.mjs "$renderer_dir"
mkdir -p build .cache/swift
for arch in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -parse-as-library -O -target "$arch-apple-macosx13.0" -module-name Scribeleaf -module-cache-path "$PWD/.cache/swift" native/*.swift -o "$PWD/build/Scribeleaf-$arch" -framework AppKit -framework WebKit -framework UniformTypeIdentifiers
done
editions=("$edition")
if [ "$edition" = all ]; then editions=(Lite Full); fi
for current in "${editions[@]}"; do
  app_path="$PWD/build/Scribeleaf.app"
  if [ "$current" = Lite ]; then app_path="$PWD/build/Lite/Scribeleaf.app"; fi
  rm -rf "$app_path"
  mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources/editor"
  lipo -create build/Scribeleaf-arm64 build/Scribeleaf-x86_64 -output "$app_path/Contents/MacOS/Scribeleaf"
  cp native/Info.plist "$app_path/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :ScribeleafEdition string $current" "$app_path/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Scribeleaf $current" "$app_path/Contents/Info.plist"
  rsync -a --delete "$renderer_dir/" "$app_path/Contents/Resources/editor/"
  if [ "$current" = Full ]; then
    bash scripts/fetch-pandoc.sh
    mkdir -p "$app_path/Contents/Resources/Converters"
    lipo -create .cache/pandoc/arm64/pandoc-3.1.11.1-arm64/bin/pandoc .cache/pandoc/x86_64/pandoc-3.1.11.1-x86_64/bin/pandoc -output "$app_path/Contents/Resources/Converters/pandoc"
    cp public/licenses/pandoc/{COPYING,SOURCE}.md "$app_path/Contents/Resources/Converters/"
    codesign --force --sign - --timestamp=none "$app_path/Contents/Resources/Converters/pandoc"
  fi
  codesign --force --sign - --timestamp=none "$app_path"
  python3 scripts/verify-release-app.py "$app_path" "$current"
  printf '%s\n' "$app_path"
done
