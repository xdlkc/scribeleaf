// Live preview: hides Markdown tokens outside the active selection and renders
// inactive table/math/diagram/image blocks as widgets. Source text is never
// modified — everything is a CodeMirror decoration, so source/live switches
// and IME input are lossless by construction.

import { EditorState, Range, StateEffect, StateField, Text } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { parser as markdownParser, GFM } from '@lezer/markdown';
import { store } from '../store';
import { freezeMarkdownPreferences, smartPunctuation, remapMarkdownPunctuation } from '../markdown-preferences';
import { openExternal } from '../bridge';
import { scanProductMarkdown, normalizeReferenceLabel, type ProductMarkdownScan } from './product-markdown';
import './product-markdown.css';
import {
  AlertTitleWidget,
  ProductBlockWidget,
  CheckboxWidget,
  FootnoteWidget,
  parseImageMarkdown,
  HrWidget,
  ImageWidget,
  InlineMathWidget,
  MathBlockWidget,
  MermaidWidget,
  TableWidget,
  WidgetContext,
} from './widgets';

export const refreshLivePreviewEffect = StateEffect.define<null>();

export function refreshLivePreview(view: EditorView): void {
  view.dispatch({ effects: refreshLivePreviewEffect.of(null) });
}

// ---------------------------------------------------------------------------
// Block scanning (selection independent, cached until the document changes)

interface BlockInfo {
  type: 'code' | 'math' | 'table';
  from: number; // first line start
  to: number; // last line end
  lang: string;
  closed?: boolean;
  openFrom: number; // opening fence line start
  openTo: number; // opening fence line end
  closeFrom: number; // closing fence line start
  closeTo: number; // closing fence line end
  contentFrom: number;
  contentTo: number;
}

interface Marker {
  from: number;
  to: number;
  kind: 'bullet' | 'quote' | 'number';
  level?: number;
}

interface LineInfo {
  from: number;
  to: number;
  classes: string[];
  markers: Marker[];
  hr: boolean;
  checkbox?: { from: number; checked: boolean };
}

interface ScanResult {
  blocks: BlockInfo[];
  lines: LineInfo[];
  product: ProductMarkdownScan;
}

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const HR_RE = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const FOOTNOTE_DEF_RE = /^\[\^[^\]]+\]:/;
const MATH_OPEN_RE = /^\s*\$\$(.*)$/;
const TABLE_DELIM_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$/;
const structuralParser = markdownParser.configure(GFM);

function isTableDelim(text: string): boolean {
  return TABLE_DELIM_RE.test(text) && text.includes('-');
}

function scanBlocks(doc: Text): ScanResult {
  const prefs = freezeMarkdownPreferences(store.prefs);
  const cacheKey = JSON.stringify(prefs);
  const cached = scanCache.get(doc)?.get(cacheKey);
  if (cached) return cached;
  const blocks: BlockInfo[] = [];
  const lines: LineInfo[] = [];
  const product = scanProductMarkdown(doc.toString(), prefs);
  const skipLines = new Set<number>(); // 1-based lines inside code/math blocks
  const listMarkers = new Map<number, Marker[]>();
  const taskMarkers = new Map<number, { from: number; checked: boolean }>();
  const literalLines = new Set<number>();
  // The Markdown tree knows where quote/list prefixes end, and excludes list
  // examples inside fenced or indented code. Keep its original source offsets.
  structuralParser.parse(remapMarkdownPunctuation(doc.toString(), prefs).replace(/^\uFEFF/, ' ')).iterate({ enter(node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'HTMLBlock') {
      for (let n = doc.lineAt(node.from).number; n <= doc.lineAt(node.to).number; n++) literalLines.add(n);
      return false;
    }
    if (node.name === 'ListMark') {
      const line = doc.lineAt(node.from);
      const marker = doc.sliceString(node.from, node.to);
      let level = -1;
      for (let parent = node.node.parent; parent; parent = parent.parent) {
        if (parent.name === 'BulletList' || parent.name === 'OrderedList') level++;
      }
      const markers = listMarkers.get(line.number) ?? [];
      markers.push({ from: node.from, to: node.to, kind: /^\d/.test(marker) ? 'number' : 'bullet', level: Math.max(0, level) });
      listMarkers.set(line.number, markers);
    } else if (node.name === 'TaskMarker') {
      taskMarkers.set(doc.lineAt(node.from).number, { from: node.from, checked: doc.sliceString(node.from + 1, node.from + 2) !== ' ' });
    }
  } });

  // Product blocks must not be mistaken for setext headings or horizontal rules.
  for (const block of product.specialBlocks) {
    for (let k = doc.lineAt(block.from).number; k <= doc.lineAt(block.to).number; k++) {
      const line = doc.line(k);
      if (block.type !== 'comment' || (line.from >= block.from && line.to <= block.to)) skipLines.add(k);
    }
  }

  let i = 1;
  const n = doc.lines;
  while (i <= n) {
    const line = doc.line(i);
    const text = line.text;
    if (skipLines.has(i)) { i++; continue; }

    // --- fenced code block ---
    const fence = FENCE_RE.exec(text);
    if (fence) {
      const marker = fence[2];
      const ch = marker[0];
      const info = fence[3].trim();
      const lang = info.split(/\s+/)[0] ?? '';
      const closeRe = new RegExp(
        '^\\s{0,3}' + (ch === '`' ? '`' : '~') + '{' + marker.length + ',}\\s*$',
      );
      let j = i + 1;
      let closed = false;
      while (j <= n) {
        if (closeRe.test(doc.line(j).text)) {
          closed = true;
          break;
        }
        j++;
      }
      const endLine = closed ? j : n;
      const last = doc.line(endLine);
      const contentFrom = Math.min(line.to + 1, doc.length);
      const contentTo = closed ? doc.line(Math.max(j - 1, i)).to : last.to;
      blocks.push({
        type: lang.toLowerCase() === 'math' && prefs.gitlabMath ? 'math' : 'code',
        from: line.from,
        to: last.to,
        lang,
        closed,
        openFrom: line.from,
        openTo: line.to,
        closeFrom: closed ? doc.line(j).from : last.from,
        closeTo: closed ? doc.line(j).to : last.to,
        contentFrom,
        contentTo: Math.max(contentFrom, contentTo),
      });
      for (let k = i; k <= endLine; k++) skipLines.add(k);
      // content lines (between the fences) get the code block styling
      const contentEnd = closed ? j - 1 : endLine;
      for (let k = i + 1; k <= contentEnd; k++) {
        const l = doc.line(k);
        const classes = ['cm-codeblock-line'];
        if (k === i + 1) classes.push('cm-codeblock-first');
        if (k === contentEnd) classes.push('cm-codeblock-last');
        lines.push({ from: l.from, to: l.to, classes, markers: [], hr: false });
      }
      i = endLine + 1;
      continue;
    }

    // --- display math $$...$$ ---
    const legacyDisplay = !prefs.noLegacyMath && /^\s*\\\[(.*)$/.exec(text);
    const mathDelimiter = legacyDisplay ? '\\[' : '$$';
    const mathCloseDelimiter = legacyDisplay ? '\\]' : '$$';
    const mathOpen = MATH_OPEN_RE.exec(text) || legacyDisplay;
    if (mathOpen) {
      const rest = mathOpen[1];
      const singleInline = (legacyDisplay ? /^(.*\S)\\\]\s*$/ : /^(.*\S)\$\$\s*$/).exec(rest);
      if (singleInline && singleInline[1].trim().length > 0) {
        // $$ tex $$ on one line
        const texFrom = line.from + text.indexOf(mathDelimiter) + 2;
        const texTo = line.to - (text.length - text.lastIndexOf(mathCloseDelimiter));
        blocks.push({
          type: 'math',
          from: line.from,
          to: line.to,
          lang: '',
          openFrom: line.from,
          openTo: line.from + text.indexOf(mathDelimiter) + 2,
          closeFrom: line.from + text.lastIndexOf(mathCloseDelimiter),
          closeTo: line.to,
          contentFrom: texFrom,
          contentTo: texTo,
        });
        skipLines.add(i);
        i++;
        continue;
      }
      // multi-line: opening line may carry content after $$
      let j = i;
      let closeFrom = -1;
      let closeContentTo = -1;
      while (true) {
        j++;
        if (j > n) break;
        const t = doc.line(j).text;
        const m = (legacyDisplay ? /^(.*?)\\\]\s*$/ : /^(.*?)\$\$\s*$/).exec(t);
        if (m && (j > i + 0)) {
          // ensure the $$ we found is not the opening one (j>i always true here)
          closeFrom = doc.line(j).from + m[1].length;
          closeContentTo = closeFrom;
          break;
        }
      }
      const closed = closeFrom >= 0;
      const endLine = closed ? j : n;
      const last = doc.line(endLine);
      const firstContentFrom = line.from + text.indexOf(mathDelimiter) + 2;
      blocks.push({
        type: 'math',
        from: line.from,
        to: last.to,
        lang: '',
        openFrom: line.from,
        openTo: firstContentFrom,
        closeFrom: closed ? closeFrom : last.to,
        closeTo: closed ? doc.line(j).to : last.to,
        contentFrom: firstContentFrom,
        contentTo: closed ? closeContentTo : last.to,
      });
      for (let k = i; k <= endLine; k++) skipLines.add(k);
      i = endLine + 1;
      continue;
    }

    // --- GFM table ---
    if (text.includes('|') && i < n) {
      const nextText = doc.line(i + 1).text;
      if (isTableDelim(nextText)) {
        let j = i + 2;
        while (j <= n) {
          const t = doc.line(j).text;
          if (t.trim() === '' || !t.includes('|')) break;
          j++;
        }
        const last = doc.line(j - 1);
        blocks.push({
          type: 'table',
          from: line.from,
          to: last.to,
          lang: '',
          openFrom: line.from,
          openTo: line.to,
          closeFrom: last.from,
          closeTo: last.to,
          contentFrom: line.from,
          contentTo: last.to,
        });
        for (let k = i; k <= j - 1; k++) skipLines.add(k);
        i = j;
        continue;
      }
    }

    i++;
  }

  // --- per-line info outside code/math blocks ---
  for (let k = 1; k <= n; k++) {
    if (skipLines.has(k) || literalLines.has(k)) continue;
    const line = doc.line(k);
    const text = line.text;
    const info: LineInfo = { from: line.from, to: line.to, classes: [], markers: [], hr: false };
    if (text.length === 0) info.classes.push('cm-blank-line');

    if (HR_RE.test(text)) {
      info.hr = true;
      lines.push(info);
      continue;
    }

    if (FOOTNOTE_DEF_RE.test(text)) {
      info.classes.push('cm-footnote-def');
    }

    // blockquote markers (possibly nested)
    const mappedText = remapMarkdownPunctuation(text, prefs);
    const quoteMatch = /^[ \t]*(?:>[ \t]*)+/.exec(k === 1 ? mappedText.replace(/^\uFEFF/, ' ') : mappedText);
    if (quoteMatch) {
      info.classes.push('cm-quote');
      // Match offsets once. Advancing for both a marker's spaces and the same
      // spaces in a character loop can move the next marker over the newline.
      for (const marker of quoteMatch[0].matchAll(/>[ \t]*/g)) {
        const from = line.from + marker.index;
        info.markers.push({ from, to: from + marker[0].length, kind: 'quote' });
      }
    }

    const task = taskMarkers.get(k);
    if (task) {
      info.classes.push('cm-task-line');
      info.checkbox = task;
      // continue to also treat the list marker below
    }

    const markers = listMarkers.get(k);
    if (markers?.length) {
      info.classes.push('cm-list-line');
      if (markers.some(marker => marker.kind === 'number')) info.classes.push('cm-ol-line');
      info.markers.push(...markers);
    }

    if (info.classes.length || info.markers.length || info.checkbox) lines.push(info);
  }

  const scan = { blocks, lines, product };
  const variants = scanCache.get(doc) ?? new Map<string, ScanResult>();
  if (variants.size > 16) variants.clear();
  variants.set(cacheKey, scan);
  scanCache.set(doc, variants);
  return scan;
}

// Text is immutable. Selection-only transactions reuse this object, so moving
// the caret never reparses the complete Markdown document.
const scanCache = new WeakMap<Text, Map<string, ScanResult>>();

// ---------------------------------------------------------------------------
// Decoration building

const bulletWidget = (level: number) =>
  new (class extends WidgetType {
    eq(o: WidgetType): boolean {
      return 'lvl' in o && o.lvl === level;
    }
    readonly lvl = level;
    toDOM(): HTMLElement {
      const s = document.createElement('span');
      s.className = 'cm-list-bullet';
      s.textContent = level % 3 === 1 ? '◦' : level % 3 === 2 ? '▪' : '•';
      return s;
    }
    ignoreEvent(): boolean {
      return false;
    }
  })();

function selectionIntersects(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && from <= r.to) return true;
  }
  return false;
}

class TextMarkerWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string) { super(); }
  eq(other: TextMarkerWidget) { return other.text === this.text && other.className === this.className; }
  toDOM(): HTMLElement { const span = document.createElement('span'); span.className = this.className; span.textContent = this.text; return span; }
}

class BreakMarkerWidget extends WidgetType {
  constructor(readonly visible: boolean) { super(); }
  eq(other: BreakMarkerWidget) { return other.visible === this.visible; }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    if (this.visible) { const mark = document.createElement('span'); mark.className = 'cm-br-mark'; mark.textContent = '<br/>'; span.append(mark); }
    span.append(document.createElement('br')); return span;
  }
}

function buildDecorations(view: EditorView, scan: ScanResult): DecorationSet {
  const state = view.state;
  const ctx: WidgetContext = {
    view,
    baseDir: store.docBase,
    theme: store.prefs.theme,
    markdownPreferences: freezeMarkdownPreferences(store.prefs),
  };
  const decos: { from: number; to: number; value: Decoration }[] = [];
  const add = (from: number, to: number, value: Decoration) => decos.push({ from, to, value });

  const visibleFrom = Math.min(...view.visibleRanges.map((r) => r.from));
  const visibleTo = Math.max(...view.visibleRanges.map((r) => r.to));

  // Multiline replacements are supplied by blockPreviewField, before layout.

  // Alert bodies remain real editable quote lines, including nested quotes.
  for (const alert of scan.product.alertLines) {
    if (alert.to < visibleFrom || alert.from > visibleTo) continue;
    const classes = [`cm-alert-${alert.type}`, 'cm-alert'];
    if (alert.first) classes.push('cm-alert-first');
    if (alert.last) classes.push('cm-alert-last');
    add(alert.from, alert.from, Decoration.line({ class: classes.join(' ') }));
    if (alert.markerFrom != null && alert.markerTo != null) {
      add(alert.markerFrom, alert.markerTo, selectionIntersects(state, alert.from, alert.to)
        ? Decoration.mark({ class: 'cm-formatting-mark' })
        : Decoration.replace({ widget: new AlertTitleWidget(alert.type) }));
    }
  }

  // --- per-line decorations ---
  for (const li of scan.lines) {
    if (li.to < visibleFrom || li.from > visibleTo) continue;
    if (li.classes.length) {
      add(li.from, li.from, Decoration.line({ class: li.classes.join(' ') }));
      if (store.prefs.showLineNumbersForFence && li.classes.includes('cm-codeblock-line')) {
        const block = scan.blocks.find(block => block.type === 'code' && li.from >= block.contentFrom && li.to <= block.contentTo);
        if (block) add(li.from, li.from, Decoration.widget({ widget: new TextMarkerWidget(String(state.doc.lineAt(li.from).number - state.doc.lineAt(block.contentFrom).number + 1), 'cm-code-line-number'), side: -1 }));
      }
    }
    const lineActive = store.prefs.expandSimpleBlocks && selectionIntersects(state, li.from, li.to);
    if (li.hr) {
      if (!lineActive) add(li.from, li.to, Decoration.replace({ widget: new HrWidget() }));
      continue;
    }
    for (const m of li.markers) {
      if (lineActive) {
        add(m.from, m.to, Decoration.mark({ class: 'cm-formatting-mark' }));
      } else if (m.kind === 'quote') {
        add(m.from, m.to, Decoration.replace({}));
      } else if (m.kind === 'bullet') {
        add(m.from, m.to, li.checkbox ? Decoration.replace({}) : Decoration.replace({ widget: bulletWidget(m.level ?? 0) }));
      } else {
        add(m.from, m.to, li.checkbox ? Decoration.replace({}) : Decoration.mark({ class: 'cm-list-number' }));
      }
    }
    if (li.checkbox) {
      add(
        li.checkbox.from,
        li.checkbox.from + 3,
        Decoration.replace({ widget: new CheckboxWidget(li.checkbox.checked, li.checkbox.from, ctx) }),
      );
    }
  }

  // --- syntax-tree driven decorations (headings + inline styles) ---
  const inBlock = (from: number, to: number): boolean => {
    for (const b of scan.blocks) {
      if (from >= b.from && to <= b.to) return true;
    }
    for (const b of scan.product.specialBlocks) {
      if (from >= b.from && to <= b.to) return true;
    }
    return false;
  };

  const headingClasses: Record<string, string> = {
    ATXHeading1: 'cm-header-1',
    ATXHeading2: 'cm-header-2',
    ATXHeading3: 'cm-header-3',
    ATXHeading4: 'cm-header-4',
    ATXHeading5: 'cm-header-5',
    ATXHeading6: 'cm-header-6',
    SetextHeading1: 'cm-header-1',
    SetextHeading2: 'cm-header-2',
  };

  for (const vr of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: vr.from,
      to: vr.to,
      enter(node) {
        const name = node.name;
        const { from, to } = node;

        if (scan.product.specialBlocks.some(b => from >= b.from && to <= b.to)) return false;

        const hClass = headingClasses[name];
        if (hClass) {
          const line = state.doc.lineAt(from);
          add(line.from, line.from, Decoration.line({ class: hClass }));
          const active = store.prefs.expandSimpleBlocks && selectionIntersects(state, line.from, line.to);
          if (!active && name.startsWith('ATX')) {
            // hide trailing closing hashes
            const m = /\s+#+\s*$/.exec(line.text);
            if (m && line.from + m.index > from) {
              add(line.from + m.index, line.to, Decoration.replace({}));
            }
          }
          if (name.startsWith('Setext')) {
            // dim the === / --- underline line
            const lastLine = state.doc.lineAt(to);
            if (lastLine.from !== line.from) {
              add(lastLine.from, lastLine.from, Decoration.line({ class: 'cm-setext-mark' }));
            }
          }
          return;
        }

        if (name === 'HeaderMark') {
          const heading = node.node.parent?.name.includes('Heading') ? node.node.parent : null;
          const line = state.doc.lineAt(heading?.from ?? from);
          const active = store.prefs.expandSimpleBlocks && selectionIntersects(state, line.from, heading?.to ?? line.to);
          let end = to;
          if (state.doc.sliceString(end, end + 1) === ' ') end++;
          if (!active) {
            // hide leading hashes plus following space
            add(from, end, Decoration.replace({}));
          } else {
            add(from, end, Decoration.mark({ class: 'cm-formatting-mark cm-heading-mark' }));
          }
          return;
        }

        if (inBlock(from, to)) return false;
        if (name === 'Paragraph' && store.prefs.indentFirstLine) {
          let parent = node.node.parent;
          let inList = false;
          while (parent) { if (parent.name === 'ListItem') { inList = true; break; } parent = parent.parent; }
          if (!inList) add(state.doc.lineAt(from).from, state.doc.lineAt(from).from, Decoration.line({ class: 'cm-markdown-paragraph-first' }));
        }
        if (name === 'Paragraph' && store.prefs.ignoreLineBreak) {
          for (let row = state.doc.lineAt(from).number; row <= state.doc.lineAt(to).number; row++) {
            const line = state.doc.line(row);
            add(line.from, line.from, Decoration.line({ attributes: { style: 'white-space:normal' } }));
          }
        }
        if (name === 'HTMLTag' && /^<br\s*\/?>$/i.test(state.sliceDoc(from, to))) {
          add(from, to, Decoration.replace({ widget: new BreakMarkerWidget(!store.prefs.hideBrAndLineBreak) })); return false;
        }

        switch (name) {
          case 'Emphasis':
            add(from, to, Decoration.mark({ class: 'cm-em' }));
            return;
          case 'StrongEmphasis':
            add(from, to, Decoration.mark({ class: 'cm-strong' }));
            return;
          case 'Strikethrough':
            add(from, to, Decoration.mark({ class: 'cm-strike' }));
            return;
          case 'HighlightMark':
            add(from, to, Decoration.mark({ class: 'cm-highlight' }));
            return;
          case 'Subscript':
            add(from, to, Decoration.mark({ class: 'cm-sub' }));
            return;
          case 'Superscript':
            add(from, to, Decoration.mark({ class: 'cm-sup' }));
            return;
          case 'InlineCode':
            add(from, to, Decoration.mark({ class: 'cm-inline-code' }));
            return;
          case 'EmphasisMark':
          case 'StrikethroughMark':
          case 'HighlightMarkMark':
          case 'SubscriptMark':
          case 'SuperscriptMark':
          case 'CodeMark': {
            const active = selectionIntersects(state, from, to);
            if (!active) add(from, to, Decoration.replace({}));
            else add(from, to, Decoration.mark({ class: 'cm-formatting-mark' }));
            return;
          }
          case 'InlineMath': {
            const active = selectionIntersects(state, from, to);
            if (!active) {
              const raw = state.sliceDoc(from, to);
              const legacy = raw.startsWith('\\(') || raw.startsWith('\\[');
              const tex = raw.slice(legacy ? 2 : 1, legacy ? -2 : -1);
              add(from, to, Decoration.replace({ widget: new InlineMathWidget(tex, from, ctx, raw.startsWith('\\[')) }));
            } else {
              add(from, to, Decoration.mark({ class: 'cm-math-source-inline' }));
            }
            return false;
          }
          case 'Image': {
            const active = selectionIntersects(state, from, to);
            if (!active) {
              const text = state.sliceDoc(from, to);
              const image = parseImageMarkdown(text);
              if (image) add(from, to, Decoration.replace({ widget: new ImageWidget(image.src, image.alt, from, ctx) }));
            } else {
              add(from, to, Decoration.mark({ class: 'cm-image-source' }));
            }
            return false;
          }
          case 'Link': {
            if (/^\[\^[^\]\s]+\]$/.test(state.sliceDoc(from, to))) return false;
            const active = selectionIntersects(state, from, to);
            // label between first '[' and matching ']'
            let labelFrom = from + 1;
            let labelTo = to - 1;
            for (let c = node.node.firstChild; c; c = c.nextSibling) {
              if (c.name === 'LinkMark' && state.sliceDoc(c.from, c.to) === ']') {
                labelTo = c.from;
                break;
              }
            }
            const url = markdownLinkTarget(state.sliceDoc(from, to), scan.product);
            add(labelFrom, labelTo, Decoration.mark({ class: 'cm-link', attributes: url ? { 'data-href': url } : undefined }));
            for (let c = node.node.firstChild; c; c = c.nextSibling) {
              if (c.name === 'LinkMark' || c.name === 'URL' || c.name === 'LinkTitle' || c.name === 'LinkLabel') {
                if (!active) add(c.from, c.to, Decoration.replace({}));
                else add(c.from, c.to, Decoration.mark({ class: 'cm-formatting-mark' }));
              }
            }
            return false;
          }
          case 'URL': {
            // bare autolink <https://…>
            add(from, to, Decoration.mark({ class: 'cm-link' }));
            return;
          }
        }
        return;
      },
    });
  }

  // footnote references per visible line (outside blocks)
  for (const vr of view.visibleRanges) {
    let line = state.doc.lineAt(vr.from);
    while (line.from <= vr.to) {
      if (!inBlock(line.from, line.to)) {
        const re = /\[\^[^\]\s]+\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line.text))) {
          const from = line.from + m.index;
          const to = from + m[0].length;
          if (m.index === 0 && line.text[m[0].length] === ':') continue;
          add(from, to, selectionIntersects(state, from, to)
            ? Decoration.mark({ class: 'cm-footnote-ref' })
            : Decoration.replace({widget: new FootnoteWidget(m[0].slice(2, -1), from, ctx)}));
        }
      }
      if (line.number >= state.doc.lines) break;
      line = state.doc.line(line.number + 1);
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  const prefs = freezeMarkdownPreferences(store.prefs);
  if (prefs.convertSmartOnRender && (prefs.smartQuote || prefs.smartDash)) {
    const tree = syntaxTree(state);
    for (let row = state.doc.lineAt(visibleFrom).number; row <= state.doc.lineAt(visibleTo).number; row++) {
      const line = state.doc.line(row);
      for (const match of line.text.matchAll(/---?|["']/g)) {
        const from = line.from + match.index!;
        let node = tree.resolveInner(from, 1);
        let protectedText = false;
        while (node) { if (/^(?:FencedCode|CodeBlock|InlineCode|InlineMath|HTMLTag|HTMLBlock|URL|LinkTitle|Image)$/.test(node.name)) { protectedText = true; break; } node = node.parent!; }
        if (protectedText) continue;
        const opening = !match.index || /[\s([{<]/.test(line.text[match.index! - 1]);
        const value = match[0] === '"' ? prefs.smartQuote ? opening ? '“' : '”' : '"'
          : match[0] === "'" ? prefs.smartQuote ? opening ? '‘' : '’' : "'" : smartPunctuation(match[0], prefs);
        if (value !== match[0]) add(from, from + match[0].length, Decoration.replace({ widget: new TextMarkerWidget(value, 'cm-smart-punctuation') }));
      }
    }
  }
  return Decoration.set(decos as Range<Decoration>[], true);
}

// ---------------------------------------------------------------------------
// Plugin

class DeferredBlockWidget extends WidgetType {
  private inner?: WidgetType;
  constructor(readonly identity: string, readonly factory: (view: EditorView) => WidgetType, readonly height: number) { super(); }
  eq(other: DeferredBlockWidget): boolean { return this.identity === other.identity; }
  get estimatedHeight(): number { return this.height; }
  toDOM(view: EditorView): HTMLElement { this.inner = this.factory(view); return this.inner.toDOM(view); }
  updateDOM(dom: HTMLElement, view: EditorView, previous: this): boolean {
    const next = this.factory(view);
    if (!previous.inner || !next.updateDOM(dom, view, previous.inner)) return false;
    this.inner = next;
    return true;
  }
  ignoreEvent(event: Event): boolean { return this.inner?.ignoreEvent(event) ?? true; }
  destroy(dom: HTMLElement): void { this.inner?.destroy(dom); }
}

function blockDecorations(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const theme = store.prefs.theme;
  const baseDir = store.docBase;
  const add = (from: number, to: number, decoration: Decoration) => { if (to >= from) decos.push(decoration.range(from, to)); };
  const scan = scanBlocks(state.doc);
  for (const block of scan.product.specialBlocks) {
    if (selectionIntersects(state, block.from, block.to)) {
      add(block.from, block.to, Decoration.mark({ class: `cm-${block.type}-source` }));
      if (block.type === 'frontmatter') {
        for (let line = state.doc.lineAt(block.from).number; line <= state.doc.lineAt(block.to).number; line++) {
          add(state.doc.line(line).from, state.doc.line(line).from, Decoration.line({ class: 'cm-frontmatter-source-line' }));
        }
      }
      continue;
    }
    const identity = JSON.stringify([block.type, block.from, block.source,
      block.type === 'toc' ? scan.product.headings : null, theme]);
    const factory = (view: EditorView) => new ProductBlockWidget(block, scan.product.headings, { view, theme, baseDir });
    add(block.from, block.to, Decoration.replace({
      widget: new DeferredBlockWidget(identity, factory, block.type === 'toc' ? Math.max(32, scan.product.headings.length * 26) : 44),
      block: block.type !== 'comment',
    }));
  }
  let equationNumber = 0;
  const numberingPrefs = freezeMarkdownPreferences(store.prefs);
  for (const block of scan.blocks) {
    const tex = block.type === 'math' ? state.sliceDoc(block.contentFrom, block.contentTo) : '';
    const numberThis = block.type === 'math' && (numberingPrefs.autoNumberingForMath === 'all'
      || numberingPrefs.autoNumberingForMath === 'ams' && /\\begin\{(?:equation|align|gather|multline)\}/.test(tex))
      && !/\\(?:tag|notag|nonumber)\b/.test(tex);
    const equation = numberThis ? ++equationNumber : undefined;
    const active = selectionIntersects(state, block.from, block.to);
    if (block.type === 'code' && (block.lang !== 'mermaid' || !store.prefs.enableDiagram || active)) {
      if (active) {
        add(block.openFrom, block.openFrom, Decoration.line({ class: 'cm-fence-line' }));
        if (block.closeFrom !== block.openFrom) add(block.closeFrom, block.closeFrom, Decoration.line({ class: 'cm-fence-line' }));
      } else {
        // Keep line boundaries: consuming the opening newline also consumes
        // the first content line's line decoration in CodeMirror.
        add(block.openFrom, block.openFrom, Decoration.line({ class: 'cm-hidden-fence' }));
        add(block.openFrom, block.openTo, Decoration.replace({}));
        if (block.closed) {
          add(block.closeFrom, block.closeFrom, Decoration.line({ class: 'cm-hidden-fence' }));
          add(block.closeFrom, block.closeTo, Decoration.replace({}));
        }
      }
      continue;
    }
    if (active && block.type !== 'table') {
      if (block.type === 'math') add(block.from, block.to, Decoration.mark({ class: 'cm-math-source' }));
      continue;
    }
    const source = block.type === 'table' ? state.sliceDoc(block.from, block.to) : state.sliceDoc(block.contentFrom, block.contentTo);
    const identity = JSON.stringify([block.type, block.lang, block.from, source, theme, baseDir, freezeMarkdownPreferences(store.prefs), equation]);
    const factory = (view: EditorView): WidgetType => {
      const ctx = { view, theme, baseDir, markdownPreferences: freezeMarkdownPreferences(store.prefs) };
      if (block.type === 'table') return new TableWidget(source, block.from, ctx);
      if (block.type === 'math') return new MathBlockWidget(source, block.from, ctx, equation);
      return new MermaidWidget(source, block.from, ctx);
    };
    const height = block.type === 'table' ? Math.max(72, source.split('\n').length * 32) : block.type === 'math' ? 80 : 240;
    add(block.from, block.to, Decoration.replace({ widget: new DeferredBlockWidget(identity, factory, height), block: true }));
  }
  if (store.prefs.ignoreLineBreak) {
    const tree = syntaxTree(state);
    for (let row = 1; row < state.doc.lines; row++) {
      const line = state.doc.line(row);
      if (!line.text.trim() || /(?: {2,}|\\)$/.test(line.text)) continue;
      let node = tree.resolveInner(line.to, -1);
      while (node.parent && node.name !== 'Paragraph') node = node.parent;
      if (node.name === 'Paragraph' && node.to > line.to + 1) add(line.to, line.to + 1, Decoration.replace({ widget: new TextMarkerWidget(' ', '') }));
    }
  }
  return Decoration.set(decos, true);
}

const blockPreviewField = StateField.define<DecorationSet>({
  create: blockDecorations,
  update(value, transaction) {
    return transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(refreshLivePreviewEffect))
      ? blockDecorations(transaction.state) : value;
  },
  provide: field => EditorView.decorations.from(field),
});

class LivePreviewView {
  decorations: DecorationSet;
  scan: ScanResult;

  constructor(readonly view: EditorView) {
    this.scan = scanBlocks(view.state.doc);
    this.decorations = buildDecorations(view, this.scan);
  }

  update(update: ViewUpdate): void {
    const forced = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLivePreviewEffect)));
    if (update.docChanged || forced) {
      this.scan = scanBlocks(update.state.doc);
    }
    if (update.docChanged || update.selectionSet || update.viewportChanged || forced) {
      this.decorations = buildDecorations(update.view, this.scan);
    }
  }
}

export const livePreviewPlugin = [blockPreviewField, ViewPlugin.fromClass(LivePreviewView, {
  decorations: (v) => v.decorations,
  eventHandlers: {
    mousedown(e: MouseEvent, view: EditorView) {
      // Cmd/Ctrl-click opens links
      if (!(e.metaKey || e.ctrlKey)) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const tree = syntaxTree(view.state);
      let node = tree.resolveInner(pos, 0);
      while (node) {
        if (node.name === 'Link' || node.name === 'URL') {
          const text = view.state.sliceDoc(node.from, node.to);
          const scan = scanBlocks(view.state.doc);
          const url = node.name === 'URL' ? text.replace(/^<|>$/g, '') : markdownLinkTarget(text, scan.product);
          if (url) {
            e.preventDefault();
            if (url.startsWith('#')) {
              let id = url.slice(1);
              try { id = decodeURIComponent(id); } catch { /* keep literal fragment */ }
              const heading = scan.product.headings.find(heading => heading.id === id);
              if (heading) {
                view.dispatch({ selection: { anchor: heading.from }, effects: EditorView.scrollIntoView(heading.from, { y: 'center' }) });
                view.focus();
              }
            } else {
              openExternal(url);
            }
            return;
          }
        }
        node = node.parent!;
      }
    },
  },
})];

function markdownLinkTarget(source: string, scan: ProductMarkdownScan): string | undefined {
  // Markdown-it handles escapes, reference labels and safe URL validation.
  // Reference targets come from the cached document parse, never a second scan.
  const inline = /^\[[\s\S]*\]\((?:<([^>]+)>|([^\s)]+))/.exec(source);
  if (inline) return inline[1] ?? inline[2];
  const reference = /^\[([\s\S]*?)\](?:\[([\s\S]*?)\])?$/.exec(source);
  if (!reference || source.startsWith('[^')) return undefined;
  return scan.references[normalizeReferenceLabel(reference[2] || reference[1])]?.href;
}
