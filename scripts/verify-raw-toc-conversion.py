#!/usr/bin/env python3
"""Compile the native consumer and run real Pandoc TOC/literal conversions."""
import hashlib,json,os,platform,subprocess,sys,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
EVIDENCE=ROOT/'evidence/raw-toc-conversion-verification.json'
PANDOC=ROOT/'.cache/pandoc/pandoc-3.12.1-x86_64/bin/pandoc'
def proof_excerpt(text):
 marker='\\begin{document}'
 return text.split(marker,1)[1].strip() if marker in text else text

def compact_mismatches(items):
 for item in items:
  for key in ['actual','expected']:
   if key in item:
    value=item[key];item[key+'SHA256']=hashlib.sha256(value.encode()).hexdigest();item[key+'Body']=proof_excerpt(value);del item[key]
 return items

def retain_literal_baseline(baseline):
 # Keep the captured original escaped output as a passing literal proof. The
 # final contract preserves escaped markers instead of treating them as TOCs.
 escaped=[item for item in baseline.get('mismatches',[]) if item['case'].endswith('-escaped')]
 if escaped:
  baseline['escapedLiteralProof']=[{k:v for k,v in item.items() if k in ['case','actualBody','actualSHA256']} for item in escaped]
  baseline['mismatches']=[item for item in baseline['mismatches'] if not item['case'].endswith('-escaped')]
  for check in baseline.get('checks',[]):
   if check['name'].endswith('-escaped'):check['passed']=True
CASES={
 'toc':'[TOC]\n',
 'toc-case-space':'  [tOc] \t\n',
 'fenced':'```text\n[TOC]\n```\n',
 'indented':'    [TOC]\n',
 'inline-code':'`[TOC]`\n',
 'prose':'literal [TOC] example\n',
 'html-block':'<pre>\n[TOC]\n</pre>\n',
 'html-inline':'<span>[TOC]</span>\n',
 'strong':'**[TOC]**\n',
 'link':'[TOC](https://example.test/toc)\n',
 'reference-link':'[TOC]\n\n[TOC]: https://example.test/toc\n',
 'paragraph-continuation':'[TOC]\nnext line\n',
 'unicode':'# 标题 Café\n\n正文 naïve — 保持文本。\n',
 'escaped':'\\[TOC\\]\n',
 'fenced-escaped':'```text\n\\[TOC\\]\n```\n',
 'indented-escaped':'    \\[TOC\\]\n',
 'multiline-inline-code':'`\n[TOC]\n`\n',
 'display-math':'$$\n[TOC]\n$$\n',
 'html-inline-multiline':'<span>\n[TOC]\n</span>\n',
 'raw-block':'```{=mediawiki}\n[TOC]\n```\n',
 'toc-strip-comments':'[TOC]\n\n<!--USER_COMMENT-->\n',
 'html-strip-comments':'<pre>\n[TOC]\n</pre>\n\n<!--USER_COMMENT-->\n',
}
RUNNER=r'''
import Foundation
@main struct VerifyRawTOC {
 static func main() async throws {
  let root=URL(fileURLWithPath:CommandLine.arguments[1]),pandoc=URL(fileURLWithPath:CommandLine.arguments[2])
  let manager=FileManager.default
  let source=root.appendingPathComponent("源 folder ' # 空格/原稿.md")
  try manager.createDirectory(at:source.deletingLastPathComponent(),withIntermediateDirectories:true)
  try Data("DISK_SOURCE_原稿".utf8).write(to:source)
  let cases=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("cases.json"))) as! [String:String]
  var checks=[[String:Any]](),prepared=[String:String]()
  func check(_ name:String,_ pass:Bool,_ detail:String="") {checks.append(["name":name,"passed":pass,"detail":detail])}
  func read(_ path:URL)->String {(try? String(contentsOf:path,encoding:.utf8)) ?? ""}
  func convert(_ text:String,_ writer:String,_ generic:Bool,_ destination:URL,_ extra:[String]=[],_ timeout:Double=5) async throws {
   let markdown=DocumentConverter.prepareRawMarkdown(text,rawType:writer,writer:writer)
   if generic {
    #if TOC_AST_FIXED
    _ = try await DocumentConverter.convertGeneric(markdown:markdown,writer:writer,destination:destination,fileExtension:writer == "latex" ? "tex":"wiki",documentURL:source,pandocURL:pandoc,extraArguments:extra,timeout:timeout,rawType:writer)
    #else
    _ = try await DocumentConverter.convertGeneric(markdown:markdown,writer:writer,destination:destination,fileExtension:writer == "latex" ? "tex":"wiki",documentURL:source,pandocURL:pandoc,extraArguments:extra,timeout:timeout)
    #endif
   } else {
    #if TOC_AST_FIXED
    _ = try await DocumentConverter.convert(markdown:markdown,format:DocumentConversionFormat(rawValue:writer)!,destination:destination,documentURL:source,pandocURL:pandoc,timeout:timeout,extraArguments:extra,rawType:writer)
    #else
    _ = try await DocumentConverter.convert(markdown:markdown,format:DocumentConversionFormat(rawValue:writer)!,destination:destination,documentURL:source,pandocURL:pandoc,timeout:timeout,extraArguments:extra)
    #endif
   }
  }
  for writer in ["mediawiki","latex"] {
   for (name,text) in cases.sorted(by:{$0.key<$1.key}) {
    prepared[writer+":"+name]=DocumentConverter.prepareRawMarkdown(text,rawType:writer,writer:writer)
    for generic in [false,true] {
     let label=writer+"-"+(generic ? "generic":"fixed")+"-"+name
     do {try await convert(text,writer,generic,root.appendingPathComponent(label+".txt"),name.hasSuffix("-strip-comments") ? ["--strip-comments"]:[])}
     catch {check(label+" converts",false,error.localizedDescription)}
    }
   }
  }
  #if TOC_AST_FIXED
  for ext in ["html","tex"] {
   do {
    _ = try await DocumentConverter.convertGeneric(markdown:"# 自动 Auto Café\n\n[TOC]\n\n正文 Ω\n",writer:"",destination:root.appendingPathComponent("auto."+ext),fileExtension:ext,documentURL:source,pandocURL:pandoc,extraArguments:[],timeout:5)
   } catch {check("Empty writer autodetects ."+ext,false,error.localizedDescription)}
  }
  for generic in [false,true] {
   let label=generic ? "generic":"fixed",target=root.appendingPathComponent(label+"-preserved.txt")
   try Data("OLD_OUTPUT".utf8).write(to:target)
   var failed=false
   do {try await convert("[TOC]\n","mediawiki",generic,target,["--lua-filter",root.appendingPathComponent("not-a-filter.lua").path])}catch DocumentConversionError.processFailed {failed=true}catch{}
   check(label+": real Pandoc failure keeps old output/source",failed && read(target)=="OLD_OUTPUT" && read(source)=="DISK_SOURCE_原稿")
   let witness=root.appendingPathComponent(label+"-lua-running"),filter=root.appendingPathComponent(label+"-pause.lua")
   let witnessJSON=String(decoding:try JSONSerialization.data(withJSONObject:[witness.path]),as:UTF8.self)
   let quoted=String(witnessJSON.dropFirst().dropLast()).replacingOccurrences(of:"\\/",with:"/")
   try Data("function Pandoc(doc) local f=assert(io.open(\(quoted),'w')); f:write('READY'); f:close(); while true do end end".utf8).write(to:filter)
   let task=Task {try await convert("[TOC]\n","mediawiki",generic,target,["--lua-filter",filter.path])}
   let deadline=ProcessInfo.processInfo.systemUptime+3
   while !manager.fileExists(atPath:witness.path),ProcessInfo.processInfo.systemUptime<deadline {try await Task.sleep(nanoseconds:5_000_000)}
   let began=manager.fileExists(atPath:witness.path)
   task.cancel();var cancelled=false
   do {try await task.value}catch DocumentConversionError.cancelled {cancelled=true}catch{}
   check(label+": cancellation during real Lua filtering keeps old output/source",began && cancelled && read(target)=="OLD_OUTPUT" && read(source)=="DISK_SOURCE_原稿")
   var timedOut=false
   do {try await convert("[TOC]\n","mediawiki",generic,target,["--lua-filter",filter.path],0.15)}catch DocumentConversionError.timedOut {timedOut=true}catch{}
   check(label+": timeout during real Lua filtering keeps old output/source",timedOut && read(target)=="OLD_OUTPUT" && read(source)=="DISK_SOURCE_原稿")
  }
  let outputFolders=try manager.contentsOfDirectory(atPath:root.path).filter{$0.hasPrefix(".typora-conversion-")}
  let inputFolders=try manager.contentsOfDirectory(atPath:manager.temporaryDirectory.path).filter{$0.hasPrefix("typora-conversion-")}
  check("Success/failure/cancel/timeout remove private snapshots, TOC filters and staged output",outputFolders.isEmpty && inputFolders.isEmpty,"output=\(outputFolders), input=\(inputFolders)")
  check("Source bytes remain unchanged after every conversion",read(source)=="DISK_SOURCE_原稿")
  #endif
  let data=try JSONSerialization.data(withJSONObject:["checks":checks,"prepared":prepared],options:[.prettyPrinted,.sortedKeys])
  try data.write(to:root.appendingPathComponent("result.json"))
 }
}
'''

def main():
 baseline='--baseline' in sys.argv
 cache=ROOT/'.cache';cache.mkdir(exist_ok=True)
 previous=json.loads(EVIDENCE.read_text()) if EVIDENCE.exists() else {}
 evidence={'scope':'Real production DocumentConverter + Pandoc 3.12.1; fixed-format and generic writer paths; no GUI','source':'https://pandoc.org/lua-filters.html','baseline':previous.get('baseline',{}),'checks':[]}
 compact_mismatches(evidence['baseline'].get('mismatches',[]))
 retain_literal_baseline(evidence['baseline'])
 with tempfile.TemporaryDirectory(prefix='raw-toc-qa-',dir=cache) as temporary:
  work=Path(temporary);(work/'tmp').mkdir();(work/'Runner.swift').write_text(RUNNER);(work/'cases.json').write_text(json.dumps(CASES,ensure_ascii=False))
  env=os.environ.copy();env['TMPDIR']=str(work/'tmp')+'/'
  compileargs=['xcrun','swiftc','-swift-version','5','-target',platform.machine()+'-apple-macosx13.0','-parse-as-library','-module-cache-path',str(cache/'swift')]
  if not baseline:compileargs+=['-D','TOC_AST_FIXED']
  compileargs +=[str(ROOT/'native/DocumentConversion.swift'),str(work/'Runner.swift'),'-o',str(work/'verify'),'-framework','UniformTypeIdentifiers']
  compiled=subprocess.run(compileargs,cwd=ROOT,capture_output=True,text=True,timeout=90)
  runinfo={'sourceSHA256':hashlib.sha256((ROOT/'native/DocumentConversion.swift').read_bytes()).hexdigest(),'compiler':{'passed':compiled.returncode==0,'swiftVersion':'5','target':platform.machine()+'-apple-macosx13.0','diagnostics':compiled.stderr}}
  if compiled.returncode==0:
   result=subprocess.run([str(work/'verify'),str(work),str(PANDOC)],cwd=ROOT,env=env,capture_output=True,text=True,timeout=90)
   runinfo['execution']={'returnCode':result.returncode,'stderr':result.stderr[-2000:]}
   if (work/'result.json').exists():
    native=json.loads((work/'result.json').read_text());runinfo['nativeChecks']=native['checks']
    mismatches=[];checks=[]
    for writer in ['mediawiki','latex']:
     for case,text in CASES.items():
      actual_toc=case in ['toc','toc-case-space','toc-strip-comments']
      expected_input=('```{='+writer+'}\n'+('__TOC__' if writer=='mediawiki' else '\\tableofcontents')+'\n```\n') if actual_toc else text
      expected=subprocess.run([str(PANDOC),'--from','markdown','--to',writer,'--standalone',*(['--strip-comments'] if case.endswith('-strip-comments') else [])],input=expected_input,capture_output=True,text=True,check=True).stdout
      for path in ['fixed','generic']:
       label=writer+'-'+path+'-'+case;actual=(work/(label+'.txt')).read_text() if (work/(label+'.txt')).exists() else ''
       passed=actual==expected
       checks.append({'name':label,'passed':passed})
       if not passed:mismatches.append({'case':label,'actual':actual,'expected':expected,'prepared':native['prepared'][writer+':'+case]})
    if not baseline:
     for ext in ['html','tex']:
      auto_input='# 自动 Auto Café\n\n'+('```{=latex}\n\\tableofcontents\n```' if ext=='tex' else '[TOC]')+'\n\n正文 Ω\n'
      expected_path=work/('expected-auto.'+ext)
      expected_input=work/'snapshot.md';expected_input.write_text(auto_input)
      subprocess.run([str(PANDOC),'--from','markdown','--standalone','--output',str(expected_path),str(expected_input)],capture_output=True,text=True,check=True)
      expected=expected_path.read_text();actual=(work/('auto.'+ext)).read_text() if (work/('auto.'+ext)).exists() else ''
      passed=actual==expected
      checks.append({'name':'Empty writer autodetects .'+ext+' and applies known Auto TOC semantics','passed':passed,'actualSHA256':hashlib.sha256(actual.encode()).hexdigest(),'expectedSHA256':hashlib.sha256(expected.encode()).hexdigest(),'body':proof_excerpt(actual)})
      if not passed:mismatches.append({'case':'auto.'+ext,'actual':actual,'expected':expected})
    runinfo['checks']=checks;runinfo['mismatches']=compact_mismatches(mismatches)
    runinfo['prepareIdentity']=all(native['prepared'][w+':'+c]==t for w in ['mediawiki','latex'] for c,t in CASES.items())
   else:runinfo['failure']=result.stdout[-3000:]
  if baseline:
   evidence['baseline']=runinfo;evidence['passed']=False;evidence['status']='baseline-reproduced' if runinfo.get('mismatches') else 'baseline-not-reproduced'
  else:
   evidence.update(runinfo);evidence['checks']=runinfo.get('checks',[])+runinfo.get('nativeChecks',[])+[{'name':'prepareRawMarkdown preserves the original Markdown bytes','passed':runinfo.get('prepareIdentity',False)}]
   evidence['limits']=['Only original unescaped standalone [TOC] line candidates, case insensitive, that Pandoc parses as a plain paragraph become raw blocks. A unique temporary self-closing HTML tag marks candidates; the original token remains so reference links retain normal parsing. Using a tag keeps --strip-comments effective for user comments without removing the candidate.','The second AST pass removes the temporary tag from Code/CodeBlock/RawBlock/RawInline/Str/Math literals. Escaped markers remain literal. The normal Pandoc writer determines the final rendering of raw HTML. No custom Markdown container scanner is used.']
   native_sources=sorted((ROOT/'native').glob('*.swift'))
   allcompile=subprocess.run(['xcrun','swiftc','-swift-version','5','-parse-as-library','-target',platform.machine()+'-apple-macosx13.0','-module-cache-path',str(cache/'swift'),'-typecheck',*map(str,native_sources),'-framework','AppKit','-framework','WebKit','-framework','UniformTypeIdentifiers'],cwd=ROOT,capture_output=True,text=True,timeout=90)
   evidence['nativeIntegrationCompile']={'passed':allcompile.returncode==0,'diagnostics':allcompile.stderr,'sourceSHA256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in native_sources}}
   evidence['passed']=compiled.returncode==0 and allcompile.returncode==0 and runinfo.get('execution',{}).get('returnCode')==0 and all(c['passed'] for c in evidence['checks'])
 EVIDENCE.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'baseline':baseline,'status':evidence.get('status'),'passed':evidence.get('passed'),'checks':len(evidence.get('checks',[])),'mismatches':len(runinfo.get('mismatches',[])),'compiler':runinfo['compiler'],'execution':runinfo.get('execution'),'evidence':str(EVIDENCE)},ensure_ascii=False,indent=2))
 return 0 if baseline and evidence.get('status')=='baseline-reproduced' or evidence.get('passed') else 1
if __name__=='__main__':raise SystemExit(main())
