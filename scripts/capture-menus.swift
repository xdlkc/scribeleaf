import AppKit
import ApplicationServices

// AX inventory for one explicitly selected application. Optional actions open
// Settings or the replica's HTML export save panel; neither changes files.
func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}
func capture(_ element: AXUIElement, depth: Int = 0) -> [String: Any] {
    var node: [String: Any] = [:]
    for (label, key) in [
        ("role", kAXRoleAttribute), ("title", kAXTitleAttribute),
        ("enabled", kAXEnabledAttribute), ("key", kAXMenuItemCmdCharAttribute),
        ("modifiers", kAXMenuItemCmdModifiersAttribute),
        ("virtualKey", kAXMenuItemCmdVirtualKeyAttribute),
        ("mark", kAXMenuItemMarkCharAttribute)
    ] {
        if let value = attribute(element, key) { node[label] = value }
    }
    if depth < 12, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        let title = node["title"] as? String ?? ""
        let role = node["role"] as? String ?? ""
        if title == "打开最近文件" || title == "Open Recent" || title == "服务" || title == "Services" {
            node["dynamicChildrenOmitted"] = true
        } else {
            let scoped = children.filter { child in
                let name = attribute(child, kAXTitleAttribute) as? String ?? ""
                if depth == 0 && name == "Apple" { return false }
                // Window document titles and recent files are user data, not product controls.
                if role == "AXMenu", title == "窗口" || title == "Window" {
                    return !name.lowercased().hasSuffix(".md") && !name.lowercased().hasSuffix(".txt")
                }
                return true
            }
            node["children"] = scoped.prefix(300).map { capture($0, depth: depth + 1) }
        }
    }
    return node
}
guard [3, 4].contains(CommandLine.arguments.count) else {
    fputs("usage: capture-menus <bundle-id> <output.json> [--open-settings|--export-html]\n", stderr); exit(2)
}
let bundleID = CommandLine.arguments[1]
guard AXIsProcessTrusted(), let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first,
      let menu = attribute(AXUIElementCreateApplication(app.processIdentifier), kAXMenuBarAttribute) else {
    fputs("Selected app or Accessibility menu is unavailable\n", stderr); exit(1)
}
let result: [String: Any] = ["bundleID": bundleID, "pid": app.processIdentifier,
    "executable": app.executableURL?.path ?? "", "capturedAt": ISO8601DateFormatter().string(from: Date()),
    "menu": capture(menu as! AXUIElement)]
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
print("Captured menus for \(bundleID)")
if CommandLine.arguments.count == 4 {
    func findItem(_ element: AXUIElement, titles: [String], depth: Int = 0) -> AXUIElement? {
        let title = attribute(element, kAXTitleAttribute) as? String ?? ""
        if titles.contains(title) { return element }
        guard depth < 5, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
        return children.lazy.compactMap { findItem($0, titles: titles, depth: depth + 1) }.first
    }
    // Only traverse the selected application's own menu, excluding Apple.
    let top = attribute(menu as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement] ?? []
    let target: AXUIElement?
    switch CommandLine.arguments[3] {
    case "--open-settings":
        target = top.first(where: { (attribute($0, kAXTitleAttribute) as? String ?? "") != "Apple" })
            .flatMap { findItem($0, titles: ["设置…", "偏好设置…", "Settings…", "Preferences…"]) }
    case "--export-html" where bundleID == "local.typora-replica.editor":
        target = top.first(where: { ["文件", "File"].contains(attribute($0, kAXTitleAttribute) as? String ?? "") })
            .flatMap { findItem($0, titles: ["导出", "Export"]) }
            .flatMap { findItem($0, titles: ["HTML"]) }
    default: exit(2)
    }
    guard let target, AXUIElementPerformAction(target, kAXPressAction as CFString) == .success else {
        fputs("Selected menu item is unavailable\n", stderr); exit(1)
    }
    print("Requested selected panel; inspect the resulting window")
}
