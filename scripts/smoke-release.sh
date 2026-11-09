#!/bin/bash
# Disposable CI only: does not touch an installed user app or grant privacy permissions.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${CI:-}" = true ] || { echo 'Use only on disposable CI runners' >&2; exit 2; }
[ "$(uname -m)" = "$EXPECTED_ARCH" ]
version="$(bash scripts/check-release-version.sh)"
python3 scripts/verify-package-set.py dist/packages "$version"
work="$(mktemp -d)"
pid=""
cleanup() { if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT
for edition in Lite Full; do
  ditto -x -k "dist/packages/Scribeleaf-$edition-$version-universal.zip" "$work/$edition"
  app="$work/$edition/Scribeleaf.app"
  python3 scripts/verify-release-app.py "$app" "$edition"
  if [ "$edition" = Full ]; then
    pandoc="$app/Contents/Resources/Converters/pandoc"
    "$pandoc" --version
    printf '# Universal conversion\n' | "$pandoc" -f markdown -t html | grep '<h1'
  fi
  "$app/Contents/MacOS/Scribeleaf" > "$work/$edition-launch.log" 2>&1 &
  pid=$!
  sleep 8
  kill -0 "$pid" || { cat "$work/$edition-launch.log"; exit 1; }
  echo "PASS: native $EXPECTED_ARCH $edition package process survived startup"
  kill "$pid"
  wait "$pid" 2>/dev/null || true
  pid=""
done
python3 scripts/verify-edition-pair.py "$work/Lite/Scribeleaf.app" "$work/Full/Scribeleaf.app"
