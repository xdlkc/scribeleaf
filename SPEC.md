# Typora 1.14.10 reconstruction contract

本文件记录当前实现基线，不穷尽原产品。完成标准仍是用户要求的完整 1:1，不能用已列子集替代全量实机对照。

## Target

Installed macOS Typora is the source of visual and behavior observations.
Deliver source plus a runnable macOS `.app`. Also support browser development
for renderer validation. The default theme is GitHub. The app name is
`Scribeleaf`, so it can coexist with Typora.

## Architecture and bridge

Use a native Swift/AppKit WKWebView shell with an independent TypeScript web
editor. Vite bundles renderer into `dist/` using relative asset paths. A build
script compiles native code with `swiftc` and copies dist into `.app` Resources.
Renderer uses CodeMirror 6 (preferred for lossless Markdown source) or a robust
ProseMirror implementation. It must have one editable writing surface with live
rendering, not a split preview. Full source mode is a separate toggle.

All renderer-to-native calls:
`window.webkit?.messageHandlers.native.postMessage({type, ...payload})`.
Types: `ready`, `new`, `open`, `openFolder`, `save` with `markdown` string,
`saveAs` with `markdown`, `change` with `markdown`, `export` with `format`
(`html`, `html-plain`, `pdf`, `png`, `docx`, `odt`, `rtf`, `epub`, `latex`,
`mediawiki`, `rst`, `textile`, or `opml`), `print` with standalone `html`,
`openExternal` with `url`, `title` with `title`.
Repeated export starts with `{type:'repeatExport',overwrite:boolean}`. Native
chooses its window-local format and asks the renderer for a snapshot through
`exportLast` payload `{format,overwrite,requestId}`. The export reply echoes
`requestId` and `overwrite`; native validates both against the source identity.

Native-to-renderer function:
`window.typora.command(name, payload?)`.
Names: `load` payload `{markdown, path, name, base?}` (optional resource URL for an unsaved duplicate), `files` payload
`{root, files:[{name,path,relativePath}], directories?:[{name,path,relativePath}]}`, `saved` payload `{path,name,markdown}` (the saved snapshot),
`requestSave`, `requestSaveAs`, `new`, `toggleSource`, `toggleSidebar`,
`toggleFocus`, `toggleTypewriter`, `find`, `replace`, `quickOpen`, `preferences`,
`theme` payload theme name, `format` payload format command string,
`export` payload format name, `exportFinished` payload `{name,warnings?}`.
`lastExportState` payload `{previous:boolean,overwrite:boolean}` drives menu
availability. It is transient window state, not an editor preference.

For native open-file actions renderer sends `{type:'open',path}`. For export
renderer sends `{type:'export',format,html,markdown}`; HTML includes document
content and standalone CSS for HTML/PDF/PNG. Conversion formats use the current
Markdown snapshot. Plain HTML omits theme styles. Native exports preserve source
identity and edits made after the export snapshot. Browser fallback supports local file input,
Markdown/HTML download, localStorage recovery and browser print.

## Must work

- Comfortable live Markdown writing: headings 1–6, bold, italic, strike,
  inline code, links, images, blockquotes, ordered/bullet/task lists, rules,
  fenced code with syntax highlighting, GFM tables, math, diagrams, footnotes.
- Keep source content, whitespace, unknown syntax and Unicode safe through
  source/live mode switches, save and reopen. Do not normalize documents just
  because the user switches view.
- Undo/redo, selection, keyboard shortcuts, paste, Chinese IME compatibility.
- Native new/open/open folder/save/save as/close with unsaved protection,
  recent files, file list, external updates, recovery and autosave settings.
- Sidebar tabs for Files and Outline, file tree/document list modes, nested headings, click to scroll, sidebar
  width drag, folder document search and quick open.
- Find/replace with result navigation, case toggle, replace current/all.
- Source mode, focus mode, typewriter mode, fullscreen, zoom.
- Theme selection (GitHub, Gothic, Night, Newsprint, Pixyll, Whitey), preferences.
- Tables insertion/editing, image and link insertion, code/math blocks.
- YAML front matter, TOC, alerts, HTML comments, reference links, task states,
  recursive folder changes and recovery of unsaved duplicate resource paths.
- Word/character/paragraph count and selected text count.
- Export styled/plain HTML, PDF, full-document PNG, Word, OpenOffice, RTF, EPUB,
  LaTeX, Media Wiki, reStructuredText, Textile and OPML; print and local images.
  Pandoc conversions use a verified bundled or discovered executable. Failures
  preserve existing output. Text formats can reference source image paths.
- Repeat the last export with a save panel, or overwrite the previous target
  after confirmation. Cancellation retains history. Confirming a destination
  records it even if output later fails. Switching source disables direct
  overwrite until another destination is confirmed. History is window-local
  memory; original relaunch persistence is not yet established.
- Native menu: app/File/Edit/Paragraph/Format/View/Theme/Window/Help. Match the
  installed Typora menu names and shortcuts where observed.

## Export preferences contract

The installed Preferences source and read-only UI captures are recorded in
`evidence/export-settings-reference.json` and
`evidence/export-settings-ui-reference.json`. Captured control values are the
current installation's values, not proof of factory defaults.

- Use an independent 720 × 480 logical-point Preferences window. Keep document
  editing commands bound to the key window. Text shortcuts in Preferences must
  edit its active field without changing the background document.
- Support export folder and Pandoc executable selection; format-specific
  settings; custom format add, rename, delete and order; output templates and
  custom commands; and configured actions after successful export. Controls
  must affect real output, rather than only persist values.
- PDF paper and margins affect actual page geometry. Headers and footers use
  current document variables, page number and page count. HTML append content,
  outline sidebar and theme affect the standalone document. Image width is CSS
  width; quality controls physical sampling; custom font size affects text
  across supported themes without enlarging fixed-size images.
- Apply supported YAML keys with the observed precedence and truthy fallback.
  Parse YAML as data. A per-file-setting toggle controls the extended keys;
  base metadata remains active. PDF/EPUB discard only their disallowed YAML
  append overlays, while retaining applicable global append settings.
- Repeated export freezes its base format and global settings. Each new
  invocation reads current document YAML. An empty export theme resolves the
  current editor theme for that invocation. Keep its resulting snapshot stable
  while asynchronous export runs.
- Run custom commands from the source document directory, as the reference
  documents. App-managed staged output must preserve an existing destination
  on failure or cancellation. Arbitrary user-command side effects are outside
  that output transaction. Release processes, pipes and temporary resources.
- Validate converter options against real Pandoc output. Raw Type must affect
  supported raw syntax, including the documented TOC cases; a stored dropdown
  value alone is insufficient evidence.

## Visual observations already measured

GitHub body: Open Sans, Clear Sans, Helvetica Neue, Helvetica, Arial; 16px;
line height 1.6; text #333; white paper; sidebar #fafafa; control text #777.
Writing region max width 860px including 30px padding, bottom padding 100px.
At viewport >=1400 width max 1024px; >=1800 max 1200px.
H1 2.25em/1.2, H2 1.75em/1.225 with bottom border #eee. H3 1.5em/1.43.
Heading margins 1rem, bold. Link #4183c4. Quiet native titlebar; no permanent
formatting toolbar. Sidebar tabs and bottom-left small controls. Word count at
bottom right. Match observations rather than inventing a dashboard.

## Verification

Run renderer typecheck/build; native compile/build; browser end-to-end editing
and persistence checks; launch app. Save representative screenshots. Exercise
real interactions and Markdown roundtrips. Report unverified behaviors and gaps.
