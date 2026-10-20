"""Compile the real native helper; verify portable image bytes without a browser."""
import base64
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import zlib

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / 'evidence/export-assets-verification.json'


def png(red, green, blue):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + bytes([red, green, blue]) * 2) * 2)) + chunk(b'IEND', b'')


class Images(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.images = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        if tag.lower() == 'img':
            self.images.append(dict(attrs))


SWIFT_MAIN = r'''
import AppKit
import Foundation

let input = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let requests = try JSONSerialization.jsonObject(with: input) as! [[String: Any]]
var outputs: [[String: Any]] = []
for request in requests {
    let html = request["html"] as! String
    let document = (request["document"] as? String).map { URL(fileURLWithPath: $0) }
    let result = embedLocalExportImages(in: html, documentURL: document)
    let pattern = try! NSRegularExpression(pattern: "data:image/png;base64,([A-Za-z0-9+/=]+)")
    let ns = result.html as NSString
    let matches = pattern.matches(in: result.html, range: NSRange(location: 0, length: ns.length))
    let decoded = matches.map { match -> Bool in
        guard let data = Data(base64Encoded: ns.substring(with: match.range(at: 1))), let bitmap = NSBitmapImageRep(data: data) else { return false }
        return bitmap.pixelsWide == 2 && bitmap.pixelsHigh == 2
    }
    outputs.append(["html": result.html, "embeddedCount": result.embeddedCount, "issues": result.issues.map { ["source": $0.source, "reason": $0.reason] }, "pngDecodes": decoded])
}
let output = try JSONSerialization.data(withJSONObject: outputs, options: [.sortedKeys])
FileHandle.standardOutput.write(output)
'''


def run():
    checks = []
    def check(name, condition):
        checks.append({'name': name, 'ok': bool(condition)})
        if not condition:
            raise AssertionError(name)

    with tempfile.TemporaryDirectory(prefix='typora-export-assets-') as temporary:
        work = Path(temporary)
        source = work / 'original docs #100%'
        source.mkdir()
        document = source / 'notes.md'
        document.write_text('# Images')
        output = work / 'different export folder'
        output.mkdir()
        first = png(22, 99, 211)
        second = png(234, 21, 89)
        names = ['plain.png', '空格 photo 100%#? (1).png', 'literal%20.png', 'a&b(2).png', 'A©.png', 'single\'quote.png']
        for index, name in enumerate(names):
            (source / name).write_bytes(second if index == 2 else first)
        (source / 'a&amp;b.png').write_bytes(first)
        (source / 'a&b.png').write_bytes(second)
        (work / 'parent.png').write_bytes(second)
        (work / 'main.swift').write_text(SWIFT_MAIN)
        executable = work / 'verify'
        subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(ROOT / '.cache/swift'), str(ROOT / 'native/ExportAssets.swift'), str(work / 'main.swift'), '-o', str(executable), '-framework', 'AppKit', '-framework', 'UniformTypeIdentifiers'], check=True, cwd=ROOT)

        def call(requests):
            request_file = work / 'requests.json'
            request_file.write_text(json.dumps(requests, ensure_ascii=False))
            proc = subprocess.run([str(executable), str(request_file)], check=True, capture_output=True, text=True, timeout=20)
            return json.loads(proc.stdout)

        def request(markup, doc=str(document)):
            return {'html': markup, 'document': doc}

        encoded_special = '空格%20photo%20100%25%23%3F%20(1).png'
        refs = ['plain.png', names[1], encoded_special, 'literal%2520.png', 'a&amp;b&#40;2&#41;.png', 'A&copy;.png', 'single&#39;quote.png', (source / names[1]).as_uri(), '../parent.png', str(work / 'parent.png')]
        expected = [first, first, first, second, first, first, first, first, second, second]
        inputs = [request('<img alt="unchanged &amp; >" src="' + ref + '" data-keep="exact">') for ref in refs]
        results = call(inputs)
        for index, (result, original, byte_data) in enumerate(zip(results, inputs, expected)):
            attrs = Images(result['html']).images[0]
            data_uri = attrs['src']
            check(f'path_{index}_embeds_exact_bytes', result['embeddedCount'] == 1 and not result['issues'] and base64.b64decode(data_uri.split(',', 1)[1]) == byte_data)
            check(f'path_{index}_png_decodes', result['pngDecodes'] == [True])
            check(f'path_{index}_unrelated_html_exact', result['html'] == original['html'].replace('src="' + refs[index] + '"', 'src="' + data_uri + '"'))
            (output / f'image-{index}.html').write_text(result['html'])

        preserved = ['https://example.test/p.png?a=1&amp;b=2', 'http://example.test/a.png', '//example.test/a.png', 'data:image/png;base64,' + base64.b64encode(first).decode(), 'blob:example', '#same-document', 'custom:abc']
        for i, result in enumerate(call([request(f"<img src='{ref}'>") for ref in preserved])):
            check(f'remote_{i}_unchanged', result['html'] == f"<img src='{preserved[i]}'>" and result['embeddedCount'] == 0 and not result['issues'])

        raw_source = '<!DOCTYPE html PUBLIC "<img src=plain.png>"><!-- <img src="plain.png"> --><script>const s = \'<img src="plain.png">\'</script><style>x{content:\'<img src="plain.png">\'}</style><textarea><img src="plain.png"></textarea><title><img src="plain.png"></title><![CDATA[<img src="plain.png">]]>'
        duplicate, missing, unsaved, unquoted, raw = call([
            request('<img src="plain.png"><IMG SRC=plain.png>'),
            request('<img src="missing &amp; absent.png" data-x="same">'),
            request('<img src="plain.png">', None),
            request('<img data-x=x src=plain.png title=y>'),
            request(raw_source),
        ])
        check('duplicate_two_embeddings', duplicate['embeddedCount'] == 2 and duplicate['pngDecodes'] == [True, True])
        check('missing_preserves_original_and_reports', missing['html'] == '<img src="missing &amp; absent.png" data-x="same">' and len(missing['issues']) == 1)
        check('unsaved_relative_preserves_and_reports', unsaved['html'] == '<img src="plain.png">' and len(unsaved['issues']) == 1)
        check('unquoted_attribute_safely_quoted', 'src="data:image/png;base64,' in unquoted['html'] and 'data-x=x' in unquoted['html'] and 'title=y' in unquoted['html'])
        check('raw_text_comments_declarations_unchanged', raw['embeddedCount'] == 0 and not raw['issues'] and raw['html'] == raw_source)

        existing = 'data:image/png;base64,' + base64.b64encode(second).decode()
        srcsets = [
            '<img srcset="plain.png 1x, a&amp;b(2).png 2x, https://example.test/image.png 3x">',
            f'<picture><source srcset="{existing} 1x, plain.png 2x"></picture>',
            '<img srcset="plain.png 400w, ../parent.png 800w">',
            '<img srcset="missing.png 1x, plain.png 2x">',
            '<img srcset="raw space.png 1x, plain.png 2x">',
            '<img srcset="plain.png, ../parent.png">',
            '<img srcset="plain.png,other.png 1x">',
            '<img srcset="plain.png 1x, raw space.png 2x">',
        ]
        setresults = call([request(s) for s in srcsets])
        check('srcset_density_mixed_remote', setresults[0]['embeddedCount'] == 2 and 'https://example.test/image.png 3x' in setresults[0]['html'] and not setresults[0]['issues'])
        check('srcset_existing_data_preserved', setresults[1]['embeddedCount'] == 1 and existing + ' 1x,' in setresults[1]['html'] and setresults[1]['pngDecodes'] == [True, True])
        check('srcset_width_descriptors', setresults[2]['embeddedCount'] == 2 and ' 400w,' in setresults[2]['html'] and ' 800w' in setresults[2]['html'])
        check('srcset_missing_item_preserved', setresults[3]['embeddedCount'] == 1 and 'missing.png 1x,' in setresults[3]['html'] and len(setresults[3]['issues']) == 1)
        check('srcset_raw_space_rejected_without_corruption', setresults[4]['html'] == srcsets[4] and len(setresults[4]['issues']) == 1)
        check('srcset_descriptorless_supported', setresults[5]['embeddedCount'] == 2 and not setresults[5]['issues'])
        check('srcset_ambiguous_comma_preserved', setresults[6]['html'] == srcsets[6] and len(setresults[6]['issues']) == 1)
        check('srcset_late_invalid_candidate_no_phantom_embeds', setresults[7]['html'] == srcsets[7] and setresults[7]['embeddedCount'] == 0 and len(setresults[7]['issues']) == 1)
        fragment = call([request('<img src="plain.png?version=1#view">')])[0]
        check('image_url_fragment_preserved', fragment['embeddedCount'] == 1 and '#view' in fragment['html'] and fragment['pngDecodes'] == [True])
        standalone = (ROOT / 'evidence/export.html').read_text()
        unchanged_standalone = call([request(standalone)])[0]
        check('actual_standalone_fonts_css_preserved', unchanged_standalone['html'] == standalone and unchanged_standalone['embeddedCount'] == 0 and not unchanged_standalone['issues'])
        nested_src, nested_srcset = call([request('<img src="a&amp;amp;b.png">'), request('<img srcset="a&amp;amp;b.png 1x">')])
        nested_src_uri = Images(nested_src['html']).images[0]['src']
        nested_set_uri = Images(nested_srcset['html']).images[0]['srcset'].split(' ', 1)[0]
        check('src_nested_entity_decoded_once', nested_src['embeddedCount'] == 1 and not nested_src['issues'] and base64.b64decode(nested_src_uri.split(',', 1)[1]) == first)
        check('srcset_nested_entity_decoded_once', nested_srcset['embeddedCount'] == 1 and not nested_srcset['issues'] and base64.b64decode(nested_set_uri.split(',', 1)[1]) == first)

        # Reopen exports after removing the entire Markdown/image directory.
        shutil.rmtree(source)
        reopened = call([request(path.read_text(), None) for path in output.glob('*.html')])
        check('different_output_directory_after_source_removed', len(reopened) == 10 and all(r['embeddedCount'] == 0 and r['pngDecodes'] == [True] and not r['issues'] for r in reopened))
        return {'ok': True, 'checks': checks, 'passed': len(checks), 'swiftCompiled': True, 'imageDecoder': 'AppKit NSBitmapImageRep 2x2 PNG', 'sourceDirectoryRemovedBeforeReopen': True, 'networkRequests': 0, 'scope': 'img src; img/source srcset standard x/w/h descriptors. Raw spaces/commas in srcset URLs are preserved with a report. Named HTML entities cover common path punctuation; all valid numeric entities are supported.'}


try:
    evidence = run()
except Exception as error:
    evidence = {'ok': False, 'error': str(error)}
EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(evidence, ensure_ascii=False))
raise SystemExit(0 if evidence['ok'] else 1)
