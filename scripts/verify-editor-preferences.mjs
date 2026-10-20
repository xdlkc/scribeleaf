import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

await mkdir('.cache', { recursive: true });
const output = resolve('.cache/editor-preferences-check.cjs');
const source = String.raw`
import { EditorState, EditorSelection, StateEffect } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { startCompletion, currentCompletions, acceptCompletion, setSelectedCompletion, CompletionContext } from '@codemirror/autocomplete';
import { createEditorState } from './src/editor/setup.ts';
import { store } from './src/store.ts';
import { DEFAULT_PREFS, normalizeEditorPreferences } from './src/types.ts';
import { toggleList, toggleQuote, indentSelection, outdentSelection } from './src/editor/format.ts';
import { emojiCompletion, documentIndent } from './src/editor/preferences.ts';
import { EMOJI_NAMES } from './src/editor/emoji-data.ts';

const checks = [];
function check(name, condition, actual) {
  checks.push({ name, passed: !!condition, ...(actual === undefined ? {} : { actual }) });
  if (!condition) throw new Error(name + ': ' + JSON.stringify(actual));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function reset(patch = {}) { store.setPrefs({ ...DEFAULT_PREFS, sourceMode: true, ...patch }); }
function view(source = '', cursor = source.length) {
  const parent = document.createElement('div'); document.body.append(parent);
  const result = new EditorView({ state: createEditorState(source), parent });
  result.dispatch({ selection: { anchor: cursor } }); result.focus(); return result;
}
function close(v) { const parent = v.dom.parentElement; v.destroy(); parent?.remove(); }
function text(v, value) {
  const range = v.state.selection.main;
  const handled = v.state.facet(EditorView.inputHandler).some(handler => handler(v, range.from, range.to, value));
  if (!handled) v.dispatch(v.state.replaceSelection(value), { userEvent: 'input.type' });
}
function key(v, key, extra = {}) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  return runScopeHandlers(v, event, 'editor');
}
function clipboard(v, type = 'copy', nested) {
  const data = {};
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: {
    clearData: () => { for (const k of Object.keys(data)) delete data[k]; },
    setData: (type, value) => { data[type] = value; },
    getData: type => data[type] ?? '',
  } });
  (nested ?? v.contentDOM).dispatchEvent(event);
  return { data, prevented: event.defaultPrevented };
}
function selectAll(v) { v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }); }

async function run() {
  check('legacy-prefs-theme-preserved', store.prefs.theme === 'night', store.prefs.theme);
  check('legacy-prefs-zoom-preserved', store.prefs.zoom === 125, store.prefs.zoom);
  check('legacy-prefs-new-flags-filled', typeof store.prefs.autoPairBrackets === 'boolean' && store.prefs.indentSize === 2);
  const invalid = normalizeEditorPreferences({ indentSize: 100, autoPairBrackets: 'false', prettyIndent: null });
  check('invalid-indent-normalized', invalid.indentSize === 2);
  check('invalid-boolean-not-truthy', invalid.autoPairBrackets === true && invalid.prettyIndent === false);
  reset();
  let v = view(); text(v, '(');
  check('bracket-input-produces-pair', v.state.doc.toString() === '()' && v.state.selection.main.head === 1);
  text(v, ')'); check('closer-skips-existing-pair', v.state.doc.toString() === '()' && v.state.selection.main.head === 2);
  check('pair-undo', undo(v) && v.state.doc.toString() === ''); close(v);
  v = view(); text(v, '['); key(v, 'Backspace');
  check('backspace-deletes-pair-before-markup', v.state.doc.toString() === ''); close(v);
  v = view('word'); selectAll(v); text(v, '(');
  check('bracket-surrounds-selection', v.state.doc.toString() === '(word)' && v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) === 'word'); close(v);
  v = view(); text(v, '（'); check('cjk-brackets-pair', v.state.doc.toString() === '（）'); close(v);
  v = view(); store.setPrefs({ autoPairBrackets: false }); text(v, '(');
  check('pair-setting-reconfigures-live-editor', v.state.doc.toString() === '(');
  store.setPrefs({ autoPairBrackets: true }); text(v, '[');
  check('pair-setting-can-reenable', v.state.doc.toString() === '([]'); close(v);
  reset({ autoPairMarkdown: false }); v = view(); text(v, '*');
  check('markdown-pair-off-leaves-single-symbol', v.state.doc.toString() === '*'); close(v);
  reset({ autoPairMarkdown: true });
  for (const symbol of ['*', '_', '~', String.fromCharCode(96), '$']) {
    v = view(); text(v, symbol);
    check('markdown-pair-on-' + symbol.charCodeAt(0), v.state.doc.toString() === symbol + symbol, v.state.doc.toString()); close(v);
  }
  reset({ autoPairBrackets: false, autoPairMarkdown: true }); v = view(); text(v, '*');
  check('markdown-pair-depends-on-brackets', v.state.doc.toString() === '*'); close(v);
  reset({ autoPairMarkdown: true }); const fence = String.fromCharCode(96).repeat(3);
  v = view(fence + 'js\n\n' + fence, fence.length + 3); text(v, '*');
  check('markdown-symbol-not-paired-in-code', v.state.doc.toString() === fence + 'js\n*\n' + fence, v.state.doc.toString()); close(v);
  reset();
  check('emoji-open-data-vocabulary', Object.keys(EMOJI_NAMES).length > 1400 && EMOJI_NAMES.smile === '😄', Object.keys(EMOJI_NAMES).length);
  v = view(':sm'); startCompletion(v); await wait(150);
  const suggestions = currentCompletions(v.state);
  const index = suggestions.findIndex(item => item.label === ':smile:');
  check('emoji-real-completion-popup', index >= 0, suggestions.slice(0, 5).map(x => x.label));
  v.dispatch({ effects: setSelectedCompletion(index) });
  await wait(100); // CM rejects acceptance during its 75ms popup interaction delay.
  check('emoji-real-accept', acceptCompletion(v));
  check('emoji-inserts-unicode', v.state.doc.toString() === '😄', v.state.doc.toString());
  check('emoji-insertion-undo', undo(v) && v.state.doc.toString() === ':sm');
  store.setPrefs({ emojiAutoComplete: false });
  check('emoji-disable-removes-completions', currentCompletions(v.state).length === 0);
  check('emoji-source-honors-disable', emojiCompletion(new CompletionContext(v.state, 3, true)) === null); close(v);
  reset();
  v = view(fence + '\n:sm\n' + fence, fence.length + 4);
  check('emoji-not-offered-in-code', emojiCompletion(new CompletionContext(v.state, v.state.selection.main.head, true)) === null); close(v);
  v = view('https://sm');
  check('emoji-not-triggered-in-url', emojiCompletion(new CompletionContext(v.state, v.state.selection.main.head, true)) === null); close(v);
  for (const size of [2, 3, 4, 5, -1]) {
    reset({ indentSize: size }); v = view('- item'); indentSelection(v);
    const unit = size === -1 ? '\t' : ' '.repeat(size);
    check('list-indent-' + size, v.state.doc.toString() === unit + '- item', v.state.doc.toString());
    outdentSelection(v); check('list-outdent-' + size, v.state.doc.toString() === '- item'); close(v);
  }
  reset({ indentSize: 4 }); v = view('- item'); key(v, 'Tab');
  check('tab-uses-list-indent-setting', v.state.doc.toString() === '    - item');
  key(v, 'Tab', { shiftKey: true }); check('shift-tab-outdents-list', v.state.doc.toString() === '- item'); close(v);
  reset({ indentSize: 0 });
  check('auto-indent-detects-four-spaces', documentIndent('- one\n    - two') === '    ');
  check('auto-indent-detects-tab', documentIndent('- one\n\t- two') === '\t');
  check('auto-indent-ignores-fenced-list', documentIndent(fence + '\n - code\n' + fence + '\n- a\n    - b') === '    ');
  reset({ indentSize: 4, prettyIndent: true }); v = view('one\ntwo'); selectAll(v); toggleList(v, 'bullet');
  check('pretty-bullet-marker-padding', v.state.doc.toString() === '-   one\n-   two', v.state.doc.toString()); close(v);
  v = view('one\ntwo'); selectAll(v); toggleList(v, 'ordered');
  check('pretty-ordered-marker-padding', v.state.doc.toString() === '1.  one\n2.  two'); close(v);
  v = view('word'); toggleQuote(v);
  check('pretty-quote-marker-padding', v.state.doc.toString() === '>   word');
  toggleQuote(v); check('pretty-quote-toggle-roundtrip', v.state.doc.toString() === 'word'); close(v);
  reset({ indentSize: 4, prettyIndent: false }); v = view('word'); toggleQuote(v);
  check('plain-quote-padding', v.state.doc.toString() === '> word'); close(v);
  reset({ sourceMode: false, copyMarkdownAsPlainText: false }); v = view('# Title\n\n**bold** [link](https://example.test)'); selectAll(v);
  let copied = clipboard(v);
  check('rendered-copy-plain-removes-markup', copied.data['text/plain'] === 'Title\n\nbold link', copied.data['text/plain']);
  check('rendered-copy-html-keeps-format', copied.data['text/html'].includes('<strong>bold</strong>') && copied.data['text/html'].includes('https://example.test'));
  store.setPrefs({ copyMarkdownAsPlainText: true }); copied = clipboard(v);
  check('markdown-copy-source-exact', copied.data['text/plain'] === v.state.doc.toString());
  store.setPrefs({ copyMarkdownAsPlainText: false, sourceMode: true }); copied = clipboard(v);
  check('source-mode-copy-stays-source', copied.data['text/plain'] === v.state.doc.toString()); close(v);
  reset({ sourceMode: false, lineWiseCopyCut: false }); v = view('first\nsecond', 1);
  copied = clipboard(v); check('no-selection-copy-disabled', copied.prevented && Object.keys(copied.data).length === 0);
  clipboard(v, 'cut'); check('no-selection-cut-disabled-preserves-document', v.state.doc.toString() === 'first\nsecond');
  store.setPrefs({ lineWiseCopyCut: true, copyMarkdownAsPlainText: true }); copied = clipboard(v);
  check('no-selection-line-copy-enabled', copied.data['text/plain'] === 'first\n', copied.data);
  copied = clipboard(v, 'cut'); check('no-selection-line-cut-enabled', copied.data['text/plain'] === 'first\n' && v.state.doc.toString() === 'second');
  check('line-cut-real-undo', undo(v) && v.state.doc.toString() === 'first\nsecond'); close(v);
  for (const lineBreak of ['\n', '\r\n']) {
    for (const trailing of [false, true]) {
      const original = ['first', 'second', 'tail'].join(lineBreak) + (trailing ? lineBreak : '');
      for (const rows of [[1, 2], [1, 3], [1, 2, 3]]) {
        reset({ sourceMode: true, lineWiseCopyCut: true });
        v = view(original, 0);
        v.setState(createEditorState(original).update({
          effects: StateEffect.appendConfig.of(EditorState.lineSeparator.of(lineBreak)),
        }).state);
        v.dispatch({ selection: EditorSelection.create(rows.map(row => EditorSelection.cursor(v.state.doc.line(row).from + 1))) });
        const label = (lineBreak === '\n' ? 'lf' : 'crlf') + (trailing ? '-trailing' : '-unterminated') + '-' + rows.join('-');
        const expected = rows.map(row => ['first', 'second', 'tail'][row - 1] + (row < 3 || trailing ? lineBreak : '')).join('');
        copied = clipboard(v);
        check('multi-line-copy-no-added-newline-' + label, copied.data['text/plain'] === expected, copied.data['text/plain']);
        check('multi-line-copy-source-unchanged-' + label, v.state.sliceDoc() === original, v.state.sliceDoc());
        copied = clipboard(v, 'cut');
        check('multi-line-cut-no-added-newline-' + label, copied.data['text/plain'] === expected, copied.data['text/plain']);
        const remaining = [1, 2, 3].filter(row => !rows.includes(row))
          .map(row => ['first', 'second', 'tail'][row - 1] + (row < 3 || trailing ? lineBreak : '')).join('');
        check('multi-line-cut-exact-source-' + label, v.state.sliceDoc() === remaining, v.state.sliceDoc());
        check('multi-line-cut-undo-exact-source-' + label, undo(v) && v.state.sliceDoc() === original, v.state.sliceDoc());
        close(v);
      }
    }
    reset({ sourceMode: true, lineWiseCopyCut: true }); v = view('first' + lineBreak + 'second', 0);
    v.setState(createEditorState('first' + lineBreak + 'second').update({
      effects: StateEffect.appendConfig.of(EditorState.lineSeparator.of(lineBreak)),
    }).state);
    v.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]) });
    copied = clipboard(v);
    check('multi-cursor-same-line-copy-dedup-' + JSON.stringify(lineBreak), copied.data['text/plain'] === 'first' + lineBreak, copied.data['text/plain']);
    copied = clipboard(v, 'cut');
    check('multi-cursor-same-line-cut-dedup-' + JSON.stringify(lineBreak), copied.data['text/plain'] === 'first' + lineBreak && v.state.sliceDoc() === 'second');
    check('multi-cursor-same-line-cut-undo-' + JSON.stringify(lineBreak), undo(v) && v.state.sliceDoc() === 'first' + lineBreak + 'second'); close(v);
  }
  reset({ copyMarkdownAsPlainText: true }); v = view('abcd'); v.dispatch({ selection: { anchor: 1, head: 3 } });
  copied = clipboard(v, 'cut'); check('selected-cut-exact-range', copied.data['text/plain'] === 'bc' && v.state.doc.toString() === 'ad');
  check('selected-cut-undo', undo(v) && v.state.doc.toString() === 'abcd'); close(v);
  reset({ sourceMode: false }); v = view('| A | B |\n| --- | --- |\n| cell | value |\n\nbackground'); await wait(30);
  const originalTableSource = v.state.doc.toString();
  const cell = v.contentDOM.querySelector('.lp-cell');
  check('nested-cell-is-real-table-widget', !!cell);
  cell.focus();
  copied = clipboard(v, 'cut', cell);
  check('nested-cell-copy-not-intercepted', Object.keys(copied.data).length === 0 && v.state.doc.toString() === originalTableSource); close(v);
  reset({ sourceMode: false, expandSimpleBlocks: false }); v = view('# Heading', 3); await wait(30);
  check('simple-heading-source-hidden-on-focus', !v.contentDOM.querySelector('.cm-heading-mark'));
  store.setPrefs({ expandSimpleBlocks: true }); await wait(30);
  check('simple-heading-source-visible-on-focus', !!v.contentDOM.querySelector('.cm-heading-mark'));
  check('simple-source-toggle-is-lossless', v.state.doc.toString() === '# Heading'); close(v);
  reset({ sourceMode: false, expandSimpleBlocks: false }); v = view('Heading\n=======', 3); await wait(30);
  check('setext-source-hidden-on-focus', !v.contentDOM.querySelector('.cm-heading-mark'));
  store.setPrefs({ expandSimpleBlocks: true }); await wait(30);
  check('setext-source-expands-as-one-block', !!v.contentDOM.querySelector('.cm-heading-mark'));
  check('setext-source-toggle-is-lossless', v.state.doc.toString() === 'Heading\n======='); close(v);
  reset(); v = view();
  v.setState(createEditorState('')); store.setPrefs({ autoPairBrackets: false }); text(v, '(');
  check('replacement-editor-reads-latest-settings', v.state.doc.toString() === '('); close(v);
  store.setPrefs({ indentSize: 5, prettyIndent: true, autoPairBrackets: false, typewriterAlwaysCenter: true });
  const saved = JSON.parse(localStorage.getItem('typora-replica:prefs'));
  check('editor-fields-persist-through-existing-store', saved.indentSize === 5 && saved.prettyIndent === true && saved.autoPairBrackets === false && saved.typewriterAlwaysCenter === true);
  store.applyHydratedPrefs({ indentSize: 3, autoPairBrackets: true });
  check('native-hydrate-normalizes-and-applies-editor-fields', store.prefs.indentSize === 3 && store.prefs.autoPairBrackets === true);
}
run().then(() => { console.log('EDITOR_PREFS_JSON:' + JSON.stringify({ passed: true, checks })); }).catch(error => {
  console.log('EDITOR_PREFS_JSON:' + JSON.stringify({ passed: false, checks, error: error.stack })); process.exitCode = 1;
});
`;
const banner = `
const { JSDOM } = require('jsdom');
const __dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' });
__dom.window.Range.prototype.getClientRects = () => [];
__dom.window.Range.prototype.getBoundingClientRect = () => new __dom.window.DOMRect();
for (const key of ['window','document','Node','Document','Element','HTMLElement','Window','DocumentFragment','DOMParser','Blob','File','FileReader','Event','InputEvent','CustomEvent','MutationObserver','localStorage']) globalThis[key] = key === 'window' ? __dom.window : __dom.window[key];
globalThis.getComputedStyle = __dom.window.getComputedStyle.bind(__dom.window);
globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
__dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
__dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
localStorage.setItem('typora-replica:prefs', JSON.stringify({ theme: 'night', zoom: 125, autoSave: true }));
`;
let result;
try {
  await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' }, outfile: output,
    bundle: true, platform: 'node', format: 'cjs', external: ['jsdom'], loader: { '.css': 'empty' }, banner: { js: banner } });
  let stdout;
  try { stdout = execFileSync(process.execPath, [output], { encoding: 'utf8', timeout: 30000 }); }
  catch (error) { stdout = error.stdout ?? ''; if (error.stderr) process.stderr.write(error.stderr); process.exitCode = 1; }
  const line = stdout.split('\n').find(line => line.startsWith('EDITOR_PREFS_JSON:'));
  if (!line) throw new Error('Missing verifier result: ' + stdout.slice(-2000));
  result = JSON.parse(line.slice('EDITOR_PREFS_JSON:'.length));
} catch (error) { result = { passed: false, error: String(error), checks: [] }; process.exitCode = 1; }
finally { await rm(output, { force: true }); }
const sources = ['src/types.ts','src/store.ts','src/editor/preferences.ts','src/editor/setup.ts','src/editor/format.ts','src/editor/livepreview.ts','src/editor/clipboard.ts','src/editor/emoji-data.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
await writeFile('evidence/editor-preferences-verification.json', JSON.stringify({ generatedAt: new Date().toISOString(),
  scope: 'Real CodeMirror 6 state/view/input handlers, autocomplete, DOM clipboard events, history and live-preview DOM in jsdom. No native GUI, system clipboard, geometry, IME candidate UI or full Typora parity claim.',
  command: 'node scripts/verify-editor-preferences.mjs', sourceHashes, ...result,
  total: result.checks.length, passedCount: result.checks.filter(x => x.passed).length,
  externalData: 'evidence/emoji-data-source.json',
  limitations: ['Typora native factory defaults are not proven by renderer baselines.', 'Emoji aliases come from MIT markdown-it-emoji 3.0.0, not Typora; exact vocabulary parity remains unproven.', 'Clipboard HTML uses independent MarkdownIt/product rendering; math/diagram/style clipboard fidelity remains unproven.', 'typewriterAlwaysCenter consumer in main.ts is coordinated and verified separately.']
}, null, 2) + '\n');
console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.checks.filter(x => x.passed).length}/${result.checks.length} editor preferences`);
if (!result.passed) { console.error(result.error); process.exitCode = 1; }
