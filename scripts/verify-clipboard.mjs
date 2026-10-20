import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const swiftArch = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();

await mkdir('.cache', { recursive: true });

const source = `
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import MarkdownIt from 'markdown-it';
import {
  clipboardExtension,
  htmlToMarkdown,
  pasteTextFromClipboard,
  queueClipboardImages,
  applyClipboardResult,
  resetClipboardDocument,
  clipboardDocumentId,
  clipboardPendingIds,
  markdownImage,
  pasteFromSystem,
  setClipboardFileReadGate,
  CLIPBOARD_ERROR_EVENT,
  handleClipboardResult,
} from './src/editor/clipboard.ts';

function assert(cond, name) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('PASS ' + name);
}

function contains(hay, needle, name) {
  assert(hay.includes(needle), name + ' :: ' + JSON.stringify(hay));
}

const heading = htmlToMarkdown('<h1>Title</h1><h2>Section</h2><h3>Sub</h3>');
contains(heading, '# Title', 'heading-h1');
contains(heading, '## Section', 'heading-h2');
contains(heading, '### Sub', 'heading-h3');

const inline = htmlToMarkdown('<p><strong>bold</strong> and <em>italic</em> and <a href="https://ex.test">link</a></p>');
contains(inline, '**bold**', 'strong');
contains(inline, '*italic*', 'emphasis');
contains(inline, '[link](https://ex.test)', 'link');

const lists = htmlToMarkdown('<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>');
contains(lists, 'one', 'ul-item');
contains(lists, 'two', 'ul-item-2');
contains(lists, 'first', 'ol-item');
assert(/^-\\s+one/m.test(lists) || /\\*\\s+one/m.test(lists), 'ul-marker');
assert(/1\\.\\s+first/.test(lists), 'ol-marker');

const quote = htmlToMarkdown('<blockquote><p>quoted line</p></blockquote>');
contains(quote, '> quoted line', 'blockquote');

const inlineCode = htmlToMarkdown('<p>use <code>foo()</code></p>');
contains(inlineCode, '\`foo()\`', 'inline-code');

const fenced = htmlToMarkdown('<pre><code class="language-js">const x = 1;\\n</code></pre>');
contains(fenced, 'const x = 1;', 'fenced-body');
assert(fenced.includes('\`\`\`'), 'fenced-ticks');

const table = htmlToMarkdown(
  '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
);
contains(table, '|', 'table-pipe');
assert(/---/.test(table), 'table-sep');

const mixed = htmlToMarkdown('<p>hello <img src="data:image/png;base64,AAAA" alt="x"> world</p>');
assert(!mixed.includes('data:image') && !mixed.includes('blob:'), 'no-base64-markdown');
contains(mixed, 'hello', 'keep-text-before-data-img');
contains(mixed, 'world', 'keep-text-after-data-img');

const md = '# Keep  **this**\\n\\n- item\\twith tab\\n\`exact\`';
assert(pasteTextFromClipboard('<h1>NO</h1>', md, true) === md, 'force-plain-exact');
assert(pasteTextFromClipboard(null, md, false) === md, 'plain-only-exact');
const unicode = '中文🎉\\u00a0nbsp';
assert(pasteTextFromClipboard(null, unicode, false) === unicode, 'unicode-plain');

const mdit = new MarkdownIt();
const imgMd = markdownImage('a]b', '/tmp/my file (1).png');
const imgHtml = mdit.render(imgMd);
assert(/<img\\b/i.test(imgHtml), 'image-renders-tag');
assert(imgHtml.includes('/tmp/my file (1).png') || imgHtml.includes('my%20file'), 'image-src-spaces-parens');
assert(!imgHtml.includes(']b]'), 'image-alt-brackets-safe');
assert(mdit.render(markdownImage('photo [1]', '/tmp/a.png')).includes('<img '), 'image-alt-paired-brackets');

function makeView(doc) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({ doc, extensions: [clipboardExtension] }),
    parent,
  });
}

const posts = [];
window.webkit = { messageHandlers: { native: { postMessage: (m) => posts.push(m) } } };

function dispatchPaste(view, { files = [], html = '', plain = '', uriList = '' }) {
  const items = files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f }));
  const types = [];
  if (files.length) types.push('Files');
  if (html) types.push('text/html');
  if (plain) types.push('text/plain');
  if (uriList) types.push('text/uri-list');
  const dt = {
    files,
    items,
    types,
    getData: (t) =>
      t === 'text/html' ? html : t === 'text/plain' ? plain : t === 'text/uri-list' ? uriList : '',
  };
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  view.contentDOM.dispatchEvent(ev);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

void (async () => {

const v1 = makeView('same text');
const v2 = makeView('same text');
assert(clipboardDocumentId(v1.state) !== clipboardDocumentId(v2.state), 'fresh-identity-same-text');

const v3 = makeView('HEAD');
v3.dispatch({ selection: { anchor: 4 } });
queueClipboardImages(v3, [
  { requestId: 'r1', alt: 'one' },
  { requestId: 'r2', alt: 'two' },
  { requestId: 'r3', alt: 'three' },
]);
applyClipboardResult(v3, { requestId: 'r3', path: 'c.png' });
assert(!v3.state.doc.toString().includes('c.png'), 'hold-until-prefix');
applyClipboardResult(v3, { requestId: 'r1', path: 'a.png' });
assert(!v3.state.doc.toString().includes('c.png'), 'third-still-held');
applyClipboardResult(v3, { requestId: 'r2', path: 'b.png' });
const after = v3.state.doc.toString();
assert(after.indexOf('one') < after.indexOf('two') && after.indexOf('two') < after.indexOf('three'), 'paste-order-after-ooo');
applyClipboardResult(v3, { requestId: 'r2', path: 'dup.png' });
assert(!after.includes('dup.png') && !v3.state.doc.toString().includes('dup.png'), 'duplicate-result-ignored');
assert(!clipboardPendingIds(v3.state).includes('r1'), 'pending-removed');

const v4 = makeView('abc');
v4.dispatch({ selection: { anchor: 1 } });
queueClipboardImages(v4, [{ requestId: 'm1', alt: 'mid' }]);
v4.dispatch({ changes: { from: 0, insert: 'ZZ' } });
applyClipboardResult(v4, { requestId: 'm1', path: 'm.png' });
const mapped = v4.state.doc.toString();
assert(mapped.indexOf('![') === 3, 'mapped-pos-after-prefix-insert: ' + JSON.stringify(mapped));

const v5 = makeView('x');
queueClipboardImages(v5, [{ requestId: 'bad', alt: 'nope' }]);
applyClipboardResult(v5, { requestId: 'bad', error: 'cancelled' });
assert(!v5.state.doc.toString().includes('!['), 'no-broken-ref-on-error');

await (async () => {
  posts.length = 0;
  let release;
  setClipboardFileReadGate(() => new Promise((r) => { release = r; }));
  const ve = makeView('abc');
  ve.dispatch({ selection: { anchor: 1 } });
  const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
  dispatchPaste(ve, { files: [file] });
  await wait(10);
  ve.dispatch({ changes: { from: 0, insert: 'ZZ' } });
  release();
  await wait(40);
  const posted = posts.find((p) => p.type === 'clipboardImage');
  assert(posted, 'event-paste-posted-after-read');
  assert(typeof FileReader === 'function', 'jsdom-FileReader-global');
  assert(posted.data === 'AQID', 'posted-base64-data ' + JSON.stringify(posted.data));
  assert(posted.source === 'paste', 'posted-source-paste');
  applyClipboardResult(ve, { requestId: posted.requestId, path: 'shot.png' });
  const text = ve.state.doc.toString();
  assert(text.indexOf('![') === 3, 'event-mapped-pos: ' + JSON.stringify(text));
  ve.destroy();
  setClipboardFileReadGate(null);
})();

await (async () => {
  posts.length = 0;
  let release;
  setClipboardFileReadGate(() => new Promise((r) => { release = r; }));
  const ve = makeView('equal');
  const file = new File([new Uint8Array([9])], 'n.png', { type: 'image/png' });
  dispatchPaste(ve, { files: [file] });
  await wait(10);
  const before = ve.state.doc.toString();
  ve.setState(EditorState.create({ doc: 'equal', extensions: [clipboardExtension] }));
  release();
  await wait(40);
  assert(posts.length === 0, 'no-native-post-after-new-doc');
  assert(ve.state.doc.toString() === before, 'new-doc-unmutated');
  ve.destroy();
  setClipboardFileReadGate(null);
})();

await (async () => {
  posts.length = 0;
  const ve = makeView('abc');
  queueClipboardImages(ve, [{ requestId: 'late', alt: 'late' }]);
  posts.push({ type: 'clipboardImage', requestId: 'late' });
  ve.setState(EditorState.create({ doc: 'abc', extensions: [clipboardExtension] }));
  handleClipboardResult({ requestId: 'late', path: 'late.png' });
  applyClipboardResult(ve, { requestId: 'late', path: 'late.png' });
  assert(!ve.state.doc.toString().includes('late.png'), 'stale-result-after-post-ignored');
  ve.destroy();
})();

await (async () => {
  const va = makeView('A');
  const vb = makeView('B');
  queueClipboardImages(vb, [{ requestId: 'own-b', alt: 'b' }]);
  handleClipboardResult({ requestId: 'own-b', path: 'b.png' });
  assert(!va.state.doc.toString().includes('b.png'), 'result-not-first-live-view');
  assert(vb.state.doc.toString().includes('b.png'), 'result-owning-view');
  va.destroy();
  vb.destroy();
})();

await (async () => {
  posts.length = 0;
  const ve = makeView('x');
  const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
  dispatchPaste(ve, { files: [file], uriList: 'file:///tmp/shot.png' });
  await wait(20);
  const imagePosts = posts.filter((p) => p.type === 'clipboardImage');
  assert(imagePosts.length === 1, 'dedupe-file-and-uri ' + imagePosts.length);
  assert(imagePosts[0].path && imagePosts[0].path.indexOf('shot.png') >= 0, 'dedupe-uses-path');
  ve.destroy();
})();

await (async () => {
  posts.length = 0;
  const ve = makeView('');
  const files = [
    new File([new Uint8Array([1])], 'same.png', { type: 'image/png' }),
    new File([new Uint8Array([2])], 'same.png', { type: 'image/png' }),
  ];
  dispatchPaste(ve, {
    files,
    uriList: ['file:///tmp/a/same.png', 'file:///tmp/b/same.png'].join(String.fromCharCode(10)),
  });
  await wait(5);
  const paths = posts.filter((p) => p.type === 'clipboardImage').map((p) => p.path);
  assert(paths.length === 2 && new Set(paths).size === 2, 'same-name-different-paths-preserved');
  ve.destroy();
})();

await (async () => {
  posts.length = 0;
  const ve = makeView('');
  dispatchPaste(ve, { html: '<img src="https://example.test/remote.png" alt="remote">' });
  await wait(5);
  assert(ve.state.doc.toString().includes('https://example.test/remote.png'), 'remote-html-image-kept');
  assert(posts.length === 0, 'remote-html-image-no-native-request');
  ve.destroy();
})();

await (async () => {
  const ve = makeView('doc');
  const cell = document.createElement('div');
  cell.className = 'lp-cell';
  cell.setAttribute('contenteditable', 'true');
  cell.tabIndex = 0;
  ve.dom.appendChild(cell);
  cell.focus();
  let resolveRead;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: () => new Promise((r) => { resolveRead = r; }) },
  });
  const pending = pasteFromSystem(ve, true);
  ve.setState(EditorState.create({ doc: 'doc', extensions: [clipboardExtension] }));
  resolveRead('CELLTEXT');
  await pending;
  assert(!ve.state.doc.toString().includes('CELLTEXT'), 'nested-replaced-no-cm-insert');
  ve.destroy();

  const ve2 = makeView('root');
  const cell2 = document.createElement('div');
  cell2.className = 'lp-cell';
  cell2.setAttribute('contenteditable', 'true');
  cell2.tabIndex = 0;
  ve2.dom.appendChild(cell2);
  cell2.focus();
  const prevExec = document.execCommand;
  document.execCommand = function () { throw new Error('no-exec'); };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: async () => 'from-menu' },
  });
  await pasteFromSystem(ve2, true);
  document.execCommand = prevExec;
  assert((cell2.textContent || '').includes('from-menu'), 'nested-cell-dom-fallback-text');
  assert(!ve2.state.doc.toString().includes('from-menu'), 'nested-not-cm-caret');
  ve2.destroy();

  const ve3 = makeView('live');
  const errors = [];
  const onErr = (e) => errors.push(e.detail);
  window.addEventListener(CLIPBOARD_ERROR_EVENT, onErr);
  let resolveErr;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: () => new Promise((r) => { resolveErr = r; }) },
  });
  const p3 = pasteFromSystem(ve3, true);
  ve3.destroy();
  resolveErr('NOPE');
  await p3;
  window.removeEventListener(CLIPBOARD_ERROR_EVENT, onErr);
  assert(errors.length === 0, 'destroyed-view-error-harmless');
})();

await (async () => {
  const errors = [];
  window.addEventListener(CLIPBOARD_ERROR_EVENT, (e) => errors.push(e.detail));
  const ve = makeView('x');
  ve.contentDOM.focus();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} });
  await pasteFromSystem(ve, true);
  assert(errors.some((d) => d.error === 'unsupported'), 'clipboard-error-event-emitted');
  errors.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      read: async () => [{ types: ['image/png'], getType: async () => new Blob([new Uint8Array([1])]) }],
      readText: async () => '',
    },
  });
  const before = ve.state.doc.toString();
  await pasteFromSystem(ve, false);
  assert(errors.some((d) => d.error === 'unsupported'), 'image-only-menu-unsupported');
  assert(ve.state.doc.toString() === before, 'image-only-no-empty-insert');
  ve.destroy();
})();

for (const v of [v1, v2, v3, v4, v5]) v.destroy();
handleClipboardResult({ requestId: 'ghost', path: 'x.png' });
console.log('ALL_CLIPBOARD_TESTS_PASSED');
})();
`;

const outfile = resolve('.cache/clipboard-check.cjs');
await build({
  stdin: { contents: source, resolveDir: process.cwd(), loader: 'js' },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['jsdom'],
  banner: {
    js: `const { JSDOM } = require('jsdom');
const __dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' });
// jsdom has no layout; clipboard assertions use text/state, not geometry.
__dom.window.Range.prototype.getClientRects = () => [];
__dom.window.Range.prototype.getBoundingClientRect = () => new __dom.window.DOMRect();
const __g = globalThis;
__g.window = __dom.window;
__g.document = __dom.window.document;
__g.Node = __dom.window.Node;
__g.Document = __dom.window.Document;
__g.Element = __dom.window.Element;
__g.HTMLElement = __dom.window.HTMLElement;
__g.Window = __dom.window.Window;
__g.DocumentFragment = __dom.window.DocumentFragment;
__g.DOMParser = __dom.window.DOMParser;
__g.Blob = __dom.window.Blob;
__g.File = __dom.window.File;
__g.FileReader = __dom.window.FileReader;
__g.Event = __dom.window.Event;
__g.InputEvent = __dom.window.InputEvent || __dom.window.Event;
__g.CustomEvent = __dom.window.CustomEvent;
__g.getComputedStyle = __dom.window.getComputedStyle.bind(__dom.window);
__g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
__g.cancelAnimationFrame = (id) => clearTimeout(id);
__g.MutationObserver = __dom.window.MutationObserver;
__dom.window.requestAnimationFrame = __g.requestAnimationFrame;
__dom.window.cancelAnimationFrame = __g.cancelAnimationFrame;
`,
  },
});

try {
  const out = execFileSync(process.execPath, [outfile], { encoding: 'utf8' });
  process.stdout.write(out);
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exitCode = 1;
} finally {
  await rm(outfile, { force: true });
}

const yamlDir = join(tmpdir(), 'typora-clipboard-yaml-' + Date.now());
await mkdir(yamlDir, { recursive: true });
const yamlTest = join(yamlDir, 'yaml-test.swift');
const stub = join(yamlDir, 'stub.swift');
await writeFile(
  stub,
  `import AppKit
import Foundation
import UniformTypeIdentifiers
final class MarkdownDocument: NSDocument {
  var markdown = ""
  func send(_ name: String, _ payload: Any? = nil) {}
}
`,
);
await writeFile(
  yamlTest,
  `import Foundation
@main
struct YAMLCheck {
  static func main() {
    var failed = 0
    func check(_ name: String, _ md: String, _ want: String) {
      let got: String
      switch parseTyporaCopyImagesTo(md) {
      case .absent: got = "absent"
      case .unresolved: got = "unresolved"
      case .path(let p): got = "path:" + p
      }
      if got != want {
        fputs("FAIL yaml-" + name + " got " + got + " want " + want + "\\n", stderr)
        failed += 1
      } else {
        print("PASS yaml-" + name)
      }
    }
    check("valid-rel", "---\\ntypora-copy-images-to: ./assets\\n---\\nbody\\n", "path:./assets")
    check("valid-quoted", "---\\ntypora-copy-images-to: \\"img\\"\\n---\\n", "path:img")
    check("absent", "---\\ntitle: hi\\n---\\n", "absent")
    check("no-fm", "hello\\n", "absent")
    check("comment", "---\\ntypora-copy-images-to: ./a # x\\n---\\n", "unresolved")
    check("unmatched", "---\\ntypora-copy-images-to: \\"foo\\n---\\n", "unresolved")
    check("block", "---\\ntypora-copy-images-to: |\\n  a\\n---\\n", "unresolved")
    check("anchor", "---\\ntypora-copy-images-to: &x ./a\\n---\\n", "unresolved")
    check("nested", "---\\nfoo:\\n  typora-copy-images-to: ./a\\n---\\n", "unresolved")
    check("dup", "---\\ntypora-copy-images-to: ./a\\ntypora-copy-images-to: ./b\\n---\\n", "unresolved")
    check("bool", "---\\ntypora-copy-images-to: true\\n---\\n", "unresolved")
    check("close-junk", "---\\ntypora-copy-images-to: ./a\\n---nope\\n", "unresolved")
    check("escape", "---\\ntypora-copy-images-to: \\"a\\\\nb\\"\\n---\\n", "unresolved")
    if failed > 0 { exit(1) }
  }
}
`,
);
try {
  const bin = join(yamlDir, 'yaml-check');
  execFileSync(
    'xcrun',
    [
      'swiftc',
      '-swift-version',
      '5',
      '-parse-as-library',
      '-module-cache-path',
      join(yamlDir, 'module-cache'),
      '-target',
      `${swiftArch}-apple-macosx13.0`,
      '-o',
      bin,
      stub,
      resolve('native/Clipboard.swift'),
      resolve('native/ImagePreferences.swift'),
      resolve('native/ExportSettings.swift'),
      resolve('native/DocumentConversion.swift'),
      yamlTest,
      '-framework',
      'AppKit',
      '-framework',
      'WebKit',
      '-framework',
      'UniformTypeIdentifiers',
    ],
    { encoding: 'utf8' },
  );
  process.stdout.write(execFileSync(bin, { encoding: 'utf8' }));
} catch (error) {
  if (error.stdout) process.stdout.write(String(error.stdout));
  if (error.stderr) process.stderr.write(String(error.stderr));
  process.exitCode = 1;
} finally {
  await rm(yamlDir, { recursive: true, force: true });
}
