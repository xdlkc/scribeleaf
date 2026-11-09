#!/usr/bin/env python3
"""Require exactly the current version's four edition assets and verify their hashes."""
import hashlib, pathlib, sys
root, version = pathlib.Path(sys.argv[1]), sys.argv[2]
expected = {f'Scribeleaf-{edition}-{version}-universal.{extension}' for edition in ('Lite', 'Full') for extension in ('zip', 'dmg')}
actual = {p.name for p in root.iterdir() if p.is_file()}
assert actual == expected | {'SHA256SUMS'}, (actual, expected)
entries = {}
for line in (root / 'SHA256SUMS').read_text().splitlines():
    digest, name = line.split('  ', 1)
    assert name not in entries, name
    entries[name] = digest
assert set(entries) == expected
for name, digest in entries.items():
    p = root / name
    assert hashlib.sha256(p.read_bytes()).hexdigest() == digest, name
    print(f'{name}: {p.stat().st_size} bytes ({p.stat().st_size / 1_000_000:.2f} MB), SHA256 OK')
