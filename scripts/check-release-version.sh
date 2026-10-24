#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' native/Info.plist)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[ "$(node -p "require('./package.json').version")" = "$version" ]
if [ -n "${RELEASE_TAG:-}" ]; then
  [ "$RELEASE_TAG" = "v$version" ] || { echo "Tag $RELEASE_TAG does not match v$version" >&2; exit 1; }
fi
printf '%s\n' "$version"
