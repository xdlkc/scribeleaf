import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const cli = process.env.AGENT_BROWSER || '/Users/lkc/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin/agent-browser';
const results = [];
const source = '---\ntitle: META_PRIVATE\nnot_body: secret\n---\n\n[TOC]\n\n# **中文** *标题* `code`\n\n## Child [link](https://example.com)\n\n# **中文** *标题* `code`\n\n' +
 ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map(type => `> [!${type}]\n> ${type} body **bold**${type === 'NOTE' ? '\n>\n> > [!TIP]\n> > Nested body' : ''}\n`).join('\n') +
 '\n```md\n# Fake heading\n[TOC]\n> [!NOTE]\n<!-- literal-code-comment -->\n```\n\n    > [!WARNING]\n\n<!-- COMMENT_PRIVATE\n<script>window.__commentExecuted=true</script>\n# Invisible heading\n-->\n\nBefore <!-- INLINE_PRIVATE --> after. `<!-- CODE_COMMENT -->`\n\n[Reference][ref] and [Collapsed][] and [Shortcut].\n\n[ref]: https://example.com/ref "Reference title"\n[Collapsed]: #中文-标题-code-1\n[Shortcut]: https://example.com/shortcut\n\n---\n\nTAIL';
const check = (name, detail) => { const ok = Boolean(detail.ok); results.push({ name, passed: ok, detail }); };
mkdirSync('.cache/product-rendering', { recursive: true });
await build({
  stdin: { contents: "export {buildStandaloneHtml,renderMarkdownToHtml} from './src/export.ts'; export {scanProductMarkdown} from './src/editor/product-markdown.ts';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: '.cache/product-rendering/verification-bundle.cjs', platform: 'node', format: 'cjs', bundle: true, external: ['mermaid'],
  plugins: [{ name: 'inline-text', setup(context) {
    context.onResolve({ filter: /\?(inline|raw)$/ }, args => { const clean = args.path.replace(/\?(inline|raw)$/, ''); return { path: clean.startsWith('.') ? resolve(args.resolveDir, clean) : require.resolve(clean, { paths: [args.resolveDir] }), namespace: 'inline-text' }; });
    context.onLoad({ filter: /.*/, namespace: 'inline-text' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  }}],
});
const api = require(resolve('.cache/product-rendering/verification-bundle.cjs'));
const scan = api.scanProductMarkdown(source);
const html = await api.buildStandaloneHtml('Product rendering', source, 'github');
const dom = new JSDOM(html);
const article = dom.window.document.querySelector('article');
check('TOC keeps heading levels, formatted Chinese labels, unique anchors, and excludes code/comments/metadata', { ok: scan.headings.length === 3 && scan.headings[0].text === '中文 标题 code' && scan.headings[0].id === '中文-标题-code' && scan.headings[2].id === '中文-标题-code-1' && scan.headings[1].level === 2, headings: scan.headings });
check('Export TOC links all resolve to the corresponding heading', { ok: [...article.querySelectorAll('.md-toc a')].length === 3 && [...article.querySelectorAll('.md-toc a')].every(a => article.querySelector(`[id="${a.hash.slice(1)}"]`) || dom.window.document.getElementById(decodeURIComponent(a.hash.slice(1)))), ids: [...article.querySelectorAll('h1,h2')].map(h => h.id) });
check('Five alert kinds and nested quote structure render outside code', { ok: ['note', 'tip', 'important', 'warning', 'caution'].every(type => article.querySelector(`blockquote.md-alert-${type}`)) && article.querySelectorAll('blockquote.md-alert').length === 6 && !!article.querySelector('blockquote.md-alert-note blockquote.md-alert-tip') && article.querySelector('pre code').textContent.includes('> [!NOTE]'), count: article.querySelectorAll('blockquote.md-alert').length });
check('Metadata is omitted from exported body and does not become a heading or rule', { ok: !article.textContent.includes('META_PRIVATE') && !article.textContent.includes('not_body') && article.querySelectorAll('hr').length === 1 && scan.specialBlocks.filter(b => b.type === 'frontmatter').length === 1 });
check('HTML comments are absent and inert; literal comments in code remain', { ok: !article.textContent.includes('COMMENT_PRIVATE') && !article.textContent.includes('INLINE_PRIVATE') && article.querySelectorAll('script').length === 0 && article.textContent.includes('literal-code-comment') && article.textContent.includes('CODE_COMMENT') });
check('Reference, collapsed and shortcut links resolve with titles', { ok: article.querySelector('a[href="https://example.com/ref"]')?.title === 'Reference title' && !!article.querySelector('a[href="#中文-标题-code-1"]') && !!article.querySelector('a[href="https://example.com/shortcut"]') && scan.references.REF?.href === 'https://example.com/ref' });
const crlf = source.replace(/\n/g, '\r\n');
const crlfScan = api.scanProductMarkdown(crlf);
check('CRLF scan offsets refer to original source bytes', { ok: crlfScan.headings.every(h => crlf.slice(h.from, h.to).startsWith('#')) && crlfScan.alertLines.filter(a => a.markerFrom != null).every(a => crlf.slice(a.markerFrom, a.markerTo).startsWith('[!')) });
check('Unclosed/noninitial --- is ordinary Markdown', { ok: api.scanProductMarkdown('---\ntitle: no closer').specialBlocks.every(b => b.type !== 'frontmatter') && api.scanProductMarkdown('Intro\n\n---\ntitle: later\n---').specialBlocks.every(b => b.type !== 'frontmatter') });
const changed = api.scanProductMarkdown(source.replace('# **中文** *标题* `code`', '# 更新标题'));
check('Editing a heading rebuilds TOC labels and matching anchors', { ok: changed.headings[0].text === '更新标题' && changed.headings[0].id === '更新标题' && changed.headings[2].id === '中文-标题-code' });
const multiline = 'Before <!-- MULTILINE_PRIVATE\n\n# Hidden\n<script>window.bad=true</script>\n--> after\n\n# Visible';
const multilineHtml = new JSDOM(await api.buildStandaloneHtml('Comments', multiline, 'github')).window.document;
check('Multiline inline comments crossing blank lines stay hidden and inert', { ok: api.scanProductMarkdown(multiline).headings.length === 1 && multilineHtml.querySelectorAll('article h1').length === 1 && !multilineHtml.querySelector('article').textContent.includes('MULTILINE_PRIVATE') && !multilineHtml.querySelector('article script') });
const regression = new JSDOM(await api.buildStandaloneHtml('Existing features', '# Existing\n\n| A | B |\n| --- | --- |\n| one | two |\n\n- [x] Task\n\nInline $x^2$ and footnote[^n].\n\n[^n]: Definition\n', 'github')).window.document;
check('Existing table, task list, math and footnote export remain functional', { ok: !!regression.querySelector('table td') && !!regression.querySelector('input[checked]') && !!regression.querySelector('math') && !!regression.querySelector('.footnotes') });
const formattedHeading = '[TOC]\n\n# ==Mark== H~2~O X^2^ $x^2$ note[^n]\n\n[^n]: Footnote';
const formattedDoc = new JSDOM(await api.buildStandaloneHtml('Formatted heading', formattedHeading, 'github')).window.document;
const formattedScan = api.scanProductMarkdown(formattedHeading);
check('Extended inline formatting and footnotes keep live/export TOC identities equal', { ok: formattedScan.headings[0].id === formattedDoc.querySelector('h1').id && formattedScan.headings[0].text === formattedDoc.querySelector('.md-toc a').textContent, live: formattedScan.headings[0], exported: formattedDoc.querySelector('.md-toc a').textContent });

// This exercises real CodeMirror state, widget creation, dispatch and teardown.
// JSDOM supplies no layout, so this cannot substitute for browser interaction.
await build({ stdin: { contents: "export {createEditor} from './src/editor/setup.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: '.cache/product-rendering/live-verification.cjs', platform: 'node', format: 'cjs', bundle: true, external: ['mermaid'], plugins: [{ name: 'no-layout-css', setup(b) { b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'text' })); } }] });
const editorDom = new JSDOM('<!doctype html><div id="editor"></div>', { pretendToBeVisual: true, url: 'http://localhost' });
const globals = ['Window', 'Document', 'Element', 'window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Text', 'DOMRect', 'Range', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame'];
const previousGlobals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { value: typeof editorDom.window[key] === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? editorDom.window[key].bind(editorDom.window) : editorDom.window[key], configurable: true, writable: true });
editorDom.window.Range.prototype.getClientRects = () => [];
editorDom.window.Range.prototype.getBoundingClientRect = () => new editorDom.window.DOMRect();
let handle;
try {
  const { createEditor } = require(resolve('.cache/product-rendering/live-verification.cjs'));
  handle = createEditor(document.querySelector('#editor'), source);
  const v = handle.view;
  v.dispatch({ selection: { anchor: source.length } });
  await new Promise(resolve => setTimeout(resolve, 40));
  check('CodeMirror creates product widgets and editable quote decorations (JSDOM)', { ok: document.querySelectorAll('.lp-toc a').length === 3 && !!document.querySelector('.lp-frontmatter') && document.querySelectorAll('.cm-alert-first').length === 6 && v.state.doc.toString() === source });
  document.querySelectorAll('.lp-toc a')[2].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  check('CodeMirror TOC widget dispatch targets the exact duplicate heading (JSDOM)', { ok: v.state.selection.main.head === scan.headings[2].from });
  for (let i = 0; i < 4; i++) { handle.setLiveMode(false); handle.setLiveMode(true); }
  check('CodeMirror mode reconfiguration preserves all source bytes (JSDOM)', { ok: v.state.doc.toString() === source });
  const welcome = readFileSync('public/samples/welcome.md', 'utf8');
  const start = performance.now();
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: welcome }, selection: { anchor: 0 } });
  for (let i = 0; i < 50; i++) v.dispatch({ selection: { anchor: Math.min(i, v.state.doc.length) } });
  await new Promise(resolve => setTimeout(resolve, 40));
  check('CodeMirror loads full welcome and completes 50 caret updates (JSDOM)', { ok: v.state.doc.toString() === welcome, elapsedMs: Math.round(performance.now() - start), sourceLength: welcome.length });
  const typedFixture = '---\ntitle: Native QA\n---\n\n[TOC]\n\n# QA Head\n\n> [!NOTE]\n> Note body\n\n> [!TIP]\n> Tip body\n\n- [ ] Task\n\n<!-- hidden -->\n\nTAIL';
  const inputResults = [];
  for (const mode of ['state', 'dom']) {
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' }, selection: { anchor: 0 } });
    v.focus();
    const errors = [], tailProgress = [];
    let printableAdvances = true, handledEnters = true;
    const previousError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    try {
      for (const char of typedFixture) {
        const previousHead = v.state.selection.main.head;
        if (char === '\n') {
          const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
          v.contentDOM.dispatchEvent(event);
          handledEnters = handledEnters && event.defaultPrevented;
        } else if (mode === 'state') {
          v.dispatch(v.state.replaceSelection(char));
        } else {
          const event = new editorDom.window.InputEvent('beforeinput', { data: char, inputType: 'insertText', bubbles: true, cancelable: true });
          v.contentDOM.dispatchEvent(event);
          if (!event.defaultPrevented) {
            const selection = document.getSelection();
            if (!selection?.rangeCount) throw new Error('Missing DOM input selection');
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const node = document.createTextNode(char);
            range.insertNode(node);
            range.setStartAfter(node);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            v.contentDOM.dispatchEvent(new editorDom.window.InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
            // Only the test synchronizes the native DOM observer explicitly.
            v.observer.flush();
          }
        }
        await new Promise(resolve => setTimeout(resolve, 0));
        if (char !== '\n') printableAdvances = printableAdvances && v.state.selection.main.head === previousHead + char.length;
        if (v.state.doc.toString().slice(-1) === char && 'TAIL'.includes(char)) tailProgress.push({ char, head: v.state.selection.main.head });
      }
    } catch (error) { errors.push(error.stack); }
    finally { console.error = previousError; }
    const finalSource = v.state.doc.toString();
    inputResults.push({ mode, errors, printableAdvances, handledEnters, source: finalSource, head: v.state.selection.main.head, tailProgress: tailProgress.slice(-4) });
    check(`Character input and Enter preserve nested-quote ranges and caret order (${mode}, JSDOM)`, { ok: errors.length === 0 && printableAdvances && handledEnters && finalSource.endsWith('TAIL') && finalSource.includes('Note body\n> >\n') && v.state.selection.main.head === v.state.doc.length, errors, source: finalSource, tailProgress: tailProgress.slice(-4), inputCharacters: typedFixture.length });
  }
  check('DOM input and state input produce the same Markdown continuation result (JSDOM)', { ok: inputResults[0].source === inputResults[1].source, note: 'Enter intentionally continues Markdown quote/list prefixes; this is keyboard entry, not byte-exact document load.' });
} catch (error) { check('CodeMirror lifecycle (JSDOM)', { ok: false, error: error.stack }); }
finally {
  handle?.view.destroy();
  editorDom.window.close();
  for (const [key, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
}

const browser = (...args) => execFileSync(cli, ['--session', 'rendering-qa', ...args], { encoding: 'utf8', timeout: 45000 });
const evaluate = code => JSON.parse(execFileSync(cli, ['--session', 'rendering-qa', 'eval', '--stdin'], { input: code, encoding: 'utf8', timeout: 45000 }));
const browserCheck = (name, code) => { try { check(name, evaluate(code)); } catch (error) { check(name, { ok: false, error: error.message }); } };
let browserStatus = 'not-run';
if (!process.argv.includes('--local')) {
  try {
    browser('open', process.env.APP_URL || 'http://127.0.0.1:5174');
    browser('wait', '--fn', 'Boolean(window.typora?.editor)');
    browser('set', 'viewport', '1400', '2600');
    evaluate(`(()=>{window.typora.command('load',{markdown:${JSON.stringify(source)},path:'',name:'rendering-qa.md'});window.typora.editor.dispatch({selection:{anchor:window.typora.editor.state.doc.length}});return true})()`);
    browser('wait', '--fn', 'Boolean(document.querySelector(".lp-toc"))');
    browserCheck('Live TOC/alerts/metadata/comments render without changing source', `({ok:window.typora.getMarkdown()===${JSON.stringify(source)}&&document.querySelectorAll('.lp-toc a').length===3&&document.querySelectorAll('.cm-alert-first').length===6&&!!document.querySelector('.lp-frontmatter')&&!document.querySelector('.cm-content').textContent.includes('COMMENT_PRIVATE'),alerts:document.querySelectorAll('.cm-alert-first').length})`);
    browser('click', '.lp-toc a:nth-child(3)');
    browserCheck('Clicking duplicate Chinese TOC entry reaches its exact source heading', `(()=>{const v=window.typora.editor;return{ok:v.state.selection.main.head===${scan.headings[2].from}&&v.hasFocus&&window.typora.getMarkdown()===${JSON.stringify(source)}}})()`);
    evaluate(`(()=>{const v=window.typora.editor;v.dispatch({changes:{from:${scan.headings[2].from},to:${scan.headings[2].to},insert:'# 更新标题'},selection:{anchor:0}});return true})()`);
    browserCheck('Live TOC updates after a heading edit', `({ok:[...document.querySelectorAll('.lp-toc a')].some(a=>a.textContent==='更新标题')})`);
    browserCheck('Source/live toggles preserve exact Markdown bytes and focus', `(()=>{const before=window.typora.getMarkdown(),v=window.typora.editor;v.focus();for(let i=0;i<6;i++)window.typora.command('toggleSource');return{ok:window.typora.getMarkdown()===before&&window.typora.editor.hasFocus}})()`);
    evaluate(`(()=>{const v=window.typora.editor,p=v.state.doc.toString().indexOf('TIP body');v.dispatch({selection:{anchor:p+3},effects:[]});v.focus();return true})()`);
    browser('keyboard', 'inserttext', '编辑');
    browserCheck('Alert body remains editable with keyboard input and stable focus', `({ok:window.typora.getMarkdown().includes('TIP编辑 body')&&window.typora.editor.hasFocus&&document.activeElement.classList.contains('cm-content')})`);
    browserCheck('Cmd-click reference link uses its resolved target', `(async()=>{const v=window.typora.editor;v.dispatch({selection:{anchor:0},effects:[]});const p=v.state.doc.toString().indexOf('[Reference]');v.dispatch({selection:{anchor:0},scrollIntoView:false});const coords=v.coordsAtPos(p);if(!coords){v.dispatch({selection:{anchor:p},scrollIntoView:true});await new Promise(requestAnimationFrame);v.dispatch({selection:{anchor:0}});}else{v.scrollDOM.scrollTop+=coords.top-v.scrollDOM.getBoundingClientRect().top-100;}await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);window.__renderingMessages=[];window.__renderingWebkit=window.webkit;window.webkit={messageHandlers:{native:{postMessage:m=>window.__renderingMessages.push(m)}}};const link=document.querySelector('.cm-link[data-href="https://example.com/ref"]');if(!link)return{ok:false,error:'reference link not visible'};const r=link.getBoundingClientRect();link.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,metaKey:true,clientX:r.x+4,clientY:r.y+r.height/2}));const messages=window.__renderingMessages;window.webkit=window.__renderingWebkit;return{ok:messages.some(m=>m.url==='https://example.com/ref'),messages}})()`);
    browserCheck('Browser export uses the same standalone HTML/PDF content pipeline', `(async()=>{const {buildStandaloneHtml}=await import('/src/export.ts');const html=await buildStandaloneHtml('QA',window.typora.getMarkdown(),'github');const d=new DOMParser().parseFromString(html,'text/html');return{ok:d.querySelectorAll('.md-toc a').length===3&&d.querySelectorAll('blockquote.md-alert').length===6&&!d.querySelector('article').textContent.includes('META_PRIVATE')}})()`);
    browserStatus = 'completed';
  } catch (error) {
    browserStatus = 'blocked';
    results.push({ name: 'Actual browser interaction', passed: false, blocked: true, detail: error.message });
  }
}
const evidence = { date: new Date().toISOString(), fixture: source, reference: { docs: '/Applications/Typora.app/Contents/Resources/TypeMark/Docs/Markdown Reference.md', css: '/Applications/Typora.app/Contents/Resources/TypeMark/style/base.css' }, browserStatus, results, limitations: ['No complete Typora pixel comparison', 'Native PDF generation not rerun; PDF shares tested standalone HTML pipeline'] };
writeFileSync('evidence/product-rendering-verification.json', JSON.stringify(evidence, null, 2));
rmSync('.cache/product-rendering/verification-bundle.cjs', { force: true });
rmSync('.cache/product-rendering/live-verification.cjs', { force: true });
for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`);
if (results.some(result => !result.passed && !result.blocked)) process.exitCode = 1;
