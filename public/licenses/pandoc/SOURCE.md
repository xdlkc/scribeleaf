# Pandoc

The bundled executable combines the official Pandoc 3.1.11.1 macOS arm64 and
x86_64 executables with lipo, then applies an ad-hoc signature. No Pandoc
source is modified. Both official ZIP archives are pinned by SHA256 in
scripts/fetch-pandoc.sh (digests calculated from the official HTTPS release downloads).

- Upstream: https://github.com/jgm/pandoc
- Release and binary: https://github.com/jgm/pandoc/releases/tag/3.1.11.1
- Corresponding source: https://github.com/jgm/pandoc/archive/refs/tags/3.1.11.1.tar.gz
- License text: COPYING.md, fetched from that exact upstream tag.
- Archive verification: scripts/fetch-pandoc.sh pins both official ZIP SHA256 values.
- Historical conversion evidence (earlier Pandoc): evidence/document-conversion-verification.json.

This repository's editor is independently implemented. Pandoc remains a
separate command-line program invoked with an argument array.

Pandoc 3.1.11.1 is selected for macOS 13 compatibility: official arm64 minos=12.0,
x86_64 minos=11.0. Official 3.12.1 and 3.6.4 arm64 binaries require macOS 15.
