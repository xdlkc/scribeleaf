#!/usr/bin/env python3
import pathlib, struct, subprocess, sys, tempfile
with tempfile.TemporaryDirectory(prefix='scribeleaf-icon-') as work:
    root = pathlib.Path(work) / 'check.iconset'
    subprocess.run(['iconutil', '-c', 'iconset', sys.argv[1], '-o', str(root)], check=True)
    expected = {f'icon_{point}x{point}{suffix}.png': point * scale for point in (16,32,128,256,512) for suffix,scale in (('',1),('@2x',2))}
    assert {p.name for p in root.iterdir()} == set(expected)
    for name,size in expected.items():
        data = (root/name).read_bytes()
        assert data[:8] == b'\x89PNG\r\n\x1a\n'
        assert struct.unpack('>II', data[16:24]) == (size,size), name
print('PASS: ICNS contains all 10 standard entries, 16 through 1024 physical pixels')
