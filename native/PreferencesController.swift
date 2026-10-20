import AppKit
import WebKit

final class PreferencesController: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    static let shared = PreferencesController()
    private var window: NSWindow?
    private var web: WKWebView?
    private var ready = false
    private var pendingTab = "general"
    private var uploaderRequestID: String?

    func show(tab: String = "general") {
        pendingTab = tab
        if let window {
            if ready {
                hydrate()
                web?.callAsyncJavaScript("location.hash = '#preferences/' + tab; return null;", arguments: ["tab": tab], in: nil, in: .page, completionHandler: nil)
            } else { pendingTab = tab }
            window.makeKeyAndOrderFront(nil)
            return
        }
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "native")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        self.web = web
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 480),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.identifier = NSUserInterfaceItemIdentifier("preferences")
        window.title = localizedMenuTitle("Preferences")
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.contentView = web
        window.setFrame(NSRect(x: 0, y: 0, width: 720, height: 480), display: false)
        window.center()
        self.window = window
        loadTab(tab)
        window.makeKeyAndOrderFront(nil)
    }

    private func loadTab(_ tab: String) {
        guard let web, let resources = Bundle.main.resourceURL else { return }
        let index = resources.appendingPathComponent("editor/index.html")
        let url = URL(string: "#preferences/\(tab)", relativeTo: index)!
        web.loadFileURL(url.absoluteURL, allowingReadAccessTo: URL(fileURLWithPath: "/", isDirectory: true))
        ready = false
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            web?.callAsyncJavaScript("location.hash = '#preferences/' + tab; return null;", arguments: ["tab": pendingTab], in: nil, in: .page, completionHandler: nil)
            hydrate()
        case "prefsChanged":
            if let prefs = body["prefs"] as? [String: Any] {
                AppPreferencesStore.saveEditorPrefs(prefs)
                PreferencesController.broadcastEditor(prefs)
            }
        case "exportSettingsChanged":
            if let settings = body["settings"] {
                let doc = ExportSettingsDocument.fromJSON(settings)
                AppPreferencesStore.saveExport(doc)
                PreferencesController.broadcastExport()
            }
        case "chooseExportFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true; panel.canChooseFiles = false
            panel.begin { response in
                guard response == .OK, let url = panel.url else { return }
                var doc = AppPreferencesStore.loadExport()
                doc.general.exportFolder = "custom"
                doc.general.customExportPath = url.path
                AppPreferencesStore.saveExport(doc)
                self.hydrate()
                PreferencesController.broadcastExport()
            }
        case "choosePandoc":
            let panel = NSOpenPanel()
            panel.canChooseFiles = true; panel.canChooseDirectories = false
            panel.allowsOtherFileTypes = true
            panel.begin { response in
                guard response == .OK, let url = panel.url else { return }
                var doc = AppPreferencesStore.loadExport()
                doc.pandocPath = url.path
                AppPreferencesStore.saveExport(doc)
                self.hydrate()
                PreferencesController.broadcastExport()
            }
        case "chooseExportFile":
            let field = body["field"] as? String ?? ""
            let key = body["key"] as? String ?? ""
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.begin { response in
                guard response == .OK, let url = panel.url else { return }
                var doc = AppPreferencesStore.loadExport()
                var opts = doc.formats[key] ?? [:]
                opts[field] = .string(url.path)
                doc.formats[key] = opts
                AppPreferencesStore.saveExport(doc)
                self.hydrate()
                PreferencesController.broadcastExport()
            }
        case "choosePreferenceFolder":
            guard let field = body["field"] as? String, ["pinFolder", "customImageFolder"].contains(field), let window else { return }
            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.beginSheetModal(for: window) { response in
                if response == .OK, let url = panel.url {
                    var values = AppPreferencesStore.loadEditorPrefs(); values[field] = url.path
                    if field == "pinFolder", body["selectLaunchFolder"] as? Bool == true { values["restoreWhenLaunch"] = 3 }
                    AppPreferencesStore.saveEditorPrefs(values); PreferencesController.broadcastEditor(values)
                } else { self.hydrate() }
            }
        case "clearRecent": FileRecentLocations.clear()
        case "imageUploaderTest":
            guard let requestID = body["requestId"] as? String, !requestID.isEmpty else { return }
            cancelUploaderTest()
            uploaderRequestID = requestID
            ImageUploaderTester.start(requestId: requestID, values: AppPreferencesStore.loadEditorPrefs()) { [weak self] payload in
                guard let self, self.uploaderRequestID == requestID else { return }
                self.uploaderRequestID = nil
                self.sendUploaderResult(payload)
            }
        case "imageUploaderTestCancel":
            if body["requestId"] as? String == uploaderRequestID { cancelUploaderTest() }
        default: break
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard let window else { completionHandler(nil); return }
        let alert = NSAlert(); alert.messageText = prompt
        let input = NSTextField(string: defaultText ?? "")
        input.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = input; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil) }
        alert.window.initialFirstResponder = input
    }

    func hydrate() {
        let prefs = AppPreferencesStore.loadEditorPrefs()
        if #available(macOS 13.3, *) { web?.isInspectable = prefs["enableDebug"] as? Bool == true }
        let export = AppPreferencesStore.loadExport().jsonObject()
        web?.callAsyncJavaScript(
            "window.typora?.command('hydratePrefs', payload); return null;",
            arguments: ["payload": ["prefs": prefs, "exportSettings": export, "runtimeFilePolicy": FileRuntimeSystemPolicy.payload]],
            in: nil, in: .page, completionHandler: nil
        )
    }

    private func sendUploaderResult(_ payload: [String: Any]) {
        web?.callAsyncJavaScript("window.typora?.command('imageUploaderTestResult', payload); return null;", arguments: ["payload": payload], in: nil, in: .page, completionHandler: nil)
    }

    private func cancelUploaderTest() {
        guard let requestID = uploaderRequestID else { return }
        uploaderRequestID = nil; ImageUploaderTester.cancel(requestId: requestID)
        sendUploaderResult(["requestId": requestID, "error": "cancelled"])
    }

    func windowWillClose(_ notification: Notification) { cancelUploaderTest() }

    static func broadcastEditor(_ prefs: [String: Any]) {
        for document in NSDocumentController.shared.documents.compactMap({ $0 as? MarkdownDocument }) {
            document.send("hydratePrefs", ["prefs": prefs, "exportSettings": AppPreferencesStore.loadExport().jsonObject()])
        }
        shared.hydrate()
        AppDelegate.shared?.rebuildExportMenu()
    }

    static func broadcastExport() {
        let payload = ["prefs": AppPreferencesStore.loadEditorPrefs(), "exportSettings": AppPreferencesStore.loadExport().jsonObject()]
        for document in NSDocumentController.shared.documents.compactMap({ $0 as? MarkdownDocument }) {
            document.send("hydratePrefs", payload)
        }
        shared.hydrate()
        AppDelegate.shared?.rebuildExportMenu()
    }
}
