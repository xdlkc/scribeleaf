import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cli = process.env.AGENT_BROWSER ?? '/Users/lkc/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin/agent-browser';
const results = [];
const browser = (...args) => execFileSync(cli, ['--session', 'typora-qa', ...args], {encoding: 'utf8', timeout: 45000});
const evaluate = (code) => {
  const raw = execFileSync(cli, ['--session','typora-qa','eval','--stdin'], {input: code, encoding:'utf8', timeout:45000}).trim();
  return JSON.parse(raw);
};
const check = (name, code) => {
  try {
    const value = evaluate(code);
    if (!value || value.ok === false) throw new Error(JSON.stringify(value));
    results.push({name, passed: true, detail: value});
  } catch (error) { results.push({name, passed: false, detail: error.message}); }
};
const fixture = readFileSync(resolve('fixtures/acceptance.md'), 'utf8');
browser('open', process.env.APP_URL ?? 'http://127.0.0.1:5173');
browser('wait', '--fn', 'Boolean(window.typora?.getMarkdown)');
check('Load Markdown without changes', `(() => { const text=${JSON.stringify(fixture)}; window.typora.command('load',{markdown:text,path:'',name:'acceptance.md'}); return {ok:window.typora.getMarkdown()===text}; })()`);
check('Repeated live/source switches preserve all bytes', `(() => { const before=window.typora.getMarkdown(); for(let i=0;i<10;i++) window.typora.command('toggleSource'); return {ok:window.typora.getMarkdown()===before}; })()`);
check('Chinese and unknown syntax survive mode switches', `(() => { const text='---\\ntitle: 中文\\n---\\n\\n# 输入法\\n\\n中文，标点。 🐈\\n\\n<custom data-x="1">keep</custom>\\n\\n    indented code\\n\\n[[unknown|syntax]]\\n'; window.typora.command('load',{markdown:text,path:'',name:'unicode.md'}); window.typora.command('toggleSource'); window.typora.command('toggleSource'); return {ok:window.typora.getMarkdown()===text}; })()`);
check('CRLF line endings survive mode switches', `(() => { const text='# Windows\\r\\n\\r\\n中文与空格  \\r\\nnext\\r\\n'; window.typora.command('load',{markdown:text,path:'',name:'crlf.md'}); window.typora.command('toggleSource'); window.typora.command('toggleSource'); return {ok:window.typora.getMarkdown()===text}; })()`);
check('Code fence keeps first content line decoration', `(async () => { const tick=String.fromCharCode(96).repeat(3); const text='# Code\\n\\n'+tick+'js\\nFIRST_LINE();\\nLAST_LINE();\\n'+tick+'\\n\\nTAIL'; window.typora.command('load',{markdown:text,path:'',name:'code.md'}); await new Promise(requestAnimationFrame); const first=document.querySelector('.cm-codeblock-first'); return {ok:first?.textContent==='FIRST_LINE();' && [...document.querySelectorAll('.cm-hidden-fence')].every(e=>e.getBoundingClientRect().height===0) && window.typora.getMarkdown()===text}; })()`);
check('Unclosed code fence keeps its final line visible', `(async () => { const tick=String.fromCharCode(96).repeat(3); const text='# Code\\n\\n'+tick+'js\\nFIRST_LINE();\\nLAST_LINE();'; window.typora.command('load',{markdown:text,path:'',name:'unclosed.md'}); await new Promise(requestAnimationFrame); return {ok:document.querySelector('.cm-content').textContent.includes('LAST_LINE();') && window.typora.getMarkdown()===text}; })()`);
check('Restore acceptance document', `(() => { const text=${JSON.stringify(fixture)}; window.typora.command('load',{markdown:text,path:'',name:'acceptance.md'}); return {ok:window.typora.getMarkdown()===text, editable:!!document.querySelector('[contenteditable=true]')}; })()`);
check('Footnote reference renders label and preserves source', `({ok:document.querySelector('.lp-footnote-ref')?.textContent==='note' && window.typora.getMarkdown().includes('[^note]')})`);
try {
  browser('click','.lp-footnote-ref');
  check('Clicking footnote reaches its definition', `(()=>{const v=window.typora.editor;return {ok:v.state.doc.lineAt(v.state.selection.main.head).text.startsWith('[^note]:')};})()`);
} catch(error) { results.push({name:'Clicking footnote reaches its definition',passed:false,detail:error.message}); }
evaluate(`(()=>{window.typora.command('load',{markdown:${JSON.stringify(fixture)},path:'',name:'acceptance.md'});return true})()`);
try {
  evaluate(`(() => { window.__nativeMessages=[]; window.__previousWebkit=window.webkit; window.webkit={messageHandlers:{native:{postMessage:m=>window.__nativeMessages.push(m)}}}; return true; })()`);
  browser('click', '.cm-content');
  browser('press', 'Control+End');
  browser('keyboard', 'inserttext', '编辑验证 QA_MARKER');
  check('Keyboard insertion changes document', `({ok:window.typora.getMarkdown().includes('QA_MARKER')})`);
  check('Loaded document sends edits to native bridge', `({ok:window.__nativeMessages.some(m=>m.type==='change' && m.markdown.includes('QA_MARKER'))})`);
  browser('press', 'Meta+z');
  check('Undo removes edit', `({ok:!window.typora.getMarkdown().includes('QA_MARKER')})`);
  browser('press', 'Meta+Shift+z');
  check('Redo restores edit', `({ok:window.typora.getMarkdown().includes('QA_MARKER')})`);
  check('Native close command reaches NSDocument bridge', `(() => {window.typora.command('close');return {ok:window.__nativeMessages.some(m=>m.type==='close')};})()`);
  evaluate(`(() => { if(window.__previousWebkit) window.webkit=window.__previousWebkit; else delete window.webkit; return true; })()`);
} catch(error) { results.push({name:'Keyboard interaction',passed:false,detail:error.message}); }
check('Restore fixture for visual evidence', `(() => { window.typora.command('load',{markdown:${JSON.stringify(fixture)},path:'',name:'acceptance.md'}); return {ok:true}; })()`);
mkdirSync('evidence', {recursive:true});
browser('screenshot', resolve('evidence/replica-browser.png'));
writeFileSync('evidence/browser-verification.json', JSON.stringify({date:new Date().toISOString(),results},null,2));
console.log(results.map(x => `${x.passed?'PASS':'FAIL'} ${x.name}`).join('\n'));
if (results.some(x => !x.passed)) process.exitCode = 1;
