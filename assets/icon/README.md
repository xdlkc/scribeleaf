# Scribeleaf icon

Original project artwork: a folded warm-white page and a teal leaf, on a deep green
rounded square. No lettering, external artwork or third-party logo assets are used.

Editable vector geometry: `draw-icon.swift` (AppKit/CoreGraphics paths and gradients).
Rebuild from repository root: `bash scripts/build-icon.sh`.

- `png/`: seven distinct transparent PNG sizes (16–1024 px).
- `Scribeleaf.icns`: standard ten-entry macOS icon, 16–1024 physical pixels.
- `preview.png`: real-size small icons on dark background and a large light-background view.
- `verification.json`: generated per-size transparent-corner / alpha-bound results.

The vector master is rendered at 1024 and downsampled with high-quality filtering to
keep shadow proportions and transparent padding consistent at small sizes. Only the
single ICNS is copied into application bundles. Source, PNGs and preview remain outside
the packaged app. Lite and Full use the same brand icon.
