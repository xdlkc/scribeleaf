#!/usr/bin/env python3
"""Read existing QA preferences through the compiled production store, without GUI or writes."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
QA = ROOT / '.cache/export-settings-native-verifier'
WORK = ROOT / '.cache/export-settings-restart-proof'
APP = WORK / 'RestartProof.app'
EVIDENCE = ROOT / 'evidence/export-settings-restart-proof.json'
RAW = ROOT / 'evidence/export-settings-native-raw-runner.json'
EXPECTED_BUNDLE = 'com.typora-replica.export-settings-verifier.de49ba4df3864980b4dbeb77365d15fe'

PROOF = r'''
import Foundation
import Darwin

@main
struct RestartProof {
    static func main() throws {
        let id = Bundle.main.bundleIdentifier ?? ""
        guard CommandLine.arguments.count == 5 else { exit(2) }
        let expectedID = CommandLine.arguments[1]
        let expectedOutput = CommandLine.arguments[2]
        let expectedPandoc = CommandLine.arguments[3]
        let previousPID = Int(CommandLine.arguments[4]) ?? 0
        setenv("TYPORA_REPLICA_DEFAULTS_SUITE", id, 1)
        let defaults = AppPreferencesStore.defaults
        let sentinel = defaults.string(forKey: "qa.restart.sentinel")
        let editor = AppPreferencesStore.loadEditorPrefs()
        let settings = AppPreferencesStore.loadExport()
        let fields: [String: Any] = [
            "sentinel": sentinel ?? NSNull(),
            "theme": editor["theme"] ?? NSNull(),
            "qaPersist": editor["qaPersist"] ?? NSNull(),
            "general": ["exportFolder": settings.general.exportFolder,
                "customExportPath": settings.general.customExportPath,
                "openExportLocation": settings.general.openExportLocation],
            "pandocPath": settings.pandocPath,
            "htmlExportTheme": settings.formats["html"]?["exportTheme"]?.any ?? NSNull()
        ]
        let checks: [String: Bool] = [
            "sameRealBundleIdentifier": id == expectedID && !id.isEmpty,
            "newProcess": ProcessInfo.processInfo.processIdentifier != previousPID,
            "sentinelThroughProductionStore": sentinel == "QA_RESTART_SENTINEL",
            "editorThemeNight": editor["theme"] as? String == "night",
            "editorWitness": editor["qaPersist"] as? String == "1",
            "exportFolderCustom": settings.general.exportFolder == "custom",
            "exactQAOutputPath": settings.general.customExportPath == expectedOutput,
            "exactQAPandocPath": settings.pandocPath == expectedPandoc,
            "explicitHTMLThemeNight": settings.formats["html"]?["exportTheme"]?.any as? String == "night"
        ]
        let passed = checks.values.allSatisfy { $0 }
        let result: [String: Any] = [
            "bundleIdentifier": id,
            "bundlePath": Bundle.main.bundlePath,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "previousQAPID": previousPID,
            "fields": fields,
            "checks": checks,
            "passed": passed,
            "scope": "New Foundation-only process. Actual production AppPreferencesStore reads. No NSApplication, no defaults writes."
        ]
        let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(passed ? 0 : 1)
    }
}
'''


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    raw_bytes = (QA / 'result.json').read_bytes()
    raw = json.loads(raw_bytes)
    if raw.get('bundleIdentifier') != EXPECTED_BUNDLE:
        raise RuntimeError('This proof is restricted to the recorded de49 QA bundle')
    failed = [c for c in raw.get('checks', []) if not c.get('pending') and c.get('passed') is not True]
    if len(failed) != 1 or failed[0].get('name') != 'restart sentinel persisted in QA domain':
        raise RuntimeError('Unexpected raw runner failure; do not substitute this proof')
    if RAW.exists() and RAW.read_bytes() != raw_bytes:
        raise RuntimeError('Original raw runner archive already differs; preserve it')
    RAW.write_bytes(raw_bytes)
    WORK.mkdir(parents=True, exist_ok=True)
    sources = WORK / 'Sources'
    if sources.exists():
        shutil.rmtree(sources)
    sources.mkdir()
    hashes = {}
    expected_hashes = json.loads((QA / 'source-hashes.json').read_text())
    for original in sorted((ROOT / 'native').glob('*.swift')):
        key = 'native/' + original.name
        hashes[key] = sha(original)
        if hashes[key] != expected_hashes.get(key):
            raise RuntimeError('Production source changed since actual QA: ' + key)
        content = original.read_bytes()
        if original.name == 'App.swift':
            if content.count(b'@main\n') != 1:
                raise RuntimeError('Expected one App.swift main annotation')
            content = content.replace(b'@main\n', b'', 1)
        (sources / original.name).write_bytes(content)
    runner = sources / 'RestartProof.swift'
    runner.write_text(PROOF)
    contents = APP / 'Contents'
    binary = contents / 'MacOS/RestartProof'
    binary.parent.mkdir(parents=True, exist_ok=True)
    (contents / 'Info.plist').write_bytes(plistlib.dumps({
        'CFBundleExecutable': 'RestartProof', 'CFBundleIdentifier': EXPECTED_BUNDLE,
        'CFBundleName': 'Read-only Export Restart Proof', 'CFBundlePackageType': 'APPL',
        'LSMinimumSystemVersion': '13.0',
    }))
    compile_result = subprocess.run([
        'xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library',
        '-target', platform.machine() + '-apple-macosx13.0',
        '-module-cache-path', str(WORK / 'swift-module'),
        *map(str, sorted(sources.glob('*.swift'))), '-o', str(binary),
        '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'PDFKit',
        '-framework', 'UniformTypeIdentifiers',
    ], cwd=ROOT, capture_output=True, text=True, timeout=120)
    report = {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'bundleIdentifier': EXPECTED_BUNDLE,
        'compiler': {'passed': compile_result.returncode == 0, 'exitCode': compile_result.returncode,
                     'target': 'Swift5 / macOS13', 'diagnostics': (compile_result.stderr or compile_result.stdout)[-8000:]},
        'productionSourceSHA256': hashes, 'proofSourceSHA256': sha(runner),
        'rawRunner': {'path': str(RAW.relative_to(ROOT)), 'sha256': sha(RAW),
                      'pid': raw.get('pid'), 'automaticScopePassed': raw.get('automaticScopePassed'),
                      'restartVerified': raw.get('restartVerified'), 'preservedUnchanged': True},
        'knownVerifierDefect': 'Same-bundle suite is nil. QA writer falls back to standard, but its optional-chained reader does not. Production store already falls back.',
        'scope': 'Read existing unique QA domain only; no GUI, no NSApplication initialization, no defaults writes.',
        'passed': False,
    }
    if compile_result.returncode == 0:
        pref = Path.home() / 'Library/Preferences' / (EXPECTED_BUNDLE + '.plist')
        before = pref.read_bytes()
        output_path = str(QA / 'output')
        pandoc_path = str(QA / 'ExportSettingsVerifier.app/Contents/Resources/Converters/pandoc')
        env = dict(os.environ)
        env['TYPORA_REPLICA_DEFAULTS_SUITE'] = EXPECTED_BUNDLE
        execution = subprocess.run([str(binary), EXPECTED_BUNDLE, output_path, pandoc_path, str(raw['pid'])],
                                   cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
        (WORK / 'stdout.json').write_text(execution.stdout)
        (WORK / 'stderr.txt').write_text(execution.stderr)
        actual = json.loads(execution.stdout) if execution.stdout.strip() else {}
        after = pref.read_bytes()
        report.update(binarySHA256=sha(binary), actual=actual,
                      execution={'exitCode': execution.returncode, 'diagnostics': execution.stderr[-8000:]},
                      defaultsReadOnly={'beforeSHA256': hashlib.sha256(before).hexdigest(),
                                        'afterSHA256': hashlib.sha256(after).hexdigest(), 'unchanged': before == after})
        report['passed'] = bool(execution.returncode == 0 and actual.get('passed') is True
                                and actual.get('bundleIdentifier') == EXPECTED_BUNDLE
                                and actual.get('pid') != raw['pid'] and before == after)
    EVIDENCE.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
