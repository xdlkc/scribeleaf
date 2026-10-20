#!/usr/bin/env python3
"""Build a native verifier for MarkdownDocument.exportDocument's real save sheet.

Prepare with this script, then launch its own NativeExportVerifier.app through
the native UI. Click Export Word, Export EPUB and Export HTML plain, saving
each default filename in the displayed fixture folder. Run --collect after
the PASS window appears. No producer source, user settings or global install
is changed. --collect keeps the app until its Close verifier button is used;
--clean removes this task's cache once its process has exited.
"""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.cache/native-export-bridge-verifier'
APP = WORK / 'NativeExportVerifier.app'
FIXTURE = WORK / 'fixture 中文 #100%'
EVIDENCE = ROOT / 'evidence/native-export-bridge-verification.json'
PANDOC = ROOT / '.cache/pandoc/pandoc-3.12.1-x86_64/bin/pandoc'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=')

RUNNER = r'''
import AppKit
import WebKit

@MainActor final class NativeExportVerifier: NSObject, NSApplicationDelegate {
    let folder = Bundle.main.bundleURL.deletingLastPathComponent()
    var fixture: URL { folder.appendingPathComponent("fixture 中文 #100%", isDirectory: true) }
    var source: URL { fixture.appendingPathComponent("bridge-fixture.md") }
    var window: NSWindow!
    var log: NSTextView!
    var doc = MarkdownDocument()
    var buttons: [NSButton] = []
    var checks: [[String: Any]] = []
    var exports: [[String: Any]] = []
    var active: String?
    var deadline = Date.distantFuture
    var sourceBytes = Data()
    var pngBytes = Data()
    var currentMemory = ""
    let savedMemory = "SAVED_MEMORY_STATE 中文"
    let bom = Data([0xff, 0xfe])

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 150, y: 140, width: 820, height: 540),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Native export bridge — READY"
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 820, height: 540))
        let scroll = NSScrollView(frame: NSRect(x: 20, y: 80, width: 780, height: 440))
        scroll.hasVerticalScroller = true
        log = NSTextView(frame: scroll.bounds)
        log.isEditable = false
        log.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        scroll.documentView = log; content.addSubview(scroll)
        for (i, title) in ["Export Word", "Export EPUB", "Export HTML plain"].enumerated() {
            let button = NSButton(title: title, target: self, action: #selector(exportPressed(_:)))
            button.tag = i; button.frame = NSRect(x: 20 + i * 190, y: 20, width: 180, height: 34)
            content.addSubview(button); buttons.append(button)
        }
        let close = NSButton(title: "Close verifier", target: self, action: #selector(closeVerifier))
        close.frame = NSRect(x: 640, y: 20, width: 160, height: 34); content.addSubview(close)
        window.contentView = content
        doc.addWindowController(NSWindowController(window: window))
        // Do not call makeWindowControllers: this test isolates the production
        // save sheet and Task path without starting another renderer or recovery.
        doc.fileURL = source
        doc.resourceOriginURL = source
        doc.folder = fixture
        doc.textEncoding = .utf16LittleEndian; doc.byteOrderMark = bom
        doc.lastSavedMarkdown = savedMemory
        currentMemory = "LIVE_MEMORY_BEFORE_EXPORT 中文"
        doc.markdown = currentMemory
        doc.ready = false
        doc.updateChangeCount(.changeDone)
        sourceBytes = (try? Data(contentsOf: source)) ?? Data()
        pngBytes = (try? Data(contentsOf: fixture.appendingPathComponent("asset 图 #%.png"))) ?? Data()
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        append("Real production NSSavePanel → MarkdownDocument Task → exportFinished.\n")
        append("Save each default filename in fixture 中文 #100%.\n")
        append("The export snapshot differs from both source disk and later editor memory.\n\n")
        record("Bundled verified Pandoc discovered by production preflight", (try? DocumentConverter.executableURL())?.path == Bundle.main.resourceURL?.appendingPathComponent("Converters/pandoc").path)
        record("Fixture image decoded by AppKit", NSImage(data: pngBytes) != nil)
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        writeResult(status: "ready")
    }

    func append(_ text: String) { log.string += text; log.scrollToEndOfDocument(nil) }
    func record(_ name: String, _ passed: Bool, _ detail: [String: Any] = [:]) {
        checks.append(["name": name, "passed": passed, "detail": detail])
        append("\(passed ? "PASS" : "FAIL") \(name)\n")
    }
    @objc func exportPressed(_ sender: NSButton) {
        guard active == nil else { return }
        let format = ["docx", "epub", "html-plain"][sender.tag]
        guard !exports.contains(where: { $0["format"] as? String == format }) else { return }
        active = format; deadline = Date().addingTimeInterval(90)
        doc.pending.removeAll()
        let snapshot = "# BRIDGE_SNAPSHOT_\(format) 中文标题\n\nSNAPSHOT_ONLY 正文。\n\n![资源](asset%20%E5%9B%BE%20%23%25.png)\n"
        let html = "<!doctype html><html><head><meta charset=\"UTF-8\"><title>BRIDGE_SNAPSHOT_html-plain</title></head><body><h1>BRIDGE_SNAPSHOT_html-plain 中文标题</h1><p>SNAPSHOT_ONLY 正文。</p><img src=\"asset%20%E5%9B%BE%20%23%25.png\" alt=\"资源\"></body></html>"
        append("\nOpening production save sheet for \(format)…\n")
        buttons.forEach { $0.isEnabled = false }
        doc.exportDocument(format: format, html: html, markdownSnapshot: snapshot)
        // The value must be captured before the save sheet returns. A later
        // editor change must neither enter the export nor be overwritten by it.
        currentMemory = "LIVE_MEMORY_AFTER_REQUEST_\(format) 中文"
        doc.markdown = currentMemory
        window.title = "Native export bridge — save \(format)"
        writeResult(status: "waiting-for-native-save")
    }

    func poll() {
        guard let format = active else { return }
        guard let event = doc.pending.first(where: { $0.0 == "exportFinished" }) else {
            if Date() > deadline {
                record("\(format): production save/completion deadline", false)
                active = nil; window.title = "FAIL native export bridge — no completion"
                writeResult(status: "failed")
            }
            return
        }
        let ext = format == "html-plain" ? "html" : format
        let destination = fixture.appendingPathComponent("bridge-fixture." + ext)
        let bytes = (try? Data(contentsOf: destination)) ?? Data()
        let payload = event.1 as? [String: Any] ?? [:]
        record("\(format): exportFinished contains saved filename", payload["name"] as? String == destination.lastPathComponent)
        record("\(format): native save created complete file in source folder", !bytes.isEmpty && (format == "html-plain" || bytes.starts(with: [0x50, 0x4b])), ["path": destination.path, "bytes": bytes.count])
        record("\(format): Task removed before completion notification", doc.conversionTasks.isEmpty)
        let identity = doc.fileURL == source && doc.resourceOriginURL == source && doc.folder == fixture
        let state = doc.markdown == currentMemory && doc.lastSavedMarkdown == savedMemory && doc.textEncoding == .utf16LittleEndian
            && doc.byteOrderMark == bom && doc.isDocumentEdited && doc.ready == false
        record("\(format): source identity and later unsaved editor state preserved", identity && state)
        record("\(format): original UTF-8 Markdown and PNG bytes unchanged", (try? Data(contentsOf: source)) == sourceBytes && (try? Data(contentsOf: fixture.appendingPathComponent("asset 图 #%.png"))) == pngBytes)
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: fixture.path)) ?? []
        record("\(format): atomic export staging removed", !entries.contains(where: { $0.hasPrefix(".typora-conversion-") || $0.hasPrefix(".typora-image-") }))
        exports.append(["format": format, "path": destination.path, "snapshotMarker": "BRIDGE_SNAPSHOT_" + format,
                        "notification": payload, "bytes": bytes.count])
        active = nil
        for (i, button) in buttons.enumerated() {
            button.isEnabled = !exports.contains(where: { $0["format"] as? String == ["docx", "epub", "html-plain"][i] })
        }
        let passed = checks.allSatisfy { $0["passed"] as? Bool == true }
        if exports.count == 3 {
            window.title = "\(passed ? "PASS" : "FAIL") native export bridge \(checks.filter { $0["passed"] as? Bool == true }.count)/\(checks.count)"
            append("\n\(window.title)\n")
            writeResult(status: passed ? "passed" : "failed")
        } else {
            window.title = "Native export bridge — \(exports.count)/3 saved"
            writeResult(status: "in-progress")
        }
    }

    func writeResult(status: String) {
        let result: [String: Any] = ["status": status, "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
            "checks": checks, "exports": exports, "source": source.path, "fixture": fixture.path,
            "sourceDiskUTF8": String(decoding: sourceBytes, as: UTF8.self), "producer": "unmodified production MarkdownDocument.exportDocument",
            "rendererStarted": false, "savePanel": "real NSSavePanel with visible user-driven Save", "pid": ProcessInfo.processInfo.processIdentifier]
        do {
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: folder.appendingPathComponent("result.json"), options: .atomic)
        } catch { append("FAIL result JSON: \(error.localizedDescription)\n") }
    }
    @objc func closeVerifier() {
        window.title = "Closing native export verifier"
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { NSApp.terminate(nil) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main struct RunNativeExportVerifier {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = NativeExportVerifier()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
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
    sources = WORK / 'Sources'
    sources.mkdir(exist_ok=True)
    hashes = {}
    for original in sorted((ROOT / 'native').glob('*.swift')):
        content = original.read_bytes()
        hashes[original.name] = hashlib.sha256(content).hexdigest()
        if original.name == 'App.swift':
            marker = b'@main\nstruct TyporaReplicaApplication'
            if content.count(marker) != 1:
                raise RuntimeError('Production @main marker changed; refuse to alter or guess the source boundary.')
            content = content.split(marker)[0]
        (sources / original.name).write_bytes(content)
    (sources / 'Runner.swift').write_text(RUNNER)
    (FIXTURE / 'bridge-fixture.md').write_text('# SOURCE_DISK_ONLY 中文原稿\n\nDo not export this stale disk snapshot.\n', encoding='utf-8')
    (FIXTURE / 'asset 图 #%.png').write_bytes(PNG)
    for ext in ('docx', 'epub', 'html'):
        (FIXTURE / ('bridge-fixture.' + ext)).unlink(missing_ok=True)
    resources = APP / 'Contents/Resources/Converters'
    resources.mkdir(parents=True, exist_ok=True)
    if not PANDOC.is_file():
        raise RuntimeError(f'Previously verified project-local Pandoc is missing: {PANDOC}')
    shutil.copy2(PANDOC, resources / 'pandoc')
    executable = APP / 'Contents/MacOS/NativeExportVerifier'
    executable.parent.mkdir(parents=True, exist_ok=True)
    identifier = 'com.openai.typora-replica.native-export-bridge-verifier.' + uuid.uuid4().hex
    info = {'CFBundleExecutable': 'NativeExportVerifier', 'CFBundleIdentifier': identifier,
            'CFBundleName': 'Native Export Verifier', 'CFBundlePackageType': 'APPL',
            'NSHighResolutionCapable': True, 'LSMinimumSystemVersion': '13.0', 'NSPrincipalClass': 'NSApplication'}
    (APP / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    command = ['xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', '-target',
               platform.machine() + '-apple-macosx13.0', '-module-cache-path', str(ROOT / '.cache/swift'),
               *[str(p) for p in sorted(sources.glob('*.swift'))], '-o', str(executable),
               '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers']
    compiler = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=90)
    signature = None
    if compiler.returncode == 0:
        signed = subprocess.run(['codesign', '--force', '--sign', '-', str(APP)], capture_output=True, text=True, timeout=30)
        signature = {'passed': signed.returncode == 0, 'diagnostics': signed.stderr.strip()}
    evidence = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'Real production native save sheet, snapshot/Task/completion path; three representative export producers',
        'compiler': {'passed': compiler.returncode == 0, 'target': 'macOS 13 / Swift 5', 'diagnostics': compiler.stderr.strip()},
        'adHocSignature': signature, 'verifierBundle': str(APP), 'bundleIdentifier': identifier,
        'productionSourceSHA256': hashes, 'bundledPandocSHA256': digest(resources / 'pandoc'),
        'fixtureSourceSHA256': digest(FIXTURE / 'bridge-fixture.md'), 'fixturePNG_SHA256': digest(FIXTURE / 'asset 图 #%.png'),
        'actualNativeBridge': {'status': 'not-yet-run'},
        'launchMethod': 'Native computer-use tools; Finder may open the exact QA app bundle. No shell GUI launch or permission change.'}
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0 if compiler.returncode == 0 and signature and signature['passed'] else 1


def collect():
    evidence = json.loads(EVIDENCE.read_text())
    result_path = WORK / 'result.json'
    if not result_path.exists():
        evidence['actualNativeBridge'] = {'status': 'blocked', 'reason': 'The QA app has not produced result.json. Native save interaction is unverified.'}
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(evidence['actualNativeBridge'], ensure_ascii=False)); return 1
    result = json.loads(result_path.read_text())
    if result['bundleIdentifier'] != evidence['bundleIdentifier']:
        raise RuntimeError('The native result belongs to another QA bundle build.')
    decoded = []
    for item in result['exports']:
        path, fmt = Path(item['path']), item['format']
        detail = {'format': fmt, 'path': str(path), 'bytes': path.stat().st_size, 'sha256': digest(path)}
        marker = item['snapshotMarker']
        if fmt in ('docx', 'epub'):
            with zipfile.ZipFile(path) as archive:
                entries = archive.namelist()
                text_entries = ['word/document.xml'] if fmt == 'docx' else [n for n in entries if n.endswith(('.html', '.xhtml'))]
                text = '\n'.join(archive.read(n).decode('utf-8') for n in text_entries)
                images = [n for n in entries if n.endswith('.png')]
                png_matches = [n for n in images if archive.read(n) == PNG]
                for name in entries:
                    if name.endswith(('.xml', '.xhtml', '.opf', '.ncx')):
                        ET.fromstring(archive.read(name))
                detail.update(snapshotMarker=marker in text, snapshotBody='SNAPSHOT_ONLY' in text and '中文标题' in text,
                              noStaleMemory=not any(s in text for s in ('SOURCE_DISK_ONLY', 'LIVE_MEMORY_')),
                              exactPNG=bool(png_matches), archiveEntries=entries)
                if fmt == 'epub':
                    detail['epubMimetype'] = archive.read('mimetype') == b'application/epub+zip'
        elif fmt == 'html-plain':
            text = path.read_text(encoding='utf-8')
            data_uri = 'data:image/png;base64,' + base64.b64encode(PNG).decode('ascii')
            detail.update(snapshotMarker=marker in text, snapshotBody='SNAPSHOT_ONLY' in text and '中文标题' in text,
                          noStaleMemory=not any(s in text for s in ('SOURCE_DISK_ONLY', 'LIVE_MEMORY_')),
                          exactPNG=data_uri in text, plainHTML='<style' not in text and 'stylesheet' not in text)
        passed_keys = ['snapshotMarker', 'snapshotBody', 'noStaleMemory', 'exactPNG']
        if fmt == 'epub': passed_keys.append('epubMimetype')
        if fmt == 'html-plain': passed_keys.append('plainHTML')
        detail['passed'] = all(detail[k] for k in passed_keys)
        decoded.append(detail)
    unchanged = {name: digest(ROOT / 'native' / name) == sha for name, sha in evidence['productionSourceSHA256'].items()}
    source_unchanged = digest(FIXTURE / 'bridge-fixture.md') == evidence['fixtureSourceSHA256']
    image_unchanged = digest(FIXTURE / 'asset 图 #%.png') == evidence['fixturePNG_SHA256']
    passed = result['status'] == 'passed' and len(decoded) == 3 and all(i['passed'] for i in decoded) and source_unchanged and image_unchanged
    result.update(status='passed' if passed else result['status'] if len(decoded) < 3 else 'failed',
                  independentFormatDecode=decoded, fixtureSourceUnchanged=source_unchanged,
                  fixturePNGUnchanged=image_unchanged, productionSourceUnchangedSinceBuild=unchanged)
    evidence['actualNativeBridge'] = result
    evidence['productionSourceCurrentMatchesVerifiedCopy'] = all(unchanged.values())
    evidence['passed'] = passed and all(unchanged.values())
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': evidence['passed'], 'nativeStatus': result['status'], 'checks': len(result['checks']),
                      'formats': [{k: v for k, v in i.items() if k not in ('archiveEntries',)} for i in decoded]}, ensure_ascii=False, indent=2))
    return 0 if evidence['passed'] else 1


def clean():
    evidence = json.loads(EVIDENCE.read_text())
    if not evidence.get('passed'):
        raise RuntimeError('Keep incomplete QA materials for further native verification.')
    pid = evidence['actualNativeBridge']['pid']
    import os
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise RuntimeError('Close this verifier with its own button before removing its app bundle.')
    shutil.rmtree(WORK)
    evidence['temporaryVerifierRemoved'] = True
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print('Removed completed native export bridge QA app and fixtures.')
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collect', action='store_true')
    parser.add_argument('--clean', action='store_true')
    options = parser.parse_args()
    sys.exit(clean() if options.clean else collect() if options.collect else prepare())
