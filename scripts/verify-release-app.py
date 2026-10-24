#!/usr/bin/env python3
"""Validate every bundled Mach-O slice, deployment floor, dependencies and signature."""
import pathlib, plistlib, re, subprocess, sys
app = pathlib.Path(sys.argv[1])
def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
assert info['LSMinimumSystemVersion'] == '13.0', info
edition = sys.argv[2] if len(sys.argv) > 2 else info.get('ScribeleafEdition')
assert edition in ('Lite', 'Full'), edition
assert info.get('ScribeleafEdition') == edition
assert info['CFBundleIdentifier'] == 'local.typora-replica.editor'
assert info['CFBundleExecutable'] == 'Scribeleaf'
assert info['CFBundleIconFile'] == 'Scribeleaf.icns'
subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('verify-icon.py')), str(app / 'Contents/Resources/Scribeleaf.icns')], check=True)
assert info['CFBundleDisplayName'] == f'Scribeleaf {edition}'
assert (app / 'Contents/Resources/editor/index.html').is_file()
converter = app / 'Contents/Resources/Converters'
if edition == 'Full':
    for name in ('pandoc', 'COPYING.md', 'SOURCE.md'):
        assert (converter / name).is_file(), name
else:
    assert not converter.exists(), 'Lite must not contain a converter directory'
    assert not any(p.name.lower() == 'pandoc' and p.is_file() for p in app.rglob('*')), 'Lite contains Pandoc'
count = 0
for p in app.rglob('*'):
    if not p.is_file() or 'Mach-O' not in run('file', '-b', str(p)):
        continue
    count += 1
    run('lipo', str(p), '-verify_arch', 'arm64', 'x86_64')
    for arch in ('arm64', 'x86_64'):
        loads = run('otool', '-arch', arch, '-l', str(p))
        # Read only deployment commands, not unrelated dylib version fields.
        minimum = re.findall(r'cmd LC_BUILD_VERSION.*?minos ([\d.]+)|cmd LC_VERSION_MIN_MACOSX.*?version ([\d.]+)', loads, re.S)
        assert minimum, (p, arch, 'missing deployment command')
        for pair in minimum:
            v = next(x for x in pair if x)
            assert tuple(map(int, v.split('.'))) <= (13, 0, 0), (p, arch, v)
        for line in run('otool', '-arch', arch, '-L', str(p)).splitlines():
            if ' (compatibility version' in line:
                dep = line.strip().split(' (')[0]
                assert dep.startswith(('/System/Library/', '/usr/lib/')), (p, arch, dep)
    run('codesign', '--verify', '--strict', str(p))
    print(run('lipo', '-info', str(p)).strip())
assert count == (2 if edition == 'Full' else 1), (edition, count)
run('codesign', '--verify', '--deep', '--strict', str(app))
print(f'PASS {edition}: {count} universal Mach-O files; macOS <=13; system dependencies; signatures')
