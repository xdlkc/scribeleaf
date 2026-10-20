"""Exercise the real NSDocument/WKWebView bridge against a disposable file."""
import json
import os
import plistlib
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

root = Path(__file__).resolve().parent.parent
original = '# Native document\r\n\r\n中文文件保存。\r\n'
suffix = '\nNative save verification.\n'
encoding = os.environ.get('TYPORA_TEST_ENCODING', 'utf-8')
check_close = os.environ.get('TYPORA_TEST_CLOSE') == '1'
with tempfile.TemporaryDirectory(prefix='typora-native-') as directory:
    base = Path(directory)
    app = base / 'Typora Native Smoke.app'
    contents = app / 'Contents'
    (contents / 'MacOS').mkdir(parents=True)
    editor = contents / 'Resources/editor'
    editor.mkdir(parents=True)
    shutil.copy2(root / '.cache/TyporaReplica', contents / 'MacOS/TyporaReplica')
    info = plistlib.loads((root / 'native/Info.plist').read_bytes())
    info['CFBundleIdentifier'] = 'local.typora-replica.smoke'
    (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
    page = '''<!doctype html><meta charset="utf-8"><title>Native verification</title>
<p>This temporary page tests native file handling.</p><script>
let tested=false;
window.typora={command(name,payload){
 if(name==='load' && !tested){tested=true;
  const markdown=payload.markdown+'\\nNative save verification.\\n';
  window.webkit.messageHandlers.native.postMessage({type:'change',markdown});
  window.webkit.messageHandlers.native.postMessage({type:'save',markdown});
 }
}};
window.webkit.messageHandlers.native.postMessage({type:'ready'});
</script>'''
    if check_close:
        page = page.replace("window.webkit.messageHandlers.native.postMessage({type:'save',markdown});", '')
    (editor / 'index.html').write_text(page)
    target = base / 'document.md'
    target.write_bytes(original.encode(encoding))
    process = subprocess.Popen([str(contents / 'MacOS/TyporaReplica'), str(target)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    result = {'ok': False}
    try:
        if check_close:
            command = [str(root / '.cache/verify-close'), str(process.pid), str(contents / 'MacOS/TyporaReplica')]
            output = subprocess.run(command, capture_output=True, text=True, timeout=25)
            result = json.loads(output.stdout)
            result['fileUnchangedAfterCancel'] = target.read_bytes() == original.encode(encoding)
            result['ok'] = result['ok'] and result['fileUnchangedAfterCancel']
        for _ in range(0 if check_close else 150):
            if target.read_bytes() == (original + suffix).encode(encoding):
                result = {'ok': True, 'nativeOpenSave': True, 'unicodeAndCRLFPreserved': True, 'encoding': encoding}
                break
            if process.poll() is not None:
                result['error'] = process.stderr.read().decode(errors='replace')[-3000:]
                break
            time.sleep(.2)
        else:
            if not check_close:
                result['error'] = 'Native open/save bridge did not finish within 30 seconds.'
    finally:
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
        recovery = Path.home() / 'Library/Application Support/local.typora-replica.smoke/Recovery'
        for item in recovery.glob('*.json'):
            try:
                data = json.loads(item.read_text())
                if data.get('path') and Path(data['path']).resolve().is_relative_to(base.resolve()):
                    item.unlink()
            except (ValueError, OSError):
                pass
    (root / 'evidence').mkdir(exist_ok=True)
    name = 'native-close-verification.json' if check_close else ('native-verification.json' if encoding == 'utf-8' else f'native-{encoding}-verification.json')
    (root / 'evidence' / name).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['ok'] else 1)
