// Block/inline widgets for the live preview: tables, math, mermaid diagrams,
// images, horizontal rules, task checkboxes.

import { WidgetType, EditorView } from '@codemirror/view';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { createTableEditor, updateTableEditor, destroyTableEditor } from './table-editor';
import MarkdownIt from 'markdown-it';
import type { ThemeName } from '../types';
import type { ProductHeading, ProductSpecialBlock } from './product-markdown';
import { freezeMarkdownPreferences, type MarkdownPreferences } from '../markdown-preferences';

export interface WidgetContext {
  view: EditorView;
  /** Base used to resolve relative image paths ('' when unknown). */
  baseDir: string;
  theme: ThemeName;
  markdownPreferences?: Readonly<MarkdownPreferences>;
}

const imageParser = new MarkdownIt();
export function parseImageMarkdown(source: string): {src: string; alt: string} | null {
  const image = imageParser.parseInline(source, {})[0]?.children?.find(token => token.type === 'image');
  if (!image) return null;
  return {src: image.attrGet('src') ?? '', alt: image.children?.map(token => token.content).join('') ?? image.content};
}

export function resolveImageSrc(src: string, baseDir: string): string {
  if (/^(https?:|data:|file:|blob:)/i.test(src)) return src;
  if (!baseDir) return src;
  try {
    const base = /^[a-z]+:/i.test(baseDir) ? baseDir : new URL(baseDir, document.baseURI).href;
    return new URL(src, base).href;
  } catch { return src; }
}

function revealSource(ctx: WidgetContext, from: number) {
  ctx.view.dispatch({
    selection: { anchor: Math.min(from + 1, ctx.view.state.doc.length) },
  });
  ctx.view.focus();
}

export class AlertTitleWidget extends WidgetType {
  constructor(readonly type: string) { super(); }
  eq(other: AlertTitleWidget): boolean { return other.type === this.type; }
  toDOM(): HTMLElement {
    const title = document.createElement('span');
    title.className = `md-alert-title md-alert-title-${this.type}`;
    title.textContent = this.type[0].toUpperCase() + this.type.slice(1);
    return title;
  }
  ignoreEvent(): boolean { return false; }
}

/** Small product blocks share the same deferred lifecycle as tables/math. */
export class ProductBlockWidget extends WidgetType {
  constructor(readonly block: ProductSpecialBlock, readonly headings: ProductHeading[], readonly ctx: WidgetContext) { super(); }
  eq(other: ProductBlockWidget): boolean {
    return other.block.type === this.block.type && other.block.from === this.block.from &&
      other.block.source === this.block.source && JSON.stringify(other.headings) === JSON.stringify(this.headings);
  }
  toDOM(): HTMLElement {
    if (this.block.type === 'toc') {
      const nav = document.createElement('nav');
      nav.className = 'lp-toc md-toc';
      nav.setAttribute('aria-label', '目录');
      for (const heading of this.headings) {
        const link = document.createElement('a');
        link.className = `md-toc-item md-toc-h${heading.level}`;
        link.href = `#${heading.id}`;
        link.textContent = heading.text;
        link.dataset.sourceFrom = String(heading.from);
        link.style.marginInlineStart = `${(heading.level - 1) * 2}em`;
        const navigate = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          const from = Math.min(heading.from, this.ctx.view.state.doc.length);
          this.ctx.view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
          this.ctx.view.focus();
        };
        link.addEventListener('mousedown', navigate);
        link.addEventListener('click', event => event.preventDefault());
        link.addEventListener('keydown', event => { if (event.key === 'Enter') navigate(event); });
        nav.appendChild(link);
      }
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'lp-toc-edit';
      edit.textContent = this.headings.length ? '编辑目录' : '[TOC]';
      edit.addEventListener('mousedown', event => { event.preventDefault(); revealSource(this.ctx, this.block.from); });
      edit.addEventListener('click', event => { event.preventDefault(); if (event.detail === 0) revealSource(this.ctx, this.block.from); });
      nav.appendChild(edit);
      return nav;
    }
    const node = document.createElement(this.block.type === 'comment' ? 'span' : 'div');
    node.className = `lp-${this.block.type}`;
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.title = this.block.type === 'comment' ? '编辑 HTML 注释' : '编辑 YAML 元信息';
    if (this.block.type === 'frontmatter') {
      const label = document.createElement('div');
      label.className = 'lp-frontmatter-label';
      label.textContent = 'YAML';
      const content = document.createElement('pre');
      content.textContent = this.block.source.replace(/^\uFEFF?---[^\S\n]*\n/, '').replace(/\n(?:---|\.\.\.)[^\S\n]*$/, '');
      node.append(label, content);
    } else {
      node.textContent = '⋯';
      node.setAttribute('aria-label', 'HTML 注释');
    }
    node.addEventListener('mousedown', event => { event.preventDefault(); revealSource(this.ctx, this.block.from); });
    node.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (key === 'Enter' || key === ' ') { event.preventDefault(); revealSource(this.ctx, this.block.from); }
    });
    return node;
  }
  ignoreEvent(): boolean { return true; }
}

export class FootnoteWidget extends WidgetType {
  constructor(readonly label: string, readonly from: number, readonly ctx: WidgetContext) { super(); }
  eq(other: FootnoteWidget): boolean { return other.label === this.label && other.from === this.from; }
  toDOM(): HTMLElement {
    const node = document.createElement('sup');
    node.className = 'lp-footnote-ref';
    node.textContent = this.label;
    node.title = this.label;
    node.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
      const doc = this.ctx.view.state.doc;
      for (let n = 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        if (line.text.trimStart().startsWith(`[^${this.label}]:`)) {
          this.ctx.view.dispatch({selection: {anchor: line.from}, effects: EditorView.scrollIntoView(line.from, {y: 'center'})});
          this.ctx.view.focus();
          return;
        }
      }
      revealSource(this.ctx, this.from);
    });
    return node;
  }
  ignoreEvent(): boolean { return true; }
}

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
    readonly ctx: WidgetContext,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'lp-checkbox';
    input.checked = this.checked;
    input.tabIndex = -1;
    input.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const doc = this.ctx.view.state.doc;
      if (this.pos < 0 || this.pos + 3 > doc.length) return;
      const marker = doc.sliceString(this.pos, this.pos + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      this.ctx.view.dispatch({
        changes: { from: this.pos + 1, to: this.pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
      });
      this.ctx.view.focus();
    });
    return input;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly from: number,
    readonly ctx: WidgetContext,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.from === this.from && other.ctx.baseDir === this.ctx.baseDir;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'lp-image';
    const img = document.createElement('img');
    img.src = resolveImageSrc(this.src, this.ctx.baseDir);
    img.alt = this.alt;
    img.addEventListener('error', () => {
      wrap.classList.add('lp-image-broken');
      if (!wrap.querySelector('.lp-image-alt')) {
        const label = document.createElement('span');
        label.className = 'lp-image-alt';
        label.textContent = this.alt ? `🖻 ${this.alt}` : '🖻 image not found';
        wrap.appendChild(label);
      }
    });
    wrap.appendChild(img);
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      revealSource(this.ctx, this.from);
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-hr';
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly ctx: WidgetContext,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.from === this.from && other.ctx.theme === this.ctx.theme && other.ctx.baseDir === this.ctx.baseDir;
  }

  toDOM(): HTMLElement {
    return createTableEditor(this.source, this.from, this.ctx);
  }

  updateDOM(dom: HTMLElement): boolean { return updateTableEditor(dom, this.source, this.from, this.ctx); }
  destroy(dom: HTMLElement): void { destroyTableEditor(dom); }

  ignoreEvent(): boolean {
    return true;
  }
}

export class MathBlockWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly from: number,
    readonly ctx: WidgetContext,
    readonly equationNumber?: number,
  ) {
    super();
  }

  eq(other: MathBlockWidget): boolean {
    return other.tex === this.tex && other.from === this.from && other.equationNumber === this.equationNumber;
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'lp-math-block';
    try {
      const prefs = freezeMarkdownPreferences(this.ctx.markdownPreferences);
      const numbered = prefs.autoNumberingForMath === 'all' || prefs.autoNumberingForMath === 'ams' && /\\begin\{(?:equation|align|gather|multline)\}/.test(this.tex);
      const tex = numbered && this.equationNumber && !/\\(?:tag|notag|nonumber)\b/.test(this.tex) ? this.tex + `\\tag{${this.equationNumber}}` : this.tex;
      katex.render(tex, div, { displayMode: true, throwOnError: false });
    } catch {
      div.textContent = this.tex;
      div.classList.add('lp-math-error');
    }
    div.title = 'Click to edit math source';
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      revealSource(this.ctx, this.from);
    });
    return div;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class InlineMathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly from: number,
    readonly ctx: WidgetContext,
    readonly displayMode = false,
  ) {
    super();
  }

  eq(other: InlineMathWidget): boolean {
    return other.tex === this.tex && other.from === this.from && other.displayMode === this.displayMode;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-math-inline';
    try {
      katex.render(this.tex, span, { displayMode: this.displayMode, throwOnError: false });
    } catch {
      span.textContent = this.tex;
      span.classList.add('lp-math-error');
    }
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      revealSource(this.ctx, this.from);
    });
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

let mermaidTheme: string | null = null;
let mermaidSeq = 0;

export class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly ctx: WidgetContext,
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return other.source === this.source && other.from === this.from && other.ctx.theme === this.ctx.theme;
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'lp-mermaid';
    const theme = this.ctx.theme === 'night' ? 'dark' : 'default';
    const source = this.source;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        if (mermaidTheme !== theme) {
          mermaid.initialize({
            startOnLoad: false,
            theme,
            securityLevel: 'loose',
            suppressErrorRendering: true,
          });
          mermaidTheme = theme;
        }
        const { svg } = await mermaid.render(`lp-mermaid-${++mermaidSeq}`, source);
        if (div.isConnected) div.innerHTML = svg;
      } catch {
        if (div.isConnected) {
          div.classList.add('lp-mermaid-error');
          div.textContent = source;
        }
      }
    })();
    div.title = 'Click to edit diagram source';
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      revealSource(this.ctx, this.from);
    });
    return div;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
