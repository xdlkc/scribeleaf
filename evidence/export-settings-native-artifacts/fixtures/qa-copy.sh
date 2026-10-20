#!/bin/sh
LOG="$(dirname "$0")/qa-copy.log"
printf "NODATA\ninput=%s\noutput=%s\ncwd=%s\npwd=%s\n" "$1" "$2" "$3" "$(pwd)" >> "$LOG"
cp "$1" "$2"
