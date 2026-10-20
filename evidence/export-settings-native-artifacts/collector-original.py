#!/usr/bin/env python3
"""Prepare/collect a real editor + native export-settings QA app.

Owns scripts/verify-export-settings-native.py, evidence/export-settings-native-verification.json,
and files under .cache/export-settings-native-verifier/ only. Does not launch GUI.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import struct
import subprocess
import sys
import uuid
import zipfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.cache/export-settings-native-verifier'
APP = WORK / 'ExportSettingsVerifier.app'
FIXTURE = WORK / 'fixtures'
EVIDENCE = ROOT / 'evidence/export-settings-native-verification.json'
PANDOC = ROOT / '.cache/pandoc/pandoc-3.12.1-x86_64/bin/pandoc'
PANDOC_SHA256 = '287e725a56ed196e1820d25acaecc48b769f9489221bd86ad2d44932e98e9af7'
SRC_FIXTURES = ROOT / '.cache/export-settings-fixtures'
REQUIRED_STAGES = list(range(0, 16))

RUNNER = r'''
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
        "Save failure-target.txt in output, confirm Replace, then dismiss command error.",
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

    func merge(html: [String: Any] = [:], pdf: [String: Any] = [:], image: [String: Any] = [:]) -> [String: Any] {
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
            // Human panel/alert interaction has no processing deadline. Producers retain their own timeout.
            deadline = Date().addingTimeInterval(120)
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
                            panel.directoryURL = outputDir
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
                let target = out("cancel-target.html")
                record("Save cancel keeps old target", text(target) == "KEEP_OLD_TARGET\n")
                record("Save cancel keeps previous history", docA.repeatHistory == cancelHistory)
                finishStep()
            }
        case 13:
            if sawError && idle() && text(fixtures.appendingPathComponent("qa-fail.log")).contains("QA_FILE_FAILED") {
                let target = out("failure-target.txt")
                record("command failure leaves the confirmed existing target", text(target) == "KEEP_OLD_TARGET\n" && docA.repeatHistory.destinationPath == target.path)
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
        let rawExtracted = pdf.string ?? ""
        let extracted = rawExtracted.replacingOccurrences(of: "\n", with: "")
        let sizes = (0..<pdf.pageCount).compactMap { index -> [CGFloat]? in
            guard let page = pdf.page(at: index) else { return nil }
            let size = page.bounds(for: .mediaBox); return [size.width, size.height]
        }
        pdfInfo[tag] = ["width": box.width, "height": box.height, "text": rawExtracted, "normalizedMarkerText": extracted, "pageSizes": sizes, "pageCount": pdf.pageCount]
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
'''


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def refuse_live_pid():
    result = WORK / 'result.json'
    if not result.exists():
        return
    try:
        pid = json.loads(result.read_text()).get('pid')
        if not pid:
            return
        os.kill(int(pid), 0)
    except (ProcessLookupError, ValueError, json.JSONDecodeError):
        return
    raise RuntimeError(f'Previous QA pid {pid} still alive; refuse prepare')


def write_scripts():
    copy = FIXTURE / 'qa-copy.sh'
    copy.write_text(
        '#!/bin/sh\nLOG="$(dirname "$0")/qa-copy.log"\n'
        'printf "NODATA\\ninput=%s\\noutput=%s\\ncwd=%s\\npwd=%s\\n" "$1" "$2" "$3" "$(pwd)" >> "$LOG"\n'
        'cp "$1" "$2"\n', encoding='utf-8')
    copy.chmod(0o755)
    post = FIXTURE / 'qa-post.sh'
    post.write_text('#!/bin/sh\nprintf "QA_POST cwd=%s\\n" "$(pwd)" >> "$(dirname "$0")/qa-post.log"\n', encoding='utf-8')
    post.chmod(0o755)
    failf = FIXTURE / 'qa-folder-fail.sh'
    failf.write_text(
        '#!/bin/sh\necho QA_FOLDER_FAILED >> "$(dirname "$0")/qa-folder-fail.log"\nmkdir -p "$TYPORA_OUTPUT_FOLDER"\necho NEW > "$TYPORA_OUTPUT_FOLDER/new-file"\necho CHANGED > "$TYPORA_OUTPUT_FOLDER/existing-target.txt"\nexit 23\n',
        encoding='utf-8')
    failf.chmod(0o755)
    none = FIXTURE / 'qa-nodialog.sh'
    none.write_text(
        '#!/bin/sh\nLOG="$(dirname "$0")/qa-nodialog.log"\n'
        'printf "NODIALOG in=%s out=%s\\n" "$1" "$2" >> "$LOG"\n'
        'cp "$1" "$(dirname "$0")/nodialog-fixed.txt"\n',
        encoding='utf-8')
    none.chmod(0o755)
    fail = FIXTURE / 'qa-fail.sh'
    fail.write_text(
        '#!/bin/sh\necho QA_FILE_FAILED >> "$(dirname "$0")/qa-fail.log"\nif [ -n "$2" ]; then printf STAGING > "$2"; fi\nexit 23\n', encoding='utf-8')
    fail.chmod(0o755)


def prepare():
    refuse_live_pid()
    if digest(PANDOC) != PANDOC_SHA256:
        raise RuntimeError('Pandoc differs from the already verified pinned binary')
    if not (SRC_FIXTURES / 'manifest.json').exists():
        raise RuntimeError('Run prepare-export-settings-fixtures.py first')
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / 'result.json').unlink(missing_ok=True)
    (WORK / 'phase.json').unlink(missing_ok=True)
    (WORK / 'manual-probes.json').unlink(missing_ok=True)
    sources = WORK / 'Sources'
    if sources.exists():
        shutil.rmtree(sources)
    sources.mkdir()
    hashes = {}
    for original in sorted((ROOT / 'native').glob('*.swift')):
        content = original.read_bytes()
        hashes['native/' + original.name] = hashlib.sha256(content).hexdigest()
        if original.name == 'App.swift':
            if content.count(b'@main\n') != 1:
                raise RuntimeError('App.swift missing @main annotation line')
            content = content.replace(b'@main\n', b'', 1)
        (sources / original.name).write_bytes(content)
    (sources / 'Runner.swift').write_text(RUNNER)
    for original in [*sorted((ROOT / 'src').rglob('*.ts')), *sorted((ROOT / 'src').rglob('*.css'))]:
        hashes[str(original.relative_to(ROOT))] = digest(original)
    if SRC_FIXTURES.exists():
        if FIXTURE.exists():
            shutil.rmtree(FIXTURE)
        shutil.copytree(SRC_FIXTURES, FIXTURE)
    else:
        FIXTURE.mkdir(exist_ok=True)
    src = FIXTURE / 'source.md'
    body = src.read_text(encoding='utf-8') if src.exists() else '# SOURCE_DISK_ONLY 中文\n'
    (FIXTURE / 'source-a.md').write_text(body, encoding='utf-8')
    (FIXTURE / 'source-b.md').write_text(body, encoding='utf-8')
    image_relative = next((p.relative_to(FIXTURE).as_posix() for p in FIXTURE.rglob('*.png') if 'image 图' in p.name), '')
    from urllib.parse import quote
    (FIXTURE / 'font-probe.md').write_text(
        '# FONT_QA_H1 中文\n\nFONT_QA_P paragraph 中文 UNSAVED_PNG\n\n'
        '```text\nFONT_QA_PRE code 24px\n```\n\n'
        '| FONT_QA_TABLE | Column |\n| --- | --- |\n| 中文正文 | 24px |\n\n'
        f'<img alt="FONT_QA_FIXED100" src="{quote(image_relative, safe="/")}" style="width:100px;height:auto">\n', encoding='utf-8')
    out = WORK / 'output'
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(exist_ok=True)
    (out / 'cancel-target.html').write_text('KEEP_OLD_TARGET\n', encoding='utf-8')
    (out / 'failure-target.txt').write_text('KEEP_OLD_TARGET\n', encoding='utf-8')
    folder = out / 'folder'
    folder.mkdir(exist_ok=True)
    (folder / 'keep.txt').write_text('KEEP_SENTINEL\n', encoding='utf-8')
    (folder / 'existing-target.txt').write_text('EXISTING_TARGET\n', encoding='utf-8')
    write_scripts()
    (WORK / 'manual-probes.example.json').write_text(json.dumps({
        'bundleIdentifier': 'COPY_FROM_result.json',
        'probes': [
            {'id': 'focus', 'passed': False, 'evidence': 'Actual Preferences keyWindow shortcut routing and unchanged background documents'},
            {'id': 'fonts', 'passed': False, 'evidence': 'Actual p/h1/pre/table at 24px across Pixyll/exportTheme; 100px image unchanged'},
            {'id': 'pdfGeometry', 'passed': False, 'evidence': 'Actual PDF consumer paper and body-margin measurements'},
        ],
    }, ensure_ascii=False, indent=2) + '\n')
    (WORK / 'source-hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')
    resources = APP / 'Contents/Resources'
    resources.mkdir(parents=True, exist_ok=True)
    renderer = WORK / 'renderer'
    built = subprocess.run(
        ['npm', 'run', 'build', '--', '--outDir', str(renderer)],
        cwd=ROOT, capture_output=True, text=True, timeout=180)
    if built.returncode:
        evidence = {
            'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'compiler': {'passed': False, 'diagnostics': 'renderer build failed'},
            'rendererBuild': {'passed': False, 'stderr': built.stderr[-4000:]},
            'actualNative': {'status': 'not-yet-run'},
        }
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(evidence, ensure_ascii=False, indent=2))
        return 1
    shutil.copytree(renderer, resources / 'editor', dirs_exist_ok=True)
    converters = resources / 'Converters'
    converters.mkdir(exist_ok=True)
    shutil.copy2(PANDOC, converters / 'pandoc')
    executable = APP / 'Contents/MacOS/ExportSettingsVerifier'
    executable.parent.mkdir(parents=True, exist_ok=True)
    identifier = 'com.typora-replica.export-settings-verifier.' + uuid.uuid4().hex
    (APP / 'Contents/Info.plist').write_bytes(plistlib.dumps({
        'CFBundleExecutable': 'ExportSettingsVerifier',
        'CFBundleIdentifier': identifier,
        'CFBundleName': 'Export Settings Verifier',
        'CFBundlePackageType': 'APPL',
        'NSPrincipalClass': 'NSApplication',
        'NSHighResolutionCapable': True,
        'LSMinimumSystemVersion': '13.0',
    }))
    module_cache = WORK / 'swift-module'
    module_cache.mkdir(exist_ok=True)
    compiler = subprocess.run([
        'xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library',
        '-target', platform.machine() + '-apple-macosx13.0',
        '-module-cache-path', str(module_cache),
        *map(str, sorted(sources.glob('*.swift'))),
        '-o', str(executable),
        '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'PDFKit',
        '-framework', 'UniformTypeIdentifiers',
    ], cwd=ROOT, capture_output=True, text=True, timeout=120)
    signature = None
    if compiler.returncode == 0:
        signed = subprocess.run(['codesign', '--force', '--sign', '-', str(APP)], capture_output=True, text=True, timeout=30)
        signature = {'passed': signed.returncode == 0, 'diagnostics': signed.stderr.strip()}
    evidence = {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'bundleIdentifier': identifier,
        'verifierBundle': str(APP),
        'compiler': {
            'passed': compiler.returncode == 0,
            'target': 'macOS13 / Swift5',
            'diagnostics': (compiler.stderr or compiler.stdout)[-8000:],
        },
        'rendererBuild': {'passed': built.returncode == 0, 'outputDirectory': str(renderer)},
        'adHocSignature': signature,
        'sourceSHA256': hashes,
        'bundledPandocSHA256': digest(converters / 'pandoc'),
        'verifierScriptSHA256': digest(Path(__file__)),
        'fixtureSourceSHA256': {str(p.relative_to(WORK)): digest(p) for p in (FIXTURE / 'source-a.md', FIXTURE / 'source-b.md')},
        'actualNative': {'status': 'not-yet-run'},
        'scope': 'Real production renderer/native export settings; own app/UI only',
        'compiledChecks': compiler.returncode == 0,
        'cliFixtureBaseline': 'separate from native UI; see .cache/export-settings-fixtures',
        'passed': False,
    }
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: evidence[k] for k in ('bundleIdentifier', 'compiler', 'rendererBuild', 'adHocSignature') if k in evidence}, ensure_ascii=False, indent=2))
    return 0 if compiler.returncode == 0 and signature and signature['passed'] else 1


class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.chunks = []

    def handle_data(self, data):
        self.chunks.append(data)


def html_text(path: Path) -> str:
    if not path.exists():
        return ''
    raw = path.read_text(encoding='utf-8', errors='replace')
    p = _Text()
    p.feed(raw)
    return raw + ' ' + ''.join(p.chunks)


def png_ihdr(path: Path):
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>II', data[16:24])


def zip_xml_blob(path: Path) -> str:
    if not path.exists():
        return ''
    parts = []
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if name.endswith(('.xml', '.xhtml', '.html', '.css', '.ncx')):
                parts.append(zf.read(name).decode('utf-8', 'replace'))
    return '\n'.join(parts)


def collect():
    evidence = json.loads(EVIDENCE.read_text()) if EVIDENCE.exists() else {}
    result_path = WORK / 'result.json'
    if not result_path.exists():
        evidence.update(actualNative={'status': 'not-run', 'reason': 'No actual native UI result'},
                        passed=False, automaticScopePassed=False, fullParity=False)
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(evidence['actualNative']))
        return 1
    result = json.loads(result_path.read_text())
    matching = bool(evidence.get('bundleIdentifier')) and result.get('bundleIdentifier') == evidence['bundleIdentifier']
    unchanged = {name: (ROOT / name).is_file() and digest(ROOT / name) == sha
                 for name, sha in evidence.get('sourceSHA256', {}).items()}
    source_unchanged = {name: (WORK / name).is_file() and digest(WORK / name) == sha
                        for name, sha in evidence.get('fixtureSourceSHA256', {}).items()}
    script_unchanged = digest(Path(__file__)) == evidence.get('verifierScriptSHA256')
    outputs = {}

    def output_check(name, function):
        try:
            detail = function()
            outputs[name] = {'passed': bool(detail.pop('passed')), **detail}
        except Exception as error:
            outputs[name] = {'passed': False, 'error': f'{type(error).__name__}: {error}'}

    def html_proof(name, plain=False):
        raw = (WORK / 'output' / name).read_text(encoding='utf-8')
        parser = _Text(); parser.feed(raw)
        head_marker = 'QA_PLAIN_HEAD' if plain else 'QA_HEAD_MARKER'
        body_marker = 'QA_PLAIN_BODY' if plain else 'QA_BODY_MARKER'
        in_head = raw.count(head_marker) == 1 and raw.index(head_marker) < raw.index('</head>')
        in_body = raw.count(body_marker) == 1 and raw.index(body_marker) > raw.index('<body')
        styled = '<style' in raw and 'data-theme="night"' in raw and 'export-outline' in raw
        no_style = '<style' not in raw.lower() and '@font-face' not in raw and '<link rel="stylesheet"' not in raw
        current = 'UNSAVED_CURRENT' in raw and '中文' in ''.join(parser.chunks)
        return {'passed': in_head and in_body and current and (no_style if plain else styled),
                'appendHeadExactlyOnceInHead': in_head, 'appendBodyExactlyOnceInBody': in_body,
                'currentUnsavedChinese': current, 'plainHasNoStyles': no_style, 'nightOutlineStyled': styled}

    output_check('styled.html', lambda: html_proof('styled.html'))
    output_check('plain.html', lambda: html_proof('plain.html', True))

    def png_proof():
        path = WORK / 'output/image.png'
        size = png_ihdr(path)
        detail = {'passed': bool(size and size[0] == 640 and size[1] > 0), 'decoder': 'PNG IHDR', 'dimensions': size}
        try:
            from PIL import Image
        except ImportError:
            return detail
        with Image.open(path) as image:
            image.load()
            detail.update(pilDimensions=list(image.size), decoder='PNG IHDR + PIL full decode')
            detail['passed'] = detail['passed'] and image.size == size
        return detail
    output_check('image.png', png_proof)

    def pdf_proof(filename, tag, markers, excludes=()):
        path = WORK / 'output' / filename
        if not path.read_bytes().startswith(b'%PDF-'):
            raise ValueError('Not a PDF')
        try:
            from pypdf import PdfReader
            reader = PdfReader(str(path))
            sizes = [(float(p.mediabox.width), float(p.mediabox.height)) for p in reader.pages]
            text = '\n'.join(p.extract_text() or '' for p in reader.pages)
            decoder = 'independent pypdf'
        except ImportError:
            proof = (result.get('pdfInfo') or {}).get(tag) or {}
            sizes = proof.get('pageSizes') or [(proof.get('width', 0), proof.get('height', 0))]
            text = proof.get('text') or ''
            decoder = 'actual-app PDFKit consumer; pypdf unavailable'
        dimensions = bool(sizes) and all(abs(w - 595.28) < 3 and abs(h - 419.53) < 3 and w > h for w, h in sizes)
        normalized_text = text.replace('\n', '').replace('\r', '')
        found = {marker: marker in normalized_text for marker in markers}
        absent = {marker: marker not in normalized_text for marker in excludes}
        return {'passed': dimensions and all(found.values()) and all(absent.values()),
                'decoder': decoder, 'allPageSizes': sizes, 'customLandscapeSize': dimensions,
                'markers': found, 'excludedMarkers': absent, 'textExcerpt': text[:700]}
    output_check('custom.pdf', lambda: pdf_proof('custom.pdf', 'custom', ['QA_PDF_TOP', 'QA_PDF_BOTTOM', 'QA_PDF_HEADER', 'QA_PDF_FOOTER', 'QA_AUTHOR']))
    output_check('repeat.pdf', lambda: pdf_proof('repeat.pdf', 'first', ['headerBar'], ['headerFoo']))
    output_check('repeat-2.pdf', lambda: pdf_proof('repeat-2.pdf', 'repeat', ['headerFoo'], ['headerBaz', 'headerBar']))

    def archive(path):
        z = zipfile.ZipFile(path)
        bad = z.testzip()
        if bad: raise ValueError('ZIP CRC failure: ' + bad)
        for name in z.namelist():
            if name.endswith(('.xml', '.xhtml', '.opf', '.ncx', '.rels')):
                ET.fromstring(z.read(name))
        return z

    def docx_proof():
        ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        with archive(WORK / 'output/custom.docx') as z:
            styles = ET.fromstring(z.read('word/styles.xml'))
            document = ET.fromstring(z.read('word/document.xml'))
            style_id = None; color = None
            for style in styles.findall(ns + 'style'):
                name = style.find(ns + 'name')
                if name is not None and name.get(ns + 'val') == 'QA Fixture Style':
                    style_id = style.get(ns + 'styleId')
                    c = style.find(ns + 'rPr/' + ns + 'color')
                    color = c.get(ns + 'val') if c is not None else None
            referenced = False
            for paragraph in document.iter(ns + 'p'):
                if 'QA_CUSTOM_STYLE_BODY' in ''.join(paragraph.itertext()):
                    ref = paragraph.find(ns + 'pPr/' + ns + 'pStyle')
                    referenced = ref is not None and ref.get(ns + 'val') == style_id
            unsaved = 'UNSAVED_DOCX_MARKER' in ''.join(document.itertext())
            return {'passed': style_id is not None and color == '1B6F5A' and referenced and unsaved,
                    'styleId': style_id, 'styleColor': color, 'bodyParagraphReferencesStyle': referenced, 'unsavedMarker': unsaved}
    output_check('custom.docx', docx_proof)

    def odt_proof():
        with archive(WORK / 'output/custom.odt') as z:
            text = ''.join(ET.fromstring(z.read('content.xml')).itertext())
            markers = {s: s in text for s in ['QA_ODT_TEMPLATE_APPLIED', 'QA_NATIVE_METADATA', 'UNSAVED_ODT_MARKER', '中文']}
            return {'passed': all(markers.values()), 'markers': markers,
                    'mimetype': z.read('mimetype').decode()}
    output_check('custom.odt', odt_proof)

    def epub_proof():
        html_ns = '{http://www.w3.org/1999/xhtml}'
        epub_ns = '{http://www.idpf.org/2007/ops}'
        with archive(WORK / 'output/custom.epub') as z:
            css = [name for name in z.namelist() if name.endswith('.css') and b'QA_EPUB_CSS_APPLIED' in z.read(name)]
            nav_name = next(name for name in z.namelist() if name.endswith('/nav.xhtml') or name == 'nav.xhtml')
            nav = ET.fromstring(z.read(nav_name))
            toc = next(n for n in nav.iter(html_ns + 'nav') if n.get(epub_ns + 'type') == 'toc')
            labels = [''.join(n.itertext()) for n in toc.iter(html_ns + 'a')]
            toc_ok = any('EPUB_H1' in s for s in labels) and not any('EPUB_H2' in s or 'EPUB_H3' in s for s in labels)
            body = '\n'.join(''.join(ET.fromstring(z.read(n)).itertext()) for n in z.namelist() if n.endswith('.xhtml') and n != nav_name)
            body_ok = all(s in body for s in ['EPUB_H1', 'EPUB_H2', 'EPUB_H3', 'UNSAVED_EPUB'])
            return {'passed': bool(css) and toc_ok and body_ok and z.read('mimetype') == b'application/epub+zip',
                    'customCssEntries': css, 'tocLabels': labels, 'tocDepth1': toc_ok, 'deepHeadingsRemainInBody': body_ok}
    output_check('custom.epub', epub_proof)

    def custom_proof():
        text = (WORK / 'output/custom.txt').read_text(encoding='utf-8')
        log = (FIXTURE / 'qa-copy.log').read_text(encoding='utf-8')
        fields = dict(line.split('=', 1) for line in log.splitlines() if '=' in line)
        private = fields.get('input', '').endswith('/snapshot.md') and '/typora-cmd-' in fields.get('input', '') and fields['input'] != str(FIXTURE / 'source-a.md')
        cwd = fields.get('cwd') == str(FIXTURE) and fields.get('pwd') == str(FIXTURE)
        return {'passed': 'UNSAVED_COPY' in text and '中文' in text and private and cwd,
                'privateInput': private, 'relativeCwd': cwd, 'loggedArguments': fields}
    output_check('custom.txt', custom_proof)

    def post_and_negative_proof():
        post = (FIXTURE / 'qa-post.log').read_text(encoding='utf-8').splitlines()
        none = (FIXTURE / 'qa-nodialog.log').read_text(encoding='utf-8').splitlines()
        none_ok = len(none) == 2 and all(line.endswith(' out=') for line in none)
        repeat_current = 'UNSAVED_NODIALOG_REPEAT' in (FIXTURE / 'nodialog-fixed.txt').read_text(encoding='utf-8')
        cancel = (WORK / 'output/cancel-target.html').read_bytes() == b'KEEP_OLD_TARGET\n'
        failed = (WORK / 'output/failure-target.txt').read_bytes() == b'KEEP_OLD_TARGET\n'
        folder = WORK / 'output/folder'
        folder_ok = ((folder / 'keep.txt').read_bytes() == b'KEEP_SENTINEL\n' and
                     (folder / 'existing-target.txt').read_bytes() == b'EXISTING_TARGET\n' and not (folder / 'new-file').exists())
        file_ran = (FIXTURE / 'qa-fail.log').read_text().splitlines() == ['QA_FILE_FAILED']
        folder_ran = (FIXTURE / 'qa-folder-fail.log').read_text().splitlines() == ['QA_FOLDER_FAILED']
        post_ok = post == ['QA_POST cwd=' + str(FIXTURE)]
        return {'passed': all([none_ok, repeat_current, cancel, failed, folder_ok, file_ran, folder_ran, post_ok]),
                'postExactlyOnceFromSourceCwd': post_ok, 'noDialogEmptyOutputTwice': none_ok,
                'noDialogRepeatCurrentSnapshot': repeat_current, 'saveCancelKeepsOld': cancel,
                'commandFailureKeepsOld': failed, 'folderRollbackKeepsAllOld': folder_ok,
                'failureCommandsActuallyExecuted': file_ran and folder_ran}
    output_check('post-and-negative-cases', post_and_negative_proof)

    completed = set(result.get('completedStages') or [])
    checks = [c for c in result.get('checks', []) if not c.get('pending')]
    pending = [c for c in result.get('checks', []) if c.get('pending')]
    compile_ok = bool(evidence.get('compiler', {}).get('passed') and (evidence.get('adHocSignature') or {}).get('passed'))
    automatic = bool(matching and compile_ok and unchanged and all(unchanged.values()) and source_unchanged and all(source_unchanged.values())
                     and script_unchanged and set(REQUIRED_STAGES).issubset(completed) and result.get('restartVerified')
                     and result.get('automaticScopePassed') and checks and all(c.get('passed') is True for c in checks)
                     and all(item['passed'] for item in outputs.values()))
    manual_path = WORK / 'manual-probes.json'
    manual = json.loads(manual_path.read_text()) if manual_path.exists() else {}
    manual_results = {p.get('id'): p for p in manual.get('probes', []) if isinstance(p, dict)}
    manual_ok = manual.get('bundleIdentifier') == evidence.get('bundleIdentifier') and all(
        manual_results.get(name, {}).get('passed') is True and bool(manual_results.get(name, {}).get('evidence'))
        for name in ['focus', 'fonts', 'pdfGeometry'])
    result['unchangedRuntimeSources'] = unchanged
    result['unchangedFixtureSources'] = source_unchanged
    evidence.update(actualNative=result, independentOutputDecode=outputs, compiledChecks=compile_ok,
                    nativeUIChecks={'requiredStagesRan': set(REQUIRED_STAGES).issubset(completed), 'matchingBundle': matching},
                    automaticScopePassed=automatic, manualProbes=manual, manualProbesPassed=manual_ok,
                    passed=bool(automatic and manual_ok), fullParity=False, pendingProbes=[] if manual_ok else pending,
                    recordedManualRequirements=pending,
                    verifierScriptUnchanged=script_unchanged, cliFixtureBaseline='Separate CLI baseline; never used as App/UI proof')
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': evidence['passed'], 'automaticScopePassed': automatic, 'manualProbesPassed': manual_ok,
                      'completedStages': sorted(completed), 'failedChecks': [c for c in checks if c.get('passed') is not True],
                      'outputs': outputs, 'pending': [] if manual_ok else [c.get('name') for c in pending]}, ensure_ascii=False, indent=2))
    return 0 if evidence['passed'] else 1


def clean():
    evidence = json.loads(EVIDENCE.read_text())
    native = evidence.get('actualNative') or {}
    if not evidence.get('passed'):
        raise RuntimeError('Keep incomplete verifier material until actualNative passed')
    pid = native.get('pid')
    if pid:
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            pass
        else:
            raise RuntimeError('QA pid still alive; Close verifier first')
    if not native.get('domainCleaned'):
        raise RuntimeError('domain cleaned marker missing')
    shutil.rmtree(WORK)
    evidence['temporaryVerifierRemoved'] = True
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print('Removed .cache/export-settings-native-verifier')
    return 0


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--prepare', action='store_true')
    p.add_argument('--collect', action='store_true')
    p.add_argument('--clean', action='store_true')
    o = p.parse_args()
    if o.clean:
        sys.exit(clean())
    if o.collect:
        sys.exit(collect())
    sys.exit(prepare())
