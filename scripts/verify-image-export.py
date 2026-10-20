#!/usr/bin/env python3
"""Prepare a real AppKit/WebKit verifier, or collect its completed results.

Run without arguments to build .cache/image-export-verifier/Verifier.app.
Open that exact bundle in Finder through the native computer-use tool. After
the first launch, get_app_state can find its printed bundle identifier. This script
does not launch GUI processes through a shell or change system permissions.
After its PASS/FAIL window appears, run --collect to inspect real PNG pixels,
save evidence, and remove temporary fixtures. Use --collect --keep-cache only
when diagnosing a failure. The app's Close verifier button ends its UI.
"""
import argparse
import datetime
import hashlib
import json
import platform
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import uuid
import zlib

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.cache/image-export-verifier'
APP = WORK / 'Verifier.app'
EVIDENCE = ROOT / 'evidence/image-export-verification.json'

RUNNER = r'''
import AppKit
import WebKit

@MainActor final class ImageExportVerifier: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var log: NSTextView!
    let folder = Bundle.main.bundleURL.deletingLastPathComponent()
    var checks: [[String: Any]] = []
    var pngs: [[String: Any]] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 820, height: 560),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Image export verification — RUNNING"
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 820, height: 560))
        let scroll = NSScrollView(frame: NSRect(x: 20, y: 60, width: 780, height: 480))
        scroll.hasVerticalScroller = true
        log = NSTextView(frame: scroll.bounds)
        log.isEditable = false
        log.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        scroll.documentView = log
        content.addSubview(scroll)
        let close = NSButton(title: "Close verifier", target: self, action: #selector(closeVerifier))
        close.frame = NSRect(x: 650, y: 15, width: 150, height: 32)
        content.addSubview(close)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        append("Real WKWebView snapshot verification. No simulated renderer.\n")
        Task { await run() }
    }

    func append(_ text: String) { log.string += text; log.scrollToEndOfDocument(nil) }
    @objc func closeVerifier() {
        window.title = "Closing verifier"
        // Native app tools inspect the app after clicking. Delay termination so
        // that inspection does not relaunch a just-terminated verifier.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { NSApp.terminate(nil) }
    }
    func record(_ name: String, _ passed: Bool, _ detail: [String: Any] = [:]) {
        checks.append(["name": name, "passed": passed, "detail": detail])
        append("\(passed ? "PASS" : "FAIL") \(name)\n")
    }
    func input(_ name: String) throws -> String {
        try String(contentsOf: folder.appendingPathComponent(name + ".html"), encoding: .utf8)
    }
    func pixel(_ rep: NSBitmapImageRep, _ x: Int, _ y: Int) -> [Int] {
        guard rep.bitsPerSample == 8, rep.samplesPerPixel >= 3 else { return [] }
        // Compare stored PNG samples. NSColor converts through the display's
        // profile and changes sample values even for a tagged sRGB image.
        var samples = [Int](repeating: 0, count: rep.samplesPerPixel)
        samples.withUnsafeMutableBufferPointer { buffer in rep.getPixel(buffer.baseAddress!, atX: x, y: y) }
        return Array(samples.prefix(3))
    }
    func near(_ a: [Int], _ b: [Int]) -> Bool {
        a.count == 3 && zip(a, b).allSatisfy { abs($0.0 - $0.1) <= 4 }
    }
    func verifyPNG(_ name: String, expectedHeight: Int, resourceY: Int? = nil) async {
        let destination = folder.appendingPathComponent(name + ".png")
        do {
            let result = try await FullDocumentImageExporter.export(html: input(name), baseURL: folder,
                destination: destination, width: 320, timeout: 20, tileHeight: 512)
            guard let pngData = try? Data(contentsOf: destination), let rep = NSBitmapImageRep(data: pngData) else {
                record("\(name): PNG decode", false); return
            }
            let top = pixel(rep, 10, 10), bottom = pixel(rep, 10, rep.pixelsHigh - 10)
            let dimensions = rep.pixelsWide == 320 && rep.pixelsHigh == expectedHeight && result.width == 320 && result.height == expectedHeight
            let endpoints = near(top, [229, 57, 53]) && near(bottom, [21, 101, 192])
            var detail: [String: Any] = ["width": rep.pixelsWide, "height": rep.pixelsHigh,
                "tileCount": result.tileCount, "topRGB": top, "bottomRGB": bottom]
            var ok = dimensions && endpoints && result.tileCount == (expectedHeight + 511) / 512
            if let y = resourceY {
                let green = pixel(rep, 10, y)
                detail["resourceRGB"] = green
                ok = ok && near(green, [46, 125, 50])
                let fontReady = pixel(rep, 250, 50)
                detail["fontReadyRGB"] = fontReady
                ok = ok && near(fontReady, [46, 125, 50])
            }
            // A repeated first viewport can still pass a top/bottom-only test.
            // Every long-document seam has a separate known alternating band.
            if name == "long" {
                var seamColors: [[String: Any]] = []
                for y in stride(from: 511, to: expectedHeight - 43, by: 512) {
                    let expected = ((y - 37) / 173) % 2 == 0 ? [243, 229, 171] : [121, 134, 203]
                    let actual = pixel(rep, 10, y)
                    seamColors.append(["y": y, "rgb": actual, "expected": expected])
                    ok = ok && near(actual, expected)
                }
                detail["seamColors"] = seamColors
            }
            pngs.append(["name": name, "path": destination.path, "width": rep.pixelsWide, "height": rep.pixelsHigh])
            record("\(name): full-document dimensions, endpoints and tile pixels", ok, detail)
        } catch { record("\(name): real WebKit image export", false, ["error": error.localizedDescription]) }
        try? await Task.sleep(nanoseconds: 100_000_000)
        let owned = NSApp.windows.filter { $0.identifier?.rawValue == "TyporaReplica.ImageExport" }
        let live = owned.filter { $0.isVisible || $0.contentView != nil }.count
        record("\(name): hidden export window closed and detached", live == 0 && owned.count <= 1,
               ["liveExportWindowCount": live, "closedWindowObjects": owned.count, "applicationWindowCount": NSApp.windows.count])
    }

    func expectedFailure(_ name: String, html: String, timeout: TimeInterval = 5,
                         maxPixelCount: Int = 100_000_000, pixelScale: CGFloat = 1) async {
        let destination = folder.appendingPathComponent("preserved-\(name).png")
        let sentinel = Data("ORIGINAL_\(name)".utf8)
        do {
            try sentinel.write(to: destination)
            _ = try await FullDocumentImageExporter.export(html: html, baseURL: folder, destination: destination,
                width: 320, timeout: timeout, tileHeight: 512, maxPixelCount: maxPixelCount, pixelScale: pixelScale)
            record("\(name): failure preserves destination", false, ["error": "Unexpected success"])
        } catch {
            let preserved = (try? Data(contentsOf: destination)) == sentinel
            let expected: Bool
            switch (name, error) {
            case ("timeout", FullDocumentImageExportError.timedOut): expected = true
            case ("missing-image", FullDocumentImageExportError.resourceFailed): expected = true
            case ("pixel-limit", FullDocumentImageExportError.documentTooLarge): expected = true
            case ("scaled-pixel-limit", FullDocumentImageExportError.documentTooLarge): expected = true
            default: expected = false
            }
            record("\(name): failure preserves destination", preserved && expected,
                   ["preserved": preserved, "error": error.localizedDescription, "expectedError": expected])
        }
    }

    func verifyPositionedContent(scale: Int = 1) async {
        let name = scale == 1 ? "positioned" : "positioned-\(scale)x"
        let destination = folder.appendingPathComponent(name + ".png")
        do {
            let result = try await FullDocumentImageExporter.export(html: input("positioned"), baseURL: folder,
                destination: destination, width: 320, timeout: 20, tileHeight: 512, pixelScale: CGFloat(scale))
            let data = try Data(contentsOf: destination)
            guard let rep = NSBitmapImageRep(data: data) else { record("positioned: PNG decode", false); return }
            let probes: [(String, Int, [Int], Int, Int)] = [
                ("viewportFixedTop", 10, [229,57,53], 0, 19),
                ("viewportFixedBottom", 310, [21,101,192], 4196, 23),
                ("stickyInNormalFlow", 10, [142,36,170], 113, 31),
                ("transformedFixedTop", 30, [46,125,50], 1060, 29),
                ("transformedFixedBottom", 160, [255,152,0], 1155, 17),
            ]
            var samples: [[String: Any]] = []
            var ok = rep.pixelsWide == 320*scale && rep.pixelsHigh == 4219*scale && result.width == 320*scale && result.height == 4219*scale && result.tileCount == 9
            for (name, x, rgb, start, length) in probes {
                let rows = (0..<rep.pixelsHigh).filter { near(pixel(rep, x*scale, $0), rgb) }
                let expected = Array((start*scale)..<((start + length)*scale))
                let passed = rows == expected
                samples.append(["element": name, "passed": passed, "rows": rows,
                    "expectedStart": start*scale, "expectedLength": length*scale])
                ok = ok && passed
            }
            pngs.append(["name": name, "path": destination.path, "width": rep.pixelsWide, "height": rep.pixelsHigh, "scale": scale])
            record("\(name): fixed/sticky occur once with flow and transformed containing blocks preserved", ok,
                ["width": rep.pixelsWide, "height": rep.pixelsHigh, "tileCount": result.tileCount,
                 "lastTileRows": 123, "samples": samples])
        } catch { record("\(name): real WebKit export", false, ["error": error.localizedDescription]) }
    }

    func verifyScaledSampling() async {
        for scale in 1...3 {
            let name="sampling-\(scale)x", destination=folder.appendingPathComponent("sampling-\(scale)x.png")
            do {
                let result=try await FullDocumentImageExporter.export(html:input("sampling"),baseURL:folder,destination:destination,width:320,timeout:20,tileHeight:512,pixelScale:CGFloat(scale))
                let data=try Data(contentsOf:destination)
                guard let rep=NSBitmapImageRep(data:data) else { record("\(name): decode",false);continue }
                let values=(0..<(12*scale)).map { pixel(rep,40*scale+$0,43*scale).first ?? -1 }
                let crisp=values.filter{$0>=0&&($0<35||$0>220)}.count
                let ok=rep.pixelsWide==320*scale&&rep.pixelsHigh==333*scale&&result.width==rep.pixelsWide&&result.height==rep.pixelsHigh&&result.tileCount==1&&(scale != 3 || crisp>=30)
                pngs.append(["name":name,"path":destination.path,"width":rep.pixelsWide,"height":rep.pixelsHigh,"scale":scale])
                record("\(name): physical dimensions and vector subpixel sampling",ok,["width":rep.pixelsWide,"height":rep.pixelsHigh,"stripeValues":values,"crispSamples":crisp])
            } catch { record("\(name): real WebKit export",false,["error":error.localizedDescription]) }
        }
    }

    func run() async {
        await verifyPNG("short", expectedHeight: 333)
        await verifyPNG("long", expectedHeight: 9377)
        await verifyPNG("resources", expectedHeight: 2801, resourceY: 2721)
        await verifyPositionedContent()
        await verifyPositionedContent(scale:2)
        await verifyPositionedContent(scale:3)
        await verifyScaledSampling()
        await expectedFailure("missing-image", html: "<!doctype html><body><img src='missing-resource.png'></body>")
        await expectedFailure("timeout", html: "<!doctype html><body><script>Object.defineProperty(document,'fonts',{value:{ready:new Promise(()=>{})}})</script>Waiting</body>", timeout: 0.25)
        await expectedFailure("pixel-limit", html: (try? input("long")) ?? "", maxPixelCount: 1000)
        await expectedFailure("scaled-pixel-limit", html: (try? input("long")) ?? "", maxPixelCount: 4_000_000, pixelScale:3)
        let destination = folder.appendingPathComponent("preserved-cancel.png")
        let sentinel = Data("ORIGINAL_CANCEL".utf8)
        do {
            try sentinel.write(to: destination)
            let html = try input("long")
            let task = Task { try await FullDocumentImageExporter.export(html: html, baseURL: folder,
                destination: destination, width: 320, timeout: 20, tileHeight: 512) }
            try await Task.sleep(nanoseconds: 60_000_000)
            task.cancel()
            do {
                _ = try await task.value
                record("in-flight cancellation preserves destination", false, ["error": "Unexpected success"])
            } catch {
                record("in-flight cancellation preserves destination", error is CancellationError && (try? Data(contentsOf: destination)) == sentinel,
                       ["error": error.localizedDescription, "isCancellation": error is CancellationError])
            }
        } catch { record("cancellation setup", false, ["error": error.localizedDescription]) }
        try? await Task.sleep(nanoseconds: 200_000_000)
        let owned = NSApp.windows.filter { $0.identifier?.rawValue == "TyporaReplica.ImageExport" }
        let live = owned.filter { $0.isVisible || $0.contentView != nil }.count
        record("success, failure and cancellation close all hidden windows", live == 0 && owned.count <= 1,
               ["liveExportWindowCount": live, "closedWindowObjects": owned.count, "applicationWindowCount": NSApp.windows.count])
        let passed = checks.allSatisfy { $0["passed"] as? Bool == true }
        let result: [String: Any] = ["ok": passed, "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "environment": "Real AppKit/WKWebView application launched by native app tool",
            "checks": checks, "pngs": pngs, "completedAt": ISO8601DateFormatter().string(from: Date())]
        do {
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: folder.appendingPathComponent("result.json"), options: .atomic)
        } catch { append("FAIL result write: \(error.localizedDescription)\n") }
        window.title = "\(passed ? "PASS" : "FAIL") image export \(checks.filter { $0["passed"] as? Bool == true }.count)/\(checks.count)"
        append("\n\(window.title)\n")
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main struct VerifyImageExport {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = ImageExportVerifier()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}
'''


def png(width, height, rgb):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    rows = (b'\0' + bytes(rgb) * width) * height
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


def prepare():
    WORK.mkdir(parents=True, exist_ok=True)
    resources = APP / 'Contents/Resources'
    executable = APP / 'Contents/MacOS/Verifier'
    resources.mkdir(parents=True, exist_ok=True)
    executable.parent.mkdir(parents=True, exist_ok=True)
    (WORK / 'result.json').unlink(missing_ok=True)
    (WORK / 'Runner.swift').write_text(RUNNER)
    (WORK / 'asset 图 #%.png').write_bytes(png(48, 36, [46, 125, 50]))
    font = ROOT / 'node_modules/@fontsource/open-sans/files/open-sans-latin-400-normal.woff2'
    shutil.copyfile(font, WORK / 'qa-font.woff2')
    css = '<style>html,body{margin:0;padding:0}body{width:320px}div{box-sizing:border-box}.top{height:37px;background:#e53935}.bottom{height:43px;background:#1565c0}</style>'
    (WORK / 'short.html').write_text('<!doctype html>' + css + '<body><div class="top"></div><div style="height:253px;background:#f3e5ab"></div><div class="bottom"></div></body>')
    bands, remaining, index = [], 9377 - 37 - 43, 0
    while remaining:
        height = min(173, remaining)
        color = '#f3e5ab' if index % 2 == 0 else '#7986cb'
        bands.append(f'<div style="height:{height}px;background:{color}"></div>')
        remaining -= height
        index += 1
    (WORK / 'long.html').write_text('<!doctype html>' + css + '<body><div class="top"></div>' + ''.join(bands) + '<div class="bottom"></div></body>')
    asset = 'asset%20%E5%9B%BE%20%23%25.png'
    (WORK / 'resources.html').write_text('<!doctype html>' + css + '''<style>@font-face{font-family:QAFace;src:url('qa-font.woff2')}body{font-family:QAFace}#font{height:63px;background:red}</style><body><div class="top"></div><div id="font">Font readiness</div><div style="height:2610px;background:#f3e5ab"></div>''' + f'<img loading="lazy" src="{asset}" style="display:block;width:48px;height:36px"><div style="height:12px"></div><div class="bottom"></div>' + '''<script>document.fonts.ready.then(()=>{document.querySelector('#font').style.backgroundColor=document.fonts.check('16px QAFace')?'#2e7d32':'red'})</script></body>''')
    (WORK / 'positioned.html').write_text('''<!doctype html><style>html,body{margin:0;padding:0;scroll-behavior:smooth!important;scroll-snap-type:y mandatory!important}body{width:320px}div{box-sizing:border-box}</style><body>
<div style="height:113px;background:#eee"></div>
<div style="position:sticky;top:0;height:31px;background:#8e24aa"></div>
<div style="height:899px;background:#eee"></div>
<div style="position:relative;transform:translateZ(0);width:200px;height:140px;background:#ddd">
 <div style="position:fixed;top:17px;left:25px;width:41px;height:29px;background:#2e7d32"></div>
 <div style="position:fixed;bottom:11px;right:13px;width:33px;height:17px;background:#ff9800"></div>
</div><div style="height:3036px;background:#eee"></div>
<div style="position:fixed;top:0;left:0;width:50px;height:19px;background:#e53935"></div>
<div style="position:fixed;bottom:0;right:0;width:50px;height:23px;background:#1565c0"></div></body>''')
    stripes=''.join(f'<rect x="{index/3:.8f}" y="0" width="{1/3:.8f}" height="12" fill="{"black" if index%2==0 else "white"}"/>' for index in range(36))
    (WORK / 'sampling.html').write_text('<!doctype html>'+css+'<body><div class="top"></div><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" style="display:block;margin-left:40px">'+stripes+'</svg><div style="height:241px;background:#f3e5ab"></div><div class="bottom"></div></body>')
    previous = json.loads(EVIDENCE.read_text()) if EVIDENCE.exists() else {}
    bundle_id = previous.get('bundleIdentifier') if previous.get('verifierBundle') == str(APP) else None
    bundle_id = bundle_id or 'com.openai.typora-replica.image-export-verifier.' + uuid.uuid4().hex
    (APP / 'Contents/Info.plist').write_text(f'''<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Verifier</string><key>CFBundleIdentifier</key><string>{bundle_id}</string><key>CFBundleName</key><string>Image Export Verifier</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/><key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>''')
    compile_result = subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library',
        '-target', platform.machine() + '-apple-macosx13.0', '-module-cache-path', str(ROOT / '.cache/swift'),
        str(ROOT / 'native/ImageExport.swift'), str(WORK / 'Runner.swift'), '-o', str(executable),
        '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers'], cwd=ROOT, capture_output=True, text=True, timeout=90)
    signature = None
    if compile_result.returncode == 0:
        signed = subprocess.run(['codesign', '--force', '--sign', '-', str(APP)], cwd=ROOT, capture_output=True, text=True, timeout=30)
        signature = {'passed': signed.returncode == 0, 'diagnostics': signed.stderr.strip()}
    evidence = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'exporterSourceSHA256': hashlib.sha256((ROOT / 'native/ImageExport.swift').read_bytes()).hexdigest(),
        'compiler': {'passed': compile_result.returncode == 0, 'target': 'macOS 13 / Swift 5', 'diagnostics': compile_result.stderr.strip()},
        'adHocSignature': signature,
        'actualWebKit': {'status': 'not-yet-run'}, 'verifierBundle': str(APP), 'bundleIdentifier': bundle_id,
        'launchMethod': 'Native Finder Open on this exact .app path; then get_app_state by unique bundle identifier. No shell GUI launch or external escalation.'}
    if previous.get('positionedBaseline'):
        evidence['positionedBaseline'] = previous['positionedBaseline']
    if previous.get('harness'):
        evidence['harness'] = previous['harness']
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: value for key, value in evidence.items() if key != 'positionedBaseline'}, ensure_ascii=False, indent=2))
    return 0 if compile_result.returncode == 0 and signature and signature['passed'] else 1


def collect(keep_cache, baseline=False):
    from PIL import Image
    evidence = json.loads(EVIDENCE.read_text())
    result_file = WORK / 'result.json'
    if not result_file.is_file():
        evidence['actualWebKit'] = {'status': 'blocked', 'reason': 'Verifier did not produce result.json. No real PNG evidence is claimed.'}
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(evidence['actualWebKit'], ensure_ascii=False))
        return 1
    result = json.loads(result_file.read_text())
    if result.get('bundleIdentifier') != evidence.get('bundleIdentifier'):
        raise RuntimeError('The result belongs to a different verifier bundle. Launch the newly built app first.')
    if baseline:
        evidence['positionedBaseline'] = {'environment': result['environment'], 'completedAt': result['completedAt'],
            'checks': [check for check in result['checks'] if check['name'].startswith('positioned:')],
            'fixtureSHA256': hashlib.sha256((WORK / 'positioned.html').read_bytes()).hexdigest(),
            'smoothScrollImportant': 'scroll-behavior:smooth!important' in (WORK / 'positioned.html').read_text(),
            'sourceSHA256': hashlib.sha256((ROOT / 'native/ImageExport.swift').read_bytes()).hexdigest()}
        EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'baselineSaved': True, 'checks': [
            {'name': check['name'], 'passed': check['passed'], 'samples': [
                {'element': sample['element'], 'passed': sample['passed'], 'matchedRows': len(sample['rows'])}
                for sample in check.get('detail', {}).get('samples', [])]}
            for check in evidence['positionedBaseline']['checks']]}, ensure_ascii=False, indent=2))
        return 0
    verification = []
    for item in result.get('pngs', []):
        path = Path(item['path'])
        with Image.open(path) as image:
            image.load()
            pixels = image.convert('RGB')
            scale=item.get('scale',1)
            top, bottom = list(pixels.getpixel((10*scale, 10*scale))), list(pixels.getpixel(((310 if item['name'].startswith('positioned') else 10)*scale, pixels.height - 10*scale)))
            passed = image.size == (320*scale, item['height']) and all(abs(a-b) <= 4 for a,b in zip(top,[229,57,53])) and all(abs(a-b) <= 4 for a,b in zip(bottom,[21,101,192]))
            decoded = {'name': item['name'], 'passed': passed, 'width': image.width, 'height': image.height, 'topRGB': top, 'bottomRGB': bottom}
            if item['name'].startswith('positioned'):
                checks = []
                for name, x, rgb, start, length in [
                    ('viewportFixedTop', 10, (229,57,53), 0, 19),
                    ('viewportFixedBottom', 310, (21,101,192), 4196, 23),
                    ('stickyInNormalFlow', 10, (142,36,170), 113, 31),
                    ('transformedFixedTop', 30, (46,125,50), 1060, 29),
                    ('transformedFixedBottom', 160, (255,152,0), 1155, 17)]:
                    rows = [y for y in range(pixels.height) if all(abs(a-b) <= 4 for a,b in zip(pixels.getpixel((x*scale,y)), rgb))]
                    correct = rows == list(range(start*scale, (start + length)*scale))
                    checks.append({'element': name, 'passed': correct, 'firstRow': rows[0] if rows else None, 'matchedRows': len(rows)})
                    decoded['passed'] = decoded['passed'] and correct
                decoded['positionedSamples'] = checks
            if item['name'].startswith('sampling'):
                values=[pixels.getpixel((40*scale+x,43*scale))[0] for x in range(12*scale)]
                decoded['stripeValues']=values
                decoded['crispSamples']=sum(value<35 or value>220 for value in values)
                if scale==3:
                    decoded['passed']=decoded['passed'] and decoded['crispSamples']>=30
                    pixels.crop((120,111,156,147)).resize((288,288),resample=Image.Resampling.NEAREST).save(ROOT/'evidence/image-export-3x-sampling-proof.png')
            verification.append(decoded)
            if item['name'] == 'short':
                shutil.copyfile(path, ROOT / 'evidence/image-export-short.png')
            if item['name'] == 'long':
                proof = Image.new('RGB', (320, 192))
                proof.paste(pixels.crop((0, 0, 320, 96)), (0, 0))
                proof.paste(pixels.crop((0, pixels.height - 96, 320, pixels.height)), (0, 96))
                proof.save(ROOT / 'evidence/image-export-long-proof.png')
            if item['name'] == 'positioned':
                proof = Image.new('RGB', (320, 256))
                for index, y in enumerate([0, 100, 1050, pixels.height - 64]):
                    proof.paste(pixels.crop((0, y, 320, y + 64)), (0, index * 64))
                proof.save(ROOT / 'evidence/image-export-positioned-proof.png')
    result['independentPNGDecode'] = verification
    result['exporterSourceUnchangedSinceBuild'] = evidence.get('exporterSourceSHA256') == hashlib.sha256((ROOT / 'native/ImageExport.swift').read_bytes()).hexdigest()
    result['positionedFixture'] = {'sha256': hashlib.sha256((WORK / 'positioned.html').read_bytes()).hexdigest(),
        'smoothScrollImportant': 'scroll-behavior:smooth!important' in (WORK / 'positioned.html').read_text(),
        'scrollSnapImportant': 'scroll-snap-type:y mandatory!important' in (WORK / 'positioned.html').read_text()}
    result['status'] = 'passed' if result.get('ok') and result['exporterSourceUnchangedSinceBuild'] and len(verification) == 9 and all(item['passed'] for item in verification) else 'failed'
    evidence['actualWebKit'] = result
    evidence['launchMethod'] = 'Native Finder Open on this exact .app path; then get_app_state by unique bundle identifier. No shell GUI launch or external escalation.'
    evidence['retainedImages'] = ['evidence/image-export-short.png', 'evidence/image-export-long-proof.png', 'evidence/image-export-positioned-proof.png','evidence/image-export-3x-sampling-proof.png']
    evidence['actualWebKit']['temporaryPNGsRemoved'] = result['status'] == 'passed' and not keep_cache
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'checks': len(result['checks']), 'pngs': verification}, ensure_ascii=False, indent=2))
    if result['status'] == 'passed' and not keep_cache:
        shutil.rmtree(WORK)
        for suffix in ('swiftmodule', 'swiftdoc', 'swiftsourceinfo'):
            (ROOT / '.cache' / ('ImageExport.' + suffix)).unlink(missing_ok=True)
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collect', action='store_true')
    parser.add_argument('--keep-cache', action='store_true')
    parser.add_argument('--baseline', action='store_true', help='With --collect, retain the real pre-fix positioned-content result')
    options = parser.parse_args()
    sys.exit(collect(options.keep_cache, options.baseline) if options.collect else prepare())
