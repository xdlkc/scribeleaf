import {execFileSync} from 'node:child_process';
import {writeFileSync, readFileSync, rmSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const local = process.argv.includes('--local');
const cli = process.env.AGENT_BROWSER || '/Users/lkc/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin/agent-browser';
const session = 'paragraph-qa';
const run = (...args) => execFileSync(cli, ['--session', session, ...args], {encoding:'utf8', timeout:30000});
const browserEval = code => JSON.parse(execFileSync(cli, ['--session',session,'eval','--stdin'], {input:code,encoding:'utf8',timeout:30000}));

// This same set runs against real CodeMirror in Chrome or the local DOM check.
function sourceChecks(api) {
  const results = [];
  const assert = (condition, detail) => { if (!condition) throw new Error(JSON.stringify(detail)); };
  const check = (name, action) => {
    try { const detail = action(); results.push({name, passed:true, detail}); }
    catch (error) { results.push({name, passed:false, detail:String(error)}); }
  };
  const load = (text, ranges) => {
    api.load(text);
    const v = api.view(), S = v.state.selection.constructor;
    if (ranges) v.dispatch({selection:S.create(ranges.map(([from,to=from]) => S.range(from,to)))});
    v.focus();
    return v;
  };
  const expect = text => assert(api.source() === text, {expected:text, actual:api.source()});
  const history = (before, after) => {
    expect(after); api.command('undo'); expect(before); api.command('redo'); expect(after);
  };
  const call = name => api.command(name);
  check('YAML inserts at the start, preserves BOM and source, and has one undo step', () => {
    const before = '\uFEFF# Title\n\n{{unknown}}'; const v = load(before,[[9]]);
    call('yamlFrontMatter');
    assert(v.state.selection.main.head === 5, {selection:v.state.selection.main.head});
    history(before,'\uFEFF---\n\n---\n\n# Title\n\n{{unknown}}');
  });
  check('Existing and unfinished YAML are entered without duplication', () => {
    for (const source of ['---\ntitle: hi\n---\n\nBody','---\ntitle: hi\n...\nBody','---\ntitle: unfinished']) {
      const v = load(source,[[source.length]]); call('yamlFrontMatter'); expect(source);
      assert(v.state.selection.main.head === 4,{selection:v.state.selection.main.head});
    }
  });
  check('TOC insertion keeps selected source and is independently undoable', () => {
    const before = '# Heading\n\nKeep **unknown**\n\nTail';load(before,[[11,27]]);call('toc');
    history(before,'# Heading\n\nKeep **unknown**\n\n[TOC]\n\nTail');
  });
  check('Paragraph commands respect fenced blocks with blank inner lines', () => {
    const before='```md\nline\n\nlast\n```';let v=load(before,[[11]]);call('insertParagraphAbove');
    assert(v.state.selection.main.head===0,{});history(before,'\n\n'+before);
    v=load(before,[[11]]);call('insertParagraphBelow');
    assert(v.state.selection.main.head===before.length+2,{});
    history(before,before+'\n\n');
  });
  check('Paragraph commands reuse adjacent empty paragraphs and preserve metadata', () => {
    const source='---\ntitle: value\n---\n\nBody\n\nTail';const v=load(source,[[7]]);call('insertParagraphBelow');expect(source);
    assert(v.state.selection.main.head===source.indexOf('\n\nBody')+1,{selection:v.state.selection.main.head});
  });
  check('Reference link preserves selected label, avoids collisions, selects URL and has one undo step', () => {
    const before='selected 中文\n\n[REF]: old\n[ref-2]: other';const v=load(before,[[0,11]]);call('linkReference');
    const after='[selected 中文][ref-3]\n\n[REF]: old\n[ref-2]: other\n\n[ref-3]: URL';
    assert(v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)==='URL',v.state.selection.main);
    history(before,after);
  });
  check('Reference link insertion at empty EOF uses valid positions', () => {
    const v=load('');call('linkReference');
    assert(v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)==='URL',v.state.selection.main);
    history('','[link][ref]\n\n[ref]: URL');
  });
  check('Reference definition inserts a block and selects only its URL', () => {
    const v=load('Body');call('linkReferenceDefinition');expect('Body\n\n[ref]: URL\n\n');
    assert(v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)==='URL',v.state.selection.main);
  });
  check('Comment toggle preserves unknown syntax, spaces, and multi-selection', () => {
    const before='Alpha **x**\n\nKeep\n\nBeta {{y}}';const v=load(before,[[0,11],[19,29]]);call('comment');
    const after='<!--Alpha **x**-->\n\nKeep\n\n<!--Beta {{y}}-->';history(before,after);call('comment');expect(before);
    assert(v.state.selection.ranges.length===2,{ranges:v.state.selection.ranges.length});
    load('<!--  text  -->',[[4,12]]);call('comment');expect('  text  ');
  });
  check('Task state preserves nested markers and ignores plain, fake, fenced and metadata lines', () => {
    const before='---\n- [ ] metadata\n---\n\n- [ ] one\n  * [X] nested\n> 1. [ ] quoted\n[ ] ordinary\n- [a] unknown\n```\n- [ ] code\n```\n\nTail';
    load(before,[[0,before.length]]);call('toggleTaskState');
    const after=before.replace('- [ ] one','- [x] one').replace('> 1. [ ] quoted','> 1. [x] quoted');history(before,after);
    call('taskUnchecked');expect(after.replace('- [x] one','- [ ] one').replace('* [X] nested','* [ ] nested').replace('> 1. [x] quoted','> 1. [ ] quoted'));
    call('taskChecked');expect(after.replace('* [X] nested','* [x] nested'));
  });
  check('Task multi-selection excludes following unselected lines', () => {
    const before='- [ ] one\n- [ ] two\n- [ ] three\n- [ ] four';const second=before.indexOf('- [ ] two'),third=before.indexOf('- [ ] three');
    load(before,[[0,second],[third,third+4]]);call('toggleTaskState');
    expect(before.replace('- [ ] one','- [x] one').replace('- [ ] three','- [x] three'));
    call('toggleTaskState');expect(before);
  });
  check('Five alert types insert without losing the current paragraph', () => {
    for (const kind of ['Note','Tip','Important','Warning','Caution']) {
      const before='Keep **body**';load(before,[[4]]);call('alert'+kind);history(before,`${before}\n\n> [!${kind.toUpperCase()}]\n> \n\n`);
    }
  });
  check('Alert conversion retains nested source and toggles the same type off', () => {
    const before='> [!NOTE]\n> Body **x**\n> > Nested\n\nTail';load(before,[[20]]);call('alertCaution');
    const after=before.replace('[!NOTE]','[!CAUTION]');history(before,after);call('alertCaution');expect('> Body **x**\n> > Nested\n\nTail');
  });
  check('Alert multi-selection wraps only selected lines and keeps existing quote prefixes', () => {
    const before='one\ntwo\n\n> three\n> four\n\nTail';load(before,[[0,4],[9,17]]);call('alertTip');
    expect('> [!TIP]\n> one\ntwo\n\n> [!TIP]\n> three\n> four\n\nTail');
  });
  check('CRLF survives YAML, references, comment, task status and alert edits', () => {
    const before='- [ ] 中文\r\n\r\n{{raw}}';load(before,[[0,8]]);call('taskChecked');
    expect('- [x] 中文\r\n\r\n{{raw}}');call('comment');assert(!/(?<!\r)\n/.test(api.source()),api.source());
    call('yamlFrontMatter');assert(!/(?<!\r)\n/.test(api.source()),api.source());
    load('中文\r\n\r\nTail',[[0,2]]);call('linkReference');assert(!/(?<!\r)\n/.test(api.source()),api.source());
    load('Body\r\n\r\nTail',[[0]]);call('alertWarning');assert(!/(?<!\r)\n/.test(api.source()),api.source());
  });
  check('Heading changes follow installed Typora boundaries and exact selected lines', () => {
    for (const [before,name,after] of [
      ['# Title','decreaseHeading','## Title'],['## Title','increaseHeading','# Title'],
      ['# Title','increaseHeading','# Title'],['###### Title','decreaseHeading','Title'],
      ['Title','increaseHeading','###### Title'],['Title','decreaseHeading','Title'],
    ]) { load(before,[[0]]);call(name);expect(after); }
    load('# One\n# Two',[[0,6]]);call('decreaseHeading');expect('## One\n# Two');
  });
  check('Input and foreign contenteditable focus cannot edit an old CodeMirror caret', () => {
    const before='Keep body';const v=load(before,[[0,4]]);
    for (const tag of ['input','textarea','select','div','button']) {
      const control=document.createElement(tag);
      if(tag==='div') { control.contentEditable='true'; control.tabIndex=0; }
      document.body.append(control);control.focus();
      for(const name of api.names)call(name);expect(before);control.remove();v.focus();
    }
  });
  check('Mixed task selection follows its first task instead of always completing all', () => {
    const before='- [x] first\n- [ ] second'; load(before,[[0,before.length]]);call('toggleTaskState');
    history(before,'- [ ] first\n- [ ] second');
    const reverse='- [ ] first\n- [x] second';load(reverse,[[0,reverse.length]]);call('toggleTaskState');
    history(reverse,'- [x] first\n- [x] second');
  });
  check('Dialog button focus cannot send paragraph commands to the old editor caret', () => {
    const before='Keep body';const v=load(before,[[0,4]]);
    const overlay=document.createElement('div');overlay.id='overlays';
    const button=document.createElement('button');button.textContent='Dialog action';overlay.append(button);document.body.append(overlay);button.focus();
    for(const name of api.names)call(name);expect(before);overlay.remove();v.focus();
  });
  return results;
}

let evaluate, closeLocal;
if (local) {
  const {build} = await import('esbuild');
  const {JSDOM} = await import('jsdom');
  const bundle = `${process.cwd()}/.cache/product-command-check.mjs`;
  await build({stdin:{contents:`export {registerProductCommands,PRODUCT_COMMAND_NAMES} from './src/editor/product-commands.ts';export {runCommand} from './src/commands.ts';export {changeHeadingLevel} from './src/editor/format.ts';export {EditorView} from '@codemirror/view';export {EditorState} from '@codemirror/state';export {history,undo,redo} from '@codemirror/commands';`,resolveDir:process.cwd(),sourcefile:'product-test.ts'},outfile:bundle,bundle:true,platform:'node',format:'esm',loader:{'.css':'empty'}});
  const dom=new JSDOM('<!doctype html><body><div id="editor"></div></body>',{pretendToBeVisual:true});
  for(const key of ['window','document','navigator','MutationObserver','HTMLElement','Element','Node','Text','DOMRect','Range','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) if(dom.window[key]) Object.defineProperty(globalThis,key,{value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key)?dom.window[key].bind(dom.window):dom.window[key],configurable:true});
  Object.defineProperty(dom.window.HTMLElement.prototype,'isContentEditable',{get(){return this.contentEditable==='true';}});
  dom.window.Range.prototype.getClientRects=()=>[];
  dom.window.Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0});
  const m=await import(pathToFileURL(bundle).href);
  const v=new m.EditorView({state:m.EditorState.create({extensions:[m.history(),m.EditorState.allowMultipleSelections.of(true)]}),parent:document.querySelector('#editor')});
  let eol='\n';m.registerProductCommands(v);
  window.__paragraphApi={
    names:m.PRODUCT_COMMAND_NAMES,view:()=>v,
    load(text){eol=text.includes('\r\n')?'\r\n':'\n';v.setState(m.EditorState.create({doc:text.replace(/\r\n/g,'\n'),extensions:[m.history(),m.EditorState.allowMultipleSelections.of(true)]}));v.focus();},
    source:()=>v.state.doc.toString().replace(/\n/g,eol),
    command(name){if(name==='undo')m.undo(v);else if(name==='redo')m.redo(v);else if(name==='increaseHeading')m.changeHeadingLevel(v,1);else if(name==='decreaseHeading')m.changeHeadingLevel(v,-1);else m.runCommand(name);},
  };
  evaluate=code=>eval(code);
  closeLocal=()=>{v.destroy();dom.window.close();rmSync(bundle,{force:true});};
} else {
  run('open',process.env.APP_URL||'http://127.0.0.1:5174');
  run('wait','--fn','Boolean(window.typora?.editor)');
  evaluate=browserEval;
  evaluate(`(async()=>{const m=await import('/src/editor/product-commands.ts');m.registerProductCommands(window.typora.editor);window.__paragraphApi={names:m.PRODUCT_COMMAND_NAMES,view:()=>window.typora.editor,load:markdown=>window.typora.command('load',{markdown,path:'',name:'paragraph-qa.md'}),source:()=>window.typora.getMarkdown(),command:name=>window.typora.command(name)};return true})()`);
}

const results=evaluate(`(${sourceChecks.toString()})(window.__paragraphApi)`);
if (!local) {
  const check=(name,fn)=>{try{const detail=fn();results.push({name,passed:detail.ok,detail});}catch(error){results.push({name,passed:false,detail:String(error)});}};
  evaluate(`(()=>{const a=window.__paragraphApi;a.load('Before\\n\\nselected 中文\\n\\nAfter');const v=a.view();v.dispatch({selection:{anchor:8,head:19}});v.focus();a.command('comment');return true})()`);
  run('press','Meta+z');
  check('Actual keyboard Undo restores original source',()=>evaluate(`({ok:window.typora.getMarkdown()==='Before\\n\\nselected 中文\\n\\nAfter',source:window.typora.getMarkdown()})`));
  run('press','Meta+Shift+z');
  check('Actual keyboard Redo restores comment',()=>evaluate(`({ok:window.typora.getMarkdown()==='Before\\n\\n<!--selected 中文-->\\n\\nAfter',source:window.typora.getMarkdown()})`));
  const table='Before\n\n| A | B |\n| --- | --- |\n| one | two |\n\nAfter';
  evaluate(`(()=>{window.__paragraphApi.load(${JSON.stringify(table)});return true})()`);
  run('click','.lp-cell[data-row="1"][data-col="1"]');
  check('Actual table cell focus swallows every new paragraph command',()=>evaluate(`(()=>{for(const name of window.__paragraphApi.names)window.typora.command(name);return {ok:window.typora.getMarkdown()===${JSON.stringify(table)},source:window.typora.getMarkdown(),focus:document.activeElement.className}})()`));
}
const reference='/Applications/Typora.app/Contents/Resources/TypeMark/appsrc/main.js';
const original=readFileSync(reference,'utf8');
const evidence={date:new Date().toISOString(),environment:local?'jsdom-CodeMirror (not browser verification)':'Chrome agent-browser paragraph-qa',browserVerified:!local,referenceEvidence:{path:reference,headingFunction:'changeHeadingLevel(e,t,n)',headingOffset:original.indexOf('changeHeadingLevel(e,t,n)'),headingBehavior:'Paragraph increase→H6; paragraph decrease→unchanged; H1 increase→unchanged; H1 decrease→H2; H6 decrease→paragraph.',alertFunction:'insertAlert(e,t)',alertOffset:original.indexOf('insertAlert(e,t)'),alertBehavior:'Existing alert changes type; same type removes alert marker and retains quote content; normal caret inserts a new alert.'},harness:{implementation:'Grok 4.6 low attempted; session permission denied; escalation was not executed because automatic approval review model was at capacity. Implementation completed in workspace by agent.',globalConfigurationChanged:false},results};
writeFileSync('evidence/product-commands-verification.json',JSON.stringify(evidence,null,2)+'\n');
for(const result of results) console.log(`${result.passed?'PASS':'FAIL'} ${result.name}${result.passed?'':': '+JSON.stringify(result.detail)}`);
closeLocal?.();
if(results.some(result=>!result.passed))process.exitCode=1;
