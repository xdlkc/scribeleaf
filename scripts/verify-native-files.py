"""Exercise actual native folder events and recovery in temporary storage only."""
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / 'evidence/native-files-verification.json'

SWIFT_MAIN = r'''
import AppKit
import Foundation

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let base = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let fm = FileManager.default
let tree = base.appendingPathComponent("tree", isDirectory: true)
let source = base.appendingPathComponent("source.md")
try! fm.createDirectory(at: tree, withIntermediateDirectories: true)
try! "# Original source".write(to: source, atomically: true, encoding: .utf8)
func mkdir(_ path: String) { try! fm.createDirectory(at: tree.appendingPathComponent(path), withIntermediateDirectories: true) }
func write(_ path: String, _ text: String = "# File") { try! text.write(to: tree.appendingPathComponent(path), atomically: true, encoding: .utf8) }
func remove(_ path: String) { try! fm.removeItem(at: tree.appendingPathComponent(path)) }
func rename(_ old: String, _ new: String) { try! fm.moveItem(at: tree.appendingPathComponent(old), to: tree.appendingPathComponent(new)) }
mkdir("nested/deeper"); mkdir("empty"); mkdir("assets")
write("root.md"); write("nested/deeper/child.markdown"); write("assets/photo.png", "resource")
for index in 0..<5105 { write("nested/file-\(index).md") }
let doc = MarkdownDocument()
doc.markdown = "# Unsaved edit\nA stable selection belongs to renderer."
doc.lastSavedMarkdown = "# Previous"
doc.resourceOriginURL = source
doc.folder = tree
doc.updateChangeCount(.changeDone)
var checks: [[String: Any]] = []
var monitorBackend = "not-started"
func check(_ name: String, _ ok: Bool, _ detail: String = "") {
    checks.append(["name": name, "ok": ok, "detail": detail])
    if !ok { finish("Failed: \(name)") }
}
func spin(_ duration: Double) {
    let end = Date().addingTimeInterval(duration)
    while Date() < end { RunLoop.main.run(until: min(Date().addingTimeInterval(0.03), end)) }
}
func until(_ predicate: () -> Bool, timeout: Double = 12) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end { if predicate() { return true }; spin(0.03) }
    return predicate()
}
func payloads(_ document: MarkdownDocument = doc) -> [[String: Any]] {
    document.pending.filter { $0.0 == "files" }.compactMap { $0.1 as? [String: Any] }
}
func paths(_ key: String, document: MarkdownDocument = doc) -> Set<String> {
    Set((payloads(document).last?[key] as? [[String: String]] ?? []).compactMap { $0["relativePath"] })
}
func finish(_ error: String? = nil) -> Never {
    let result: [String: Any] = ["ok": error == nil && checks.allSatisfy { $0["ok"] as? Bool == true }, "checks": checks, "error": error ?? "", "testStorage": "temporary directory", "recoveryStorageRedirectedInTestCopy": true, "productionSerializationAndDocumentLifecycleUsed": true, "realFilesystemEvents": true, "observationBackend": monitorBackend, "uiFocusTested": false]
    if let suite = ProcessInfo.processInfo.environment["TYPORA_REPLICA_DEFAULTS_SUITE"] { AppPreferencesStore.defaults.removePersistentDomain(forName: suite) }
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
    exit(error == nil ? 0 : 1)
}
let originalText = doc.markdown
var heartbeatCount = 0
var maximumHeartbeatGap = 0.0
var previousHeartbeat = Date()
let heartbeat = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { _ in
    let now = Date()
    maximumHeartbeatGap = max(maximumHeartbeatGap, now.timeIntervalSince(previousHeartbeat))
    previousHeartbeat = now
    heartbeatCount += 1
}
doc.listFiles(tree)
check("initial snapshot arrives", until { payloads().count > 0 })
check("main loop remains responsive during initial enumeration", heartbeatCount >= 5 && maximumHeartbeatGap < 0.5, "ticks=\(heartbeatCount), largestGap=\(maximumHeartbeatGap)")
check("all 5107 Markdown files retained", paths("files").count == 5107, "count=\(paths("files").count)")
check("empty and resource-only directories included", paths("directories").isSuperset(of: ["empty", "assets", "nested", "nested/deeper"]), paths("directories").sorted().joined(separator: ","))
let initial = payloads().last!
let files = initial["files"] as! [[String: String]]
check("existing file schema preserved", files.allSatisfy { Set($0.keys) == Set(["name", "path", "relativePath"]) && $0["path"]!.hasPrefix(tree.path + "/") })
write("added.md")
check("root add", until { paths("files").contains("added.md") })
rename("added.md", "renamed.mdx")
check("root rename", until { paths("files").contains("renamed.mdx") && !paths("files").contains("added.md") })
remove("renamed.mdx")
check("root delete", until { !paths("files").contains("renamed.mdx") })
write("nested/deeper/added.qmd")
check("nested add", until { paths("files").contains("nested/deeper/added.qmd") })
rename("nested/deeper/added.qmd", "nested/deeper/renamed.RMD")
check("nested rename including uppercase supported extension", until { paths("files").contains("nested/deeper/renamed.RMD") && !paths("files").contains("nested/deeper/added.qmd") })
remove("nested/deeper/renamed.RMD")
check("nested delete", until { !paths("files").contains("nested/deeper/renamed.RMD") })
mkdir("new/sub/empty"); write("new/sub/document.md")
check("new nested directory and file", until { paths("files").contains("new/sub/document.md") && paths("directories").contains("new/sub/empty") })
rename("new", "moved")
check("directory rename updates descendants", until { paths("files").contains("moved/sub/document.md") && paths("directories").contains("moved/sub/empty") && !paths("directories").contains("new") })
write("moved/sub/later.mmd")
check("new directory remains monitored", until { paths("files").contains("moved/sub/later.mmd") })
remove("moved")
check("directory removal updates descendants", until { !paths("directories").contains("moved") && !paths("files").contains("moved/sub/document.md") })
spin(1.1)
let stableCount = payloads().count
write("root.md", "# Changed only file contents")
write("assets/photo.png", "resource changed")
spin(1.5)
check("unchanged membership emits no repeated full payload", payloads().count == stableCount, "before=\(stableCount), after=\(payloads().count)")
let beforeBurst = payloads().count
for index in 0..<25 { write("burst-\(index).md") }
check("burst reaches complete snapshot", until { paths("files").filter { $0.hasPrefix("burst-") }.count == 25 })
spin(0.8)
check("burst events coalesced", payloads().count - beforeBurst <= 4, "deliveries=\(payloads().count - beforeBurst)")
check("folder refresh preserves unsaved edits and true file identity", doc.markdown == originalText && doc.isDocumentEdited && doc.fileURL == nil && doc.resourceOriginURL == source)
check("folder refresh never sends document load", !doc.pending.contains { $0.0 == "load" })

// Persist via the production Recovery.write function. Only its folder getter in
// this compiled test copy is redirected; no user recovery directory is touched.
doc.persistRecovery()
let recoveryURL = Recovery.url(doc.recoveryID)
let recoveryData = try! Data(contentsOf: recoveryURL)
let recovery = try! JSONSerialization.jsonObject(with: recoveryData) as! [String: Any]
check("recovery records unsaved copy without source file identity", recovery["path"] == nil && recovery["markdown"] as? String == originalText)
check("recovery retains origin and selected folder", recovery["resourceOriginPath"] as? String == source.path && recovery["folderPath"] as? String == tree.path)
RECOVERY_SCHEMA_TESTS

// Switching root invalidates delivery from the previous tree.
let second = base.appendingPathComponent("second", isDirectory: true)
try! fm.createDirectory(at: second, withIntermediateDirectories: true)
try! "# Other".write(to: second.appendingPathComponent("other.md"), atomically: true, encoding: .utf8)
doc.folder = second
doc.listFiles(second)
check("switch folder delivers its own initial snapshot", until { payloads().last?["root"] as? String == second.path && paths("files") == ["other.md"] })
let savedFolderRecord = RecoveryRecord(data: try! Data(contentsOf: recoveryURL))!
check("folder switch persists the selected folder for edited document", savedFolderRecord.folderURL == second)
let beforeOldRoot = payloads().count
write("old-root-ignored.md")
spin(1.2)
check("old folder cannot deliver after switch", payloads().count == beforeOldRoot && payloads().last?["root"] as? String == second.path)
try! "# Pending".write(to: second.appendingPathComponent("close-pending.md"), atomically: true, encoding: .utf8)
doc.close()
let afterClose = doc.pending.count
try! "# After close".write(to: second.appendingPathComponent("after-close.md"), atomically: true, encoding: .utf8)
spin(1.6)
check("document close cancels pending and future folder deliveries", doc.pending.count == afterClose)
check("close removes only isolated recovery", !fm.fileExists(atPath: recoveryURL.path))
check("source document never overwritten", (try? String(contentsOf: source)) == "# Original source")
var stoppedDeliveries = 0
let stoppedMonitor = FolderMonitor(root: second, extensions: markdownExtensions) { _ in stoppedDeliveries += 1 }
stoppedMonitor.start()
Thread.sleep(forTimeInterval: 0.8) // Let the background scan queue a main delivery.
monitorBackend = stoppedMonitor.observationBackend
stoppedMonitor.stop()
spin(0.8)
check("stop invalidates an already queued main delivery", stoppedDeliveries == 0)
heartbeat.invalidate()
finish()
'''


def run():
    started = time.time()
    with tempfile.TemporaryDirectory(prefix='typora-native-files-') as temporary:
        work = Path(temporary)
        source = (ROOT / 'native/App.swift').read_text().split('@main\nstruct TyporaReplicaApplication')[0]
        source, count = re.subn(r'static var folder: URL \{.*?\n    \}\n    static func url', 'static var folder: URL { URL(fileURLWithPath: ProcessInfo.processInfo.environment["TYPORA_QA_RECOVERY_DIRECTORY"]!, isDirectory: true) }\n    static func url', source, count=1, flags=re.S)
        assert count == 1, 'Recovery folder isolation patch must match exactly once'
        (work / 'App.swift').write_text(source)
        schema = schema_tests(source)
        (work / 'main.swift').write_text(SWIFT_MAIN.replace('RECOVERY_SCHEMA_TESTS', schema))
        executable = work / 'verify'
        sources = [str(work / 'App.swift'), str(work / 'main.swift')]
        sources += [str(p) for p in (ROOT / 'native').glob('*.swift') if p.name != 'App.swift']
        compiled = subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(ROOT / '.cache/swift'), *sources, '-o', str(executable), '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers'], cwd=ROOT, capture_output=True, text=True)
        if compiled.returncode:
            return {'ok': False, 'compileSucceeded': False, 'error': compiled.stderr[-6000:]}
        env = os.environ.copy()
        env['TYPORA_QA_RECOVERY_DIRECTORY'] = str(work / 'recovery')
        env['TYPORA_REPLICA_DEFAULTS_SUITE'] = 'local.typora-replica.native-files-qa.' + uuid.uuid4().hex
        proc = subprocess.run([str(executable), str(work)], cwd=ROOT, capture_output=True, text=True, timeout=180, env=env)
        try:
            result = json.loads(proc.stdout)
        except ValueError:
            result = {'ok': False, 'error': (proc.stderr or proc.stdout)[-6000:]}
        result['compileSucceeded'] = True
        result['elapsedSeconds'] = round(time.time() - started, 2)
        suite = env['TYPORA_REPLICA_DEFAULTS_SUITE']
        subprocess.run(['defaults', 'delete', suite], capture_output=True)
        preferences = Path.home() / 'Library/Preferences' / (suite + '.plist')
        if preferences.exists() and plistlib.loads(preferences.read_bytes()) == {}:
            preferences.unlink()
        result['isolatedDefaultsSuite'] = suite
        result['ownedDefaultsFileCleaned'] = not preferences.exists()
        return result


def schema_tests(source):
    assert 'func restoreRecovery(_ record: RecoveryRecord, id: String)' in source
    return r'''
let decoded = RecoveryRecord(data: recoveryData)!
check("new recovery decoder preserves independent origin and folder", decoded.fileURL == nil && decoded.resourceOriginURL == source && decoded.folderURL == tree)
let restored = MarkdownDocument()
restored.restoreRecovery(decoded, id: "isolated-restored")
check("production restore preserves unsaved identity and text", restored.fileURL == nil && restored.markdown == originalText && restored.lastSavedMarkdown == "" && restored.resourceOriginURL == source && restored.folder == tree)
let copyDestination = base.appendingPathComponent("saved-copy.md")
try! restored.write(to: copyDestination, ofType: MarkdownDocument.documentType)
check("restored copy saves to explicit new destination", (try? String(contentsOf: copyDestination)) == originalText && (try? String(contentsOf: source)) == "# Original source")
let legacyJSON: [String: Any] = ["markdown": "# Old unsaved", "name": "legacy", "path": source.path, "encoding": String.Encoding.utf16LittleEndian.rawValue, "bom": Data([0xff, 0xfe]).base64EncodedString()]
let legacy = RecoveryRecord(data: try! JSONSerialization.data(withJSONObject: legacyJSON))!
check("legacy recovery accepts saved path with no new keys", legacy.fileURL == source && legacy.resourceOriginURL == nil && legacy.folderURL == nil && legacy.encoding == .utf16LittleEndian && legacy.bom == Data([0xff, 0xfe]))
let legacyDoc = MarkdownDocument()
legacyDoc.restoreRecovery(legacy, id: "legacy-isolated")
check("legacy restoration still reads saved file baseline", legacyDoc.fileURL == source && legacyDoc.markdown == "# Old unsaved" && legacyDoc.lastSavedMarkdown == "# Original source" && legacyDoc.textEncoding == .utf8)
let minimal = RecoveryRecord(data: Data("{\"markdown\":\"old untitled\"}".utf8))!
check("legacy untitled defaults remain compatible", minimal.fileURL == nil && minimal.name == "Untitled" && minimal.encoding == .utf8 && minimal.bom.isEmpty)
let invalid = RecoveryRecord(data: Data("{\"markdown\":\"x\",\"path\":\"relative.md\",\"resourceOriginPath\":\"https://example.com/a.md\",\"folderPath\":\"../folder\"}".utf8))!
check("relative paths and URL strings cannot acquire native file identity", invalid.fileURL == nil && invalid.resourceOriginURL == nil && invalid.folderURL == nil)
check("invalid recovery data is rejected", RecoveryRecord(data: Data("{\"name\":\"missing markdown\"}".utf8)) == nil && RecoveryRecord(data: Data("invalid".utf8)) == nil)
let utf16 = RecoveryRecord(markdown: "# 中文副本", name: "副本", path: nil, resourceOriginPath: source.path, folderPath: tree.path, encoding: .utf16BigEndian, bom: Data([0xfe, 0xff]))
let roundtrip = RecoveryRecord(data: try! utf16.encoded())!
let encodedDoc = MarkdownDocument()
encodedDoc.restoreRecovery(roundtrip, id: "utf16-isolated")
let encodedBytes = try! encodedDoc.data(ofType: MarkdownDocument.documentType)
check("new recovery preserves UTF16 text and BOM", roundtrip.markdown == utf16.markdown && roundtrip.encoding == .utf16BigEndian && roundtrip.bom == utf16.bom && encodedBytes.starts(with: [0xfe, 0xff]) && (try? EncodedMarkdown.decode(encodedBytes).text) == utf16.markdown)
restored.close(); legacyDoc.close(); encodedDoc.close()
''' 


if __name__ == '__main__':
    try:
        result = run()
    except Exception as error:
        result = {'ok': False, 'error': str(error)}
    EVIDENCE.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result.get('ok') else 1)
