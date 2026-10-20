// Exercise the real boot/bridge/sidebar together. JSDOM proves DOM/focus and
// source invariants; it does not prove native window or pixel behavior.
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),bundle=resolve('.cache/folder-update-check.mjs');
await build({stdin:{contents:"import './src/main.ts';export {store} from './src/store.ts'",resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'esm',loader:{'.css':'empty'},plugins:[{name:'text-assets',setup(b){
  b.onResolve({filter:/\?(inline|raw)$/},a=>({path:a.path.startsWith('.')?resolve(a.resolveDir,a.path.replace(/\?(inline|raw)$/,'')):require.resolve(a.path.replace(/\?(inline|raw)$/,''),{paths:[a.resolveDir]}),namespace:'text-assets'}));
  b.onLoad({filter:/.*/,namespace:'text-assets'},a=>({contents:readFileSync(a.path,'utf8'),loader:'text'}));
}}]});
const dom=new JSDOM(readFileSync('index.html','utf8'),{pretendToBeVisual:true,url:'http://localhost/'}),messages=[];
for(const name of ['window','document','navigator','localStorage','MutationObserver','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Element','Node','Text','DOMRect','Range','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) {
  if(dom.window[name])Object.defineProperty(globalThis,name,{value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(name)?dom.window[name].bind(dom.window):dom.window[name],configurable:true});
}
dom.window.Range.prototype.getClientRects=()=>[];
dom.window.Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0});
window.webkit={messageHandlers:{native:{postMessage:m=>messages.push(m)}}};
const results=[];
const check=(name,fn)=>{try{const detail=fn();if(!detail)throw Error('Assertion failed');results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:String(e)});}};
let editor;
try {
  const {store}=await import(pathToFileURL(bundle).href);editor=window.typora.editor;
  const root='/work/Notes',files=[{name:'note.md',path:root+'/note.md',relativePath:'note.md'}];
  const dirs=['assets','assets/empty','empty','media only'].map(relativePath=>({name:relativePath.split('/').pop(),path:root+'/'+relativePath,relativePath}));
  window.typora.command('load',{markdown:'# Title\n\nDraft',path:root+'/note.md',name:'note.md'});
  editor.dispatch({changes:{from:editor.state.doc.length,insert:' changed'},selection:{anchor:2,head:5}});
  const text=window.typora.getMarkdown(),selection=editor.state.selection.main.toJSON();
  const update=(directories=dirs)=>window.typora.command('files',{root,files,directories});
  const rows=()=>[...document.querySelectorAll('.sidebar-tree-item')];
  update();window.typora.command('sidebarTree');
  check('Initial directory metadata shows empty and asset-only directories',()=>['assets','empty','media only'].every(name=>rows().some(row=>row.getAttribute('aria-label')===name)));
  check('A folder update preserves the edited document identity and bytes',()=>store.currentPath===root+'/note.md'&&store.dirty&&window.typora.getMarkdown()===text&&JSON.stringify(editor.state.selection.main.toJSON())===JSON.stringify(selection));
  window.typora.command('sidebarOutline');editor.focus();update();
  check('Background updates keep the outline tab and editor focus',()=>!!document.querySelector('.sidebar-outline')&&document.activeElement===editor.contentDOM);
  window.typora.command('toggleSidebar');update();
  check('Background updates do not reopen a hidden sidebar',()=>document.body.classList.contains('sidebar-hidden'));
  window.typora.command('sidebarTree');
  let filter=document.querySelector('.sidebar-filter');filter.value='as';filter.dispatchEvent(new window.Event('input'));filter.focus();filter.setSelectionRange(0,1,'backward');
  update([...dirs,{name:'new empty',path:root+'/assets/new empty',relativePath:'assets/new empty'}]);
  filter=document.querySelector('.sidebar-filter');
  check('Live update preserves filter value, focus and backward selection',()=>filter.value==='as'&&document.activeElement===filter&&filter.selectionStart===0&&filter.selectionEnd===1&&filter.selectionDirection==='backward');
  filter.value='';filter.dispatchEvent(new window.Event('input'));
  let assets=rows().find(row=>row.dataset.path===root+'/assets');assets.click();assets=rows().find(row=>row.dataset.path===root+'/assets');assets.focus();
  update([...dirs,{name:'new empty',path:root+'/assets/new empty',relativePath:'assets/new empty'}]);
  check('New nested empty directory appears under an expanded folder',()=>rows().some(row=>row.dataset.path===root+'/assets/new empty'));
  check('Directory row focus survives a refreshed snapshot',()=>document.activeElement?.dataset.path===root+'/assets');
  update();
  check('Deleted directory metadata disappears without rewriting the document',()=>!rows().some(row=>row.dataset.path===root+'/assets/new empty')&&window.typora.getMarkdown()===text);
  window.typora.command('files',{root,files});
  check('Legacy files payload remains valid without directory metadata',()=>store.directories.length===0&&rows().some(row=>row.dataset.path===root+'/note.md'));
} finally {
  editor?.destroy();dom.window.close();rmSync(bundle,{force:true});
}
writeFileSync('evidence/folder-updates-verification.json',JSON.stringify({date:new Date().toISOString(),environment:'JSDOM real application boot/bridge/sidebar',browserVerified:false,results},null,2)+'\n');
for(const result of results)console.log(`${result.passed?'PASS':'FAIL'} ${result.name}${result.error?': '+result.error:''}`);
if(results.some(result=>!result.passed))process.exitCode=1;
