// Custom @lezer/markdown inline extensions: inline math $...$, ==highlight==,
// ~subscript~ and ^superscript^. Block math ($$...$$) is handled by the
// line-based scanner in livepreview.ts, not by lezer.

import { MarkdownConfig } from '@lezer/markdown';
import { tags } from '@lezer/highlight';
import { Parser, type Input, type PartialParse, type TreeFragment } from '@lezer/common';
import { freezeMarkdownPreferences, remapMarkdownPunctuation, shouldRemapPunctuation } from '../markdown-preferences';

const DOLLAR = 36; // $
const EQ = 61; // =
const TILDE = 126; // ~
const CARET = 94; // ^
const BACKSLASH = 92; // \
const SPACE = 32;
const TAB = 9;
const NEWLINE = 10;

function isSpace(code: number): boolean {
  return code === SPACE || code === TAB || code === NEWLINE || code === -1;
}

const InlineMathDelim = { resolve: 'InlineMath', mark: 'InlineMathMark' };

export const InlineMath: MarkdownConfig = {
  defineNodes: [{ name: 'InlineMath' }, { name: 'InlineMathMark', style: tags.processingInstruction }],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        // $$ belongs to block math / display spans handled elsewhere.
        if (cx.char(pos + 1) === DOLLAR || cx.char(pos - 1) === BACKSLASH) return -1;
        // opening delimiter requires a non-space next char
        if (!isSpace(cx.char(pos + 1))) {
          return cx.addDelimiter(InlineMathDelim, pos, pos + 1, true, true);
        }
        // still allow it as a closer
        return cx.addDelimiter(InlineMathDelim, pos, pos + 1, false, true);
      },
      after: 'Emphasis',
    },
  ],
};

const HighlightMarkDelim = { resolve: 'HighlightMark', mark: 'HighlightMarkMark' };

export const HighlightMark: MarkdownConfig = {
  defineNodes: [{ name: 'HighlightMark' }, { name: 'HighlightMarkMark', style: tags.processingInstruction }],
  parseInline: [
    {
      name: 'HighlightMark',
      parse(cx, next, pos) {
        if (next !== EQ || cx.char(pos + 1) !== EQ) return -1;
        return cx.addDelimiter(HighlightMarkDelim, pos, pos + 2, true, true);
      },
      after: 'Emphasis',
    },
  ],
};

const SubscriptDelim = { resolve: 'Subscript', mark: 'SubscriptMark' };

export const Subscript: MarkdownConfig = {
  defineNodes: [{ name: 'Subscript' }, { name: 'SubscriptMark', style: tags.processingInstruction }],
  parseInline: [
    {
      name: 'Subscript',
      parse(cx, next, pos) {
        // ~~ is strikethrough (GFM)
        if (next !== TILDE || cx.char(pos + 1) === TILDE) return -1;
        if (!isSpace(cx.char(pos + 1))) {
          return cx.addDelimiter(SubscriptDelim, pos, pos + 1, true, true);
        }
        return cx.addDelimiter(SubscriptDelim, pos, pos + 1, false, true);
      },
      after: 'Emphasis',
    },
  ],
};

const SuperscriptDelim = { resolve: 'Superscript', mark: 'SuperscriptMark' };

export const Superscript: MarkdownConfig = {
  defineNodes: [{ name: 'Superscript' }, { name: 'SuperscriptMark', style: tags.processingInstruction }],
  parseInline: [
    {
      name: 'Superscript',
      parse(cx, next, pos) {
        if (next !== CARET) return -1;
        if (!isSpace(cx.char(pos + 1))) {
          return cx.addDelimiter(SuperscriptDelim, pos, pos + 1, true, true);
        }
        return cx.addDelimiter(SuperscriptDelim, pos, pos + 1, false, true);
      },
      after: 'Emphasis',
    },
  ],
};

export const extraInlineExtensions: MarkdownConfig[] = [
  InlineMath,
  HighlightMark,
  Subscript,
  Superscript,
];

const LegacyMath: MarkdownConfig = {
  defineNodes: [{ name: 'InlineMath' }, { name: 'InlineMathMark', style: tags.processingInstruction }],
  parseInline: [{ name: 'LegacyMath', before: 'Escape', parse(cx, next, position) {
    if (next !== BACKSLASH || ![40, 91].includes(cx.char(position + 1))) return -1;
    const closer = cx.char(position + 1) === 40 ? 41 : 93;
    for (let end = position + 2; end < cx.end; end++) {
      if (cx.char(end) !== BACKSLASH || cx.char(end + 1) !== closer) continue;
      return cx.addElement(cx.elt('InlineMath', position, end + 2, [cx.elt('InlineMathMark', position, position + 2), cx.elt('InlineMathMark', end, end + 2)]));
    }
    return -1;
  } }],
};

const LooseHeading: MarkdownConfig = { parseBlock: [{ name: 'LooseATXHeading', before: 'ATXHeading', parse(cx, line) {
  const match = /^(#{1,6})(?=[^#\s])/.exec(line.text.slice(line.pos));
  if (!match) return false;
  const from = cx.lineStart + line.pos;
  const content = from + match[1].length;
  cx.addElement(cx.elt('ATXHeading' + match[1].length, from, cx.lineStart + line.text.length, [
    cx.elt('HeaderMark', from, content), ...cx.parser.parseInline(line.text.slice(line.pos + match[1].length), content),
  ]));
  cx.nextLine(); return true;
} }] };

export function markdownInlineExtensions(value: unknown): MarkdownConfig[] {
  const prefs = freezeMarkdownPreferences(value);
  return [
    ...(prefs.enableInlineMath ? [InlineMath] : []),
    ...(!prefs.noLegacyMath ? [LegacyMath] : []),
    ...(prefs.enableHighlight ? [HighlightMark] : []),
    ...(prefs.enableSubscript ? [Subscript] : []),
    ...(prefs.enableSuperscript ? [Superscript] : []),
    ...(!prefs.strictMarkdown ? [LooseHeading] : []),
    ...(prefs.noAutoLink ? [{ remove: ['Autolink'] }] : []),
  ];
}

export function markdownPunctuationParser(inner: Parser, value: unknown): Parser {
  const prefs = freezeMarkdownPreferences(value);
  if (!shouldRemapPunctuation(prefs)) return inner;
  return new class extends Parser {
    createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
      const mapped = remapMarkdownPunctuation(input.read(0, input.length), prefs);
      return inner.startParse({ length: input.length, lineChunks: false,
        chunk: from => mapped.slice(from), read: (from, to) => mapped.slice(from, to) }, fragments, ranges);
    }
  }();
}
