#!/bin/sh
printf "QA_POST cwd=%s\n" "$(pwd)" >> "$(dirname "$0")/qa-post.log"
