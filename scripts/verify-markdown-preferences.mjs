import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

await mkdir('.cache', { recursive: true });
const output = resolve('.cache/markdown-preferences-check.cjs');
const source = String.raw`
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { undo } from '@codemirror/commands';
import { createEditorState } from './src/editor/setup.ts';
import { store } from './src/store.ts';
import { DEFAULT_PREFS } from './src/types.ts';
import { DEFAULT_MARKDOWN_PREFERENCES, freezeMarkdownPreferences, normalizeMarkdownPreferences, markdownOutputCSS } from './src/markdown-preferences.ts';
import { createMarkdownRenderer, renderClipboardMarkdown } from './src/markdown-renderer.ts';
import { buildStandaloneHtml } from './src/export.ts';
import { scanProductMarkdown } from './src/editor/product-markdown.ts';
import { setHeading, changeHeadingLevel, toggleList, insertCodeFence, indentSelection, outdentSelection } from './src/editor/format.ts';
const checks = [];
const knownGaps = {};
function check(name, passed, actual) { checks.push({ name, passed: !!passed, ...(actual === undefined ? {} : { actual }) }); if (!passed) throw Error(name + ': ' + JSON.stringify(actual)); }
const wait = ms => new Promise(r => setTimeout(r, ms));
const fence = String.fromCharCode(96).repeat(3);
const html = (source, patch = {}, writing = false) => { const { md } = createMarkdownRenderer({ ...DEFAULT_MARKDOWN_PREFERENCES, ...patch }, { forWriting: writing }); return md.render(source); };
function reset(patch = {}) { store.setPrefs({ ...DEFAULT_PREFS, sourceMode: true, ...patch }); }
function view(source = '', cursor) { const parent = document.createElement('div'); document.body.append(parent); const v = new EditorView({ state: createEditorState(source), parent }); v.dispatch({ selection: { anchor: cursor ?? v.state.doc.length } }); v.focus(); return v; }
function close(v) { const p = v.dom.parentElement; v.destroy(); p?.remove(); }
function selectAll(v) { v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }); }
function text(v, value) { const r = v.state.selection.main; if (!v.state.facet(EditorView.inputHandler).some(h => h(v, r.from, r.to, value))) v.dispatch(v.state.replaceSelection(value), { userEvent: 'input.type' }); }
function key(v, key, extra = {}) { return runScopeHandlers(v, new window.KeyboardEvent('keydown', { key, ...extra }), 'editor'); }
function elements(value) { const t = document.createElement('template'); t.innerHTML = value; return t.content; }
async function run() {
  const fallback = normalizeMarkdownPreferences(null);
  check('old-prefs-preserve-enabled-syntax', fallback.enableInlineMath && fallback.enableSubscript && fallback.enableSuperscript && fallback.enableHighlight && fallback.enableDiagram);
  const invalid = normalizeMarkdownPreferences({ headingStyle: 8, codeIndentSize: 100, noAutoLink: 'true', defaultCodeLang: 'js\nBAD' });
  check('invalid-enums-normalize', invalid.headingStyle === 0 && invalid.codeIndentSize === 4 && invalid.noAutoLink === false);
  check('language-does-not-inject-lines', invalid.defaultCodeLang === 'jsBAD');
  const mutable = { enableHighlight: false }; const frozen = freezeMarkdownPreferences(mutable); mutable.enableHighlight = true;
  check('snapshot-independent-and-frozen', Object.isFrozen(frozen) && frozen.enableHighlight === false);
  for (const [key, source, tag] of [['enableSubscript','H~2~O','sub'],['enableSuperscript','X^2^','sup'],['enableHighlight','==key==','mark'],['enableInlineMath','$x+1$','math']]) {
    check('html-' + key + '-on', !!elements(html(source, { [key]: true })).querySelector(tag));
    check('html-' + key + '-off', !elements(html(source, { [key]: false })).querySelector(tag));
  }
  check('html-autolink-on', !!elements(html('https://example.test')).querySelector('a'));
  check('html-autolink-off', !elements(html('https://example.test', { noAutoLink: true })).querySelector('a'));
  check('explicit-link-stays-when-autolink-off', !!elements(html('[link](https://example.test)', { noAutoLink: true })).querySelector('a'));
  check('alert-on', !!elements(html('> [!NOTE]\n> hello')).querySelector('.md-alert-note'));
  check('alert-off', !elements(html('> [!NOTE]\n> hello', { enableAlert: false })).querySelector('.md-alert'));
  const diagram = createMarkdownRenderer({ enableDiagram: true }); diagram.md.render(fence + 'mermaid\ngraph TD; A-->B;\n' + fence);
  check('diagram-queued-only-when-enabled', diagram.mermaidSources.length === 1);
  const codeDiagram = createMarkdownRenderer({ enableDiagram: false });
  check('diagram-off-is-code', !!elements(codeDiagram.md.render(fence + 'mermaid\ngraph TD; A-->B;\n' + fence)).querySelector('pre code') && codeDiagram.mermaidSources.length === 0);
  const queueA = createMarkdownRenderer({}); const queueB = createMarkdownRenderer({});
  queueA.md.render(fence + 'mermaid\nA\n' + fence); queueB.md.render(fence + 'mermaid\nB\n' + fence);
  check('mermaid-queues-are-request-local', queueA.mermaidSources[0] === 'A\n' && queueB.mermaidSources[0] === 'B\n');
  check('code-math-enabled', !!elements(html(fence + 'math\nx^2\n' + fence, { gitlabMath: true })).querySelector('math'));
  check('code-math-disabled', !!elements(html(fence + 'math\nx^2\n' + fence, { gitlabMath: false })).querySelector('pre code'));
  for (const source of ['\\(x+1\\)', '\\[x+1\\]', '\\[\nx+1\n\\]']) {
    check('legacy-delimiter-on-' + JSON.stringify(source), !!elements(html(source, { noLegacyMath: false })).querySelector('math'));
    check('legacy-delimiter-off-' + JSON.stringify(source), !elements(html(source, { noLegacyMath: true })).querySelector('math'));
  }
  check('strict-heading-requires-space', !elements(html('#Loose', { strictMarkdown: true })).querySelector('h1'));
  check('relaxed-heading-allows-no-space', !!elements(html('#Loose', { strictMarkdown: false })).querySelector('h1'));
  check('relaxed-heading-does-not-rewrite-code', elements(html(fence + '\n#Loose\n' + fence)).querySelector('code')?.textContent === '#Loose\n');
  check('outline-scanner-reads-strict-mode', scanProductMarkdown('#Loose', freezeMarkdownPreferences({ strictMarkdown: true })).headings.length === 0 && scanProductMarkdown('#Loose', freezeMarkdownPreferences({ strictMarkdown: false })).headings.length === 1);
  check('outline-disabled-syntax-remains-literal', scanProductMarkdown('# ==key==', freezeMarkdownPreferences({ enableHighlight: false })).headings[0].text === '==key==');
  check('smart-quotes-rendered-independently', elements(html('"hello" -- world', { convertSmartOnRender: true, smartQuote: true, smartDash: false })).textContent?.includes('“hello” -- world'));
  check('smart-dashes-rendered-independently', elements(html('"hello" -- world', { convertSmartOnRender: true, smartQuote: false, smartDash: true })).textContent?.includes('"hello" – world'));
  check('smart-render-skips-inline-code', elements(html(String.fromCharCode(96) + '"raw" --' + String.fromCharCode(96), { convertSmartOnRender: true, smartQuote: true, smartDash: true })).querySelector('code')?.textContent === '"raw" --');
  check('unicode-punctuation-parses-quote', !!elements(html('》 quoted', { remapPunctuation: true })).querySelector('blockquote'));
  check('unicode-punctuation-off-keeps-text', !elements(html('》 quoted', { remapPunctuation: false })).querySelector('blockquote'));
  check('unicode-remap-does-not-change-code', elements(html(fence + '\n“raw” —\n' + fence, { remapPunctuation: true })).querySelector('code')?.textContent === '“raw” —\n');
  const ticks = String.fromCharCode(96).repeat(2);
  check('unicode-remap-preserves-multi-tick-code', elements(html(ticks + '“raw” ' + String.fromCharCode(96) + ' —' + ticks, { remapPunctuation: true })).querySelector('code')?.textContent === '“raw” ' + String.fromCharCode(96) + ' —');
  const numbered = elements(html(fence + 'js\none();\ntwo();\n' + fence, { showLineNumbersForFence: true }));
  check('html-code-line-numbers', numbered.querySelector('.md-code-gutter')?.textContent === '1\n2');
  check('html-code-line-numbers-off', !elements(html(fence + '\none\n' + fence)).querySelector('.md-code-gutter'));
  check('html-code-wrapping-setting', markdownOutputCSS(freezeMarkdownPreferences({ noLineWrapping: true })).includes('white-space:pre}'));
  check('html-first-line-indent', markdownOutputCSS(freezeMarkdownPreferences({ indentFirstLine: true })).includes('text-indent:2em'));
  check('html-export-whitespace-independent', html('one  two\nthree', { preLinebreakOnExport: true }).includes('<br>') && !html('one  two\nthree', { preLinebreakOnExport: false }).includes('<br>'));
  check('clipboard-writing-whitespace-independent', renderClipboardMarkdown('one\ntwo', { ignoreLineBreak: false, preLinebreakOnExport: false }).includes('<br>') && !renderClipboardMarkdown('one\ntwo', { ignoreLineBreak: true, preLinebreakOnExport: true }).includes('<br>'));
  check('clipboard-writing-sequential-spaces-preserved', elements(renderClipboardMarkdown('one  two', { ignoreLineBreak: false })).querySelector('p')?.style.whiteSpace === 'pre-wrap');
  check('clipboard-latex-source-option', !elements(renderClipboardMarkdown('$x$', { mathFormatOnCopy: 'latex' })).querySelector('math') && renderClipboardMarkdown('$x$', { mathFormatOnCopy: 'latex' }).includes('$x$'));
  const equations = elements(html('$$a$$\n\n$$b$$', { autoNumberingForMath: 'all' }));
  check('display-equation-numbering', [...equations.querySelectorAll('math')].every((m, i) => m.textContent.includes('(' + (i + 1) + ')')), equations.textContent);
  const amsSource = '$$\n\\begin{align}\na&=b\\\\\nc&=d\n\\end{align}\n$$';
  const amsHTML = html(amsSource, { autoNumberingForMath: 'ams' });
  knownGaps.amsMultiline = { source: amsSource, outputText: elements(amsHTML).textContent, hasKatexError: amsHTML.includes('katex-error'), scope: 'Actual current pipeline witness; original Typora uses MathJax AMS tags. No equivalence claim.' };
  const requestPrefs = { enableHighlight: true, noLineWrapping: false };
  const pending = buildStandaloneHtml('Snapshot', '==key==', 'github', { markdownPreferences: requestPrefs, fontSize: '24px', imageWidth: 320, nativePrint: true });
  requestPrefs.enableHighlight = false; requestPrefs.noLineWrapping = true;
  const standalone = await pending;
  check('export-request-freezes-syntax', !!elements(standalone).querySelector('mark'));
  check('export-request-freezes-style', !standalone.includes('white-space:pre}'));
  check('export-preserves-root-font-contract', standalone.includes('font-size:24px!important;--content-rem:1rem'));
  check('export-preserves-image-width-contract', standalone.includes('width:320px'));
  check('native-print-does-not-restore-css-page-margins', !standalone.includes('@page{margin:2cm;}'));
  const plain = await buildStandaloneHtml('Plain', '# Heading\n\n$x$', 'github', { withoutStyles: true });
  check('unstyled-export-keeps-zero-style-contract', !elements(plain).querySelector('style') && !plain.includes('@font-face'));
  const latexPlain = await buildStandaloneHtml('Plain', '$x$', 'github', { withoutStyles: true, markdownPreferences: freezeMarkdownPreferences({ mathFormatOnCopy: 'latex' }) });
  check('unstyled-latex-math-remains-source', !elements(latexPlain).querySelector('math') && latexPlain.includes('$x$'));
  let v;
  for (const [key, sample, node] of [['enableSubscript','H~2~O','Subscript'],['enableSuperscript','X^2^','Superscript'],['enableHighlight','==key==','HighlightMark'],['enableInlineMath','$x$','InlineMath']]) {
    reset({ [key]: true }); v = view(sample);
    check('cm-' + key + '-on', syntaxTree(v.state).toString().includes(node), syntaxTree(v.state).toString());
    store.setPrefs({ [key]: false });
    check('cm-' + key + '-off-after-live-change', !syntaxTree(v.state).toString().includes(node), syntaxTree(v.state).toString());
    check('cm-syntax-toggle-source-lossless-' + key, v.state.doc.toString() === sample); close(v);
  }
  reset({ noAutoLink: false }); v = view('https://example.test'); check('cm-autolink-on', syntaxTree(v.state).toString().includes('URL'));
  store.setPrefs({ noAutoLink: true }); check('cm-autolink-off', !syntaxTree(v.state).toString().includes('URL')); close(v);
  reset({ strictMarkdown: false }); v = view('#Loose'); check('cm-relaxed-heading', syntaxTree(v.state).toString().includes('ATXHeading1'));
  store.setPrefs({ strictMarkdown: true }); check('cm-strict-heading', !syntaxTree(v.state).toString().includes('ATXHeading1')); close(v);
  reset({ remapPunctuation: true }); v = view('》 quoted'); check('cm-remapped-quote', syntaxTree(v.state).toString().includes('Blockquote'), syntaxTree(v.state).toString());
  check('cm-remap-source-lossless', v.state.doc.toString() === '》 quoted'); close(v);
  for (const style of [0, 1, 2, 3]) {
    reset({ headingStyle: style }); v = view('Title'); setHeading(v, 1);
    check('heading-style-' + style, v.state.doc.toString() === ['# Title','Title\n===','# Title #','Title\n====='][style], v.state.doc.toString());
    setHeading(v, 0); check('heading-style-to-paragraph-' + style, v.state.doc.toString() === 'Title'); close(v);
  }
  reset({ headingStyle: 1 }); v = view('Title'); setHeading(v, 1); changeHeadingLevel(v, 1);
  check('setext-h1-raise-noop', v.state.doc.toString() === 'Title\n===');
  changeHeadingLevel(v, -1); check('setext-heading-lowers-to-h2', v.state.doc.toString() === 'Title\n---');
  changeHeadingLevel(v, -1); check('setext-h2-lowers-to-atx-h3', v.state.doc.toString() === '### Title'); close(v);
  for (const style of [0, 1, 2]) { reset({ ulStyle: style }); v = view('one\ntwo'); selectAll(v); toggleList(v, 'bullet'); check('unordered-style-' + style, v.state.doc.toString() === ['-','+','*'][style] + ' one\n' + ['-','+','*'][style] + ' two'); close(v); }
  reset({ olStyle: 1 }); v = view('one\ntwo'); selectAll(v); toggleList(v, 'ordered'); check('ordered-repeated-one-style', v.state.doc.toString() === '1. one\n1. two'); close(v);
  for (const origin of [1, 2, 3]) {
    reset({ defaultCodeLang: 'python', defaultCodeLangOption: origin }); v = view(''); insertCodeFence(v);
    check('default-code-language-menu-mask-' + origin, v.state.doc.toString().startsWith(origin & 2 ? fence + 'python\n' : fence + '\n')); close(v);
    v = view(fence); key(v, 'Enter'); check('default-code-language-markdown-mask-' + origin, v.state.doc.toString().startsWith(origin & 1 ? fence + 'python\n' : fence + '\n'), v.state.doc.toString()); close(v);
  }
  reset({ defaultCodeLang: '__LAST', defaultCodeLangOption: 2 }); v = view(fence + 'js\nlet n=1;\n' + fence + '\n\n'); insertCodeFence(v);
  check('default-code-language-last-used', v.state.doc.toString().endsWith(fence + 'js\n\n' + fence + '\n')); close(v);
  for (const size of [2, 3, 4, 5]) {
    reset({ codeIndentSize: size }); const original = fence + 'js\nvalue();\n' + fence; v = view(original, 7); indentSelection(v);
    check('fence-indent-size-' + size, v.state.doc.line(2).text === ' '.repeat(size) + 'value();');
    outdentSelection(v); check('fence-outdent-size-' + size, v.state.doc.toString() === original); close(v);
  }
  await languages.find(language => language.name === 'JavaScript').load();
  reset({ shiftTabAutoIndent: true, codeIndentSize: 4 });
  v = view(fence + 'js\nif (ok) {\nx();\n}\n' + fence, 17); await wait(30);
  v.dispatch({ selection: { anchor: v.state.doc.line(3).from, head: v.state.doc.line(3).to } });
  key(v, 'Tab', { shiftKey: true });
  check('shift-tab-auto-indent-uses-language-and-code-size', v.state.doc.line(3).text === '    x();', v.state.doc.toString());
  check('shift-tab-auto-indent-undo', undo(v) && v.state.doc.line(3).text === 'x();');
  store.setPrefs({ shiftTabAutoIndent: false });
  v.dispatch({ changes: { from: v.state.doc.line(3).from, insert: '    ' } });
  key(v, 'Tab', { shiftKey: true });
  check('shift-tab-disabled-outdents-instead', v.state.doc.line(3).text === 'x();', v.state.doc.toString()); close(v);
  reset({ smartQuote: true, autoPairBrackets: false, convertSmartOnRender: false }); v = view('can'); text(v, "'"); text(v, 't');
  check('smart-quote-on-input-stores-unicode', v.state.doc.toString() === 'can’t'); close(v);
  reset({ smartDash: true, convertSmartOnRender: false }); v = view(); text(v, '-'); text(v, '-'); check('smart-en-dash-input', v.state.doc.toString() === '–'); text(v, '-'); check('smart-em-dash-input', v.state.doc.toString() === '—'); close(v);
  reset({ sourceMode: false, smartQuote: true, smartDash: true, convertSmartOnRender: true }); v = view('"hello" -- world'); await wait(40);
  check('smart-render-preview-unicode', v.contentDOM.textContent.includes('“hello” – world'), v.contentDOM.textContent);
  check('smart-render-preserves-ascii-source', v.state.doc.toString() === '"hello" -- world'); close(v);
  reset({ sourceMode: false, showLineNumbersForFence: true, noLineWrapping: true }); v = view(fence + 'js\none();\ntwo();\n' + fence + '\n\nend'); await wait(40);
  check('cm-code-line-numbers', [...v.contentDOM.querySelectorAll('.cm-code-line-number')].map(n => n.textContent).join(',') === '1,2');
  check('cm-code-wrap-class', v.contentDOM.classList.contains('markdown-code-nowrap'));
  store.setPrefs({ showLineNumbersForFence: false }); check('cm-code-line-numbers-live-off', !v.contentDOM.querySelector('.cm-code-line-number')); close(v);
  reset({ sourceMode: false, gitlabMath: true }); v = view(fence + 'math\nx^2\n' + fence + '\n\nend'); await wait(60);
  check('cm-code-math-widget', !!v.contentDOM.querySelector('.lp-math-block math'));
  store.setPrefs({ gitlabMath: false }); await wait(30); check('cm-code-math-disables-to-code', !v.contentDOM.querySelector('.lp-math-block')); close(v);
  reset({ sourceMode: false, noLegacyMath: false }); v = view('\\[\nx+1\n\\]\n\nend'); await wait(60);
  check('cm-latex-display-widget', !!v.contentDOM.querySelector('.lp-math-block math'));
  store.setPrefs({ noLegacyMath: true }); await wait(30); check('cm-latex-display-disabled', !v.contentDOM.querySelector('.lp-math-block')); close(v);
  const amsSequence = '$$plain$$\n\n' + amsSource + '\n\nend';
  reset({ sourceMode: false, autoNumberingForMath: 'ams' }); v = view(amsSequence); await wait(60);
  const amsWidgets = [...v.contentDOM.querySelectorAll('.lp-math-block math')];
  check('cm-ams-skips-plain-display-number', amsWidgets.length === 2 && !amsWidgets[0].textContent.includes('(1)') && amsWidgets[1].textContent.includes('(1)'), amsWidgets.map(node => node.textContent)); close(v);
  reset({ sourceMode: false, hideBrAndLineBreak: false }); v = view('a<br/>b\n\nend'); await wait(30);
  check('cm-br-visible-mark', !!v.contentDOM.querySelector('.cm-br-mark'));
  store.setPrefs({ hideBrAndLineBreak: true }); check('cm-br-hidden-mark', !v.contentDOM.querySelector('.cm-br-mark'));
  check('cm-br-toggle-lossless', v.state.doc.toString() === 'a<br/>b\n\nend'); close(v);
  reset({ sourceMode: false, ignoreLineBreak: true, indentFirstLine: true }); v = view('one\ntwo\n\nend'); await wait(30);
  check('cm-writing-softbreak-collapses', v.contentDOM.querySelector('.cm-line')?.textContent === 'one two', v.contentDOM.innerHTML.slice(0,500));
  check('cm-writing-sequential-spaces-collapses-style', v.contentDOM.querySelector('.cm-line')?.style.whiteSpace === 'normal');
  check('cm-first-paragraph-indent-class', !!v.contentDOM.querySelector('.cm-markdown-paragraph-first'));
  check('cm-whitespace-view-is-lossless', v.state.doc.toString() === 'one\ntwo\n\nend'); close(v);
}
run().then(() => console.log('MARKDOWN_PREFS_JSON:' + JSON.stringify({ passed: true, checks, knownGaps }))).catch(error => { console.log('MARKDOWN_PREFS_JSON:' + JSON.stringify({ passed: false, checks, knownGaps, error: error.stack })); process.exitCode = 1; });
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
`;let result;
try {
  await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' }, outfile: output,
    bundle: true, platform: 'node', format: 'cjs', external: ['jsdom'], loader: { '.css': 'empty' }, banner: { js: banner },
    plugins: [{ name: 'raw-preference-evidence', setup(build) {
      build.onResolve({ filter: /\?(inline|raw)$/ }, async args => { const resolved = await build.resolve(args.path.replace(/\?(inline|raw)$/, ''), { resolveDir: args.resolveDir, kind: args.kind }); return { path: resolved.path, namespace: 'raw-preference' }; });
      build.onLoad({ filter: /.*/, namespace: 'raw-preference' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
    } }] });
  let stdout;
  try { stdout = execFileSync(process.execPath, [output], { encoding: 'utf8', timeout: 30000 }); }
  catch (error) { stdout = error.stdout ?? ''; if (error.stderr) process.stderr.write(error.stderr); process.exitCode = 1; }
  const line = stdout.split('\n').find(line => line.startsWith('MARKDOWN_PREFS_JSON:'));
  if (!line) throw Error('Missing result: ' + stdout.slice(-2000));
  result = JSON.parse(line.slice('MARKDOWN_PREFS_JSON:'.length));
} catch (error) { result = { passed: false, error: String(error), checks: [] }; process.exitCode = 1; }
finally { await rm(output, { force: true }); }
const sources = ['src/markdown-preferences.ts','src/markdown-renderer.ts','src/editor/setup.ts','src/editor/preferences.ts','src/editor/format.ts','src/editor/mathparser.ts','src/editor/widgets.ts','src/editor/livepreview.ts','src/editor/product-markdown.ts','src/editor/product-markdown.css','src/export.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async p => [p, createHash('sha256').update(await readFile(p)).digest('hex')])));
await writeFile('evidence/markdown-preferences-verification.json', JSON.stringify({ generatedAt: new Date().toISOString(), command: 'node scripts/verify-markdown-preferences.mjs',
  scope: 'Real CodeMirror state/view, input handlers and DOM widgets in jsdom; real shared MarkdownIt/KaTeX/HLJS HTML; standalone export request snapshot. No GUI/geometry or full Typora parser parity claim.', sourceHashes, ...result,
  total: result.checks.length, passedCount: result.checks.filter(c => c.passed).length,
  unsupported: ['complete physics macros','precise legacy inline-math regex compatibility','SVG math clipboard output'],
  partial: ['strict-mode fidelity beyond no-space ATX headings and CommonMark list rules','AMS equation environment/cross-reference parity','native system smart-quote patterns'],
}, null, 2) + '\n');
console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.checks.filter(c => c.passed).length}/${result.checks.length} markdown preferences`);
if (!result.passed) { console.error(result.error); process.exitCode = 1; }
