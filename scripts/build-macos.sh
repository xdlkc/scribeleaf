#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
renderer_dir="${TYPORA_RENDERER_OUT_DIR:-dist}"
npm run build -- --outDir "$renderer_dir"
node scripts/verify-bundle.mjs "$renderer_dir"
app_path="$PWD/build/Scribeleaf.app"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources/editor" .cache/swift
xcrun swiftc -swift-version 5 -parse-as-library -O -target "$(uname -m)-apple-macosx13.0" -module-name Scribeleaf -module-cache-path "$PWD/.cache/swift" native/*.swift -o "$app_path/Contents/MacOS/Scribeleaf" -framework AppKit -framework WebKit -framework UniformTypeIdentifiers
cp native/Info.plist "$app_path/Contents/Info.plist"
rsync -a --delete "$renderer_dir/" "$app_path/Contents/Resources/editor/"
pandoc_source="${TYPORA_PANDOC_PATH:-$PWD/.cache/pandoc/pandoc-3.12.1-$(uname -m)/bin/pandoc}"
if [[ -x "$pandoc_source" ]]; then
  mkdir -p "$app_path/Contents/Resources/Converters"
  cp "$pandoc_source" "$app_path/Contents/Resources/Converters/pandoc"
  cp public/licenses/pandoc/COPYING.md public/licenses/pandoc/SOURCE.md "$app_path/Contents/Resources/Converters/"
fi
codesign --force --sign - "$app_path"
printf '%s\n' "$app_path"
