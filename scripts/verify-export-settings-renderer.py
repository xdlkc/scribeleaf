#!/usr/bin/env python3
"""Bounded, windowless real WebKit probe of production exportPrepare replies.

Captures the real renderer bridge only; it never runs the production native
request vault, save panels, exporters, custom commands, or user preferences.
"""
import datetime
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import platform
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.cache/export-settings-renderer-probe'
EDITOR = ROOT / '.cache/export-settings-native-verifier/ExportSettingsVerifier.app/Contents/Resources/editor'
EVIDENCE = ROOT / 'evidence/export-settings-renderer-verification.json'

SWIFT = r'''
import AppKit
import WebKit
import Foundation
import Darwin

@MainActor final class RendererProbe: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var web: WKWebView!
    var ready = false
    var replies: [String: [String: Any]] = [:]
    var types: [String] = []
    var results: [[String: Any]] = []
    var diagnostics: [[String: Any]] = []
    var error: String?
    let work: URL
    init(editor: URL, work: URL) {
        self.work = work
        super.init()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.add(self, name: "native")
        config.userContentController.addUserScript(WKUserScript(source: "window.addEventListener('error',e=>window.webkit.messageHandlers.native.postMessage({type:'probeError',message:String(e.message)}));window.addEventListener('unhandledrejection',e=>window.webkit.messageHandlers.native.postMessage({type:'probeError',message:String(e.reason)}));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 820, height: 600), configuration: config)
        web.navigationDelegate = self
        web.loadFileURL(editor.appendingPathComponent("index.html"), allowingReadAccessTo: editor)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        types.append(type)
        if type == "ready" { ready = true }
        if type == "probeError" { diagnostics.append(body) }
        if type == "export", let id = body["requestId"] as? String { replies[id] = body }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError failure: Error) { error = failure.localizedDescription }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError failure: Error) { error = failure.localizedDescription }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { types.append("navigationFinished") }
    func js(_ script: String, _ args: [String: Any] = [:]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            web.callAsyncJavaScript(script, arguments: args, in: nil, in: .page) { continuation.resume(with: $0) }
        }
    }
    func waitReady() async throws {
        let deadline = Date().addingTimeInterval(15)
        while !ready && error == nil && Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        if !ready { throw failure(error ?? "Renderer ready timeout (15s)") }
    }
    func failure(_ text: String) -> NSError { NSError(domain: "RendererProbe", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
    func prepare(id: String, currentTheme: String, explicit: String, intent: String) async throws {
        let markdown = "# WEBKIT_THEME_PROBE 中文\n\nUNSAVED_RENDERER_SNAPSHOT \(id)\n"
        let identity = "/private/tmp/typora-renderer-probe/source.md"
        let snapshot: [String: Any] = ["key": "html", "type": "html", "name": "HTML",
            "general": ["exportFolder": "", "customExportPath": "", "openExportLocation": false],
            "pandocPath": "", "options": ["exportTheme": explicit, "sidebar": false,
                "appendHead": "", "appendBody": "", "allowPerFileSetting": false]]
        let _ = try await js("window.typora.command('load',payload); return window.typora.getMarkdown();",
            ["payload": ["markdown": markdown, "path": identity, "name": "source.md"]])
        let hydrated = try await js("window.typora.command('hydratePrefs',{prefs:{theme:theme}}); return document.body.dataset.theme;", ["theme": currentTheme])
        let _ = try await js("window.typora.command('exportPrepare',payload); return true;", ["payload": [
            "requestId": id, "format": "html", "identity": identity, "overwrite": false, "intent": intent, "settings": snapshot]])
        let deadline = Date().addingTimeInterval(12)
        while replies[id] == nil && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        guard let reply = replies[id], let html = reply["html"] as? String else { throw failure("No real export bridge reply for \(id) (12s)") }
        let after = try await js("return {markdown:window.typora.getMarkdown(),theme:document.body.dataset.theme,width:innerWidth,height:innerHeight};")
        try Data(html.utf8).write(to: work.appendingPathComponent(id + ".html"), options: .atomic)
        results.append(["id": id, "currentTheme": currentTheme, "explicitTheme": explicit, "intent": intent,
            "hydratedTheme": hydrated, "snapshot": snapshot, "reply": reply, "expectedMarkdown": markdown,
            "after": after, "htmlPath": work.appendingPathComponent(id + ".html").path])
    }
    func run() async {
        var passed = false
        do {
            try await waitReady()
            try await prepare(id: "base-empty-github", currentTheme: "github", explicit: "", intent: "export")
            try await prepare(id: "base-empty-repeat-pixyll", currentTheme: "pixyll", explicit: "", intent: "repeat")
            try await prepare(id: "explicit-night-github", currentTheme: "github", explicit: "night", intent: "export")
            try await prepare(id: "explicit-night-repeat-whitey", currentTheme: "whitey", explicit: "night", intent: "repeat")
            passed = true
        } catch { self.error = error.localizedDescription }
        if !passed, let state = try? await js("return {state:document.readyState,typora:typeof window.typora,scripts:Array.from(document.scripts).map(s=>s.src),body:document.body?.innerText?.slice(0,300)};") as? [String: Any] { diagnostics.append(state) }
        let record: [String: Any] = ["completed": passed, "error": error as Any? ?? NSNull(), "cases": results,
            "nativeMessageTypes": types, "visibleWindowCount": NSApp.windows.filter { $0.isVisible }.count,
            "windowCount": NSApp.windows.count, "webViewBounds": ["width": web.bounds.width, "height": web.bounds.height],
            "nonPersistentDataStore": !web.configuration.websiteDataStore.isPersistent,
            "diagnostics": diagnostics,
            "pid": ProcessInfo.processInfo.processIdentifier]
        if let data = try? JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: work.appendingPathComponent("result.json"), options: .atomic)
        }
        web.configuration.userContentController.removeScriptMessageHandler(forName: "native")
        web.stopLoading(); web.navigationDelegate = nil
        exit(passed ? 0 : 1)
    }
}

@main enum Main {
    @MainActor static func main() {
        let args = CommandLine.arguments
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let probe = RendererProbe(editor: URL(fileURLWithPath: args[1], isDirectory: true), work: URL(fileURLWithPath: args[2], isDirectory: true))
        Task { await probe.run() }
        withExtendedLifetime(probe) { app.run() }
    }
}
'''


class HTMLProof(HTMLParser):
    def __init__(self):
        super().__init__(); self.theme = None; self.in_style = False; self.styles = []
    def handle_starttag(self, tag, attrs):
        if tag == 'body': self.theme = dict(attrs).get('data-theme')
        if tag == 'style': self.in_style = True
    def handle_endtag(self, tag):
        if tag == 'style': self.in_style = False
    def handle_data(self, data):
        if self.in_style: self.styles.append(data)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    result_path = WORK / 'result.json'
    collection_only = '--collect' in sys.argv
    if not collection_only: result_path.unlink(missing_ok=True)
    sources = {str(p.relative_to(ROOT)): digest(p) for p in [ROOT / 'src/main.ts', ROOT / 'src/export.ts', ROOT / 'src/export-settings.ts', ROOT / 'src/store.ts']}
    bundle_hashes = {str(p.relative_to(EDITOR)): digest(p) for p in EDITOR.rglob('*') if p.is_file()}
    evidence = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed': False,
                'sourceSHA256': sources, 'productionRendererSHA256': bundle_hashes, 'productionRenderer': str(EDITOR),
                'scope': 'Windowless real WKWebView loads the production renderer and captures its actual export bridge replies.',
                'limits': ['Four HTML theme-resolution cases only; no Mermaid concurrency case.',
                           'Probe native handler only captures messages. Production native request vault, saved output, PDF/PNG exporters, save panels and full repeat history are not verified.',
                           'CLI has no visible or registered application and uses a nonpersistent WebKit data store. No user defaults, clipboard, existing app, or custom command is used.'],
                'bounds': {'readySeconds': 15, 'replySecondsPerCase': 12, 'processSeconds': 60, 'cases': 4}, 'checks': []}
    swift = WORK / 'Probe.swift'; executable = WORK / 'renderer-probe'
    if not collection_only: swift.write_text(SWIFT)
    try:
        if collection_only:
            evidence = json.loads(EVIDENCE.read_text())
            bundle_hashes = evidence['productionRendererSHA256']
            evidence['checks'] = []
            evidence['collectionOnly'] = True
            evidence['validationNote'] = 'WKWebView may create an internal invisible window. The required boundary is zero visible windows; the probe never constructs NSWindow or registers an app.'
            run = subprocess.CompletedProcess([], evidence['process']['exitCode'])
        else:
            compile_result = subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', '-target', platform.machine() + '-apple-macosx13.0',
                '-module-cache-path', str(WORK / 'swift-module'), str(swift), '-o', str(executable), '-framework', 'AppKit', '-framework', 'WebKit'],
                cwd=ROOT, capture_output=True, text=True, timeout=90)
            evidence['compiler'] = {'passed': compile_result.returncode == 0, 'diagnostics': compile_result.stderr[-8000:]}
            if compile_result.returncode: raise RuntimeError('Swift compile failed')
            run = subprocess.run([str(executable), str(EDITOR), str(WORK)], cwd=ROOT, capture_output=True, text=True, timeout=60)
            evidence['process'] = {'exitCode': run.returncode, 'stdout': run.stdout[-2000:], 'stderr': run.stderr[-4000:]}
        result = json.loads(result_path.read_text())
        evidence['actualWebKit'] = result
        expected = ['github', 'pixyll', 'night', 'night']
        for case, theme in zip(result.get('cases', []), expected):
            html = Path(case['htmlPath']).read_text()
            doc = HTMLProof(); doc.feed(html); css = ''.join(doc.styles)
            scope = re.search(r'\[data-theme=[\"\x27]?' + theme + r'[\"\x27]?\]', css) is not None
            specific = {'github': '#4183c4', 'pixyll': 'Replica Pixyll', 'night': '#363b40'}[theme] in css
            reply = case['reply']; after = case['after']; settings = reply.get('settings', {})
            unchanged = reply.get('markdown') == case['expectedMarkdown'] == after.get('markdown')
            frozen = settings.get('snapshot') == case['snapshot']
            ok = (doc.theme == theme and scope and specific and unchanged and frozen
                  and case['hydratedTheme'] == case['currentTheme'] == after.get('theme')
                  and reply.get('requestId') == case['id'] and reply.get('intent') == case['intent'])
            evidence['checks'].append({'name': case['id'], 'passed': ok, 'expectedExportTheme': theme,
                'actualBodyTheme': doc.theme, 'themeCssScope': scope, 'themeCssFingerprint': specific,
                'markdownUnchanged': unchanged, 'baseSnapshotUnchanged': frozen, 'editorThemeAfter': after.get('theme'),
                'htmlSHA256': digest(Path(case['htmlPath']))})
        evidence['passed'] = (evidence['compiler']['passed'] and run.returncode == 0 and result.get('completed') is True and len(evidence['checks']) == 4
            and all(c['passed'] for c in evidence['checks'])
            and result.get('visibleWindowCount') == 0 and result.get('nonPersistentDataStore') is True)
    except Exception as error:
        evidence['error'] = f'{type(error).__name__}: {error}'
    finally:
        evidence['productionRendererUnchanged'] = all((EDITOR / name).is_file() and digest(EDITOR / name) == sha for name, sha in bundle_hashes.items())
        evidence['passed'] = evidence['passed'] and evidence['productionRendererUnchanged']
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    for check in evidence['checks']: print(('PASS ' if check['passed'] else 'FAIL ') + check['name'])
    print(json.dumps({'passed': evidence['passed'], 'evidence': str(EVIDENCE), 'error': evidence.get('error')}, ensure_ascii=False))
    return 0 if evidence['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
