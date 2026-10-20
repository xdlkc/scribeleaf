#!/bin/sh
LOG="$(dirname "$0")/qa-nodialog.log"
printf "NODIALOG in=%s out=%s\n" "$1" "$2" >> "$LOG"
cp "$1" "$(dirname "$0")/nodialog-fixed.txt"
