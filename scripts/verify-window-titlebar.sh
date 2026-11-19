#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache/swift
work="$(mktemp -d "$PWD/.cache/titlebar-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT

sed '/^@main$/d' native/App.swift > "$work/App.swift"
cat > "$work/main.swift" <<'SWIFT'
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let document = MarkdownDocument()
document.makeWindowControllers()
let window = document.windowControllers[0].window!
let web = document.web!
let frameView = web.superview!
var passed = true

func check(_ description: String, _ result: Bool) {
    print("\(result ? "PASS" : "FAIL"): \(description)")
    passed = result && passed
}

let top = web.convert(web.bounds, to: nil).maxY
let width = web.bounds.width
let dragHeight = min(28, top - window.contentLayoutRect.maxY)
precondition(dragHeight > 2, "Expected a native title bar above the document content")
for offset in [dragHeight / 2, dragHeight - 2] {
    let hit = frameView.hitTest(NSPoint(x: width * 0.75, y: top - offset))
    check("draggable AppKit view receives the title bar hit at \(offset) pt below the top",
          window.isMovableByWindowBackground && hit?.mouseDownCanMoveWindow == true && hit?.isDescendant(of: web) == false)
}
let editorPoint = NSPoint(x: width * 0.75, y: top - 120)
let sidebarPoint = NSPoint(x: 100, y: top - 29)
check("editor receives mouse events", frameView.hitTest(editorPoint)?.isDescendant(of: web) == true)
check("WebKit receives mouse events at the top of the sidebar tabs", frameView.hitTest(sidebarPoint)?.isDescendant(of: web) == true)

for type: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
    guard let button = window.standardWindowButton(type) else {
        check("native window button \(type) exists", false)
        continue
    }
    let center = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
    check("native window button \(type) receives mouse events", frameView.hitTest(center)?.isDescendant(of: button) == true)
}
exit(passed ? 0 : 1)
SWIFT

sources=()
for source in native/*.swift; do
  [[ "$source" == native/App.swift ]] || sources+=("$source")
done
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/.cache/swift" \
  "$work/App.swift" "$work/main.swift" "${sources[@]}" -o "$work/verify"
"$work/verify"
