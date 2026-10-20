#!/usr/bin/env python3
"""Bounded RepeatExport history tests plus TypeScript and Swift compile checks."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache/repeat-export-state'
EVIDENCE = ROOT / 'evidence/repeat-export-state-verification.json'
DRIVER = CACHE / 'RepeatExportVerify.swift'
BIN = CACHE / 'repeat-export-history'

DRIVER_SRC = r'''
import Foundation

@main
struct RepeatExportVerify {
    static func fail(_ name: String, _ detail: String) -> Never {
        emit(["ok": false, "failed": name, "detail": detail])
        exit(1)
    }

    static func emit(_ value: Any) {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    static func main() {
        var checks: [[String: Any]] = []
        func check(_ name: String, _ passed: Bool, _ detail: [String: Any] = [:]) {
            checks.append(["name": name, "passed": passed, "detail": detail])
            if !passed { fail(name, String(describing: detail)) }
        }

        var history = RepeatExportHistory()
        check("first no history disables previous and overwrite", !history.canExportPrevious && !history.canOverwrite)

        let unsaved = RepeatExport.identityKey(fileURL: nil, unsavedID: "doc-a")
        let firstURL = URL(fileURLWithPath: "/tmp/repeat-export/notes.md")
        let saved = RepeatExport.identityKey(fileURL: firstURL, unsavedID: "doc-a")
        check("unsaved identity differs from later file identity", unsaved != saved)

        check("invalid format rejected", !history.record(format: "not-a-format", destinationPath: "/tmp/out.pdf", identity: saved))
        check("history unchanged after invalid record", !history.canExportPrevious)

        check("accepted destination records format and enables overwrite",
              history.record(format: "pdf", destinationPath: "/tmp/exports/notes.pdf", identity: saved)
              && history.canExportPrevious && history.canOverwrite && history.format == "pdf")

        history.noteDocumentIdentity(saved)
        check("same file identity refresh keeps overwrite", history.canOverwrite)

        let second = RepeatExport.identityKey(fileURL: URL(fileURLWithPath: "/tmp/repeat-export/other.md"), unsavedID: "doc-a")
        history.noteDocumentIdentity(second)
        check("identity switch keeps format and disables overwrite",
              history.format == "pdf" && history.canExportPrevious && !history.canOverwrite)

        let switched = history.panelSuggestion(currentIdentity: second, documentName: "other.md")
        check("switched identity uses stored directory and current name",
              switched?.directory == "/tmp/exports" && switched?.filename == "other.pdf")

        history.noteDocumentIdentity(second)
        check("repeat of switched identity does not restore overwrite", !history.canOverwrite)

        _ = history.record(format: "html-plain", destinationPath: "/tmp/exports/other.html", identity: second)
        let exact = history.panelSuggestion(currentIdentity: second, documentName: "other.md")
        check("same identity uses exact last path",
              history.canOverwrite && exact?.filename == "other.html")

        check("all 13 formats accepted", RepeatExport.formats.count == 13 && RepeatExport.formats.allSatisfy { RepeatExport.isValidFormat($0) })

        var anotherWindow = RepeatExportHistory()
        _ = anotherWindow.record(format: "docx", destinationPath: "/tmp/another-window.docx", identity: "another-window")
        check("window histories remain isolated", history.format == "html-plain" && anotherWindow.format == "docx")
        let unchanged = history
        check("relative export target is rejected without changing history", !history.record(format: "html", destinationPath: "relative.html", identity: second) && history == unchanged)
        check("empty source identity is rejected", !history.record(format: "html", destinationPath: "/tmp/unsafe.html", identity: "") && history == unchanged)
        let request = RepeatExportRequest(id: "one", format: "pdf", overwrite: true, identity: saved)
        check("repeat response must match request identifier", !request.accepts(id: "old", format: "pdf", overwrite: true, identity: saved))
        check("repeat response must match source identity", !request.accepts(id: "one", format: "pdf", overwrite: true, identity: second))
        check("repeat response cannot change format or overwrite intent", !request.accepts(id: "one", format: "html", overwrite: true, identity: saved) && !request.accepts(id: "one", format: "pdf", overwrite: false, identity: saved))
        check("matching current repeat response is accepted", request.accepts(id: "one", format: "pdf", overwrite: true, identity: saved))

        emit(["ok": true, "checks": checks])
    }
}
'''


def run(cmd, **kwargs):
    kwargs.setdefault('timeout', 120)
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, **kwargs)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    DRIVER.write_text(DRIVER_SRC)
    compile_history = run([
        'xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library',
        '-target', subprocess.check_output(['uname', '-m'], text=True).strip() + '-apple-macosx13.0',
        '-module-cache-path', str(ROOT / '.cache/swift'),
        str(ROOT / 'native/RepeatExport.swift'), str(DRIVER),
        '-o', str(BIN),
    ])
    if compile_history.returncode != 0:
        result = {'ok': False, 'stage': 'swift-history', 'stderr': compile_history.stderr[-4000:]}
        EVIDENCE.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False))
        return 1
    history = run([str(BIN)])
    if history.returncode != 0:
        result = {'ok': False, 'stage': 'history-run', 'stdout': history.stdout[-2000:], 'stderr': history.stderr[-2000:]}
        EVIDENCE.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False))
        return 1
    history_json = json.loads(history.stdout.strip().splitlines()[-1])

    native_out = CACHE / 'TyporaReplica'
    compile_native = run([
        'xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', '-O',
        '-target', subprocess.check_output(['uname', '-m'], text=True).strip() + '-apple-macosx13.0',
        '-module-name', 'TyporaReplica',
        '-module-cache-path', str(ROOT / '.cache/swift'),
        *sorted(str(p) for p in (ROOT / 'native').glob('*.swift')),
        '-o', str(native_out),
        '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers',
    ])
    tsc = run(['npx', 'tsc', '--noEmit'])
    result = {
        'ok': history_json.get('ok') is True and compile_native.returncode == 0 and tsc.returncode == 0,
        'history': history_json,
        'nativeCompile': compile_native.returncode == 0,
        'nativeStderr': compile_native.stderr[-4000:] if compile_native.returncode else '',
        'typecheck': tsc.returncode == 0,
        'typecheckStderr': tsc.stderr[-4000:] if tsc.returncode else '',
        'nativeBinary': str(native_out),
    }
    EVIDENCE.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: result[k] for k in ['ok', 'nativeCompile', 'typecheck']}, ensure_ascii=False))
    if history_json.get('checks'):
        for check in history_json['checks']:
            print(('PASS' if check['passed'] else 'FAIL'), check['name'])
    if compile_native.returncode:
        print(compile_native.stderr[-2000:])
    if tsc.returncode:
        print(tsc.stderr[-2000:])
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
