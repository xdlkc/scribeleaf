#!/bin/bash
# Official immutable-version downloads; verify even cached archives before extraction.
set -euo pipefail
cd "$(dirname "$0")/.."
version=3.12.1
for arch in arm64 x86_64; do
  case "$arch" in
    arm64) sha=c2146cf33a583f3ac93eccddf1bb662371d5cfcce1aad1c87ad860cca1435d46 ;;
    x86_64) sha=81ed3e2cfecf096df15d407152f89a684fd65221082b919963f738e977fad3bc ;;
  esac
  archive="$PWD/.cache/pandoc/pandoc-$version-$arch-macOS.zip"
  mkdir -p .cache/pandoc
  if [ ! -f "$archive" ]; then
    curl --fail --location --retry 3 "https://github.com/jgm/pandoc/releases/download/$version/pandoc-$version-$arch-macOS.zip" -o "$archive.tmp"
    mv "$archive.tmp" "$archive"
  fi
  echo "$sha  $archive" | shasum -a 256 -c -
  rm -rf ".cache/pandoc/$arch"
  mkdir -p ".cache/pandoc/$arch"
  ditto -x -k "$archive" ".cache/pandoc/$arch"
  lipo ".cache/pandoc/$arch/pandoc-$version-$arch/bin/pandoc" -verify_arch "$arch"
done
