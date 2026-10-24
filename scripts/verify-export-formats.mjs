import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),bundle=resolve('.cache/export-formats-check.mjs');
await build({stdin:{contents:"import './src/main.ts';export {store} from './src/store.ts';export {buildStandaloneHtml} from './src/export.ts';export {freezeEntry} from './src/export-settings.ts'",resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'esm',loader:{'.css':'empty'},plugins:[{name:'text-assets',setup(b){
  b.onResolve({filter:/\?(inline|raw)$/},a=>({path:a.path.startsWith('.')?resolve(a.resolveDir,a.path.replace(/\?(inline|raw)$/,'')):require.resolve(a.path.replace(/\?(inline|raw)$/,''),{paths:[a.resolveDir]}),namespace:'text-assets'}));
  b.onLoad({filter:/.*/,namespace:'text-assets'},a=>({contents:readFileSync(a.path,'utf8'),loader:'text'}));
}}]});
const runtimeErrors=[],virtualConsole=new VirtualConsole();
virtualConsole.on('jsdomError',error=>runtimeErrors.push(String(error)));
const dom=new JSDOM(readFileSync('index.html','utf8'),{pretendToBeVisual:true,url:'http://localhost/',virtualConsole}),messages=[];
for(const name of ['window','document','Window','Document','Event','CustomEvent','navigator','location','localStorage','MutationObserver','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Element','Node','Text','DOMRect','Range','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) {
  if(dom.window[name])Object.defineProperty(globalThis,name,{value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(name)?dom.window[name].bind(dom.window):dom.window[name],configurable:true});
}
dom.window.Range.prototype.getClientRects=()=>[];
dom.window.Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0});
const native={messageHandlers:{native:{postMessage:m=>messages.push(m)}}};window.webkit=native;
const results=[];
const check=(name,condition)=>results.push({name,passed:!!condition});
const waitForMessage=async(format,start,type='export')=>{
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){const found=messages.slice(start).find(m=>m.type===type&&m.format===format);if(found)return found;await new Promise(r=>setTimeout(r,0));}
  throw Error(`Missing native export: ${format}`);
};
let editor;
try {
  const {store,buildStandaloneHtml,freezeEntry}=await import(pathToFileURL(bundle).href);editor=window.typora.editor;
  const source='# 中文\r\n\r\n[TOC]\r\n\r\n## Child\r\n\r\n- [x] task\r\n\r\nBody $x^2$[^n].\r\n\r\n[^n]: Footnote\r\n';
  window.typora.command('load',{markdown:source,path:'/work/notes.md',name:'notes.md'});
  editor.dispatch({changes:{from:editor.state.doc.length,insert:'UNSAVED'}});
  const snapshot=window.typora.getMarkdown(),path=store.currentPath;
  for(const format of ['docx','odt','rtf','epub','latex','mediawiki','rst','textile','opml','html','html-plain','pdf','png']) {
    const start=messages.length;window.typora.command('export',format);
    const begin=await waitForMessage(format,start,'beginExport');
    check(`Native ${format} begins the settings preflight protocol`,begin.type==='beginExport');
    window.typora.command('exportPrepare',{requestId:`qa-${format}`,format,identity:'qa-source',settings:freezeEntry(store.exportSettings,format==='png'?'image':format),markdownPreferences:begin.markdownPreferences});
    const message=await waitForMessage(format,start);
    check(`Native ${format} receives the current unsaved CRLF snapshot`,message.markdown===snapshot);
    if(format==='html-plain'){
      const doc=new JSDOM(message.html).window.document;
      check('Unstyled HTML retains headings, TOC, task, math and footnote content',!!doc.querySelector('h1')&&!!doc.querySelector('.md-toc')&&!!doc.querySelector('input[checked]')&&!!doc.querySelector('math')&&!!doc.querySelector('.footnotes'));
      check('Unstyled HTML excludes theme styles and font embedding',doc.querySelectorAll('head style').length===0&&!message.html.includes('@font-face'));
    }
    if(['html','pdf','png'].includes(format))check(`${format} uses a standalone styled document`,message.html.startsWith('<!DOCTYPE html>')&&message.html.includes('<style>'));
  }
  check('Exporting every format preserves source identity, bytes and dirty state',store.currentPath===path&&store.dirty&&window.typora.getMarkdown()===snapshot);
  for(const [theme,license] of [['newsprint','ParaType'],['pixyll','Merriweather']]){
    const html=await buildStandaloneHtml('Licenses','Body',theme);
    check(`${theme} styled HTML carries its font license`,html.includes(license)&&html.includes('SIL OPEN FONT LICENSE'));
  }
  const start=messages.length;window.typora.command('export','not-a-format');
  await new Promise(r=>setTimeout(r,0));
  check('Unknown formats cannot silently export a different document type',!messages.slice(start).some(m=>m.type==='export'));
  window.typora.command('exportFinished',{name:'notes.docx'});
  check('Native success feedback identifies the written file',document.body.textContent.includes('notes.docx'));
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  results.push({name:'Async export and layout complete without uncaught editor errors',passed:runtimeErrors.length===0,errors:runtimeErrors});
} finally {editor?.destroy();dom.window.close();rmSync(bundle,{force:true});}
writeFileSync(process.env.SCRIBELEAF_TEST_REPORT || 'evidence/export-formats-verification.json',JSON.stringify({date:new Date().toISOString(),environment:'JSDOM real application boot/commands/bridge',browserVerified:false,results},null,2)+'\n');
for(const result of results)console.log(`${result.passed?'PASS':'FAIL'} ${result.name}`);
if(results.some(r=>!r.passed))process.exitCode=1;
