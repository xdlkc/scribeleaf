#!/usr/bin/env python3
"""Validate every bundled Mach-O slice, deployment floor, dependencies and signature."""
import pathlib, plistlib, re, subprocess, sys
app = pathlib.Path(sys.argv[1])
def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
assert info['LSMinimumSystemVersion'] == '13.0', info
if info['CFBundleExecutable'] == 'Scribeleaf':
    for relative in ('Contents/Resources/editor/index.html', 'Contents/Resources/Converters/pandoc', 'Contents/Resources/Converters/COPYING.md', 'Contents/Resources/Converters/SOURCE.md'):
        assert (app / relative).is_file(), relative
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
assert count, 'No Mach-O found'
run('codesign', '--verify', '--deep', '--strict', str(app))
print(f'PASS: {count} universal Mach-O files; macOS <=13; system dependencies; signatures')
