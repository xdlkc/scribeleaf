#!/usr/bin/env python3
"""Prepare/collect a real editor + native repeat-export QA app.

The app loads an independent build of the production renderer and unmodified
native producers. Its Next button runs one scenario. Operate only this QA app's
save/warning sheets with native UI tools. Collect after PASS, close the verifier,
then --clean. No main app, original Typora, shared renderer, or user window is
touched. History stays in memory; the warning preference uses the QA app domain.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.cache/repeat-export-native'
APP = WORK / 'RepeatExportVerifier.app'
FIXTURE = WORK / 'fixture 中文 #100%'
EVIDENCE = ROOT / 'evidence/repeat-export-native-verification.json'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=')
PANDOC = ROOT / '.cache/pandoc/pandoc-3.12.1-x86_64/bin/pandoc'

RUNNER = r'''
import AppKit
import WebKit

@MainActor final class RepeatVerifier: NSObject, NSApplicationDelegate {
    let folder = Bundle.main.bundleURL.deletingLastPathComponent()
    var fixture: URL { folder.appendingPathComponent("fixture 中文 #100%", isDirectory: true) }
    let doc = MarkdownDocument()
    let menuOwner = AppDelegate()
    var inspector: NSWindow!
    var log: NSTextView!
    var next: NSButton!
    var checks: [[String: Any]] = []
    var panels: [[String: Any]] = []
    var step = -1
    var active = false
    var sawSheet = false
    var sawError = false
    var initialBytes: [String: Data] = [:]
    var previousBytes = Data()
    var expectedText = ""
    var deadline = Date.distantFuture
    let names = ["Initial export — Cancel", "Seed HTML — Save as chosen-output.html", "Previous — Cancel",
                 "Previous — Save as second-output.html", "Overwrite — Cancel", "Overwrite — check suppression, Continue",
                 "Overwrite — suppressed warning", "Switch document — Previous, Cancel", "Switched Previous — Save",
                 "Failed DOCX — Save, dismiss error", "Failed history — Previous, Cancel"]
    var primary: NSWindow { doc.windowControllers[0].window! }
    var sourceA: URL { fixture.appendingPathComponent("source-a.md") }
    var sourceB: URL { fixture.appendingPathComponent("source-b.md") }
    var chosen: URL { fixture.appendingPathComponent("chosen-output.html") }
    var second: URL { fixture.appendingPathComponent("second-output.html") }
    var switched: URL { fixture.appendingPathComponent("source-b.html") }
    var failed: URL { fixture.appendingPathComponent("source-b.docx") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        for source in [sourceA, sourceB] { initialBytes[source.path] = try? Data(contentsOf: source) }
        doc.fileURL = sourceA; doc.resourceOriginURL = sourceA
        doc.markdown = "# INITIAL_LOADED 中文\n"; doc.lastSavedMarkdown = doc.markdown
        NSDocumentController.shared.addDocument(doc)
        doc.makeWindowControllers(); doc.showWindows()
        doc.watchTimer?.invalidate(); doc.watchTimer = nil
        menuOwner.buildMenu()
        inspector = NSWindow(contentRect: NSRect(x: 30, y: 90, width: 800, height: 540), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        inspector.isReleasedWhenClosed = false; inspector.title = "Repeat export verifier — loading real editor"
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 540))
        let scroll = NSScrollView(frame: NSRect(x: 20, y: 75, width: 760, height: 440)); scroll.hasVerticalScroller = true
        log = NSTextView(frame: scroll.bounds); log.font = .monospacedSystemFont(ofSize: 11, weight: .regular); log.isEditable = false
        scroll.documentView = log; content.addSubview(scroll)
        next = NSButton(title: "Loading real renderer…", target: self, action: #selector(advance))
        next.frame = NSRect(x: 20, y: 20, width: 560, height: 35); next.isEnabled = false; content.addSubview(next)
        let close = NSButton(title: "Close verifier", target: self, action: #selector(closeVerifier))
        close.frame = NSRect(x: 610, y: 20, width: 170, height: 35); content.addSubview(close)
        inspector.contentView = content; inspector.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        append("Real production editor + native menu actions + NSSavePanel/overwrite warning.\n")
        Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.poll() } }
        write("loading")
    }

    func append(_ value: String) { log.string += value; log.scrollToEndOfDocument(nil) }
    func record(_ name: String, _ passed: Bool, _ detail: [String: Any] = [:]) {
        checks.append(["name": name, "passed": passed, "detail": detail]); append("\(passed ? "PASS" : "FAIL") \(name)\n")
    }
    func find(_ title: String) -> NSMenuItem? { find(title, in: NSApp.mainMenu) }
    func find(_ title: String, in menu: NSMenu?) -> NSMenuItem? {
        for item in menu?.items ?? [] {
            if item.title == localizedMenuTitle(title) { return item }
            if let found = find(title, in: item.submenu) { return found }
        }; return nil
    }
    func enabled(_ overwrite: Bool) -> Bool {
        guard let item = find(overwrite ? "Export and Overwrite with Previous" : "Export with Previous") else { return false }
        return menuOwner.validateMenuItem(item)
    }
    func invokePrevious(_ overwrite: Bool) {
        primary.makeKeyAndOrderFront(nil)
        guard let item = find(overwrite ? "Export and Overwrite with Previous" : "Export with Previous") else {
            record("Repeat menu exists", false); return
        }
        menuOwner.action(item)
    }
    func js(_ code: String, _ arguments: [String: Any] = [:]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            doc.web.callAsyncJavaScript(code, arguments: arguments, in: nil, in: .page) { continuation.resume(with: $0) }
        }
    }
    func setText(_ text: String) async throws {
        let _ = try await js("const v=window.typora.editor;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text}});return window.typora.getMarkdown();", ["text": text])
        let until = Date().addingTimeInterval(4)
        while doc.markdown != text && Date() < until { try await Task.sleep(nanoseconds: 30_000_000) }
        // Avoid test-only recovery files in the user profile. Export state itself
        // remains production state, and unsaved content stays dirty in memory.
        doc.recoveryTask?.cancel(); doc.recoveryTask = nil
        if doc.markdown != text { throw NSError(domain: "RepeatVerifier", code: 1, userInfo: [NSLocalizedDescriptionKey: "Editor change did not arrive at the native document"] ) }
    }
    @objc func advance() {
        guard !active else { return }
        step += 1
        guard step < names.count else { return }
        next.isEnabled = false; active = true; sawSheet = false; sawError = false; deadline = Date().addingTimeInterval(100)
        append("\n\(step + 1)/\(names.count) \(names[step])\n"); inspector.title = "Repeat export — " + names[step]
        Task {
            do {
                if step == 7 {
                    doc.fileURL = sourceB; doc.resourceOriginURL = sourceB
                    doc.markdown = "# SWITCHED_LOADED 中文\n"; doc.lastSavedMarkdown = doc.markdown
                    doc.loadRenderer()
                    try await Task.sleep(nanoseconds: 150_000_000)
                    primary.makeKeyAndOrderFront(nil)
                    record("Switch keeps repeat format but disables direct overwrite", enabled(false) && !enabled(true))
                }
                expectedText = step == 9 ? "---\ntitle: [unterminated\n---\n\n# FAILED_SNAPSHOT 中文\n" : "# REPEAT_STEP_\(step) 中文标题\n\nUNSAVED_CURRENT_STEP_\(step) 正文。\n\n![资源](asset%20%E5%9B%BE%20%23%25.png)\n"
                try await setText(expectedText)
                previousBytes = (try? Data(contentsOf: step >= 8 ? switched : step >= 3 ? second : chosen)) ?? Data()
                primary.makeKeyAndOrderFront(nil)
                if step == 0 || step == 1 { doc.send("export", "html-plain") }
                else if step == 9 { doc.send("export", "docx") }
                else { invokePrevious([4, 5, 6].contains(step)) }
                write("waiting-for-native-interaction")
            } catch { record("Current editor snapshot dispatch", false, ["error": error.localizedDescription]); finishStep() }
        }
    }
    func data(_ target: URL) -> Data { (try? Data(contentsOf: target)) ?? Data() }
    func containsStep(_ target: URL) -> Bool { String(decoding: data(target), as: UTF8.self).contains("UNSAVED_CURRENT_STEP_\(step)") }
    func poll() {
        if !booted && step == -1 && doc.ready {
            step = -2
            primary.makeKeyAndOrderFront(nil)
            record("No history disables both native repeat menu items", !enabled(false) && !enabled(true))
            if let previous = find("Export with Previous"), let overwrite = find("Export and Overwrite with Previous") {
                record("Captured repeat shortcut is Control+Command+E; overwrite has none", previous.keyEquivalent.lowercased() == "e" && previous.keyEquivalentModifierMask == [.command, .control] && overwrite.keyEquivalent.isEmpty)
            } else { record("Repeat menu items built", false) }
            step = -1; next.title = names[0]; next.isEnabled = true
            inspector.title = "Repeat export verifier — READY"; inspector.makeKeyAndOrderFront(nil); write("ready")
            // Mark boot observed once, without changing the next step index.
            booted = true
            return
        }
        guard active else { return }
        if let sheet = primary.attachedSheet {
            if !sawSheet {
                sawSheet = true
                if let panel = sheet as? NSSavePanel {
                    panels.append(["step": step, "kind": "save", "name": panel.nameFieldStringValue, "directory": panel.directoryURL?.path ?? ""])
                    let expectedName = [0: "source-a.html", 1: "source-a.html", 2: "chosen-output.html", 3: "chosen-output.html", 7: "source-b.html", 8: "source-b.html", 9: "source-b.docx", 10: "source-b.docx"][step]
                    if let expectedName { record("Step \(step): save panel default name and last directory", panel.nameFieldStringValue == expectedName && panel.directoryURL?.standardizedFileURL == fixture.standardizedFileURL, ["actualName": panel.nameFieldStringValue, "expectedName": expectedName]) }
                } else { panels.append(["step": step, "kind": "alert", "title": sheet.title]) }
                write("native-sheet-visible")
            }
            if step == 9 && !(sheet is NSSavePanel) && doc.conversionTasks.isEmpty { sawError = true }
        }
        if [0, 2, 4, 7, 10].contains(step) && sawSheet && primary.attachedSheet == nil && doc.conversionTasks.isEmpty {
            if step == 0 { record("Initial Save Cancel does not create history", !enabled(false) && !enabled(true) && !FileManager.default.fileExists(atPath: fixture.appendingPathComponent("source-a.html").path)) }
            if step == 2 { record("Previous Save Cancel preserves accepted export bytes/history", data(chosen) == previousBytes && enabled(false) && enabled(true)) }
            if step == 4 { record("Overwrite warning Cancel preserves export bytes/history", data(second) == previousBytes && enabled(false) && enabled(true)) }
            if step == 7 { record("Switched Previous Cancel retains disabled overwrite", data(second) == previousBytes && enabled(false) && !enabled(true)) }
            if step == 10 { record("Failed export history survives Previous Cancel", enabled(false) && enabled(true) && !FileManager.default.fileExists(atPath: failed.path)) }
            finishStep(); return
        }
        if [1, 3, 5, 6, 8].contains(step) {
            let target = step == 1 ? chosen : step == 8 ? switched : second
            if containsStep(target) && doc.conversionTasks.isEmpty && primary.attachedSheet == nil {
                record("Step \(step): real renderer exports current unsaved content", true, ["path": target.path, "bytes": data(target).count])
                record("Step \(step): confirmed destination enables both repeat menus", enabled(false) && enabled(true))
                if step == 6 { record("App-domain suppression skips overwrite warning/save panel", !sawSheet) }
                if step == 5 { record("Direct overwrite uses confirmation without NSSavePanel", !panels.contains { $0["step"] as? Int == step && $0["kind"] as? String == "save" }) }
                finishStep(); return
            }
        }
        if step == 9 && sawError && primary.attachedSheet == nil && doc.conversionTasks.isEmpty {
            record("Accepted destination remains repeatable after real Pandoc failure", enabled(false) && enabled(true) && !FileManager.default.fileExists(atPath: failed.path))
            finishStep(); return
        }
        if Date() > deadline { record("Step \(step): native interaction/completion deadline", false); finishStep() }
    }
    var booted = false
    func finishStep() {
        active = false
        record("Step \(step): source files and document identity preserved", initialBytes.allSatisfy { data(URL(fileURLWithPath: $0.key)) == $0.value } && doc.fileURL == (step >= 7 ? sourceB : sourceA))
        record("Step \(step): export leaves current unsaved editor text unchanged", doc.markdown == expectedText && doc.isDocumentEdited)
        if step + 1 < names.count { next.title = names[step + 1]; next.isEnabled = true; inspector.title = "Repeat export — \(step + 1)/\(names.count) done"; write("in-progress") }
        else {
            let ok = checks.allSatisfy { $0["passed"] as? Bool == true }
            inspector.title = "\(ok ? "PASS" : "FAIL") repeat export \(checks.filter { $0["passed"] as? Bool == true }.count)/\(checks.count)"
            next.title = "All checks finished"; append("\n\(inspector.title)\n"); write(ok ? "passed" : "failed")
        }
        inspector.makeKeyAndOrderFront(nil)
    }
    func write(_ status: String) {
        let result: [String: Any] = ["status": status, "step": step, "checks": checks, "panels": panels,
            "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "pid": ProcessInfo.processInfo.processIdentifier,
            "fixture": fixture.path, "actualProductionRenderer": true, "actualProductionNative": true,
            "historyPersistence": "in-memory only", "warningPreferenceScope": "unique QA app domain"]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: folder.appendingPathComponent("result.json"), options: .atomic) }
    }
    @objc func closeVerifier() {
        doc.recoveryTask?.cancel(); doc.recoveryTask = nil
        doc.close()
        if let id = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: id) }
        let ownSupport = Recovery.folder.deletingLastPathComponent()
        if ownSupport.lastPathComponent == Bundle.main.bundleIdentifier { try? FileManager.default.removeItem(at: ownSupport) }
        inspector.title = "Closing repeat export verifier"
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { NSApp.terminate(nil) }
    }
}
@main struct RunRepeatVerifier {
    @MainActor static func main() {
        let app = NSApplication.shared; let delegate = RepeatVerifier(); app.delegate = delegate; app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare():
    WORK.mkdir(parents=True, exist_ok=True)
    FIXTURE.mkdir(exist_ok=True)
    (WORK / 'result.json').unlink(missing_ok=True)
    sources = WORK / 'Sources'; sources.mkdir(exist_ok=True)
    hashes = {}
    for original in sorted((ROOT / 'native').glob('*.swift')):
        content = original.read_bytes(); hashes['native/' + original.name] = hashlib.sha256(content).hexdigest()
        if original.name == 'App.swift':
            marker = b'@main\nstruct TyporaReplicaApplication'
            assert content.count(marker) == 1
            content = content.split(marker)[0]
        (sources / original.name).write_bytes(content)
    for original in [*sorted((ROOT / 'src').rglob('*.ts')), *sorted((ROOT / 'src').rglob('*.css'))]:
        hashes[str(original.relative_to(ROOT))] = digest(original)
    (sources / 'Runner.swift').write_text(RUNNER)
    for name in ('source-a.md', 'source-b.md'):
        (FIXTURE / name).write_text('# SOURCE_DISK_ONLY ' + name + ' 中文原稿\n', encoding='utf-8')
    (FIXTURE / 'asset 图 #%.png').write_bytes(PNG)
    for name in ('source-a.html', 'chosen-output.html', 'second-output.html', 'source-b.html', 'source-b.docx'):
        (FIXTURE / name).unlink(missing_ok=True)
    resources = APP / 'Contents/Resources'; resources.mkdir(parents=True, exist_ok=True)
    renderer = WORK / 'renderer'
    built = subprocess.run(['npm', 'run', 'build', '--', '--outDir', str(renderer)], cwd=ROOT, capture_output=True, text=True, timeout=120)
    if built.returncode:
        raise RuntimeError(built.stderr[-2000:])
    shutil.copytree(renderer, resources / 'editor', dirs_exist_ok=True)
    converters = resources / 'Converters'; converters.mkdir(exist_ok=True); shutil.copy2(PANDOC, converters / 'pandoc')
    executable = APP / 'Contents/MacOS/RepeatExportVerifier'; executable.parent.mkdir(parents=True, exist_ok=True)
    identifier = 'com.openai.typora-replica.repeat-export-verifier.' + uuid.uuid4().hex
    (APP / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable': 'RepeatExportVerifier', 'CFBundleIdentifier': identifier,
        'CFBundleName': 'Repeat Export Verifier', 'CFBundlePackageType': 'APPL', 'NSPrincipalClass': 'NSApplication',
        'NSHighResolutionCapable': True, 'LSMinimumSystemVersion': '13.0'}))
    compiler = subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', '-target', platform.machine() + '-apple-macosx13.0',
        '-module-cache-path', str(ROOT / '.cache/swift'), *map(str, sorted(sources.glob('*.swift'))), '-o', str(executable),
        '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers'], cwd=ROOT, capture_output=True, text=True, timeout=90)
    signature = None
    if compiler.returncode == 0:
        signed = subprocess.run(['codesign', '--force', '--sign', '-', str(APP)], capture_output=True, text=True, timeout=30)
        signature = {'passed': signed.returncode == 0, 'diagnostics': signed.stderr.strip()}
    evidence = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'bundleIdentifier': identifier,
        'verifierBundle': str(APP), 'compiler': {'passed': compiler.returncode == 0, 'target': 'macOS13 / Swift5', 'diagnostics': compiler.stderr.strip()},
        'rendererBuild': {'passed': built.returncode == 0, 'outputDirectory': str(renderer)}, 'adHocSignature': signature,
        'sourceSHA256': hashes, 'bundledPandocSHA256': digest(converters / 'pandoc'),
        'actualNative': {'status': 'not-yet-run'}, 'scope': 'Real production renderer/native repeat export; own app/UI only'}
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'); print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0 if compiler.returncode == 0 and signature and signature['passed'] else 1


def collect():
    evidence = json.loads(EVIDENCE.read_text()); result_file = WORK / 'result.json'
    if not result_file.exists():
        evidence['actualNative'] = {'status': 'not-run', 'reason': 'No native app result; no UI verification claimed'}
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'); return 1
    result = json.loads(result_file.read_text()); assert result['bundleIdentifier'] == evidence['bundleIdentifier']
    result['unchangedSources'] = {name: digest(ROOT / name) == sha for name, sha in evidence['sourceSHA256'].items()}
    formats = {}
    for name in ('chosen-output.html', 'second-output.html', 'source-b.html'):
        path = FIXTURE / name
        text = path.read_text(encoding='utf-8') if path.exists() else ''
        formats[name] = {'bytes': path.stat().st_size if path.exists() else 0,
                         'html': text.startswith('<!DOCTYPE html>') or text.startswith('<!doctype html>'),
                         'embeddedPNG': ('data:image/png;base64,' + base64.b64encode(PNG).decode()) in text,
                         'noSourceDiskText': 'SOURCE_DISK_ONLY' not in text,
                         'latestStep': 1 if name.startswith('chosen') else 6 if name.startswith('second') else 8}
        formats[name]['latestUnsavedSnapshot'] = f'UNSAVED_CURRENT_STEP_{formats[name]["latestStep"]}' in text
        formats[name]['passed'] = all(formats[name][k] for k in ('html', 'embeddedPNG', 'noSourceDiskText', 'latestUnsavedSnapshot'))
    result['independentOutputDecode'] = formats
    evidence['actualNative'] = result
    evidence['passed'] = result['status'] == 'passed' and all(result['unchangedSources'].values()) and all(i['passed'] for i in formats.values())
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': evidence['passed'], 'status': result['status'], 'checks': len(result['checks']), 'failedChecks': [i for i in result['checks'] if not i['passed']], 'formats': formats}, ensure_ascii=False, indent=2))
    return 0 if evidence['passed'] else 1


def clean():
    evidence = json.loads(EVIDENCE.read_text()); assert evidence.get('passed'), 'Keep incomplete verifier material'
    try: os.kill(evidence['actualNative']['pid'], 0)
    except ProcessLookupError: pass
    else: raise RuntimeError('Close the QA app with its own button first')
    shutil.rmtree(WORK); evidence['temporaryVerifierRemoved'] = True
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'); print('Removed completed repeat export verifier materials.'); return 0


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--collect', action='store_true'); p.add_argument('--clean', action='store_true'); o = p.parse_args()
    sys.exit(clean() if o.clean else collect() if o.collect else prepare())
