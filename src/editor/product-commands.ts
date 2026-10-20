// Additional Typora paragraph commands. Source is the only editing authority.
import { EditorSelection, Text, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { parser as markdownParser, GFM } from '@lezer/markdown';
import { registerCommand } from '../commands';
import { scanProductMarkdown, normalizeReferenceLabel } from './product-markdown';

export const PRODUCT_COMMAND_NAMES = [
  'yamlFrontMatter', 'toc', 'insertParagraphAbove', 'insertParagraphBelow',
  'linkReference', 'linkReferenceDefinition', 'comment',
  'toggleTaskState', 'taskChecked', 'taskUnchecked',
  'alertNote', 'alertTip', 'alertImportant', 'alertWarning', 'alertCaution',
] as const;

// Text positions always count a line break as one unit, even for CRLF files.
const sourceText = (value: string): Text => Text.of(value.split('\n'));
const slice = (state: EditorState, from: number, to: number) => state.doc.sliceString(from, to, '\n');

function canEdit(view: EditorView): boolean {
  const active = view.dom.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement)) return true;
  if (active.closest('#overlays, .dialog, .quick-open')) return false;
  if (active.tagName === 'BUTTON' && !view.dom.contains(active)) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return false;
  if (active !== view.contentDOM && active.closest('[class*="lp-"]')) return false;
  return !active.isContentEditable || active === view.contentDOM || view.contentDOM.contains(active) && !active.closest('[contenteditable="true"]:not(.cm-content)');
}

function dispatch(view: EditorView, spec: TransactionSpec): void {
  view.dispatch({ ...spec, annotations: isolateHistory.of('full'), scrollIntoView: true });
  view.focus();
}

function selectedLines(state: EditorState): number[] {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1)).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

// Locate literal blocks first so an empty line inside a fence never splits it.
function literalBlocks(state: EditorState): { first: number; last: number }[] {
  const blocks: { first: number; last: number }[] = [];
  const first = state.doc.line(1).text.replace(/^\uFEFF/, '');
  let from = 1;
  if (first === '---') {
    let last = state.doc.lines;
    for (let n = 2; n <= state.doc.lines; n++) {
      if (/^(---|\.\.\.)\s*$/.test(state.doc.line(n).text)) { last = n; break; }
    }
    blocks.push({ first: 1, last });
    from = last + 1;
  }
  for (let n = from; n <= state.doc.lines; n++) {
    const match = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})/.exec(state.doc.line(n).text);
    if (!match) continue;
    const marker = match[1];
    let last = state.doc.lines;
    const close = new RegExp('^[ \\t]*(?:>[ \\t]*)*' + marker[0] + '{' + marker.length + ',}[ \\t]*$');
    for (let end = n + 1; end <= state.doc.lines; end++) {
      if (close.test(state.doc.line(end).text)) { last = end; break; }
    }
    blocks.push({ first: n, last });
    n = last;
  }
  return blocks;
}

function blockBounds(state: EditorState, at: number): { first: number; last: number; from: number; to: number } {
  const line = state.doc.lineAt(at);
  const literals = literalBlocks(state);
  const literal = literals.find(block => line.number >= block.first && line.number <= block.last);
  let first = literal?.first ?? line.number;
  let last = literal?.last ?? line.number;
  const boundary = (text: string) => /^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-*_][ \t]*){3,}$|\[(?:TOC|toc)\]\s*$|\[[^\]]+\]:)/.test(text);
  const quote = /^[ \t]*>/.test(line.text);
  const adjacent = (n: number) => {
    const text = state.doc.line(n).text;
    return !!text.trim() && !boundary(text) && !literals.some(block => n >= block.first && n <= block.last) && (!quote || /^[ \t]*>/.test(text));
  };
  if (!literal && line.text.trim() && !boundary(line.text)) {
    while (first > 1 && adjacent(first - 1)) first--;
    while (last < state.doc.lines && adjacent(last + 1)) last++;
  }
  return { first, last, from: state.doc.line(first).from, to: state.doc.line(last).to };
}

function yamlFrontMatter(view: EditorView): void {
  const { state } = view;
  const bom = state.doc.line(1).text.startsWith('\uFEFF') ? 1 : 0;
  if (state.doc.line(1).text.slice(bom) === '---') {
    // An incomplete metadata block is also kept intact.
    const anchor = state.doc.lines > 1 ? state.doc.line(2).from : state.doc.line(1).to;
    dispatch(view, { selection: { anchor } });
    return;
  }
  dispatch(view, {
    changes: { from: bom, insert: sourceText('---\n\n---\n\n') },
    selection: { anchor: bom + 4 },
  });
}

function insertParagraph(view: EditorView, above: boolean): void {
  const { state } = view;
  const block = blockBounds(state, state.selection.main.head);
  const adjacent = above ? block.first - 1 : block.last + 1;
  if (adjacent > 0 && adjacent <= state.doc.lines && !state.doc.line(adjacent).text.trim()) {
    dispatch(view, { selection: { anchor: state.doc.line(adjacent).from } });
    return;
  }
  const at = above ? block.from : block.to;
  dispatch(view, {
    changes: { from: at, insert: sourceText('\n\n') },
    selection: { anchor: above ? at : at + 2 },
  });
}

function insertBlock(view: EditorView, body: string, selectOffset = body.length, selectLength = 0): void {
  const { state } = view;
  const block = blockBounds(state, state.selection.main.head);
  const blank = block.from === block.to || !slice(state, block.from, block.to).trim();
  const at = blank ? state.doc.lineAt(state.selection.main.head).from : block.to;
  const before = slice(state, Math.max(0, at - 2), at);
  const after = slice(state, at, Math.min(state.doc.length, at + 2));
  const prefix = !at || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const suffix = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const insert = prefix + body + suffix;
  const anchor = at + prefix.length + selectOffset;
  dispatch(view, { changes: { from: at, insert: sourceText(insert) }, selection: { anchor, head: anchor + selectLength } });
}

function nextReference(state: EditorState): string {
  const labels = scanProductMarkdown(state.doc.toString()).references;
  let name = 'ref';
  for (let n = 2; Object.hasOwn(labels, normalizeReferenceLabel(name)); n++) name = `ref-${n}`;
  return name;
}

function linkReference(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const label = slice(state, range.from, range.to) || 'link';
  const reference = nextReference(state);
  const inline = `[${label}][${reference}]`;
  const tail = slice(state, Math.max(0, state.doc.length - 2), state.doc.length);
  const separator = !state.doc.length ? '\n\n' : tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n';
  const definition = `${separator}[${reference}]: URL`;
  const replacedLength = range.to - range.from;
  const urlAt = state.doc.length + inline.length - replacedLength + separator.length + reference.length + 4;
  // Use two ordered edits. CM handles coincident insertion points at EOF.
  dispatch(view, {
    changes: [
      { from: range.from, to: range.to, insert: sourceText(inline) },
      { from: state.doc.length, insert: sourceText(definition) },
    ],
    selection: { anchor: urlAt, head: urlAt + 3 },
  });
}

function comment(view: EditorView): void {
  const { state } = view;
  const result = state.changeByRange(range => {
    let from = range.from, to = range.to;
    if (range.empty && state.selection.ranges.length === 1) {
      const line = state.doc.lineAt(from);
      from = line.from; to = line.to;
    }
    const text = slice(state, from, to);
    if (text.startsWith('<!--') && text.endsWith('-->')) {
      const inner = text.slice(4, -3);
      return { changes: { from, to, insert: sourceText(inner) }, range: EditorSelection.range(from, from + inner.length) };
    }
    if (from >= 4 && slice(state, from - 4, from) === '<!--' && slice(state, to, to + 3) === '-->') {
      return { changes: [{ from: from - 4, to: from }, { from: to, to: to + 3 }], range: EditorSelection.range(from - 4, to - 4) };
    }
    return { changes: { from, to, insert: sourceText(`<!--${text}-->`) }, range: EditorSelection.range(from + 4, to + 4) };
  });
  dispatch(view, result);
}

const taskParser = markdownParser.configure(GFM);

function taskState(view: EditorView, checked?: boolean): void {
  const { state } = view;
  const specialBlocks = scanProductMarkdown(state.doc.toString()).specialBlocks;
  // Ignore a file BOM for block parsing while retaining every source offset.
  const tree = taskParser.parse(state.doc.toString().replace(/^\uFEFF/, ' '));
  const items: { from: number; to: number; line: number; at: number; checked: boolean }[] = [];
  tree.iterate({ enter(node) {
    if (node.name !== 'ListItem') return;
    const marker = node.node.getChild('Task')?.getChild('TaskMarker');
    if (!marker) return;
    const line = state.doc.lineAt(marker.from).number;
    if (specialBlocks.some(block => marker.from >= block.from && marker.from < block.to)) return false;
    items.push({ from: node.from, to: node.to, line, at: marker.from + 1, checked: slice(state, marker.from + 1, marker.from + 2) !== ' ' });
  } });
  const tasks: typeof items = [];
  const add = (task: typeof items[number] | undefined) => {
    if (task && !tasks.some(existing => existing.at === task.at)) tasks.push(task);
  };
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1)).number;
    // A task owns its continuation paragraphs. Resolve the smallest containing
    // list item instead of searching backward across unrelated Markdown blocks.
    const starting = items.filter(item => item.line === first || item.from <= range.from && range.from <= item.to)
      .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
    let literal = specialBlocks.some(block => range.from >= block.from && range.from < block.to);
    for (let node = tree.resolveInner(range.from, 1); node; node = node.parent!) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'HTMLBlock') literal = true;
    }
    if (!literal) add(starting);
    if (!range.empty) for (const item of items) if (item.line >= first && item.line <= last) add(item);
  }
  // Typora uses the starting task's state for the whole selected task range.
  const target = checked ?? !tasks[0]?.checked;
  const changes = tasks.filter(task => task.checked !== target).map(task => ({ from: task.at, to: task.at + 1, insert: target ? 'x' : ' ' }));
  if (changes.length) dispatch(view, { changes });
}

function alert(view: EditorView, kind: string): void {
  const { state } = view;
  const numbers = selectedLines(state);
  const changes: ChangeSpec[] = [];
  const converted = new Set<number>();
  const plain: number[] = [];
  for (const n of numbers) {
    const line = state.doc.line(n);
    const bounds = blockBounds(state, line.from);
    let marker = 0;
    if (/^[ \t]*>/.test(line.text)) {
      // All lines in one quoted block share its alert marker.
      for (let m = n; m >= bounds.first && /^[ \t]*>/.test(state.doc.line(m).text); m--) {
        if (/^[ \t]*(?:>[ \t]*)+\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]|$)/i.test(state.doc.line(m).text)) { marker = m; break; }
      }
    }
    if (marker) {
      if (converted.has(marker)) continue;
      converted.add(marker);
      const markerLine = state.doc.line(marker);
      const match = /\[!([A-Z]+)\]/i.exec(markerLine.text)!;
      if (match[1].toUpperCase() === kind) {
        if (/^[ \t]*(?:>[ \t]*)+\[![A-Z]+\][ \t]*$/i.test(markerLine.text) && marker < state.doc.lines) {
          changes.push({ from: markerLine.from, to: state.doc.line(marker + 1).from, insert: '' });
        } else changes.push({ from: markerLine.from + match.index, to: markerLine.from + match.index + match[0].length, insert: '' });
      } else changes.push({ from: markerLine.from + match.index, to: markerLine.from + match.index + match[0].length, insert: `[!${kind}]` });
    } else plain.push(n);
  }
  if (!converted.size && state.selection.ranges.every(range => range.empty)) {
    insertBlock(view, `> [!${kind}]\n> `);
    return;
  }
  for (let index = 0; index < plain.length;) {
    const first = plain[index];
    let last = first;
    while (++index < plain.length && plain[index] === last + 1) last = plain[index];
    const rows = Array.from({ length: last - first + 1 }, (_, i) => state.doc.line(first + i).text);
    const quoted = rows.every(row => /^[ \t]*>/.test(row));
    const prefix = quoted ? /^[ \t]*(?:>[ \t]*)+/.exec(rows[0])![0] : '> ';
    const insert = `${prefix}[!${kind}]\n` + rows.map(row => quoted ? row : '> ' + row).join('\n');
    changes.push({ from: state.doc.line(first).from, to: state.doc.line(last).to, insert: sourceText(insert) });
  }
  if (changes.length) dispatch(view, { changes });
}

export function registerProductCommands(view: EditorView): void {
  const register = (name: string, action: () => void) => registerCommand(name, () => { if (canEdit(view)) action(); });
  register('yamlFrontMatter', () => yamlFrontMatter(view));
  register('toc', () => insertBlock(view, '[TOC]', 7));
  register('insertParagraphAbove', () => insertParagraph(view, true));
  register('insertParagraphBelow', () => insertParagraph(view, false));
  register('linkReference', () => linkReference(view));
  register('linkReferenceDefinition', () => {
    const label = nextReference(view.state);
    insertBlock(view, `[${label}]: URL`, label.length + 4, 3);
  });
  register('comment', () => comment(view));
  register('toggleTaskState', () => taskState(view));
  register('taskChecked', () => taskState(view, true));
  register('taskUnchecked', () => taskState(view, false));
  for (const kind of ['Note', 'Tip', 'Important', 'Warning', 'Caution']) register(`alert${kind}`, () => alert(view, kind.toUpperCase()));
}
