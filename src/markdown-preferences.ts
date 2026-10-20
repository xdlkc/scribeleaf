export interface MarkdownPreferences {
  strictMarkdown: boolean;
  headingStyle: 0 | 1 | 2 | 3;
  ulStyle: 0 | 1 | 2;
  olStyle: 0 | 1;
  noAutoLink: boolean;
  enableInlineMath: boolean;
  enableSubscript: boolean;
  enableSuperscript: boolean;
  enableHighlight: boolean;
  enableAlert: boolean;
  enableDiagram: boolean;
  convertSmartOnRender: boolean;
  smartQuote: boolean;
  smartDash: boolean;
  remapPunctuation: boolean;
  showLineNumbersForFence: boolean;
  noLineWrapping: boolean;
  shiftTabAutoIndent: boolean;
  codeIndentSize: 2 | 3 | 4 | 5;
  defaultCodeLang: string;
  defaultCodeLangOption: 1 | 2 | 3;
  noLegacyMath: boolean;
  gitlabMath: boolean;
  allowPhysicsConflict: boolean;
  legacyInlineMathParse: boolean;
  autoNumberingForMath: '' | 'ams' | 'all';
  mathFormatOnCopy: 'svg' | 'latex';
  indentFirstLine: boolean;
  hideBrAndLineBreak: boolean;
  ignoreLineBreak: boolean;
  preLinebreakOnExport: boolean;
}

/** Keep the replica's existing syntax enabled. These are compatibility
 * fallbacks, not evidence of Typora's native factory preferences. */
export const DEFAULT_MARKDOWN_PREFERENCES: Readonly<MarkdownPreferences> = Object.freeze({
  strictMarkdown: false, headingStyle: 0, ulStyle: 0, olStyle: 0, noAutoLink: false,
  enableInlineMath: true, enableSubscript: true, enableSuperscript: true,
  enableHighlight: true, enableAlert: true, enableDiagram: true,
  convertSmartOnRender: false, smartQuote: false, smartDash: false, remapPunctuation: false,
  showLineNumbersForFence: false, noLineWrapping: false, shiftTabAutoIndent: false,
  codeIndentSize: 4, defaultCodeLang: '', defaultCodeLangOption: 1,
  noLegacyMath: false, gitlabMath: true, allowPhysicsConflict: false,
  legacyInlineMathParse: false, autoNumberingForMath: '', mathFormatOnCopy: 'svg',
  indentFirstLine: false, hideBrAndLineBreak: false, ignoreLineBreak: false,
  preLinebreakOnExport: false,
});

export function normalizeMarkdownPreferences(value: unknown): MarkdownPreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_MARKDOWN_PREFERENCES };
  for (const key of Object.keys(result) as (keyof MarkdownPreferences)[]) {
    if (typeof result[key] === 'boolean' && typeof input[key] === 'boolean') {
      (result as unknown as Record<string, unknown>)[key] = input[key];
    }
  }
  for (const [key, allowed] of Object.entries({ headingStyle: [0, 1, 2, 3], ulStyle: [0, 1, 2], olStyle: [0, 1], codeIndentSize: [2, 3, 4, 5], defaultCodeLangOption: [1, 2, 3] })) {
    if (allowed.includes(input[key] as number)) (result as unknown as Record<string, unknown>)[key] = input[key];
  }
  if (typeof input.defaultCodeLang === 'string') result.defaultCodeLang = input.defaultCodeLang.trim().replace(/[\r\n`~]/g, '').slice(0, 80);
  if (['', 'ams', 'all'].includes(input.autoNumberingForMath as string)) result.autoNumberingForMath = input.autoNumberingForMath as MarkdownPreferences['autoNumberingForMath'];
  if (input.autoNumberingForMath === true || input.autoNumberingForMath === 1) result.autoNumberingForMath = 'all';
  if (input.mathFormatOnCopy === 'latex' || input.mathFormatOnCopy === 'svg') result.mathFormatOnCopy = input.mathFormatOnCopy;
  return result;
}

export function freezeMarkdownPreferences(value: unknown): Readonly<MarkdownPreferences> {
  return Object.freeze(normalizeMarkdownPreferences(value));
}

export function shouldRemapPunctuation(prefs: MarkdownPreferences): boolean {
  return prefs.remapPunctuation || !prefs.convertSmartOnRender && (prefs.smartQuote || prefs.smartDash);
}

/** Every replacement has the same UTF-16 width. Source offsets stay valid. */
export function remapMarkdownPunctuation(source: string, prefs: MarkdownPreferences): string {
  if (!shouldRemapPunctuation(prefs)) return source;
  const pairs: Record<string, string> = { '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '》': '>', '＞': '>', '＃': '#', '（': '(', '）': ')' };
  const protectedRanges: { from: number; to: number }[] = [];
  let fence: { from: number; marker: string } | null = null;
  let offset = 0;
  for (const line of source.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { from: offset, marker: marker[1] };
      else if (marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
        protectedRanges.push({ from: fence.from, to: offset + line.length }); fence = null;
      }
    }
    offset += line.length + 1;
  }
  if (fence) protectedRanges.push({ from: fence.from, to: source.length });
  for (let position = 0; position < source.length;) {
    const protectedBlock = protectedRanges.find(range => position >= range.from && position < range.to);
    if (protectedBlock) { position = protectedBlock.to; continue; }
    if (source[position] !== '`' || source[position - 1] === '\\') { position++; continue; }
    const opening = /^`+/.exec(source.slice(position))![0];
    let end = source.indexOf(opening, position + opening.length);
    while (end >= 0 && (source[end - 1] === '`' || source[end + opening.length] === '`')) end = source.indexOf(opening, end + opening.length);
    if (end >= 0) { protectedRanges.push({ from: position, to: end + opening.length }); position = end + opening.length; }
    else position += opening.length;
  }
  return source.replace(/[“”‘’–—》＞＃（）]/g, (value, position: number) =>
    protectedRanges.some(range => position >= range.from && position < range.to) ? value : pairs[value]);
}

export function smartPunctuation(source: string, prefs: MarkdownPreferences): string {
  let value = source;
  if (prefs.smartDash) value = value.replace(/---/g, '—').replace(/--/g, '–');
  if (prefs.smartQuote) value = value.replace(/["']/g, (quote, offset: number, text: string) => {
    const open = offset === 0 || /[\s([{<]/.test(text[offset - 1]);
    return quote === '"' ? open ? '“' : '”' : open ? '‘' : '’';
  });
  return value;
}

export function markdownPreferenceSource(source: string, prefs: MarkdownPreferences): string {
  const remapped = remapMarkdownPunctuation(source, prefs);
  if (prefs.strictMarkdown) return remapped;
  let fence: { marker: string } | null = null;
  return remapped.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1] };
      else if (marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) fence = null;
      return line;
    }
    return fence ? line : line.replace(/^(#{1,6})(?=[^#\s])/, '$1 ');
  }).join('\n');
}

export function markdownOutputCSS(prefs: MarkdownPreferences, forWriting = false): string {
  const preserve = forWriting ? !prefs.ignoreLineBreak : prefs.preLinebreakOnExport;
  return (preserve ? '.md-render p,.md-render li{white-space:pre-wrap}' : '')
    + (prefs.indentFirstLine ? '.md-render p{text-indent:2em}.md-render li p,.md-render p *,.md-render svg *{text-indent:0}.md-render li{margin-left:2em}' : '')
    + `.md-render pre,.md-render pre code{white-space:${prefs.noLineWrapping ? 'pre' : 'pre-wrap'}}`
    + `.md-render pre{tab-size:${prefs.codeIndentSize}}`
    + (prefs.showLineNumbersForFence ? '.md-numbered-code{display:flex;gap:1em}.md-code-gutter{white-space:pre;text-align:right;opacity:.45;user-select:none}.md-numbered-code code{flex:1;min-width:0}' : '');
}

/** These require more than a setting switch. Keep their controls hidden until
 * the corresponding engine contract is implemented and verified. */
export const UNSUPPORTED_MARKDOWN_PREFERENCES = Object.freeze([
  'allowPhysicsConflict', 'legacyInlineMathParse', 'mathFormatOnCopy',
] as const);

export const PARTIAL_MARKDOWN_PREFERENCES = Object.freeze({
  strictMarkdown: 'ATX whitespace and the CommonMark parser switch are implemented; Typora relaxed list continuation indentation is not yet matched.',
  autoNumberingForMath: 'Display equation numbering is implemented; MathJax AMS multiline environments and label/ref across equations are not matched by KaTeX.',
  mathFormatOnCopy: 'LaTeX source is implemented; the SVG alternative needs a different math output engine.',
  smartQuote: 'Curly quote conversion is implemented; the native system custom quotation pattern is not yet supplied to the renderer.',
});
