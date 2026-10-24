#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build .cache/swift
xcrun swiftc -swift-version 5 -parse-as-library -module-cache-path "$PWD/.cache/swift" native/DocumentConversion.swift scripts/verify-pandoc-dependency.swift -o build/verify-pandoc-dependency
build/verify-pandoc-dependency
