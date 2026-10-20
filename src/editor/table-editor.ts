// Direct WYSIWYG GFM table editing. Coordinator wires this into TableWidget
// and command interceptors; this module does not patch those files.

import { undo, redo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { prepareMarkdownTables } from '../markdown-tables';
import type { WidgetContext } from './widgets';
import './table-editor.css';

export type TableAlign = 'none' | 'left' | 'center' | 'right';

export interface MarkdownTable {
  header: string[];
  alignments: TableAlign[];
  rows: string[][];
}

export interface TableRange {
  from: number;
  to: number;
}

const fragmentRenderer = new MarkdownIt({ html: true, linkify: true });

const FORMAT_COMMANDS = new Set([
  'bold',
  'italic',
  'underline',
  'strike',
  'inlineCode',
  'highlight',
  'clearFormat',
]);

const SWALLOW_WHEN_FOCUSED = new Set([
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'paragraph',
  'increaseHeading',
  'decreaseHeading',
  'quote',
  'orderedList',
  'bulletList',
  'taskList',
  'codeFences',
  'mathBlock',
  'indent',
  'outdent',
  'horizontalRule',
  'footnote',
  'yamlFrontMatter', 'toc', 'insertParagraphAbove', 'insertParagraphBelow',
  'linkReference', 'linkReferenceDefinition', 'comment',
  'toggleTaskState', 'taskChecked', 'taskUnchecked',
  'alertNote', 'alertTip', 'alertImportant', 'alertWarning', 'alertCaution',
  'table',
  'hyperlink',
  'image',
  'selectLine',
  'duplicateLine',
  'jumpTop',
  'jumpBottom',
]);

const controllers = new WeakMap<HTMLElement, TableController>();
let activeController: TableController | null = null;

function isPipeEscaped(line: string, at: number): boolean {
  let count = 0;
  let i = at;
  while (i > 0 && line[--i] === '\\') count++;
  return count % 2 === 1;
}

function codeSpanMask(line: string): boolean[] {
  const mask = Array(line.length).fill(false);
  for (let index = 0; index < line.length; ) {
    if (line[index] !== '`' || isPipeEscaped(line, index)) {
      index++;
      continue;
    }
    let openEnd = index;
    while (openEnd < line.length && line[openEnd] === '`') openEnd++;
    const count = openEnd - index;
    let close = -1;
    for (let at = openEnd; at < line.length; ) {
      if (line[at] !== '`') {
        at++;
        continue;
      }
      let end = at;
      while (end < line.length && line[end] === '`') end++;
      if (end - at === count) {
        close = at;
        break;
      }
      at = end;
    }
    if (close < 0) {
      index = openEnd;
      continue;
    }
    for (let at = openEnd; at < close; at++) mask[at] = true;
    index = close + count;
  }
  return mask;
}

/** Split a GFM table row. Unescaped pipes outside matched code spans are cells. */
export function splitTableRow(line: string): string[] {
  const mask = codeSpanMask(line);
  const cells: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && !isPipeEscaped(line, i) && !mask[i]) {
      cells.push(line.slice(start, i));
      start = i + 1;
    }
  }
  cells.push(line.slice(start));
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.replace(/^\s+/, '').replace(/\s+$/, ''));
}

function parseAlignCell(cell: string): TableAlign | null {
  const t = cell.trim();
  if (!/^:?-+:?$/.test(t) || !t.includes('-')) return null;
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return 'none';
}

export function isAlignmentRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => parseAlignCell(c) !== null);
}

export function parseMarkdownTable(source: string): MarkdownTable | null {
  const lines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let delim = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isAlignmentRow(lines[i]) && lines[i - 1].includes('|')) {
      delim = i;
      break;
    }
  }
  if (delim < 0) return null;
  const header = splitTableRow(lines[delim - 1]);
  if (header.length < 1) return null;
  const alignments = splitTableRow(lines[delim]).map((c) => parseAlignCell(c) ?? 'none');
  while (alignments.length < header.length) alignments.push('none');
  alignments.length = header.length;
  const rows: string[][] = [];
  for (let i = delim + 1; i < lines.length; i++) {
    if (!lines[i].includes('|')) break;
    if (lines[i].trim() === '') break;
    rows.push(padCells(splitTableRow(lines[i]), header.length));
  }
  if (rows.length < 1) rows.push(padCells([], header.length));
  return { header: padCells(header, header.length), alignments, rows };
}

function padCells(cells: string[], n: number): string[] {
  const next = cells.slice(0, n);
  while (next.length < n) next.push('');
  return next;
}

function escapeCellPipes(raw: string): string {
  const mask = codeSpanMask(raw);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '|' && !isPipeEscaped(raw, i) && !mask[i]) out += '\\';
    out += raw[i];
  }
  return out;
}

function alignToken(align: TableAlign, width: number): string {
  const inner = Math.max(3, width);
  if (align === 'left') return ':' + '-'.repeat(inner - 1);
  if (align === 'right') return '-'.repeat(inner - 1) + ':';
  if (align === 'center') return ':' + '-'.repeat(Math.max(1, inner - 2)) + ':';
  return '-'.repeat(inner);
}

function cellWidth(cell: string): number {
  return Math.max(3, escapeCellPipes(cell).length + 2);
}

/** Format a whole table. Used for structural edits of this table only. */
export function serializeMarkdownTable(table: MarkdownTable): string {
  const cols = Math.max(1, table.header.length);
  const header = padCells(table.header, cols).map(escapeCellPipes);
  const alignments = padCellsAlign(table.alignments, cols);
  const rows = table.rows.length ? table.rows.map((r) => padCells(r, cols).map(escapeCellPipes)) : [padCells([], cols)];
  const widths = Array.from({ length: cols }, (_, c) => {
    let w = cellWidth(header[c]);
    w = Math.max(w, alignToken(alignments[c], 3).length + 2);
    for (const row of rows) w = Math.max(w, cellWidth(row[c]));
    return w;
  });
  const fmt = (cell: string, i: number) => {
    const body = ` ${cell} `;
    return body + ' '.repeat(Math.max(0, widths[i] - body.length));
  };
  const delim = alignments.map((a, i) => {
    const tok = alignToken(a, widths[i] - 2);
    const body = ` ${tok} `;
    return body + ' '.repeat(Math.max(0, widths[i] - body.length));
  });
  const lines = [
    '|' + header.map(fmt).join('|') + '|',
    '|' + delim.join('|') + '|',
    ...rows.map((r) => '|' + r.map(fmt).join('|') + '|'),
  ];
  return lines.join('\n');
}

function padCellsAlign(aligns: TableAlign[], n: number): TableAlign[] {
  const next = aligns.slice(0, n);
  while (next.length < n) next.push('none');
  return next;
}

export function replaceCell(table: MarkdownTable, row: number, col: number, raw: string): MarkdownTable {
  const cols = table.header.length;
  if (col < 0 || col >= cols) return table;
  if (row === 0) {
    const header = table.header.slice();
    header[col] = raw;
    return { ...table, header };
  }
  const ri = row - 1;
  if (ri < 0 || ri >= table.rows.length) return table;
  const rows = table.rows.map((r, i) => (i === ri ? r.map((c, j) => (j === col ? raw : c)) : r));
  return { ...table, rows };
}

export function insertTableRow(table: MarkdownTable, at: number): MarkdownTable {
  const cols = table.header.length;
  const rows = table.rows.slice();
  const index = Math.max(0, Math.min(at, rows.length));
  rows.splice(index, 0, padCells([], cols));
  return { ...table, rows };
}

export function deleteTableRow(table: MarkdownTable, dataIndex: number): MarkdownTable {
  if (table.rows.length <= 1) return table;
  if (dataIndex < 0 || dataIndex >= table.rows.length) return table;
  const rows = table.rows.filter((_, i) => i !== dataIndex);
  return { ...table, rows };
}

export function insertTableColumn(table: MarkdownTable, at: number): MarkdownTable {
  const index = Math.max(0, Math.min(at, table.header.length));
  const header = table.header.slice();
  header.splice(index, 0, '');
  const alignments = table.alignments.slice();
  alignments.splice(index, 0, 'none');
  const rows = table.rows.map((r) => {
    const next = r.slice();
    next.splice(index, 0, '');
    return next;
  });
  return { header, alignments, rows };
}

export function deleteTableColumn(table: MarkdownTable, at: number): MarkdownTable {
  if (table.header.length <= 1) return table;
  if (at < 0 || at >= table.header.length) return table;
  const header = table.header.filter((_, i) => i !== at);
  const alignments = table.alignments.filter((_, i) => i !== at);
  const rows = table.rows.map((r) => r.filter((_, i) => i !== at));
  return { header, alignments, rows };
}

export function setTableAlignment(table: MarkdownTable, col: number, align: TableAlign): MarkdownTable {
  if (col < 0 || col >= table.alignments.length) return table;
  const alignments = table.alignments.slice();
  alignments[col] = align;
  return { ...table, alignments };
}

export function moveTableRow(table: MarkdownTable, from: number, to: number): MarkdownTable {
  if (from === to) return table;
  if (from < 0 || from >= table.rows.length) return table;
  const rows = table.rows.slice();
  const [row] = rows.splice(from, 1);
  const dest = Math.max(0, Math.min(to, rows.length));
  rows.splice(dest, 0, row);
  return { ...table, rows };
}

export function moveTableColumn(table: MarkdownTable, from: number, to: number): MarkdownTable {
  if (from === to) return table;
  const n = table.header.length;
  if (from < 0 || from >= n) return table;
  const dest = Math.max(0, Math.min(to, n - 1));
  const reorder = <T,>(arr: T[]): T[] => {
    const next = arr.slice();
    const [item] = next.splice(from, 1);
    next.splice(dest, 0, item);
    return next;
  };
  return {
    header: reorder(table.header),
    alignments: reorder(table.alignments),
    rows: table.rows.map(reorder),
  };
}

export function resizeTable(table: MarkdownTable, dataRows: number, cols: number): MarkdownTable {
  const r = Math.max(1, dataRows | 0);
  const c = Math.max(1, cols | 0);
  let next: MarkdownTable = {
    header: padCells(table.header, c),
    alignments: padCellsAlign(table.alignments, c),
    rows: table.rows.map((row) => padCells(row, c)),
  };
  while (next.header.length > c) next = deleteTableColumn(next, next.header.length - 1);
  while (next.header.length < c) next = insertTableColumn(next, next.header.length);
  while (next.rows.length > r) next = deleteTableRow(next, next.rows.length - 1);
  while (next.rows.length < r) next = insertTableRow(next, next.rows.length);
  return next;
}

/**
 * Patch a single cell in the original table source so untouched cells keep
 * their raw Markdown and spacing. Falls back to full serialize if the line
 * cannot be patched.
 */
export function patchTableCell(source: string, row: number, col: number, raw: string): string | null {
  const parsed = parseMarkdownTable(source);
  if (!parsed) return null;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let delim = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isAlignmentRow(lines[i]) && lines[i - 1].includes('|')) {
      delim = i;
      break;
    }
  }
  if (delim < 0) return null;
  const lineIndex = row === 0 ? delim - 1 : delim + row;
  if (lineIndex < 0 || lineIndex >= lines.length) return serializeMarkdownTable(replaceCell(parsed, row, col, raw));
  const line = lines[lineIndex];
  const mask = codeSpanMask(line);
  const bounds: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && !isPipeEscaped(line, i) && !mask[i]) {
      bounds.push({ start, end: i });
      start = i + 1;
    }
  }
  bounds.push({ start, end: line.length });
  if (bounds.length && line.slice(bounds[0].start, bounds[0].end).trim() === '' && line[bounds[0].end] === '|') {
    bounds.shift();
  }
  if (bounds.length && line.slice(bounds[bounds.length - 1].start, bounds[bounds.length - 1].end).trim() === '') {
    bounds.pop();
  }
  if (col < 0 || col >= bounds.length) return serializeMarkdownTable(replaceCell(parsed, row, col, raw));
  const b = bounds[col];
  const original = line.slice(b.start, b.end);
  const lead = original.match(/^\s*/)?.[0] ?? '';
  const trail = original.match(/\s*$/)?.[0] ?? '';
  const nextLine = line.slice(0, b.start) + lead + escapeCellPipes(raw) + trail + line.slice(b.end);
  const next = lines.slice();
  next[lineIndex] = nextLine;
  return next.join('\n');
}

export function findTableInDocument(doc: string, from: number, source: string): TableRange | null {
  if (from >= 0 && from + source.length <= doc.length && doc.slice(from, from + source.length) === source) {
    return { from, to: from + source.length };
  }
  const first = doc.indexOf(source);
  if (first < 0) return null;
  const second = doc.indexOf(source, first + 1);
  if (second >= 0) return null;
  return { from: first, to: first + source.length };
}

function cellRaw(table: MarkdownTable, row: number, col: number): string {
  if (row === 0) return table.header[col] ?? '';
  return table.rows[row - 1]?.[col] ?? '';
}

function cssAlign(align: TableAlign): string {
  if (align === 'left' || align === 'center' || align === 'right') return align;
  return '';
}

function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined') return html;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function renderInlineMarkdown(raw: string): string {
  const wrapped = `| ${raw} |\n| --- |\n| x |`;
  const html = fragmentRenderer.render(prepareMarkdownTables(wrapped));
  const match = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(html);
  return sanitizeHtml(match ? match[1] : fragmentRenderer.renderInline(raw));
}

function wrapInline(text: string, open: string, close = open): string {
  if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
    return text.slice(open.length, text.length - close.length);
  }
  return open + text + close;
}

function clearInline(text: string): string {
  return text
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/==(.*?)==/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<\/?u>/g, '');
}

interface SavedCaret {
  start: number;
  end: number;
}

function readCellText(el: HTMLElement): string {
  // A cell's line break is HTML <br> in GFM; a literal source newline ends the row.
  return el.innerText.replace(/\r\n?/g, '\n').replace(/\n$/, '').replace(/\n/g, '<br>');
}

function saveCaret(el: HTMLElement): SavedCaret | null {
  const sel = el.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length };
}

function restoreCaret(el: HTMLElement, caret: SavedCaret | null): void {
  if (!caret) return;
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const next = pos + node.data.length;
    if (!startNode && caret.start <= next) {
      startNode = node;
      startOff = Math.max(0, caret.start - pos);
    }
    if (!endNode && caret.end <= next) {
      endNode = node;
      endOff = Math.max(0, caret.end - pos);
      break;
    }
    pos = next;
    node = walker.nextNode() as Text | null;
  }
  const range = el.ownerDocument.createRange();
  if (startNode) range.setStart(startNode, Math.min(startOff, startNode.data.length));
  else {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  if (endNode) range.setEnd(endNode, Math.min(endOff, endNode.data.length));
  else range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

class TableController {
  source: string;
  from: number;
  ctx: WidgetContext;
  table: MarkdownTable;
  focused: { row: number; col: number } | null = null;
  composing = false;
  applying = false;
  suppressBlur = false;
  private entering = false;
  private root: HTMLElement;
  private grid!: HTMLTableElement;
  private toolbar!: HTMLElement;
  private menu: HTMLElement | null = null;
  private rowCountInput!: HTMLInputElement;
  private colCountInput!: HTMLInputElement;
  private readonly onDocMouseDown = (e: MouseEvent) => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
  };

  constructor(root: HTMLElement, source: string, from: number, ctx: WidgetContext) {
    this.root = root;
    this.source = source;
    this.from = from;
    this.ctx = ctx;
    this.table = parseMarkdownTable(source) ?? {
      header: [''],
      alignments: ['none'],
      rows: [['']],
    };
    this.buildShell();
    this.rebuildGrid();
  }

  refresh(source: string, from: number, ctx: WidgetContext): void {
    this.from = from;
    this.ctx = ctx;
    if (source === this.source) return;
    const parsed = parseMarkdownTable(source);
    if (!parsed) return;
    const sameShape =
      parsed.header.length === this.table.header.length && parsed.rows.length === this.table.rows.length;
    this.source = source;
    this.table = parsed;
    if (sameShape) this.reconcileInPlace();
    else this.rebuildGrid(true);
  }

  destroy(): void {
    this.closeMenu();
    document.removeEventListener('mousedown', this.onDocMouseDown);
    if (activeController === this) activeController = null;
    this.focused = null;
    this.suppressBlur = false;
  }

  private buildShell(): void {
    this.root.className = 'lp-table lp-table-editor md-render';
    this.root.replaceChildren();
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'lp-table-toolbar';
    this.toolbar.setAttribute('role', 'toolbar');
    this.toolbar.append(
      this.toolBtn('←', 'Align left', () => this.alignFocused('left')),
      this.toolBtn('↔', 'Align center', () => this.alignFocused('center')),
      this.toolBtn('→', 'Align right', () => this.alignFocused('right')),
    );
    const sep = document.createElement('span');
    sep.className = 'lp-table-sep';
    this.toolbar.append(sep);
    this.rowCountInput = this.countInput('Rows', () => this.applyResize());
    this.colCountInput = this.countInput('Columns', () => this.applyResize());
    this.toolbar.append(this.rowCountInput, this.colCountInput);
    const sep2 = document.createElement('span');
    sep2.className = 'lp-table-sep';
    this.toolbar.append(
      sep2,
      this.toolBtn('+row', 'Insert row below', () => this.insertRowBelow()),
      this.toolBtn('−row', 'Delete row', () => this.deleteFocusedRow()),
      this.toolBtn('+col', 'Insert column right', () => this.insertColRight()),
      this.toolBtn('−col', 'Delete column', () => this.deleteFocusedCol()),
    );
    const scroll = document.createElement('div');
    scroll.className = 'lp-table-scroll';
    this.grid = document.createElement('table');
    this.grid.className = 'lp-table-grid';
    scroll.append(this.grid);
    this.root.append(this.toolbar, scroll);
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.root.addEventListener('contextmenu', (e) => this.onContext(e));
    document.addEventListener('mousedown', this.onDocMouseDown);
  }

  private toolBtn(label: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activeController = this;
      fn();
    });
    return b;
  }

  private countInput(title: string, onCommit: () => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.title = title;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onCommit();
      }
    });
    input.addEventListener('change', onCommit);
    return input;
  }

  private syncCounts(): void {
    this.rowCountInput.value = String(this.table.rows.length);
    this.colCountInput.value = String(this.table.header.length);
  }

  private applyCellChrome(el: HTMLTableCellElement, row: number, col: number): void {
    el.dataset.row = String(row);
    el.dataset.col = String(col);
    const css = cssAlign(this.table.alignments[col] ?? 'none');
    el.style.textAlign = css;
  }

  private reconcileInPlace(): void {
    this.syncCounts();
    const cols = this.table.header.length;
    const dataRows = this.table.rows.length;
    for (let row = 0; row <= dataRows; row++) {
      for (let col = 0; col < cols; col++) {
        const el = this.cellEl(row, col);
        if (!el) {
          this.rebuildGrid(true);
          return;
        }
        this.applyCellChrome(el, row, col);
        const raw = cellRaw(this.table, row, col);
        const isFocused =
          this.focused?.row === row &&
          this.focused?.col === col &&
          (el === document.activeElement || el.contains(document.activeElement));
        if (isFocused) {
          if (this.composing) continue;
          const current = readCellText(el);
          if (current !== raw) {
            const caret = saveCaret(el);
            el.contentEditable = 'true';
            el.classList.add('lp-cell-raw');
            el.textContent = raw;
            restoreCaret(el, caret ? { start: Math.min(caret.start, raw.length), end: Math.min(caret.end, raw.length) } : { start: raw.length, end: raw.length });
          }
        } else {
          el.contentEditable = 'false';
          el.classList.remove('lp-cell-raw');
          el.innerHTML = renderInlineMarkdown(raw);
        }
      }
    }
    this.syncAlignButtons();
  }

  private rebuildGrid(restoreFocus = false): void {
    this.suppressBlur = true;
    this.syncCounts();
    const cols = this.table.header.length;
    const dataRows = this.table.rows.length;
    const focus = this.focused;

    const thead = document.createElement('thead');
    const colHandles = document.createElement('tr');
    colHandles.className = 'lp-table-handle-row';
    const corner = document.createElement('th');
    corner.className = 'lp-table-corner';
    colHandles.append(corner);
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      th.className = 'lp-table-colhead';
      const handle = document.createElement('span');
      handle.className = 'lp-col-handle';
      handle.draggable = true;
      handle.dataset.col = String(c);
      handle.title = 'Drag to reorder column';
      this.bindColDrag(handle, c);
      th.append(handle);
      colHandles.append(th);
    }
    thead.append(colHandles);

    const headerRow = document.createElement('tr');
    headerRow.append(this.rowHandle(-1));
    for (let c = 0; c < cols; c++) headerRow.append(this.makeCell(0, c, true));
    thead.append(headerRow);

    const tbody = document.createElement('tbody');
    for (let r = 0; r < dataRows; r++) {
      const tr = document.createElement('tr');
      tr.append(this.rowHandle(r));
      for (let c = 0; c < cols; c++) tr.append(this.makeCell(r + 1, c, false));
      tbody.append(tr);
    }

    this.grid.replaceChildren(thead, tbody);
    this.syncAlignButtons();
    if (restoreFocus && focus) this.focusCell(focus.row, focus.col);
    this.suppressBlur = false;
    if (restoreFocus && focus) {
      const row = focus.row;
      const col = focus.col;
      queueMicrotask(() => {
        if (!this.root.isConnected) return;
        this.focusCell(row, col);
      });
    }
  }

  private rowHandle(dataIndex: number): HTMLTableCellElement {
    const td = document.createElement(dataIndex < 0 ? 'th' : 'td');
    td.className = 'lp-row-handle';
    if (dataIndex >= 0) {
      const grip = document.createElement('span');
      grip.className = 'lp-row-grip';
      grip.draggable = true;
      grip.dataset.row = String(dataIndex);
      grip.title = 'Drag to reorder row';
      this.bindRowDrag(grip, dataIndex);
      td.append(grip);
    }
    return td;
  }

  private makeCell(row: number, col: number, header: boolean): HTMLTableCellElement {
    const el = document.createElement(header ? 'th' : 'td');
    el.className = 'lp-cell';
    this.applyCellChrome(el, row, col);
    el.innerHTML = renderInlineMarkdown(cellRaw(this.table, row, col));
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      activeController = this;
      this.root.classList.add('lp-table-active');
    });
    el.addEventListener('focus', () => {
      activeController = this;
      this.enterCell(el, row, col, true);
    });
    el.addEventListener('blur', () => {
      if (this.composing) return;
      this.leaveCell(el, row, col);
    });
    el.addEventListener('input', () => {
      if (this.composing) return;
      this.commitFromCell(el, row, col);
    });
    el.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    el.addEventListener('compositionend', () => {
      this.composing = false;
      this.commitFromCell(el, row, col);
    });
    el.tabIndex = 0;
    return el;
  }

  private cellEl(row: number, col: number): HTMLTableCellElement | null {
    return this.grid.querySelector(`[data-row="${row}"][data-col="${col}"]`);
  }

  private enterCell(el: HTMLTableCellElement, row: number, col: number, showRaw: boolean): void {
    if (this.entering) return;
    this.entering = true;
    this.focused = { row, col };
    this.root.classList.add('lp-table-active');
    activeController = this;
    if (showRaw && el.contentEditable !== 'true') {
      el.contentEditable = 'true';
      el.classList.add('lp-cell-raw');
      el.textContent = cellRaw(this.table, row, col);
    } else if (el.contentEditable !== 'true') {
      el.contentEditable = 'true';
      el.classList.add('lp-cell-raw');
    }
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    this.syncAlignButtons();
    this.entering = false;
  }

  private leaveCell(el: HTMLTableCellElement, row: number, col: number): void {
    if (this.suppressBlur) return;
    if (this.focused && this.focused.row === row && this.focused.col === col) {
      this.commitFromCell(el, row, col);
      this.focused = null;
    }
    el.contentEditable = 'false';
    el.classList.remove('lp-cell-raw');
    el.innerHTML = renderInlineMarkdown(cellRaw(this.table, row, col));
    if (!this.root.contains(document.activeElement)) this.root.classList.remove('lp-table-active');
  }

  private commitFromCell(el: HTMLTableCellElement, row: number, col: number): void {
    if (this.applying || this.suppressBlur) return;
    const raw = readCellText(el);
    if (raw === cellRaw(this.table, row, col)) return;
    const patched = patchTableCell(this.source, row, col, raw);
    if (patched == null) return;
    this.table = replaceCell(this.table, row, col, raw);
    this.writeSource(patched);
  }

  writeSource(next: string): boolean {
    if (next === this.source) return true;
    if (this.applying) return false;
    const view = this.ctx.view;
    const doc = view.state.doc.toString();
    const range = findTableInDocument(doc, this.from, this.source);
    if (!range) return false;
    this.applying = true;
    this.source = next;
    this.from = range.from;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: next },
    });
    this.applying = false;
    return true;
  }

  writeStructured(nextTable: MarkdownTable, focus?: { row: number; col: number }): void {
    if (this.applying) return;
    this.table = nextTable;
    if (focus) this.focused = focus;
    const text = serializeMarkdownTable(nextTable);
    this.writeSource(text);
    this.rebuildGrid(true);
  }

  private currentCell(): { row: number; col: number } {
    return this.focused ?? { row: 0, col: 0 };
  }

  insertRowBelow(): void {
    const { row } = this.currentCell();
    const at = row === 0 ? 0 : row;
    this.writeStructured(insertTableRow(this.table, at), { row: at + 1, col: this.currentCell().col });
  }

  insertRowAbove(): void {
    const { row, col } = this.currentCell();
    const at = Math.max(0, row - 1);
    this.writeStructured(insertTableRow(this.table, at), { row: at + 1, col });
  }

  deleteFocusedRow(): void {
    const { row, col } = this.currentCell();
    if (row === 0) return;
    const next = deleteTableRow(this.table, row - 1);
    if (next === this.table || next.rows.length === this.table.rows.length) return;
    const nr = Math.min(row, next.rows.length);
    this.writeStructured(next, { row: nr, col });
  }

  insertColRight(): void {
    const { row, col } = this.currentCell();
    this.writeStructured(insertTableColumn(this.table, col + 1), { row, col: col + 1 });
  }

  insertColLeft(): void {
    const { row, col } = this.currentCell();
    this.writeStructured(insertTableColumn(this.table, col), { row, col });
  }

  deleteFocusedCol(): void {
    const { row, col } = this.currentCell();
    const next = deleteTableColumn(this.table, col);
    if (next.header.length === this.table.header.length) return;
    const nc = Math.min(col, next.header.length - 1);
    this.writeStructured(next, { row, col: nc });
  }

  alignFocused(align: TableAlign): void {
    const { row, col } = this.currentCell();
    this.writeStructured(setTableAlignment(this.table, col, align), { row, col });
  }

  applyResize(): void {
    const rows = Math.max(1, Number(this.rowCountInput.value) || 1);
    const cols = Math.max(1, Number(this.colCountInput.value) || 1);
    const { row, col } = this.currentCell();
    const next = resizeTable(this.table, rows, cols);
    this.writeStructured(next, {
      row: Math.min(row, next.rows.length),
      col: Math.min(col, next.header.length - 1),
    });
  }

  formatSelection(command: string): boolean {
    const cell = this.focused ? this.cellEl(this.focused.row, this.focused.col) : null;
    if (!cell || cell.contentEditable !== 'true') return false;
    const sel = cell.ownerDocument.getSelection();
    const selected = sel && cell.contains(sel.anchorNode) ? sel.toString() : '';
    const whole = cell.innerText.replace(/\u00a0/g, ' ');
    const target = selected || whole;
    let next = target;
    if (command === 'bold') next = wrapInline(target, '**');
    else if (command === 'italic') next = wrapInline(target, '*');
    else if (command === 'strike') next = wrapInline(target, '~~');
    else if (command === 'highlight') next = wrapInline(target, '==');
    else if (command === 'inlineCode') next = wrapInline(target, '`');
    else if (command === 'underline') next = wrapInline(target, '<u>', '</u>');
    else if (command === 'clearFormat') next = clearInline(target);
    else return false;
    if (selected && sel) {
      const caret = saveCaret(cell);
      document.execCommand('insertText', false, next);
      if (caret) restoreCaret(cell, { start: caret.start, end: caret.start + next.length });
    } else {
      cell.textContent = next;
    }
    this.commitFromCell(cell, this.focused!.row, this.focused!.col);
    return true;
  }

  selectAllInCell(): boolean {
    const cell = this.focused ? this.cellEl(this.focused.row, this.focused.col) : null;
    if (!cell) return false;
    const range = cell.ownerDocument.createRange();
    range.selectNodeContents(cell);
    const sel = cell.ownerDocument.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return true;
  }

  undoRedo(which: 'undo' | 'redo'): boolean {
    const view = this.ctx.view as EditorView;
    if (which === 'undo') undo(view);
    else redo(view);
    return true;
  }

  private onKey(e: KeyboardEvent): void {
    if (this.composing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      this.moveTab(e.shiftKey ? -1 : 1);
      return;
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.insertRowBelow();
      return;
    }
    if (mod && e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      e.stopPropagation();
      this.deleteFocusedRow();
      return;
    }
  }

  private moveTab(dir: number): void {
    const cols = this.table.header.length;
    const maxRow = this.table.rows.length;
    let { row, col } = this.currentCell();
    col += dir;
    if (col >= cols) {
      col = 0;
      row += 1;
      if (row > maxRow) {
        this.writeStructured(insertTableRow(this.table, this.table.rows.length), { row, col: 0 });
        return;
      }
    } else if (col < 0) {
      col = cols - 1;
      row -= 1;
      if (row < 0) row = 0;
    }
    this.focusCell(row, col);
  }

  focusCell(row: number, col: number): void {
    const el = this.cellEl(row, col);
    if (!el) return;
    this.enterCell(el, row, col, true);
    el.focus();
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = el.ownerDocument.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  private syncAlignButtons(): void {
    const col = this.focused?.col ?? 0;
    const align = this.table.alignments[col] ?? 'none';
    const buttons = this.toolbar.querySelectorAll('button');
    const map = ['left', 'center', 'right'] as const;
    buttons.forEach((b, i) => {
      if (i < 3) b.setAttribute('aria-pressed', map[i] === align ? 'true' : 'false');
    });
  }

  private onContext(e: MouseEvent): void {
    const cell = (e.target as HTMLElement).closest('.lp-cell') as HTMLTableCellElement | null;
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    this.focused = { row, col };
    activeController = this;
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'lp-table-menu';
    const item = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        this.closeMenu();
        fn();
      });
      menu.append(b);
    };
    item('Insert row above', () => this.insertRowAbove());
    item('Insert row below', () => this.insertRowBelow());
    item('Delete row', () => this.deleteFocusedRow());
    item('Insert column left', () => this.insertColLeft());
    item('Insert column right', () => this.insertColRight());
    item('Delete column', () => this.deleteFocusedCol());
    item('Align left', () => this.alignFocused('left'));
    item('Align center', () => this.alignFocused('center'));
    item('Align right', () => this.alignFocused('right'));
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    this.root.append(menu);
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private bindRowDrag(handle: HTMLElement, from: number): void {
    handle.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/table-row', String(from));
      e.dataTransfer?.setDragImage(handle, 0, 0);
      this.root.classList.add('lp-dragging');
    });
    handle.addEventListener('dragend', () => this.root.classList.remove('lp-dragging'));
    handle.addEventListener('dragover', (e) => e.preventDefault());
    handle.addEventListener('drop', (e) => {
      e.preventDefault();
      const src = Number(e.dataTransfer?.getData('text/table-row'));
      if (!Number.isFinite(src)) return;
      this.writeStructured(moveTableRow(this.table, src, from), {
        row: from + 1,
        col: this.currentCell().col,
      });
    });
  }

  private bindColDrag(handle: HTMLElement, from: number): void {
    handle.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/table-col', String(from));
      this.root.classList.add('lp-dragging');
    });
    handle.addEventListener('dragend', () => this.root.classList.remove('lp-dragging'));
    handle.addEventListener('dragover', (e) => e.preventDefault());
    handle.addEventListener('drop', (e) => {
      e.preventDefault();
      const src = Number(e.dataTransfer?.getData('text/table-col'));
      if (!Number.isFinite(src)) return;
      this.writeStructured(moveTableColumn(this.table, src, from), {
        row: this.currentCell().row,
        col: from,
      });
    });
  }
}

export function createTableEditor(source: string, from: number, ctx: WidgetContext): HTMLElement {
  const root = document.createElement('div');
  const controller = new TableController(root, source, from, ctx);
  controllers.set(root, controller);
  return root;
}

export function updateTableEditor(
  dom: HTMLElement,
  source: string,
  from: number,
  ctx: WidgetContext,
): boolean {
  const controller = controllers.get(dom);
  if (!controller) return false;
  controller.ctx = ctx;
  controller.from = from;
  if (controller.applying) {
    controller.source = source;
    return true;
  }
  controller.refresh(source, from, ctx);
  return true;
}

export function destroyTableEditor(dom: HTMLElement): void {
  const controller = controllers.get(dom);
  if (!controller) return;
  controller.destroy();
  controllers.delete(dom);
}

function ownsTableFocus(): TableController | null {
  if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return null;
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return activeController && activeController.focused ? activeController : null;
  for (const root of [el.closest('.lp-table-editor') as HTMLElement | null]) {
    if (root) {
      const c = controllers.get(root);
      if (c) {
        activeController = c;
        return c;
      }
    }
  }
  if (el.closest?.('.lp-table-toolbar') || el.closest?.('.lp-table-menu')) return activeController;
  return null;
}

export function handleTableCommand(command: string, payload?: unknown): boolean {
  const ctrl = ownsTableFocus();
  if (!ctrl) return false;

  if (command === 'undo') return ctrl.undoRedo('undo');
  if (command === 'redo') return ctrl.undoRedo('redo');
  if (command === 'selectAll') return ctrl.selectAllInCell();
  if (FORMAT_COMMANDS.has(command)) return ctrl.formatSelection(command);

  if (command === 'deleteLine') {
    ctrl.deleteFocusedRow();
    return true;
  }

  const tableCmd = command === 'tableCommand' ? String((payload as { action?: string } | undefined)?.action ?? '') : command;
  switch (tableCmd) {
    case 'tableInsertRow':
    case 'insertRow':
    case 'tableInsertRowBelow':
      ctrl.insertRowBelow();
      return true;
    case 'tableInsertRowAbove':
      ctrl.insertRowAbove();
      return true;
    case 'tableDeleteRow':
    case 'deleteRow':
      ctrl.deleteFocusedRow();
      return true;
    case 'tableInsertCol':
    case 'tableInsertColumn':
    case 'insertColumn':
    case 'tableInsertColRight':
      ctrl.insertColRight();
      return true;
    case 'tableInsertColLeft':
      ctrl.insertColLeft();
      return true;
    case 'tableDeleteCol':
    case 'tableDeleteColumn':
    case 'deleteColumn':
      ctrl.deleteFocusedCol();
      return true;
    case 'tableAlignLeft':
    case 'alignLeft':
      ctrl.alignFocused('left');
      return true;
    case 'tableAlignCenter':
    case 'alignCenter':
      ctrl.alignFocused('center');
      return true;
    case 'tableAlignRight':
    case 'alignRight':
      ctrl.alignFocused('right');
      return true;
    case 'tableAlignNone':
    case 'alignDefault':
      ctrl.alignFocused('none');
      return true;
    default:
      break;
  }

  if (SWALLOW_WHEN_FOCUSED.has(command)) return true;
  return false;
}
