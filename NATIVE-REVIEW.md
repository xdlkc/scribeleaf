# Native review (`native/App.swift` vs `SPEC.md` bridge)

UTF-8/UTF-16 save and close/cancel are treated as passing.

## 1. External reload uses the old BOM

`checkExternalChange` (213–227) drops `byteOrderMark.count` and decodes with the encoding from `read` (52–61). It does not detect the BOM again.

Trigger: a UTF-8 BOM file is rewritten outside the app without a BOM, or a UTF-16 file is replaced by UTF-8. If the document is clean, `replaceFromDisk` (230–232) applies that text and `updateChangeCount(.changeCleared)` marks it clean. The next save uses `data(ofType:)` (64–66), which still prepends the old BOM.

Impact: truncated text is written over the good file. A UTF-16→UTF-8 decode often returns nil, so the next save writes UTF-16 over the new bytes.

Fix: use the same BOM detection as `read(from:ofType:)` and set `textEncoding` and `byteOrderMark` before replacing.

## 2. Restore deletes the only recovery copy

`applicationDidFinishLaunching` (354–369) deletes every recovery file after the alert, including after Restore. The new document gets a new `recoveryID` (47), `lastSavedMarkdown = ""`, and default UTF-8. `Recovery.write` (23–27) does not store encoding or BOM. Nothing is rewritten until the next `change` (130–141). `makeWindowControllers` (104–105) then watches the file.

Trigger: Restore a recovery for a non-empty file, then crash before another edit, or choose Reload on the sheet shown because disk text is not `""`. Or Save a restored UTF-16 path. Opening that path at launch (350–352) and restoring (364) opens a second document on that `fileURL`.

Impact: Reload or a second crash loses the recovered buffer. Save rewrites UTF-16 as UTF-8. Either document can clobber the other.

Fix: keep the file until a successful save or Discard; store encoding and BOM; set `lastSavedMarkdown` from a real `read` of disk; if that path is already open, apply the text there.

## 3. Discarded edits remain in Recovery

`Recovery.remove` runs on save and `close` (69–73, 298–300), not when dirty text is dropped. Matching `lastSavedMarkdown` only clears the dirty flag (133). `replaceFromDisk` (230–232) does the same after Reload. Save does not cancel `recoveryTask` (166–174).

Trigger: recovery JSON exists, the user reloads disk or undoes to the saved text, then the process is killed. Or the 1.5s job still sees `isDocumentEdited` and rewrites JSON after a successful save.

Impact: the next Restore puts the discarded buffer back, marks it dirty (365), and Save overwrites the version the user kept.

Fix: `Recovery.remove(recoveryID)` in `replaceFromDisk` and when a `change` clears the dirty flag. Cancel the pending job inside `save`.

## 4. Menu commands miss the bridge names

Spec commands include `requestSave`, `toggleSidebar`, `find`, `replace`, and `format` (a format string only). `action` (407–428) does that only for its whitelist. Undo, Redo, Find Next/Previous, zoom, Outline, and Files fall through to `send("format", command)`. `chooseFolder` (191) sends the bare name `sidebarFiles`.

Trigger: Edit → Undo becomes `command("format", "undo")`. View → Files becomes `command("format", "sidebarFiles")`. Open Folder becomes `command("sidebarFiles")`.

Fix: `send` each as its own command. Keep `format` for paragraph and format items.

## 5. Load breaks on U+2028/U+2029; PDF export can vanish

`js` (7–9) embeds JSON in `evaluateJavaScript` (111). U+2028 and U+2029 stay raw and are illegal in JavaScript source, so `load` throws and is only logged (112). A later `change` can set `markdown` to the empty editor buffer. Trigger: open a file containing either character, then save.

PDF: `ExportJob` (318–336) never orders its window on screen, treats `printOperation.run()` as finished, and closes that window immediately. Only `didFail` is implemented (339), so a provisional load failure never completes the job or shows an error.

Fix: pass the payload via `callAsyncJavaScript` arguments, or escape those code points. Keep the web view until print completes, and fail the job if provisional navigation fails.
