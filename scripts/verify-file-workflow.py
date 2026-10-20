"""Headless real AppKit workflow QA. Only generated documents and a unique suite."""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / 'evidence/file-workflow-verification.json'
OWNED_SUITES = []


def run():
    started = time.time()
    suite = 'local.typora-replica.file-workflow-qa.' + uuid.uuid4().hex
    OWNED_SUITES.append(suite)
    hashes = {}
    with tempfile.TemporaryDirectory(prefix='typora-file-workflow-') as temporary:
        work = Path(temporary)
        sources = []
        for path in sorted((ROOT / 'native').glob('*.swift')):
            data = path.read_bytes()
            hashes[str(path.relative_to(ROOT))] = hashlib.sha256(data).hexdigest()
            text = data.decode()
            if path.name == 'App.swift':
                text = text.split('@main\nstruct TyporaReplicaApplication')[0]
                text, count = re.subn(r'static var folder: URL \{.*?\n    \}\n    static func url', 'static var folder: URL { URL(fileURLWithPath: ProcessInfo.processInfo.environment["TYPORA_QA_RECOVERY_DIRECTORY"]!, isDirectory: true) }\n    static func url', text, count=1, flags=re.S)
                assert count == 1, 'Recovery isolation must patch exactly one path getter'
            frozen = work / path.name
            frozen.write_text(text)
            sources.append(str(frozen))
        main = ROOT / 'scripts/verify-file-workflow.swift'
        hashes[str(main.relative_to(ROOT))] = hashlib.sha256(main.read_bytes()).hexdigest()
        (work / 'main.swift').write_bytes(main.read_bytes())
        executable = work / 'verify'
        info_path = ROOT / 'native/Info.plist'
        hashes[str(info_path.relative_to(ROOT))] = hashlib.sha256(info_path.read_bytes()).hexdigest()
        production_info = plistlib.loads(info_path.read_bytes())
        info = {'CFBundleIdentifier': suite + '.bundle', 'CFBundleExecutable': 'verify', 'CFBundleName': 'File Workflow Verifier',
                'CFBundleDocumentTypes': production_info['CFBundleDocumentTypes']}
        embedded_info = work / 'Info.plist'
        embedded_info.write_bytes(plistlib.dumps(info))
        compiled = subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(ROOT / '.cache/swift'), *sources, str(work / 'main.swift'), '-o', str(executable), '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', str(embedded_info), '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers'], cwd=ROOT, capture_output=True, text=True, timeout=180)
        if compiled.returncode:
            return {'passed': False, 'compileSucceeded': False, 'error': compiled.stderr[-9000:], 'sourceHashes': hashes}
        env = os.environ.copy()
        env['TYPORA_REPLICA_DEFAULTS_SUITE'] = suite
        env['TYPORA_QA_RECOVERY_DIRECTORY'] = str(work / 'recovery')
        # Imports used here contain no embedded media. The helper's independent
        # media lifecycle QA supplies its own isolated cache.
        pandoc = ROOT / '.cache/pandoc' / ('pandoc-3.12.1-' + platform.machine()) / 'bin/pandoc'
        process = subprocess.run([str(executable), str(work / 'documents'), str(pandoc)], cwd=ROOT, capture_output=True, text=True, timeout=150, env=env)
        line = next((line for line in process.stdout.splitlines() if line.startswith('FILE_WORKFLOW_JSON:')), None)
        if line:
            result = json.loads(line[len('FILE_WORKFLOW_JSON:'):])
        else:
            result = {'passed': False, 'checks': [], 'error': (process.stderr + process.stdout)[-10000:]}
        result.update({'compileSucceeded': True, 'exitCode': process.returncode, 'elapsedSeconds': round(time.time() - started, 2), 'sourceHashes': hashes,
            'sourceMatchesCurrent': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest for name, digest in hashes.items()},
            'testCopyChanges': ['Remove production @main only', 'Redirect Recovery.folder to generated temporary directory'],
            'bundleMetadata': 'Production CFBundleDocumentTypes declarations embedded in a bare CLI Mach-O __TEXT/__info_plist section, with unique QA identity/name/executable. No .app is opened.',
            'command': 'python3 scripts/verify-file-workflow.py', 'diagnostics': process.stderr[-3000:]})
        result['total'] = len(result.get('checks', []))
        result['passedCount'] = sum(row['passed'] for row in result.get('checks', []))
        if not all(result['sourceMatchesCurrent'].values()):
            result['passed'] = False
            result['sourceDrift'] = [name for name, matches in result['sourceMatchesCurrent'].items() if not matches]
        return result


if __name__ == '__main__':
    try:
        result = run()
    except Exception as error:
        result = {'passed': False, 'error': str(error), 'checks': []}
    cleanup = []
    for suite in OWNED_SUITES:
        assert re.fullmatch(r'local\.typora-replica\.file-workflow-qa\.[a-f0-9]{32}', suite)
        for domain in [suite, suite + '.bundle', suite + '.system-policy']:
            subprocess.run(['defaults', 'delete', domain], capture_output=True)
            path = Path.home() / 'Library/Preferences' / (domain + '.plist')
            try:
                if path.exists() and plistlib.loads(path.read_bytes()) == {}:
                    path.unlink()
                cleanup.append({'domain': domain, 'fileAbsent': not path.exists()})
            except OSError as error:
                cleanup.append({'domain': domain, 'fileAbsent': False, 'error': str(error)})
    result['ownedDefaultsCleanup'] = cleanup
    EVIDENCE.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(('PASS' if result['passed'] else 'FAIL') + f" {result.get('passedCount', 0)}/{result.get('total', 0)} native file workflows")
    for row in result.get('checks', []):
        if not row['passed']:
            print(json.dumps(row, ensure_ascii=False))
    if result.get('error'):
        print(result['error'])
    if result.get('sourceDrift'):
        print('Source changed during verification:', result['sourceDrift'])
    raise SystemExit(0 if result['passed'] else 1)
