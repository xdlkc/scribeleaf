
import AppKit
import WebKit
import PDFKit
import Foundation
import Darwin

@MainActor final class ExportSettingsVerifier: NSObject, NSApplicationDelegate {
    let folder = Bundle.main.bundleURL.deletingLastPathComponent()
    var fixtures: URL { folder.appendingPathComponent("fixtures", isDirectory: true) }
    var outputDir: URL { folder.appendingPathComponent("output", isDirectory: true) }
    var work: URL { folder }
    let docA = MarkdownDocument()
    let docB = MarkdownDocument()
    let menuOwner = AppDelegate()
    var inspector: NSWindow!
    var log: NSTextView!
    var next: NSButton!
    var checks: [[String: Any]] = []
    var sheets: [[String: Any]] = []
    var pending: [String] = []
    var completed: [Int] = []
    var step = -1
    var active = false
    var sawSheet = false
    var recordedPanel = false
    var sawError = false
    var deadline = Date.distantFuture
    var expectedText = ""
    var initialBytes: [String: Data] = [:]
    var sourceHashes: [String: String] = [:]
    var folderSpy = 0
    var fileSpy = 0
    var pngWidth = 0
    var pdfInfo: [String: Any] = [:]
    var restartVerified = false
    var domainCleaned = false
    var defaultPanel: [String: Any] = [:]
    var booted = false
    var currentKey = "html"
    var seenSheets = Set<ObjectIdentifier>()
    var evaluating = false
    var cancelHistory = RepeatExportHistory()
    let names = [
        "0 General custom dir + pandoc + theme broadcast + Preferences",
        "1 Styled HTML night + outline + post command — Save styled.html",
        "2 Plain HTML — Save plain.html",
        "3 PNG width320 quality2 — Save image.png",
        "4 PDF custom paper/margins/header — Save custom.pdf",
        "5 DOCX reference style — Save custom.docx",
        "6 ODT template + extra metadata — Save custom.odt",
        "7 EPUB CSS toc-depth1 — Save custom.epub",
        "8 Custom saveFile qa-copy.sh — Save custom.txt",
        "9 Custom saveFolder fail — pick output/folder, expect rollback",
        "10 Custom noDialog qa-nodialog.sh (no save panel)",
        "11 Repeat Previous of noDialog (history, no overwrite dialog)",
        "12 HTML Save Cancel — keep cancel-target.html",
        "13 Command failure saveFile — Save, dismiss error",
        "14 PDF YAML headerBar first — Save repeat.pdf",
        "15 Repeat PDF frozen BASE headerFoo — Save repeat-2.pdf then Restart"
    ]
    let hints = [
        "Open Preferences if needed. Next records theme/prefs. Font/focus probes stay pending.",
        "Save as styled.html in output/. Do not dismiss via automation.",
        "Save as plain.html in output/.",
        "Save as image.png in output/. Font probe pending.",
        "Save as custom.pdf. Margin geometry pending if not measured.",
        "Save as custom.docx.",
        "Save as custom.odt.",
        "Save as custom.epub.",
        "Save as custom.txt (arbitrary extension).",
        "Choose the QA output/folder directory. Failure should leave keep.txt.",
        "No panel expected. Next waits for task completion.",
        "Previous export, no overwrite dialog expected.",
        "Click Cancel on the save panel.",
        "Save as failure-target.txt then dismiss the error alert.",
        "Save as repeat.pdf (YAML headerBar).",
        "Save as repeat-2.pdf then use Restart verifier."
    ]
    var primary: NSWindow { docA.windowControllers[0].window! }
    var sourceA: URL { fixtures.appendingPathComponent("source-a.md") }
    var sourceB: URL { fixtures.appendingPathComponent("source-b.md") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let id = Bundle.main.bundleIdentifier ?? "local.export-settings-verifier"
        setenv("TYPORA_REPLICA_DEFAULTS_SUITE", id, 1)
        let phasePath = work.appendingPathComponent("phase.json")
        var isRestart = false
        if let data = try? Data(contentsOf: phasePath),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           obj["phase"] as? String == "restart" {
            isRestart = true
        }
        if !isRestart {
            UserDefaults(suiteName: id)?.removePersistentDomain(forName: id)
            UserDefaults.standard.removePersistentDomain(forName: id)
            let support = Recovery.folder.deletingLastPathComponent()
            if support.lastPathComponent == id { try? FileManager.default.removeItem(at: support) }
        } else if let data = try? Data(contentsOf: work.appendingPathComponent("result.json")),
                  let previous = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  previous["bundleIdentifier"] as? String == id {
            checks = previous["checks"] as? [[String: Any]] ?? []
            sheets = previous["sheets"] as? [[String: Any]] ?? []
            completed = previous["completedStages"] as? [Int] ?? []
            pending = previous["pending"] as? [String] ?? []
            pdfInfo = previous["pdfInfo"] as? [String: Any] ?? [:]
            pngWidth = previous["pngWidth"] as? Int ?? 0
            step = names.count
            booted = true
        }
        AppDelegate.shared = menuOwner
        menuOwner.buildMenu()
        try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        for source in [sourceA, sourceB] {
            initialBytes[source.path] = (try? Data(contentsOf: source)) ?? Data()
        }
        if let data = try? Data(contentsOf: work.appendingPathComponent("source-hashes.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            sourceHashes = obj
        }
        setupDoc(docA, url: sourceA, text: "# INITIAL_A 中文\n")
        setupDoc(docB, url: sourceB, text: "# INITIAL_B 中文\n")
        ExportPostActions.openFolder = { [weak self] _ in self?.folderSpy += 1 }
        ExportPostActions.openFile = { [weak self] _ in self?.fileSpy += 1 }
        buildInspector()
        inspector.level = .floating
        inspector.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        if isRestart {
            Task { await self.verifyRestart(id) }
        } else {
            write("loading")
        }
    }

    func setupDoc(_ doc: MarkdownDocument, url: URL, text: String) {
        doc.fileType = MarkdownDocument.documentType
        doc.fileURL = url
        doc.resourceOriginURL = url
        doc.markdown = text
        doc.lastSavedMarkdown = text
        NSDocumentController.shared.addDocument(doc)
        doc.makeWindowControllers()
        doc.showWindows()
        doc.watchTimer?.invalidate()
        doc.watchTimer = nil
    }

    func buildInspector() {
        inspector = NSWindow(contentRect: NSRect(x: 24, y: 40, width: 850, height: 650),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable],
                             backing: .buffered, defer: false)
        inspector.isReleasedWhenClosed = false
        inspector.title = "Export settings verifier"
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 850, height: 650))
        let scroll = NSScrollView(frame: NSRect(x: 16, y: 70, width: 818, height: 560))
        scroll.hasVerticalScroller = true
        log = NSTextView(frame: scroll.bounds)
        log.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        log.isEditable = false
        scroll.documentView = log
        content.addSubview(scroll)
        next = NSButton(title: "Loading renderer…", target: self, action: #selector(advance))
        next.frame = NSRect(x: 16, y: 16, width: 280, height: 40)
        next.isEnabled = false
        content.addSubview(next)
        let prefs = NSButton(title: "Open Preferences", target: self, action: #selector(openPrefs))
        prefs.frame = NSRect(x: 304, y: 16, width: 150, height: 40)
        content.addSubview(prefs)
        let cancel = NSButton(title: "Cancel task", target: self, action: #selector(cancelTasks))
        cancel.frame = NSRect(x: 460, y: 16, width: 120, height: 40)
        content.addSubview(cancel)
        let restart = NSButton(title: "Restart verifier", target: self, action: #selector(restartVerifier))
        restart.frame = NSRect(x: 586, y: 16, width: 140, height: 40)
        content.addSubview(restart)
        let close = NSButton(title: "Close verifier", target: self, action: #selector(closeVerifier))
        close.frame = NSRect(x: 732, y: 16, width: 102, height: 40)
        content.addSubview(close)
        inspector.contentView = content
        append("Independent QA bundle. Operate only this app's sheets.\n")
        for (i, n) in names.enumerated() { append("  \(i) \(n)\n") }
    }

    func append(_ value: String) { log.string += value; log.scrollToEndOfDocument(nil) }
    func record(_ name: String, _ passed: Bool, _ detail: [String: Any] = [:]) {
        checks.append(["name": name, "passed": passed, "detail": detail, "stage": step])
        append("\(passed ? "PASS" : "FAIL") \(name)\n")
        write(active ? "waiting-for-native-interaction" : "in-progress")
    }
    func markPending(_ name: String) {
        pending.append(name)
        checks.append(["name": name, "passed": false, "pending": true, "detail": ["reason": "manual probe"], "stage": step])
        append("PENDING \(name)\n")
    }

    func js(_ doc: MarkdownDocument, _ code: String, _ arguments: [String: Any] = [:]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            doc.web.callAsyncJavaScript(code, arguments: arguments, in: nil, in: .page) { continuation.resume(with: $0) }
        }
    }
    func setText(_ doc: MarkdownDocument, _ text: String) async throws {
        let _ = try await js(doc, "const v=window.typora.editor;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text}});return window.typora.getMarkdown();", ["text": text])
        let until = Date().addingTimeInterval(5)
        while doc.markdown != text && Date() < until { try await Task.sleep(nanoseconds: 30_000_000) }
        doc.recoveryTask?.cancel(); doc.recoveryTask = nil
        if doc.markdown != text { throw NSError(domain: "ExportSettingsVerifier", code: 1, userInfo: [NSLocalizedDescriptionKey: "Editor change did not arrive"]) }
    }
    func theme(_ doc: MarkdownDocument) async -> String {
        (try? await js(doc, "return document.body?.dataset?.theme || '';")) as? String ?? ""
    }

    func applyExport(_ object: [String: Any]) {
        AppPreferencesStore.saveExport(ExportSettingsDocument.fromJSON(object))
        PreferencesController.broadcastExport()
    }

    func baseSettings() -> [String: Any] {
        let pandoc = Bundle.main.resourceURL!.appendingPathComponent("Converters/pandoc").path
        return [
            "version": 1,
            "pandocPath": pandoc,
            "general": [
                "exportFolder": "custom",
                "customExportPath": outputDir.path,
                "openExportLocation": false
            ],
            "formats": [:] as [String: Any],
            "customExport": [
                ["key": "docx", "name": "Word (.docx)", "type": "docx", "reference-doc": fixtures.appendingPathComponent("reference.docx").path],
                ["key": "odt", "name": "OpenOffice", "type": "odt", "template": fixtures.appendingPathComponent("custom.opendocument").path, "extraArguments": "--metadata qa-extra=QA_NATIVE_METADATA"],
                ["key": "epub", "name": "Epub", "type": "epub", "css": fixtures.appendingPathComponent("epub 样式 #%.css").path, "toc-depth": 1],
                ["key": "qaCopy", "name": "QA Copy", "type": "custom", "command": "./qa-copy.sh ${inputPath} ${outputPath} ${currentDir}", "saveDialog": "saveFile", "extensions": "txt"],
                ["key": "qaFolder", "name": "QA Folder Fail", "type": "custom", "command": "./qa-folder-fail.sh", "saveDialog": "saveFolder"],
                ["key": "qaNone", "name": "QA NoDialog", "type": "custom", "command": "./qa-nodialog.sh ${inputPath} ${outputPath}", "saveDialog": ""],
                ["key": "qaFail", "name": "QA Fail", "type": "custom", "command": "./qa-fail.sh ${inputPath} ${outputPath}", "saveDialog": "saveFile", "extensions": "txt", "openExportFile": true, "openExportLocation": true]
            ]
        ]
    }

    func merge(_ html: [String: Any] = [:], pdf: [String: Any] = [:], image: [String: Any] = [:]) -> [String: Any] {
        var s = baseSettings()
        var formats: [String: Any] = [:]
        if !html.isEmpty { formats["html"] = html }
        if !pdf.isEmpty { formats["pdf"] = pdf }
        if !image.isEmpty { formats["image"] = image }
        s["formats"] = formats
        return s
    }

    @objc func openPrefs() {
        PreferencesController.shared.show(tab: "export")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            let pref = NSApp.windows.first { $0.title == "Preferences" }
            let bounds = pref?.contentView?.bounds ?? .zero
            let frame = pref?.frame ?? .zero
            self.record("PreferencesController window content 720x480",
                        abs(bounds.width - 720) < 1 && abs(bounds.height - 480) < 1,
                        ["content": ["w": bounds.width, "h": bounds.height], "frame": ["w": frame.width, "h": frame.height]])
            self.markPending("manual focus/font probe of Preferences UI")
        }
    }

    @objc func cancelTasks() {
        for task in docA.conversionTasks.values { task.cancel() }
        for task in docB.conversionTasks.values { task.cancel() }
        append("Cancelled conversion tasks\n")
    }

    @objc func restartVerifier() {
        guard !active, Set(completed).isSuperset(of: Set(0..<names.count)),
              checks.filter({ ($0["pending"] as? Bool) != true }).allSatisfy({ $0["passed"] as? Bool == true }) else {
            append("Finish all automatic stages successfully before Restart.\n"); return
        }
        let id = Bundle.main.bundleIdentifier ?? ""
        let defaults = UserDefaults(suiteName: id) ?? .standard
        defaults.set("QA_RESTART_SENTINEL", forKey: "qa.restart.sentinel")
        AppPreferencesStore.saveEditorPrefs(["theme": "night", "qaPersist": "1"])
        applyExport(merge(html: ["exportTheme": "night"]))
        let phase: [String: Any] = ["phase": "restart", "bundleIdentifier": id]
        if let data = try? JSONSerialization.data(withJSONObject: phase, options: [.prettyPrinted]) {
            try? data.write(to: work.appendingPathComponent("phase.json"), options: .atomic)
        }
        write("restarting")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { NSApp.terminate(nil) }
    }

    @objc func closeVerifier() {
        docA.recoveryTask?.cancel(); docB.recoveryTask?.cancel()
        docA.close(); docB.close()
        if let id = Bundle.main.bundleIdentifier {
            UserDefaults(suiteName: id)?.removePersistentDomain(forName: id)
            UserDefaults.standard.removePersistentDomain(forName: id)
        }
        let ownSupport = Recovery.folder.deletingLastPathComponent()
        if ownSupport.lastPathComponent == Bundle.main.bundleIdentifier {
            try? FileManager.default.removeItem(at: ownSupport)
        }
        domainCleaned = true
        write("closed")
        inspector.title = "Closing export settings verifier"
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { NSApp.terminate(nil) }
    }

    func chineseHTML() -> String {
        "# QA_H1_CURRENT 中文标题\n\nUNSAVED_CURRENT 正文。\n\n## QA_H2_CURRENT\n\nQA_HEAD_BODY\n"
    }
    func longPDF() -> String {
        var s = "---\nheader: headerBar\nauthor: YAML_AUTHOR\n---\n\nQA_PDF_TOP 中文\n\n"
        for i in 1...10 { s += "# SEC_\(i)\n\nparagraph \(i) QA_SECTION 中文。\n\n" }
        s += "QA_PDF_BOTTOM 中文\n"
        return s
    }

    @objc func advance() {
        guard !active else { return }
        step += 1
        guard step < names.count else { return }
        next.isEnabled = false; active = true; sawSheet = false; recordedPanel = false; sawError = false
        seenSheets.removeAll(); evaluating = false
        deadline = Date().addingTimeInterval(120)
        folderSpy = 0; fileSpy = 0
        append("\n=== \(names[step]) ===\n\(hints[step])\n")
        inspector.title = names[step]
        Task { await runStage() }
    }

    func runStage() async {
        do {
            switch step {
            case 0:
                applyExport(baseSettings())
                AppPreferencesStore.saveEditorPrefs(["theme": "newsprint"])
                PreferencesController.broadcastEditor(["theme": "newsprint"])
                openPrefs()
                try await Task.sleep(nanoseconds: 800_000_000)
                let ta = await theme(docA), tb = await theme(docB)
                record("Custom pandoc + export folder persisted", {
                    let d = AppPreferencesStore.loadExport()
                    return d.general.exportFolder == "custom" && !d.pandocPath.isEmpty && d.general.customExportPath == outputDir.path
                }())
                record("Two-document theme dataset probe after broadcast", ta == "newsprint" && tb == "newsprint", ["a": ta, "b": tb])
                markPending("manual focus mode probe")
                finishStep(); return
            case 1:
                applyExport(merge(html: [
                    "sidebar": true, "outline": true, "exportTheme": "night",
                    "appendHead": "<meta name=\"qa-head\" content=\"QA_HEAD_MARKER\">", "appendBody": "<div id=\"qa-body\">QA_BODY_MARKER</div>",
                    "runCommand": true, "runCommandStr": "./qa-post.sh",
                    "openExportLocation": true, "openExportFile": true
                ]))
                expectedText = chineseHTML()
                try await setText(docA, expectedText)
                currentKey = "html"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("html")
            case 2:
                applyExport(merge(html: [:]))
                var s = baseSettings()
                s["formats"] = ["html-plain": ["appendHead": "<meta name=\"qa-plain\" content=\"QA_PLAIN_HEAD\">", "appendBody": "<div id=\"qa-plain-body\">QA_PLAIN_BODY</div>"]]
                applyExport(s)
                expectedText = chineseHTML()
                try await setText(docA, expectedText)
                currentKey = "html-plain"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("html-plain")
            case 3:
                applyExport(merge(image: ["imageWidth": 320, "quality": 2, "imageFontSize": 24, "useThemeFontSize": 0, "exportTheme": "pixyll"]))
                expectedText = (try? String(contentsOf: fixtures.appendingPathComponent("font-probe.md"), encoding: .utf8)) ?? "# PNG 中文\n\nUNSAVED_PNG\n"
                try await setText(docA, expectedText)
                currentKey = "image"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("image")
            case 4:
                applyExport(merge(pdf: [
                    "paper": "custom", "paper.custom": [210, 148],
                    "paper.margin": "custom", "paper.marginTop": 11, "paper.marginBottom": 12,
                    "paper.marginLeft": 13, "paper.marginRight": 14,
                    "header": "QA_PDF_HEADER ${author}", "footer": "QA_PDF_FOOTER ${pageNo}",
                    "author": "QA_AUTHOR"
                ]))
                expectedText = longPDF().replacingOccurrences(of: "header: headerBar\n", with: "").replacingOccurrences(of: "author: YAML_AUTHOR\n", with: "")
                try await setText(docA, expectedText)
                currentKey = "pdf"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("pdf")
            case 5:
                applyExport(baseSettings())
                expectedText = "UNSAVED_DOCX_MARKER 中文\n\n::: {custom-style=\"QA Fixture Style\"}\nQA_CUSTOM_STYLE_BODY 中文\n:::\n"
                try await setText(docA, expectedText)
                currentKey = "docx"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("docx")
            case 6:
                applyExport(baseSettings())
                expectedText = "UNSAVED_ODT_MARKER 中文\n"
                try await setText(docA, expectedText)
                currentKey = "odt"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("odt")
            case 7:
                applyExport(baseSettings())
                expectedText = "# EPUB_H1 中文\n\n## EPUB_H2\n\n### EPUB_H3\n\nUNSAVED_EPUB\n"
                try await setText(docA, expectedText)
                currentKey = "epub"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("epub")
            case 8:
                applyExport(baseSettings())
                expectedText = "UNSAVED_COPY 中文正文\n"
                try await setText(docA, expectedText)
                currentKey = "qaCopy"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("qaCopy")
            case 9:
                applyExport(baseSettings())
                expectedText = "UNSAVED_FOLDER 中文\n"
                try await setText(docA, expectedText)
                currentKey = "qaFolder"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("qaFolder")
            case 10:
                applyExport(baseSettings())
                expectedText = "UNSAVED_NODIALOG 中文\n"
                try await setText(docA, expectedText)
                currentKey = "qaNone"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("qaNone")
            case 11:
                expectedText = "UNSAVED_NODIALOG_REPEAT 中文\n"
                try await setText(docA, expectedText)
                primary.makeKeyAndOrderFront(nil)
                record("noDialog history canExportPrevious and not canOverwrite",
                       docA.repeatHistory.canExportPrevious && !docA.repeatHistory.canOverwrite)
                docA.requestRepeatExport(overwrite: false)
            case 12:
                cancelHistory = docA.repeatHistory
                applyExport(merge(html: ["appendBody": "QA_CANCEL"]))
                expectedText = "UNSAVED_CANCEL 中文\n"
                try await setText(docA, expectedText)
                currentKey = "html"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("html")
            case 13:
                applyExport(baseSettings())
                expectedText = "UNSAVED_FAIL 中文\n"
                try await setText(docA, expectedText)
                currentKey = "qaFail"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("qaFail")
            case 14:
                applyExport(merge(pdf: ["header": "headerFoo", "allowPerFileSetting": true, "paper": "custom", "paper.custom": [210, 148]]))
                expectedText = longPDF()
                try await setText(docA, expectedText)
                currentKey = "pdf"
                primary.makeKeyAndOrderFront(nil)
                docA.beginPreparedExport("pdf")
            case 15:
                applyExport(merge(pdf: ["header": "headerBaz", "allowPerFileSetting": true]))
                expectedText = "# NO_YAML 中文\n\nrepeat body\n"
                try await setText(docA, expectedText)
                primary.makeKeyAndOrderFront(nil)
                docA.requestRepeatExport(overwrite: false)
            default:
                finishStep()
            }
            write("waiting-for-native-interaction")
        } catch {
            record("Stage \(step) dispatch", false, ["error": error.localizedDescription])
            finishStep()
        }
    }

    func out(_ name: String) -> URL { outputDir.appendingPathComponent(name) }
    func data(_ url: URL) -> Data { (try? Data(contentsOf: url)) ?? Data() }
    func text(_ url: URL) -> String { String(decoding: data(url), as: UTF8.self) }
    func idle() -> Bool { docA.conversionTasks.isEmpty && primary.attachedSheet == nil && openSheets().isEmpty }

    func openSheets() -> [NSWindow] {
        NSApp.windows.compactMap { $0.attachedSheet }
    }

    func poll() {
        if !booted && step == -1 && docA.ready && docB.ready {
            booted = true
            next.title = names[0]
            next.isEnabled = true
            inspector.title = "READY — \(names[0])"
            write("ready")
            return
        }
        guard active, !evaluating else { return }
        let attached = openSheets()
        if let sheet = attached.first ?? primary.attachedSheet {
            if seenSheets.insert(ObjectIdentifier(sheet)).inserted {
                sawSheet = true
                if let panel = sheet as? NSOpenPanel {
                    recordedPanel = true
                    sheets.append(["stage": step, "kind": "open", "directory": panel.directoryURL?.path ?? ""])
                    panel.directoryURL = outputDir
                } else if let panel = sheet as? NSSavePanel {
                    if !recordedPanel {
                        recordedPanel = true
                        defaultPanel = ["stage": step, "kind": "save", "name": panel.nameFieldStringValue, "directory": panel.directoryURL?.path ?? ""]
                        sheets.append(defaultPanel)
                        let wanted: [Int: String] = [1: "styled.html", 2: "plain.html", 3: "image.png", 4: "custom.pdf", 5: "custom.docx", 6: "custom.odt", 7: "custom.epub", 8: "custom.txt", 12: "cancel-target.html", 13: "failure-target.txt", 14: "repeat.pdf", 15: "repeat-2.pdf"]
                        if let name = wanted[step] {
                            panel.nameFieldStringValue = name
                            panel.directoryURL = (step == 12 || step == 13) ? fixtures : outputDir
                        }
                    }
                } else {
                    sheets.append(["stage": step, "kind": "alert", "title": sheet.title])
                    if !(sheet is NSSavePanel) { sawError = true }
                }
                write("native-sheet-visible")
            }
        }
        evaluateCompletion()
        if Date() > deadline {
            record("Stage \(step) timeout", false)
            finishStep()
        }
    }

    func evaluateCompletion() {
        switch step {
        case 1:
            let url = out("styled.html")
            if FileManager.default.fileExists(atPath: url.path) && idle() {
                let t = text(url)
                let logn = (try? String(contentsOf: fixtures.appendingPathComponent("qa-post.log"), encoding: .utf8)) ?? ""
                let lines = logn.split(separator: "\n").filter { $0.contains("QA_POST") }
                record("styled HTML markers/theme/outline", t.contains("QA_HEAD_MARKER") && t.contains("QA_BODY_MARKER") && t.contains("UNSAVED_CURRENT") && t.contains("中文") && t.contains("data-theme=\"night\"") && t.contains("export-outline"))
                record("post command log exactly 1 and spies", lines.count == 1 && folderSpy == 1 && fileSpy == 1, ["log": lines.count, "folderSpy": folderSpy, "fileSpy": fileSpy])
                evaluating = true
                Task {
                    let a = await theme(docA), b = await theme(docB)
                    record("Export theme leaves both editor themes unchanged", a == "newsprint" && b == "newsprint", ["a": a, "b": b])
                    finishStep()
                }
            }
        case 2:
            let url = out("plain.html")
            if FileManager.default.fileExists(atPath: url.path) && idle() {
                let t = text(url)
                record("plain HTML additions, current Chinese, no built-in styles", t.contains("QA_PLAIN_HEAD") && t.contains("QA_PLAIN_BODY") && t.contains("中文") && !t.contains("<style") && !t.contains("@font-face"))
                finishStep()
            }
        case 3:
            let url = out("image.png")
            if FileManager.default.fileExists(atPath: url.path) && idle() {
                if let img = NSImage(contentsOf: url), let rep = img.representations.first as? NSBitmapImageRep {
                    pngWidth = rep.pixelsWide
                }
                record("PNG physical width 640 (320x quality2)", pngWidth == 640, ["width": pngWidth])
                markPending("PNG font-size probe")
                finishStep()
            }
        case 4:
            let url = out("custom.pdf")
            if FileManager.default.fileExists(atPath: url.path) && idle() {
                inspectPDF(url)
                finishStep()
            }
        case 5:
            if FileManager.default.fileExists(atPath: out("custom.docx").path) && idle() {
                record("DOCX written", true, ["path": out("custom.docx").path]); finishStep()
            }
        case 6:
            if FileManager.default.fileExists(atPath: out("custom.odt").path) && idle() {
                record("ODT written", true); finishStep()
            }
        case 7:
            if FileManager.default.fileExists(atPath: out("custom.epub").path) && idle() {
                record("EPUB written", true); finishStep()
            }
        case 8:
            let url = out("custom.txt")
            if FileManager.default.fileExists(atPath: url.path) && idle() {
                let t = text(url)
                let logt = (try? String(contentsOf: fixtures.appendingPathComponent("qa-copy.log"), encoding: .utf8)) ?? ""
                record("custom copy unsaved Chinese, source unchanged", t.contains("UNSAVED_COPY") && t.contains("中文") && diskUnchanged())
                record("qa-copy log records input/output/cwd", logt.contains("input=") && logt.contains("output=") && logt.contains("cwd="))
                finishStep()
            }
        case 9:
            if sawError && idle() && text(fixtures.appendingPathComponent("qa-folder-fail.log")).contains("QA_FOLDER_FAILED") {
                let keep = outputDir.appendingPathComponent("folder/keep.txt")
                let newbie = outputDir.appendingPathComponent("folder/new-file")
                let keepOK = text(keep).contains("KEEP_SENTINEL")
                let existingOK = text(outputDir.appendingPathComponent("folder/existing-target.txt")) == "EXISTING_TARGET\n"
                record("folder failure leaves keep/existing target and no new-file", keepOK && existingOK && !FileManager.default.fileExists(atPath: newbie.path))
                finishStep()
            }
        case 10:
            let fixed = fixtures.appendingPathComponent("nodialog-fixed.txt")
            if FileManager.default.fileExists(atPath: fixed.path) && idle() {
                let logt = (try? String(contentsOf: fixtures.appendingPathComponent("qa-nodialog.log"), encoding: .utf8)) ?? ""
                record("noDialog output arg empty/not source", !logt.contains(sourceA.path), ["log": logt])
                record("repeatHistory after noDialog", docA.repeatHistory.canExportPrevious && !docA.repeatHistory.canOverwrite)
                finishStep()
            }
        case 11:
            if idle() && sawSheet == false {
                let logt = (try? String(contentsOf: fixtures.appendingPathComponent("qa-nodialog.log"), encoding: .utf8)) ?? ""
                let n = logt.split(separator: "\n").filter { $0.contains("NODIALOG") }.count
                guard n >= 2 else { return }
                record("noDialog previous ran command twice, no overwrite dialog", n == 2 && text(fixtures.appendingPathComponent("nodialog-fixed.txt")).contains("UNSAVED_NODIALOG_REPEAT") && !sheets.contains { ($0["stage"] as? Int) == 11 && ($0["kind"] as? String) == "alert" })
                finishStep()
            } else if idle() && sawSheet {
                record("noDialog previous unexpectedly showed a sheet", false); finishStep()
            }
        case 12:
            if sawSheet && idle() {
                let target = fixtures.appendingPathComponent("cancel-target.html")
                record("Save cancel keeps old target", text(target).contains("KEEP_OLD_TARGET"))
                record("Save cancel keeps previous history", docA.repeatHistory == cancelHistory)
                finishStep()
            }
        case 13:
            if sawError && idle() && text(fixtures.appendingPathComponent("qa-fail.log")).contains("QA_FILE_FAILED") {
                let target = fixtures.appendingPathComponent("failure-target.txt")
                record("command failure leaves original", text(target).contains("KEEP_OLD_TARGET"))
                record("failure has no successful spies", folderSpy == 0 && fileSpy == 0)
                finishStep()
            }
        case 14:
            let url = out("repeat.pdf")
            if FileManager.default.fileExists(atPath: url.path) && idle() {
                inspectPDF(url, tag: "first")
                finishStep()
            }
        case 15:
            let url = out("repeat-2.pdf")
            if FileManager.default.fileExists(atPath: url.path) && idle() {
                inspectPDF(url, tag: "repeat")
                append("Use Restart verifier to persist domain, then relaunch this app.\n")
                finishStep()
            }
        default: break
        }
    }

    func inspectPDF(_ url: URL, tag: String = "custom") {
        guard let pdf = PDFDocument(url: url), let page = pdf.page(at: 0) else {
            record("PDF \(tag) readable", false); return
        }
        let box = page.bounds(for: .mediaBox)
        let extracted = pdf.string ?? ""
        let sizes = (0..<pdf.pageCount).compactMap { index -> [CGFloat]? in
            guard let page = pdf.page(at: index) else { return nil }
            let size = page.bounds(for: .mediaBox); return [size.width, size.height]
        }
        pdfInfo[tag] = ["width": box.width, "height": box.height, "text": extracted, "pageSizes": sizes, "pageCount": pdf.pageCount]
        let sizeOK = sizes.count == pdf.pageCount && sizes.allSatisfy { abs($0[0] - 595.28) < 3 && abs($0[1] - 419.53) < 3 && $0[0] > $0[1] }
        record("PDF \(tag) mediaBox 210x148mm", sizeOK, ["w": box.width, "h": box.height])
        if tag == "custom" {
            record("PDF text top/bottom/header/footer/author",
                   extracted.contains("QA_PDF_TOP") && extracted.contains("QA_PDF_BOTTOM")
                    && extracted.contains("QA_PDF_HEADER") && extracted.contains("QA_AUTHOR")
                    && extracted.contains("QA_PDF_FOOTER"))
            markPending("manual PDF margin geometry")
        }
        if tag == "first" {
            record("first repeat PDF contains YAML headerBar", extracted.contains("headerBar") && !extracted.contains("headerFoo"))
        }
        if tag == "repeat" {
            record("repeated PDF frozen BASE headerFoo, no Baz", extracted.contains("headerFoo") && !extracted.contains("headerBaz"))
        }
    }

    func diskUnchanged() -> Bool {
        initialBytes.allSatisfy { key, value in
            ((try? Data(contentsOf: URL(fileURLWithPath: key))) ?? Data()) == value
        }
    }

    func finishStep() {
        active = false
        completed.append(step)
        record("Stage \(step) source identity preserved", diskUnchanged() && docA.fileURL == sourceA)
        record("Stage \(step) unsaved editor retained", (docA.markdown == expectedText && docA.isDocumentEdited) || step == 0)
        if step + 1 < names.count {
            next.title = names[step + 1]
            next.isEnabled = true
            inspector.title = "done \(step)/\(names.count - 1)"
            write("in-progress")
        } else {
            let auto = checks.filter { ($0["pending"] as? Bool) != true }
            let ok = auto.allSatisfy { $0["passed"] as? Bool == true } && Set(completed).isSuperset(of: Set(0..<names.count))
            inspector.title = "\(ok ? "READY FOR RESTART" : "FAIL") auto \(auto.filter { $0["passed"] as? Bool == true }.count)/\(auto.count) pending \(pending.count)"
            next.title = "All stages finished"
            next.isEnabled = false
            write(ok ? "awaiting-restart" : "failed")
        }
    }

    func verifyRestart(_ id: String) async {
        let until = Date().addingTimeInterval(20)
        while (!docA.ready || !docB.ready) && Date() < until { try? await Task.sleep(nanoseconds: 100_000_000) }
        let sentinel = UserDefaults(suiteName: id)?.string(forKey: "qa.restart.sentinel")
        record("restart sentinel persisted in QA domain", sentinel == "QA_RESTART_SENTINEL")
        let export = AppPreferencesStore.loadExport()
        let exportOK = export.general.exportFolder == "custom" && export.general.customExportPath == outputDir.path && !export.pandocPath.isEmpty
        record("restart export options hydrated", exportOK)
        try? await Task.sleep(nanoseconds: 500_000_000)
        let ta = await theme(docA), tb = await theme(docB)
        record("two renderer hydrations after restart", ta == "night" && tb == "night", ["a": ta, "b": tb])
        restartVerified = sentinel == "QA_RESTART_SENTINEL" && exportOK && ta == "night" && tb == "night"
        completed.append(99)
        write(automaticPassed() ? "passed" : "failed")
        next.title = "Restart verified — Close verifier"
        next.isEnabled = false
        append("Restart checks done. Close verifier to clear domain.\n")
    }

    func automaticPassed() -> Bool {
        restartVerified && Set(completed).isSuperset(of: Set(0..<names.count))
            && !checks.isEmpty && checks.filter { ($0["pending"] as? Bool) != true }.allSatisfy { $0["passed"] as? Bool == true }
    }
    func write(_ status: String) {
        let result: [String: Any] = [
            "status": status, "step": step, "checks": checks, "sheets": sheets,
            "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
            "pid": ProcessInfo.processInfo.processIdentifier,
            "fixtures": fixtures.path, "output": outputDir.path,
            "completedStages": completed, "pending": pending,
            "pngWidth": pngWidth, "pdfInfo": pdfInfo,
            "restartVerified": restartVerified, "domainCleaned": domainCleaned,
            "automaticScopePassed": automaticPassed(),
            "sourceHashes": sourceHashes, "defaultPanel": defaultPanel,
            "actualProductionRenderer": true, "actualProductionNative": true
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: work.appendingPathComponent("result.json"), options: .atomic)
        }
    }
}

@main
enum Main {
    static func main() {
        let app = NSApplication.shared
        let delegate = ExportSettingsVerifier()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
