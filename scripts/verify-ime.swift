import AppKit
import WebKit

// Drive Cocoa's marked-text protocol against the production renderer.
// This covers composition events, not a specific input method's candidate UI.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let tableMode = CommandLine.arguments.contains("--table")
let initialMarkdown = tableMode
    ? "# IME test\n\n| A | B |\n| --- | --- |\n| value | START |\n\nAFTER"
    : "# IME test\n\nSTART"
let expectedMarkdown = initialMarkdown.replacingOccurrences(of: "START", with: "START你好")
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 750))
let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = web
var completed = false
func finish(_ result: [String: Any]) {
    guard !completed else { return }
    completed = true
    let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    exit(result["ok"] as? Bool == true ? 0 : 1)
}
func later(_ action: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: action) }
final class Probe: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        prepare(attempt: 0)
    }
    func prepare(attempt: Int) {
        web.evaluateJavaScript("Boolean(window.typora?.editor)") { value, _ in
            guard value as? Bool == true else {
                if attempt < 30 { later { self.prepare(attempt: attempt + 1) } }
                else { finish(["ok": false, "error": "Production editor did not boot"]) }
                return
            }
            web.callAsyncJavaScript("window.typora.command('load',{markdown:markdown,path:'',name:'ime.md'}); const v=window.typora.editor; if(table){const cell=document.querySelector('.lp-cell[data-row=\"1\"][data-col=\"1\"]');cell.focus();const range=document.createRange();range.selectNodeContents(cell);range.collapse(false);const s=document.getSelection();s.removeAllRanges();s.addRange(range);}else{v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();} return true;", arguments: ["markdown": initialMarkdown, "table": tableMode], in: nil, in: .page) { result in
                if case .failure(let error) = result { finish(["ok": false, "error": error.localizedDescription]); return }
                later { self.compose() }
            }
        }
    }
    func compose() {
        guard let client = window.firstResponder as? NSTextInputClient else {
            finish(["ok": false, "error": "No Cocoa text input client", "responder": String(describing: window.firstResponder)]); return
        }
        let unspecified = NSRange(location: NSNotFound, length: 0)
        client.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0), replacementRange: unspecified)
        later {
            client.setMarkedText("你好", selectedRange: NSRange(location: 2, length: 0), replacementRange: unspecified)
            later {
                client.insertText("你好", replacementRange: unspecified)
                later {
                    web.callAsyncJavaScript("const t=window.typora.getMarkdown();window.typora.command('undo');const undone=window.typora.getMarkdown()===initial;window.typora.command('redo');const redone=window.typora.getMarkdown()===t;window.typora.command('toggleSource');window.typora.command('toggleSource');const stable=window.typora.getMarkdown()===t;return {ok:t===expected&&stable&&undone&&redone,markedTextCommitted:t===expected,sourceSwitchPreserved:stable,undoComposition:undone,redoComposition:redone,candidateUITested:false,surface:table?'table':'document',text:t};", arguments: ["initial": initialMarkdown, "expected": expectedMarkdown, "table": tableMode], in: nil, in: .page) { result in
                        switch result {
                        case .success(let value): finish(value as? [String: Any] ?? ["ok": false, "error": "No composition result"])
                        case .failure(let error): finish(["ok": false, "error": error.localizedDescription])
                        }
                    }
                }
            }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(["ok": false, "error": error.localizedDescription]) }
}
let probe = Probe()
web.navigationDelegate = probe
window.makeFirstResponder(web)
let index = URL(fileURLWithPath: CommandLine.arguments[1])
web.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { _ in finish(["ok": false, "error": "Composition probe timed out"]) }
application.run()
