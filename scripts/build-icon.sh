#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/icon .cache/swift
xcrun swiftc -O -module-cache-path "$PWD/.cache/swift" assets/icon/draw-icon.swift -o build/icon/draw-icon -framework AppKit -framework ImageIO
build/icon/draw-icon "$PWD/build/icon/png"
iconset="$PWD/build/icon/Scribeleaf.iconset"
mkdir -p "$iconset"
for points in 16 32 128 256 512; do
  cp "build/icon/png/icon-$points.png" "$iconset/icon_${points}x${points}.png"
  cp "build/icon/png/icon-$((points * 2)).png" "$iconset/icon_${points}x${points}@2x.png"
done
iconutil -c icns "$iconset" -o build/icon/Scribeleaf.icns
python3 scripts/verify-icon.py build/icon/Scribeleaf.icns
