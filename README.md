# Scribeleaf

English | [简体中文](./README.zh-CN.md)

**Scribeleaf** is a native macOS Markdown editor built with an **AppKit (`NSDocument` + `WKWebView`)** shell and an independent **TypeScript + CodeMirror 6** live-preview renderer, targeting compatibility with macOS Typora 1.14.10.

> **Development Status**: Scribeleaf is **under active development** and has not yet completed full 1:1 product parity or pixel-level verification against Typora 1.14.10. See [`STATUS.md`](./STATUS.md) for current implementation coverage, test evidence, and known gaps, and [`PARITY-MENUS.md`](./PARITY-MENUS.md) for menu inventory comparisons.

## Architecture & Compatibility

- **Hybrid Native + WebKit Architecture**: Native Swift/AppKit code ([`native/`](./native)) manages `NSDocument` lifecycle, menus, recursive folder monitoring, preferences windows, PDFKit rendering, and Pandoc subprocess execution. The frontend ([`src/`](./src)) bundles via Vite into classic IIFE assets for local `file://` execution inside `WKWebView`.
- **Standalone Reference Approach**: Typora 1.14.10 is used strictly as a read-only design reference; all editor and native code is independently implemented.
- **Coexistence & Identifiers**: Distributed as **Scribeleaf** (`build/Scribeleaf.app`, executable `Scribeleaf`, version `0.1.0`) so it runs alongside Typora without naming collisions. The internal bundle identifier (`local.typora-replica.editor`), WebKit bridge names, and storage keys retain compatibility identifiers so existing preferences and recovery records remain intact.
- **System Requirements**: macOS 13.0 or later (`LSMinimumSystemVersion = 13.0`), packaged as a Universal 2 (`arm64` + `x86_64`) binary.

## Key Capabilities

- **Native Window Controls**. Drag the document’s title bar to move the window.
- **Live-Preview Markdown & Source Modes**: Single editable CodeMirror 6 surface with headings, lists, task checkboxes, blockquotes, fenced code syntax highlighting, KaTeX math, Mermaid diagrams, YAML front matter, TOC, alerts, HTML comments, reference links, footnotes, and lossless source-mode toggling.
- **Direct Table Editing & Rich Paste**: Interactive table editing with position mapping, undo/redo history, row/column insertion, alignment, row/column drag reordering, and CJK IME composition; rich/plain paste and asynchronous multi-image saving isolated per document.
- **Workspace Navigation & Modes**: Sidebar with file tree and document list modes, recursive directory watching, and an outline. Both Files and Outline tabs stay visible whenever the sidebar is open. Also includes find & replace, focus mode, typewriter centering, and 6 themes (`GitHub`, `Gothic`, `Night`, `Newsprint`, `Pixyll`, `Whitey`) with bundled open-source fonts (`public/fonts/`, `public/licenses/`).
- **13 Built-in Export Formats & Repeat Export**:
  - **Built-in**: Styled HTML, unstyled HTML, PDF (configurable paper size, margins, headers/footers), and full-length PNG (multi-viewport stitch).
  - **Pandoc Conversions (9 formats)**: `docx`, `odt`, `rtf`, `epub`, `latex`, `mediawiki`, `rst`, `textile`, and `opml`.
  - **Repeat Last Export**: Native Export menu supports repeating the last export format/destination (`Ctrl+Cmd+E`) and overwriting the previous target with confirmation (switching documents preserves the format and requires confirming a new destination; history is kept per window in memory).
- **Preferences & Export Settings**: Independent Export Settings window (`File → Export → Export Settings…`) for default folders, Pandoc path, PDF/HTML/PNG options, custom formats/order/templates, custom post-export commands, and YAML front-matter overrides—synced across windows and restarts. Searchable Editor Preferences cover bracket/Markdown pairing, Emoji autocomplete, list/quote indentation, copy/cut behavior, current-block source reveal, and typewriter centering.

## Directory Layout

```text
scribeleaf/
├── native/                 # AppKit/NSDocument/WKWebView shell, PDF/PNG/Pandoc export & Preferences UI
├── src/                    # TypeScript + CodeMirror 6 editor, themes, export builders & bridge
├── public/
│   ├── fonts/              # Bundled UI fonts
│   ├── licenses/           # Third-party font & Pandoc licenses
│   └── samples/            # Sample Markdown documents
├── fixtures/               # Acceptance fixture documents (e.g., acceptance.md)
├── scripts/                # Build, Pandoc fetch, packaging & verification scripts
├── STATUS.md               # Detailed implementation status, verification results & open gaps
├── SPEC.md                 # Reconstruction architecture & WebKit bridge specification
└── PARITY-MENUS.md         # Menu inventory comparison against Typora 1.14.10
```

## Development & Building

### Browser Renderer Dev Server

Requires Node.js (CI uses Node 22):

```sh
npm install
npm run typecheck
npm run dev -- --host 127.0.0.1
```

Vite serves on port `5173` by default (see [`vite.config.ts`](./vite.config.ts)).

### Build the Native macOS App

Requires local **Node.js** and **Xcode Command Line Tools**:

```sh
bash scripts/build-macos.sh
open 'build/Scribeleaf.app'
```

During the build, [`scripts/fetch-pandoc.sh`](./scripts/fetch-pandoc.sh) downloads official **Pandoc 3.1.11.1** (`arm64` and `x86_64` ZIPs), verifies their SHA256 digests, combines them via `lipo` into `Contents/Resources/Converters/pandoc`, and bundles the GPL license notices (`public/licenses/pandoc/`). First build requires internet access; subsequent builds re-verify cached archives in `.cache/pandoc/`.

### Verification

After starting the dev server (`npm run dev -- --host 127.0.0.1`):

```sh
APP_URL=http://127.0.0.1:5173 node scripts/verify-browser.mjs
node scripts/verify-export.mjs
```

- `verify-browser.mjs` drives the live editor via `agent-browser` (override path with `AGENT_BROWSER`) against [`fixtures/acceptance.md`](./fixtures/acceptance.md).
- Native bundle check: `node scripts/verify-bundle.mjs dist`
- Local JSDOM regressions (do not replace real browser/WebKit verification): `node scripts/verify-export-formats.mjs` and `node scripts/verify-nested-editing.mjs`
- Standalone native test harnesses: `python3 scripts/verify-image-export.py` and `python3 scripts/verify-native-export-bridge.py` (see [`STATUS.md`](./STATUS.md) for real WebKit and save-panel evidence)

## Packaging & GitHub Releases

Build local Universal (`arm64` + `x86_64`) ZIP and DMG packages plus `SHA256SUMS`:

```sh
bash scripts/package-macos.sh
```

- [`.github/workflows/release.yml`](./.github/workflows/release.yml) runs on PRs, `main`, `release/**`, and manual triggers, validating the packaged ZIP launch on native `macos-15` (`arm64`) and `macos-15-intel` (`x86_64`) runners.
- Pushing a `v<major>.<minor>.<patch>` tag matching [`native/Info.plist`](./native/Info.plist) and [`package.json`](./package.json) creates a **draft Release** for manual review and publishing.
- Verify downloaded release artifacts with `shasum -a 256 -c SHA256SUMS`.
- Release packages are ad-hoc signed without Developer ID signing or Apple notarization, so macOS Gatekeeper warnings may appear on first launch. CI validates macOS 13 deployment targets across Mach-O slices and `Info.plist`, which does not replace physical macOS 13 hardware testing.
