# Clipboard task result — 2026-10-19

Status: **module implemented** (review repair). Coordinator still owns setup/main/types/native-switch/menubar. UI paste was not run.

Types: `src/editor/clipboard-gfm.d.ts` (ambient `gfm`). No `@ts-expect-error`, no local `@types` package.

Dependencies: `turndown ^7.2.0`, `turndown-plugin-gfm ^1.0.2`;
dev `@types/turndown ^5.0.5`, `jsdom ^25.0.1`. Lockfile is updated.

## Public API

- `clipboardExtension`
- `handleClipboardResult(payload)`
- `pasteFromSystem(view, plain: boolean)` — browser/menu fallback
- `htmlToMarkdown`, `resetClipboardDocument`, `CLIPBOARD_ERROR_EVENT`

## Reset

`resetClipboardDocument(view)` for same-view replace without `setState`. `view.setState(createEditorState(...))` already allocates a new `docId`. ViewPlugin removes the view on destroy; native callbacks after destroy are no-ops.

## Coordinator integration

### `src/editor/setup.ts`

```ts
import { clipboardExtension } from './clipboard';
```

Add `clipboardExtension` to `createEditorState` extensions.

### `src/main.ts`

```ts
import { handleClipboardResult, pasteFromSystem } from './editor/clipboard';
```

```ts
case 'clipboardResult':
  handleClipboardResult((payload ?? {}) as { requestId: string; path?: string; paths?: string[]; error?: string });
  return;
```

Browser menu paste (not native NSResponder): `pasteFromSystem(view, false)` and `pasteFromSystem(view, true)`.

If `document.activeElement` is a nested contenteditable inside `view.contentDOM` (`.lp-cell`), `pasteFromSystem` inserts there with `insertText` / `input` and does not touch the CM caret.

Native ⇧⌘V: **root** `pastePlainText` + focused-element `document.execCommand("insertText",false,text)`. This module does **not** add a native plain-text bridge.

Cmd+V: let DOM paste reach the editor; nested cells are not stolen.

`loadDocument` `setState` is enough for identity. Optional: `resetClipboardDocument(view)` if state is reused.
Import `resetClipboardDocument` only when that optional path is needed.

Browser image / clipboard-read failure: `typora-clipboard-error` (`detail: { requestId?, error: 'unsupported' }`).

### `src/types.ts` NativeMessage

```ts
| {
    type: 'clipboardImage';
    requestId: string;
    data?: string;
    mime?: string;
    name?: string;
    path?: string;
    usePasteboard?: boolean;
    lookupFileURLs?: boolean;
    source?: 'paste' | 'drop'; // snapshot NSPasteboard.general vs .drag only
  }
```

Native → renderer: `send("clipboardResult", { requestId, path?, paths?, error? })`.

### `native/App.swift`

```swift
case "clipboardImage":
    handleClipboardImage(body)
```

### Build

`scripts/build-macos.sh` already compiles `native/*.swift`.

## Native

- Snapshot **one** pasteboard at request receipt: `source: 'paste'` → `NSPasteboard.general`, `source: 'drop'` → `.drag`.
- An explicit nonempty `path`, or explicit `data` with `lookupFileURLs` and
  `usePasteboard` both false/absent, bypasses pasteboard reads and PNG conversion.
  Explicit paths take priority over optional lookup flags.
- `lookupFileURLs`: use a snapshotted file URL only when `name` matches **exactly one** file. No match / ambiguous → raw `data` bytes or save panel, never every unmatched file.
- `usePasteboard`: all image files from that single board.
- Unresolved YAML + multiple files: `NSOpenPanel` directory, then copy. Absent config still references originals.
- YAML `typora-copy-images-to`: exact `---` delimiter lines; restricted scalar lines only. Invalid/unquoted comments, `|`/`>`, anchors, nested indent, duplicates, booleans/numbers → **unresolved** → NSSavePanel. **Absent** key → existing file keeps original path.
- Remaining gap: WebKit drop that provides a `File` with no `.path` **and** empty drag/general file URLs (e.g. in-page blob drag) still falls back to bytes + save panel.

## Verification actually run

| Check | Result |
| --- | --- |
| `node scripts/verify-clipboard.mjs` | **PASS** `ALL_CLIPBOARD_TESTS_PASSED` — FileReader global + posted `data=AQID` and `source=paste`; mapping offset 3; owning-view result routing; file+`file://` same-name ingest once; nested cell **text** after execCommand throw; destroyed-view error silent; image-only ClipboardItem → unsupported, no empty insert |
| YAML fixtures via temp `swiftc` + stub | **PASS** including `---nope` closer **unresolved**, quoted `\\` escape **unresolved** |
| `npx tsc --noEmit` | **PASS** |
| `swiftc -parse-as-library native/*.swift` | **PASS** `SWIFT_OK` (temp `/tmp` removed) |
| App / `npm run build` / `build-macos.sh` / UI paste | **not run** |

The worker independently reran `npm run typecheck`, `npm run verify:clipboard`,
and a full `native/*.swift` temporary executable compile after the final small
review fixes. All exited 0. The final regression run additionally covers paired
`[1]` alt text, two different file paths with the same basename, and remote
HTML-only images that keep their URL without a native request. jsdom's missing
Range geometry methods are shimmed only in the test harness; these tests assert
source/state and DOM text, not layout. Test bundles and temporary Swift folders
are removed after use.

## Known limits

- Real WKWebView paste/drop, save panels, and Finder interactions still need UI
  verification. Native pure parser fixtures and compilation do not prove UI.
- Browser image persistence is unsupported and emits the error event. There is
  no base64/blob Markdown fallback.
- If nested-cell `execCommand` is unavailable, the tested DOM fallback appends
  text to that cell and emits `input`; it does not preserve a DOM selection.
- Finder lookup is best effort when WebKit hides original file paths. An
  unmatched file uses its actual bytes and a save panel.
