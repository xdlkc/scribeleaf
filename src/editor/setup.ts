// CodeMirror 6 editor assembly: markdown language, live preview, keymaps,
// focus/typewriter modes, search, and per-prefs reconfiguration.

import { EditorState, Compartment, StateEffect, Prec } from '@codemirror/state';
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  ViewPlugin,
  ViewUpdate,
  Decoration,
  DecorationSet,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  indentSelection as autoIndentCode,
  cursorDocStart,
  cursorDocEnd,
  selectLine,
  deleteLine,
} from '@codemirror/commands';
import {
  markdown,
  commonmarkLanguage,
  insertNewlineContinueMarkup,
  deleteMarkupBackward,
} from '@codemirror/lang-markdown';
import { GFM, Autolink } from '@lezer/markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle, indentUnit } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { search, searchKeymap } from '@codemirror/search';

import { runCommand } from '../commands';
import { clipboardExtension } from './clipboard';
import { store } from '../store';
import { livePreviewPlugin, refreshLivePreview, refreshLivePreviewEffect } from './livepreview';
import { markdownInlineExtensions, markdownPunctuationParser } from './mathparser';
import { createSearchPanel } from './searchpanel';
import { editorPreferencesExtension } from './preferences';
import { indentSelection, outdentSelection, insertCodeFenceLanguage } from './format';
import { inCode } from './preferences';
import { fileDropExtension } from './file-drop';

// --- highlight styles -------------------------------------------------------

// Live preview: only code tokens get syntax colors; document structure is
// styled through CSS classes so themes control the look.
const liveCodeStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], class: 'tok-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'tok-number' },
  { tag: [tags.comment, tags.blockComment, tags.lineComment], class: 'tok-comment' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'tok-function' },
  { tag: [tags.typeName, tags.className, tags.tagName], class: 'tok-type' },
  { tag: [tags.propertyName, tags.attributeName], class: 'tok-property' },
  { tag: [tags.operator, tags.punctuation], class: 'tok-operator' },
  { tag: [tags.atom, tags.labelName], class: 'tok-atom' },
  { tag: [tags.definition(tags.variableName)], class: 'tok-def' },
]);

// Source mode: full markdown syntax coloring.
const sourceStyle = HighlightStyle.define([
  { tag: tags.heading, class: 'src-heading' },
  { tag: tags.emphasis, class: 'src-em' },
  { tag: tags.strong, class: 'src-strong' },
  { tag: tags.strikethrough, class: 'src-strike' },
  { tag: tags.link, class: 'src-link' },
  { tag: tags.url, class: 'src-url' },
  { tag: tags.monospace, class: 'src-code' },
  { tag: tags.quote, class: 'src-quote' },
  { tag: tags.processingInstruction, class: 'src-mark' },
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], class: 'tok-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'tok-number' },
  { tag: [tags.comment, tags.blockComment, tags.lineComment], class: 'tok-comment' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'tok-function' },
  { tag: [tags.typeName, tags.className, tags.tagName], class: 'tok-type' },
  { tag: [tags.propertyName, tags.attributeName], class: 'tok-property' },
  { tag: [tags.operator, tags.punctuation], class: 'tok-operator' },
]);

// --- focus mode -------------------------------------------------------------

const focusModePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    constructor(readonly view: EditorView) {
      this.rebuild();
    }
    update(u: ViewUpdate): void {
      const forced = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLivePreviewEffect)));
      if (u.docChanged || u.selectionSet || u.viewportChanged || forced) this.rebuild();
    }
    rebuild(): void {
      if (!store.prefs.focusMode) {
        this.decorations = Decoration.none;
        return;
      }
      const { state } = this.view;
      const head = state.selection.main.head;
      // active block = paragraph (blank-line delimited) containing the cursor
      const line = state.doc.lineAt(head);
      let start = line.number;
      let end = line.number;
      while (start > 1 && state.doc.line(start - 1).text.trim() !== '') start--;
      while (end < state.doc.lines && state.doc.line(end + 1).text.trim() !== '') end++;
      const blockFrom = state.doc.line(start).from;
      const blockTo = state.doc.line(end).to;
      const dim: { from: number; to: number }[] = [];
      for (const vr of this.view.visibleRanges) {
        let l = state.doc.lineAt(vr.from);
        while (l.from <= vr.to) {
          if (l.to < blockFrom || l.from > blockTo) {
            dim.push({ from: l.from, to: l.from });
          }
          if (l.number >= state.doc.lines) break;
          l = state.doc.line(l.number + 1);
        }
      }
      this.decorations = Decoration.set(
        dim.map((d) => Decoration.line({ class: 'cm-focus-dim' }).range(d.from, d.to)),
        true,
      );
    }
  },
  { decorations: (v) => v.decorations },
);

// --- editor state -----------------------------------------------------------

const modeCompartment = new Compartment();
const spellcheckCompartment = new Compartment();

let updateHandler: ((update: ViewUpdate) => void) | null = null;

/** Register the single app-level update listener. Survives setState() because
 *  it is part of the base extensions created by createEditorState. */
export function setEditorUpdateHandler(fn: (update: ViewUpdate) => void): void {
  updateHandler = fn;
}

function cmd(name: string) {
  return () => {
    runCommand(name);
    return true;
  };
}

function liveExtensions() {
  return [livePreviewPlugin, syntaxHighlighting(liveCodeStyle)];
}

function sourceExtensions() {
  return [syntaxHighlighting(sourceStyle)];
}

const formatKeymap = keymap.of([
  // CM ignores Shift for a printable key's first lookup. Keep the physical
  // Control-backquote pair distinct, including synthesized keyboard events.
  { any: (_view, event) => {
    if (event.ctrlKey && !event.metaKey && !event.altKey &&
        (event.code === 'Backquote' || event.key === '`' || event.key === '~')) {
      runCommand(event.shiftKey ? 'strike' : 'inlineCode');
      return true;
    }
    return false;
  } },
  { key: 'Mod-b', run: cmd('bold') },
  { key: 'Mod-i', run: cmd('italic') },
  { key: 'Mod-u', run: cmd('underline') },
  { key: 'Ctrl-Shift-h', run: cmd('highlight') },
  { key: 'Ctrl--', run: cmd('comment') },
  { key: 'Ctrl-x', run: cmd('toggleTaskState') },
  { key: 'Mod-k', run: cmd('hyperlink') },
  { key: 'Ctrl-Mod-i', run: cmd('image') },
  { key: 'Mod-\\', run: cmd('clearFormat') },
  { key: 'Mod-0', run: cmd('paragraph') },
  { key: 'Mod-1', run: cmd('heading1') },
  { key: 'Mod-2', run: cmd('heading2') },
  { key: 'Mod-3', run: cmd('heading3') },
  { key: 'Mod-4', run: cmd('heading4') },
  { key: 'Mod-5', run: cmd('heading5') },
  { key: 'Mod-6', run: cmd('heading6') },
  { key: 'Mod-=', run: cmd('increaseHeading') },
  { key: 'Mod--', run: cmd('decreaseHeading') },
  { key: 'Alt-Mod-t', run: cmd('table') },
  { key: 'Alt-Mod-c', run: cmd('codeFences') },
  { key: 'Alt-Mod-b', run: cmd('mathBlock') },
  { key: 'Alt-Mod-q', run: cmd('quote') },
  { key: 'Alt-Mod-o', run: cmd('orderedList') },
  { key: 'Alt-Mod-u', run: cmd('bulletList') },
  { key: 'Alt-Mod-x', run: cmd('taskList') },
  { key: 'Mod-]', run: cmd('indent') },
  { key: 'Mod-[', run: cmd('outdent') },
  { key: 'Alt-Mod--', run: cmd('horizontalRule') },
  { key: 'Alt-Mod-r', run: cmd('footnote') },
  { key: 'Alt-Mod-l', run: cmd('linkReferenceDefinition') },
  { key: 'Mod-/', run: cmd('toggleSource') },
  { key: 'F8', run: cmd('toggleFocus') },
  { key: 'F9', run: cmd('toggleTypewriter') },
  { key: 'Shift-Mod-l', run: cmd('toggleSidebar') },
  { key: 'Ctrl-Mod-1', run: cmd('sidebarOutline') },
  { key: 'Ctrl-Mod-2', run: cmd('sidebarListFiles') },
  { key: 'Ctrl-Mod-3', run: cmd('sidebarTree') },
  { key: 'Mod-s', run: cmd('save') },
  { key: 'Alt-Shift-Mod-s', run: cmd('saveAs') },
  { key: 'Mod-n', run: cmd('new') },
  { key: 'Mod-o', run: cmd('open') },
  { key: 'Shift-Mod-o', run: cmd('quickOpen') },
  { key: 'Mod-,', run: cmd('preferences') },
  { key: 'Mod-f', run: cmd('find') },
  { key: 'Alt-Mod-f', run: cmd('replace') },
  { key: 'Mod-g', run: cmd('findNext') },
  { key: 'Shift-Mod-g', run: cmd('findPrev') },
  { key: 'Shift-Mod-=', run: cmd('zoomIn') },
  { key: 'Shift-Mod--', run: cmd('zoomOut') },
  { key: 'Shift-Mod-0', run: cmd('actualSize') },
  { key: 'Mod-p', run: cmd('print') },
  { key: 'Ctrl-Mod-f', run: cmd('fullscreen') },
  { key: 'Mod-l', run: selectLine },
  { key: 'Shift-Mod-Backspace', run: deleteLine },
  { key: 'Shift-Mod-d', run: cmd('duplicateLine') },
  { key: 'Mod-ArrowUp', run: cursorDocStart },
  { key: 'Mod-ArrowDown', run: cursorDocEnd },
  { key: 'Enter', run: (view) => insertCodeFenceLanguage(view) || insertNewlineContinueMarkup(view) },
  { key: 'Backspace', run: deleteMarkupBackward },
  { key: 'Tab', run: (view) => {
    if (inCode(view.state, view.state.selection.main.head)) { indentSelection(view); return true; }
    if (!/^(?:[ \t]*)(?:>|[-+*]\s|\d+[.)]\s)/.test(view.state.doc.lineAt(view.state.selection.main.head).text)) return false;
    indentSelection(view); return true;
  } },
  { key: 'Shift-Tab', run: (view) => {
    if (inCode(view.state, view.state.selection.main.head)) {
      if (store.prefs.shiftTabAutoIndent) {
        const temporary = view.state.update({ effects: StateEffect.appendConfig.of(Prec.highest(indentUnit.of(' '.repeat(store.prefs.codeIndentSize)))) }).state;
        return autoIndentCode({ state: temporary, dispatch: transaction => view.dispatch({ changes: transaction.changes, selection: transaction.newSelection, userEvent: 'input.indent' }) });
      }
      outdentSelection(view); return true;
    }
    if (!/^(?:[ \t]*)(?:>|[-+*]\s|\d+[.)]\s)/.test(view.state.doc.lineAt(view.state.selection.main.head).text)) return false;
    outdentSelection(view); return true;
  } },
]);

export function createEditorState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      clipboardExtension,
      fileDropExtension(),
      editorPreferencesExtension(() => {
        const support = markdown({ base: commonmarkLanguage, codeLanguages: languages,
          extensions: [store.prefs.noAutoLink ? GFM.filter(extension => extension !== Autolink) : GFM, ...markdownInlineExtensions(store.prefs)] });
        support.language.parser = markdownPunctuationParser(support.language.parser, store.prefs);
        return support;
      }),
      formatKeymap,
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      EditorState.allowMultipleSelections.of(true),
      search({ createPanel: createSearchPanel }),
      modeCompartment.of(store.prefs.sourceMode ? sourceExtensions() : liveExtensions()),
      spellcheckCompartment.of(
        EditorView.contentAttributes.of({ spellcheck: store.prefs.spellcheck ? 'true' : 'false' }),
      ),
      focusModePlugin,
      editorTheme,
      EditorView.updateListener.of((u) => updateHandler?.(u)),
      keymap.of([...searchKeymap, ...historyKeymap]),
      keymap.of([indentWithTab]),
      keymap.of(defaultKeymap),
      EditorView.lineWrapping,
    ],
  });
}

export interface EditorHandle {
  view: EditorView;
  setLiveMode(live: boolean): void;
  setSpellcheck(on: boolean): void;
  /** Force re-computation of live preview / focus decorations. */
  refresh(): void;
}

export function createEditor(parent: HTMLElement, initialDoc: string): EditorHandle {
  const view = new EditorView({ state: createEditorState(initialDoc), parent });

  return {
    view,
    setLiveMode(live: boolean) {
      view.dispatch({
        effects: modeCompartment.reconfigure(live ? liveExtensions() : sourceExtensions()),
      });
    },
    setSpellcheck(on: boolean) {
      view.dispatch({
        effects: spellcheckCompartment.reconfigure(
          EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false' }),
        ),
      });
    },
    refresh() {
      refreshLivePreview(view);
    },
  };
}

// CM6 shell theme; colors come from CSS variables set by the active theme.
const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--paper)',
    color: 'var(--text)',
    fontSize: '16px',
  },
  '.cm-content': {
    fontFamily: 'var(--font-body)',
    caretColor: 'var(--text)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionMatch': { backgroundColor: 'var(--mark-bg)' },
  '.cm-searchMatch': {
    backgroundColor: 'var(--search-match, rgba(255, 213, 0, 0.35))',
    outline: 'none',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'var(--search-match-active, rgba(255, 150, 0, 0.5))',
  },
  '.cm-panels': {
    backgroundColor: 'var(--sidebar-bg)',
    color: 'var(--text)',
    borderBottom: '1px solid var(--border)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--paper)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
});
