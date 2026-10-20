# 表格编辑模块结果

状态：**模块已实现并已由 coordinator 接入。** 本轮只改 `table-editor.ts` / `.css`、`scripts/verify-table.mjs`、`TABLE-RESULT.md`。

## API

- `createTableEditor(source, from, ctx) → HTMLElement`
- `updateTableEditor(dom, source, from, ctx) → boolean`
- `destroyTableEditor(dom)`（TableWidget.destroy 应调用）
- `handleTableCommand(command, payload?) → boolean`

纯函数：`parseMarkdownTable`、`serializeMarkdownTable`、`splitTableRow`、`patchTableCell`、行列增删/对齐/重排、`findTableInDocument`。

## 本轮修复

1. 结构编辑后 `focusCell`/`enterCell` 真正 focus；末格 Tab 聚焦新行第 0 列。
2. 同形状 `refresh` 就地 reconcile，不把 contenteditable 挪到新行。结构 rebuild 时 `suppressBlur`，dispatch 返回后立即并 `queueMicrotask` 再聚焦。`applying` 期间不二次 dispatch。
3. composition 期间不处理 Tab / ⌘Enter / ⌘⇧Backspace。
4. `findTableInDocument` 在 `from` 失效且文档中有多份相同表文本时返回 null。
5. `destroyTableEditor` 移除 document mousedown、菜单和 active 引用。
6. 工具条绝对定位浮在表上；行列手柄零占位，仅 hover/focus 显示。

## 实际检查

- `node --experimental-strip-types scripts/verify-table.mjs`：**11/11 PASS**（含重复表文本拒绝、destroy 导出存在）。
- `npm run typecheck`：`src/editor/table-editor.ts` 无错误。整仓失败在 `src/editor/clipboard.ts` 的 `Unused '@ts-expect-error'`（非本模块、未改）。
- 未改 `scripts/verify-table-browser.mjs`；浏览器 Tab/⌘Enter 焦点由 root 重跑该脚本验证。

## 未验证 / 限制

- 中文 IME 与拖放仍无端到端证据。
- 剪贴板不在本模块。
- 浏览器 Tab 焦点与结构快捷键依赖 coordinator 接入后的 widget 生命周期；纯测试无法覆盖 DOM 焦点。
