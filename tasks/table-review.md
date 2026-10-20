Continue the same table task. The module is now integrated by coordinator.
Fix the actual UI failures below. Write fixes incrementally; no broad research.
Own ONLY table-editor.ts/.css, verify-table.mjs, TABLE-RESULT.md.
Do not edit coordinator's scripts/verify-table-browser.mjs or existing app code.

Actual browser run: first edit, focus/blur no-op, immediate source write,
focused DOM identity, block-format interception and insertion above table PASS.
Last-cell Tab adds a row but drops focus to CodeMirror; subsequent CmdEnter and
CmdShiftBackspace then operate at the stale main caret, deleting # Tables.
This is a real data correctness bug, not a test expectation to weaken.

Required fixes:
1. writeStructured/rebuildGrid must retain/refocus the intended cell after row,
   column, alignment and resize changes. Current enterCell() does not focus.
   Last-cell Tab must focus column 0 of the new row, not the old last column.
2. refresh/rebuildGrid currently moves the active contenteditable into new rows
   before grid.replaceChildren(). That disconnects it and triggers blur/input.
   For unchanged grid shape reconcile cells IN PLACE. Keep the focused element
   connected. On external source changes such as undo/redo update its raw value
   and caret too; do not keep stale text. During structural rebuild suppress
   blur commits, then safely restore focus after EditorView.update has returned
   (queueMicrotask is suitable). Do not dispatch recursively inside a CM update.
3. Guard table keyboard structural commands during composition.
4. findTableInDocument fallback must reject ambiguous repeated identical table
   text when the supplied from is stale. Do not edit the first matching table.
5. document mousedown listener in buildShell retains every controller forever.
   Add explicit controller cleanup and export destroyTableEditor(dom). Root will
   call it from TableWidget.destroy. Cleanup listener, menu, active controller.
6. Inactive table must visually match an ordinary rendered table. Hide reorder
   chrome until hover/focus; avoid permanent top row/left column offsets and
   keep toolbar floating so focusing does not shift document layout.

Run pure test plus npm run typecheck. You may run coordinator's browser script
read-only; it will be rerun by root. Don't edit unrelated clipboard code.
Report actual checks and remaining limits honestly in TABLE-RESULT.md.
