import { build } from 'esbuild';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const baseline = await readFile('scripts/verify-clipboard.mjs','utf8');
const banner = baseline.slice(baseline.indexOf("js: `const { JSDOM }") + 5, baseline.indexOf('\n`,\n  },', baseline.indexOf("js: `const { JSDOM }")));
const outfile=resolve('.cache/image-preferences-dom.cjs');
const source=String.raw`
import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import MarkdownIt from 'markdown-it';
import {store} from './src/store.ts';
import {DEFAULT_IMAGE_PREFERENCES,normalizeImagePreferences,imageDocumentPolicy,imageMarkdownDestination} from './src/image-preferences.ts';
import {clipboardExtension,clipboardPendingIds,handleClipboardResult,resetClipboardDocument,markdownImage,pasteFromSystem,CLIPBOARD_ERROR_EVENT} from './src/editor/clipboard.ts';
const results=[];
function check(name,passed,observed){ results.push({name,passed:!!passed,...(observed===undefined?{}:{observed})}); if(!passed) console.error('FAIL',name,observed); }
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function view(doc=''){ const parent=document.body.appendChild(document.createElement('div')); return new EditorView({state:EditorState.create({doc,extensions:[clipboardExtension]}),parent}); }
const posts=[]; window.webkit={messageHandlers:{native:{postMessage:m=>posts.push(m)}}};
function paste(v,{html='',uri='',plain='',files=[]}){ const types=[];if(html)types.push('text/html');if(uri)types.push('text/uri-list');if(plain)types.push('text/plain');if(files.length)types.push('Files');const e=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(e,'clipboardData',{value:{files,items:files.map(file=>({kind:'file',type:file.type,getAsFile:()=>file})),types,getData:t=>t==='text/html'?html:t==='text/uri-list'?uri:t==='text/plain'?plain:''}});v.contentDOM.dispatchEvent(e); }
void(async()=>{
const defaults=normalizeImagePreferences(null);check('defaults-complete',Object.keys(defaults).length===10);
for(const action of ['','folder','assert','per-file-assert','ipic','custom']) check('normalize-action-'+action,normalizeImagePreferences({imageInsertAction:action}).imageInsertAction===action);
for(const uploader of ['','ipic','upic','picsee','picgo-app','piclist-app','custom'])check('normalize-uploader-'+uploader,normalizeImagePreferences({imageUploader:uploader}).imageUploader===uploader);
check('intro-not-persisted-service',normalizeImagePreferences({imageUploader:'picgo-intro'}).imageUploader==='');
check('invalid-fields-return-defaults',normalizeImagePreferences({imageInsertAction:'bogus',imageCopyLocal:'true',customImageFolder:'x\0bad'}).customImageFolder===defaults.customImageFolder);
for(const key of ['imageCopyLocal','imageCopyOnline','allowImageUpload','useRelativeImagePaths','relativeImageDotPrefix','escapeImageURLs'])check('normalize-boolean-'+key,normalizeImagePreferences({[key]:!defaults[key]})[key]===!defaults[key]);
check('yaml-current-path',imageDocumentPolicy('---\ntypora-copy-images-to: ./assets\n---\n').copyImagesTo==='./assets');
check('yaml-nested-other-fields-accepted',imageDocumentPolicy('---\nother:\n  nested: x\ntypora-copy-images-to: "./assets #100%" # comment\n---\n').copyImagesTo==='./assets #100%');
check('yaml-source-mode-ignores',Object.keys(imageDocumentPolicy('---\ntypora-copy-images-to: upload\n---\n',true)).length===0);
check('yaml-bom-crlf',imageDocumentPolicy('\uFEFF---\r\ntypora-copy-images-to: ./图片\r\n---\r\n').copyImagesTo==='./图片');
check('yaml-duplicate-invalid',imageDocumentPolicy('---\ntypora-copy-images-to: ./a\ntypora-copy-images-to: ./b\n---\n').copyImagesInvalid);
check('yaml-no-fabricated-auto-upload-key',Object.keys(imageDocumentPolicy('---\ntypora-auto-upload: true\n---\n')).length===0);
check('yaml-unset-fallback',Object.keys(imageDocumentPolicy('---\ntypora-copy-images-to: unset\n---\n')).length===0);
check('yaml-invalid-typed-target',imageDocumentPolicy('---\ntypora-copy-images-to: [a,b]\n---\n').copyImagesInvalid);
store.prefs={...store.prefs,...DEFAULT_IMAGE_PREFERENCES,escapeImageURLs:false};
check('readable-path-syntax',imageMarkdownDestination('assets/图片 a.png',false)==='<assets/图片 a.png>');
check('escape-path-syntax',imageMarkdownDestination('assets/图片 a.png',true)==='<assets/%E5%9B%BE%E7%89%87%20a.png>');
check('literal-percent-escaped-even-readable',imageMarkdownDestination('a%20.png',false)==='<a%2520.png>');
check('online-url-kept',imageMarkdownDestination('https://images.test/图 a.png?q=1#anchor',true)==='<https://images.test/图 a.png?q=1#anchor>');
const markdown=new MarkdownIt();
for(const escapeImageURLs of [false,true]){store.prefs.escapeImageURLs=escapeImageURLs;const html=markdown.render(markdownImage('x]y','assets/图 #100% (1).png'));const template=document.createElement('template');template.innerHTML=html;check('markdown-roundtrip-'+escapeImageURLs,decodeURIComponent(template.content.querySelector('img')?.getAttribute('src')??'')==='assets/图 #100% (1).png',html);}
const v=view('---\ntypora-copy-images-to: ./current.assets\n---\nTAIL');v.dispatch({selection:{anchor:v.state.doc.length}});
paste(v,{uri:'file:///tmp/%E5%9B%BE%20%23100%25.png'});await wait(20);
let message=posts.find(m=>m.type==='clipboardImage');check('local-request-current-yaml-snapshot',message?.imagePolicy?.copyImagesTo==='./current.assets',message);check('native-local-uri-utf8-decoded',message?.path==='/tmp/图 #100%.png');
handleClipboardResult({requestId:message.requestId,path:'current.assets/图 #100%.png'});check('local-path-resolved-result-inserted',v.state.doc.toString().includes('current.assets/'));
const errors=[];window.addEventListener(CLIPBOARD_ERROR_EVENT,e=>errors.push(e.detail));
paste(v,{uri:'file:///tmp/missing.png'});await wait(10);message=posts.filter(m=>m.type==='clipboardImage').at(-1);const before=v.state.doc.toString();handleClipboardResult({requestId:message.requestId,error:'The uploader is unavailable.'});check('native-failure-no-markdown-change',v.state.doc.toString()===before);check('native-failure-event-real-detail',errors.at(-1)?.error==='The uploader is unavailable.');
store.prefs.imageCopyOnline=true;store.prefs.imageInsertAction='assert';
const online=view('HEAD\n');online.dispatch({selection:{anchor:5}});posts.length=0;
paste(online,{html:'<p>before<img alt="one" src="https://images.test/one.png">middle<img alt="two" src="https://images.test/two.png">after</p>'});await wait(10);
let remote=posts.filter(m=>m.type==='clipboardImage');check('mixed-online-html-two-native-requests',remote.length===2,remote);check('mixed-content-images-wait-for-real-result',!online.state.doc.toString().includes('https://'));
handleClipboardResult({requestId:remote[1].requestId,path:'https://cdn.test/two.png'});check('remote-order-held-before-prefix',!online.state.doc.toString().includes('cdn.test'));
handleClipboardResult({requestId:remote[0].requestId,path:'https://cdn.test/one.png'});const ordered=online.state.doc.toString();check('mixed-online-html-order-preserved',ordered.indexOf('before')<ordered.indexOf('one.png')&&ordered.indexOf('one.png')<ordered.indexOf('middle')&&ordered.indexOf('middle')<ordered.indexOf('two.png')&&ordered.indexOf('two.png')<ordered.indexOf('after'),ordered);
posts.length=0;paste(online,{uri:'https://images.test/drop.png',plain:'https://images.test/drop.png'});await wait(10);remote=posts.filter(m=>m.type==='clipboardImage');check('online-uri-drop-native-request',remote.length===1&&remote[0].remoteURL==='https://images.test/drop.png');check('online-uri-no-duplicate-plain-url',!online.state.doc.toString().includes('images.test/drop.png'));
resetClipboardDocument(online);check('reset-sends-native-cancel-for-sent-only',posts.some(m=>m.type==='clipboardCancel'&&m.requestIds.includes(remote[0].requestId)));const resetDoc=online.state.doc.toString();handleClipboardResult({requestId:remote[0].requestId,path:'https://late.test/old.png'});check('late-url-after-reset-ignored',online.state.doc.toString()===resetDoc&&clipboardPendingIds(online.state).length===0);
posts.length=0;paste(online,{html:'<img src="https://images.test/destroy.png">'});await wait(10);remote=posts.filter(m=>m.type==='clipboardImage');online.destroy();check('destroy-sends-native-cancel',posts.some(m=>m.type==='clipboardCancel'&&m.requestIds.includes(remote[0].requestId)));
const menu=view('TEXT');menu.dispatch({selection:{anchor:4}});posts.length=0;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>[{types:['text/html'],getType:async()=>({text:async()=>'<img src="https://images.test/menu.png">'})}]}});await pasteFromSystem(menu,false);check('menu-html-online-consumes-policy',posts.some(m=>m.type==='clipboardImage'&&m.remoteURL==='https://images.test/menu.png'));
menu.destroy();v.destroy();
const report={generatedAt:new Date().toISOString(),passed:results.every(x=>x.passed),checks:results,scope:'Actual CodeMirror DOM paste/menu and async result/cancel paths in JSDOM. Native is a message recorder, network and system clipboard are never accessed.'};require('node:fs').writeFileSync('evidence/image-preferences-dom-verification.json',JSON.stringify(report,null,2)+'\n');if(!report.passed)process.exitCode=1;
})();
`;
await mkdir('.cache',{recursive:true});
try{await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'js'},outfile,bundle:true,platform:'node',format:'cjs',external:['jsdom'],banner:{js:banner}});execFileSync(process.execPath,[outfile],{stdio:'inherit'});const p='evidence/image-preferences-dom-verification.json';const report=JSON.parse(await readFile(p,'utf8'));report.sourceHashes=Object.fromEntries(await Promise.all(['src/image-preferences.ts','src/editor/clipboard.ts'].map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));await writeFile(p,JSON.stringify(report,null,2)+'\n');}finally{await rm(outfile,{force:true});}
