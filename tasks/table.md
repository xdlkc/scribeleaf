Implement direct WYSIWYG table editing in /Users/lkc/Code/typora-replica.
This is ONE bounded feature, not a request to rebuild or research the whole app.
Use only your current Kimi K3 model; do not spawn agents or other harnesses.
Read AGENTS.md plus relevant sections of src/editor/widgets.ts,
src/editor/livepreview.ts, src/markdown-tables.ts, src/commands.ts.

You own ONLY src/editor/table-editor.ts, src/editor/table-editor.css,
scripts/verify-table.mjs, TABLE-RESULT.md. Do not change existing source,
package files, native code, or user configuration. Another worker owns clipboard.
Write files incrementally. Do not spend the run planning a whole application.

API to implement:
  createTableEditor(source: string, from: number, ctx: WidgetContext): HTMLElement
  updateTableEditor(dom: HTMLElement, source: string, from: number,
                    ctx: WidgetContext): boolean
  handleTableCommand(command: string, payload?: unknown): boolean
Import WidgetContext as type only from './widgets'. Import your own CSS.
Coordinator will replace TableWidget.toDOM/updateDOM with these calls and make
DeferredBlockWidget.updateDOM delegate to the new inner widget. Coordinator will
register handleTableCommand as a command interceptor before normal app commands.
Do not wait for those integration changes. State needed for a DOM table can be
owned by a controller held in a WeakMap, with source/from/context refreshed.

Authoritative installed Typora docs say:
- Table header plus >=1 row and >=1 column.
- Cmd/Ctrl+Enter inserts row below; Cmd/Ctrl+Shift+Backspace deletes row.
- Context menu adds/deletes columns; table tooltip resizes rows/columns.
- Toolbar changes left/center/right alignment per column.
- Rows and columns can be reordered by drag/drop.
Reference: /Applications/Typora.app/Contents/Resources/TypeMark/Docs/Table Editing.md
No further binary reverse engineering is needed for this task.

Requirements:
- Click a cell and edit it directly, retaining a rendered table. Never reveal
  the whole Markdown table as the normal editing interface.
- On input, write the changed cell to CodeMirror source and preserve DOM focus
  and selection across widget updates. updateDOM must update controller metadata
  and reconcile other cells without replacing the focused contenteditable.
- Preserve untouched raw cell Markdown and alignment. Correctly handle escaped
  pipes and pipes in matched code spans (reuse the shared rendering helper).
  A no-op focus/blur must not rewrite source. Structural edits may format only
  this table. Do not rewrite any surrounding document.
- Tab/Shift+Tab navigation, Tab at last cell adds row, documented row shortcuts,
  resize controls, context menu row/column add/delete and alignment. At least
  one data row and column remain. Reorder via handles with actual source edits.
- Chinese composition must not lose text/caret. Undo/redo must operate through
  CodeMirror history. A table edit must immediately reach the document source,
  not live only in contenteditable DOM until blur/save.
- Never use stale source positions after text is inserted before this table.
  Check the current source range before committing; refresh mapping on update.
- Inline raw Markdown within the focused cell is acceptable as an editing aid,
  but render it when inactive. Preserve existing emphasis/link/code syntax.
- handleTableCommand intercepts relevant formatting, undo/redo/select-all and
  table commands only when a table cell/toolbar owns focus. Unsupported block
  operations must not silently change text at the old CodeMirror caret.
- Use existing theme CSS variables. Show a compact table-only context toolbar;
  do not add an app-wide permanent formatting toolbar. Sanitize rendered HTML.

Use existing installed dependencies only. Export pure parsing/serialization
helpers if useful for meaningful tests. Write scripts/verify-table.mjs to cover
cell edits, row/column/alignment/reorder, escaped/code pipes, and source outside
the table. UI testing can follow integration; report any unverified focus/IME
behavior honestly. Run typecheck on your module and fix actual errors. Do not
modify others' files to fix unrelated compilation errors. End with concise
TABLE-RESULT.md listing APIs, actual checks and remaining limits. Finish the
implementation instead of stopping at a plan.
