#!/usr/bin/env python3
"""Compare runtime sections, not edition-specific plist/code-signature metadata."""
import hashlib, pathlib, plistlib, struct, subprocess, sys, tempfile
lite, full = map(pathlib.Path, sys.argv[1:3])
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def runtime_sections(executable, arch, output):
    subprocess.run(['lipo', str(executable), '-thin', arch, '-output', str(output)], check=True)
    data = output.read_bytes()
    header = struct.unpack_from('<8I', data)
    assert header[0] == 0xfeedfacf
    sections, cursor = {}, 32
    for _ in range(header[4]):
        command, length = struct.unpack_from('<II', data, cursor)
        if command == 0x19:  # LC_SEGMENT_64; __LINKEDIT/signatures have no sections.
            count = struct.unpack_from('<I', data, cursor + 64)[0]
            for i in range(count):
                start = cursor + 72 + i * 80
                name = data[start:start+16].rstrip(b'\0').decode()
                segment = data[start+16:start+32].rstrip(b'\0').decode()
                size = struct.unpack_from('<Q', data, start + 40)[0]
                offset = struct.unpack_from('<I', data, start + 48)[0]
                flags = struct.unpack_from('<I', data, start + 64)[0]
                if flags & 0xff not in (1, 12, 18):  # zero-fill sections have no file bytes.
                    sections[(segment, name)] = hashlib.sha256(data[offset:offset+size]).hexdigest()
        cursor += length
    assert sections
    return sections
with tempfile.TemporaryDirectory(prefix='scribeleaf-section-check-') as work:
    for arch in ('arm64', 'x86_64'):
        first = runtime_sections(lite / 'Contents/MacOS/Scribeleaf', arch, pathlib.Path(work) / 'lite')
        second = runtime_sections(full / 'Contents/MacOS/Scribeleaf', arch, pathlib.Path(work) / 'full')
        assert first == second, arch
        print(f'PASS: {arch} native runtime code/data sections identical (edition signatures differ)')
assert digest(lite / 'Contents/Resources/Scribeleaf.icns') == digest(full / 'Contents/Resources/Scribeleaf.icns')
print('PASS: Lite/Full share exactly the same brand icon')
infos = [plistlib.loads((app / 'Contents/Info.plist').read_bytes()) for app in (lite, full)]
for key in ('CFBundleIdentifier', 'CFBundleName', 'CFBundleExecutable', 'CFBundleShortVersionString', 'CFBundleDocumentTypes'):
    assert infos[0][key] == infos[1][key], key
renderers = []
for app in (lite, full):
    root = app / 'Contents/Resources/editor'
    renderers.append({str(p.relative_to(root)): digest(p) for p in root.rglob('*') if p.is_file()})
assert renderers[0] == renderers[1]
print(f'PASS: {len(renderers[0])} identical renderer files and same installed document identity')
