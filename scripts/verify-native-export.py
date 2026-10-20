"""Exercise the current native PDF implementation with a document longer than a viewport."""
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
work = root / '.cache/native-export'
work.mkdir(parents=True, exist_ok=True)
source = (root / 'native/App.swift').read_text()
assert '@main\nstruct TyporaReplicaApplication' in source
(work / 'App.swift').write_text(source.split('@main\nstruct TyporaReplicaApplication')[0])
html = (root / 'evidence/export.html').read_text()
extra = ''.join(f'<p>PDF_PAGE_CHECK_{n}: This paragraph verifies pagination and complete document output.</p>' for n in range(240))
(work / 'input.html').write_text(html.replace('</body>', extra + '<p>NATIVE_PDF_END_MARKER</p></body>'))
(work / 'main.swift').write_text(r'''
import AppKit
import WebKit
import PDFKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let target = folder.appendingPathComponent("output.pdf")
var job: ExportJob?
func finish(_ result: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(result["ok"] as? Bool == true ? 0 : 1)
}
Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { _ in
    let html = try! String(contentsOf: folder.appendingPathComponent("input.html"), encoding: .utf8)
    job = ExportJob(html: html, base: folder, destination: target, printInfo: NSPrintInfo.shared) { _, error in
        if let error { finish(["ok": false, "error": error.localizedDescription]) }
        guard let pdf = PDFDocument(url: target) else { finish(["ok": false, "error": "No readable PDF"]) }
        let text = pdf.string ?? ""
        let end = text.contains("NATIVE_PDF_END_MARKER")
        let first = text.contains("A place for your thoughts")
        let math = text.contains("Mathematics")
        let result: [String: Any] = ["ok": end && first && math && pdf.pageCount > 2, "pages": pdf.pageCount, "firstHeading": first, "lastMarker": end, "mathSection": math, "pdf": target.path, "releaseCycleTested": true]
        job = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { finish(result) }
    }
    job!.start()
}
Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { _ in finish(["ok": false, "error": "Native PDF export timed out"]) }
app.run()
''')
sources = [str(work / 'App.swift'), str(work / 'main.swift')]
sources += [str(p) for p in (root / 'native').glob('*.swift') if p.name != 'App.swift']
subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(root / '.cache/swift'), *sources, '-o', str(work / 'verify'), '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'PDFKit', '-framework', 'UniformTypeIdentifiers'], check=True, cwd=root)
try:
    result = subprocess.run([str(work / 'verify'), str(work)], capture_output=True, text=True, timeout=55, cwd=root)
    try:
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        data = {'ok': False, 'error': (result.stderr or result.stdout)[-1500:]}
except subprocess.TimeoutExpired:
    data = {'ok': False, 'error': 'Native PDF export exceeded 55 seconds'}
(root / 'evidence/native-pdf-verification.json').write_text(json.dumps(data, ensure_ascii=False, indent=2))
print(json.dumps(data, ensure_ascii=False))
raise SystemExit(0 if data.get('ok') else 1)
