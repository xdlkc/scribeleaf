import AppKit
import Foundation
import UniformTypeIdentifiers

enum FileRuntimeSystemPolicy {
    static var systemAlwaysConfirmsChanges: Bool { alwaysConfirmsChanges(defaults: .standard) }
    static var saveOnSwitchForced: Bool { !systemAlwaysConfirmsChanges }
    static var systemClosesWindows: Bool {
        guard let value = UserDefaults.standard.object(forKey: "NSQuitAlwaysKeepsWindows") as? NSNumber else { return false }
        return !value.boolValue
    }
    static func alwaysConfirmsChanges(defaults: UserDefaults) -> Bool {
        // An absent system key does not authorize an unprompted file write.
        (defaults.object(forKey: "NSCloseAlwaysConfirmsChanges") as? NSNumber)?.boolValue ?? true
    }
    static var payload: [String: Any] {
        ["saveOnFileSwitchForced": saveOnSwitchForced, "systemAlwaysConfirmsChanges": systemAlwaysConfirmsChanges]
    }
}

enum FileRecentLocations {
    static func clear() {
        NSDocumentController.shared.clearRecentDocuments(nil)
        for case let document as MarkdownDocument in NSDocumentController.shared.documents { document.send("clearRecent") }
    }
}

/// Sessions are separate from the Open Recent list. Only paths are stored;
/// unsaved text and encoding/BOM remain in the existing Recovery mechanism.
struct FileSessionStore {
    let defaults: UserDefaults
    static let key = "fileSession.v1"
    init(defaults: UserDefaults = AppPreferencesStore.defaults) { self.defaults = defaults }
    var state: (files: [String], folders: [String]) {
        let data = defaults.dictionary(forKey: Self.key) ?? [:]
        return (Self.paths(data["files"] as? [String] ?? []), Self.paths(data["folders"] as? [String] ?? []))
    }
    func save(files: [String], folders: [String]) {
        defaults.set(["version": 1, "files": Self.paths(files), "folders": Self.paths(folders)], forKey: Self.key)
    }
    func noteClosed(file: URL?, folder: URL?) {
        guard file != nil || folder != nil else { return }
        save(files: file.map { [$0.path] } ?? [], folders: folder.map { [$0.path] } ?? [])
    }
    func targets(preferences: FilePreferences, explicitOpenRequested: Bool, recoveredDocuments: Bool,
                 systemClosesWindows: Bool) -> [FileLaunchTarget] {
        guard !recoveredDocuments else { return [] }
        let current = state
        return preferences.launchPlan(previousFiles: current.files, previousFolders: current.folders,
            explicitOpenRequested: explicitOpenRequested, systemClosesWindows: systemClosesWindows).filter {
                var directory: ObjCBool = false
                return FileManager.default.fileExists(atPath: $0.path, isDirectory: &directory) && directory.boolValue == $0.isDirectory
            }
    }
    private static func paths(_ input: [String]) -> [String] {
        var seen = Set<String>()
        return input.filter { $0.hasPrefix("/") && !$0.contains("\0") }
            .map { URL(fileURLWithPath: $0).standardizedFileURL.path }
            .filter { seen.insert($0).inserted }.prefix(100).map { $0 }
    }
}

/// NSDocument automatically calls these virtual methods during open/save.
/// Keeping the list in the app's preference domain also lets "do not record"
/// suppress automatic entries and makes the menu obey the same switch.
final class ReplicaDocumentController: NSDocumentController {
    static let recentKey = "fileRecentLocations.v1"
    override var defaultType: String? { MarkdownDocument.documentType }
    override func documentClass(forType typeName: String) -> AnyClass? {
        typeName == MarkdownDocument.documentType ? MarkdownDocument.self : super.documentClass(forType: typeName)
    }
    override func typeForContents(of url: URL) throws -> String {
        let preferences = FilePreferences(values: AppPreferencesStore.loadEditorPrefs())
        let configuredSuffix = "." + preferences.effectiveDefaultExtension
        if preferences.isSupportedFile(named: url.lastPathComponent) || url.lastPathComponent.lowercased().hasSuffix(configuredSuffix) { return MarkdownDocument.documentType }
        return try super.typeForContents(of: url)
    }
    func configureOpenPanel(_ panel: NSOpenPanel) {
        let preferences = FilePreferences(values: AppPreferencesStore.loadEditorPrefs())
        panel.allowedContentTypes = preferences.supportedExtensions.sorted().compactMap { UTType(filenameExtension: $0, conformingTo: .plainText) }
        panel.allowsOtherFileTypes = true
        panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = true
    }
    override func beginOpenPanel(_ openPanel: NSOpenPanel, forTypes inTypes: [String]?, completionHandler: @escaping (Int) -> Void) {
        configureOpenPanel(openPanel)
        openPanel.begin { completionHandler($0.rawValue) }
    }
    override func noteNewRecentDocument(_ document: NSDocument) {
        if let url = document.fileURL { noteNewRecentDocumentURL(url) }
    }
    override func noteNewRecentDocumentURL(_ url: URL) {
        guard FilePreferences(values: AppPreferencesStore.loadEditorPrefs()).recordRecentFiles, url.isFileURL else { return }
        let normalized = url.standardizedFileURL.path
        let previous = AppPreferencesStore.defaults.stringArray(forKey: Self.recentKey) ?? []
        AppPreferencesStore.defaults.set(([normalized] + previous.filter { $0 != normalized }).prefix(50).map { $0 }, forKey: Self.recentKey)
    }
    override var recentDocumentURLs: [URL] {
        guard FilePreferences(values: AppPreferencesStore.loadEditorPrefs()).recordRecentFiles else { return [] }
        return (AppPreferencesStore.defaults.stringArray(forKey: Self.recentKey) ?? [])
            .filter { $0.hasPrefix("/") && !$0.contains("\0") }.map { URL(fileURLWithPath: $0) }
    }
    override func clearRecentDocuments(_ sender: Any?) { AppPreferencesStore.defaults.removeObject(forKey: Self.recentKey) }
}

struct PreparedMarkdownFile {
    let url: URL
    let decoded: EncodedMarkdown
    let modificationDate: Date?
    init(url: URL) throws {
        guard url.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), !directory.boolValue else { throw CocoaError(.fileReadNoSuchFile) }
        self.url = url.standardizedFileURL
        decoded = try EncodedMarkdown.decode(Data(contentsOf: self.url))
        modificationDate = (try? self.url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }
}

final class FileSwitchRequest {
    var sourceIdentity: String
    var savingSource = false
    let prepared: PreparedMarkdownFile
    let completion: (Bool, Error?) -> Void
    init(sourceIdentity: String, prepared: PreparedMarkdownFile, completion: @escaping (Bool, Error?) -> Void) {
        self.sourceIdentity = sourceIdentity; self.prepared = prepared; self.completion = completion
    }
}

struct NativeFileDropRequest {
    let requestId: String
    let documentId: String
    let documentPath: String
    let rendererDocumentId: String
    let urls: [URL]
    init?(body: [String: Any], draggingURLs: () -> [URL] = NativeFileDropRequest.draggingURLs) {
        guard let requestId = body["requestId"] as? String, !requestId.isEmpty,
              let documentId = body["documentId"] as? String, !documentId.isEmpty,
              let documentPath = body["documentPath"] as? String else { return nil }
        self.requestId = requestId; self.documentId = documentId; self.documentPath = documentPath
        rendererDocumentId = body["rendererDocumentId"] as? String ?? ""
        let paths = body["paths"] as? [String] ?? []
        var seen = Set<String>()
        let supplied = paths.filter { $0.hasPrefix("/") && !$0.contains("\0") }.map { URL(fileURLWithPath: $0) }
        let candidates = supplied + (body["useDraggingPasteboard"] as? Bool == true ? draggingURLs() : [])
        urls = candidates.filter { $0.isFileURL }.map(\.standardizedFileURL).filter { seen.insert($0.path).inserted }
    }
    static func draggingURLs() -> [URL] {
        NSPasteboard(name: .drag).readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    }
    func accepts(document: MarkdownDocument) -> Bool {
        document.documentIdentityKey() == documentId && (document.fileURL?.standardizedFileURL.path ?? "") == documentPath
    }
}
