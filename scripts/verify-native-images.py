"""Verify real native image writes using explicit bytes/paths, never the system clipboard."""
import json
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
work = root / '.cache/native-images'
work.mkdir(parents=True, exist_ok=True)
(work / 'App.swift').write_text((root / 'native/App.swift').read_text().split('@main\nstruct TyporaReplicaApplication')[0])
(work / 'main.swift').write_text(r'''
import AppKit
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let bytes = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=")!
let original = folder.appendingPathComponent("source image.png")
try! bytes.write(to: original)
let document = MarkdownDocument()
document.fileURL = folder.appendingPathComponent("document.md")
try! "# Image test".write(to: document.fileURL!, atomically: true, encoding: .utf8)
let configured = "---\ntypora-copy-images-to: ./images\n---\n# Images"
let cases: [(String, String, [String: Any], String?)] = [
 ("raw", configured, ["data": bytes.base64EncodedString(), "name": "sample name.png"], "images/sample name.png"),
 ("duplicate", configured, ["data": bytes.base64EncodedString(), "name": "sample name.png"], "images/sample name-1.png"),
 ("copy", configured, ["path": original.path], "images/source image.png"),
 ("reference", "# Images", ["path": original.path], "source image.png"),
 ("filename", configured, ["data": bytes.base64EncodedString(), "name": "../../sneaky.png"], "images/sneaky.png"),
 ("unknown-config", "---\ntypora-copy-images-to: ${unknown}\n---", ["data": bytes.base64EncodedString(), "name": "must-not-save.png"], nil)
]
var stage = 0
var results: [[String: Any]] = []
func finish(_ error: String? = nil) -> Never {
    let result: [String: Any] = ["ok": error == nil && results.count == cases.count && results.allSatisfy { $0["passed"] as? Bool == true }, "results": results, "error": error ?? "", "systemClipboardUsed": false, "saveDialogTested": false]
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
    exit(result["ok"] as? Bool == true ? 0 : 1)
}
func submit() {
    guard stage < cases.count else { finish() }
    let item = cases[stage]
    document.markdown = item.1
    var body = item.2
    body["requestId"] = item.0
    body["mime"] = "image/png"
    body["source"] = "drop"
    body["lookupFileURLs"] = false
    document.handleClipboardImage(body)
}
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    guard let index = document.pending.firstIndex(where: { $0.0 == "clipboardResult" }) else { return }
    let payload = document.pending.remove(at: index).1 as? [String: Any] ?? [:]
    let item = cases[stage]
    let path = payload["path"] as? String
    let actualURL = path.map { $0.hasPrefix("/") ? URL(fileURLWithPath: $0) : folder.appendingPathComponent($0) }
    let matchesBytes = actualURL.flatMap { try? Data(contentsOf: $0) } == bytes
    let passed: Bool
    if let expected = item.3 { passed = path == expected && matchesBytes && payload["error"] == nil }
    else { passed = payload["error"] != nil && path == nil && !FileManager.default.fileExists(atPath: folder.appendingPathComponent("images/must-not-save.png").path) }
    results.append(["name": item.0, "passed": passed, "path": path ?? "", "bytesMatch": matchesBytes])
    stage += 1
    submit()
}
Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { _ in finish("Native image test timed out") }
submit()
application.run()
''')
sources = [str(work / 'App.swift'), str(work / 'main.swift')]
sources += [str(p) for p in (root / 'native').glob('*.swift') if p.name != 'App.swift']
subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(root / '.cache/swift'), *sources, '-o', str(work / 'verify'), '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers'], check=True, cwd=root)
with tempfile.TemporaryDirectory(prefix='typora-images-') as directory:
    run = subprocess.run([str(work / 'verify'), directory], capture_output=True, text=True, timeout=25, cwd=root)
    try:
        result = json.loads(run.stdout)
    except ValueError:
        result = {'ok': False, 'error': (run.stderr or run.stdout)[-1500:]}
(root / 'evidence/native-images-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
raise SystemExit(0 if result.get('ok') else 1)
