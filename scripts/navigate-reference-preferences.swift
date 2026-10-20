// Navigate only observed read-only labels in the installed Typora Preferences.
// Build with swiftc and AppKit/ApplicationServices; no settings fields are edited.
import AppKit
import ApplicationServices
func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(1) }
func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? { var x: CFTypeRef?; return AXUIElementCopyAttributeValue(e,key as CFString,&x) == .success ? x : nil }
let label=CommandLine.arguments.count>1 ? CommandLine.arguments[1] : "导出"
guard ["导出","文件","PDF","HTML","HTML (without Styles)","Image","Word (.docx)","OpenOffice","Epub"].contains(label) else { fail("Unsupported navigation label") }
func find(_ e: AXUIElement, depth: Int = 0) -> AXUIElement? {
    guard depth < 12 else { return nil }
    let role=attr(e,kAXRoleAttribute) as? String ?? ""
    if role == kAXStaticTextRole {
        let labels=[kAXTitleAttribute,kAXValueAttribute,kAXDescriptionAttribute].compactMap { attr(e,$0) as? String }
        if labels.contains(label) { return e }
    }
    for child in attr(e,kAXChildrenAttribute) as? [AXUIElement] ?? [] { if let result=find(child,depth:depth+1) { return result } }
    return nil
}
guard AXIsProcessTrusted(),let app=NSRunningApplication.runningApplications(withBundleIdentifier:"abnerworks.Typora").first else { fail("Original app/AX unavailable") }
let root=AXUIElementCreateApplication(app.processIdentifier)
guard let window=(attr(root,kAXWindowsAttribute) as? [AXUIElement])?.first(where:{ ["偏好设置","Preferences"].contains(attr($0,kAXTitleAttribute) as? String ?? "") }),let target=find(window),let p=attr(target,kAXPositionAttribute),let s=attr(target,kAXSizeAttribute) else { fail("Selected preferences sidebar label unavailable") }
var point=CGPoint.zero,size=CGSize.zero
guard AXValueGetValue(p as! AXValue,.cgPoint,&point), AXValueGetValue(s as! AXValue,.cgSize,&size) else { fail("Selected label geometry is unavailable") }
let center=CGPoint(x:point.x+size.width/2,y:point.y+size.height/2)
print("Click observed original Preferences label at \(center), size \(size)")
app.activate(options:[])
let until=Date().addingTimeInterval(3)
while !app.isActive && Date()<until { RunLoop.current.run(until:Date().addingTimeInterval(0.05)) }
guard app.isActive else { fail("Original app could not be activated") }
for type in [CGEventType.mouseMoved,.leftMouseDown,.leftMouseUp] { if let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:center,mouseButton:.left) { event.setIntegerValueField(.mouseEventClickState,value:1);event.post(tap:.cghidEventTap);RunLoop.current.run(until:Date().addingTimeInterval(0.12)) } }
