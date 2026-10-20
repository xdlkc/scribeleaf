import AppKit
import WebKit

final class Smoke: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var done = false
    var navigationStarted = false
    var navigationFinished = false
    var scriptErrors: [String] = []
    let fixture: String
    let evidence: URL

    init(index: URL, fixture: String, evidence: URL) {
        self.fixture = fixture
        self.evidence = evidence
        super.init()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "native")
        config.userContentController.addUserScript(WKUserScript(source: """
        window.addEventListener('error',e=>window.webkit.messageHandlers.native.postMessage({type:'testError',message:e.message||e.target?.src||'resource error'}),true);
        window.addEventListener('unhandledrejection',e=>window.webkit.messageHandlers.native.postMessage({type:'testError',message:String(e.reason)}));
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 850), configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Scribeleaf — WebKit verification"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        web.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [self] in
            if !done { finish(["ok": false, "error": "WebKit renderer did not become ready within 15 seconds", "navigationStarted": navigationStarted, "navigationFinished": navigationFinished, "scriptErrors": scriptErrors], code: 1) }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any] else { return }
        if payload["type"] as? String == "testError" { scriptErrors.append(payload["message"] as? String ?? "error"); return }
        guard payload["type"] as? String == "ready" else { return }
        let data = try! JSONSerialization.data(withJSONObject: ["markdown": fixture, "path": "", "name": "acceptance.md"])
        let arg = String(data: data, encoding: .utf8)!
        web.evaluateJavaScript("window.typora.command('load', \(arg)); true") { [self] _, error in
            if let error { finish(["ok": false, "error": error.localizedDescription], code: 1); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [self] in verify() }
        }
    }

    func verify() {
        let code = """
        (() => { const before=window.typora.getMarkdown();
          for(let i=0;i<4;i++) window.typora.command('toggleSource');
          return {ok:window.typora.getMarkdown()===before,
            markdown:window.typora.getMarkdown(),
            editable:!!document.querySelector('[contenteditable=true]'),
            text:document.body.innerText.slice(0,200)}; })()
        """
        web.evaluateJavaScript(code) { [self] value, error in
            if let error { finish(["ok": false, "error": error.localizedDescription], code: 1); return }
            var result = value as? [String: Any] ?? [:]
            result["exactFixture"] = result["markdown"] as? String == fixture
            result.removeValue(forKey: "markdown")
            let passed = result["ok"] as? Bool == true && result["exactFixture"] as? Bool == true && result["editable"] as? Bool == true
            result["ok"] = passed
            web.takeSnapshot(with: nil) { [self] image, _ in
                if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: evidence.appendingPathComponent("replica-webkit.png"))
                }
                finish(result, code: passed ? 0 : 1)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(["ok": false, "error": error.localizedDescription], code: 1) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(["ok": false, "error": error.localizedDescription], code: 1) }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { navigationStarted = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { navigationFinished = true }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(["ok": false, "error": "WebKit content process terminated"], code: 1) }
    func finish(_ result: [String: Any], code: Int32) {
        guard !done else { return }; done = true
        let data = try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        try? data.write(to: evidence.appendingPathComponent("webkit-verification.json"))
        FileHandle.standardOutput.write(data)
        exit(code)
    }
}

guard CommandLine.arguments.count == 4 else { fputs("usage: webkit-smoke dist/index.html fixture.md evidence-dir\n", stderr); exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let fixture = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
let smoke = Smoke(index: URL(fileURLWithPath: CommandLine.arguments[1]), fixture: fixture, evidence: URL(fileURLWithPath: CommandLine.arguments[3]))
app.run()
