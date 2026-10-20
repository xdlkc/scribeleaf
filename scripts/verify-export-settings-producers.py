#!/usr/bin/env python3
"""Three real App.performExport consumers, with no windows or save panels."""
import datetime
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.cache/export-settings-producers'
EVIDENCE = ROOT / 'evidence/export-settings-producers-verification.json'
PANDOC = ROOT / '.cache/pandoc/pandoc-3.12.1-x86_64/bin/pandoc'
PANDOC_SHA = '287e725a56ed196e1820d25acaecc48b769f9489221bd86ad2d44932e98e9af7'

RUNNER = r'''
import AppKit
import Foundation
import Darwin

enum ProducerErrors { static var messages: [String] = [] }

@MainActor final class ProducerProbe {
    let folder: URL
    let pandoc: URL
    let doc = MarkdownDocument()
    var cases: [[String: Any]] = []
    init(folder: URL, pandoc: URL) { self.folder = folder; self.pandoc = pandoc }
    func runCase(_ name: String, snapshot: String, format: String, conversion: DocumentConversionFormat?, options: [String: Any]) async throws {
        let source = folder.appendingPathComponent("source.md")
        let target = folder.appendingPathComponent(name)
        doc.fileURL = source
        doc.resourceOriginURL = source
        doc.markdown = "# EDITOR_IDENTITY_ONLY 中文\n"
        doc.lastSavedMarkdown = doc.markdown
        let identity = doc.documentIdentityKey()
        doc.pending.removeAll()
        let frozen: [String: Any] = ["key": format, "type": format, "name": name,
            "pandocPath": pandoc.path, "general": ["exportFolder": "", "customExportPath": "", "openExportLocation": false], "options": options]
        // Real production method owns every flag and the conversion dispatch.
        doc.performExport(format: format, html: "", snapshot: snapshot, destination: target,
                          sourceURL: source, conversionFormat: conversion, options: options, frozen: frozen, requestIdentity: identity)
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if !ProducerErrors.messages.isEmpty { throw NSError(domain: "ProducerProbe", code: 1, userInfo: [NSLocalizedDescriptionKey: ProducerErrors.messages.joined(separator: "\n")]) }
            let finished = doc.pending.contains { $0.0 == "exportFinished" }
            if finished && doc.conversionTasks.isEmpty && FileManager.default.fileExists(atPath: target.path) {
                cases.append(["name": name, "snapshot": snapshot, "options": options, "target": target.path,
                    "sourceIdentityPreserved": identity == doc.documentIdentityKey() && doc.fileURL == source,
                    "editorTextPreserved": doc.markdown == "# EDITOR_IDENTITY_ONLY 中文\n",
                    "readyWasFalse": !doc.ready, "pendingCommands": doc.pending.map { $0.0 }, "tasksEmpty": doc.conversionTasks.isEmpty])
                return
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw NSError(domain: "ProducerProbe", code: 2, userInfo: [NSLocalizedDescriptionKey: "Producer deadline waiting for task completion + pending exportFinished: \(name)"])
    }
    func run() async {
        var passed = false
        var failureDetail: String?
        do {
            let epub = "---\ntitle: QA_PRODUCER\n---\n\n# QA_PRODUCER_H1 中文\n\n## QA_PRODUCER_H2\n\n### QA_PRODUCER_H3\n\nCURRENT_EPUB_SNAPSHOT 中文\n"
            try await runCase("override.epub", snapshot: epub, format: "epub", conversion: .epub,
                options: ["type": "epub", "toc-depth": 1, "extraArguments": "--toc-depth=2"])
            let words = (1...60).map { String(format: "word%02d", $0) }.joined(separator: " ")
            let markdown = "# QA_MARKDOWN_CURRENT\n\n" + words + "\n\n中文 é\n\n[qa-link](https://example.invalid/fixture)\n"
            try await runCase("override.md", snapshot: markdown, format: "markdown", conversion: nil,
                options: ["type": "markdown", "variants": "markdown", "hardLineWrap": true, "columns": 130,
                          "eol": "crlf", "ascii": true, "reference-links": true, "reference-location": "block", "markdown-headings": "atx",
                          "extraArguments": "--columns=40"])
            let autoHTML = "---\ntitle: QA_AUTO_HTML\n---\n\n# QA_AUTO_DETECT_HTML 中文\n\nCURRENT_AUTO_SNAPSHOT 中文\n"
            try await runCase("auto.html", snapshot: autoHTML, format: "pandoc", conversion: nil,
                options: ["type": "pandoc", "targetFormat": "", "extraArguments": ""])
            passed = true
        } catch { failureDetail = error.localizedDescription }
        let result: [String: Any] = ["completed": passed, "error": failureDetail as Any? ?? NSNull(), "cases": cases,
            "errors": ProducerErrors.messages, "visibleWindows": NSApp.windows.filter { $0.isVisible }.count,
            "pid": ProcessInfo.processInfo.processIdentifier]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: folder.appendingPathComponent("result.json"), options: .atomic)
        }
        exit(passed ? 0 : 1)
    }
}

@main enum Main {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
        let probe = ProducerProbe(folder: URL(fileURLWithPath: CommandLine.arguments[1]), pandoc: URL(fileURLWithPath: CommandLine.arguments[2]))
        Task { await probe.run() }
        withExtendedLifetime(probe) { app.run() }
    }
}
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    sources = WORK / 'Sources'; sources.mkdir(exist_ok=True)
    for name in ['result.json', 'override.epub', 'override.md', 'auto.html']:
        (WORK / name).unlink(missing_ok=True)
    evidence = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed': False, 'checks': [],
                'scope': 'Real production MarkdownDocument.performExport directly builds flags and dispatches EPUB, generic Markdown, and automatic-writer HTML producers.',
                'limits': ['No renderer bridge, native save panel, request vault, history, custom command, visible window or original Typora parity claim.',
                           'Only QA App.swift annotation and showError display body differ; all producer code is retained verbatim.',
                           'Three cases only. Existing raw-format/strip-comments suite is not repeated.'],
                'bounds': {'cases': 3, 'producerSecondsPerCase': 30, 'processSeconds': 105}, 'nativeSourceSHA256': {}, 'copiedNativeSHA256': {}}
    try:
        if digest(PANDOC) != PANDOC_SHA: raise RuntimeError('Pinned Pandoc SHA256 mismatch')
        for path in sorted((ROOT / 'native').glob('*.swift')):
            raw = path.read_bytes(); evidence['nativeSourceSHA256'][path.name] = digest(path)
            if path.name == 'App.swift':
                original = raw.decode()
                if original.count('@main\n') != 1: raise ValueError('Unexpected App @main annotation count')
                modified = original.replace('@main\n', '', 1)
                replacement = 'func showError(_ error: Error, window: NSWindow? = nil) {\n    ProducerErrors.messages.append(error.localizedDescription)\n}'
                modified, count = re.subn(r'func showError\(_ error: Error, window: NSWindow\? = nil\) \{\n.*?\n\}', replacement, modified, count=1, flags=re.S)
                if count != 1: raise ValueError('Could not replace the error display layer')
                producer = lambda value: value[value.index('    func performExport('):value.index('\n    func renderForPrint(', value.index('    func performExport('))]
                evidence['performExportVerbatimSHA256'] = hashlib.sha256(producer(original).encode()).hexdigest()
                evidence['performExportBodyUnchanged'] = producer(original) == producer(modified)
                raw = modified.encode()
            (sources / path.name).write_bytes(raw)
            evidence['copiedNativeSHA256'][path.name] = hashlib.sha256(raw).hexdigest()
        evidence['otherNativeCopiesVerbatim'] = all(evidence['copiedNativeSHA256'][name] == sha for name, sha in evidence['nativeSourceSHA256'].items() if name != 'App.swift')
        (sources / 'Runner.swift').write_text(RUNNER)
        (WORK / 'source.md').write_text('# SOURCE_DISK_KEEP 中文\n')
        source_hash = digest(WORK / 'source.md')
        executable = WORK / 'producer-probe'
        compiler = subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', '-target', platform.machine() + '-apple-macosx13.0',
            '-module-cache-path', str(WORK / 'swift-module'), *map(str, sorted(sources.glob('*.swift'))), '-o', str(executable),
            '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'PDFKit', '-framework', 'UniformTypeIdentifiers'],
            cwd=ROOT, capture_output=True, text=True, timeout=100)
        evidence['compiler'] = {'passed': compiler.returncode == 0, 'diagnostics': compiler.stderr[-12000:]}
        if compiler.returncode: raise RuntimeError('Swift compile failed')
        run = subprocess.run([str(executable), str(WORK), str(PANDOC)], cwd=ROOT, capture_output=True, text=True, timeout=105)
        evidence['process'] = {'exitCode': run.returncode, 'stderr': run.stderr[-4000:]}
        result = json.loads((WORK / 'result.json').read_text()); evidence['actualProducers'] = result
        with zipfile.ZipFile(WORK / 'override.epub') as z:
            names = z.namelist(); nav_name = next(n for n in names if n.endswith('/nav.xhtml') or n == 'nav.xhtml')
            nav = ET.fromstring(z.read(nav_name)); h = '{http://www.w3.org/1999/xhtml}'; e = '{http://www.idpf.org/2007/ops}'
            toc = next(n for n in nav.iter(h + 'nav') if n.get(e + 'type') == 'toc')
            labels = [''.join(n.itertext()) for n in toc.iter(h + 'a')]
            text = '\n'.join(''.join(ET.fromstring(z.read(n)).itertext()) for n in names if n.endswith('.xhtml') and n != nav_name)
            epub_ok = any('QA_PRODUCER_H2' in label for label in labels) and not any('QA_PRODUCER_H3' in label for label in labels)
            epub_ok = epub_ok and all(marker in text for marker in ['QA_PRODUCER_H1', 'QA_PRODUCER_H2', 'QA_PRODUCER_H3', 'CURRENT_EPUB_SNAPSHOT'])
            evidence['checks'].append({'name': 'EPUB user --toc-depth=2 overrides structured depth1', 'passed': epub_ok, 'actualNavLabels': labels, 'deepHeadingRetainedInBody': 'QA_PRODUCER_H3' in text})
        data = (WORK / 'override.md').read_bytes(); text = data.decode()
        paragraph_lines = [line for line in text.splitlines() if line.startswith('word')]
        max_length = max(map(len, paragraph_lines))
        flags = {'wordParagraphMax40': max_length <= 40, 'wrappedIntoMultipleLines': len(paragraph_lines) > 3,
                 'currentSnapshot': '# QA_MARKDOWN_CURRENT' in text and 'word60' in text,
                 'crlfOnly': b'\r\n' in data and b'\n' not in data.replace(b'\r\n', b''),
                 'ascii': all(byte < 128 for byte in data), 'referenceLinks': '[qa-link]:' in text}
        evidence['checks'].append({'name': 'Generic Markdown user columns40 overrides structured130', 'passed': all(flags.values()), 'observed': flags, 'maxWordParagraphLine': max_length, 'paragraphLineCount': len(paragraph_lines)})
        auto_html = (WORK / 'auto.html').read_text(encoding='utf-8')
        auto_ok = ('<html' in auto_html.lower() and '<h1' in auto_html.lower()
                   and 'QA_AUTO_DETECT_HTML' in auto_html and 'CURRENT_AUTO_SNAPSHOT' in auto_html and '中文' in auto_html)
        evidence['checks'].append({'name': 'Generic Pandoc empty targetFormat auto-detects HTML destination', 'passed': auto_ok,
                                   'destination': str(WORK / 'auto.html'), 'htmlSHA256': digest(WORK / 'auto.html')})
        invariant = all(c['sourceIdentityPreserved'] and c['editorTextPreserved'] and c['readyWasFalse'] and c['tasksEmpty'] and 'exportFinished' in c['pendingCommands'] for c in result['cases'])
        evidence['checks'].append({'name': 'Actual completion, source identity and bytes retained; no visible windows', 'passed': invariant and digest(WORK / 'source.md') == source_hash and result['visibleWindows'] == 0})
        evidence['passed'] = (run.returncode == 0 and result['completed'] and len(result['cases']) == 3 and all(c['passed'] for c in evidence['checks']) and evidence['performExportBodyUnchanged'] and evidence['otherNativeCopiesVerbatim'])
        evidence['pandocSHA256'] = PANDOC_SHA
    except Exception as error:
        evidence['error'] = f'{type(error).__name__}: {error}'
    finally:
        evidence['nativeSourcesUnchanged'] = all((ROOT / 'native' / name).is_file() and digest(ROOT / 'native' / name) == sha for name, sha in evidence['nativeSourceSHA256'].items())
        evidence['passed'] = evidence['passed'] and evidence['nativeSourcesUnchanged']
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    for check in evidence['checks']: print(('PASS ' if check['passed'] else 'FAIL ') + check['name'])
    print(json.dumps({'passed': evidence['passed'], 'evidence': str(EVIDENCE), 'error': evidence.get('error')}, ensure_ascii=False))
    return 0 if evidence['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
