import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import Token from 'markdown-it/lib/token.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import { freezeMarkdownPreferences, markdownPreferenceSource, type MarkdownPreferences } from '../markdown-preferences';

export interface ProductHeading { from: number; to: number; level: number; text: string; id: string }
export interface ProductSpecialBlock { type: 'frontmatter' | 'comment' | 'toc'; from: number; to: number; source: string }
export interface ProductAlertLine { from: number; to: number; type: 'note' | 'tip' | 'important' | 'warning' | 'caution'; first: boolean; last: boolean; markerFrom?: number; markerTo?: number }
export interface ProductReference { href: string; title?: string }
export interface ProductMarkdownScan { headings: ProductHeading[]; specialBlocks: ProductSpecialBlock[]; alertLines: ProductAlertLine[]; references: Record<string, ProductReference> }
type AlertType = ProductAlertLine['type'];
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*(?:\n|$))/i;

export function normalizeReferenceLabel(label: string): string { return label.trim().replace(/\s+/g, ' ').toUpperCase(); }

function plainHeading(tokens: Token[], prefs: Readonly<MarkdownPreferences>): string {
  return tokens.map(token => {
    if (token.type === 'image') return token.children ? plainHeading(token.children, prefs) : token.content;
    if (token.type === 'text') {
      let text = token.content;
      if (prefs.enableHighlight) text = text.replace(/==([^=\n]+)==/g, '$1');
      if (prefs.enableSubscript) text = text.replace(/~([^\s~]+)~/g, '$1');
      if (prefs.enableSuperscript) text = text.replace(/\^([^\s^]+)\^/g, '$1');
      if (prefs.enableInlineMath) text = text.replace(/\$\$?(\S(?:[^$]*?\S)?)\$\$?/g, '$1');
      return text;
    }
    if (token.type === 'code_inline' || token.type === 'math_inline') return token.content;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    return '';
  }).join('').trim();
}

function headingIds(tokens: Token[], prefs: Readonly<MarkdownPreferences>): { token: Token; text: string; id: string }[] {
  const used = new Set<string>();
  const headings: { token: Token; text: string; id: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const text = plainHeading(tokens[i + 1]?.children ?? [], prefs);
    const base = text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'heading';
    let id = base;
    let suffix = 1;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    headings.push({ token: tokens[i], text, id });
  }
  return headings;
}

function frontmatterRule(state: StateBlock, start: number, end: number, silent: boolean): boolean {
  if (start !== 0 || state.blkIndent !== 0 || !/^\uFEFF?---[ \t]*$/.test(state.src.slice(state.bMarks[start], state.eMarks[start]))) return false;
  let last = start + 1;
  while (last < end && !/^(?:---|\.\.\.)[ \t]*$/.test(state.src.slice(state.bMarks[last], state.eMarks[last]))) last++;
  if (last >= end) return false;
  if (silent) return true;
  const token = state.push('product_frontmatter', '', 0);
  token.block = true;
  token.hidden = true;
  token.map = [start, last + 1];
  state.line = last + 1;
  return true;
}

function tocRule(state: StateBlock, start: number, _end: number, silent: boolean): boolean {
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const text = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  if (!/^\[toc\][ \t]*$/i.test(text)) return false;
  if (silent) return true;
  const token = state.push('product_toc', 'nav', 0);
  token.block = true;
  token.map = [start, start + 1];
  state.line = start + 1;
  return true;
}

function escapeHtml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function stripComments(value: string): string { return value.replace(/<!--[\s\S]*?(?:-->|$)/g, ''); }

const commentParser = new MarkdownIt({ html: true });
function commentSpans(source: string): { from: number; to: number }[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const code = commentParser.parse(source, {}).filter(token => (token.type === 'fence' || token.type === 'code_block') && token.map)
    .map(token => ({ from: starts[token.map![0]], to: starts[token.map![1]] ?? source.length }));
  const spans: { from: number; to: number }[] = [];
  for (let pos = 0; pos < source.length;) {
    const protectedBlock = code.find(range => range.from <= pos && pos < range.to);
    if (protectedBlock) { pos = protectedBlock.to; continue; }
    if (source.startsWith('<!--', pos)) {
      const close = source.indexOf('-->', pos + 4);
      const to = close < 0 ? source.length : close + 3;
      spans.push({ from: pos, to });
      pos = to;
      continue;
    }
    if (source[pos] === '`' && (pos === 0 || source[pos - 1] !== '\\')) {
      const run = /^`+/.exec(source.slice(pos))![0];
      const closer = new RegExp(`(?<!\x60)\x60{${run.length}}(?!\x60)`, 'g');
      closer.lastIndex = pos + run.length;
      const close = closer.exec(source);
      if (close && !/\n[ \t]*\n/.test(source.slice(pos, close.index)) &&
          !code.some(range => range.from > pos && range.from < close.index)) {
        pos = close.index + close[0].length;
        continue;
      }
      pos += run.length;
      continue;
    }
    pos++;
  }
  return spans;
}

export function installProductMarkdown(md: MarkdownIt, preferences?: Readonly<MarkdownPreferences>): void {
  const prefs = freezeMarkdownPreferences(preferences);
  // Mask comments before block parsing so a multiline inline comment cannot
  // accidentally produce headings or executable HTML across blank lines.
  // Preserve line breaks and offsets for every block token's source map.
  md.core.ruler.before('block', 'product_comments', state => {
    const spans = commentSpans(state.src);
    for (let i = spans.length - 1; i >= 0; i--) {
      const { from, to } = spans[i];
      state.src = state.src.slice(0, from) + state.src.slice(from, to).replace(/[^\r\n]/g, ' ') + state.src.slice(to);
    }
  });
  md.block.ruler.before('hr', 'product_frontmatter', frontmatterRule);
  md.block.ruler.before('paragraph', 'product_toc', tocRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.core.ruler.after('inline', 'product_markdown', state => {
    const headings = headingIds(state.tokens, prefs);
    for (const heading of headings) heading.token.attrSet('id', heading.id);
    const toc = `<nav class="md-toc" aria-label="目录">${headings.map(h => `<a class="md-toc-item md-toc-h${h.token.tag.slice(1)}" href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>`).join('')}</nav>\n`;
    for (const token of state.tokens) if (token.type === 'product_toc') token.content = toc;
    for (let i = 0; i < state.tokens.length; i++) {
      const open = state.tokens[i];
      if (!prefs.enableAlert || open.type !== 'blockquote_open' || state.tokens[i + 1]?.type !== 'paragraph_open') continue;
      const inline = state.tokens[i + 2];
      if (inline?.type !== 'inline') continue;
      const match = ALERT_RE.exec(inline.content);
      if (!match) continue;
      const type = match[1].toLowerCase();
      open.attrJoin('class', `md-alert md-alert-${type}`);
      const title = new Token('html_inline', '', 0);
      title.content = `<span class="md-alert-title md-alert-title-${type}">${type[0].toUpperCase() + type.slice(1)}</span>`;
      inline.content = inline.content.slice(match[0].length);
      inline.children = [];
      state.md.inline.parse(inline.content, state.md, state.env, inline.children);
      const newline = new Token('hardbreak', 'br', 0);
      if (inline.children.length) inline.children.unshift(newline);
      inline.children.unshift(title);
    }
  });
  md.renderer.rules.product_frontmatter = () => '';
  md.renderer.rules.product_toc = (tokens, index) => tokens[index].content;
  // Comments are inert and absent from exported content. Other HTML keeps its
  // established renderer; comment text never enters an executable element.
  for (const kind of ['html_block', 'html_inline']) {
    const original = md.renderer.rules[kind];
    md.renderer.rules[kind] = (tokens, index, options, env, renderer) => stripComments(original
      ? original(tokens, index, options, env, renderer) : tokens[index].content);
  }
}

const preferenceScanners = new Map<string, MarkdownIt>();

export function scanProductMarkdown(source: string, preferences?: Readonly<MarkdownPreferences>): ProductMarkdownScan {
  const prefs = freezeMarkdownPreferences(preferences);
  const key = JSON.stringify(prefs);
  let activeScanner = preferenceScanners.get(key);
  if (!activeScanner) {
    if (preferenceScanners.size > 16) preferenceScanners.clear();
    activeScanner = new MarkdownIt({ html: true });
    installProductMarkdown(activeScanner, prefs);
    activeScanner.use(footnote as unknown as (instance: MarkdownIt) => void);
    preferenceScanners.set(key, activeScanner);
  }
  const offsets: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) offsets.push(i + 1);
  const lineStart = (line: number) => offsets[line] ?? source.length;
  const lineEnd = (line: number) => {
    let end = line + 1 < offsets.length ? offsets[line + 1] - 1 : source.length;
    if (source[end - 1] === '\r') end--;
    return end;
  };
  // Markdown-it normalizes CRLF and BOM. Token maps use line numbers, so offsets
  // are always calculated against the original source and preserve its bytes.
  const env: { references?: Record<string, { href: string; title: string }> } = {};
  const tokens = activeScanner.parse(markdownPreferenceSource(source, prefs), env);
  const specialBlocks: ProductSpecialBlock[] = [];
  for (const token of tokens) {
    if (!token.map) continue;
    const from = lineStart(token.map[0]);
    const to = lineEnd(token.map[1] - 1);
    if (token.type === 'product_frontmatter' || token.type === 'product_toc') specialBlocks.push({ type: token.type === 'product_toc' ? 'toc' : 'frontmatter', from, to, source: source.slice(from, to) });
  }
  for (const { from, to } of commentSpans(source)) {
    if (specialBlocks.some(block => from >= block.from && from < block.to)) continue;
    specialBlocks.push({ type: 'comment', from, to, source: source.slice(from, to) });
  }
  specialBlocks.sort((a, b) => a.from - b.from);
  const headings = headingIds(tokens, prefs).map(({ token, text, id }) => ({ from: lineStart(token.map![0]), to: lineEnd(token.map![1] - 1), level: Number(token.tag.slice(1)), text, id }));
  const alertLines: ProductAlertLine[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (preferences && !preferences.enableAlert) break;
    const token = tokens[i];
    if (token.type !== 'blockquote_open' || !token.map || !token.attrGet('class')?.includes('md-alert-')) continue;
    const type = token.attrGet('class')!.match(/md-alert-(note|tip|important|warning|caution)/)![1] as AlertType;
    const firstLine = token.map[0];
    const lastLine = token.map[1] - 1;
    for (let line = firstLine; line <= lastLine; line++) {
      const from = lineStart(line), to = lineEnd(line);
      // Keep literal marker text inside quoted fences as code content.
      const entry: ProductAlertLine = { from, to, type, first: line === firstLine, last: line === lastLine };
      if (line === firstLine) {
        const marker = /\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(source.slice(from, to));
        if (marker) { entry.markerFrom = from + marker.index; entry.markerTo = entry.markerFrom + marker[0].length; }
      }
      alertLines.push(entry);
    }
  }
  const references: Record<string, ProductReference> = Object.create(null);
  for (const [label, ref] of Object.entries(env.references ?? {})) references[normalizeReferenceLabel(label)] = { href: ref.href, ...(ref.title ? { title: ref.title } : {}) };
  // A nested quote owns its line's live border/title. Keeping only the inner
  // entry avoids a parent severity color overriding the inner alert in CSS.
  const innerAlertLines = new Map<number, ProductAlertLine>();
  for (const line of alertLines) innerAlertLines.set(line.from, line);
  return { headings, specialBlocks, alertLines: [...innerAlertLines.values()].sort((a, b) => a.from - b.from), references };
}
