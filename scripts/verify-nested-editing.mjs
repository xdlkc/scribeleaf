import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// These checks use real CodeMirror dispatch, DOM observation, widgets and
// keymaps. JSDOM has no layout and does not count as browser verification.
const require = createRequire(import.meta.url);
const cache = '.cache/nested-editing';
const bundle = resolve(cache, 'verification.cjs');
mkdirSync(cache, { recursive: true });
await build({
  stdin: { contents: `export {createEditor,createEditorState,setEditorUpdateHandler} from './src/editor/setup.ts';export {registerProductCommands} from './src/editor/product-commands.ts';export {runCommand} from './src/commands.ts';export {undo,redo} from '@codemirror/commands';export {EditorSelection} from '@codemirror/state';export {scanProductMarkdown} from './src/editor/product-markdown.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['mermaid'], loader: { '.css': 'empty' },
});
const dom = new JSDOM('<!doctype html><body><div id="editor"></div></body>', { pretendToBeVisual: true, url: 'http://localhost' });
const globals = ['Window', 'Document', 'Element', 'window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Text', 'DOMRect', 'Range', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame'];
const oldGlobals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { value: ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? dom.window[key].bind(dom.window) : dom.window[key], configurable: true, writable: true });
Object.defineProperty(dom.window.HTMLElement.prototype, 'isContentEditable', { get() { return this.contentEditable === 'true'; } });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
const results = [];
const assert = (condition, detail) => { if (!condition) throw new Error(JSON.stringify(detail)); };
const check = async (name, action) => { try { results.push({ name, passed: true, detail: await action() }); } catch (error) { results.push({ name, passed: false, detail: error.stack }); } };
const settle = () => new Promise(resolve => setTimeout(resolve, 35));
let handle;
try {
  const api = require(bundle);
  handle = api.createEditor(document.querySelector('#editor'), '');
  const v = handle.view;
  api.registerProductCommands(v);
  const edits = [];
  api.setEditorUpdateHandler(update => { for (const tr of update.transactions) if (tr.docChanged) tr.changes.iterChanges((from, to, _newFrom, _newTo, text) => edits.push({ from, to, text: text.toString() })); });
  let eol = '\n';
  const load = async (source, ranges) => {
    eol = source.includes('\r\n') ? '\r\n' : '\n';
    v.setState(api.createEditorState(source.replace(/\r\n/g, '\n')));
    const normalized = v.state.doc.toString();
    v.dispatch({ selection: ranges ? api.EditorSelection.create(ranges.map(([anchor, head = anchor]) => api.EditorSelection.range(anchor, head))) : { anchor: normalized.length } });
    v.focus(); edits.length = 0;
    await settle();
  };
  const source = () => v.state.doc.toString().replace(/\n/g, eol);
  const command = name => api.runCommand(name);
  const exact = expected => assert(source() === expected, { expected, actual: source() });
  const history = (before, after) => { exact(after); assert(api.undo(v), 'undo failed'); exact(before); assert(api.redo(v), 'redo failed'); exact(after); };
  const fixture = '> > - [x] checked\n> >   continuation\n> >   + [ ] nested task\n> >     continuation\n> >\n> > 12. [X] ordered\n> > 13. plain ordered\n> >\n> > * plain bullet\n\n> > ```md\n> > - [ ] fenced fake\n> > ```\n\n> >     - [ ] indented fake\n\n- [ ] root task\n\nTAIL';
  await check('Nested quote task/list widgets use parsed marker positions and hide task numbers (JSDOM)', async () => {
    await load(fixture);
    const boxes = [...document.querySelectorAll('.lp-checkbox')];
    const bullets = [...document.querySelectorAll('.cm-list-bullet')];
    const numbers = [...document.querySelectorAll('.cm-list-number')].map(node => node.textContent);
    assert(boxes.length === 4 && boxes.map(box => box.checked).join(',') === 'true,false,true,false', { checkboxes: boxes.map(box => box.checked), rendered: v.contentDOM.textContent });
    assert(bullets.length === 1 && numbers.join(',') === '13.', { bullets: bullets.length, numbers });
    exact(fixture);
    return { checkboxes: boxes.map(box => box.checked), bullets: bullets.length, numbers };
  });
  await check('Nested checkbox clicks edit one exact state character and support undo/redo (JSDOM)', async () => {
    await load(fixture);
    const positions = [fixture.indexOf('[x] checked'), fixture.indexOf('[ ] nested task'), fixture.indexOf('[X] ordered'), fixture.indexOf('[ ] root task')];
    for (let index = 0; index < positions.length; index++) {
      await load(fixture);
      const box = document.querySelectorAll('.lp-checkbox')[index];
      box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      const at = positions[index] + 1;
      const after = fixture.slice(0, at) + (fixture[at] === ' ' ? 'x' : ' ') + fixture.slice(at + 1);
      assert(edits.length === 1 && edits[0].from === at && edits[0].to === at + 1 && edits[0].text.length === 1, { index, edits });
      history(fixture, after);
    }
    return { clicked: positions.length, changedUnitsPerClick: 1 };
  });
  await check('Quoted/list-contained fences, indented code and HTML never create fake task widgets (JSDOM)', async () => {
    const before = '> > ```md\n> > - [ ] fake\n> > ```\n\n> >     - [ ] fake\n\n- item\n\n  ```md\n  - [ ] fake\n  ```\n\n<div>\n- [ ] fake\n</div>\n\nTAIL';
    await load(before);
    assert(!document.querySelector('.lp-checkbox') && !document.querySelector('.cm-list-number'), { rendered: v.contentDOM.textContent }); exact(before);
    return { fakeTaskWidgets: 0 };
  });
  await check('Repeated live/source switches retain exact nested source and selection (JSDOM)', async () => {
    await load(fixture, [[fixture.indexOf('nested task') + 3]]);
    const selection = v.state.selection.toJSON();
    for (let i = 0; i < 8; i++) { handle.setLiveMode(false); handle.setLiveMode(true); }
    exact(fixture); assert(JSON.stringify(selection) === JSON.stringify(v.state.selection.toJSON()), v.state.selection.toJSON());
    return { switches: 16, sourceLength: source().length, selection };
  });
  await check('Task continuation caret modifies its owner, including nested ordered tasks (JSDOM)', async () => {
    const cases = [
      ['> > - [ ] parent\n> >   continuation\n\nTAIL', 'continuation', '[ ] parent', '[x] parent'],
      ['> > - [x] parent\n> >   - [ ] child\n> >     child continuation\n\nTAIL', 'child continuation', '[ ] child', '[x] child'],
      ['> > 3. [X] ordered\n> >    continuation\n\nTAIL', 'continuation', '[X] ordered', '[ ] ordered'],
      ['- [ ] task\n\n  second paragraph\n\nTAIL', 'second paragraph', '[ ] task', '[x] task'],
    ];
    for (const [before, caret, from, to] of cases) {
      await load(before, [[before.indexOf(caret) + 2]]); command('toggleTaskState');
      assert(edits.length === 1 && edits[0].to - edits[0].from === 1, edits);
      history(before, before.replace(from, to));
    }
    return { cases: cases.length };
  });
  await check('Plain text, fake tasks and adjacent unowned paragraphs remain unchanged (JSDOM)', async () => {
    const before = '- [ ] actual\n  continuation\n\nplain paragraph\n\n> > ```md\n> > - [ ] fake\n> > ```\n\n    - [ ] code\n\n- ordinary\n  ordinary continuation';
    for (const caret of ['plain paragraph', '- [ ] fake', '- [ ] code', 'ordinary continuation']) {
      await load(before, [[before.indexOf(caret) + 3]]);
      for (const name of ['toggleTaskState', 'taskChecked', 'taskUnchecked']) { command(name); exact(before); }
      assert(edits.length === 0, { caret, edits });
    }
    return { unchangedCarets: 4 };
  });
  await check('Unclosed nested fences end with their quote/list container and do not mask later tasks (JSDOM)', async () => {
    const before = '> > ```md\n> > - [ ] fake\n\n- [ ] actual\n  continuation\n\nTAIL';
    await load(before, [[before.indexOf('continuation') + 2]]); command('toggleTaskState');
    history(before, before.replace('[ ] actual', '[x] actual'));
    await load(before);
    assert(document.querySelectorAll('.lp-checkbox').length === 1, v.contentDOM.textContent);
    return { realTaskWidgets: 1, quotedCodeUnchanged: true };
  });
  await check('Selection starting on a continuation uses its owner state for all selected tasks (JSDOM)', async () => {
    const before = '> > - [x] first\n> >   first continuation\n> > - [ ] second\n> >   second continuation\n> > - [X] unselected\n\nTAIL';
    await load(before, [[before.indexOf('first continuation') + 3, before.indexOf('> > - [X] unselected')]]);
    command('toggleTaskState'); history(before, before.replace('[x] first', '[ ] first'));
    await load(before, [[before.indexOf('second continuation') + 3, before.indexOf('first continuation') + 3]]);
    command('toggleTaskState'); history(before, before.replace('[x] first', '[ ] first'));
    return { forwardAndReverseSelections: true, excludedFinalTask: true };
  });
  await check('Multiple carets on one task deduplicate its state edit (JSDOM)', async () => {
    const before = '> > - [ ] task\n> >   first continuation\n> >   second continuation\n\nTAIL';
    await load(before, [[before.indexOf('first continuation')], [before.indexOf('second continuation')]]);
    command('taskChecked'); assert(edits.length === 1, edits); history(before, before.replace('[ ]', '[x]'));
    return { edits: 1 };
  });
  await check('CRLF serialization and unknown source survive nested task commands and modes (JSDOM)', async () => {
    const before = '\uFEFF> > - [X] 中文  \r\n> >   续行 {{unknown}}\r\n\r\nTAIL\r\n';
    const normalized = before.replace(/\r\n/g, '\n');
    await load(before, [[normalized.indexOf('续行') + 1]]); command('taskUnchecked');
    for (let i = 0; i < 3; i++) { handle.setLiveMode(false); handle.setLiveMode(true); }
    history(before, before.replace('[X]', '[ ]'));
    assert(!/(?<!\r)\n/.test(source()), source());
    return { serializedCRLF: true, bomRetained: source().startsWith('\uFEFF') };
  });
  await check('Reference allocation sees nested quote/list definitions, case and parsed labels (JSDOM)', async () => {
    const before = 'selected\n\n> > [ReF]: https://example.com/one\n\n- item\n\n  [rEf-2]: https://example.com/two\n\n[ ref-3 ]: https://example.com/three\n\n[ref\\-4]: https://example.com/escaped';
    const references = Object.keys(api.scanProductMarkdown(before).references);
    await load(before, [[0,8]]); command('linkReference');
    const after = '[selected][ref-4]' + before.slice(8) + '\n\n[ref-4]: URL';
    // CommonMark keeps escapes in labels. [ref\-4] is a distinct reference.
    assert(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) === 'URL', v.state.selection.toJSON()); history(before, after);
    return { references, generated: 'ref-4' };
  });
  await check('Reference allocation ignores code, comments, metadata, escaped brackets and invalid definitions (JSDOM)', async () => {
    const before = '---\n[ref]: https://metadata.test\n---\n\nselected\n\n> > ```md\n> > [ref]: https://fence.test\n> > ```\n\n- item\n\n  ```md\n  [ref]: https://list-fence.test\n  ```\n\nOutside list\n\n    [ref]: https://indent.test\n\n<!-- [ref]: https://comment.test -->\n\n\\[ref]: https://escaped.test\n\n[ref]: <broken';
    await load(before, [[before.indexOf('selected'), before.indexOf('selected') + 8]]); command('linkReference');
    const after = before.replace('selected', '[selected][ref]') + '\n\n[ref]: URL'; history(before, after);
    return { generated: 'ref', excludedScopes: ['metadata', 'quote fence', 'list fence', 'indented code', 'comment', 'escaped bracket', 'invalid definition'] };
  });
  await check('Reference definition command avoids quoted names and selects only URL (JSDOM)', async () => {
    const before = '> > [ref]: https://example.com\n\nBody';
    await load(before); command('linkReferenceDefinition');
    assert(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) === 'URL', v.state.selection.toJSON());
    history(before, before + '\n\n[ref-2]: URL\n\n');
    return { generated: 'ref-2' };
  });
  await check('Character input and real Enter preserve nested marker bounds, DOM/state parity and tail (JSDOM)', async () => {
    const input = '> > - [ ] task\nchild\n\nTAIL';
    const variants = [];
    for (const mode of ['state', 'dom']) {
      await load('');
      const errors = [], previousError = console.error;
      console.error = (...args) => errors.push(args.map(String).join(' '));
      let printableAdvances = true, handledEnters = true;
      try {
        for (const char of input) {
          const previousHead = v.state.selection.main.head;
          if (char === '\n') {
            const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
            v.contentDOM.dispatchEvent(event); handledEnters &&= event.defaultPrevented;
          } else if (mode === 'state') v.dispatch(v.state.replaceSelection(char));
          else {
            const event = new dom.window.InputEvent('beforeinput', { data: char, inputType: 'insertText', bubbles: true, cancelable: true });
            v.contentDOM.dispatchEvent(event);
            if (!event.defaultPrevented) {
              const selection = document.getSelection(); assert(selection?.rangeCount, 'missing DOM selection');
              const range = selection.getRangeAt(0); range.deleteContents();
              const node = document.createTextNode(char); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
              v.contentDOM.dispatchEvent(new dom.window.InputEvent('input', { data: char, inputType: 'insertText', bubbles: true })); v.observer.flush();
            }
          }
          await new Promise(resolve => setTimeout(resolve, 0));
          if (char !== '\n') printableAdvances &&= v.state.selection.main.head === previousHead + char.length;
        }
      } catch (error) { errors.push(error.stack); } finally { console.error = previousError; }
      const after = source();
      assert(!errors.length && printableAdvances && handledEnters && after.endsWith('TAIL') && v.state.selection.main.head === v.state.doc.length, { mode, errors, printableAdvances, handledEnters, source: after });
      variants.push({ mode, source: after, inputCharacters: input.length, printableAdvances, handledEnters });
    }
    assert(variants[0].source === variants[1].source, variants);
    return { variants, note: 'Enter intentionally continues Markdown prefixes; loaded-source checks are byte exact.' };
  });
} finally {
  handle?.view.destroy(); dom.window.close();
  for (const [key, descriptor] of oldGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  rmSync(bundle, { force: true });
}
const originalPath = '/Applications/Typora.app/Contents/Resources/TypeMark/appsrc/main.js';
const original = readFileSync(originalPath, 'utf8');
const evidence = {
  date: new Date().toISOString(), environment: 'Real CodeMirror in JSDOM; no browser layout', browserVerified: false,
  browserStatus: 'blocked before launch: agent-browser nested-qa socket directory /Users/lkc/.agent-browser is not writable in sandbox; no escalation repeated',
  referenceEvidence: { path: originalPath, function: 'toggleTaskStatus(e)', offset: original.indexOf('toggleTaskStatus(e)'), behavior: 'Uses selection startContainer closest .md-task-list-item; collapsed selection changes that owning task; selected range uses its starting task state.' },
  harness: { implementation: 'Grok 4.6 low bounded prompt attempted once; automatic approval review model at capacity, action not executed. Implementation completed locally.', globalConfigurationChanged: false },
  results,
};
writeFileSync('evidence/nested-editing-verification.json', JSON.stringify(evidence, null, 2) + '\n');
for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.passed ? '' : ': ' + result.detail}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
