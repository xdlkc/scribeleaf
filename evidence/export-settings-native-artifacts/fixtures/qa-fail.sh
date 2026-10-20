#!/bin/sh
echo QA_FILE_FAILED >> "$(dirname "$0")/qa-fail.log"
if [ -n "$2" ]; then printf STAGING > "$2"; fi
exit 23
