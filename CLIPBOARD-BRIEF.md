# Clipboard implementation task

Implement the following bounded task completely. Use Grok 4.6 in this
session only. Do not spawn agents, invoke other model harnesses, or change auth.
Do not write credentials or sensitive data to logs. Other workers are active.

## Ownership

You may write ONLY:
- `src/editor/clipboard.ts`
- `src/editor/clipboard-gfm.d.ts` (coordinator-authorized ambient declaration)
- `native/Clipboard.swift`
- `package.json` and `package-lock.json` (clipboard dependencies/scripts only)
- `scripts/verify-clipboard.mjs`
- `CLIPBOARD-RESULT.md`

Do not edit `AGENTS.md`, `SPEC.md`, existing main/editor/native source, build
scripts, or unrelated files. Read those source files as necessary. This brief
must remain unchanged. The coordinator integrates your module into existing
sources after review.

Read `AGENTS.md`, `SPEC.md`, `src/types.ts`, `src/bridge.ts`,
`src/editor/setup.ts`, the document lifecycle sections in `src/main.ts`, and
necessary parts of `native/App.swift`. Read the installed Typora image behavior
document at `/Applications/Typora.app/Contents/Resources/TypeMark/Docs/Use Images in Typora.md`
read-only. Do not embed Typora code.

## Deliverable

1. `src/editor/clipboard.ts` exports `clipboardExtension` (CM6 Extension),
   `handleClipboardResult(payload)`, and preferably pure `htmlToMarkdown(html)`
   for actual conversion tests. Design a small explicit document reset API if
   needed; document its exact integration point.
2. Rich HTML paste converts headings, strong/emphasis, links, lists, quotes,
   inline/fenced code, and GFM tables to Markdown. Use Turndown with GFM (add
   dependencies and type packages as needed). Preserve plain text Markdown
   exactly; Shift+Cmd+V forces plain text even when HTML exists. Normal paste
   handles HTML when HTML is provided and images before text as appropriate.
3. Multiple pasted/dropped images supported. No base64 Markdown. Image bytes
   go to native, get saved to disk, and become file references only after native
   success. Native failures/cancellation must not insert broken references.
4. Async insertion positions must map across intervening editor transactions.
   Keep paste order if image results arrive out of order. A new document must
   invalidate pending callbacks, including when its text happens to be equal to
   the old document. A StateField can carry unique document identity, positions,
   and requests. Expose an explicit reset for same-view document replacement;
   new EditorState should receive fresh identity. No view-retention leaks.
5. Renderer native message proposal: `{type:'clipboardImage',requestId,data,
   mime,name}`. Extend it minimally for existing file path references or native
   NSPasteboard fallback as needed. Exact required NativeMessage additions must
   be in result notes, but do not edit `src/types.ts` yourself. The module should
   still typecheck before coordinator adds that union if feasible, without
   broad `any` or suppressing real typing errors.
6. Native `extension MarkdownDocument` in `native/Clipboard.swift` exports
   `handleClipboardImage(_ body:[String:Any])` and any necessary named fallback
   method. Native sends `send("clipboardResult", ["requestId":...,"path":...])`
   or error payload. Reuse existing `fileURL`, `markdown`, `windowControllers`,
   and `send`. Do not reimplement NSDocument or App.
7. Existing image files dragged from Finder default to references to original
   paths, relative to saved Markdown when possible. WebKit may not expose File
   paths. Support file:// URI data and native NSPasteboard fileURL fallback to
   the extent feasible; make limitations explicit. Native NSImage fallback must
   handle Finder clipboard or raw clipboard image where browser items fail.
8. Raw image data without config uses NSSavePanel to pick the saving path.
   Saved Markdown's parent is the preferred panel directory. Honor simple
   YAML front matter `typora-copy-images-to` when reliably parsed, including
   relative folder config for saved documents. If config cannot be resolved
   safely/reliably, use save panel; never guess. Existing image with config can
   copy into the configured target directory. Use collision-safe names. No
   global config change, original Typora write, or cloud upload.
9. Avoid introducing browser-only base64/blob Markdown as fallback. In browser
   mode, image persistence may report unsupported via a visible or custom error
   event (document it). Plain/rich paste should work in browser mode.

## Verification

Create and run `scripts/verify-clipboard.mjs` with real htmlToMarkdown tests and
plain Markdown byte/character preservation tests. Bundle/import TypeScript
through existing esbuild if convenient. Include async mapping, out-of-order
batch results, and document-reset tests if possible with CM6 EditorState or a
minimal fake view; keep module test hooks minimal and justified. A DOM test
dependency is allowed only if needed for real tests. Do not write superficial
source-pattern assertions. Typecheck renderer and build if the current tree
allows it; report other workers' failures accurately. Compile Swift using
native/*.swift with `-parse-as-library`, or at least typecheck the extension
alongside App.swift; do not edit build scripts. `native/App.swift` contains the
app entry point. Use a temp output or module cache inside the project or /tmp
and remove unused temp files.

Do not launch the app, run `scripts/build-macos.sh`, run `npm run build`, or
rebuild the complete project. Another coordinator is fixing and verifying the
real app. Use only module tests, renderer typecheck, and temporary Swift
typecheck/compile outputs. Tell the coordinator when dependencies are installed.

You cannot verify app paste interactions with UI from this harness. Do not claim
UI passed. Complete implementation, run actual available checks, and write a
concise CLIPBOARD-RESULT.md including exact coordinator integration edits:
- setup import and extension array addition;
- main native command dispatch and document load/new/reset hook;
- NativeMessage union payloads;
- native switch cases;
- build script native/*.swift compilation requirement;
- actual verification and known limits.

Do not stop after planning. Implement the owned files and validate. Ask no
questions for routine choices within this scope. Do not run git commit or push.
