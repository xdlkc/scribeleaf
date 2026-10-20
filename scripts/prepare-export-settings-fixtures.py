#!/usr/bin/env python3
"""Create reusable export fixtures and verify them with the pinned Pandoc CLI.

This is a CLI fixture baseline. It does not launch or verify the application.
Uses the Python standard library and subprocess argument lists only.
"""

import argparse
import datetime
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
import zlib


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".cache/export-settings-fixtures"
EVIDENCE = ROOT / "evidence/export-settings-pandoc-baseline.json"
PINNED = ROOT / ".cache/pandoc/pandoc-3.12.1-x86_64/bin/pandoc"
PINNED_SHA256 = "287e725a56ed196e1820d25acaecc48b769f9489221bd86ad2d44932e98e9af7"
WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XHTML = "http://www.w3.org/1999/xhtml"
EPUB = "http://www.idpf.org/2007/ops"
TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
STYLE_NAME = "QA Fixture Style"
STYLE_ID = "QAFixtureStyle"
STYLE_COLOR = "1B6F5A"
TEMPLATE_MARKER = "QA_ODT_TEMPLATE_APPLIED"
CSS_MARKER = "QA_EPUB_CSS_APPLIED"
METADATA_MARKER = "QA_EXTRA_METADATA 中文 ; $(fixture-literal)"
HEADING_MARKERS = ["QA_H1_ALPHA", "QA_H2_ALPHA", "QA_H3_ALPHA", "QA_H1_BETA", "QA_H2_BETA"]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def save_text(path, value):
    path.write_bytes(value.encode("utf-8"))


def png(width=28, height=18):
    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend((27, 111, 90) if (x // 7 + y // 6) % 2 else (238, 177, 37))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows))) + chunk(b"IEND", b""))


def word_style(archive):
    styles = ET.fromstring(archive.read("word/styles.xml"))
    for item in styles.findall(f"{{{WORD}}}style"):
        name = item.find(f"{{{WORD}}}name")
        if name is not None and name.get(f"{{{WORD}}}val") == STYLE_NAME:
            color = item.find(f"{{{WORD}}}rPr/{{{WORD}}}color")
            return {"id": item.get(f"{{{WORD}}}styleId"),
                    "color": color.get(f"{{{WORD}}}val") if color is not None else None}
    return None


def validate_xml_archive(path):
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise AssertionError(f"Corrupt archive entry: {bad}")
        for name in archive.namelist():
            if name.endswith((".xml", ".xhtml", ".opf", ".ncx", ".rels")):
                ET.fromstring(archive.read(name))


def epub_details(path, image_bytes):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        nav_name = next(name for name in names if name.endswith("/nav.xhtml") or name == "nav.xhtml")
        nav = ET.fromstring(archive.read(nav_name))
        toc = next(node for node in nav.iter(f"{{{XHTML}}}nav") if node.get(f"{{{EPUB}}}type") == "toc")
        labels = ["".join(node.itertext()).strip() for node in toc.iter(f"{{{XHTML}}}a")]
        headings = [label for label in labels if any(marker in label for marker in HEADING_MARKERS)]
        chapters = {}
        for name in names:
            if name.endswith(".xhtml") and name != nav_name:
                text = "".join(ET.fromstring(archive.read(name)).itertext())
                found = [marker for marker in HEADING_MARKERS if marker in text]
                if found:
                    chapters[name] = found
        return {"tocHeadings": headings, "chapterFiles": chapters,
                "cssEntriesWithMarker": [name for name in names if name.endswith(".css") and CSS_MARKER.encode() in archive.read(name)],
                "embeddedPngEntries": [name for name in names if name.endswith(".png") and archive.read(name) == image_bytes],
                "mimetype": archive.read("mimetype").decode()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pandoc", type=Path, default=PINNED,
                        help="Must be the previously verified Pandoc binary (SHA256 checked).")
    args = parser.parse_args()
    pandoc = args.pandoc.resolve()
    if sha256(pandoc.read_bytes()) != PINNED_SHA256:
        raise RuntimeError("Pandoc SHA256 differs from the previously verified 3.12.1 binary")
    WORK.mkdir(parents=True, exist_ok=True)
    output = WORK / "baseline-output"
    output.mkdir(exist_ok=True)
    data_dir = WORK / "isolated-pandoc-data"
    data_dir.mkdir(exist_ok=True)
    evidence = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": "CLI fixture baseline only. No new application consumer, renderer bridge, native UI, or Typora parity verification.",
        "applicationConsumerVerified": False, "nativeUIVerified": False,
        "executable": str(pandoc), "executableSha256": PINNED_SHA256,
        "fixtureRoot": str(WORK), "commands": [], "checks": [], "passed": False,
        "isolation": "Every invocation uses a fixture-local --data-dir; no shell, global install, user configuration, GUI, network, or original application access.",
    }

    def run(arguments, *, binary=False):
        argv = [str(pandoc), "--data-dir", str(data_dir), *map(str, arguments)]
        result = subprocess.run(argv, cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
        evidence["commands"].append({"argv": argv, "cwd": str(WORK), "exitCode": result.returncode,
                                     "stderr": result.stderr.decode("utf-8", errors="replace")[:4096]})
        if result.returncode:
            raise RuntimeError(f"Pandoc failed: {arguments!r}\n{result.stderr.decode('utf-8', errors='replace')}")
        return result.stdout if binary else result.stdout.decode("utf-8")

    def check(name, condition, **detail):
        evidence["checks"].append({"name": name, "passed": bool(condition), **detail})
        if not condition:
            raise AssertionError(name)

    try:
        version = run(["--version"])
        help_text = run(["--help"])
        save_text(WORK / "pandoc-version.txt", version)
        save_text(WORK / "pandoc-help.txt", help_text)
        evidence["version"] = version.splitlines()[0]
        required_flags = ["--reference-doc", "--template", "--css", "--toc-depth", "--split-level", "--metadata", "--wrap", "--columns", "--eol", "--reference-links", "--markdown-headings"]
        check("Installed CLI advertises every exercised option", all(flag in help_text for flag in required_flags), flags=required_flags)

        assets = WORK / "assets 特殊 # % ' $(fixture-literal); [qa]"
        assets.mkdir(exist_ok=True)
        image = assets / "image 图 #%.png"
        image_bytes = png()
        image.write_bytes(image_bytes)
        relative_image = urllib.parse.quote(image.relative_to(WORK).as_posix(), safe="/")
        css = WORK / "epub 样式 #%.css"
        save_text(css, f"/* {CSS_MARKER} */\nbody {{ color: #123abc; }}\nh1 {{ border-bottom: 3px solid #1b6f5a; }}\n")
        source = WORK / "source.md"
        source_text = f'''---
title: "QA_EXPORT_SETTINGS 中文"
author: "QA Fixture Author"
subject: "QA_SOURCE_METADATA"
---

# QA_H1_ALPHA

正文 **加粗**，UTF-8 中文、é、🙂。路径和参数保持字面值：`$()`、`;`、`#`、`%`。

![QA_PNG_ASSET]({relative_image})

## QA_H2_ALPHA

QA_LEVEL_TWO_BODY

### QA_H3_ALPHA

QA_LEVEL_THREE_BODY

::: {{custom-style="{STYLE_NAME}"}}
QA_CUSTOM_STYLE_BODY 中文
:::

# QA_H1_BETA

QA_SECOND_CHAPTER_BODY

## QA_H2_BETA

[qa-link](https://example.invalid/fixture?a=1&b=2)
'''
        save_text(source, source_text)
        crlf_source = WORK / "source-crlf.md"
        crlf_source.write_bytes(source_text.replace("\n", "\r\n").encode())
        yaml_cases = WORK / "yaml-whitelist.md"
        save_text(yaml_cases, '''---
title: QA_YAML_TITLE
author: QA_YAML_AUTHOR
subject: QA_YAML_SUBJECT
creator: QA_YAML_CREATOR
split-level: 2
toc-depth: 1
typora-sidebar: false
sidebar: "false"
Header: QA_CAPITAL_HEADER
typora-header: unset
header: ""
footer: QA_YAML_FOOTER
typora-append-head: '<meta name="qa-append-head" content="QA_YAML_HEAD">'
append-body: '<div id="qa-yaml-body">QA_YAML_BODY</div>'
append-head-extra: QA_HEAD_EXTRA
append-body-extra: QA_BODY_EXTRA
runCommand: true
runCommandStr: QA_MUST_NOT_BECOME_COMMAND
pandocPath: QA_MUST_NOT_OVERRIDE_EXECUTABLE
---

# QA_YAML_FIXTURE

This is input for App YAML whitelist tests, not proof of App YAML semantics.
''')
        long_source = WORK / "long-document.md"
        save_text(long_source, "# QA_LONG_TOP\n\n" + "\n\n".join(
            f"## QA_LONG_SECTION_{i:03d}\n\n" + (f"长文第 {i} 段。Font readiness and export pagination. " * 12)
            for i in range(1, 81)) + "\n\n# QA_LONG_BOTTOM\n")
        markdown_source = WORK / "markdown-options-source.md"
        save_text(markdown_source, "# QA_MARKDOWN_OPTIONS\n\n" + " ".join(f"word{i:02d}" for i in range(1, 61))
                  + "\n\nPRESERVE_SOFT_ALPHA\nPRESERVE_SOFT_BETA\n\n[qa-link](https://example.invalid/fixture)\n\n中文 é\n")
        source_hashes = {str(path.relative_to(WORK)): sha256(path.read_bytes()) for path in [source, crlf_source, yaml_cases, long_source, markdown_source, image, css]}

        # Preserve the default DOCX archive and XML namespace spelling. Add one
        # paragraph style whose color is absent from Pandoc's generated fallback.
        default_docx = run(["--print-default-data-file=reference.docx"], binary=True)
        reference = WORK / "reference.docx"
        with zipfile.ZipFile(io.BytesIO(default_docx)) as original, zipfile.ZipFile(reference, "w") as target:
            for entry in original.infolist():
                data = original.read(entry.filename)
                if entry.filename == "word/styles.xml":
                    style = (f'<w:style w:type="paragraph" w:customStyle="1" w:styleId="{STYLE_ID}">'
                             f'<w:name w:val="{STYLE_NAME}"/><w:basedOn w:val="Normal"/><w:qFormat/>'
                             f'<w:rPr><w:color w:val="{STYLE_COLOR}"/><w:sz w:val="30"/></w:rPr></w:style>').encode()
                    if data.count(b"</w:styles>") != 1:
                        raise AssertionError("Unexpected default DOCX styles root")
                    data = data.replace(b"</w:styles>", style + b"</w:styles>")
                target.writestr(entry, data)
        validate_xml_archive(reference)
        with zipfile.ZipFile(reference) as archive:
            check("Reference DOCX contains the unique custom paragraph style", word_style(archive) == {"id": STYLE_ID, "color": STYLE_COLOR})

        template = WORK / "custom.opendocument"
        default_template = run(["--print-default-template=opendocument"])
        check("Default OpenDocument template exposes one body slot", default_template.count("$body$") == 1)
        save_text(template, default_template.replace("$body$", f"<text:p>{TEMPLATE_MARKER}</text:p>\n<text:p>$qa-extra$</text:p>\n$body$"))

        common = ["--from", "markdown", "--standalone"]
        docx_default, docx_reference = output / "docx-default.docx", output / "docx-reference.docx"
        run([*common, "--to", "docx", "--output", docx_default, source])
        run([*common, "--to", "docx", "--reference-doc", reference, "--output", docx_reference, source])
        for path in [docx_default, docx_reference]:
            validate_xml_archive(path)
        with zipfile.ZipFile(docx_reference) as applied, zipfile.ZipFile(docx_default) as control:
            xml = ET.fromstring(applied.read("word/document.xml"))
            style_ids = [node.get(f"{{{WORD}}}val") for node in xml.iter(f"{{{WORD}}}pStyle")]
            details = {"appliedStyle": word_style(applied), "controlStyle": word_style(control), "paragraphStyleIds": sorted(set(style_ids))}
            check("--reference-doc carries the style color and document references it",
                  details["appliedStyle"] == {"id": STYLE_ID, "color": STYLE_COLOR}
                  and STYLE_ID in style_ids and (details["controlStyle"] or {}).get("color") != STYLE_COLOR, **details)
            check("DOCX embeds the PNG from its percent-encoded special path",
                  any(name.startswith("word/media/") and applied.read(name) == image_bytes for name in applied.namelist()), imageSha256=sha256(image_bytes))

        odt = output / "template-and-metadata.odt"
        run([*common, "--to", "odt", "--template", template, "--metadata", f"qa-extra={METADATA_MARKER}", "--output", odt, source])
        validate_xml_archive(odt)
        with zipfile.ZipFile(odt) as archive:
            xml = ET.fromstring(archive.read("content.xml"))
            contents = "".join(xml.itertext())
            check("--template injects valid ODT XML and extra metadata remains literal",
                  TEMPLATE_MARKER in contents and METADATA_MARKER in contents and "中文" in contents,
                  templateMarker=TEMPLATE_MARKER, metadataMarker=METADATA_MARKER,
                  paragraphs=["".join(p.itertext()) for p in xml.iter(f"{{{TEXT}}}p") if TEMPLATE_MARKER in "".join(p.itertext()) or METADATA_MARKER in "".join(p.itertext())])

        epub_results = {}
        for depth in [1, 2]:
            target = output / f"epub-depth{depth}-split{depth}.epub"
            run([*common, "--to", "epub", "--css", css, "--toc", "--toc-depth", str(depth), "--split-level", str(depth), "--output", target, source])
            validate_xml_archive(target)
            details = epub_details(target, image_bytes)
            epub_results[str(depth)] = details
            wanted = [marker for marker in HEADING_MARKERS if int(marker[4]) <= depth]
            check(f"EPUB depth {depth}: CSS, TOC depth, chapter split and special-path PNG",
                  details["mimetype"] == "application/epub+zip" and details["tocHeadings"] == wanted
                  and len(details["chapterFiles"]) == len(wanted) and bool(details["cssEntriesWithMarker"])
                  and bool(details["embeddedPngEntries"]), **details)

        markdown_common = [*common, "--to", "markdown", "--markdown-headings", "atx", "--reference-links", "--reference-location", "block"]
        variants = {
            "auto": ["--wrap", "auto", "--columns", "40", "--eol", "lf"],
            "none": ["--wrap", "none", "--columns", "40", "--eol", "lf"],
            "preserve": ["--wrap", "preserve", "--eol", "lf"],
            "crlf": ["--wrap", "none", "--eol", "crlf"],
            "ascii": ["--wrap", "none", "--ascii", "--eol", "lf"],
        }
        markdown_bytes = {}
        for name, options in variants.items():
            target = output / f"markdown-{name}.md"
            run([*markdown_common, *options, "--output", target, markdown_source])
            markdown_bytes[name] = target.read_bytes()
        # Columns is not a hard limit for indivisible URLs/reference definitions.
        # Measure the controlled word paragraph rather than every output line.
        longest = lambda value: max(len(line) for line in value.decode().splitlines() if line.startswith("word"))
        check("Markdown wrap auto wraps the word paragraph; none retains it",
              longest(markdown_bytes["auto"]) <= 40 and longest(markdown_bytes["none"]) > 300,
              autoParagraphMaxLineLength=longest(markdown_bytes["auto"]), noneParagraphMaxLineLength=longest(markdown_bytes["none"]),
              columnsCaveat="Columns is a soft wrap width; the 44-character reference definition is not broken.")
        check("Markdown preserve retains the explicit source soft break",
              b"PRESERVE_SOFT_ALPHA\nPRESERVE_SOFT_BETA" in markdown_bytes["preserve"]
              and b"PRESERVE_SOFT_ALPHA PRESERVE_SOFT_BETA" in markdown_bytes["none"])
        crlf = markdown_bytes["crlf"]
        check("Markdown --eol crlf has CRLF only; --eol lf has no CR",
              b"\r\n" in crlf and b"\n" not in crlf.replace(b"\r\n", b"") and b"\r" not in markdown_bytes["none"],
              crlfCount=crlf.count(b"\r\n"), bareLfCount=crlf.replace(b"\r\n", b"").count(b"\n"))
        check("Markdown ATX headings, reference links and ASCII option affect real bytes",
              markdown_bytes["none"].startswith(b"# QA_MARKDOWN_OPTIONS") and b"[qa-link]:" in markdown_bytes["none"]
              and all(byte < 128 for byte in markdown_bytes["ascii"]),
              referenceDefinition=[line for line in markdown_bytes["none"].decode().splitlines() if "[qa-link]:" in line],
              asciiExcerpt=markdown_bytes["ascii"].decode().splitlines()[-1])

        ast_paths = [output / "source-lf.json", output / "source-crlf.json"]
        asts = []
        for source_path, ast_path in zip([source, crlf_source], ast_paths):
            run(["--from", "markdown", "--to", "json", "--output", ast_path, source_path])
            asts.append(json.loads(ast_path.read_bytes()))
        check("UTF-8 LF and CRLF fixtures produce identical Pandoc ASTs", asts[0] == asts[1],
              sourceCrLfCount=crlf_source.read_bytes().count(b"\r\n"), lfSourceCrCount=source.read_bytes().count(b"\r"))
        yaml_ast_path = output / "yaml-whitelist.json"
        run(["--from", "markdown", "--to", "json", "--output", yaml_ast_path, yaml_cases])
        yaml_meta = json.loads(yaml_ast_path.read_bytes())["meta"]
        check("YAML fixture distinguishes false from string false and retains unknown keys for App filtering",
              yaml_meta["typora-sidebar"] == {"t": "MetaBool", "c": False}
              and yaml_meta["sidebar"]["t"] == "MetaInlines"
              and yaml_meta["runCommand"] == {"t": "MetaBool", "c": True}
              and "pandocPath" in yaml_meta,
              metaKeys=sorted(yaml_meta), booleanFalse=yaml_meta["typora-sidebar"], stringFalse=yaml_meta["sidebar"],
              note="Pandoc YAML parsing is proven. This does not verify or implement the application's export whitelist.")
        long_html = output / "long-document.html"
        run([*common, "--to", "html5", "--output", long_html, long_source])
        long_result = long_html.read_text(encoding="utf-8")
        check("Long fixture survives a real conversion with all 80 sections and both endpoints",
              "QA_LONG_TOP" in long_result and "QA_LONG_BOTTOM" in long_result
              and all(f"QA_LONG_SECTION_{i:03d}" in long_result for i in range(1, 81)),
              sections=80, outputBytes=long_html.stat().st_size,
              note="HTML content sanity only; PNG/PDF sizing and pagination require App/native consumer verification.")

        # Compare source bytes after every conversion. Output files are always
        # distinct paths and Pandoc receives no command line assembled by a shell.
        check("CLI baseline leaves every source and asset byte unchanged",
              all(sha256((WORK / path).read_bytes()) == digest for path, digest in source_hashes.items()), sourceSha256=source_hashes)
        markdown_options = {"reader": "markdown", "writer": "markdown", "commonArguments": markdown_common,
                            "variants": variants, "source": str(markdown_source),
                            "note": "CLI argument samples, not the App's setting schema. Map hardLineWrap/columns/eol/reference-links/reference-location/markdown-headings/ascii to these proven CLI behaviors."}
        save_text(WORK / "markdown-options.json", json.dumps(markdown_options, ensure_ascii=False, indent=2) + "\n")
        files = [source, crlf_source, yaml_cases, long_source, markdown_source, image, css, reference, template,
                 WORK / "markdown-options.json", WORK / "pandoc-help.txt", WORK / "pandoc-version.txt", *sorted(output.iterdir())]
        inventory = [{"path": str(path), "relativePath": str(path.relative_to(WORK)), "bytes": path.stat().st_size, "sha256": sha256(path.read_bytes())} for path in files]
        manifest = {"scope": evidence["scope"], "source": str(source), "sourceCRLF": str(crlf_source), "yamlWhitelistSource": str(yaml_cases),
                    "longDocumentSource": str(long_source), "image": str(image), "imageDimensions": [28, 18],
                    "referenceDocx": str(reference), "opendocumentTemplate": str(template), "epubCss": str(css),
                    "markdownOptions": str(WORK / "markdown-options.json"), "markers": {"docxStyleName": STYLE_NAME, "docxStyleId": STYLE_ID,
                    "docxStyleColor": STYLE_COLOR, "odtTemplate": TEMPLATE_MARKER, "extraMetadata": METADATA_MARKER, "epubCss": CSS_MARKER,
                    "headings": HEADING_MARKERS, "longTop": "QA_LONG_TOP", "longBottom": "QA_LONG_BOTTOM"}, "files": inventory}
        save_text(WORK / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        evidence["manifest"] = str(WORK / "manifest.json")
        evidence["files"] = inventory
        evidence["passed"] = True
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
    finally:
        EVIDENCE.parent.mkdir(exist_ok=True)
        save_text(EVIDENCE, json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    for item in evidence["checks"]:
        print(("PASS " if item["passed"] else "FAIL ") + item["name"])
    print(json.dumps({"passed": evidence["passed"], "fixtureRoot": str(WORK), "evidence": str(EVIDENCE), "error": evidence.get("error")}, ensure_ascii=False))
    return 0 if evidence["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
