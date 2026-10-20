// AX driver for this project's unique export-settings QA app only.
// It invokes real inspector buttons and native panel controls, not app methods.
import AppKit
import ApplicationServices

func fail(_ value: String) -> Never { fputs(value + "\n", stderr); exit(1) }
func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success ? value : nil
}
func text(_ e: AXUIElement, _ key: String = kAXTitleAttribute) -> String { attr(e,key) as? String ?? "" }
func walk(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    guard depth < 14 else { return [] }
    if ["AXTable","AXOutline","AXBrowser","AXWebArea","AXTextArea"].contains(text(element,kAXRoleAttribute)) { return [element] }
    return [element] + (attr(element,kAXChildrenAttribute) as? [AXUIElement] ?? []).flatMap { walk($0,depth:depth+1) }
}
func press(_ element: AXUIElement) {
    guard attr(element,kAXEnabledAttribute) as? Bool != false else { fail("Observed control is disabled") }
    guard AXUIElementPerformAction(element,kAXPressAction as CFString) == .success else { fail("AXPress failed") }
}
func panelWalk(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    guard depth < 12 else { return [] }
    if ["AXWebArea","AXTextArea"].contains(text(element,kAXRoleAttribute)) { return [element] }
    return [element] + (attr(element,kAXChildrenAttribute) as? [AXUIElement] ?? []).flatMap { panelWalk($0,depth:depth+1) }
}
let args=CommandLine.arguments
guard args.count >= 4, let pid=pid_t(args[2]), AXIsProcessTrusted() else { fail("Usage: driver <unique QA bundle> <PID> inspect|raise|next|save|cancel|replace|dismiss|restart|close [filename]") }
let bundle=args[1], action=args[3]
guard bundle.range(of:"^com\\.typora-replica\\.export-settings-verifier\\.[a-f0-9]{32}$",options:.regularExpression) != nil,
      let app=NSRunningApplication(processIdentifier:pid), app.bundleIdentifier==bundle else { fail("This is not the requested unique QA app") }
let work=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent(".cache/export-settings-native-verifier")
let expected=work.appendingPathComponent("ExportSettingsVerifier.app").standardizedFileURL.resolvingSymlinksInPath()
guard app.bundleURL?.standardizedFileURL.resolvingSymlinksInPath()==expected else { fail("QA app path does not match this workspace") }
let root=AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(root,2)
if action != "inspect" {
    app.activate(options:[])
    let until=Date().addingTimeInterval(2)
    while !app.isActive && Date()<until { RunLoop.current.run(until:Date().addingTimeInterval(0.05)) }
    guard app.isActive else { fail("QA app could not activate") }
}
let windows=attr(root,kAXWindowsAttribute) as? [AXUIElement] ?? []
let inspector=windows.first { w in walk(w).contains { text($0,kAXRoleAttribute)==kAXButtonRole && text($0)=="Restart verifier" } }
if ["inspect","inspect-active"].contains(action) {
    var rows:[[String:Any]]=[]
    for window in windows {
        rows.append(["window":text(window),"role":text(window,kAXRoleAttribute)])
        for e in walk(window) {
            let role=text(e,kAXRoleAttribute)
            guard [kAXButtonRole,kAXTextFieldRole,kAXSheetRole,"AXDialog",kAXComboBoxRole].contains(role) else { continue }
            rows.append(["role":role,"title":text(e),"description":text(e,kAXDescriptionAttribute),"identifier":text(e,kAXIdentifierAttribute),"value":String(text(e,kAXValueAttribute).prefix(140)),"enabled":attr(e,kAXEnabledAttribute) as? Bool ?? true])
        }
    }
    let bytes=try JSONSerialization.data(withJSONObject:rows,options:[.prettyPrinted,.sortedKeys])
    print(String(data:bytes,encoding:.utf8)!)
    exit(0)
}
if ["raise","next","restart","close"].contains(action) {
    guard let inspector else { fail("Inspector with observed Restart button is absent") }
    guard AXUIElementPerformAction(inspector,kAXRaiseAction as CFString) == .success else { fail("Inspector AXRaise failed") }
    AXUIElementSetAttributeValue(inspector,kAXMainAttribute as CFString,kCFBooleanTrue)
    if action=="raise" { print("Raised " + text(inspector));exit(0) }
    let label=action=="restart" ? "Restart verifier" : action=="close" ? "Close verifier" : nil
    guard let button=walk(inspector).first(where:{ e in
        guard text(e,kAXRoleAttribute)==kAXButtonRole else { return false }
        if let label { return text(e)==label }
        return text(e).range(of:"^[0-9]+ ",options:.regularExpression) != nil
    }) else { fail("Expected inspector button absent") }
    print("Press " + text(button));press(button)
} else if ["save","cancel","replace","dismiss","discard","folder"].contains(action) {
    let sheets=windows.flatMap { walk($0).filter { text($0,kAXRoleAttribute)==kAXSheetRole } }
    let candidates=sheets.isEmpty ? windows.filter { text($0,kAXRoleAttribute)=="AXDialog" || text($0).isEmpty } : sheets
    let alertLabels=action=="replace" ? ["Replace","替换"] : action=="discard" ? ["Don’t Save","Don't Save","不保存"] : ["OK","好","确定","Done","完成"]
    let alertWindow=["dismiss","replace","discard"].contains(action) ? windows.first(where:{walk($0).contains(where:{text($0,kAXRoleAttribute)==kAXButtonRole && alertLabels.contains(text($0))})}) : nil
    guard let panel=alertWindow ?? candidates.first else { fail("No observed native sheet/panel") }
    let elements=action=="folder" ? panelWalk(panel) : walk(panel)
    if action=="folder" {
        guard let data=try? Data(contentsOf:work.appendingPathComponent("result.json")),let result=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
              result["bundleIdentifier"] as? String==bundle,result["pid"] as? Int==Int(pid),result["step"] as? Int==9,
              let records=result["sheets"] as? [[String:Any]],let last=records.last,last["kind"] as? String=="open",last["directory"] as? String==work.appendingPathComponent("output").path
        else { fail("Folder action requires the QA stage9 picker in output") }
        guard let row=elements.first(where:{ e in text(e,kAXRoleAttribute)==kAXRowRole && panelWalk(e).contains(where:{ text($0)=="folder" || text($0,kAXValueAttribute)=="folder" }) }) else { fail("Observed folder row absent") }
        AXUIElementSetAttributeValue(row,kAXSelectedAttribute as CFString,kCFBooleanTrue)
        if attr(row,kAXSelectedAttribute) as? Bool != true {
            guard let p=attr(row,kAXPositionAttribute),let s=attr(row,kAXSizeAttribute) else { fail("Folder row geometry absent") }
            var point=CGPoint.zero,size=CGSize.zero
            guard AXValueGetValue(p as! AXValue,.cgPoint,&point),AXValueGetValue(s as! AXValue,.cgSize,&size) else { fail("Folder row geometry invalid") }
            let center=CGPoint(x:point.x+size.width/2,y:point.y+size.height/2)
            guard app.isActive else { fail("QA app is not active for folder row click") }
            for type in [CGEventType.mouseMoved,.leftMouseDown,.leftMouseUp] {
                if let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:center,mouseButton:.left) {event.setIntegerValueField(.mouseEventClickState,value:1);event.post(tap:.cghidEventTap);RunLoop.current.run(until:Date().addingTimeInterval(0.12))}
            }
        }
        guard attr(row,kAXSelectedAttribute) as? Bool==true else { fail("Folder row did not become selected") }
        guard let button=elements.first(where:{text($0,kAXRoleAttribute)==kAXButtonRole && ["Open","Choose","打开","选择"].contains(text($0))}) else {fail("Native folder confirmation absent")}
        print("Selected actual folder row; confirm output/folder");press(button)
    } else if action=="save" {
        let resultURL=work.appendingPathComponent("result.json")
        guard let data=try? Data(contentsOf:resultURL),let result=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
              result["bundleIdentifier"] as? String==bundle,result["pid"] as? Int==Int(pid),
              let records=result["sheets"] as? [[String:Any]],let last=records.last,
              last["kind"] as? String=="save",last["directory"] as? String==work.appendingPathComponent("output").path
        else { fail("QA app did not observe a save panel in its fixed output directory") }
        let allowed=["styled.html","plain.html","image.png","custom.pdf","custom.docx","custom.odt","custom.epub","custom.txt","failure-target.txt","repeat.pdf","repeat-2.pdf"]
        guard args.count==5,allowed.contains(args[4]) else { fail("Only fixed QA filenames are allowed") }
        guard let field=elements.first(where:{ text($0,kAXRoleAttribute)==kAXTextFieldRole && (text($0,kAXIdentifierAttribute)=="saveAsNameTextField" || text($0,kAXDescriptionAttribute).lowercased().contains("save as")) }) else { fail("Save As name field absent; inspect first") }
        let value=args[4] as CFString
        guard AXUIElementSetAttributeValue(field,kAXValueAttribute as CFString,value) == .success else { fail("Save As field is not writable") }
        guard let button=elements.first(where:{ text($0,kAXRoleAttribute)==kAXButtonRole && ["Save","保存"].contains(text($0)) }) else { fail("Save control absent") }
        print("Save fixed QA filename " + args[4]);press(button)
    } else {
        if action=="discard" {
            guard let data=try? Data(contentsOf:work.appendingPathComponent("result.json")),let result=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
                  result["bundleIdentifier"] as? String==bundle,result["pid"] as? Int==Int(pid),result["status"] as? String=="restarting",
                  ["source-a.md","source-b.md"].contains(text(panel))
            else { fail("Discard is restricted to the QA fixture documents during restart") }
        }
        if action=="replace" {
            guard (try? String(contentsOf:work.appendingPathComponent("output/failure-target.txt"),encoding:.utf8))=="KEEP_OLD_TARGET\n",
                  elements.contains(where:{ text($0,kAXValueAttribute).contains("failure-target.txt") || text($0).contains("failure-target.txt") })
            else { fail("Replace is restricted to the observed existing failure-target fixture") }
        }
        let labels=action=="cancel" ? ["Cancel","取消"] : alertLabels
        guard let button=elements.first(where:{ text($0,kAXRoleAttribute)==kAXButtonRole && labels.contains(text($0)) }) else { fail("Expected panel action absent") }
        print("Press " + text(button));press(button)
    }
} else { fail("Unsupported action") }
