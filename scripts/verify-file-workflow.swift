import AppKit
import Foundation

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let controller = ReplicaDocumentController()
let base = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let pandoc = URL(fileURLWithPath: CommandLine.arguments[2])
let fm = FileManager.default
let suite = ProcessInfo.processInfo.environment["TYPORA_REPLICA_DEFAULTS_SUITE"]!
let defaults = AppPreferencesStore.defaults
var checks: [[String: Any]] = []
func check(_ name: String, _ ok: Bool, _ actual: Any? = nil) {
    var result: [String: Any] = ["name": name, "passed": ok]
    if let actual { result["actual"] = actual }
    checks.append(result)
    if !ok { FileHandle.standardError.write(Data(("FAILED_CHECK: " + String(describing: result) + "\n").utf8)) }
}
func spin(_ duration: Double) {
    let end = Date().addingTimeInterval(duration)
    while Date() < end { RunLoop.main.run(until: min(Date().addingTimeInterval(0.02), end)) }
}
func until(_ predicate: () -> Bool, timeout: Double = 12) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end { if predicate() { return true }; spin(0.02) }
    return predicate()
}
func prefs(_ values: [String: Any]) { AppPreferencesStore.saveEditorPrefs(values) }
func make(_ name: String, _ text: String) -> URL {
    let url = base.appendingPathComponent(name)
    try! fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try! Data(text.utf8).write(to: url)
    return url
}
func open(_ url: URL) -> MarkdownDocument? {
    var finished = false
    var document: MarkdownDocument?
    controller.openDocument(withContentsOf: url, display: false) { result, _, error in
        document = result as? MarkdownDocument; finished = true
        check("native-open-" + url.lastPathComponent, error == nil && document != nil, error?.localizedDescription)
    }
    check("native-open-completion-" + url.lastPathComponent, until { finished })
    return document
}
func files(_ document: MarkdownDocument) -> Set<String> {
    let snapshot = document.pending.last { $0.0 == "files" }?.1 as? [String: Any]
    return Set((snapshot?["files"] as? [[String: String]] ?? []).compactMap { $0["relativePath"] })
}
func save(_ document: MarkdownDocument, _ url: URL) -> Error? {
    var done = false; var failure: Error?
    document.save(to: url, ofType: MarkdownDocument.documentType, for: .saveOperation) { error in failure = error; done = true }
    check("native-save-completion-" + url.lastPathComponent, until { done })
    return failure
}
func switchTo(_ document: MarkdownDocument, _ url: URL, review: ((MarkdownDocument, @escaping (Bool) -> Void) -> Void)? = nil,
              confirms: Bool = true) -> (Bool, Error?) {
    var done = false; var accepted = false; var failure: Error?
    document.switchDocument(to: url, review: review, systemAlwaysConfirmsChanges: confirms, completion: { ok, error in accepted = ok; failure = error; done = true })
    check("switch-completion-" + url.lastPathComponent, until { done })
    return (accepted, failure)
}
func drop(_ document: MarkdownDocument, paths: [String], requestId: String, documentId: String? = nil,
          drag: (() -> [URL])? = nil, readDrag: Bool? = nil) -> [String: Any]? {
    var body: [String: Any] = ["requestId": requestId, "documentId": documentId ?? document.documentIdentityKey(),
        "rendererDocumentId": "renderer-" + requestId, "documentPath": document.fileURL?.path ?? "", "paths": paths, "useDraggingPasteboard": readDrag ?? (drag != nil)]
    if documentId != nil { body["documentId"] = documentId }
    document.handleFileDrop(body, draggingURLs: drag ?? { [] }, display: false, importMediaCacheURL: base.appendingPathComponent("import-media", isDirectory: true))
    _ = until({ document.pending.contains { $0.0 == "fileDropResult" && ($0.1 as? [String: Any])?["requestId"] as? String == requestId } }, timeout: documentId == nil ? 12 : 0.15)
    return document.pending.last { $0.0 == "fileDropResult" && ($0.1 as? [String: Any])?["requestId"] as? String == requestId }?.1 as? [String: Any]
}

if CommandLine.arguments.last == "write-session" {
    FileSessionStore().save(files: [base.appendingPathComponent("folder/target.md").path, base.appendingPathComponent("dropped.md").path], folders: [base.appendingPathComponent("folder").path])
    prefs(["restoreWhenLaunch": 2])
    defaults.synchronize()
    print("SESSION_WRITE_OK")
    exit(0)
}
if CommandLine.arguments.last == "read-session" {
    let launch = AppDelegate()
    var done = false
    launch.restoreSession(display: false, explicitOpenRequested: false, recoveredDocuments: false, systemClosesWindows: false) { done = true }
    let completed = until { done }
    let expected = Set([base.appendingPathComponent("folder/target.md").path, base.appendingPathComponent("dropped.md").path])
    let actual = Set(controller.documents.compactMap { $0.fileURL?.path })
    let ok = completed && actual == expected && controller.documents.count == 2
    print("SESSION_READ_JSON:" + String(data: try! JSONSerialization.data(withJSONObject: ["passed": ok, "files": actual.sorted(), "documentCount": controller.documents.count], options: [.sortedKeys]), encoding: .utf8)!)
    for document in controller.documents { document.close() }
    exit(ok ? 0 : 1)
}

try! fm.createDirectory(at: base, withIntermediateDirectories: true)
check("custom-controller-is-native-shared-controller", NSDocumentController.shared === controller)
prefs(["defaultExtension": "notes", "recordRecentFiles": false])
let source = make("source.notes", "# Original\n")
guard let custom = open(source) else {
    defaults.removePersistentDomain(forName: suite)
    print("FILE_WORKFLOW_JSON:" + String(data: try! JSONSerialization.data(withJSONObject: ["passed": false, "checks": checks], options: [.sortedKeys]), encoding: .utf8)!)
    exit(1)
}
check("custom-extension-real-document-read", custom.markdown == "# Original\n" && custom.fileURL == source)
check("native-auto-open-recording-disabled", controller.recentDocumentURLs.isEmpty && defaults.stringArray(forKey: ReplicaDocumentController.recentKey) == nil)
let unsaved = MarkdownDocument(); unsaved.fileType = MarkdownDocument.documentType
unsaved.markdown = "# Newly saved\n"; unsaved.updateChangeCount(.changeDone)
let savePanel = NSSavePanel(); savePanel.nameFieldStringValue = "Untitled.md"
check("actual-save-panel-default-extension", unsaved.prepareSavePanel(savePanel) && savePanel.nameFieldStringValue == "Untitled.notes", savePanel.nameFieldStringValue)
check("native-document-extension-policy", unsaved.fileNameExtension(forType: MarkdownDocument.documentType, saveOperation: .saveOperation) == "notes")
let openPanel = NSOpenPanel(); controller.configureOpenPanel(openPanel)
check("native-open-panel-allows-custom-extension", openPanel.allowsOtherFileTypes && openPanel.allowedContentTypes.contains { $0.preferredFilenameExtension == "notes" })
let saved = base.appendingPathComponent("saved.notes")
check("custom-extension-real-save", save(unsaved, saved) == nil && unsaved.fileURL == saved && (try? String(contentsOf: saved)) == "# Newly saved\n")
check("native-auto-save-recording-disabled", defaults.stringArray(forKey: ReplicaDocumentController.recentKey) == nil)
custom.close(); unsaved.close()
prefs(["defaultExtension": "note.book", "recordRecentFiles": false])
let compound = make("compound.note.book", "# Compound extension")
let compoundDoc = open(compound)
check("native-controller-opens-configured-complete-multi-dot-extension", compoundDoc?.markdown == "# Compound extension" && compoundDoc?.fileURL == compound)
check("multi-dot-extension-does-not-rewrite-proven-sidebar-last-suffix-rule", !FilePreferences(values: ["defaultExtension": "note.book"]).isSupportedFile(named: "compound.note.book"))
compoundDoc?.close()
let invalidCompound = base.appendingPathComponent("invalid.note.book")
try! Data([0xff, 0x00]).write(to: invalidCompound)
var invalidFinished = false; var invalidRejected = false
controller.openDocument(withContentsOf: invalidCompound, display: false) { document, _, error in invalidRejected = document == nil && error != nil; invalidFinished = true }
check("custom-extension-still-validates-real-text-bytes", until { invalidFinished } && invalidRejected)

prefs(["defaultExtension": "notes", "recordRecentFiles": true])
let doc = open(source)!
check("native-auto-open-recorded", controller.recentDocumentURLs.first == source)
doc.markdown = "# Saved update\n"; doc.updateChangeCount(.changeDone)
check("native-save-recorded", save(doc, source) == nil && controller.recentDocumentURLs.first == source)
prefs(["recordRecentFiles": false]); controller.noteNewRecentDocumentURL(saved)
check("disabled-recents-hidden-without-erasing-prior-list", controller.recentDocumentURLs.isEmpty && defaults.stringArray(forKey: ReplicaDocumentController.recentKey)?.first == source.path)
prefs(["recordRecentFiles": true]); FileSessionStore().save(files: [source.path], folders: [base.path]); FileRecentLocations.clear()
check("clear-recent-native-entrypoint", controller.recentDocumentURLs.isEmpty)
check("clear-recent-also-clears-renderer-list", doc.pending.contains { $0.0 == "clearRecent" })
check("clear-recent-keeps-launch-session-independent", FileSessionStore().state.files == [source.path] && FileSessionStore().state.folders == [base.path])

let root = base.appendingPathComponent("folder", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
let target = root.appendingPathComponent("target.md")
let utf16Text = "# 中文\r\n"
try! (Data([0xff, 0xfe]) + utf16Text.data(using: .utf16LittleEndian)!).write(to: target)
_ = make("folder/table.csv", "a,b")
_ = make("folder/.private.md", "# Hidden")
doc.folder = root; doc.listFiles(root)
check("live-app-monitor-initial", until { files(doc).contains("target.md") && !files(doc).contains("table.csv") })
prefs(["treeFileFilterMode": "all", "showHiddenFiles": true])
check("editor-preference-notification-rescans-native-folder", until { files(doc).contains("table.csv") && files(doc).contains(".private.md") })

prefs(["saveOnFileSwitch": true, "recordRecentFiles": true])
doc.markdown = "# Autosave before switch\n"; doc.updateChangeCount(.changeDone); doc.persistRecovery()
_ = doc.repeatHistory.record(format: "pdf", destinationPath: base.appendingPathComponent("previous.pdf").path, identity: doc.documentIdentityKey(), frozenSettings: ["key": "pdf", "options": ["title": "frozen"]])
let switched = switchTo(doc, target)
check("saved-sidebar-switch-autosaves-real-old-source", switched.0 && switched.1 == nil && (try? String(contentsOf: source)) == "# Autosave before switch\n")
check("same-document-switch-retains-root-and-bom", doc.fileURL == target && doc.folder == root && doc.markdown == utf16Text && doc.textEncoding == .utf16LittleEndian && doc.byteOrderMark == Data([0xff, 0xfe]))
check("native-controller-association-follows-same-document-switch", controller.document(for: target) === doc && controller.document(for: source) == nil)
check("switch-clears-recovery-and-edit-state", !doc.isDocumentEdited && !fm.fileExists(atPath: Recovery.url(doc.recoveryID).path))
check("switch-preserves-repeat-format-without-overwrite", doc.repeatHistory.canExportPrevious && !doc.repeatHistory.canOverwrite && doc.repeatHistory.frozenSettings["key"] as? String == "pdf")
let load = doc.pending.last { $0.0 == "load" }?.1 as? [String: Any]
check("load-includes-native-document-identity", load?["documentId"] as? String == doc.documentIdentityKey())
doc.markdown += "saved UTF16\r\n"; doc.updateChangeCount(.changeDone)
check("switched-document-save-keeps-encoding-bom", save(doc, target) == nil && (try? Data(contentsOf: target))?.starts(with: [0xff, 0xfe]) == true)
let savedPayload = doc.pending.last { $0.0 == "saved" }?.1 as? [String: Any]
check("saved-includes-native-document-identity", savedPayload?["documentId"] as? String == doc.documentIdentityKey())

prefs(["saveOnFileSwitch": false])
doc.markdown = "unsaved stays after Cancel"; doc.updateChangeCount(.changeDone); doc.persistRecovery()
let beforeCancel = try! Data(contentsOf: target)
var reviewed = false
let cancelled = switchTo(doc, source, review: { _, reply in reviewed = true; reply(false) })
check("sidebar-cancel-preserves-current-document", reviewed && !cancelled.0 && doc.fileURL == target && doc.markdown == "unsaved stays after Cancel" && doc.isDocumentEdited)
check("sidebar-cancel-preserves-recovery-and-disk", fm.fileExists(atPath: Recovery.url(doc.recoveryID).path) && (try? Data(contentsOf: target)) == beforeCancel)
let discarded = switchTo(doc, source, review: { _, reply in reply(true) })
check("sidebar-discard-switch-does-not-write-old-source", discarded.0 && doc.fileURL == source && (try? Data(contentsOf: target)) == beforeCancel && !doc.isDocumentEdited)

let newUnsaved = MarkdownDocument(); newUnsaved.fileType = MarkdownDocument.documentType
newUnsaved.markdown = "retain unsaved before switch"; newUnsaved.updateChangeCount(.changeDone)
let approvedSave = base.appendingPathComponent("approved.notes")
let savedThenSwitch = switchTo(newUnsaved, target, review: { document, reply in
    document.save(to: approvedSave, ofType: MarkdownDocument.documentType, for: .saveOperation) { error in reply(error == nil) }
})
check("unsaved-save-then-switch-retains-saved-document", savedThenSwitch.0 && (try? String(contentsOf: approvedSave)) == "retain unsaved before switch" && newUnsaved.fileURL == target)
newUnsaved.close()
let failureDoc = MarkdownDocument(); failureDoc.fileType = MarkdownDocument.documentType
let blocker = make("blocker", "not a directory")
failureDoc.fileURL = blocker.appendingPathComponent("source.md"); failureDoc.markdown = "must survive failed save"; failureDoc.lastSavedMarkdown = "old"; failureDoc.updateChangeCount(.changeDone)
prefs(["saveOnFileSwitch": true])
let failed = switchTo(failureDoc, target)
check("failed-auto-save-keeps-current-document", !failed.0 && failed.1 != nil && failureDoc.markdown == "must survive failed save" && failureDoc.isDocumentEdited && failureDoc.fileURL == blocker.appendingPathComponent("source.md"))
failureDoc.close()
let stale = MarkdownDocument(); stale.fileType = MarkdownDocument.documentType; stale.markdown = "dirty"; stale.updateChangeCount(.changeDone)
var later: ((Bool) -> Void)?; var staleResult: Bool?
prefs(["saveOnFileSwitch": false])
stale.switchDocument(to: target, review: { _, reply in later = reply }, completion: { result, _ in staleResult = result })
stale.fileURL = source; later?(true)
check("identity-change-cancels-pending-sidebar-switch", staleResult == false && stale.fileURL == source && stale.markdown == "dirty")
stale.close()

prefs(["saveOnFileSwitch": false])
doc.markdown = "system override autosaved"; doc.updateChangeCount(.changeDone)
check("system-save-override-consumed-by-real-switch", switchTo(doc, target, confirms: false).0 && (try? String(contentsOf: source)) == "system override autosaved")
let policyDefaults = UserDefaults(suiteName: suite + ".system-policy")!
check("absent-system-key-does-not-authorize-auto-save", FileRuntimeSystemPolicy.alwaysConfirmsChanges(defaults: policyDefaults))
policyDefaults.set(false, forKey: "NSCloseAlwaysConfirmsChanges")
check("system-forced-checkbox-policy", !FileRuntimeSystemPolicy.alwaysConfirmsChanges(defaults: policyDefaults))
policyDefaults.removePersistentDomain(forName: suite + ".system-policy")

let linkFolder = base.appendingPathComponent("link folder", isDirectory: true)
try! fm.createDirectory(at: linkFolder, withIntermediateDirectories: true)
let droppedMarkdown = make("dropped.md", "# Drop document")
let droppedImage = make("skip.png", "image pipeline owns this")
let imageNamedFolder = base.appendingPathComponent("diagram.png", isDirectory: true)
try! fm.createDirectory(at: imageNamedFolder, withIntermediateDirectories: true)
prefs(["folderDropAction": "link", "markdownDropAction": "link", "importDropAction": "link"])
let linked = drop(doc, paths: [linkFolder.path, droppedMarkdown.path, imageNamedFolder.path, droppedImage.path], requestId: "links")
let links = linked?["links"] as? [[String: Any]] ?? []
check("native-drop-links-separate-images", links.count == 3 && links[0]["isDirectory"] as? Bool == true && links[1]["name"] as? String == "dropped.md")
check("native-drop-folder-image-suffix-is-still-directory", links.count == 3 && links[2]["name"] as? String == "diagram.png" && links[2]["isDirectory"] as? Bool == true)
check("native-drop-echoes-both-identities", linked?["documentId"] as? String == doc.documentIdentityKey() && linked?["rendererDocumentId"] as? String == "renderer-links")
var draggingRead = false
let dragged = drop(doc, paths: [], requestId: "drag-board", drag: { draggingRead = true; return [droppedMarkdown] })
check("native-drop-uses-only-supplied-drag-reader-when-no-path", draggingRead && (dragged?["links"] as? [[String: Any]])?.count == 1)
draggingRead = false
_ = drop(doc, paths: [droppedMarkdown.path], requestId: "explicit-path", drag: { draggingRead = true; return [] }, readDrag: false)
check("native-drop-does-not-read-board-with-explicit-path", !draggingRead)
let partial = drop(doc, paths: [droppedMarkdown.path], requestId: "partial-drag-path", drag: { [droppedMarkdown, linkFolder] })
check("native-drop-merges-missing-drag-paths-and-deduplicates", (partial?["links"] as? [[String: Any]])?.count == 2)
check("native-drop-stale-source-blocked", drop(doc, paths: [droppedMarkdown.path], requestId: "stale", documentId: "wrong-source") == nil)
prefs(["markdownDropAction": "open", "folderDropAction": "open"])
let opened = drop(doc, paths: [droppedMarkdown.path, linkFolder.path], requestId: "open")
check("native-drop-open-creates-real-markdown-document", opened?["error"] == nil && controller.document(for: droppedMarkdown) is MarkdownDocument)
check("native-drop-folder-open-changes-real-root", doc.folder == linkFolder)
let html = make("imported.html", "<h1>Imported heading</h1><p>Original source survives.</p>")
let importOriginal = try! Data(contentsOf: html)
var export = AppPreferencesStore.loadExport(); export.pandocPath = pandoc.path; AppPreferencesStore.saveExport(export)
prefs(["importDropAction": "import"])
let importedResult = drop(doc, paths: [html.path], requestId: "import")
let imported = controller.documents.compactMap { $0 as? MarkdownDocument }.first { $0.resourceOriginURL == html }
check("native-drop-import-produces-real-independent-document", importedResult?["error"] == nil && imported?.fileURL == nil && imported?.markdown.contains("# Imported heading") == true && imported?.isDocumentEdited == true)
check("native-drop-import-keeps-source-and-root", (try? Data(contentsOf: html)) == importOriginal && imported?.folder == linkFolder && imported?.resourceOriginURL == html)
let errors = drop(doc, paths: [base.appendingPathComponent("missing.md").path], requestId: "missing")
check("native-drop-error-returned-with-request", errors?["error"] as? String != nil && errors?["requestId"] as? String == "missing")
doc.close()
for document in controller.documents { document.close() }

let launch = AppDelegate()
let session = FileSessionStore()
session.save(files: [target.path, droppedMarkdown.path], folders: [root.path])
prefs(["restoreWhenLaunch": 1])
var restored = false
launch.restoreSession(display: false, explicitOpenRequested: false, recoveredDocuments: false, systemClosesWindows: false) { restored = true }
check("launch-mode-one-actual-folder-document", until { restored } && controller.documents.count == 1 && (controller.documents.first as? MarkdownDocument)?.fileURL == nil && (controller.documents.first as? MarkdownDocument)?.folder == root)
for document in controller.documents { document.close() }
session.save(files: [target.path, droppedMarkdown.path], folders: [root.path])
prefs(["restoreWhenLaunch": 2])
restored = false
launch.restoreSession(display: false, explicitOpenRequested: false, recoveredDocuments: false, systemClosesWindows: false) { restored = true }
check("launch-mode-two-opens-real-files-no-duplicate-folder-window", until { restored } && controller.documents.count == 2 && Set(controller.documents.compactMap { $0.fileURL?.path }) == Set([target.path, droppedMarkdown.path]), controller.documents.count)
check("restored-file-retains-associated-folder", (controller.document(for: target) as? MarkdownDocument)?.folder == root)
for document in controller.documents { document.close() }
prefs(["restoreWhenLaunch": 3, "pinFolder": linkFolder.path])
restored = false
launch.restoreSession(display: false, explicitOpenRequested: false, recoveredDocuments: false, systemClosesWindows: false) { restored = true }
check("launch-mode-three-opens-pin-folder", until { restored } && controller.documents.count == 1 && (controller.documents.first as? MarkdownDocument)?.folder == linkFolder)
var sameFolder: MarkdownDocument?
launch.open(linkFolder, display: false) { sameFolder = $0; _ = $1 }
check("opening-same-folder-reuses-window-document", sameFolder === controller.documents.first && controller.documents.count == 1)
for document in controller.documents { document.close() }
prefs(["restoreWhenLaunch": 3, "pinFolder": linkFolder.path]); restored = false
launch.restoreSession(display: false, explicitOpenRequested: false, recoveredDocuments: false, systemClosesWindows: true) { restored = true }
check("explicit-pin-folder-opens-despite-system-close-restore-policy", until { restored } && controller.documents.count == 1 && (controller.documents.first as? MarkdownDocument)?.folder == linkFolder)
for document in controller.documents { document.close() }
for mode in [0, 1, 2, 3] {
    prefs(["restoreWhenLaunch": mode, "pinFolder": linkFolder.path])
    restored = false
    launch.restoreSession(display: false, explicitOpenRequested: true, recoveredDocuments: false, systemClosesWindows: false) { restored = true }
    check("explicit-open-suppresses-session-mode-\(mode)", until { restored } && controller.documents.isEmpty)
}
prefs(["restoreWhenLaunch": 2])
for recovery in [true, false] {
    restored = false
    launch.restoreSession(display: false, explicitOpenRequested: false, recoveredDocuments: recovery, systemClosesWindows: !recovery) { restored = true }
    check(recovery ? "recovery-suppresses-session" : "system-close-overrides-session", until { restored } && controller.documents.isEmpty)
}
session.save(files: ["relative.md", base.appendingPathComponent("missing.md").path], folders: [base.appendingPathComponent("missing-folder").path])
check("session-rejects-invalid-and-missing-paths", session.targets(preferences: FilePreferences(values: ["restoreWhenLaunch": 2]), explicitOpenRequested: false, recoveredDocuments: false, systemClosesWindows: false).isEmpty)
do {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
    let write = try ProcessGroupLauncher.run(executable: executable, arguments: [base.path, pandoc.path, "write-session"], environment: ProcessInfo.processInfo.environment, cwd: base.path, timeout: 15, cancellation: ConversionCancellation())
    let read = try ProcessGroupLauncher.run(executable: executable, arguments: [base.path, pandoc.path, "read-session"], environment: ProcessInfo.processInfo.environment, cwd: base.path, timeout: 15, cancellation: ConversionCancellation())
    check("session-restores-real-documents-across-two-independent-processes", write.stdout.contains("SESSION_WRITE_OK") && read.stdout.contains("\"passed\":true"), read.stdout)
} catch { check("session-restores-real-documents-across-two-independent-processes", false, error.localizedDescription) }

let exportDoc = MarkdownDocument(); exportDoc.fileType = MarkdownDocument.documentType
prefs(["noAutoLink": true]); exportDoc.beginPreparedExport("html")
let prepared = exportDoc.pending.last { $0.0 == "exportPrepare" }?.1 as? [String: Any]
check("export-prepare-freezes-current-markdown-preferences", (prepared?["markdownPreferences"] as? [String: Any])?["noAutoLink"] as? Bool == true && (prepared?["settings"] as? [String: Any])?["markdownPreferences"] == nil)
exportDoc.beginPreparedExport("html", markdownPreferences: ["noAutoLink": false, "requestSnapshot": "renderer"])
let rendererSnapshot = exportDoc.pending.last { $0.0 == "exportPrepare" }?.1 as? [String: Any]
check("renderer-export-entry-snapshot-overrides-later-native-store", (rendererSnapshot?["markdownPreferences"] as? [String: Any])?["noAutoLink"] as? Bool == false && (rendererSnapshot?["markdownPreferences"] as? [String: Any])?["requestSnapshot"] as? String == "renderer")
_ = exportDoc.repeatHistory.record(format: "html", destinationPath: base.appendingPathComponent("repeat.html").path, identity: exportDoc.documentIdentityKey(), frozenSettings: ["key": "html", "type": "html", "options": [:]])
prefs(["noAutoLink": false]); exportDoc.requestRepeatExport(overwrite: false)
let repeated = exportDoc.pending.last { $0.0 == "exportPrepare" }?.1 as? [String: Any]
check("repeat-freezes-new-preferences-without-changing-base-schema", (repeated?["markdownPreferences"] as? [String: Any])?["noAutoLink"] as? Bool == false && (repeated?["settings"] as? [String: Any])?["key"] as? String == "html")
exportDoc.close()
prefs(["quitAfterWindowClose": false]); check("last-window-close-default-stays-running", !launch.applicationShouldTerminateAfterLastWindowClosed(application))
prefs(["quitAfterWindowClose": true]); check("last-window-close-setting-consumed", launch.applicationShouldTerminateAfterLastWindowClosed(application))
defaults.removePersistentDomain(forName: suite)
if let bundle = Bundle.main.bundleIdentifier, bundle == suite + ".bundle" { UserDefaults.standard.removePersistentDomain(forName: bundle) }
check("isolated-defaults-domain-cleaned", defaults.persistentDomain(forName: suite)?.isEmpty != false)
let result: [String: Any] = ["passed": checks.allSatisfy { $0["passed"] as? Bool == true }, "checks": checks,
    "scope": "Actual headless AppKit NSDocumentController/NSDocument save/read, live folder notification, same-document switching, isolated session restoration and native drop/import/export request branches. Modal Save/Don't Save/Cancel choices are injected; actual sheets, GUI focus and pixels are not claimed.",
    "temporaryFilesOnly": true, "uniqueDefaultsSuite": suite, "systemSettingsModified": false, "visibleWindowsCreated": false]
print("FILE_WORKFLOW_JSON:" + String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
exit(result["passed"] as! Bool ? 0 : 1)
