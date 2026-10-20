#!/usr/bin/env python3
"""Exercise production export consumer helpers with real child processes and files.
No GUI or stored user commands/preferences are opened. All commands are fixtures.
"""
import hashlib,json,platform,subprocess,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
RUNNER=r'''
import Foundation
import AppKit
import Darwin

@MainActor enum PostProbe {
    static var locations:[String]=[], files:[String]=[], output:[String]=[]
    static var mainThread=true
    static func reset() {
        locations=[];files=[];output=[];mainThread=true
        ExportPostActions.openFolder={locations.append($0.path);mainThread = mainThread && Thread.isMainThread}
        ExportPostActions.openFile={files.append($0.path);mainThread = mainThread && Thread.isMainThread}
        ExportPostActions.presentOutput={output.append($0);mainThread = mainThread && Thread.isMainThread}
        ExportPostActions.runPostCommand=nil
    }
}
@main struct VerifyNativeExportSettings {
    static func main() async {
        let folder=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true),python=CommandLine.arguments[2],pandoc=CommandLine.arguments[3]
        let manager=FileManager.default
        var checks:[[String:Any]]=[]
        func check(_ name:String,_ condition:Bool,_ detail:[String:Any]=[:]) { checks.append(["name":name,"passed":condition,"detail":detail]) }
        func quote(_ text:String)->String { "'"+text.replacingOccurrences(of:"'",with:"'\\''")+"'" }
        func write(_ path:URL,_ value:String) throws {try manager.createDirectory(at:path.deletingLastPathComponent(),withIntermediateDirectories:true);try Data(value.utf8).write(to:path)}
        func read(_ path:URL)->String {(try? String(contentsOf:path,encoding:.utf8)) ?? ""}
        let fixture=folder.appendingPathComponent("fixture.py")
        let env=ProcessInfo.processInfo.environment
        func run(_ mode:String,_ arguments:[String]=[],timeout:TimeInterval=5,cancellation:ConversionCancellation=ConversionCancellation()) throws -> ProcessGroupLauncher.Capture {
            try ProcessGroupLauncher.run(executable:python,arguments:[fixture.path,mode]+arguments,environment:env,cwd:folder.path,timeout:timeout,cancellation:cancellation)
        }
        do {
            let begin=ProcessInfo.processInfo.systemUptime
            let burst=try run("burst")
            check("Concurrent stdout/stderr bursts complete, are bounded and valid UTF-8",burst.stdout.utf8.count<=16384 && burst.stderr.utf8.count<=16384 && burst.stdout.contains("truncated") && burst.stderr.contains("truncated") && ProcessInfo.processInfo.systemUptime-begin<4,["stdoutBytes":burst.stdout.utf8.count,"stderrBytes":burst.stderr.utf8.count])
            let eof=try run("stdin")
            check("Child stdin is the null device",eof.stdout.trimmingCharacters(in:.whitespacesAndNewlines) == "0")
            var exitCode=false
            do {_ = try run("exit")}catch DocumentConversionError.processFailed(let code,let diagnostic){exitCode=code == 7 && diagnostic.contains("FIXTURE_ERROR")}catch{}
            check("Real nonzero child status and stderr are propagated",exitCode)
            let fdBefore=(try? manager.contentsOfDirectory(atPath:"/dev/fd").count) ?? 0
            var launchFailures=0
            for _ in 0..<25 {do {_ = try ProcessGroupLauncher.run(executable:folder.appendingPathComponent("missing-executable").path,arguments:[],environment:env,cwd:folder.path,timeout:1,cancellation:ConversionCancellation())}catch{launchFailures+=1}}
            let fdAfter=(try? manager.contentsOfDirectory(atPath:"/dev/fd").count) ?? 0
            check("Failed spawn closes pipe descriptors",launchFailures == 25 && fdAfter<=fdBefore+1,["before":fdBefore,"after":fdAfter])
            var nulRejected=0
            for args in [["bad\0argument"],["stdin"]] {
                do {_ = try ProcessGroupLauncher.run(executable:python,arguments:args,environment:args.count == 1 && args[0] == "stdin" ? ["BAD":"value\0suffix"]:env,cwd:folder.path,timeout:1,cancellation:ConversionCancellation())}catch{nulRejected+=1}
            }
            check("NUL arguments and environment values fail before spawn",nulRejected == 2)
            for mode in ["timeout","cancel"] {
                let pidFile=folder.appendingPathComponent(mode+"-pid"),late=folder.appendingPathComponent(mode+"-late")
                let token=ConversionCancellation()
                if mode == "cancel" {DispatchQueue.global().async {
                    let deadline=ProcessInfo.processInfo.systemUptime+1.5
                    while !FileManager.default.fileExists(atPath:pidFile.path),ProcessInfo.processInfo.systemUptime<deadline {usleep(5_000)}
                    token.cancel()
                }}
                let start=ProcessInfo.processInfo.systemUptime
                var expected=false
                do {_ = try run("tree",[pidFile.path,late.path],timeout:mode == "timeout" ? 0.15:3,cancellation:token)}catch DocumentConversionError.cancelled {expected=mode == "cancel"}catch DocumentConversionError.timedOut {expected=mode == "timeout"}catch{}
                let duration=ProcessInfo.processInfo.systemUptime-start
                var status:Int32=0
                let pid=pid_t(read(pidFile).trimmingCharacters(in:.whitespacesAndNewlines)) ?? 0
                let reaped=pid>0 && waitpid(pid,&status,WNOHANG) == -1 && errno == ECHILD
                try await Task.sleep(nanoseconds:1_300_000_000)
                check("\(mode): group descendants stop and the leader is reaped once",expected && duration<1.5 && reaped && !manager.fileExists(atPath:late.path),["seconds":duration,"leaderReaped":reaped,"lateSideEffect":manager.fileExists(atPath:late.path)])
            }
            let bgStart=ProcessInfo.processInfo.systemUptime
            let bg=try run("inherited-fd")
            check("Successful background descendant does not hold capture open on pipe EOF",bg.stdout.contains("PARENT_DONE") && ProcessInfo.processInfo.systemUptime-bgStart<0.6)
            let sourceDir=folder.appendingPathComponent("源 folder '\" #$",isDirectory:true)
            try manager.createDirectory(at:sourceDir,withIntermediateDirectories:true)
            try write(sourceDir.appendingPathComponent("resource.txt"),"RELATIVE_ASSET")
            let source=sourceDir.appendingPathComponent("原稿 ' \" $(literal) #.md")
            try write(source,"DISK_ORIGINAL")
            let target=folder.appendingPathComponent("output ' \" #.txt")
            let title="标题 '\"; $(touch INJECTED) `touch ALSO_INJECTED`\n第二行"
            let metadata=["sourcePath":source.path,"title":title,"author":"作者","nested.key":"nested ' \" value","today":"2026-10-20"]
            let command=quote(python)+" "+quote(fixture.path)+" macros ${inputPath} \"${inputPath}\" '${inputPath}' pre${title}post \"${title}\" '${title}' '${nested.key}' ${currentPath} ${currentFileName} ${currentFileFullName} ${currentFolder} ${outputPath} ${outputFileName} ${outputFileFullName} ${today} \\${title}"
            let result=try CustomCommandRunner.run(command:command,snapshot:"CURRENT_UNSAVED 中文",sourceDirectory:sourceDir,output:target,metadata:metadata,cancellation:ConversionCancellation())
            let json=try JSONSerialization.jsonObject(with:Data(result.utf8)) as! [String:Any],args=json["args"] as! [String]
            let inputPath=args[0]
            check("Official path/name macros and source cwd reach the actual shell consumer",args[7] == source.path && args[8] == source.deletingPathExtension().lastPathComponent && args[9] == source.lastPathComponent && args[10] == sourceDir.path && args[11] == target.path && args[12] == target.deletingPathExtension().lastPathComponent && args[13] == target.lastPathComponent && args[14] == "2026-10-20" && json["cwd"] as? String == sourceDir.path && json["asset"] as? String == "RELATIVE_ASSET",["args":args,"cwd":json["cwd"] ?? ""])
            check("Macros preserve single/double quotes, literal escapes and nested metadata without evaluation",args[0] == args[1] && args[1] == args[2] && args[3] == "pre"+title+"post" && args[4] == title && args[5] == title && args[6] == metadata["nested.key"] && args[15] == "${title}" && !manager.fileExists(atPath:sourceDir.appendingPathComponent("INJECTED").path) && !manager.fileExists(atPath:sourceDir.appendingPathComponent("ALSO_INJECTED").path))
            check("Snapshot input is current UTF-8, private and removed while original remains exact",json["snapshot"] as? String == "CURRENT_UNSAVED 中文" && inputPath != source.path && !manager.fileExists(atPath:inputPath) && read(source) == "DISK_ORIGINAL")
            let noOutput=try CustomCommandRunner.run(command:"printf '%s|%s|%s' '${outputPath}' '${outputFileName}' '${outputFolder}'",snapshot:"x",sourceDirectory:sourceDir,output:nil,cancellation:ConversionCancellation())
            check("No-dialog commands have empty output macros rather than a source destination",noOutput == "||")
            var commandNul=false
            do {_ = try CustomCommandRunner.run(command:"printf BAD\0suffix",snapshot:"x",sourceDirectory:sourceDir,output:nil,cancellation:ConversionCancellation())}catch{commandNul=true}
            check("Custom command NUL cannot silently truncate executable text",commandNul)
            let dest=folder.appendingPathComponent("managed",isDirectory:true),stage=folder.appendingPathComponent("stage",isDirectory:true)
            try manager.createDirectory(at:dest,withIntermediateDirectories:true);try manager.createDirectory(at:stage,withIntermediateDirectories:true)
            let original=dest.appendingPathComponent("original.md");try write(original,"KEEP_SOURCE")
            try write(dest.appendingPathComponent("a.txt"),"OLD_A");try write(dest.appendingPathComponent("keep.txt"),"UNRELATED")
            try write(dest.appendingPathComponent("assets/b.txt"),"OLD_B");try write(dest.appendingPathComponent("assets/keep.txt"),"KEEP_ASSET")
            try write(stage.appendingPathComponent("a.txt"),"NEW_A");try write(stage.appendingPathComponent("assets/b.txt"),"NEW_B");try write(stage.appendingPathComponent("assets/c.txt"),"NEW_C")
            try ExportStaging.commitFolderItems(staging:stage,destination:dest,source:original)
            check("Folder commit replaces produced names and recursively retains unrelated files/source",read(dest.appendingPathComponent("a.txt")) == "NEW_A" && read(dest.appendingPathComponent("assets/b.txt")) == "NEW_B" && read(dest.appendingPathComponent("assets/c.txt")) == "NEW_C" && read(dest.appendingPathComponent("assets/keep.txt")) == "KEEP_ASSET" && read(dest.appendingPathComponent("keep.txt")) == "UNRELATED" && read(original) == "KEEP_SOURCE")
            let bad=folder.appendingPathComponent("bad-stage",isDirectory:true);try write(bad.appendingPathComponent("a.txt"),"AFTER_BAD");try write(bad.appendingPathComponent("new/created.txt"),"CREATED");try write(bad.appendingPathComponent("z"),"TYPE_CONFLICT")
            try write(dest.appendingPathComponent("z/user.txt"),"KEEP_DIRECTORY")
            var failed=false;do {try ExportStaging.commitFolderItems(staging:bad,destination:dest,source:original)}catch{failed=true}
            check("A later folder conflict rolls back replaced and newly created entries",failed && read(dest.appendingPathComponent("a.txt")) == "NEW_A" && !manager.fileExists(atPath:dest.appendingPathComponent("new").path) && read(dest.appendingPathComponent("z/user.txt")) == "KEEP_DIRECTORY")
            let sourceStage=folder.appendingPathComponent("source-stage",isDirectory:true);try write(sourceStage.appendingPathComponent("original.md"),"CORRUPT")
            var protected=false;do{try ExportStaging.commitFolderItems(staging:sourceStage,destination:dest,source:original)}catch{protected=true}
            check("Folder source collision is rejected without changing original bytes",protected && read(original) == "KEEP_SOURCE")
            let fileStage=folder.appendingPathComponent("one-stage.txt"),fileTarget=dest.appendingPathComponent("one.txt")
            try write(fileStage,"ATOMIC_NEW");try write(fileTarget,"ATOMIC_OLD");try ExportStaging.commitFile(staging:fileStage,destination:fileTarget,source:original)
            var missing=false;do{try ExportStaging.commitFile(staging:fileStage,destination:fileTarget,source:original)}catch{missing=true}
            check("File commit is atomic and a missing output preserves its prior target",missing && read(fileTarget) == "ATOMIC_NEW")
            try write(fileStage,"");try ExportStaging.commitFile(staging:fileStage,destination:fileTarget,source:original)
            check("An intentionally empty regular command output remains valid",read(fileTarget).isEmpty && !manager.fileExists(atPath:fileStage.path))
            check("Folder transaction recovery materials are cleaned after success and rollback",!(try manager.contentsOfDirectory(atPath:dest.path)).contains{$0.hasPrefix(".typora-export-transaction-")})
            var parsed=try PandocArgv.split("--css '/tmp/a b.css' --metadata \"empty=\" --css \"\" --template /tmp/a\\ b.tex --metadata \"a\\b\"")
            check("Pandoc argv splitting retains empty quoted args, spaces and literal backslashes",parsed == ["--css","/tmp/a b.css","--metadata","empty=","--css","","--template","/tmp/a b.tex","--metadata","a\\b"],["parsed":parsed])
            var blocked=0
            for input in ["-o/tmp/source.md","-so/tmp/source.md","--out=/tmp/source.md","--lo=/tmp/log","--def=/tmp/defaults.yaml","-d/tmp/defaults.yaml","--extr=/tmp/media"] {do{_ = try PandocArgv.sanitize(input)}catch{blocked+=1}}
            check("Exact, compact, clustered and abbreviated transport/default flags are rejected",blocked == 7,["blocked":blocked])
            parsed=try PandocArgv.sanitize("--data-dir '/tmp/data dir' --css '/tmp/a$(literal).css' --metadata title='a`b' extra-input.md")
            check("Ordinary Pandoc resources and extra input paths retain argv semantics",parsed.contains("/tmp/data dir") && parsed.contains("/tmp/a$(literal).css") && parsed.contains("title=a`b") && parsed.contains("extra-input.md"))
            let svg=PandocArgv.structuredFlags(["webtex":true,"webtex-format":"svg","title":"META_TITLE","author":"META_AUTHOR"])
            let png=PandocArgv.structuredFlags(["webtex":true,"webtex-format":"png"])
            let markdown=folder.appendingPathComponent("math.md");try write(markdown,"$x$\n")
            let svgHTML=try ProcessGroupLauncher.run(executable:pandoc,arguments:["-f","markdown","-t","html5"]+svg+[markdown.path],environment:env,cwd:folder.path,timeout:5,cancellation:ConversionCancellation())
            let pngHTML=try ProcessGroupLauncher.run(executable:pandoc,arguments:["-f","markdown","-t","html5"]+png+[markdown.path],environment:env,cwd:folder.path,timeout:5,cancellation:ConversionCancellation())
            check("Real Pandoc receives valid PNG/default and SVG WebTeX URLs",svgHTML.stdout.contains("https://latex.codecogs.com/svg.latex?") && pngHTML.stdout.contains("https://latex.codecogs.com/png.latex?"),["svgFlags":svg,"pngFlags":png])
            let jsonAST=try ProcessGroupLauncher.run(executable:pandoc,arguments:["-f","markdown","-t","json"]+svg+[markdown.path],environment:env,cwd:folder.path,timeout:5,cancellation:ConversionCancellation())
            let ast=try JSONSerialization.jsonObject(with:Data(jsonAST.stdout.utf8)) as! [String:Any]
            check("Structured global title/author become real Pandoc metadata",String(describing:ast["meta"] ?? "").contains("META_TITLE") && String(describing:ast["meta"] ?? "").contains("META_AUTHOR"))
            let settings=ExportSettingsDocument.fromJSON(["general":["exportFolder":"same"],"formats":["pdf":["paper.custom":[148,210],"openExportLocation":false]],"customExport":[["key":"pdf","name":"preset","type":"pdf"],["key":"docx","name":"one","type":"docx"],["key":"docx","name":"two","type":"docx"]]])
            let keys=settings.customExport.map(\.key),frozen=settings.freeze(key:"pdf")!,options=frozen["options"] as! [String:Any]
            check("Native normalization avoids reserved/duplicate IDs and freeze rejects removed entries",Set(keys).count == 3 && !keys.contains("pdf") && settings.freeze(key:"removed") == nil,["keys":keys])
            check("Native PDF/Markdown defaults and boolean JSON values agree with consumers",options["paper.marginTop"] as? Int == 16 && options["openExportLocation"] as? Bool == false && settings.schemaDefaults("markdown")["webtex-format"] as? String == "png")
            let roundTripInput=try JSONSerialization.jsonObject(with:Data(#"{"formats":{"html":{"sidebar":true,"allowPerFileSetting":true},"image":{"quality":2,"imageWidth":640}},"customExport":[{"key":"preset","name":"preset","type":"html","sidebar":false,"appendHead":"LEGACY"}]}"#.utf8))
            var roundTrip=ExportSettingsDocument.fromJSON(roundTripInput)
            roundTrip.formats["preset"]=["sidebar":.bool(true),"appendHead":.string("UI_CURRENT")]
            roundTrip=ExportSettingsDocument.fromJSON(roundTrip.jsonObject())
            let htmlOptions=roundTrip.freeze(key:"html")!["options"] as! [String:Any],imageOptions=roundTrip.freeze(key:"image")!["options"] as! [String:Any],presetOptions=roundTrip.freeze(key:"preset")!["options"] as! [String:Any]
            func boolean(_ value:Any?) -> Bool {guard let n=value as? NSNumber else{return false};return CFGetTypeID(n) == CFBooleanGetTypeID()}
            check("Actual JSON roundtrip keeps toggles boolean and dimensions/quality numeric",htmlOptions["sidebar"] as? Bool == true && htmlOptions["allowPerFileSetting"] as? Bool == true && boolean(htmlOptions["sidebar"]) && boolean(htmlOptions["allowPerFileSetting"]) && !boolean(imageOptions["quality"]) && !boolean(imageOptions["imageWidth"]) && imageOptions["quality"] as? Int == 2 && imageOptions["imageWidth"] as? Int == 640)
            check("UI format options override legacy custom entry extras",presetOptions["sidebar"] as? Bool == true && presetOptions["appendHead"] as? String == "UI_CURRENT")
            await MainActor.run {PostProbe.reset()}
            var general=ExportGeneralSettings();general.openExportLocation=true
            await ExportPostActions.fire(options:["type":"html"],general:general,destination:fileTarget,output:nil,sourceDirectory:sourceDir,succeeded:true)
            await ExportPostActions.fire(options:["type":"html","openExportLocation":false],general:general,destination:fileTarget,output:nil,sourceDirectory:sourceDir,succeeded:true)
            let inherited=await MainActor.run {PostProbe.locations.count == 1 && PostProbe.mainThread}
            check("Post folder inheritance honors absent/explicit false and opens on MainActor",inherited)
            await MainActor.run {PostProbe.reset()}
            let postStart=ProcessInfo.processInfo.systemUptime
            let post=Task { @MainActor in await ExportPostActions.fire(options:["type":"html","runCommand":true,"runCommandStr":"sleep 0.25; printf '%s' '${title}'","showOutput":true],general:ExportGeneralSettings(),destination:fileTarget,output:"MAIN:",sourceDirectory:sourceDir,succeeded:true,snapshot:"POST_SNAPSHOT",metadata:["title":"POST_TITLE"]) }
            try await Task.sleep(nanoseconds:30_000_000)
            let tick=await MainActor.run {ProcessInfo.processInfo.systemUptime-postStart}
            await post.value
            let postResult=await MainActor.run {PostProbe.output == ["MAIN:POST_TITLE"] && PostProbe.mainThread}
            check("Post shell runs asynchronously, receives metadata and presents on MainActor",tick<0.15 && postResult,["mainActorTickSeconds":tick])
            await MainActor.run {PostProbe.reset()}
            let marker=sourceDir.appendingPathComponent("POST_CANCELLED")
            let cancelPost=Task { @MainActor in await ExportPostActions.fire(options:["type":"html","runCommand":true,"runCommandStr":"sleep 1; touch POST_CANCELLED","showOutput":true],general:ExportGeneralSettings(),destination:fileTarget,output:nil,sourceDirectory:sourceDir,succeeded:true) }
            try await Task.sleep(nanoseconds:70_000_000);cancelPost.cancel();await cancelPost.value
            try await Task.sleep(nanoseconds:1_100_000_000)
            let noDialog=await MainActor.run {PostProbe.output.isEmpty}
            check("Post Task cancellation reaches process group and suppresses late UI",!manager.fileExists(atPath:marker.path) && noDialog)
        } catch {check("Native helper checks finish without unexpected failure",false,["error":error.localizedDescription])}
        let result:[String:Any]=["passed":checks.allSatisfy{$0["passed"] as? Bool == true},"checks":checks]
        let data=try! JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]);try!data.write(to:folder.appendingPathComponent("result.json"));print(String(decoding:data,as:UTF8.self))
    }
}
'''
FIXTURE=r'''
import os,sys,time,threading,signal,json
from pathlib import Path
mode=sys.argv[1]
if mode=='burst':
 def send(fd,text):
  data=text.encode()*250000
  while data:
   count=os.write(fd,data);data=data[count:]
 a=threading.Thread(target=send,args=(1,'中'));b=threading.Thread(target=send,args=(2,'错'));a.start();b.start();a.join();b.join()
elif mode=='stdin': print(len(sys.stdin.read()))
elif mode=='exit': print('FIXTURE_ERROR',file=sys.stderr);sys.exit(7)
elif mode=='tree':
 ready_read,ready_write=os.pipe()
 child=os.fork()
 if child==0:
  os.close(ready_read);signal.signal(signal.SIGTERM,signal.SIG_IGN);os.write(ready_write,b'R');os.close(ready_write)
  time.sleep(1);Path(sys.argv[3]).write_text('LATE');os._exit(0)
 os.close(ready_write);os.read(ready_read,1);os.close(ready_read)
 Path(sys.argv[2]).write_text(str(os.getpid()))
 time.sleep(10)
elif mode=='inherited-fd':
 child=os.fork()
 if child==0:time.sleep(0.9);os._exit(0)
 print('PARENT_DONE',flush=True)
elif mode=='macros':
 args=sys.argv[2:]
 print(json.dumps({'args':args,'cwd':str(Path.cwd()),'snapshot':Path(args[0]).read_text(),'asset':Path('resource.txt').read_text()},ensure_ascii=False))
'''

def main():
 evidence={'scope':'Production native ExportSettings helpers against actual DocumentConversion declarations, real fixture shells/Pandoc/files; no GUI or user preference/command execution','limits':['User commands retain source cwd; arbitrary command side effects cannot be rolled back.','Folder commit is a rollback-capable batch, not a directory-wide atomic replacement. Conflicting file/directory types fail without deleting unrelated contents.'],'sources':['https://support.typora.io/Export/#variables','https://support.typora.io/Export/#other-formats-using-custom-commands','https://pandoc.org/MANUAL.html#math-rendering'],'checks':[]}
 cache=ROOT/'.cache';cache.mkdir(exist_ok=True)
 with tempfile.TemporaryDirectory(prefix='native-export-settings-',dir=cache) as temporary:
  work=Path(temporary);(work/'Runner.swift').write_text(RUNNER);(work/'fixture.py').write_text(FIXTURE)
  consumer=(ROOT/'native/DocumentConversion.swift').read_bytes();(work/'DocumentConversion.swift').write_bytes(consumer)
  evidence['sourceSHA256']={name:hashlib.sha256((ROOT/'native'/name).read_bytes()).hexdigest() for name in ['ExportSettings.swift','DocumentConversion.swift']}
  compile=subprocess.run(['xcrun','swiftc','-swift-version','5','-parse-as-library','-target',platform.machine()+'-apple-macosx13.0','-module-cache-path',str(cache/'swift'),str(ROOT/'native/ExportSettings.swift'),str(work/'DocumentConversion.swift'),str(work/'Runner.swift'),'-o',str(work/'verify'),'-framework','AppKit','-framework','UniformTypeIdentifiers'],cwd=ROOT,capture_output=True,text=True,timeout=90)
  evidence['compiler']={'passed':compile.returncode==0,'languageVersion':'5','target':platform.machine()+'-apple-macosx13.0','diagnostics':compile.stderr}
  if compile.returncode==0:
   pandoc=ROOT/'.cache/pandoc/pandoc-3.12.1-x86_64/bin/pandoc'
   run=subprocess.run([str(work/'verify'),str(work),__import__('sys').executable,str(pandoc)],cwd=ROOT,capture_output=True,text=True,timeout=50)
   evidence['execution']={'returnCode':run.returncode,'stderr':run.stderr[-2000:]}
   if (work/'result.json').exists():evidence.update(json.loads((work/'result.json').read_text()))
   else:evidence['passed']=False;evidence['failure']=run.stdout[-2500:]
  else:evidence['passed']=False
 (ROOT/'evidence/native-export-settings-verification.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
 checks=evidence.get('checks',[])
 print(json.dumps({'passed':evidence.get('passed',False),'checks':str(sum(check.get('passed',False) for check in checks))+'/'+str(len(checks)),'evidence':'evidence/native-export-settings-verification.json','failures':[check for check in checks if not check.get('passed')],'compiler':evidence.get('compiler')},ensure_ascii=False,indent=2));return 0 if evidence.get('passed') else 1
if __name__=='__main__':raise SystemExit(main())
