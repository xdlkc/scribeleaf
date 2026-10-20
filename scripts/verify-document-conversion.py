#!/usr/bin/env python3
"""Compile the Swift adapter and verify transport separately from real Pandoc.

Use --pandoc /absolute/path/to/pandoc for actual format conversion checks.
The test double is a real child process. It does not implement document formats.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SWIFT = r'''
import Foundation
@main struct VerifyConversion {
    static func emit(_ value: Any) {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    }
    static func main() async {
        let a = CommandLine.arguments
        if a[1] == "metadata" {
            emit(DocumentConversionFormat.allCases.map { ["format": $0.rawValue, "title": $0.title,
                  "extension": $0.fileExtension, "uti": $0.contentType.identifier] }); return
        }
        if a[1] == "resolve" {
            do { emit(["path": try DocumentConverter.executableURL(customURL: a[2] == "-" ? nil : URL(fileURLWithPath: a[2])).path]) }
            catch { emit(["error": error.localizedDescription]) }; return
        }
        if a[1] == "parallel" {
            let folder = URL(fileURLWithPath: a[2]), pandoc = URL(fileURLWithPath: a[3])
            let results = await withTaskGroup(of: [String: String].self) { group in
                for i in 0..<6 {
                    group.addTask {
                        do {
                            let target = folder.appendingPathComponent("parallel-\(i).docx")
                            let result = try await DocumentConverter.convert(markdown: "# 并发 \(i)", format: .docx,
                                destination: target, resourceDirectoryURL: folder, pandocURL: pandoc, timeout: 5)
                            return ["path": result.destination.path]
                        } catch { return ["error": error.localizedDescription] }
                    }
                }
                var collected: [[String: String]] = []
                for await result in group { collected.append(result) }; return collected
            }
            emit(results); return
        }
        guard a.count == 11, let format = DocumentConversionFormat(rawValue: a[2]),
              let timeout = Double(a[7]), let cancelMS = Int(a[9]) else {
            emit(["error": "invalid runner arguments"]); return
        }
        do {
            let markdown = try String(contentsOfFile: a[8], encoding: .utf8)
            let task = Task {
                try await DocumentConverter.convert(markdown: markdown, format: format,
                    destination: URL(fileURLWithPath: a[3]),
                    documentURL: a[4] == "-" ? nil : URL(fileURLWithPath: a[4]),
                    resourceDirectoryURL: a[5] == "-" ? nil : URL(fileURLWithPath: a[5]),
                    pandocURL: a[6] == "-" ? nil : URL(fileURLWithPath: a[6]), timeout: timeout)
            }
            if cancelMS == 0 { task.cancel() }
            else if cancelMS > 0 {
                Task { try? await Task.sleep(nanoseconds: UInt64(cancelMS) * 1_000_000); task.cancel() }
            }
            let result = try await task.value
            emit(["destination": result.destination.path, "warnings": result.warnings])
        } catch { emit(["error": error.localizedDescription]) }
    }
}
'''

STUB = r'''
import json, os, signal, sys, time
from pathlib import Path
a = sys.argv[1:]
assert a[0:2] == ["--from", "markdown"], a
assert a[2] == "--to" and a[4:6] == ["--standalone", "--output"], a
assert len(a) in (8, 10), a
if len(a) == 10:
    assert a[7] == "--lua-filter" and Path(a[8]).is_file(), a
target = Path(a[6]); source = Path(a[-1])
text = source.read_text(encoding="utf-8")
if text.startswith("MODE:SLEEP"):
    Path("active-pid").write_text(str(os.getpid()))
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(20)
if text.startswith("MODE:FAIL"):
    target.write_text("PARTIAL OUTPUT")
    sys.stdout.write("out" * 100000); sys.stdout.flush()
    sys.stderr.write("错误" * 100000); sys.stderr.flush()
    sys.exit(23)
if text.startswith("MODE:MISSING"):
    sys.exit(0)
if text.startswith("MODE:HUGE"):
    sys.stderr.write("warning" * 300000); sys.stderr.flush()
target.write_text(json.dumps({"argv": a, "cwd": str(Path.cwd()), "text": text,
    "input_exists": source.is_file(), "asset_exists": Path("asset 图 #%.png").is_file()}, ensure_ascii=False), encoding="utf-8")
'''

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pandoc", type=Path)
    args = parser.parse_args()
    evidence = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": "Swift Pandoc adapter; process transport checks are distinct from real format conversions",
        "sources": ["https://support.typora.io/Export/", "https://support.typora.io/Install-and-Use-Pandoc/",
                    "https://pandoc.org/MANUAL.html", "https://pandoc.org/lua-filters.html", "https://pandoc.org/installing.html"],
        "harness": {"model": "grok-4.6", "reasoning_effort": "low", "attempted": True,
                    "executed": False, "reason": "Automatic approval review failed: selected model is at capacity. No bypass or retry."},
        "transport_checks": [], "real_pandoc": {"status": "not_run", "checks": []},
    }
    checks = evidence["transport_checks"]

    def check(name, condition, detail=None):
        item = {"name": name, "passed": bool(condition)}
        if detail is not None:
            item["detail"] = detail
        checks.append(item)
        if not condition:
            raise AssertionError(f"{name}: {detail}")

    cache = ROOT / ".cache"
    cache.mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="document-conversion-qa-", dir=cache) as work_str:
            work = Path(work_str)
            swift = work / "Runner.swift"
            swift.write_text(SWIFT)
            runner = work / "conversion-runner"
            compile_result = subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-parse-as-library",
                "-module-cache-path", str(cache / "swift"), str(ROOT / "native/DocumentConversion.swift"),
                str(swift), "-o", str(runner)], capture_output=True, text=True, timeout=60)
            check("Swift 5 / macOS native compiler", compile_result.returncode == 0, compile_result.stderr.strip())
            metadata = json.loads(subprocess.check_output([str(runner), "metadata"], text=True))
            evidence["formats"] = metadata
            check("Nine captured Typora Pandoc formats", {i["format"] for i in metadata} ==
                  {"docx", "odt", "rtf", "epub", "latex", "mediawiki", "rst", "textile", "opml"})
            stub = work / "pandoc controlled test double"
            stub.write_text("#!" + sys.executable + "\n" + STUB)
            stub.chmod(0o700)
            assets = work / "源资源 folder: 图 #100%"
            assets.mkdir()
            image = assets / "asset 图 #%.png"
            image.write_bytes(PNG)
            source = assets / "source.md"
            source.write_text("ORIGINAL SOURCE 中文", encoding="utf-8")
            source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
            output = work / "separate exports"
            output.mkdir()
            markdown = work / "unsaved snapshot.md"

            def convert(text, dest, fmt="docx", origin=source, resource=None, pandoc=stub, timeout=5, cancel=-1):
                markdown.write_text(text, encoding="utf-8")
                call = [str(runner), "convert", fmt, str(dest), str(origin) if origin else "-",
                        str(resource) if resource else "-", str(pandoc) if pandoc else "-", str(timeout), str(markdown), str(cancel), "end"]
                started = time.monotonic()
                result = subprocess.run(call, capture_output=True, text=True, timeout=timeout + 8)
                if result.returncode:
                    raise AssertionError(result.stderr)
                return json.loads(result.stdout), time.monotonic() - started

            def no_staging():
                return not list(output.glob(".typora-conversion-*")) and not list(assets.glob(".typora-conversion-*"))

            body = "# 未保存 中文\n\n![图](<asset 图 #%.png>)\n\n`$(touch injected)` ; ' \" &\n"
            target = output / "输出 $(touch injected) ' ; #%.docx"
            result, _ = convert(body, target)
            payload = json.loads(target.read_text())
            check("UTF-8 unsaved snapshot, literal arguments, special output path", "error" not in result and payload["text"] == body and not (assets / "injected").exists())
            check("Resources resolved from source cwd including colon and Chinese", payload["cwd"] == str(assets) and payload["asset_exists"])
            check("Temporary snapshot outside source and removed after success", Path(payload["argv"][-1]).parent != assets and not Path(payload["argv"][-1]).exists())
            snapshot_root = Path(payload["argv"][-1]).parent.parent
            prior_snapshots = set(snapshot_root.glob("typora-conversion-*"))
            check("Successful output commit removes same-directory staging", no_staging())
            for item in metadata:
                dest = output / ("transport." + item["extension"])
                result, _ = convert(body, dest, fmt=item["format"])
                payload = json.loads(dest.read_text())
                check("Writer arguments: " + item["format"], "error" not in result and payload["argv"][3] == item["format"] and payload["argv"][4] == "--standalone")
            target.write_bytes(b"EXISTING DESTINATION")
            result, _ = convert("MODE:FAIL", target)
            check("Nonzero exit drains both pipes and preserves prior destination", "exit 23" in result.get("error", "") and target.read_bytes() == b"EXISTING DESTINATION")
            check("Failure diagnostics are bounded", len(result["error"].encode("utf-8")) < 16600)
            check("Failure removes private snapshot/staging files", no_staging())
            result, _ = convert("MODE:MISSING", target)
            check("Success without output is an error and preserves destination", "without producing" in result.get("error", "") and target.read_bytes() == b"EXISTING DESTINATION")
            result, _ = convert("MODE:HUGE", target)
            check("Large success diagnostics drain without deadlock and are bounded", "error" not in result and 16384 <= len(result["warnings"].encode()) < 16432)
            result, _ = convert("# 副本 中文", target, origin=None, resource=assets)
            payload = json.loads(target.read_text())
            check("Unsaved duplicate without fileURL uses explicit resource root", "error" not in result and payload["cwd"] == str(assets) and payload["asset_exists"])
            result, _ = convert("# Untitled 中文", target, origin=None)
            payload = json.loads(target.read_text())
            check("Untitled without resource origin uses private snapshot cwd", "error" not in result and Path(payload["cwd"]).resolve() == Path(payload["argv"][-1]).parent.resolve())
            result, _ = convert(body, source)
            check("Source destination rejected before conversion", "cannot overwrite" in result.get("error", "") and hashlib.sha256(source.read_bytes()).hexdigest() == source_hash)
            alias = output / "source-alias.docx"
            alias.symlink_to(source)
            result, _ = convert(body, alias)
            check("Symlink alias cannot overwrite source", "cannot overwrite" in result.get("error", "") and source.read_text() == "ORIGINAL SOURCE 中文")
            result, _ = convert(body, target, resource=work / "missing-resource-folder")
            check("Unavailable resource origin produces actionable error", "resource folder is unavailable" in result.get("error", ""))
            target.write_bytes(b"UNCHANGED ON INTERRUPT")
            result, elapsed = convert("MODE:SLEEP", target, timeout=0.3)
            pid = int((assets / "active-pid").read_text())
            check("Timeout terminates SIGTERM-resistant child and preserves destination", "did not finish" in result.get("error", "") and elapsed < 3 and target.read_bytes() == b"UNCHANGED ON INTERRUPT")
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                alive = False
            check("Timed-out child is reaped", not alive)
            result, elapsed = convert("MODE:SLEEP", target, timeout=5, cancel=250)
            pid = int((assets / "active-pid").read_text())
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                alive = False
            check("Task cancellation kills child, preserves destination, completes promptly", "cancelled" in result.get("error", "").lower() and elapsed < 3 and not alive and target.read_bytes() == b"UNCHANGED ON INTERRUPT")
            result, _ = convert(body, target, cancel=0)
            check("Cancellation before process launch preserves destination", "cancel" in result.get("error", "").lower() and target.read_bytes() == b"UNCHANGED ON INTERRUPT")
            result, _ = convert(body, target, pandoc=work / "does-not-exist")
            check("Invalid explicit executable fails without silent fallback", "cannot be run" in result.get("error", ""))
            detected = json.loads(subprocess.check_output([str(runner), "resolve", "-"], text=True))
            evidence["system_pandoc_detection"] = detected
            check("Dependency discovery returns executable or installation instructions", "path" in detected or "https://pandoc.org/installing.html" in detected.get("error", ""))
            parallel = json.loads(subprocess.check_output([str(runner), "parallel", str(assets), str(stub)], text=True, timeout=10))
            payloads = [json.loads(Path(i["path"]).read_text()) for i in parallel]
            check("Concurrent conversions use six independent snapshots and outputs", len(payloads) == 6 and len({p["argv"][-1] for p in payloads}) == 6 and len({p["text"] for p in payloads}) == 6)
            check("Source bytes remain unchanged after all transport operations", hashlib.sha256(source.read_bytes()).hexdigest() == source_hash)
            check("All transport operations clean private staging directories", no_staging())
            check("All transport operations clean temporary input snapshots", set(snapshot_root.glob("typora-conversion-*")) == prior_snapshots)

            if args.pandoc:
                pandoc = args.pandoc.resolve()
                version = subprocess.check_output([str(pandoc), "--version"], text=True, timeout=10).splitlines()[0]
                real = evidence["real_pandoc"]
                real.update(status="running", executable=str(pandoc), version=version,
                            executable_sha256=hashlib.sha256(pandoc.read_bytes()).hexdigest())
                real_body = "---\ntitle: 导出验收\n---\n\n# 中文标题\n\n正文 **加粗**。\n\n![资源](asset%20%E5%9B%BE%20%23%25.png)\n\n## 子标题\n\n- 项目一\n- 项目二\n"
                for item in metadata:
                    fmt = item["format"]
                    dest = output / ("real." + item["extension"])
                    result, _ = convert(real_body, dest, fmt=fmt, origin=None, resource=assets, pandoc=pandoc)
                    valid = "error" not in result and dest.is_file() and dest.stat().st_size > 0
                    details = {"name": fmt + " actual format conversion", "passed": valid,
                               "bytes": dest.stat().st_size if dest.exists() else 0, "warnings": result.get("warnings", ""), "transport": "real Pandoc"}
                    if valid and fmt in {"docx", "odt", "epub"}:
                        with zipfile.ZipFile(dest) as archive:
                            names = archive.namelist()
                            if fmt == "docx":
                                xml = archive.read("word/document.xml")
                                valid = "中文标题" in xml.decode() and "正文" in xml.decode() and any(n.startswith("word/media/") and archive.read(n) == PNG for n in names)
                            elif fmt == "odt":
                                xml = archive.read("content.xml")
                                valid = archive.read("mimetype") == b"application/vnd.oasis.opendocument.text" and "中文标题" in xml.decode() and any(n.startswith("Pictures/") and archive.read(n) == PNG for n in names)
                            else:
                                xmls = [archive.read(n) for n in names if n.endswith((".xhtml", ".html"))]
                                valid = archive.read("mimetype") == b"application/epub+zip" and any("中文标题" in x.decode() for x in xmls) and any(n.endswith(".png") and archive.read(n) == PNG for n in names)
                            for name in names:
                                if name.endswith((".xml", ".xhtml", ".opf", ".ncx")):
                                    ET.fromstring(archive.read(name))
                            details["archive_entries"] = names
                            details["embedded_source_png_sha256"] = hashlib.sha256(PNG).hexdigest()
                    elif valid:
                        text = dest.read_text(encoding="utf-8")
                        signatures = {"rtf": "{\\rtf", "latex": "\\begin{document}", "mediawiki": "中文标题", "rst": "中文标题", "textile": "h1(#中文标题).", "opml": "<opml"}
                        valid = signatures[fmt] in text
                        if fmt == "rtf":
                            valid = valid and "\\u20013" in text and "\\pict" in text
                        else:
                            valid = valid and "中文标题" in text
                        if fmt == "opml":
                            ET.fromstring(text)
                        if fmt == "latex":
                            valid = valid and str(image) in text.replace("\\#", "#").replace("\\%", "%")
                        elif fmt != "rtf":
                            valid = valid and urllib.parse.quote(str(image), safe="/-._~") in text
                        details["signature"] = signatures[fmt]
                        details["image_reference_behavior"] = "RTF embeds image" if fmt == "rtf" else "Readable local images use absolute source paths; source assets must remain available"
                    details["passed"] = bool(valid)
                    real["checks"].append(details)
                    if not valid:
                        raise AssertionError(f"real format {fmt}: {result}")
                real["status"] = "passed"
                real["scope_note"] = "Nine genuine conversions. DOCX/ODT/EPUB archives and embedded PNG bytes checked; text signatures/Chinese and OPML XML checked. Not full Typora visual/export preference parity."
            evidence["passed"] = True
    except Exception as error:
        evidence["passed"] = False
        evidence["error"] = str(error)
        raise
    finally:
        evidence["transport_passed"] = sum(i["passed"] for i in checks)
        evidence["transport_total"] = len(checks)
        target = ROOT / "evidence/document-conversion-verification.json"
        target.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"passed": evidence.get("passed"), "transport": f"{evidence['transport_passed']}/{len(checks)}",
                          "real_pandoc": evidence["real_pandoc"]["status"], "evidence": str(target)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
