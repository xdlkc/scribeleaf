#!/usr/bin/env python3
import json, os, subprocess, tempfile, pathlib, sys

root = pathlib.Path(__file__).resolve().parents[1]
cache = root / ".cache/export-settings-dist"
cache.mkdir(parents=True, exist_ok=True)
pandoc = root / ".cache/pandoc/pandoc-3.12.1-x86_64/bin/pandoc"
if not pandoc.exists():
    arch = subprocess.check_output(["uname", "-m"], text=True).strip()
    pandoc = root / f".cache/pandoc/pandoc-3.12.1-{arch}/bin/pandoc"
if not pandoc.exists():
    print("pandoc missing", file=sys.stderr)
    sys.exit(1)

help_text = subprocess.check_output([str(pandoc), "--help"], text=True, errors="replace")
formats = subprocess.check_output([str(pandoc), "--list-output-formats"], text=True, errors="replace")
needed = ["--reference-doc", "--template", "--css", "--toc-depth", "--split-level", "--pdf-engine", "--wrap", "--columns", "--eol", "--tab-stop", "--ascii", "--reference-links", "--reference-location", "--markdown-headings", "--webtex"]
missing = [f for f in needed if f not in help_text]

with tempfile.TemporaryDirectory(prefix="export-settings-qa-", dir=str(cache)) as td:
    td = pathlib.Path(td)
    src_dir = td / "源 文件#1"
    src_dir.mkdir()
    src = src_dir / "笔记.md"
    src.write_text("# 你好\n", encoding="utf-8")
    out = td / "out.rst"
    cmd = [str(pandoc), "--from", "markdown", "--to", "rst", "--standalone", "--output", str(out), str(src)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not out.exists():
        print(proc.stderr)
        sys.exit(1)
    # extras with unicode path as argv element
    ref = td / "样式.docx"
    # cannot create real docx easily; just ensure argv does not use shell
    unsafe = subprocess.run([str(pandoc), "--from", "markdown", "--to", "plain", "--output", str(td / "plain.txt"), str(src), "--columns", "80"], capture_output=True, text=True)
    if unsafe.returncode != 0:
        sys.exit(1)

report = {
    "pandoc": str(pandoc),
    "missingFlags": missing,
    "hasDocx": "docx" in formats,
    "unicodeOk": True,
}
(cache / "export-settings-pandoc.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report, indent=2))
if missing:
    sys.exit(1)
