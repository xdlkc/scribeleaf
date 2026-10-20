import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { store } from '../store';
import { normalizeEditorPreferences, type EditorPreferences } from '../types';
import { EMOJI_NAMES } from './emoji-data';
import { refreshLivePreview } from './livepreview';
import { freezeMarkdownPreferences, smartPunctuation } from '../markdown-preferences';

export function inCode(state: EditorState, position: number, includeIndented = true): boolean {
  for (let node = syntaxTree(state).resolveInner(position, -1); node; node = node.parent!) {
    if (/^(?:FencedCode|InlineCode|HTMLBlock|CommentBlock|URL|LinkTitle)$/.test(node.name) || includeIndented && node.name === 'CodeBlock') return true;
  }
  return false;
}

/** The source returns Unicode text; the alias spelling is never inserted. */
export function emojiCompletion(context: CompletionContext) {
  if (!store.prefs.emojiAutoComplete || inCode(context.state, context.pos)) return null;
  const token = context.matchBefore(/:[+\-\w]*$/);
  if (!token || token.text.length < 2 && !context.explicit) return null;
  if (token.from > 0 && /[\w/:]/.test(context.state.sliceDoc(token.from - 1, token.from))) return null;
  return {
    from: token.from,
    options: Object.entries(EMOJI_NAMES).map(([name, emoji]) => ({
      label: `:${name}:`, displayLabel: `${emoji} :${name}:`, apply: emoji, type: 'text',
    })),
    validFor: /^:[+\-\w]*$/,
  };
}

function extensions(prefs: EditorPreferences): Extension {
  const pairs = prefs.autoPairBrackets ? [
    closeBrackets(),
    Prec.highest(EditorState.languageData.of((state, position) => [{
      closeBrackets: {
        brackets: ['(', '[', '{', "'", '"', '（', '【', '「', '『', '“', '‘',
          ...(prefs.autoPairMarkdown && !inCode(state, position) ? ['*', '_', '~', '`', '$'] : [])],
      },
    }])),
    // Delete both symbols before the Markdown list backspace command runs.
    Prec.highest(keymap.of(closeBracketsKeymap)),
  ] : [];
  return [pairs, ...(prefs.emojiAutoComplete ? [autocompletion({
    override: [emojiCompletion], activateOnTyping: true,
  })] : [])];
}

/** Each EditorState owns its compartment and subscription. setState/destroy
 * releases the previous subscription; new files do not inherit stale options. */
export function editorPreferencesExtension(markdownLanguage?: () => Extension): Extension {
  const compartment = new Compartment();
  const languageCompartment = new Compartment();
  const attributes = () => EditorView.contentAttributes.of({
    class: [store.prefs.indentFirstLine ? 'markdown-indent-first' : '', store.prefs.noLineWrapping ? 'markdown-code-nowrap' : ''].filter(Boolean).join(' '),
    style: `tab-size:${store.prefs.codeIndentSize ?? 4}`,
  });
  const markdownInput = Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
    const prefs = freezeMarkdownPreferences(store.prefs);
    if (view.composing || view.state.readOnly || prefs.convertSmartOnRender || inCode(view.state, from)) return false;
    let insert = smartPunctuation(text, prefs);
    if (prefs.smartQuote && (text === '"' || text === "'")) {
      const prior = view.state.sliceDoc(Math.max(0, from - 1), from);
      const opening = !prior || /[\s([{<]/.test(prior);
      insert = text === '"' ? opening ? '“' : '”' : opening ? '‘' : '’';
    }
    if (prefs.smartDash && text === '-' && from === to) {
      const before = view.state.sliceDoc(Math.max(0, from - 1), from);
      if (before === '-' || before === '–') { from--; insert = before === '-' ? '–' : '—'; }
    }
    if (insert === text && from === view.state.selection.main.from) return false;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type' });
    return true;
  }));
  return [markdownInput, ...(markdownLanguage ? [languageCompartment.of([markdownLanguage(), attributes()])] : []), compartment.of(extensions(store.prefs)), ViewPlugin.fromClass(class {
    private signature = JSON.stringify(normalizeEditorPreferences(store.prefs));
    private markdownSignature = JSON.stringify(freezeMarkdownPreferences(store.prefs));
    private unsubscribe: () => void;
    constructor(readonly view: EditorView) {
      this.unsubscribe = store.on('prefs', () => {
        const next = JSON.stringify(normalizeEditorPreferences(store.prefs));
        const markdownNext = JSON.stringify(freezeMarkdownPreferences(store.prefs));
        if (this.signature === next && this.markdownSignature === markdownNext) return;
        this.signature = next;
        this.markdownSignature = markdownNext;
        view.dispatch({ effects: [compartment.reconfigure(extensions(store.prefs)),
          ...(markdownLanguage ? [languageCompartment.reconfigure([markdownLanguage(), attributes()])] : [])] });
        refreshLivePreview(view);
      });
    }
    destroy() { this.unsubscribe(); }
  })];
}

export function documentIndent(source: string, configured = store.prefs.indentSize): string {
  if (configured === -1) return '\t';
  if (configured > 0) return ' '.repeat(configured);
  // Auto follows the smallest existing list indentation. Ignore fenced code.
  let fence: { char: string; length: number } | null = null;
  let size = Infinity;
  for (const line of source.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^(\s+)(?:[-+*]|\d+[.)])\s+/.exec(line);
    if (!match) continue;
    if (match[1].includes('\t')) return '\t';
    size = Math.min(size, match[1].length);
  }
  return ' '.repeat(Number.isFinite(size) ? size : 2);
}

export function markerSpace(marker: string, source: string): string {
  if (!store.prefs.prettyIndent) return ' ';
  const unit = documentIndent(source);
  if (unit === '\t') return '\t';
  return ' '.repeat(Math.max(1, unit.length - marker.length));
}
