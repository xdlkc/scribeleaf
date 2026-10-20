import AppKit
import Darwin
import WebKit
import PDFKit
import UniformTypeIdentifiers

let markdownExtensions = Set(["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt", "mdtext", "mmd", "txt", "text", "mdx", "rmd", "qmd", "apib"])

struct EncodedMarkdown {
    let text: String
    let encoding: String.Encoding
    let bom: Data
    static func decode(_ data: Data) throws -> EncodedMarkdown {
        var encoding: String.Encoding = .utf8
        var count = 0
        if data.starts(with: [0xef, 0xbb, 0xbf]) { count = 3 }
        else if data.starts(with: [0xff, 0xfe]) { count = 2; encoding = .utf16LittleEndian }
        else if data.starts(with: [0xfe, 0xff]) { count = 2; encoding = .utf16BigEndian }
        guard let text = String(data: data.dropFirst(count), encoding: encoding) else {
            throw NSError(domain: "TyporaReplica", code: 1, userInfo: [NSLocalizedDescriptionKey: "This file cannot be decoded as UTF-8 or UTF-16 text."])
        }
        return EncodedMarkdown(text: text, encoding: encoding, bom: data.prefix(count))
    }
}

func showError(_ error: Error, window: NSWindow? = nil) {
    if let window { NSAlert(error: error).beginSheetModal(for: window) }
    else { NSAlert(error: error).runModal() }
}

/// Typora's default leaves Markdown punctuation literal. These are public
/// NSTextView actions implemented by macOS WKWebView; validation reports the
/// current WebKit state, which can differ from NSSpellChecker's global flags.
@discardableResult
func configureMarkdownPunctuation(_ web: WKWebView) -> Bool {
    for action in [#selector(NSTextView.toggleAutomaticDashSubstitution(_:)),
                   #selector(NSTextView.toggleAutomaticQuoteSubstitution(_:))] {
        guard web.responds(to: action) else { return false }
        let item = NSMenuItem(title: "", action: action, keyEquivalent: "")
        item.state = .mixed
        _ = web.validateUserInterfaceItem(item)
        if item.state == .on, !web.tryToPerform(action, with: item) { return false }
        item.state = .mixed
        _ = web.validateUserInterfaceItem(item)
        guard item.state == .off else { return false }
    }
    return true
}

/// Recovery keeps resource lookup separate from NSDocument file identity.
/// The dictionary format also accepts records written before schema version 2.
struct RecoveryRecord {
    let markdown: String
    let name: String
    let path: String?
    let resourceOriginPath: String?
    let folderPath: String?
    let encoding: String.Encoding
    let bom: Data

    init(markdown: String, name: String, path: String?, resourceOriginPath: String? = nil, folderPath: String? = nil, encoding: String.Encoding = .utf8, bom: Data = Data()) {
        self.markdown = markdown; self.name = name
        self.path = Self.absolutePath(path)
        self.resourceOriginPath = Self.absolutePath(resourceOriginPath)
        self.folderPath = Self.absolutePath(folderPath)
        self.encoding = encoding; self.bom = bom
    }

    init?(data: Data) {
        guard let item = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let markdown = item["markdown"] as? String else { return nil }
        self.init(markdown: markdown, name: item["name"] as? String ?? "Untitled", path: item["path"] as? String,
                  resourceOriginPath: item["resourceOriginPath"] as? String, folderPath: item["folderPath"] as? String,
                  encoding: (item["encoding"] as? NSNumber).map { String.Encoding(rawValue: $0.uintValue) } ?? .utf8,
                  bom: (item["bom"] as? String).flatMap { Data(base64Encoded: $0) } ?? Data())
    }

    private static func absolutePath(_ value: String?) -> String? {
        guard let value, value.hasPrefix("/"), !value.contains("\0") else { return nil }
        return URL(fileURLWithPath: value).standardizedFileURL.path
    }
    var fileURL: URL? { path.map { URL(fileURLWithPath: $0) } }
    var resourceOriginURL: URL? { resourceOriginPath.map { URL(fileURLWithPath: $0) } }
    var folderURL: URL? { folderPath.map { URL(fileURLWithPath: $0, isDirectory: true) } }

    func encoded() throws -> Data {
        var item: [String: Any] = ["schemaVersion": 2, "markdown": markdown, "name": name, "savedAt": Date().timeIntervalSince1970, "encoding": encoding.rawValue, "bom": bom.base64EncodedString()]
        if let path { item["path"] = path }
        if let resourceOriginPath { item["resourceOriginPath"] = resourceOriginPath }
        if let folderPath { item["folderPath"] = folderPath }
        return try JSONSerialization.data(withJSONObject: item)
    }
}

enum Recovery {
    static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "local.typora-replica.editor", isDirectory: true)
            .appendingPathComponent("Recovery", isDirectory: true)
    }
    static func url(_ id: String) -> URL { folder.appendingPathComponent(id + ".json") }
    static func write(id: String, markdown: String, path: String?, name: String, encoding: String.Encoding, bom: Data, resourceOriginPath: String? = nil, folderPath: String? = nil) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let record = RecoveryRecord(markdown: markdown, name: name, path: path, resourceOriginPath: resourceOriginPath, folderPath: folderPath, encoding: encoding, bom: bom)
        if let bytes = try? record.encoded() { try? bytes.write(to: url(id), options: .atomic) }
    }
    static func remove(_ id: String) { try? FileManager.default.removeItem(at: url(id)) }
}

@objc(MarkdownDocument)
final class MarkdownDocument: NSDocument, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    var markdown = ""
    var lastSavedMarkdown = ""
    var textEncoding: String.Encoding = .utf8
    var byteOrderMark = Data()
    var web: WKWebView!
    var ready = false
    var folder: URL? {
        didSet {
            if oldValue != folder, isDocumentEdited { persistRecovery() }
        }
    }
    private var folderMonitor: FolderMonitor?
    private var documentClosed = false
    // Unsaved duplicates still resolve assets beside their source document.
    var resourceOriginURL: URL?
    var pending: [(String, Any?)] = []
    var watchTimer: Timer?
    var recoveryTask: DispatchWorkItem?
    var lastModified: Date?
    var checkingExternal = false
    var exportJobs: [ExportJob] = []
    var conversionTasks: [UUID: Task<Void, Never>] = [:]
    var recoveryID = UUID().uuidString
    var tableFocused = false
    var repeatHistory = RepeatExportHistory()
    var pendingRepeatRequest: RepeatExportRequest?
    var pendingExportSettings: [String: Any]?
    var pendingExportIsPrevious = false
    static let documentType = "Markdown Document"

    override var fileURL: URL? {
        get { super.fileURL }
        set {
            let previous = super.fileURL?.standardizedFileURL
            super.fileURL = newValue
            if previous != newValue?.standardizedFileURL {
                pendingRepeatRequest = nil
                pendingExportSettings = nil
                for task in conversionTasks.values { task.cancel() }
                repeatHistory.noteDocumentIdentity(documentIdentityKey())
                sendLastExportState()
            }
        }
    }

    func documentIdentityKey() -> String {
        RepeatExport.identityKey(fileURL: fileURL, unsavedID: recoveryID)
    }

    func sendLastExportState() {
        send("lastExportState", ["previous": repeatHistory.canExportPrevious, "overwrite": repeatHistory.canOverwrite])
    }

    func requestRepeatExport(overwrite: Bool) {
        guard !documentClosed, windowControllers.first?.window?.attachedSheet == nil else { return }
        repeatHistory.noteDocumentIdentity(documentIdentityKey())
        guard repeatHistory.canExportPrevious, let format = repeatHistory.format, RepeatExport.isValidFormat(format) else { return }
        if overwrite && !repeatHistory.usesExactLastPath(currentIdentity: documentIdentityKey()) { return }
        let requestId = UUID().uuidString
        pendingRepeatRequest = RepeatExportRequest(id: requestId, format: format, overwrite: overwrite, identity: documentIdentityKey())
        let frozen = repeatHistory.frozenSettings.isEmpty
            ? AppPreferencesStore.loadExport().freeze(key: format == "png" ? "image" : (format == "mediawiki" ? "wiki" : format))
            : repeatHistory.frozenSettings
        pendingExportSettings = frozen
        pendingExportIsPrevious = true
        send("exportPrepare", [
            "overwrite": overwrite, "requestId": requestId, "format": format,
            "identity": documentIdentityKey(), "intent": overwrite ? "overwrite" : "repeat",
            "settings": frozen ?? [:]
        ])
    }

    func beginPreparedExport(_ key: String) {
        guard !documentClosed, windowControllers.first?.window?.attachedSheet == nil else { return }
        let requestId = UUID().uuidString
        guard let frozen = AppPreferencesStore.loadExport().freeze(key: key == "png" ? "image" : (key == "mediawiki" ? "wiki" : key)) else { return }
        pendingExportIsPrevious = false
        pendingExportSettings = frozen
        pendingRepeatRequest = RepeatExportRequest(id: requestId, format: key, overwrite: false, identity: documentIdentityKey())
        send("exportPrepare", [
            "overwrite": false, "requestId": requestId, "format": key,
            "identity": documentIdentityKey(), "intent": "export",
            "settings": frozen
        ])
    }

    override class var autosavesInPlace: Bool { false }

    override func read(from data: Data, ofType typeName: String) throws {
        let decoded = try EncodedMarkdown.decode(data)
        markdown = decoded.text; lastSavedMarkdown = decoded.text
        textEncoding = decoded.encoding; byteOrderMark = decoded.bom
    }

    override func data(ofType typeName: String) throws -> Data {
        guard let data = markdown.data(using: textEncoding) else { throw NSError(domain: "TyporaReplica", code: 3, userInfo: [NSLocalizedDescriptionKey: "This document cannot be encoded."]) }
        return byteOrderMark + data
    }

    override func write(to url: URL, ofType typeName: String) throws {
        try data(ofType: typeName).write(to: url, options: .atomic)
    }

    override func makeWindowControllers() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "native")
        config.userContentController.addUserScript(WKUserScript(source: """
        (() => { const post=message=>window.webkit.messageHandlers.native.postMessage(message);
        const update=()=>post({type:'appearance',theme:document.body?.dataset.theme||'github'});
        const focus=()=>post({type:'tableFocus',active:!!document.activeElement?.closest('.lp-table')});
        document.addEventListener('focusin',focus);document.addEventListener('focusout',()=>queueMicrotask(focus));
        if(document.body){new MutationObserver(update).observe(document.body,{attributes:true,attributeFilter:['data-theme']});update();} })();
        """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: .zero, configuration: config)
        if !configureMarkdownPunctuation(web) { NSLog("Could not configure Markdown punctuation substitutions") }
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = true
        if #available(macOS 13.3, *) { web.isInspectable = true }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 850), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.minSize = NSSize(width: 640, height: 420)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.isMovableByWindowBackground = true
        window.backgroundColor = .white
        window.contentView = web
        window.delegate = self
        window.setFrameAutosaveName("TyporaReplicaDocument")
        window.center()
        let controller = NSWindowController(window: window)
        addWindowController(controller)
        guard let resources = Bundle.main.resourceURL else { return }
        let index = resources.appendingPathComponent("editor/index.html")
        web.loadFileURL(index, allowingReadAccessTo: URL(fileURLWithPath: "/", isDirectory: true))
        lastModified = fileURL.flatMap(modificationDate)
        watchTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.checkExternalChange() }
        window.makeKeyAndOrderFront(nil)
    }

    func send(_ name: String, _ payload: Any? = nil) {
        guard !documentClosed else { return }
        guard ready else { pending.append((name, payload)); return }
        web.callAsyncJavaScript("window.typora?.command(name,payload); return null;", arguments: ["name": name, "payload": payload ?? NSNull()], in: nil, in: .page) { [weak self] result in
            if case .failure(let error) = result { NSLog("Renderer command %@ failed: %@", name, error.localizedDescription); self?.windowControllers.first?.window?.title = "Typora Replica — Editor error" }
        }
    }

    func loadRenderer() {
        pendingRepeatRequest = nil
        repeatHistory.noteDocumentIdentity(documentIdentityKey())
        let origin = fileURL ?? resourceOriginURL
        send("load", ["markdown": markdown, "path": fileURL?.path ?? "", "name": fileURL?.lastPathComponent ?? displayName ?? "Untitled", "base": origin?.deletingLastPathComponent().absoluteString ?? ""])
        if let folder { listFiles(folder) }
        else if let parent = origin?.deletingLastPathComponent() { folder = parent; listFiles(parent) }
        sendLastExportState()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            loadRenderer()
            send("hydratePrefs", ["prefs": AppPreferencesStore.loadEditorPrefs(), "exportSettings": AppPreferencesStore.loadExport().jsonObject()])
            let queued = pending; pending.removeAll()
            for (name, payload) in queued { send(name, payload) }
            sendLastExportState()
        case "prefsChanged":
            if let prefs = body["prefs"] as? [String: Any] {
                AppPreferencesStore.saveEditorPrefs(prefs)
                PreferencesController.broadcastEditor(prefs)
            }
        case "exportSettingsChanged":
            if let settings = body["settings"] {
                AppPreferencesStore.saveExport(ExportSettingsDocument.fromJSON(settings))
                PreferencesController.broadcastExport()
            }
        case "openPreferences":
            PreferencesController.shared.show(tab: body["tab"] as? String ?? "general")
        case "change":
            guard let text = body["markdown"] as? String, text != markdown else { return }
            markdown = text
            if text == lastSavedMarkdown { updateChangeCount(.changeCleared); clearRecovery(); return }
            else { updateChangeCount(.changeDone) }
            recoveryTask?.cancel()
            let task = DispatchWorkItem { [weak self] in
                guard let self, self.isDocumentEdited else { return }
                self.persistRecovery()
            }
            recoveryTask = task
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: task)
        case "save", "saveAs":
            guard let text = body["markdown"] as? String else { return }
            if markdown != text { markdown = text; updateChangeCount(.changeDone) }
            if type == "saveAs" { saveAs(nil) } else { save(nil) }
        case "new": NSDocumentController.shared.newDocument(nil)
        case "close": canClose(withDelegate: self, shouldClose: #selector(closeApproved(_:shouldClose:contextInfo:)), contextInfo: nil)
        case "pastePlainText":
            guard let text = NSPasteboard.general.string(forType: .string) else { return }
            web.callAsyncJavaScript("document.execCommand('insertText', false, text); return null;", arguments: ["text": text], in: nil, in: .page) { [weak self] result in
                if case .failure(let error) = result { showError(error, window: self?.windowControllers.first?.window) }
            }
        case "clipboardImage": handleClipboardImage(body)
        case "open":
            if let path = body["path"] as? String, !path.isEmpty { openDocument(URL(fileURLWithPath: path)) }
            else { NSDocumentController.shared.openDocument(nil) }
        case "openFolder": chooseFolder()
        case "openExternal":
            if let text = body["url"] as? String, let url = URL(string: text, relativeTo: fileURL?.deletingLastPathComponent())?.absoluteURL {
                if url.isFileURL && markdownExtensions.contains(url.pathExtension.lowercased()) { openDocument(url) }
                else if url.isFileURL || ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
            }
        case "repeatExport":
            requestRepeatExport(overwrite: body["overwrite"] as? Bool == true)
        case "beginExport":
            if let key = body["format"] as? String { beginPreparedExport(key) }
        case "export":
            guard let format = body["format"] as? String, let html = body["html"] as? String,
                  let requestId = body["requestId"] as? String, let request = pendingRepeatRequest,
                  let identity = body["identity"] as? String,
                  request.accepts(id: requestId, format: format, overwrite: body["overwrite"] as? Bool == true, identity: identity),
                  identity == documentIdentityKey(), let base = pendingExportSettings else { return }
            let previous = pendingExportIsPrevious
            pendingRepeatRequest = nil
            pendingExportSettings = nil
            var response = body["settings"] as? [String: Any] ?? [:]
            response["snapshot"] = base
            var effective = response["resolved"] as? [String: Any] ?? base["options"] as? [String: Any] ?? [:]
            effective["type"] = base["type"]
            effective["key"] = base["key"]
            response["resolved"] = effective
            exportDocument(format: format, html: html, markdownSnapshot: body["markdown"] as? String ?? markdown,
                           overwrite: request.overwrite, usingPrevious: previous, resolvedSettings: response)
        case "print":
            if let html = body["html"] as? String { renderForPrint(html, destination: nil) }
        case "title": break // NSDocument owns filename, edited indicator and represented URL.
        case "tableFocus": tableFocused = body["active"] as? Bool ?? false
        case "appearance":
            let theme = body["theme"] as? String ?? "github"
            let window = windowControllers.first?.window
            window?.appearance = NSAppearance(named: theme == "night" ? .darkAqua : .aqua)
            window?.backgroundColor = theme == "night" ? NSColor(srgbRed: 54/255, green: 59/255, blue: 64/255, alpha: 1) : .white
        default: break
        }
    }

    override func save(to url: URL, ofType typeName: String, for saveOperation: NSDocument.SaveOperationType, completionHandler: @escaping (Error?) -> Void) {
        let snapshot = markdown
        super.save(to: url, ofType: typeName, for: saveOperation) { [weak self] error in
            if error == nil, let self {
                self.lastSavedMarkdown = snapshot
                self.lastModified = self.modificationDate(url)
                self.send("saved", ["path": url.path, "name": url.lastPathComponent, "markdown": snapshot])
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
                if self.markdown == snapshot { self.clearRecovery() }
                else { self.updateChangeCount(.changeDone); self.persistRecovery() }
            }
            completionHandler(error)
        }
    }

    func openDocument(_ url: URL) {
        NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, error in
            if let error { showError(error, window: self.windowControllers.first?.window) }
        }
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.prompt = "Open Folder"
        panel.beginSheetModal(for: windowControllers[0].window!) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.folder = url; self?.listFiles(url); self?.send("sidebarFiles")
        }
    }

    func listFiles(_ root: URL) {
        guard !documentClosed else { return }
        let normalized = root.standardizedFileURL
        if let folderMonitor, folderMonitor.root == normalized {
            folderMonitor.refresh(forceDelivery: true)
            return
        }
        folderMonitor?.stop()
        let monitor = FolderMonitor(root: normalized, extensions: markdownExtensions) { [weak self] snapshot in
            guard let self, !self.documentClosed, self.folderMonitor?.root.path == snapshot.root else { return }
            self.send("files", snapshot.payload)
        }
        folderMonitor = monitor
        monitor.start()
    }

    func modificationDate(_ url: URL) -> Date? { (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate }

    func persistRecovery() {
        Recovery.write(id: recoveryID, markdown: markdown, path: fileURL?.path, name: displayName ?? "Untitled", encoding: textEncoding, bom: byteOrderMark, resourceOriginPath: resourceOriginURL?.path, folderPath: folder?.path)
    }

    /// Populate native state before any window or renderer is made. In particular,
    /// an unsaved copy's asset origin must never become its save destination.
    func restoreRecovery(_ record: RecoveryRecord, id: String) {
        fileType = NSDocumentController.shared.defaultType ?? Self.documentType
        fileURL = record.fileURL
        resourceOriginURL = record.resourceOriginURL
        if fileURL == nil { displayName = record.name }
        if let fileURL, let bytes = try? Data(contentsOf: fileURL), let disk = try? EncodedMarkdown.decode(bytes) {
            lastSavedMarkdown = disk.text; textEncoding = disk.encoding; byteOrderMark = disk.bom
            fileModificationDate = modificationDate(fileURL)
        } else {
            lastSavedMarkdown = ""
            textEncoding = record.encoding; byteOrderMark = record.bom
        }
        markdown = record.markdown
        recoveryID = id
        folder = record.folderURL
    }

    func clearRecovery() {
        recoveryTask?.cancel(); recoveryTask = nil
        Recovery.remove(recoveryID)
    }

    func checkExternalChange() {
        guard !checkingExternal, let url = fileURL, let date = modificationDate(url), let previous = lastModified, date > previous else { return }
        lastModified = date
        let decoded: EncodedMarkdown
        do { decoded = try EncodedMarkdown.decode(Data(contentsOf: url)) }
        catch { showError(error, window: windowControllers.first?.window); return }
        guard decoded.text != lastSavedMarkdown || decoded.encoding != textEncoding || decoded.bom != byteOrderMark else { return }
        if isDocumentEdited, let window = windowControllers.first?.window {
            let alert = NSAlert()
            alert.messageText = "The file changed on disk."
            alert.informativeText = "Reloading will replace your unsaved edits."
            alert.addButton(withTitle: "Keep My Edits"); alert.addButton(withTitle: "Reload")
            checkingExternal = true
            alert.beginSheetModal(for: window) { [weak self] response in
                self?.checkingExternal = false
                if response == .alertSecondButtonReturn { self?.replaceFromDisk(decoded) }
            }
        } else { replaceFromDisk(decoded) }
    }

    func replaceFromDisk(_ decoded: EncodedMarkdown) {
        markdown = decoded.text; lastSavedMarkdown = decoded.text
        textEncoding = decoded.encoding; byteOrderMark = decoded.bom
        clearRecovery(); updateChangeCount(.changeCleared)
        loadRenderer()
    }

    func exportDocument(format: String, html: String, markdownSnapshot: String? = nil, overwrite: Bool = false, usingPrevious: Bool = false, resolvedSettings: [String: Any]? = nil) {
        guard !documentClosed, windowControllers.first?.window?.attachedSheet == nil else { return }
        let requestIdentity = documentIdentityKey()
        let sourceURL = fileURL ?? resourceOriginURL
        let snapshot = markdownSnapshot ?? markdown
        let frozen = resolvedSettings?["snapshot"] as? [String: Any] ?? AppPreferencesStore.loadExport().freeze(key: format == "png" ? "image" : (format == "mediawiki" ? "wiki" : format)) ?? [:]
        var options = (resolvedSettings?["resolved"] as? [String: Any]) ?? (frozen["options"] as? [String: Any]) ?? [:]
        options["type"] = frozen["type"] ?? format
        options["_metadata"] = resolvedSettings?["metadata"] as? [String: Any] ?? [:]
        let type = (frozen["type"] as? String) ?? format
        let replica = type == "image" ? "png" : (type == "wiki" ? "mediawiki" : type)
        let conversionFormat = DocumentConversionFormat(rawValue: replica == "mediawiki" ? "mediawiki" : replica)
        if conversionFormat != nil || ["latex-pdf", "pandoc", "markdown"].contains(type) {
            let path = frozen["pandocPath"] as? String ?? ""
            do { _ = try DocumentConverter.executableURL(customURL: path.isEmpty ? nil : URL(fileURLWithPath: path)) }
            catch { showError(error, window: windowControllers.first?.window); return }
        }
        let accept: (URL) -> Void = { [weak self] url in
            guard let self, !self.documentClosed, self.documentIdentityKey() == requestIdentity else { return }
            if let sourceURL, sourceURL.standardizedFileURL.resolvingSymlinksInPath() == url.standardizedFileURL.resolvingSymlinksInPath() {
                showError(DocumentConversionError.invalidDestination("Export cannot overwrite the Markdown source document."), window: self.windowControllers.first?.window)
                return
            }
            _ = self.repeatHistory.record(format: format, destinationPath: url.path, identity: self.documentIdentityKey(), frozenSettings: frozen)
            self.sendLastExportState()
            self.performExport(format: replica, html: html, snapshot: snapshot, destination: url, sourceURL: sourceURL, conversionFormat: conversionFormat, options: options, frozen: frozen, requestIdentity: requestIdentity)
        }
        if overwrite {
            guard usingPrevious, repeatHistory.usesExactLastPath(currentIdentity: requestIdentity), let path = repeatHistory.destinationPath, repeatHistory.format == format else { return }
            confirmExportOverwrite(URL(fileURLWithPath: path), then: accept)
            return
        }
        if type == "custom" {
            let saveDialog = options["saveDialog"] as? String ?? ""
            if saveDialog.isEmpty {
                repeatHistory.recordWithoutDestination(format: format, identity: requestIdentity, frozenSettings: frozen)
                sendLastExportState()
                performExport(format: replica, html: html, snapshot: snapshot,
                              destination: FileManager.default.temporaryDirectory.appendingPathComponent("unused-export-target"),
                              sourceURL: sourceURL, conversionFormat: nil, options: options, frozen: frozen, requestIdentity: requestIdentity)
                return
            }
            if saveDialog == "saveFolder" {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true; panel.canChooseFiles = false
                if usingPrevious, let last = repeatHistory.destinationPath { panel.directoryURL = URL(fileURLWithPath: last, isDirectory: true) }
                else if let general = frozen["general"] as? [String: Any] {
                    if general["exportFolder"] as? String == "same" { panel.directoryURL = sourceURL?.deletingLastPathComponent() }
                    else if general["exportFolder"] as? String == "custom", let path = general["customExportPath"] as? String, !path.isEmpty { panel.directoryURL = URL(fileURLWithPath: path, isDirectory: true) }
                }
                guard let window = windowControllers.first?.window else { return }
                panel.beginSheetModal(for: window) { response in
                    guard response == .OK, let url = panel.url else { return }
                    accept(url)
                }
                return
            }
        }
        let panel = NSSavePanel()
        let configuredExtensions = (options["extensions"] as? String ?? "").split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace }).map { String($0).trimmingCharacters(in: CharacterSet(charactersIn: ".")) }.filter { !$0.isEmpty }
        let configuredExtension = configuredExtensions.first
        let ext = configuredExtension?.isEmpty == false ? configuredExtension! : (conversionFormat?.fileExtension ?? (["latex-pdf", "pdf"].contains(replica) ? "pdf" : (replica == "markdown" ? "md" : RepeatExport.fileExtension(for: replica))))
        let autoExtension = type == "pandoc" && configuredExtensions.isEmpty
        panel.allowedContentTypes = autoExtension ? [] : (configuredExtensions.isEmpty ? [conversionFormat?.contentType ?? UTType(filenameExtension: ext) ?? .data] : configuredExtensions.map { UTType(filenameExtension: $0) ?? .data })
        if autoExtension { panel.allowsOtherFileTypes = true }
        let defaultName = ((fileURL?.lastPathComponent ?? displayName ?? "Untitled") as NSString).deletingPathExtension + (autoExtension ? "" : "." + ext)
        if usingPrevious, let suggestion = repeatHistory.panelSuggestion(currentIdentity: documentIdentityKey(), documentName: fileURL?.lastPathComponent ?? displayName ?? "Untitled") {
            panel.directoryURL = URL(fileURLWithPath: suggestion.directory, isDirectory: true)
            panel.nameFieldStringValue = suggestion.filename
        } else {
            panel.nameFieldStringValue = defaultName
            let general = frozen["general"] as? [String: Any]
            let folderMode = general?["exportFolder"] as? String ?? ""
            if folderMode == "same" {
                panel.directoryURL = fileURL?.deletingLastPathComponent()
            } else if folderMode == "custom", let path = general?["customExportPath"] as? String, !path.isEmpty {
                panel.directoryURL = URL(fileURLWithPath: path, isDirectory: true)
            }
        }
        guard let window = windowControllers.first?.window else { return }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            accept(url)
        }
    }

    func confirmExportOverwrite(_ url: URL, then accept: @escaping (URL) -> Void) {
        if AppPreferencesStore.defaults.bool(forKey: RepeatExport.overwriteWarningDefaultsKey) {
            accept(url)
            return
        }
        let alert = NSAlert()
        let template = localizedMenuTitle("\"Export and Overwrite with Previous\" will overwrite file at %@, would you continue?")
        alert.messageText = template.replacingOccurrences(of: "%@", with: url.path)
        alert.addButton(withTitle: localizedMenuTitle("Continue"))
        alert.addButton(withTitle: localizedMenuTitle("Cancel"))
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = localizedMenuTitle("Don't ask again")
        let present: (NSApplication.ModalResponse) -> Void = { response in
            if response == .alertFirstButtonReturn {
                if alert.suppressionButton?.state == .on {
                    AppPreferencesStore.defaults.set(true, forKey: RepeatExport.overwriteWarningDefaultsKey)
                }
                accept(url)
            }
        }
        if let window = windowControllers.first?.window {
            alert.beginSheetModal(for: window, completionHandler: present)
        } else {
            present(alert.runModal())
        }
    }

    func performExport(format: String, html: String, snapshot: String, destination url: URL, sourceURL: URL?, conversionFormat: DocumentConversionFormat?, options: [String: Any] = [:], frozen: [String: Any] = [:], requestIdentity: String? = nil) {
        let identity = requestIdentity ?? documentIdentityKey()
        guard !documentClosed, documentIdentityKey() == identity else { return }
        let generalDict = frozen["general"] as? [String: Any]
        var general = ExportGeneralSettings()
        general.exportFolder = generalDict?["exportFolder"] as? String ?? ""
        general.customExportPath = generalDict?["customExportPath"] as? String ?? ""
        general.openExportLocation = generalDict?["openExportLocation"] as? Bool ?? false
        let pandocPath = frozen["pandocPath"] as? String ?? ""
        let pandocURL = pandocPath.isEmpty ? nil : URL(fileURLWithPath: pandocPath)
        let type = options["type"] as? String ?? format
        var metadata: [String: String] = [:]
        func flatten(_ object: [String: Any], prefix: String = "") {
            for (key, value) in object {
                let path = prefix.isEmpty ? key : prefix + "." + key
                if let nested = value as? [String: Any] { flatten(nested, prefix: path) }
                else if let list = value as? [Any] { metadata[path] = list.map { String(describing: $0) }.joined(separator: ", ") }
                else { metadata[path] = String(describing: value) }
            }
        }
        flatten(options["_metadata"] as? [String: Any] ?? [:])
        for key in ["title", "author", "subject", "creator"] { if let value = options[key] { metadata[key] = String(describing: value) } }
        metadata["sourcePath"] = sourceURL?.path ?? ""
        let sourceDirectory = sourceURL?.deletingLastPathComponent()
        let hasDestination = type != "custom" || !(options["saveDialog"] as? String ?? "").isEmpty
        let finish: (Error?, String?) -> Void = { [weak self] error, output in
            guard let self, !self.documentClosed, self.documentIdentityKey() == identity else { return }
            if let error {
                if case DocumentConversionError.cancelled = error { return }
                showError(error, window: self.windowControllers.first?.window); return
            }
            self.send("exportFinished", ["name": hasDestination ? url.lastPathComponent : (frozen["name"] as? String ?? "Command")])
            let id = UUID()
            self.conversionTasks[id] = Task { @MainActor [weak self] in
                await ExportPostActions.fire(options: options, general: general, destination: hasDestination ? url : nil, output: output,
                                             sourceDirectory: sourceDirectory, succeeded: true, snapshot: snapshot, metadata: metadata)
                self?.conversionTasks[id] = nil
            }
        }
        if type == "custom" {
            let id = UUID(), cancellation = ConversionCancellation()
            conversionTasks[id] = Task { @MainActor [weak self] in
                do {
                    let result: String = try await withTaskCancellationHandler(operation: {
                        try await withCheckedThrowingContinuation { continuation in
                            DispatchQueue.global(qos: .userInitiated).async {
                                let manager = FileManager.default
                                let mode = options["saveDialog"] as? String ?? ""
                                let stagingFolder = (hasDestination ? url.deletingLastPathComponent() : manager.temporaryDirectory).appendingPathComponent(".typora-command-\(UUID().uuidString)", isDirectory: true)
                                do {
                                    try manager.createDirectory(at: stagingFolder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                                    defer { try? manager.removeItem(at: stagingFolder) }
                                    let staging: URL? = mode == "saveFile" ? stagingFolder.appendingPathComponent(url.lastPathComponent) : (mode == "saveFolder" ? stagingFolder : nil)
                                    let output = try CustomCommandRunner.run(command: options["command"] as? String ?? "", snapshot: snapshot,
                                                                            sourceDirectory: sourceDirectory, output: staging, metadata: metadata, cancellation: cancellation)
                                    if cancellation.isCancelled { throw DocumentConversionError.cancelled }
                                    if mode == "saveFile", let staging { try ExportStaging.commitFile(staging: staging, destination: url, source: sourceURL) }
                                    if mode == "saveFolder" { try ExportStaging.commitFolderItems(staging: stagingFolder, destination: url, source: sourceURL) }
                                    continuation.resume(returning: output)
                                } catch { continuation.resume(throwing: error) }
                            }
                        }
                    }, onCancel: { cancellation.cancel() })
                    self?.conversionTasks[id] = nil
                    finish(nil, result)
                } catch { self?.conversionTasks[id] = nil; finish(error, nil) }
            }
            return
        }
        if conversionFormat != nil || ["latex-pdf", "pandoc", "markdown"].contains(type) {
            let extra: [String]
            do { extra = PandocArgv.structuredFlags(options) + (try PandocArgv.sanitize(options["extraArguments"] as? String ?? "")) }
            catch { finish(error, nil); return }
            let id = UUID()
            conversionTasks[id] = Task { @MainActor [weak self] in
                do {
                    let prepared = DocumentConverter.prepareRawMarkdown(snapshot, rawType: options["raw"] as? String ?? "", writer: conversionFormat?.rawValue ?? (options["targetFormat"] as? String ?? type))
                    let result: DocumentConversionResult
                    if let conversionFormat {
                        result = try await DocumentConverter.convert(markdown: prepared, format: conversionFormat, destination: url,
                                                                      documentURL: sourceURL, pandocURL: pandocURL, extraArguments: extra, rawType: options["raw"] as? String ?? "")
                    } else {
                        let writer = type == "latex-pdf" ? "pdf" : (type == "markdown" ? (options["variants"] as? String ?? "markdown") : (options["targetFormat"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
                        result = try await DocumentConverter.convertGeneric(markdown: prepared, writer: writer, destination: url,
                                                                             fileExtension: url.pathExtension, documentURL: sourceURL,
                                                                             pandocURL: pandocURL, extraArguments: extra, timeout: 60, rawType: options["raw"] as? String ?? "")
                    }
                    self?.conversionTasks[id] = nil; finish(nil, result.warnings)
                } catch { self?.conversionTasks[id] = nil; finish(error, nil) }
            }
            return
        }
        let output = embedLocalExportImages(in: html, documentURL: sourceURL)
        if format.hasPrefix("html") {
            do { try output.html.write(to: url, atomically: true, encoding: .utf8); finish(nil, nil) }
            catch { finish(error, nil) }
        } else if format == "png" {
            let width = CGFloat((options["imageWidth"] as? NSNumber)?.doubleValue ?? 640)
            let quality = options["quality"] as? Int ?? 0
            let scale: CGFloat = (1...3).contains(quality) ? CGFloat(quality) : (windowControllers.first?.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 1)
            let id = UUID()
            conversionTasks[id] = Task { @MainActor [weak self] in
                do {
                    _ = try await FullDocumentImageExporter.export(html: output.html, baseURL: sourceDirectory, destination: url, width: width, pixelScale: scale)
                    self?.conversionTasks[id] = nil; finish(nil, nil)
                } catch { self?.conversionTasks[id] = nil; finish(error, nil) }
            }
        } else {
            startPrint(output.html, destination: url, base: sourceDirectory, options: options,
                       canCommit: { [weak self] in self?.documentClosed == false && self?.documentIdentityKey() == identity }, completion: finish)
        }
    }

    func renderForPrint(_ html: String, destination: URL?) {
        let origin = fileURL ?? resourceOriginURL
        let output = embedLocalExportImages(in: html, documentURL: origin)
        startPrint(output.html, destination: destination, base: origin?.deletingLastPathComponent(), options: [:])
    }

    private func startPrint(_ html: String, destination: URL?, base: URL?, options: [String: Any], canCommit: @escaping () -> Bool = { true }, completion: ((Error?, String?) -> Void)? = nil) {
        let job = ExportJob(html: html, base: base, destination: destination, printInfo: printInfo, parent: windowControllers.first?.window,
                            pdfOptions: options, canCommit: canCommit) { [weak self] job, error in
            self?.exportJobs.removeAll { $0 === job }
            if let completion { completion(error, nil) }
            else if let error { showError(error, window: self?.windowControllers.first?.window) }
        }
        exportJobs.append(job); job.start()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        canClose(withDelegate: self, shouldClose: #selector(closeApproved(_:shouldClose:contextInfo:)), contextInfo: nil)
        return false
    }

    @objc func closeApproved(_ document: NSDocument, shouldClose: Bool, contextInfo: UnsafeMutableRawPointer?) {
        if shouldClose { close() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.navigationType == .linkActivated {
            if url.isFileURL, markdownExtensions.contains(url.pathExtension.lowercased()) { openDocument(url) }
            else if url.isFileURL, url.deletingPathExtension().path == web.url?.deletingPathExtension().path { decisionHandler(.allow); return }
            else if url.isFileURL || ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        } else { decisionHandler(url.isFileURL || url.scheme == "about" ? .allow : .cancel) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.beginSheetModal(for: windowControllers[0].window!) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: windowControllers[0].window!) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt
        let field = NSTextField(string: defaultText ?? ""); field.frame = NSRect(x: 0, y: 0, width: 340, height: 24)
        alert.accessoryView = field; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: windowControllers[0].window!) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
        alert.window.initialFirstResponder = field
    }

    override func close() {
        documentClosed = true
        for task in conversionTasks.values { task.cancel() }
        conversionTasks.removeAll()
        folderMonitor?.stop(); folderMonitor = nil
        pending.removeAll()
        pendingRepeatRequest = nil
        clearRecovery(); watchTimer?.invalidate()
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "native")
        web?.navigationDelegate = nil; web?.uiDelegate = nil
        super.close()
    }
}

final class ExportJob: NSObject, WKNavigationDelegate {
    let html: String
    let base: URL?
    let destination: URL?
    let printSettings: NSPrintInfo
    let pdfValues: [String: Any]
    let canCommit: () -> Bool
    var finished = false
    let completion: (ExportJob, Error?) -> Void
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 794, height: 1123))
    var window: NSWindow!
    weak var parent: NSWindow?
    var intermediate: URL?
    init(html: String, base: URL?, destination: URL?, printInfo: NSPrintInfo, parent: NSWindow? = nil, pdfOptions: [String: Any] = [:], canCommit: @escaping () -> Bool = { true }, completion: @escaping (ExportJob, Error?) -> Void) {
        self.html = html; self.base = base; self.destination = destination; self.completion = completion
        self.printSettings = printInfo.copy() as! NSPrintInfo
        self.parent = parent
        self.pdfValues = pdfOptions
        self.canCommit = canCommit
        super.init(); web.navigationDelegate = self
    }
    func start() {
        window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = web
        web.loadHTMLString(html, baseURL: base)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        web.callAsyncJavaScript("await document.fonts.ready; await Promise.all(Array.from(document.images).map(i=>i.complete?Promise.resolve():new Promise(r=>{i.onload=r;i.onerror=r}))); return true;", arguments: [:], in: nil, in: .page) { [weak self] _ in
            guard let self, !self.finished else { return }
            guard self.canCommit() else { self.finish(DocumentConversionError.cancelled); return }
            let info = self.printSettings.copy() as! NSPrintInfo
            if self.destination != nil {
                let temp = FileManager.default.temporaryDirectory.appendingPathComponent("typora-pdf-\(UUID().uuidString).pdf")
                self.intermediate = temp
                info.jobDisposition = .save
                info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = temp
                do { try self.options().apply(to: info) }
                catch { self.finish(error); return }
            } else { info.jobDisposition = .spool }
            info.horizontalPagination = .fit
            info.isVerticallyCentered = false
            if self.destination == nil {
                info.topMargin = 36; info.bottomMargin = 36; info.leftMargin = 36; info.rightMargin = 36
            }
            let operation = self.web.printOperation(with: info)
            // WebKit computes the final page range on its printing thread.
            // Main-thread preview initially reports an unbounded page range.
            operation.canSpawnSeparateThread = true
            operation.showsPrintPanel = self.destination == nil; operation.showsProgressPanel = self.destination == nil
            operation.runModal(for: self.parent ?? self.window, delegate: self, didRun: #selector(self.printFinished(_:success:contextInfo:)), contextInfo: nil)
        }
    }
    func options() throws -> PDFExportOptions {
        var variables = (pdfValues["_metadata"] as? [String: Any] ?? [:]).mapValues { String(describing: $0) }
        for key in ["title", "author", "subject", "creator"] { if let value = pdfValues[key] { variables[key] = String(describing: value) } }
        return try PDFExportOptions(pdfValues, variables: variables)
    }
    func finish(_ error: Error?) {
        guard !finished else { return }
        finished = true
        if let intermediate { try? FileManager.default.removeItem(at: intermediate) }
        window?.close()
        web.navigationDelegate = nil
        completion(self, error)
    }
    @objc func printFinished(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        DispatchQueue.main.async { [self] in
            guard !finished else { return }
            guard canCommit() else { finish(DocumentConversionError.cancelled); return }
            if let destination, let intermediate, success {
                do {
                    if let pdf = PDFDocument(url: intermediate) {
                        var attributes = pdf.documentAttributes ?? [:]
                        for (key, attribute) in [("title", PDFDocumentAttribute.titleAttribute), ("author", .authorAttribute), ("subject", .subjectAttribute), ("creator", .creatorAttribute)] {
                            if let value = pdfValues[key] { attributes[attribute] = String(describing: value) }
                        }
                        pdf.documentAttributes = attributes
                        guard let data = pdf.dataRepresentation() else { throw PDFExportError.invalidSource }
                        try data.write(to: intermediate, options: .atomic)
                    }
                    guard canCommit() else { finish(DocumentConversionError.cancelled); return }
                    try options().finalize(source: intermediate, destination: destination); finish(nil)
                }
                catch { finish(error) }
            } else { finish(success || destination == nil ? nil : DocumentConversionError.cancelled) }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error) }

}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, NSMenuDelegate {
    static var shared: AppDelegate?
    var openedAtLaunch = false
    var launchReady = false
    var pendingOpenURLs: [URL] = []
    weak var exportMenu: NSMenu?
    var document: MarkdownDocument? {
        if let key = NSApp.keyWindow { return key.windowController?.document as? MarkdownDocument }
        return nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)
        let arguments = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-") }
        let recoveries = ((try? FileManager.default.contentsOfDirectory(at: Recovery.folder, includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "json" }
        if !recoveries.isEmpty {
            let alert = NSAlert(); alert.messageText = "Restore unsaved documents?"
            alert.informativeText = "\(recoveries.count) document(s) were recovered from the previous session."
            alert.addButton(withTitle: "Restore"); alert.addButton(withTitle: "Discard")
            if alert.runModal() == .alertFirstButtonReturn {
                for url in recoveries {
                    guard let data = try? Data(contentsOf: url), let record = RecoveryRecord(data: data) else { continue }
                    let text = record.markdown
                    let fileURL = record.fileURL
                    let doc = fileURL.flatMap { NSDocumentController.shared.document(for: $0) as? MarkdownDocument } ?? MarkdownDocument()
                    doc.restoreRecovery(record, id: url.deletingPathExtension().lastPathComponent)
                    if !NSDocumentController.shared.documents.contains(where: { $0 === doc }) { NSDocumentController.shared.addDocument(doc) }
                    if doc.windowControllers.isEmpty { doc.makeWindowControllers() } else { doc.loadRenderer() }
                    doc.showWindows()
                    if text != doc.lastSavedMarkdown { doc.updateChangeCount(.changeDone); doc.persistRecovery() }
                    else { doc.updateChangeCount(.changeCleared); doc.clearRecovery() }
                    openedAtLaunch = true
                }
            } else {
                for url in recoveries { try? FileManager.default.removeItem(at: url) }
            }
        }
        launchReady = true
        var opened = Set<URL>()
        for url in pendingOpenURLs + arguments.map({ URL(fileURLWithPath: $0) }) {
            let path = url.standardizedFileURL
            if opened.insert(path).inserted { open(path); openedAtLaunch = true }
        }
        pendingOpenURLs.removeAll()
        if !openedAtLaunch && NSDocumentController.shared.documents.isEmpty { NSDocumentController.shared.newDocument(nil) }
    }

    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) {
        for case let doc as MarkdownDocument in NSDocumentController.shared.documents {
            doc.clearRecovery()
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        NSDocumentController.shared.reviewUnsavedDocuments(withAlertTitle: "Quit Typora Replica?", cancellable: true, delegate: self, didReviewAllSelector: #selector(reviewed(_:didReviewAll:contextInfo:)), contextInfo: nil)
        return .terminateLater
    }
    @objc func reviewed(_ controller: NSDocumentController, didReviewAll: Bool, contextInfo: UnsafeMutableRawPointer?) {
        NSApp.reply(toApplicationShouldTerminate: didReviewAll)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { NSDocumentController.shared.newDocument(nil) }; return true
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        openedAtLaunch = true
        for path in filenames {
            let url = URL(fileURLWithPath: path)
            if launchReady { open(url) } else { pendingOpenURLs.append(url) }
        }
        sender.reply(toOpenOrPrint: .success)
    }

    func open(_ url: URL) {
        var directory: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), directory.boolValue {
            NSDocumentController.shared.newDocument(nil)
            if let doc = NSDocumentController.shared.currentDocument as? MarkdownDocument { doc.folder = url; doc.listFiles(url); doc.send("sidebarFiles") }
        } else {
            NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, error in if let error { showError(error) } }
        }
    }

    @objc func action(_ sender: NSMenuItem) {
        guard let command = sender.representedObject as? String else { return }
        if document == nil {
            if command == "close", NSApp.keyWindow?.identifier?.rawValue == "preferences" { NSApp.keyWindow?.performClose(sender); return }
            let selector: Selector? = ["selectAll": #selector(NSText.selectAll(_:)), "undo": Selector(("undo:")), "redo": Selector(("redo:")), "pastePlainText": #selector(NSTextView.pasteAsPlainText(_:))][command]
            if let selector { NSApp.sendAction(selector, to: nil, from: sender); return }
        }
        switch command {
        case "new": NSDocumentController.shared.newDocument(nil)
        case "open": NSDocumentController.shared.openDocument(nil)
        case "openFolder": document?.chooseFolder()
        case "save": document?.send("requestSave")
        case "saveAs": document?.send("requestSaveAs")
        case "duplicate":
            guard let source = document else { return }
            do {
                let copy = try source.duplicate()
                if let markdownCopy = copy as? MarkdownDocument {
                    markdownCopy.resourceOriginURL = source.fileURL ?? source.resourceOriginURL
                    markdownCopy.folder = source.folder
                    if markdownCopy.ready { markdownCopy.loadRenderer() }
                }
                if copy.windowControllers.isEmpty { copy.makeWindowControllers() }
                copy.showWindows()
            } catch { showError(error, window: source.windowControllers.first?.window) }
        case "close": document?.canClose(withDelegate: self, shouldClose: #selector(closeApproved(_:shouldClose:contextInfo:)), contextInfo: nil)
        case "print": document?.send("print")
        case "pageSetup": document?.runPageLayout(nil)
        case "fullscreen": document?.windowControllers.first?.window?.toggleFullScreen(nil)
        case "clearRecent": NSDocumentController.shared.clearRecentDocuments(nil)
        case "about": NSApp.orderFrontStandardAboutPanel(nil)
        case "help": NSWorkspace.shared.open(URL(string: "https://support.typora.io/Markdown-Reference/")!)
        case "preferences": PreferencesController.shared.show(tab: "general")
        case "exportSettings": PreferencesController.shared.show(tab: "export")
        case "quickOpen", "toggleSource", "toggleSidebar", "toggleFocus", "toggleTypewriter", "find", "replace", "findNext", "findPrev", "undo", "redo", "zoomIn", "zoomOut", "actualSize", "sidebarFiles", "sidebarListFiles", "sidebarTree", "sidebarOutline", "selectAll", "pastePlainText", "selectLine", "jumpTop", "jumpBottom": document?.send(command)
        default:
            if command.hasPrefix("recent:") { open(URL(fileURLWithPath: String(command.dropFirst(7)))) }
            else if command.hasPrefix("theme:") { document?.send("theme", String(command.dropFirst(6))) }
            else if command.hasPrefix("export:") { document?.beginPreparedExport(String(command.dropFirst(7))) }
            else if command == "exportLast" { document?.requestRepeatExport(overwrite: false) }
            else if command == "exportLastOverwrite" { document?.requestRepeatExport(overwrite: true) }
            else { document?.send("format", command) }
        }
    }

    @objc func closeApproved(_ document: NSDocument, shouldClose: Bool, contextInfo: UnsafeMutableRawPointer?) { if shouldClose { document.close() } }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let command = menuItem.representedObject as? String else { return true }
        if command.hasPrefix("table") && command != "table" { return document?.tableFocused == true }
        if command == "exportLast" { return document?.repeatHistory.canExportPrevious == true }
        if command == "exportLastOverwrite" { return document?.repeatHistory.canOverwrite == true }
        return command.hasPrefix("recent:") || ["new", "open", "about", "help", "clearRecent", "preferences", "exportSettings"].contains(command) || (document == nil && ["selectAll", "undo", "redo", "pastePlainText", "close"].contains(command)) || document != nil
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu.identifier?.rawValue == "recent" else { return }
        menu.removeAllItems()
        for url in NSDocumentController.shared.recentDocumentURLs {
            let item = NSMenuItem(title: url.lastPathComponent, action: #selector(action(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = "recent:" + url.path; item.toolTip = url.path; menu.addItem(item)
        }
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        let clear = NSMenuItem(title: localizedMenuTitle("Clear Menu"), action: #selector(action(_:)), keyEquivalent: "")
        clear.target = self; clear.representedObject = "clearRecent"; menu.addItem(clear)
    }

    func buildMenu() {
        let bar = NSMenu(); NSApp.mainMenu = bar
        func menu(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: localizedMenuTitle(title), action: nil, keyEquivalent: ""); bar.addItem(item)
            let submenu = NSMenu(title: localizedMenuTitle(title)); item.submenu = submenu; return submenu
        }
        func item(_ menu: NSMenu, _ title: String, _ command: String, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command]) {
            let item = NSMenuItem(title: localizedMenuTitle(title), action: #selector(action(_:)), keyEquivalent: key)
            item.target = self; item.representedObject = command; item.keyEquivalentModifierMask = modifiers; menu.addItem(item)
        }
        func role(_ menu: NSMenu, _ title: String, _ selector: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command]) {
            let item = NSMenuItem(title: localizedMenuTitle(title), action: selector, keyEquivalent: key); item.keyEquivalentModifierMask = modifiers; menu.addItem(item)
        }
        func branch(_ parent: NSMenu, _ title: String) -> NSMenu {
            let child = NSMenu(title: localizedMenuTitle(title))
            let entry = NSMenuItem(title: localizedMenuTitle(title), action: nil, keyEquivalent: "")
            entry.submenu = child; parent.addItem(entry); return child
        }
        let app = menu("Typora Replica")
        item(app, "About Typora Replica", "about"); app.addItem(.separator())
        item(app, "Settings…", "preferences", ","); app.addItem(.separator())
        let services = NSMenu(); let servicesItem = NSMenuItem(title: localizedMenuTitle("Services"), action: nil, keyEquivalent: ""); servicesItem.submenu = services; app.addItem(servicesItem); NSApp.servicesMenu = services
        app.addItem(.separator()); role(app, "Hide Typora Replica", #selector(NSApplication.hide(_:)), "h")
        role(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]); role(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator()); role(app, "Quit Typora Replica", #selector(NSApplication.terminate(_:)), "q")
        let file = menu("File")
        item(file, "New", "new", "n"); item(file, "Open…", "open", "o"); item(file, "Open Folder…", "openFolder")
        item(file, "Open Quickly…", "quickOpen", "o", [.command, .shift])
        let recent = NSMenu(title: localizedMenuTitle("Open Recent")); recent.identifier = NSUserInterfaceItemIdentifier("recent"); recent.delegate = self
        let recentItem = NSMenuItem(title: localizedMenuTitle("Open Recent"), action: nil, keyEquivalent: ""); recentItem.submenu = recent; file.addItem(recentItem)
        item(recent, "Clear Menu", "clearRecent")
        file.addItem(.separator()); item(file, "Save", "save", "s"); item(file, "Save As…", "saveAs", "s", [.command, .shift, .option])
        item(file, "Duplicate", "duplicate", "s", [.command, .shift])
        file.addItem(.separator())
        let exportMenu = NSMenu(title: localizedMenuTitle("Export"))
        self.exportMenu = exportMenu
        let exportItem = NSMenuItem(title: localizedMenuTitle("Export"), action: nil, keyEquivalent: ""); exportItem.submenu = exportMenu; file.addItem(exportItem)
        rebuildExportMenu()
        file.addItem(.separator()); item(file, "Page Setup…", "pageSetup", "p", [.command, .shift]); item(file, "Print…", "print", "p")
        file.addItem(.separator()); item(file, "Close", "close", "w")
        let edit = menu("Edit")
        item(edit, "Undo", "undo", "z"); item(edit, "Redo", "redo", "z", [.command, .shift]); edit.addItem(.separator())
        role(edit, "Cut", #selector(NSText.cut(_:)), "x"); role(edit, "Copy", #selector(NSText.copy(_:)), "c"); role(edit, "Paste", #selector(NSText.paste(_:)), "v")
        item(edit, "Paste as Plain Text", "pastePlainText", "v", [.command, .shift]); item(edit, "Select All", "selectAll", "a")
        edit.addItem(.separator()); item(edit, "Find…", "find", "f"); item(edit, "Find Next", "findNext", "g"); item(edit, "Find Previous", "findPrev", "g", [.command, .shift]); item(edit, "Find and Replace…", "replace", "f", [.command, .option])
        edit.addItem(.separator()); item(edit, "Select Line / Sentence", "selectLine", "l"); item(edit, "Jump to Top", "jumpTop", String(UnicodeScalar(NSUpArrowFunctionKey)!), [.command]); item(edit, "Jump to Bottom", "jumpBottom", String(UnicodeScalar(NSDownArrowFunctionKey)!), [.command])
        let paragraph = menu("Paragraph")
        for n in 1...6 { item(paragraph, "Heading \(n)", "heading\(n)", "\(n)") }; item(paragraph, "Paragraph", "paragraph", "0")
        paragraph.addItem(.separator()); item(paragraph, "Increase Heading Level", "increaseHeading", "="); item(paragraph, "Decrease Heading Level", "decreaseHeading", "-")
        paragraph.addItem(.separator())
        let tableMenu = NSMenu(title: localizedMenuTitle("Table"))
        let tableItem = NSMenuItem(title: localizedMenuTitle("Table"), action: nil, keyEquivalent: ""); tableItem.submenu = tableMenu; paragraph.addItem(tableItem)
        item(tableMenu, "Insert Table", "table", "t", [.command, .option]); tableMenu.addItem(.separator())
        item(tableMenu, "Insert Row Above", "tableInsertRowAbove"); item(tableMenu, "Insert Row Below", "tableInsertRowBelow", "\r")
        item(tableMenu, "Insert Column Left", "tableInsertColLeft"); item(tableMenu, "Insert Column Right", "tableInsertColRight")
        tableMenu.addItem(.separator()); item(tableMenu, "Delete Row", "tableDeleteRow", "\u{8}", [.command, .shift]); item(tableMenu, "Delete Column", "tableDeleteCol")
        item(paragraph, "Code Fences", "codeFences", "c", [.command, .option]); item(paragraph, "Math Block", "mathBlock", "b", [.command, .option]); item(paragraph, "Quote", "quote", "q", [.command, .option])
        let alerts = branch(paragraph, "Alert")
        for (label, command) in [("Note", "alertNote"), ("Tip", "alertTip"), ("Important", "alertImportant"), ("Warning", "alertWarning"), ("Caution", "alertCaution")] { item(alerts, label, command) }
        paragraph.addItem(.separator()); item(paragraph, "Ordered List", "orderedList", "o", [.command, .option]); item(paragraph, "Unordered List", "bulletList", "u", [.command, .option]); item(paragraph, "Task List", "taskList", "x", [.command, .option]); item(paragraph, "Indent", "indent", "]"); item(paragraph, "Outdent", "outdent", "[")
        let taskStates = branch(paragraph, "Task State")
        item(taskStates, "Toggle Task State", "toggleTaskState", "x", [.control]); item(taskStates, "Mark as Complete", "taskChecked"); item(taskStates, "Mark as Incomplete", "taskUnchecked")
        paragraph.addItem(.separator()); item(paragraph, "Horizontal Line", "horizontalRule", "-", [.command, .option]); item(paragraph, "Footnote", "footnote", "r", [.command, .option])
        item(paragraph, "Insert Paragraph Above", "insertParagraphAbove"); item(paragraph, "Insert Paragraph Below", "insertParagraphBelow")
        item(paragraph, "Table of Contents", "toc"); item(paragraph, "YAML Front Matter", "yamlFrontMatter")
        item(paragraph, "Link Reference", "linkReferenceDefinition", "l", [.command, .option])
        let format = menu("Format")
        item(format, "Strong", "bold", "b"); item(format, "Emphasis", "italic", "i"); item(format, "Underline", "underline", "u"); item(format, "Code", "inlineCode", "`", [.control]); item(format, "Strikethrough", "strike", "`", [.control, .shift]); item(format, "Highlight", "highlight", "h", [.control, .shift])
        item(format, "Comment", "comment", "-", [.control])
        format.addItem(.separator()); item(format, "Hyperlink…", "hyperlink", "k"); item(format, "Image…", "image", "i", [.command, .control]); format.addItem(.separator()); item(format, "Clear Format", "clearFormat", "\\")
        let view = menu("View")
        item(view, "Toggle Sidebar", "toggleSidebar", "l", [.command, .shift]); item(view, "Outline", "sidebarOutline", "1", [.command, .control]); item(view, "File List", "sidebarListFiles", "2", [.command, .control]); item(view, "File Tree", "sidebarTree", "3", [.command, .control])
        view.addItem(.separator()); item(view, "Source Code Mode", "toggleSource", "/"); item(view, "Focus Mode", "toggleFocus", String(UnicodeScalar(NSF8FunctionKey)!), []); item(view, "Typewriter Mode", "toggleTypewriter", String(UnicodeScalar(NSF9FunctionKey)!), [])
        view.addItem(.separator()); item(view, "Zoom In", "zoomIn", "=", [.command, .shift]); item(view, "Zoom Out", "zoomOut", "-", [.command, .shift]); item(view, "Actual Size", "actualSize", "0", [.command, .shift])
        view.addItem(.separator()); item(view, "Enter Full Screen", "fullscreen", "f", [.command, .control])
        let theme = menu("Theme")
        for name in ["GitHub", "Gothic", "Night", "Newsprint", "Pixyll", "Whitey"] { item(theme, name, "theme:" + name.lowercased()) }
        let window = menu("Window"); NSApp.windowsMenu = window
        role(window, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"); role(window, "Zoom", #selector(NSWindow.performZoom(_:))); window.addItem(.separator()); role(window, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)))
        let help = menu("Help"); NSApp.helpMenu = help; item(help, "Markdown Reference", "help")
    }

    func rebuildExportMenu() {
        guard let exportMenu else { return }
        exportMenu.removeAllItems()
        func item(_ title: String, _ command: String, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command]) {
            let item = NSMenuItem(title: localizedMenuTitle(title), action: #selector(action(_:)), keyEquivalent: key)
            item.target = self; item.representedObject = command; item.keyEquivalentModifierMask = modifiers; exportMenu.addItem(item)
        }
        let settings = AppPreferencesStore.loadExport()
        var first = true
        for entry in settings.menuItems() {
            if first {
                item(entry.label, "export:" + (entry.key == "image" ? "png" : entry.key), entry.key == "pdf" ? "p" : "", entry.key == "pdf" ? [.command, .control] : [.command])
                first = false
            } else {
                item(entry.label, "export:" + (entry.key == "image" ? "png" : entry.key))
            }
        }
        exportMenu.addItem(.separator())
        item("Export with Previous", "exportLast", "e", [.command, .control])
        item("Export and Overwrite with Previous", "exportLastOverwrite")
        exportMenu.addItem(.separator())
        item("Export Settings…", "exportSettings")
    }
}

struct TyporaReplicaApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
