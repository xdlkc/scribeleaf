#!/bin/bash
# Official immutable-version downloads; verify even cached archives before extraction.
set -euo pipefail
cd "$(dirname "$0")/.."
version=3.1.11.1
for arch in arm64 x86_64; do
  case "$arch" in
    arm64) sha=fa38ad91d8f1f09549ae16830ade3a26650b03cb9a29c68b41b55ea7fab0aa2d ;;
    x86_64) sha=0018eddd489389ac4e6cf6f4711c1ad49574361c04282e075400fad2c0050084 ;;
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
