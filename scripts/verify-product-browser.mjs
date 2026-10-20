import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

// Run against a frozen production build while native export work continues.
// The existing state/DOM cases run in Chromium, then CDP sends actual clicks
// and keyboard input. This does not claim a specific native IME candidate UI.
const cli = process.env.AGENT_BROWSER ?? '/Users/lkc/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin/agent-browser';
const session = process.env.TYPORA_QA_SESSION ?? 'typora-final-qa';
const url = process.env.APP_URL ?? 'http://127.0.0.1:5182';
const dist = process.env.TYPORA_QA_DIST ?? '.cache/native-dist';
const browser = (...args) => execFileSync(cli, ['--session', session, ...args], {encoding:'utf8',timeout:45000});
const evaluate = source => JSON.parse(execFileSync(cli, ['--session',session,'eval','--stdin'], {input:source,encoding:'utf8',timeout:45000}).trim());
const local = readFileSync('scripts/verify-nested-editing.mjs','utf8');
const start = local.indexOf('  const fixture =');
const end = local.indexOf("  await check('Character input");
if (start < 0 || end <= start) throw new Error('Nested case boundaries changed; update this browser runner.');
const cases = local.slice(start,end)
  .replaceAll('(JSDOM)', '(Chromium)')
  .replace('    const references = Object.keys(api.scanProductMarkdown(before).references);\n','')
  .replace("return { references, generated: 'ref-4' };", "return { generated: 'ref-4' };");
if (cases.includes('scanProductMarkdown')) throw new Error('Unexpected non-browser helper in shared cases.');

browser('open',url);
browser('wait','--fn','Boolean(window.typora?.getMarkdown)');
const context = evaluate(`({userAgent:navigator.userAgent,url:location.href,viewport:[innerWidth,innerHeight],loadedAssets:[...document.querySelectorAll('script[src],link[rel="stylesheet"][href]')].map(n=>n.src||n.href)})`);
const results = evaluate(`(async()=>{
  const results=[], edits=[], v=window.typora.editor;
  window.__productBrowserErrors=[];
  window.addEventListener('error', event=>window.__productBrowserErrors.push(event.message));
  window.addEventListener('unhandledrejection', event=>window.__productBrowserErrors.push(String(event.reason)));
  const oldUpdate=v.update.bind(v);
  v.update=transactions=>{
    for(const tr of transactions) if(tr.docChanged) tr.changes.iterChanges((from,to,_a,_b,text)=>edits.push({from,to,text:text.toString()}));
    return oldUpdate(transactions);
  };
  const assert=(ok,detail)=>{if(!ok)throw new Error(JSON.stringify(detail))};
  const check=async(name,action)=>{try{results.push({name,passed:true,detail:await action()})}catch(e){results.push({name,passed:false,detail:e.stack})}};
  const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const setLiveMode=live=>{if(live===document.body.classList.contains('source-mode'))window.typora.command('toggleSource')};
  const handle={setLiveMode};
  const api={EditorSelection:v.state.selection.constructor,runCommand:name=>window.typora.command(name),
    undo:()=>{const before=window.typora.getMarkdown();window.typora.command('undo');return window.typora.getMarkdown()!==before},
    redo:()=>{const before=window.typora.getMarkdown();window.typora.command('redo');return window.typora.getMarkdown()!==before}};
  let eol='\\n';
  const load=async(text,ranges)=>{
    eol=text.includes('\\r\\n')?'\\r\\n':'\\n';setLiveMode(true);
    window.typora.command('load',{markdown:text,path:'',name:'nested-browser.md'});
    const normalized=v.state.doc.toString();
    v.dispatch({selection:ranges?api.EditorSelection.create(ranges.map(([anchor,head=anchor])=>api.EditorSelection.range(anchor,head))):{anchor:normalized.length}});
    v.focus();v.scrollDOM.scrollTop=0;edits.length=0;await settle();
  };
  const source=()=>v.state.doc.toString().replace(/\\n/g,eol);
  const command=name=>api.runCommand(name);
  const exact=expected=>{assert(source()===expected,{expected,actual:source()});assert(window.typora.getMarkdown()===expected,{serialized:window.typora.getMarkdown(),expected})};
  const history=(before,after)=>{exact(after);assert(api.undo(v),'undo failed');exact(before);assert(api.redo(v),'redo failed');exact(after)};
  try{${cases}}finally{v.update=oldUpdate;setLiveMode(true)}
  await settle();
  results.push({name:'No browser runtime exceptions',passed:window.__productBrowserErrors.length===0,detail:window.__productBrowserErrors});
  return results;
})()`);

const check = (name,fn) => {try{const detail=fn();if(!detail?.ok)throw new Error(JSON.stringify(detail));results.push({name,passed:true,detail})}catch(error){results.push({name,passed:false,detail:error.stack})}};
const clickFixture = '> > - [x] checked\n> > - [ ] unchecked\n\nTAIL';
evaluate(`(()=>{window.typora.command('load',{markdown:${JSON.stringify(clickFixture)},path:'',name:'actual-click.md'});const v=window.typora.editor;v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();return true})()`);
browser('wait','--fn',"document.querySelectorAll('.lp-checkbox').length===2");
browser('snapshot','-i','-c');
check('Actual browser click changes a quoted task',()=>{
  browser('find','first','.lp-checkbox','click');
  return evaluate(`({ok:window.typora.getMarkdown()===${JSON.stringify(clickFixture.replace('[x]','[ ]'))},source:window.typora.getMarkdown()})`);
});
check('Actual keyboard undo restores quoted task',()=>{browser('press','Meta+z');return evaluate(`({ok:window.typora.getMarkdown()===${JSON.stringify(clickFixture)}})`)});
check('Actual keyboard redo changes only quoted task',()=>{browser('press','Meta+Shift+z');return evaluate(`({ok:window.typora.getMarkdown()===${JSON.stringify(clickFixture.replace('[x]','[ ]'))}})`)});

evaluate(`(()=>{window.typora.command('load',{markdown:'',path:'',name:'actual-input.md'});window.typora.editor.focus();return true})()`);
check('Actual text input and Enter retain nested quote markers and tail',()=>{
  for(const text of ['> > - [ ] task','child','','TAIL']){
    if(text)browser('keyboard','type',text);
    if(text!=='TAIL')browser('press','Enter');
  }
  return evaluate(`(()=>{const v=window.typora.editor,s=window.typora.getMarkdown();return {ok:s.includes('task')&&s.includes('child')&&s.endsWith('TAIL')&&v.state.selection.main.head===v.state.doc.length,source:s,errors:window.__productBrowserErrors}})()`);
});
check('Actual Unicode and literal punctuation input survive source switches',()=>{
  const text=' 中文 🐈 "straight" --';
  browser('keyboard','inserttext',text);
  return evaluate(`(()=>{const before=window.typora.getMarkdown();window.typora.command('toggleSource');window.typora.command('toggleSource');return {ok:before.endsWith(${JSON.stringify(text)})&&window.typora.getMarkdown()===before,source:before}})()`);
});
check('Browser remains free of runtime exceptions after actual input',()=>evaluate(`({ok:window.__productBrowserErrors.length===0,errors:window.__productBrowserErrors})`));
mkdirSync('evidence',{recursive:true});
browser('screenshot',resolve('evidence/product-browser-final.png'));
const assets=readdirSync(resolve(dist,'assets')).filter(name=>name.endsWith('.js')||name.endsWith('.css'));
for(const loaded of context.loadedAssets){const name=new URL(loaded).pathname.split('/').at(-1);if(!assets.includes(name))throw new Error('Served asset is absent from selected frozen build: '+name);}
const hashes=Object.fromEntries(assets.map(name=>[name,createHash('sha256').update(readFileSync(resolve(dist,'assets',name))).digest('hex')]));
writeFileSync('evidence/product-browser-verification.json',JSON.stringify({date:new Date().toISOString(),environment:'Real isolated Chromium via agent-browser CDP',browserVerified:true,context,frozenBuildDirectory:dist,frozenBuildHashes:hashes,sharedCaseSource:'scripts/verify-nested-editing.mjs',limitations:['Programmatic state/DOM checks use the actual application and browser, but only the explicit click/keyboard cases use CDP input.','No native IME candidate UI or system clipboard was exercised.','Editing checks only. Export and preferences have separate verification.'],results},null,2)+'\n');
console.log(results.map(x=>(x.passed?'PASS ':'FAIL ')+x.name+(x.passed?'':': '+x.detail)).join('\n'));
if(results.some(x=>!x.passed))process.exitCode=1;
