// Markdown format commands: inline style toggles, block structure commands,
// insertions. All operate on the raw source (lossless by design).

import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { indentMore, indentLess, isolateHistory } from '@codemirror/commands';
import { documentIndent, markerSpace, inCode } from './preferences';
import { store } from '../store';
import { freezeMarkdownPreferences } from '../markdown-preferences';
import { syntaxTree } from '@codemirror/language';

// --- inline styles ----------------------------------------------------------

function toggleInline(view: EditorView, open: string, close = open): void {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const { from, to } = range;
    const doc = state.doc;
    // already wrapped?  **text** with cursor selection inside
    const before = doc.sliceString(Math.max(0, from - open.length), from);
    const after = doc.sliceString(to, Math.min(doc.length, to + close.length));
    if (before === open && after === close) {
      return {
        range: EditorSelection.range(from - open.length, to - open.length),
        changes: [
          { from: to, to: to + close.length, insert: '' },
          { from: from - open.length, to: from, insert: '' },
        ],
      };
    }
    const text = state.sliceDoc(from, to);
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      // selection includes the marks
      return {
        range: EditorSelection.range(from, to - open.length - close.length),
        changes: [{ from, to, insert: text.slice(open.length, text.length - close.length) }],
      };
    }
    const insert = open + text + close;
    return {
      range: text
        ? EditorSelection.range(from + open.length, to + open.length)
        : EditorSelection.cursor(from + open.length),
      changes: [{ from, to, insert }],
    };
  });
  view.dispatch(changes);
  view.focus();
}

export const toggleBold = (v: EditorView) => toggleInline(v, '**');
export const toggleItalic = (v: EditorView) => toggleInline(v, '*');
export const toggleStrike = (v: EditorView) => toggleInline(v, '~~');
export const toggleHighlight = (v: EditorView) => toggleInline(v, '==');
export const toggleInlineCode = (v: EditorView) => toggleInline(v, '`');
export const toggleUnderline = (v: EditorView) => toggleInline(v, '<u>', '</u>');

export function clearFormat(view: EditorView): void {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const cleaned = text
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/==(.*?)==/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/<\/?u>/g, '');
    return {
      range,
      changes: [{ from: range.from, to: range.to, insert: cleaned }],
    };
  });
  view.dispatch(changes);
  view.focus();
}

// --- block structure --------------------------------------------------------

function eachSelectedLine(view: EditorView, fn: (text: string, from: number, to: number) => string | null): void {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1));
    for (let n = startLine.number; n <= endLine.number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const next = fn(line.text, line.from, line.to);
      if (next !== null) changes.push({ from: line.from, to: line.to, insert: next });
    }
  }
  if (changes.length) view.dispatch({ changes, annotations: isolateHistory.of('full') });
  view.focus();
}

export function setHeading(view: EditorView, level: number): void {
  const changes: { from: number; to: number; insert: string }[] = [];
  const seen = new Set<number>();
  const state = view.state;
  let caret: number | undefined;
  for (const range of state.selection.ranges) {
    for (let row = state.doc.lineAt(range.from).number; row <= state.doc.lineAt(range.empty ? range.to : range.to - 1).number; row++) {
      if (seen.has(row)) continue;
      seen.add(row);
      const line = state.doc.line(row);
      if (!line.text.trim()) continue;
      let to = line.to;
      if (row < state.doc.lines && /^ {0,3}(?:=+|-+)\s*$/.test(state.doc.line(row + 1).text)) {
        to = state.doc.line(row + 1).to; seen.add(row + 1);
      }
      const stripped = line.text.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '');
      const insert = headingSource(stripped, level);
      changes.push({ from: line.from, to, insert });
      if (state.selection.ranges.length === 1 && range.empty && range.head >= line.from && range.head <= to) {
        const oldPrefix = /^\s{0,3}#{1,6}\s*/.exec(line.text)?.[0].length ?? 0;
        const newPrefix = /^#{1,6}\s/.exec(insert)?.[0].length ?? 0;
        caret = line.from + newPrefix + Math.max(0, Math.min(stripped.length, range.head - line.from - oldPrefix));
      }
    }
  }
  if (changes.length) view.dispatch({ changes, ...(caret === undefined ? {} : { selection: { anchor: caret } }), annotations: isolateHistory.of('full') });
  view.focus();
}

function headingSource(text: string, level: number): string {
  if (!level) return text;
  const style = freezeMarkdownPreferences(store.prefs).headingStyle;
  if (level <= 2 && (style === 1 || style === 3)) return text + '\n' + (level === 1 ? '=' : '-').repeat(style === 1 ? 3 : Math.max(3, [...text].length));
  return '#'.repeat(level) + ' ' + text + (style === 2 ? ' ' + '#'.repeat(level) : '');
}

export function changeHeadingLevel(view: EditorView, delta: number): void {
  if (view.state.selection.ranges.length === 1) {
    const state = view.state;
    let node = syntaxTree(state).resolveInner(state.selection.main.head, -1);
    while (node.parent && !/^SetextHeading[12]$/.test(node.name)) node = node.parent;
    if (/^SetextHeading[12]$/.test(node.name)) {
      const current = Number(node.name.slice(-1));
      if (!delta || current === 1 && delta > 0) return;
      const next = current - Math.sign(delta);
      const body = state.doc.lineAt(node.from);
      view.dispatch({ selection: { anchor: Math.min(state.selection.main.head, body.to) } });
      setHeading(view, next);
      return;
    }
  }
  eachSelectedLine(view, (text) => {
    if (text.trim() === '') return null;
    const m = /^\s{0,3}(#{1,6})\s+/.exec(text);
    const current = m ? m[1].length : 0;
    // Typora treats a paragraph as the level below H6. Raising H1 is a no-op.
    if (current === 0 && delta < 0 || current === 1 && delta > 0 || delta === 0) return null;
    const next = current === 0 ? 6 : current - Math.sign(delta);
    const stripped = text.replace(/^\s{0,3}#{1,6}\s+/, '');
    if (next === 7) return stripped;
    return headingSource(stripped, next);
  });
}

export function toggleQuote(view: EditorView): void {
  const { state } = view;
  let allQuoted = true;
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1)).number; n++) {
      const t = state.doc.line(n).text;
      if (t.trim() !== '' && !/^\s*>/.test(t)) {
        allQuoted = false;
        break;
      }
    }
  }
  eachSelectedLine(view, (text) => {
    if (text.trim() === '') return allQuoted ? text.replace(/^\s*> ?/, '') : '>' + markerSpace('>', state.doc.toString());
    if (!allQuoted) return '>' + markerSpace('>', state.doc.toString()) + text;
    const padding = markerSpace('>', state.doc.toString());
    return text.replace(new RegExp(`^(\\s*)>(?:${padding === '\t' ? '\\t' : ` {${padding.length}}`}|[ \\t]?)`), '$1');
  });
}

type ListKind = 'bullet' | 'ordered' | 'task';

export function toggleList(view: EditorView, kind: ListKind): void {
  const { state } = view;
  const markerOf = (i: number) => {
    const prefs = freezeMarkdownPreferences(store.prefs);
    const marker = kind === 'ordered' ? `${prefs.olStyle === 1 ? 1 : i + 1}.` : ['-', '+', '*'][prefs.ulStyle];
    return marker + markerSpace(marker, state.doc.toString()) + (kind === 'task' ? '[ ] ' : '');
  };
  const stripRe = /^(\s*)(?:[-+*]|\d+[.)])(?:\s+\[[ xX]\])?\s+/;
  let allMarked = true;
  let count = 0;
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1)).number; n++) {
      const t = state.doc.line(n).text;
      if (t.trim() === '') continue;
      count++;
      const m = stripRe.exec(t);
      const matchesKind =
        m &&
        ((kind === 'bullet' && /^[-+*]\s/.test(m[0].trim()) && !/\[/.test(m[0])) ||
          (kind === 'ordered' && /^\d/.test(m[0].trim())) ||
          (kind === 'task' && /\[[ xX]\]/.test(m[0])));
      if (!matchesKind) allMarked = false;
    }
  }
  let i = 0;
  eachSelectedLine(view, (text) => {
    if (text.trim() === '') return null;
    const m = stripRe.exec(text);
    if (allMarked) {
      // remove this kind of marker (keep other structure)
      return text.replace(stripRe, '$1');
    }
    const indent = /^\s*/.exec(text)![0];
    const body = m ? text.slice(m[0].length) : text.slice(indent.length);
    const marker = markerOf(i);
    i++;
    return indent + marker + body;
  });
  void count;
}

export function insertCodeFence(view: EditorView): void {
  wrapBlock(view, '```' + defaultCodeLanguage(view.state.doc.toString(), 2), '```');
}

function defaultCodeLanguage(source: string, origin: 1 | 2): string {
  const prefs = freezeMarkdownPreferences(store.prefs);
  if (!(prefs.defaultCodeLangOption & origin)) return '';
  if (prefs.defaultCodeLang !== '__LAST') return prefs.defaultCodeLang;
  return [...source.matchAll(/^ {0,3}(?:`{3,}|~{3,})([\w+#.-]+)\s*$/gm)].at(-1)?.[1] ?? '';
}

export function insertCodeFenceLanguage(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const line = state.doc.lineAt(state.selection.main.head);
  if (state.selection.main.head !== line.to || !/^ {0,3}(?:`{3,}|~{3,})$/.test(line.text)) return false;
  // A later fence closes an existing block; only opening fences get a language.
  const prior = state.doc.sliceString(0, line.from).match(/^ {0,3}(?:`{3,}|~{3,})/gm)?.length ?? 0;
  if (prior % 2) return false;
  const language = defaultCodeLanguage(state.doc.toString(), 1);
  if (!language) return false;
  view.dispatch({ changes: { from: line.to, insert: language + '\n' }, selection: { anchor: line.to + language.length + 1 }, userEvent: 'input.type' });
  return true;
}

export function insertMathBlock(view: EditorView): void {
  wrapBlock(view, '$$', '$$');
}

function wrapBlock(view: EditorView, open: string, close: string): void {
  const { state } = view;
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1));
  const selected = state.sliceDoc(startLine.from, endLine.to);
  const insert = `${open}\n${selected}\n${close}\n`;
  const anchor = startLine.from + open.length + 1;
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert },
    selection: selected.trim()
      ? { anchor: startLine.from + insert.length }
      : { anchor },
  });
  view.focus();
}

// --- insertions -------------------------------------------------------------

export function insertTableMd(view: EditorView, rows: number, cols: number, header = true): void {
  const { state } = view;
  const pos = state.selection.main.from;
  const line = state.doc.lineAt(pos);
  const headerCells = Array.from({ length: cols }, (_, i) => ` Column ${i + 1} `).join('|');
  const delim = Array.from({ length: cols }, () => ' --- ').join('|');
  const bodyRow = Array.from({ length: cols }, () => '      ').join('|');
  const parts: string[] = [];
  if (header) {
    parts.push(`|${headerCells}|`, `|${delim}|`);
    for (let r = 0; r < rows; r++) parts.push(`|${bodyRow}|`);
  } else {
    for (let r = 0; r < rows; r++) parts.push(`|${bodyRow}|`);
  }
  const onBlankLine = line.text.trim() === '';
  const at = onBlankLine ? pos : line.to;
  const insert = (onBlankLine ? '' : '\n\n') + parts.join('\n') + '\n';
  const firstCell = insert.indexOf('Column 1');
  view.dispatch({
    changes: { from: at, to: at, insert },
    selection: firstCell >= 0 ? { anchor: at + firstCell } : { anchor: at + insert.length },
    scrollIntoView: true,
  });
  view.focus();
}

export function insertLinkMd(view: EditorView, text: string, href: string, title = ''): void {
  const { state } = view;
  const range = state.selection.main;
  const label = text || state.sliceDoc(range.from, range.to) || href;
  const insert = `[${label}](${href}${title ? ` "${title}"` : ''})`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
  });
  view.focus();
}

export function insertImageMd(view: EditorView, alt: string, src: string, title = ''): void {
  const { state } = view;
  const range = state.selection.main;
  const insert = `![${alt}](${src}${title ? ` "${title}"` : ''})`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
    scrollIntoView: true,
  });
  view.focus();
}

export function insertHorizontalRule(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const prefix = line.text.trim() === '' ? '' : '\n';
  const insert = `${prefix}---\n`;
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + insert.length },
    scrollIntoView: true,
  });
  view.focus();
}

export function insertFootnote(view: EditorView): void {
  const { state } = view;
  const existing = new Set<number>();
  const re = /\[\^(\d+)\]/g;
  let m: RegExpExecArray | null;
  const text = state.doc.toString();
  while ((m = re.exec(text))) existing.add(Number(m[1]));
  let n = 1;
  while (existing.has(n)) n++;
  const range = state.selection.main;
  const ref = `[^${n}]`;
  const docEnd = state.doc.length;
  const lastLine = state.doc.line(state.doc.lines);
  const sep = lastLine.text.trim() === '' ? '' : '\n\n';
  view.dispatch({
    changes: [
      { from: range.from, to: range.to, insert: ref },
      { from: docEnd, insert: `${sep}[^${n}]: ` },
    ],
    selection: { anchor: docEnd + sep.length + ref.length + 2 },
    scrollIntoView: true,
  });
  view.focus();
}

export function indentSelection(view: EditorView): void {
  if (inCode(view.state, view.state.selection.main.head, false)) eachSelectedLine(view, text => ' '.repeat(freezeMarkdownPreferences(store.prefs).codeIndentSize) + text);
  else if (selectedStructure(view)) eachSelectedLine(view, text => documentIndent(view.state.doc.toString()) + text);
  else indentMore(view);
  view.focus();
}

export function outdentSelection(view: EditorView): void {
  if (inCode(view.state, view.state.selection.main.head, false)) {
    const size = freezeMarkdownPreferences(store.prefs).codeIndentSize;
    eachSelectedLine(view, text => text.replace(new RegExp(`^(?:\\t| {1,${size}})`), ''));
  } else if (selectedStructure(view)) {
    const unit = documentIndent(view.state.doc.toString());
    eachSelectedLine(view, text => text.startsWith('\t') ? text.slice(1) : text.replace(new RegExp(`^ {1,${unit === '\t' ? 2 : unit.length}}`), ''));
  } else indentLess(view);
  view.focus();
}

function selectedStructure(view: EditorView): boolean {
  return view.state.selection.ranges.some(range => {
    for (let n = view.state.doc.lineAt(range.from).number; n <= view.state.doc.lineAt(range.to).number; n++) {
      const line = view.state.doc.line(n);
      if (!inCode(view.state, line.from + line.text.search(/\S|$/), false) && /^[ \t]*(?:>|[-+*]\s|\d+[.)]\s)/.test(line.text)) return true;
    }
    return false;
  });
}

export function duplicateLine(view: EditorView): void {
  const { state } = view;
  const changes: { from: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1)).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      changes.push({ from: line.to, insert: '\n' + line.text });
    }
  }
  view.dispatch({ changes });
  view.focus();
}

export async function pastePlainText(view: EditorView): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    const range = view.state.selection.main;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: range.from + text.length },
    });
  } catch {
    // clipboard unavailable; ignore
  }
  view.focus();
}
