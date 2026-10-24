# Pandoc

The bundled executable combines the official Pandoc 3.12.1 macOS arm64 and
x86_64 executables with lipo, then applies an ad-hoc signature. No Pandoc
source is modified. Both official ZIP archives are pinned by SHA256 in
scripts/fetch-pandoc.sh (digests verified against the upstream release API).

- Upstream: https://github.com/jgm/pandoc
- Release and binary: https://github.com/jgm/pandoc/releases/tag/3.12.1
- Corresponding source: https://github.com/jgm/pandoc/archive/refs/tags/3.12.1.tar.gz
- License text: COPYING.md, fetched from that exact upstream tag.
- Download verification: evidence/document-conversion-verification.json.

This repository's editor is independently implemented. Pandoc remains a
separate command-line program invoked with an argument array.
