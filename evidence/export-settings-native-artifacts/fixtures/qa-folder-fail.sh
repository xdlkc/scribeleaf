#!/bin/sh
echo QA_FOLDER_FAILED >> "$(dirname "$0")/qa-folder-fail.log"
mkdir -p "$TYPORA_OUTPUT_FOLDER"
echo NEW > "$TYPORA_OUTPUT_FOLDER/new-file"
echo CHANGED > "$TYPORA_OUTPUT_FOLDER/existing-target.txt"
exit 23
