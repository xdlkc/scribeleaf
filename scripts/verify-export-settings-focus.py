#!/usr/bin/env python3
"""Build an isolated production-source Preferences focus and rename probe. GUI only by MCP."""
import importlib.util
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('nativeqa', ROOT / 'scripts/verify-export-settings-native.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
qa.WORK = ROOT / '.cache/export-settings-focus'
qa.APP = qa.WORK / 'ExportSettingsVerifier.app'
qa.FIXTURE = qa.WORK / 'fixtures'
qa.EVIDENCE = ROOT / 'evidence/export-settings-focus-verification.json'
qa.RUNNER = r'''
import AppKit
import WebKit
import Foundation
@MainActor final class FocusVerifier: NSObject, NSApplicationDelegate {
    let menuOwner = AppDelegate()
    let doc = MarkdownDocument()
    var inspector: NSWindow!
    var status: NSTextField!
    var checks: [[String:Any]] = []
    var originalClipboard: [[NSPasteboard.PasteboardType:Data]] = []
    let root = Bundle.main.bundleURL.deletingLastPathComponent()
    func applicationDidFinishLaunching(_ notification: Notification) {
        setenv("TYPORA_REPLICA_DEFAULTS_SUITE", Bundle.main.bundleIdentifier!, 1)
        AppPreferencesStore.defaults.removePersistentDomain(forName: Bundle.main.bundleIdentifier!)
        originalClipboard = (NSPasteboard.general.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType:type).map { (type,$0) } })
        }
        AppDelegate.shared = menuOwner; menuOwner.buildMenu()
        doc.fileType = MarkdownDocument.documentType
        doc.fileURL = root.appendingPathComponent("fixtures/source-a.md")
        doc.markdown = "# FOCUS_BACKGROUND\n\nDo not edit this document.\n"
        doc.lastSavedMarkdown = doc.markdown
        NSDocumentController.shared.addDocument(doc); doc.makeWindowControllers(); doc.showWindows()
        doc.watchTimer?.invalidate(); doc.watchTimer = nil
        inspector = NSWindow(contentRect:NSRect(x:40,y:40,width:560,height:200),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        inspector.isReleasedWhenClosed=false; inspector.title="Preferences focus verifier"
        let content=NSView(frame:NSRect(x:0,y:0,width:560,height:200))
        status=NSTextField(wrappingLabelWithString:"Open Preferences. Test local A/C/V/Undo in Pandoc path, then Probe. Rename Word to QA Renamed, then Record rename.")
        status.frame=NSRect(x:16,y:100,width:528,height:80);content.addSubview(status)
        let labels=["Open Preferences","Probe focus","Record rename","Finish"]
        let actions=[#selector(openPrefs),#selector(probe),#selector(rename),#selector(finish)]
        for i in 0..<4 { let b=NSButton(title:labels[i],target:self,action:actions[i]);b.frame=NSRect(x:12+i*135,y:24,width:132,height:40);content.addSubview(b) }
        inspector.contentView=content;inspector.level = .floating;inspector.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        save()
    }
    func record(_ name:String,_ ok:Bool,_ detail:Any="") { checks.append(["name":name,"passed":ok,"detail":detail]);status.stringValue="\(ok ? "PASS":"FAIL") \(name)";save() }
    func save() { let obj:[String:Any]=["bundleIdentifier":Bundle.main.bundleIdentifier!,"pid":ProcessInfo.processInfo.processIdentifier,"checks":checks,"passed":!checks.isEmpty && checks.allSatisfy{$0["passed"] as? Bool == true}];if let data=try? JSONSerialization.data(withJSONObject:obj,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:root.appendingPathComponent("focus-result.json"),options:.atomic)} }
    @objc func openPrefs(){PreferencesController.shared.show(tab:"export")}
    func prefsWeb()->WKWebView? { NSApp.windows.first{$0.identifier?.rawValue == "preferences"}?.contentView as? WKWebView }
    @objc func probe(){
        openPrefs()
        DispatchQueue.main.asyncAfter(deadline:.now()+0.5){[self] in
            guard let web=prefsWeb() else{record("Preferences window exists",false);return}
            web.evaluateJavaScript("({tag:document.activeElement?.tagName,value:document.activeElement?.value,selection:document.activeElement?.selectionStart})"){[self] value,error in
                let dict=value as? [String:Any] ?? [:]
                record("Preferences keyWindow owns focused input", NSApp.keyWindow?.identifier?.rawValue == "preferences" && dict["tag"] as? String == "INPUT",dict)
                record("Local copy/paste/undo result remains in Preferences input",dict["value"] as? String == "LOCAL_SECOND",dict)
                let before=doc.markdown
                var disabled=true
                for command in ["bold","save","export:html"]{let item=NSMenuItem(title:command,action:nil,keyEquivalent:"");item.representedObject=command;disabled = disabled && !menuOwner.validateMenuItem(item);menuOwner.action(item)}
                record("Format/Save/Export menus disabled for Preferences",disabled && menuOwner.document == nil)
                DispatchQueue.main.asyncAfter(deadline:.now()+0.5){[self] in
                    record("Native commands preserve background Markdown and export state",doc.markdown == before && doc.repeatHistory.format == nil && doc.conversionTasks.isEmpty && doc.windowControllers.first?.window?.attachedSheet == nil,["markdown":doc.markdown])
                }
            }
        }
    }
    @objc func rename(){
        let settings=AppPreferencesStore.loadExport()
        let entry=settings.customExport.first{$0.key == "docx"}
        let menu=menuOwner.exportMenu?.items.map{$0.title} ?? []
        record("Native prompt rename persists and rebuilds actual export menu",entry?.name == "QA Renamed" && menu.contains("QA Renamed"),["name":entry?.name ?? "","menu":menu])
    }
    @objc func finish(){
        record("Source identity and disk bytes untouched",doc.fileURL?.lastPathComponent == "source-a.md" && doc.markdown == "# FOCUS_BACKGROUND\n\nDo not edit this document.\n")
        NSPasteboard.general.clearContents()
        let items=originalClipboard.map{values->NSPasteboardItem in let item=NSPasteboardItem();for(type,data)in values{item.setData(data,forType:type)};return item}
        if !items.isEmpty{NSPasteboard.general.writeObjects(items)}
        doc.close();AppPreferencesStore.defaults.removePersistentDomain(forName:Bundle.main.bundleIdentifier!)
        try? FileManager.default.removeItem(at:Recovery.folder.deletingLastPathComponent())
        save();DispatchQueue.main.asyncAfter(deadline:.now()+4){NSApp.terminate(nil)}
    }
}
@main struct Main {static func main(){let app=NSApplication.shared;let d=FocusVerifier();app.delegate=d;app.run()}}
'''
if __name__ == '__main__':
    import sys
    if '--prepare' in sys.argv:
        raise SystemExit(qa.prepare())
    result = qa.WORK / 'focus-result.json'
    data=json.loads(result.read_text())
    evidence=json.loads(qa.EVIDENCE.read_text())
    evidence['actualFocusAndRename']=data
    evidence['actualNative']={'status':'focus-and-rename-run','checks':len(data.get('checks',[])),'bundleIdentifier':data.get('bundleIdentifier')}
    unchanged = {name: (qa.WORK / name).is_file() and qa.digest(qa.WORK / name) == digest for name, digest in evidence.get('fixtureSourceSHA256',{}).items()}
    evidence['fixtureSourceUnchanged'] = unchanged
    evidence['scope'] = 'Actual native Preferences focus, local text shortcuts, rename and export-menu rebuild only; no format-conversion claim'
    evidence['wrapperSHA256'] = qa.digest(Path(__file__))
    evidence['passed']=data.get('passed') is True and len(data.get('checks',[]))>=6 and bool(unchanged) and all(unchanged.values())
    qa.EVIDENCE.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'passed':evidence['passed'],'checks':len(data.get('checks',[]))}))
    raise SystemExit(0 if evidence['passed'] else 1)
