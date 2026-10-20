import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import hljs from 'highlight.js';
import katex from 'katex';
import Token from 'markdown-it/lib/token.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type { RuleCore } from 'markdown-it/lib/parser_core.mjs';
import type { RuleInline } from 'markdown-it/lib/parser_inline.mjs';
import type { RuleBlock } from 'markdown-it/lib/parser_block.mjs';
import type { RenderRule } from 'markdown-it/lib/renderer.mjs';
import { installProductMarkdown } from './editor/product-markdown';
import { prepareMarkdownTables } from './markdown-tables';
import { freezeMarkdownPreferences, markdownPreferenceSource, smartPunctuation } from './markdown-preferences';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      output: 'mathml',
      throwOnError: false,
      displayMode,
    });
  } catch (err) {
    console.error('[export] katex render failed:', err);
    return `<code class="math-error">${escapeHtml(tex)}</code>`;
  }
}

// Rewrites list items starting with [ ] / [x] / [X] into checkbox items.
const taskListRule: RuleCore = (state: StateCore): void => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline') continue;
    if (tokens[i - 1].type !== 'paragraph_open') continue;
    const itemOpen = tokens[i - 2];
    if (itemOpen.type !== 'list_item_open') continue;
    const children = tokens[i].children;
    if (!children || children.length === 0) continue;
    const first = children[0];
    if (first.type !== 'text') continue;
    const match = /^\[([ xX])\](?:[ \t]+|$)/.exec(first.content);
    if (!match) continue;
    first.content = first.content.slice(match[0].length);
    const checkbox = new Token('html_inline', '', 0);
    const checked = match[1].toLowerCase() === 'x' ? ' checked' : '';
    checkbox.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${checked}> `;
    children.unshift(checkbox);
    itemOpen.attrJoin('class', 'task-list-item');
  }
};

// Inline math: $...$ (and mid-paragraph $$...$$ as display math).
const mathInlineRule: RuleInline = (state: StateInline, silent: boolean): boolean => {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false;
  const double = src.charCodeAt(start + 1) === 0x24;
  const openLen = double ? 2 : 1;
  const contentStart = start + openLen;
  if (contentStart >= state.posMax) return false;
  // Opening $ must not be followed by whitespace.
  if (/\s/.test(src[contentStart])) return false;
  let pos = contentStart;
  while (pos < state.posMax) {
    if (src.charCodeAt(pos) === 0x24 && src.charCodeAt(pos - 1) !== 0x5c /* \ */) {
      // Closing $ must not be preceded by whitespace, content must be non-empty.
      if (pos === contentStart || /\s/.test(src[pos - 1])) {
        pos++;
        continue;
      }
      if (double) {
        if (src.charCodeAt(pos + 1) !== 0x24) {
          pos++;
          continue;
        }
      } else {
        // Avoid currency-like matches: $5 and $10.
        const after = src[pos + 1];
        if (after !== undefined && /[0-9]/.test(after)) {
          pos++;
          continue;
        }
      }
      if (!silent) {
        const token = state.push('math_inline', 'math', 0);
        token.markup = double ? '$$' : '$';
        token.content = src.slice(contentStart, pos);
      }
      state.pos = pos + openLen;
      return true;
    }
    pos++;
  }
  return false;
};

// Block math: $$...$$ fenced blocks and single-line $$x$$.
const mathBlockRule: RuleBlock = (
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean => {
  const src = state.src;
  const begin = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (begin + 2 > max || src.slice(begin, begin + 2) !== '$$') return false;

  // Single-line form: $$ E = mc^2 $$
  const firstLine = src.slice(begin, max).trim();
  if (firstLine.length > 2 && firstLine.endsWith('$$')) {
    const content = firstLine.slice(2, -2).trim();
    if (content) {
      if (silent) return true;
      state.line = startLine + 1;
      const token = state.push('math_block', 'math', 0);
      token.block = true;
      token.markup = '$$';
      token.content = content;
      token.map = [startLine, startLine + 1];
      return true;
    }
  }

  // Multi-line form: $$ \n ... \n $$
  let nextLine = startLine;
  let found = false;
  while (nextLine < endLine) {
    nextLine++;
    if (nextLine >= endLine) break;
    const lineBegin = state.bMarks[nextLine] + state.tShift[nextLine];
    const lineEnd = state.eMarks[nextLine];
    if (src.slice(lineBegin, lineEnd).trim().endsWith('$$')) {
      found = true;
      break;
    }
  }
  if (!found) return false;
  if (silent) return true;

  const lastBegin = state.bMarks[nextLine] + state.tShift[nextLine];
  const lastEnd = state.eMarks[nextLine];
  const trimmedLen = src.slice(lastBegin, lastEnd).trimEnd().length;
  const content = src.slice(begin + 2, lastBegin + trimmedLen - 2).trim();
  state.line = nextLine + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.markup = '$$';
  token.content = content;
  token.map = [startLine, nextLine + 1];
  return true;
};

// ==highlight== -> <mark> (inner region gets full inline parsing).
const markRule: RuleInline = (state: StateInline, silent: boolean): boolean => {
  const src = state.src;
  const start = state.pos;
  const max = state.posMax;
  if (src.charCodeAt(start) !== 0x3d /* = */ || src.charCodeAt(start + 1) !== 0x3d) return false;
  if (start + 2 >= max || /\s/.test(src[start + 2])) return false;
  let pos = start + 2;
  while (pos < max) {
    if (
      src.charCodeAt(pos) === 0x3d &&
      src.charCodeAt(pos + 1) === 0x3d &&
      src.charCodeAt(pos - 1) !== 0x5c
    ) {
      if (!silent) {
        state.push('mark_open', 'mark', 1).markup = '==';
        state.pos = start + 2;
        state.posMax = pos;
        state.md.inline.tokenize(state);
        state.posMax = max;
        state.push('mark_close', 'mark', -1).markup = '==';
      }
      state.pos = pos + 2;
      return true;
    }
    pos++;
  }
  return false;
};

// H~2~O -> <sub>2</sub>; no whitespace inside, ~~ stays strikethrough.
const subRule: RuleInline = (state: StateInline, silent: boolean): boolean => {
  const src = state.src;
  const start = state.pos;
  const max = state.posMax;
  if (src.charCodeAt(start) !== 0x7e /* ~ */ || src.charCodeAt(start + 1) === 0x7e) return false;
  if (start + 1 >= max || /\s/.test(src[start + 1])) return false;
  let pos = start + 1;
  while (pos < max) {
    if (
      src.charCodeAt(pos) === 0x7e &&
      src.charCodeAt(pos - 1) !== 0x5c &&
      !/\s/.test(src[pos - 1])
    ) {
      if (!silent) {
        state.push('sub_open', 'sub', 1).markup = '~';
        state.pos = start + 1;
        state.posMax = pos;
        state.md.inline.tokenize(state);
        state.posMax = max;
        state.push('sub_close', 'sub', -1).markup = '~';
      }
      state.pos = pos + 1;
      return true;
    }
    pos++;
  }
  return false;
};

// X^2^ -> <sup>2</sup>; no whitespace inside (footnote refs use [^..] and
// are consumed by markdown-it-footnote before this rule sees the caret).
const supRule: RuleInline = (state: StateInline, silent: boolean): boolean => {
  const src = state.src;
  const start = state.pos;
  const max = state.posMax;
  if (src.charCodeAt(start) !== 0x5e /* ^ */) return false;
  if (start + 1 >= max || /\s/.test(src[start + 1])) return false;
  let pos = start + 1;
  while (pos < max) {
    if (
      src.charCodeAt(pos) === 0x5e &&
      src.charCodeAt(pos - 1) !== 0x5c &&
      !/\s/.test(src[pos - 1])
    ) {
      if (!silent) {
        state.push('sup_open', 'sup', 1).markup = '^';
        state.pos = start + 1;
        state.posMax = pos;
        state.md.inline.tokenize(state);
        state.posMax = max;
        state.push('sup_close', 'sup', -1).markup = '^';
      }
      state.pos = pos + 1;
      return true;
    }
    pos++;
  }
  return false;
};

export function createMarkdownRenderer(value: unknown, options: { forWriting?: boolean; mathSource?: boolean } = {}) {
  const prefs = freezeMarkdownPreferences(value);
  const mermaidQueue: string[] = [];
  let equationNumber = 0;
  const md = new MarkdownIt({
    html: true,
    linkify: !prefs.noAutoLink,
    breaks: options.forWriting ? !prefs.ignoreLineBreak : prefs.preLinebreakOnExport,
    highlight: (str: string, lang: string): string => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          const value = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
          return `<pre><code class="hljs language-${escapeHtml(lang)}">${value}</code></pre>`;
        } catch (err) {
          console.error('[export] hljs highlight failed:', err);
        }
      }
      return `<pre><code class="hljs">${escapeHtml(str)}</code></pre>`;
    },
  });
  installProductMarkdown(md, prefs);
  // @types/markdown-it-footnote resolves a structurally different MarkdownIt
  // type view than the root import under bundler resolution; cast across it.
  md.use(footnote as unknown as (instance: MarkdownIt) => void);
  // GFM table + strikethrough ship with the default preset; re-assert them.
  md.enable(['table', 'strikethrough'], true);
  md.core.ruler.push('task_lists', taskListRule);
  md.block.ruler.before('paragraph', 'math_block', mathBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  if (prefs.enableInlineMath) md.inline.ruler.push('math_inline', mathInlineRule);
  if (prefs.enableHighlight) md.inline.ruler.push('mark', markRule);
  if (prefs.enableSubscript) md.inline.ruler.push('sub', subRule);
  if (prefs.enableSuperscript) md.inline.ruler.push('sup', supRule);

  if (!prefs.noLegacyMath) {
    md.inline.ruler.before('escape', 'latex_inline_delimiters', (state, silent) => {
      const open = state.src.slice(state.pos, state.pos + 2);
      if (open !== '\\(' && open !== '\\[') return false;
      const close = open === '\\(' ? '\\)' : '\\]';
      const end = state.src.indexOf(close, state.pos + 2);
      if (end < 0 || end >= state.posMax) return false;
      if (!silent) { const token = state.push('math_inline', 'math', 0); token.content = state.src.slice(state.pos + 2, end); token.markup = open === '\\[' ? '$$' : '$'; }
      state.pos = end + 2; return true;
    });
    md.block.ruler.before('paragraph', 'latex_display_delimiters', (state, line, end, silent) => {
      const from = state.bMarks[line] + state.tShift[line];
      if (!state.src.startsWith('\\[', from)) return false;
      const close = state.src.indexOf('\\]', from + 2);
      if (close < 0) return false;
      let last = line; while (last < end && state.eMarks[last] < close + 2) last++;
      if (last >= end || state.src.slice(close + 2, state.eMarks[last]).trim()) return false;
      if (!silent) { const token = state.push('math_block', 'math', 0); token.content = state.src.slice(from + 2, close).trim(); token.map = [line, last + 1]; token.block = true; state.line = last + 1; }
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  }
  md.core.ruler.before('block', 'markdown_preference_source', state => {
    state.src = markdownPreferenceSource(state.src, prefs);
  });
  md.core.ruler.after('inline', 'markdown_preference_smart', state => {
    if (!prefs.convertSmartOnRender) return;
    const visit = (tokens: Token[]) => tokens.forEach(token => {
      if (token.type === 'text') token.content = smartPunctuation(token.content, prefs);
      if (token.children) visit(token.children);
    });
    visit(state.tokens);
  });
  const preserveWhitespace = options.forWriting ? !prefs.ignoreLineBreak : prefs.preLinebreakOnExport;
  if (preserveWhitespace) md.core.ruler.after('block', 'markdown_preference_spaces', state => {
    for (const token of state.tokens) if (token.type === 'paragraph_open') token.attrSet('style', 'white-space:pre-wrap');
  });
  const defaultFence: RenderRule =
    md.renderer.rules.fence ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (prefs.enableDiagram && token.info.trim().toLowerCase() === 'mermaid') {
      const index = mermaidQueue.length;
      mermaidQueue.push(token.content);
      return `<div class="mermaid-export" data-mermaid-index="${index}"></div>\n`;
    }
    if (prefs.gitlabMath && token.info.trim().toLowerCase() === 'math') return displayMath(token.content);
    let html = defaultFence(tokens, idx, options, env, self);
    if (prefs.showLineNumbersForFence) {
      const count = token.content.replace(/\n$/, '').split('\n').length;
      html = html.replace('<pre>', '<pre class="md-numbered-code"><span class="md-code-gutter" aria-hidden="true">' + Array.from({ length: count }, (_, index) => index + 1).join('\n') + '</span>');
    }
    return html;
  };
  function displayMath(tex: string): string {
    const numbered = prefs.autoNumberingForMath === 'all' || prefs.autoNumberingForMath === 'ams' && /\\begin\{(?:equation|align|gather|multline)\}/.test(tex);
    let source = tex;
    if (numbered && !/\\(?:tag|nonumber|notag)\b/.test(tex)) source += `\\tag{${++equationNumber}}`;
    return `<div class="math-block">${options.mathSource ? escapeHtml('$$' + tex + '$$') : renderMath(source, true)}</div>\n`;
  }
  md.renderer.rules.math_inline = (tokens, idx) => options.mathSource
    ? escapeHtml('$' + tokens[idx].content + '$') : renderMath(tokens[idx].content, tokens[idx].markup === '$$');
  md.renderer.rules.math_block = (tokens, idx) => displayMath(tokens[idx].content);
  return { md, mermaidSources: mermaidQueue };
}

export function renderClipboardMarkdown(source: string, value: unknown): string {
  const prefs = freezeMarkdownPreferences(value);
  const { md } = createMarkdownRenderer(prefs, { forWriting: true, mathSource: prefs.mathFormatOnCopy === 'latex' });
  return md.render(prepareMarkdownTables(source));

}

