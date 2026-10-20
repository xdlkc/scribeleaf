import {build} from 'esbuild';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const baseline=await readFile('scripts/verify-clipboard.mjs','utf8');
const banner=baseline.slice(baseline.indexOf("js: `const { JSDOM }")+5,baseline.indexOf('\n`,\n  },',baseline.indexOf("js: `const { JSDOM }")));
const folder=await mkdtemp(join(tmpdir(),'typora-file-drop-check-'));
const compiled=resolve('.cache/file-drop-check.cjs');
const inputs=['src/editor/file-drop.ts','src/editor/clipboard.ts','native/Clipboard.swift','native/ImagePreferences.swift','native/ExportSettings.swift','native/DocumentConversion.swift','scripts/verify-file-drop.mjs'];
const sourceHashes={};for(const path of inputs)sourceHashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
const browserSource=String.raw`
import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import MarkdownIt from 'markdown-it';
import {store} from './src/store.ts';
import {fileDropExtension,handleNonImageFileDrop,handleFileDropResult,isDirectoryDropFile,FILE_DROP_ERROR_EVENT} from './src/editor/file-drop.ts';
import {clipboardExtension,clipboardPendingIds,handleClipboardResult,CLIPBOARD_ERROR_EVENT} from './src/editor/clipboard.ts';
const results=[];function check(name,passed,detail){results.push({name,passed:!!passed,...(detail===undefined?{}:{detail})});if(!passed)console.error('FAIL',name,detail);}
const wait=()=>new Promise(resolve=>setTimeout(resolve,10));
const posts=[];window.webkit={messageHandlers:{native:{postMessage:message=>posts.push(message)}}};
store.nativeDocumentId='native-doc-A';store.currentPath='/workspace/原稿.md';store.docBase='file:///workspace/';
function makeView(doc='abcdef'){const parent=document.body.appendChild(document.createElement('div'));const view=new EditorView({state:EditorState.create({doc,extensions:[fileDropExtension(),clipboardExtension]}),parent});view.posAtCoords=()=>2;return view;}
function file(name,path,mime='',directory){const value=new File([new Uint8Array([1])],name,{type:mime});if(path)Object.defineProperty(value,'path',{value:path});return {file:value,entry:directory===undefined?null:{isDirectory:directory,isFile:!directory,name}};}
function transfer({items=[],uri=''}){return {files:items.map(item=>item.file).filter(Boolean),items:items.map(item=>({kind:'file',type:item.file?.type??'',getAsFile:()=>item.file??null,webkitGetAsEntry:()=>item.entry??null})),types:[...(items.length?['Files']:[]),...(uri?['text/uri-list']:[])],getData:type=>type==='text/uri-list'?uri:''};}
function event(transfer){const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperties(event,{dataTransfer:{value:transfer},clientX:{value:2},clientY:{value:2}});return event;}
function drop(view,spec){const ev=event(transfer(spec));view.contentDOM.dispatchEvent(ev);return ev;}
function result(request,links,extra={}){return {requestId:request.requestId,documentId:request.documentId,rendererDocumentId:request.rendererDocumentId,links,...extra};}
void(async()=>{
const view=makeView();
let ev=drop(view,{items:[file('doc.md','/workspace/doc.md','text/markdown',false)]});let request=posts.find(post=>post.type==='fileDrop');
check('pure-nonimage-native-contract',ev.defaultPrevented&&request?.paths?.[0]==='/workspace/doc.md'&&request.documentId==='native-doc-A'&&!!request.rendererDocumentId&&request.documentPath==='/workspace/原稿.md',request);
view.dispatch({changes:{from:0,insert:'ZZ'}});handleFileDropResult(result(request,[{path:'/workspace/doc.md',name:'doc.md'}]));
check('drop-caret-maps-through-async-edits',view.state.doc.toString()==='ZZab[doc.md](<doc.md>)cdef',view.state.doc.toString());
let before=view.state.doc.toString();handleFileDropResult(result(request,[{path:'/workspace/duplicate.md',name:'duplicate'}]));check('duplicate-result-ignored',view.state.doc.toString()===before);
posts.length=0;ev=drop(view,{items:[file('doc.md','/workspace/doc.md','text/markdown',false),file('image.png','/workspace/image.png','image/png',false)],uri:'file:///workspace/doc.md\nfile:///workspace/image.png\n'});await wait();
check('mixed-drop-both-native-pipelines',posts.some(post=>post.type==='fileDrop'&&post.paths.includes('/workspace/doc.md'))&&posts.some(post=>post.type==='clipboardImage'&&post.path==='/workspace/image.png'),posts);
check('mixed-nonimage-never-enqueued-as-image',!posts.some(post=>post.type==='clipboardImage'&&post.path==='/workspace/doc.md'));
request=posts.find(post=>post.type==='fileDrop');handleFileDropResult(result(request,[]));for(const image of posts.filter(post=>post.type==='clipboardImage'))handleClipboardResult({requestId:image.requestId,paths:[]});check('empty-image-result-is-no-op-and-drains-pending',clipboardPendingIds(view.state).length===0);
posts.length=0;const special=makeView('xy');special.posAtCoords=()=>1;
const osPath='/workspace/子目录/文档 #100% (a)[b].md';drop(special,{uri:'  # comment\nfile:///workspace/%E5%AD%90%E7%9B%AE%E5%BD%95/%E6%96%87%E6%A1%A3%20%23100%25%20(a)%5Bb%5D.md\n'});request=posts.find(post=>post.type==='fileDrop');check('uri-percent-hash-unicode-decoded-once',request?.paths?.[0]===osPath,request);
handleFileDropResult(result(request,[{path:osPath,name:'文档 [a] \\ b'}]));const html=new MarkdownIt().render(special.state.doc.toString());const holder=document.createElement('template');holder.innerHTML=html;const link=holder.content.querySelector('a');check('markdown-link-special-path-roundtrip',decodeURIComponent(link?.getAttribute('href')??'')==='子目录/文档 #100% (a)[b].md',html);check('markdown-label-brackets-backslash-safe',link?.textContent==='文档 [a] \\ b');
posts.length=0;drop(special,{uri:'file:///workspace/folder.png/'});request=posts.find(post=>post.type==='fileDrop');check('uri-directory-image-extension-is-file-drop',request?.paths?.[0]==='/workspace/folder.png/'&&!posts.some(post=>post.type==='clipboardImage'),posts);handleFileDropResult(result(request,[{path:'/workspace/folder.png',name:'folder.png',isDirectory:true}]));check('directory-result-trailing-slash',special.state.doc.toString().includes('<folder.png/>'));
posts.length=0;const folderFile=file('folder.png','/workspace/folder.png','',true);check('webkit-directory-before-extension',isDirectoryDropFile(transfer({items:[folderFile]}),folderFile.file));drop(special,{items:[folderFile]});check('known-directory-not-in-image-pipeline',posts.some(post=>post.type==='fileDrop')&&!posts.some(post=>post.type==='clipboardImage'),posts);
posts.length=0;drop(special,{items:[folderFile,file('actual.png','/workspace/actual.png','image/png',false)],uri:'file:///workspace/folder.png\nfile:///workspace/actual.png'});await wait();check('mixed-directory-image-skips-known-folder',posts.some(post=>post.type==='clipboardImage'&&post.path==='/workspace/actual.png')&&!posts.some(post=>post.type==='clipboardImage'&&post.path==='/workspace/folder.png'),posts);
posts.length=0;drop(special,{items:[file('unknown.png','/workspace/unknown.png','')]});await wait();check('unknown-image-extension-reaches-native-classification-and-image',posts.some(post=>post.type==='fileDrop'&&post.paths.includes('/workspace/unknown.png'))&&posts.some(post=>post.type==='clipboardImage'&&post.path==='/workspace/unknown.png'),posts);
posts.length=0;drop(special,{items:[file('a.md','/workspace/a.md','text/plain',false),file('b.md',undefined,'text/plain',false)],uri:'file:///workspace/a.md'});request=posts.find(post=>post.type==='fileDrop');check('partial-missing-path-requests-native-drag-snapshot',request?.useDraggingPasteboard===true&&request.paths.length===1,request);
posts.length=0;drop(special,{items:[file('a.md',undefined,'text/plain',false)],uri:'file:///workspace/a.md'});request=posts.find(post=>post.type==='fileDrop');check('complete-uri-mapping-needs-no-pasteboard',request?.useDraggingPasteboard===false&&request.paths.length===1,request);
posts.length=0;drop(special,{items:[{file:null,entry:{isDirectory:true,isFile:false,name:'folder.png'}}]});request=posts.find(post=>post.type==='fileDrop');check('directory-entry-without-file-uses-native-drag-snapshot',request?.useDraggingPasteboard===true);
posts.length=0;drop(special,{items:[file('colon:name.md','/workspace/colon:name.md','text/plain',false)]});request=posts.find(post=>post.type==='fileDrop');handleFileDropResult(result(request,[{path:'/workspace/colon:name.md',name:'colon'}]));check('colon-in-file-name-does-not-become-uri-scheme',special.state.doc.toString().includes('<colon%3Aname.md>'));
posts.length=0;drop(special,{items:[file('old.md','/workspace/old.md','text/plain',false)]});request=posts.find(post=>post.type==='fileDrop');before=special.state.doc.toString();handleFileDropResult(result(request,[{path:'/workspace/bad.md',name:'bad'}],{rendererDocumentId:'wrong-generation'}));check('wrong-renderer-generation-ignored',special.state.doc.toString()===before);
store.nativeDocumentId='native-doc-B';handleFileDropResult(result(request,[{path:'/workspace/bad.md',name:'bad'}]));check('changed-native-document-ignored',special.state.doc.toString()===before);handleFileDropResult(result(request,[{path:'/workspace/forged.md',name:'forged'}],{documentId:'native-doc-B'}));check('result-must-match-captured-native-id',special.state.doc.toString()===before);
store.nativeDocumentId='native-doc-A';store.currentPath='/workspace/other.md';handleFileDropResult(result(request,[{path:'/workspace/bad.md',name:'bad'}]));check('save-as-or-path-change-invalidates-old-request',special.state.doc.toString()===before);store.currentPath='/workspace/原稿.md';
special.setState(EditorState.create({doc:'NEW DOCUMENT',extensions:[fileDropExtension(),clipboardExtension]}));handleFileDropResult(result(request,[{path:'/workspace/late.md',name:'late'}]));check('new-editor-state-rejects-old-result',special.state.doc.toString()==='NEW DOCUMENT');
posts.length=0;drop(special,{items:[file('destroy.md','/workspace/destroy.md','text/plain',false)]});request=posts.find(post=>post.type==='fileDrop');special.destroy();handleFileDropResult(result(request,[{path:'/workspace/late.md',name:'late'}]));check('destroyed-editor-result-harmless',special.state.doc.toString()==='NEW DOCUMENT');
posts.length=0;const errorView=makeView('KEPT');const errors=[];window.addEventListener(FILE_DROP_ERROR_EVENT,event=>errors.push(event.detail));drop(errorView,{items:[file('error.md','/workspace/error.md','text/plain',false)]});request=posts.find(post=>post.type==='fileDrop');handleFileDropResult(result(request,[],{error:'actual native failure'}));check('native-error-does-not-change-markdown',errorView.state.doc.toString()==='KEPT'&&errors.at(-1)==='actual native failure');handleFileDropResult(result(request,[{path:'/workspace/late.md',name:'late'}]));check('failed-request-is-settled',errorView.state.doc.toString()==='KEPT');
posts.length=0;const native=window.webkit;delete window.webkit;const browserEvent=event(transfer({items:[file('browser.md','/tmp/browser.md','text/plain',false)]}));check('browser-without-native-retains-original-flow',handleNonImageFileDrop(browserEvent,errorView)===false&&!browserEvent.defaultPrevented&&posts.length===0);window.webkit=native;
let failedRequest;const originalHandler=window.webkit.messageHandlers.native.postMessage;const originalError=console.error;window.webkit.messageHandlers.native.postMessage=message=>{failedRequest=message;throw new Error('injected bridge failure')};console.error=()=>{};const failedDrop=event(transfer({items:[file('failed.md','/tmp/failed.md','text/plain',false)]}));before=errorView.state.doc.toString();try{check('failed-native-send-retains-browser-flow',handleNonImageFileDrop(failedDrop,errorView)===false&&!failedDrop.defaultPrevented);handleFileDropResult(result(failedRequest,[{path:'/tmp/late.md',name:'late'}]));check('failed-native-send-leaves-no-pending-result',errorView.state.doc.toString()===before);}finally{console.error=originalError;window.webkit.messageHandlers.native.postMessage=originalHandler;}
const missingId=store.nativeDocumentId;store.nativeDocumentId='';const notReady=event(transfer({items:[file('pending.md','/tmp/pending.md','text/plain',false)]}));check('not-hydrated-native-id-does-not-consume-drop',handleNonImageFileDrop(notReady,errorView)===false&&!notReady.defaultPrevented);store.nativeDocumentId=missingId;
view.destroy();errorView.destroy();
const report={generatedAt:new Date().toISOString(),passed:results.every(item=>item.passed),checks:results,scope:'Actual CodeMirror State/View and DOM drop handlers in JSDOM. Native is a message recorder; no OS clipboard/drag board or GUI is read. Position hit-testing is a fixed test coordinate; async mapping uses actual CodeMirror transactions.'};require('node:fs').writeFileSync('evidence/file-drop-dom-verification.json',JSON.stringify(report,null,2)+'\n');if(!report.passed)process.exitCode=1;
})();
`;
const swiftSource=String.raw`
import Foundation
import AppKit
@main struct NativeDropChecks {
 static func main() throws {
  let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true);let report=URL(fileURLWithPath:CommandLine.arguments[2]);let manager=FileManager.default;try manager.createDirectory(at:root,withIntermediateDirectories:true)
  let image=root.appendingPathComponent("real.png"),directory=root.appendingPathComponent("folder.png",isDirectory:true);try Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=")!.write(to:image);try manager.createDirectory(at:directory,withIntermediateDirectories:true)
  var checks:[[String:Any]]=[];func check(_ name:String,_ passed:Bool){checks.append(["name":name,"passed":passed]);print("\(passed ? "PASS":"FAIL") \(name)")}
  let doc=MarkdownDocument();doc.fileURL=root.appendingPathComponent("source.md");doc.markdown="ORIGINAL";AppPreferencesStore.saveEditorPrefs(["imageCopyLocal":false])
  var names:[NSPasteboard.Name]=[];ClipboardPasteboardReader.read={name in names.append(name);return ClipboardPasteboardSnapshot(files:[directory,image],png:nil)}
  func wait(_ count:Int){let until=Date().addingTimeInterval(3);while doc.messages.count<count&&Date()<until{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}}
  doc.handleClipboardImage(["requestId":"directory","path":directory.path,"source":"drop","imagePolicy":[:]]);wait(1);check("real-drop-directory-is-empty-success",(doc.messages.last?["paths"] as? [String])?.isEmpty==true&&doc.messages.last?["error"]==nil)
  doc.handleClipboardImage(["requestId":"drop-snapshot","lookupFileURLs":true,"name":"real.png","data":"AQID","source":"drop","imagePolicy":[:]]);wait(2);check("drop-lookup-selects-drag-board",names.last == .drag);check("drop-matched-image-resolves",doc.messages.last?["path"] as? String == "real.png")
  doc.handleClipboardImage(["requestId":"paste-snapshot","lookupFileURLs":true,"name":"real.png","data":"AQID","source":"paste","imagePolicy":[:]]);wait(3);check("paste-lookup-selects-general-board",names.last == .general)
  doc.handleClipboardImage(["requestId":"mixed-snapshot","usePasteboard":true,"source":"drop","imagePolicy":[:]]);wait(4);check("mixed-native-snapshot-omits-directory",doc.messages.last?["paths"] as? [String] == ["real.png"])
  check("native-original-markdown-preserved",doc.markdown=="ORIGINAL");check("injected-snapshot-only-no-user-pasteboards-read",names == [.drag,.general,.drag])
  try JSONSerialization.data(withJSONObject:["generatedAt":ISO8601DateFormatter().string(from:Date()),"passed":checks.allSatisfy{$0["passed"] as? Bool == true},"checks":checks,"scope":"Actual production Clipboard queue with temporary directory/file and injected value-only pasteboard snapshots. No real NSPasteboard reads."] as [String:Any],options:[.prettyPrinted,.sortedKeys]).write(to:report)
  if checks.contains(where:{$0["passed"] as? Bool != true}){exit(1)}
 }
}
`;
let failed=false;
try{
 await mkdir('.cache',{recursive:true});
 await build({stdin:{contents:browserSource,resolveDir:process.cwd(),loader:'js'},outfile:compiled,bundle:true,platform:'node',format:'cjs',external:['jsdom'],banner:{js:banner}});
 try{execFileSync(process.execPath,[compiled],{stdio:'inherit'});}catch{failed=true;}
 const frozen=[];for(const path of inputs.filter(path=>path.endsWith('.swift'))){const target=join(folder,path.split('/').at(-1));await writeFile(target,await readFile(path));frozen.push(target);}
 await writeFile(join(folder,'stub.swift'),`import Foundation\nimport AppKit\nfinal class MarkdownDocument:NSDocument{var markdown="";var messages:[[String:Any]]=[];func send(_ name:String,_ payload:Any?=nil){if name=="clipboardResult",let item=payload as? [String:Any]{messages.append(item)}}}\n`);
 await writeFile(join(folder,'Runner.swift'),swiftSource);
 const bin=join(folder,'verify');execFileSync('xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',resolve('.cache/swift'),join(folder,'stub.swift'),...frozen,join(folder,'Runner.swift'),'-o',bin,'-framework','AppKit','-framework','WebKit','-framework','UniformTypeIdentifiers'],{stdio:'inherit'});
 const suite='com.typora-replica.file-drop-test.'+folder.split('-').at(-1);
 try{execFileSync(bin,[join(folder,'fixtures'),resolve('evidence/file-drop-native-verification.json')],{stdio:'inherit',env:{...process.env,TYPORA_REPLICA_DEFAULTS_SUITE:suite}});}catch{failed=true;}finally{try{execFileSync('/usr/bin/defaults',['delete',suite],{stdio:'ignore'});}catch{}}
 const files=['evidence/file-drop-dom-verification.json','evidence/file-drop-native-verification.json'];const sourceMatchesCurrent=Object.fromEntries(await Promise.all(inputs.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')===sourceHashes[path]])));
 for(const path of files){const report=JSON.parse(await readFile(path,'utf8'));report.sourceHashes=sourceHashes;report.sourceMatchesCurrent=sourceMatchesCurrent;if(Object.values(sourceMatchesCurrent).some(value=>!value))report.passed=false;await writeFile(path,JSON.stringify(report,null,2)+'\n');if(!report.passed)failed=true;}
 if(failed)process.exitCode=1;
}finally{await rm(compiled,{force:true});await rm(folder,{recursive:true,force:true});}
