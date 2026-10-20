import AppKit
import ApplicationServices

func attribute(_ node: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(node, key as CFString, &value) == .success ? value : nil
}
func buttons(_ node: AXUIElement, depth: Int = 0) -> [(String, AXUIElement)] {
    guard depth < 12 else { return [] }
    let title = (attribute(node, kAXTitleAttribute) as? String).flatMap { $0.isEmpty ? nil : $0 } ?? attribute(node, kAXDescriptionAttribute) as? String ?? ""
    var output: [(String, AXUIElement)] = []
    if attribute(node, kAXRoleAttribute) as? String == kAXButtonRole { output.append((title, node)) }
    for child in (attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(200) { output += buttons(child, depth: depth + 1) }
    return output
}
func fail(_ text: String) -> Never { print("{\"ok\":false,\"error\":\"\(text)\"}"); exit(1) }
guard CommandLine.arguments.count == 3, let pid = Int32(CommandLine.arguments[1]) else { fail("Invalid owned process arguments") }
let expectedExecutable = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL.resolvingSymlinksInPath()
var registered: NSRunningApplication?
for _ in 0..<30 {
    registered = NSRunningApplication(processIdentifier: pid)
    if registered?.executableURL != nil { break }
    Thread.sleep(forTimeInterval: 0.1)
}
guard let running = registered,
      running.executableURL?.standardizedFileURL.resolvingSymlinksInPath() == expectedExecutable else { fail("Owned process identity did not match") }
guard AXIsProcessTrusted() else { fail("Accessibility permission unavailable") }
let app = AXUIElementCreateApplication(pid)
var selected: AXUIElement?
for _ in 0..<100 {
    selected = (attribute(app, kAXWindowsAttribute) as? [AXUIElement])?.first
    if selected != nil { break }
    Thread.sleep(forTimeInterval: 0.1)
}
guard let window = selected else { fail("Document window unavailable") }
Thread.sleep(forTimeInterval: 2)
guard let closeValue = attribute(window, kAXCloseButtonAttribute), CFGetTypeID(closeValue) == AXUIElementGetTypeID() else { fail("Close button unavailable") }
let close = closeValue as! AXUIElement
guard AXUIElementPerformAction(close, kAXPressAction as CFString) == .success else { fail("Close action failed") }
for _ in 0..<80 {
    let sheets = (attribute(window, "AXSheets") as? [AXUIElement] ?? []) + (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? [])
    for sheet in sheets {
        let found = buttons(sheet)
        if let cancel = found.first(where: { ["Cancel", "取消"].contains($0.0) }) {
            guard AXUIElementPerformAction(cancel.1, kAXPressAction as CFString) == .success else { fail("Cancel action failed") }
            Thread.sleep(forTimeInterval: 0.3)
            let live = (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).contains { CFEqual($0, window) }
            let data = try! JSONSerialization.data(withJSONObject: ["ok": live, "unsavedReview": true, "cancelKeepsDocumentOpen": live, "buttons": found.map { $0.0 }], options: [.sortedKeys])
            FileHandle.standardOutput.write(data); exit(live ? 0 : 1)
        }
    }
    Thread.sleep(forTimeInterval: 0.1)
}
let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
let result: [String: Any] = ["ok": false, "error": "Unsaved review sheet with a Cancel button was not shown", "windowCount": windows.count, "buttons": windows.flatMap { buttons($0).map { $0.0 } }]
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result)); exit(1)
