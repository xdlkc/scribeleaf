/// <reference types="vite/client" />

// HTML export / print renderer.
// Renders markdown to a standalone HTML document: GFM tables, task lists,
// footnotes, KaTeX math (MathML output, so no fonts/CSS needed), mermaid
// diagrams (rendered to inline SVG), and highlight.js syntax highlighting.

import { createMarkdownRenderer } from './markdown-renderer';
import { freezeMarkdownPreferences, markdownOutputCSS, type MarkdownPreferences } from './markdown-preferences';
import type { ThemeName } from './types';
import { prepareMarkdownTables } from './markdown-tables';
import productMarkdownCss from './editor/product-markdown.css?inline';
// Vite ?inline imports resolve to the raw file contents (string) at build time.
import githubCss from './themes/github.css?inline';
import gothicCss from './themes/gothic.css?inline';
import nightCss from './themes/night.css?inline';
import newsprintCss from './themes/newsprint.css?inline';
import pixyllCss from './themes/pixyll.css?inline';
import whiteyCss from './themes/whitey.css?inline';
import openSansRegular from '@fontsource/open-sans/400.css?inline';
import openSansItalic from '@fontsource/open-sans/400-italic.css?inline';
import openSansBold from '@fontsource/open-sans/700.css?inline';
import openSansBoldItalic from '@fontsource/open-sans/700-italic.css?inline';
import openSansLicense from '../public/licenses/OpenSans-OFL.txt?raw';
import gustLicense from './assets/fonts/gothic/GUST-FONT-LICENSE.txt?raw';
import lpplLicense from './assets/fonts/gothic/LPPL-1.3c.txt?raw';
import didactLicense from './assets/fonts/gothic/DIDACT-OFL-1.1.txt?raw';
import ptSerifLicense from '../public/licenses/newsprint/PTSerif-OFL-1.1.txt?raw';
import merriweatherLicense from '../public/licenses/pixyll/Merriweather-OFL-1.1.txt?raw';
import latoLicense from '../public/licenses/pixyll/Lato-OFL-1.1.txt?raw';

const FONT_CSS = openSansRegular + openSansItalic + openSansBold + openSansBoldItalic;

const THEME_CSS: Record<ThemeName, string> = {
  github: githubCss,
  gothic: gothicCss,
  night: nightCss,
  newsprint: newsprintCss,
  pixyll: pixyllCss,
  whitey: whiteyCss,
};

// Standalone document styles. Colors/fonts come from the active theme via the
// CSS variables the theme files define under body[data-theme="..."].
const CONTENT_CSS = `
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 40px 24px;
  background: var(--paper, #ffffff);
  color: var(--text, #1f2328);
  font-family: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.md-render { max-width: 860px; margin: 0 auto; word-wrap: break-word; word-break: normal; }
.md-render > :first-child { margin-top: 0; }
.md-render > :last-child { margin-bottom: 0; }
a { color: var(--link, #0969da); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3, h4, h5, h6 { margin: 1.4em 0 0.6em; font-weight: 600; line-height: 1.25; }
h1 { font-size: 2.25em; }
h2 { font-size: 1.75em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border, #d0d7de); }
h3 { font-size: 1.5em; }
h4 { font-size: 1.25em; }
h5 { font-size: 1em; }
h6 { font-size: 0.85em; color: var(--quote-text, #656d76); }
p { margin: 0.8em 0; }
blockquote {
  margin: 1em 0;
  padding: 0.2em 1em;
  color: var(--quote-text, #656d76);
  border-left: 0.25em solid var(--quote-border, #d0d7de);
}
blockquote > :first-child { margin-top: 0; }
blockquote > :last-child { margin-bottom: 0; }
code, kbd, pre, samp {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
}
code {
  padding: 0.2em 0.4em;
  font-size: 0.9em;
  background: var(--code-bg, #eff1f3);
  color: var(--code-text, inherit);
  border-radius: 4px;
}
pre {
  margin: 1em 0;
  padding: 12px 16px;
  overflow-x: auto;
  font-size: 0.875em;
  line-height: 1.5;
  background: var(--code-bg, #f6f8fa);
  color: var(--code-text, inherit);
  border: 1px solid var(--border, #d0d7de);
  border-radius: 6px;
}
pre code { padding: 0; background: transparent; border-radius: 0; font-size: 1em; }
table {
  border-collapse: collapse;
  margin: 1em 0;
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
}
th, td { padding: 6px 13px; border: 1px solid var(--border, #d0d7de); }
th { font-weight: 600; }
table tr:nth-child(even) { background: var(--table-stripe, #f6f8fa); }
img { max-width: 100%; height: auto; }
hr { height: 1px; border: 0; margin: 2em 0; background: var(--border, #d0d7de); }
ul, ol { padding-left: 2em; margin: 0.8em 0; }
li + li { margin-top: 0.25em; }
.task-list-item { list-style-type: none; }
input.task-list-item-checkbox { margin: 0 0.4em 0.2em -1.4em; vertical-align: middle; }
mark { background: var(--mark-bg, #fff8c5); padding: 0 0.15em; border-radius: 2px; }
sub, sup { font-size: 0.75em; line-height: 0; }
.md-render sup a { text-decoration: none; }
.footnotes {
  margin-top: 2em;
  padding-top: 1em;
  border-top: 1px solid var(--border, #d0d7de);
  font-size: 0.875em;
  color: var(--quote-text, #656d76);
}
.footnotes ol { padding-left: 1.5em; }
.footnotes .footnote-backref { text-decoration: none; }
.katex { font-size: 1.06em; }
.katex-display { margin: 1em 0; text-align: center; overflow-x: auto; overflow-y: hidden; }
.math-block { margin: 1em 0; text-align: center; }
.math-error { color: #cc0000; }
.mermaid-diagram { margin: 1em 0; text-align: center; }
.mermaid-diagram svg { max-width: 100%; height: auto; }
.mermaid-error { color: #cc0000; font-size: 0.8em; }
@media print {
  html, body { background: #ffffff !important; color: #000000 !important; }
  body { padding: 0; font-size: 12pt; }
  a { color: #000000; text-decoration: underline; }
  pre, table, blockquote, img, .mermaid-diagram { page-break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
}
`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type MermaidApi = (typeof import('mermaid'))['default'];

let mermaidApi: MermaidApi | null = null;
let mermaidTheme: 'dark' | 'default' | null = null;
let mermaidIdCounter = 0;

async function getMermaid(theme: ThemeName): Promise<MermaidApi> {
  if (!mermaidApi) {
    mermaidApi = (await import('mermaid')).default;
  }
  const want: 'dark' | 'default' = theme === 'night' ? 'dark' : 'default';
  if (mermaidTheme !== want) {
    mermaidApi.initialize({
      startOnLoad: false,
      theme: want,
      securityLevel: 'loose',
      suppressErrorRendering: true,
    });
    mermaidTheme = want;
  }
  return mermaidApi;
}

/** Render markdown body to HTML fragment (sync part) — internal. */
/** Full pipeline: markdown -> HTML with KaTeX (MathML output), mermaid blocks rendered to inline SVG, hljs-highlighted code, GFM tables, task checkboxes, footnotes. */
export async function renderMarkdownToHtml(markdown: string, theme: ThemeName, preferences?: Readonly<MarkdownPreferences>, options: { mathSource?: boolean } = {}): Promise<string> {
  const frozen = freezeMarkdownPreferences(preferences);
  const { md, mermaidSources } = createMarkdownRenderer(frozen, options);
  let html = md.render(prepareMarkdownTables(markdown));
  const sources = mermaidSources.slice();
  if (sources.length === 0) return html;

  const mermaid = await getMermaid(theme);
  for (let i = 0; i < sources.length; i++) {
    const id = `export-mermaid-${++mermaidIdCounter}`;
    let replacement: string;
    try {
      const { svg } = await mermaid.render(id, sources[i]);
      replacement = `<div class="mermaid-diagram">${svg}</div>`;
    } catch (err) {
      console.error('[export] mermaid render failed:', err);
      replacement = `<pre class="mermaid-error">${escapeHtml(sources[i])}</pre>`;
      // mermaid leaves its scratch element behind on failure.
      if (typeof document !== 'undefined') {
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
    }
    html = html.replace(
      `<div class="mermaid-export" data-mermaid-index="${i}"></div>`,
      replacement,
    );
  }
  return html;
}

/** Standalone HTML document string: inlined export CSS + active theme CSS + rendered body. */
export async function buildStandaloneHtml(
  title: string,
  markdown: string,
  theme: ThemeName,
  options: {
    withoutStyles?: boolean;
    appendHead?: string;
    appendBody?: string;
    sidebar?: boolean;
    splitPages?: boolean;
    fontSize?: string;
    imageWidth?: number;
    nativePrint?: boolean;
    markdownPreferences?: Readonly<MarkdownPreferences>;
  } = {},
): Promise<string> {
  const markdownPreferences = freezeMarkdownPreferences(options.markdownPreferences);
  let bodyHtml = await renderMarkdownToHtml(markdown, theme, markdownPreferences, { mathSource: options.withoutStyles && markdownPreferences.mathFormatOnCopy === 'latex' });
  const headings: { id: string; text: string }[] = [];
  if (options.sidebar) bodyHtml = bodyHtml.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (_match, level, attrs: string, content: string) => {
    const id = `export-heading-${headings.length + 1}`;
    headings.push({ id, text: content.replace(/<[^>]*>/g, '') });
    return `<h${level}${attrs.replace(/\sid=("[^"]*"|'[^']*')/g, '')} id="${id}">${content}</h${level}>`;
  });
  const themeCss = THEME_CSS[theme] ?? githubCss;
  const requestedFont = Number.parseFloat(options.fontSize ?? '');
  const customFont = Number.isFinite(requestedFont) && requestedFont >= 6 && requestedFont <= 96;
  const licenses = openSansLicense + (theme === 'gothic' ? '\n' + gustLicense + '\n' + lpplLicense + '\n' + didactLicense : '')
    + (theme === 'newsprint' ? '\n' + ptSerifLicense : '')
    + (theme === 'pixyll' ? '\n' + merriweatherLicense + '\n' + latoLicense : '');
  const extraCss = (options.sidebar ? '.export-outline{position:fixed;left:16px;top:32px;width:160px;max-height:90vh;overflow:auto}.export-outline~.md-render{margin-left:176px} .export-outline ul{padding-left:12px}' : '')
    + (options.splitPages ? 'h1{page-break-before:always}' : '')
    + (options.imageWidth ? `body{box-sizing:border-box;width:${Math.max(1, Number(options.imageWidth) || 640)}px}` : '')
    + (customFont ? 'body{font-size:1rem}' : '')
    + (options.withoutStyles ? '' : markdownOutputCSS(markdownPreferences));
  const styles = options.withoutStyles
    ? (extraCss ? `<style>${extraCss}</style>\n` : '')
    : `<!-- ${licenses} -->\n<style>${FONT_CSS}</style>\n<style>${CONTENT_CSS}</style>\n`
      + (options.nativePrint ? '' : '<style>@media print{@page{margin:2cm;}}</style>\n')
      + `<style>${themeCss}</style>\n<style>${productMarkdownCss}</style>\n`
      + (extraCss ? `<style>${extraCss}</style>\n` : '');
  const outline = options.sidebar ? `<nav class="export-outline" aria-label="Outline"><ul>${headings.map(h => `<li><a href="#${h.id}">${h.text}</a></li>`).join('')}</ul></nav>\n` : '';
  // Typora's custom image size is the HTML root size. Native rem/em CSS then
  // controls typography and spacing; fixed-pixel images and borders stay fixed.
  // Localized Pixyll/Whitey rem lengths use --content-rem to preserve their
  // default roots without changing the editor's global root.
  const htmlStyle = customFont ? ` style="font-size:${requestedFont}px!important;--content-rem:1rem"` : '';

  return (
    `<!DOCTYPE html>\n<html${htmlStyle}>\n<head>\n<meta charset="utf-8">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    styles + (options.appendHead ?? '') + '</head>\n' +
    `<body data-theme="${theme}">\n` + outline +
    `<article class="md-render">\n${bodyHtml}\n</article>\n` +
    (options.appendBody ?? '') + '</body>\n</html>\n'
  );
}

/** Browser fallback print: opens a hidden iframe/new window with the standalone HTML + print CSS and calls print(). */
export async function printMarkdown(
  title: string,
  markdown: string,
  theme: ThemeName,
  preferences?: Readonly<MarkdownPreferences>,
): Promise<void> {
  const html = await buildStandaloneHtml(title, markdown, theme, { markdownPreferences: freezeMarkdownPreferences(preferences) });
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.visibility = 'hidden';

  let removed = false;
  const cleanup = (): void => {
    if (removed) return;
    removed = true;
    iframe.remove();
  };

  try {
    document.body.appendChild(iframe);
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!win || !doc) throw new Error('print iframe unavailable');

    const loaded = new Promise<void>((resolve) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
      setTimeout(resolve, 2000);
    });
    doc.open();
    doc.write(html);
    doc.close();
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 100));

    win.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(cleanup, 60_000);
    win.focus();
    win.print();
  } catch (err) {
    cleanup();
    console.error('[export] print failed:', err);
    throw err;
  }
}
