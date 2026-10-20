import Foundation
import UniformTypeIdentifiers

struct ExportAssetIssue {
    let source: String
    let reason: String
}

struct ExportAssetsResult {
    let html: String
    let embeddedCount: Int
    let issues: [ExportAssetIssue]
}

/// Embeds local image bytes. `documentURL` is the Markdown file URL, never the
/// export destination. No network requests or HTML/JavaScript execution occur.
/// Only image src and img/source srcset values change. Unknown/missing resources
/// stay byte-for-byte intact and appear in issues. Standard srcset x/w/h
/// descriptors are supported; URLs with raw spaces or commas must be encoded.
func embedLocalExportImages(in html: String, documentURL: URL?) -> ExportAssetsResult {
    ExportImageEmbedder(documentURL: documentURL).embed(html)
}

private final class ExportImageEmbedder {
    struct Attribute { let name: String; let range: Range<Int>; let quoted: Bool }
    struct Edit { let range: Range<Int>; let value: [UInt8] }
    let documentURL: URL?
    var issues: [ExportAssetIssue] = []
    var embeddedCount = 0
    var cache: [String: String] = [:]
    var failed = Set<String>()

    init(documentURL: URL?) { self.documentURL = documentURL }
    func space(_ c: UInt8) -> Bool { c == 9 || c == 10 || c == 12 || c == 13 || c == 32 }
    func nameByte(_ c: UInt8) -> Bool { (65...90).contains(c) || (97...122).contains(c) || (48...57).contains(c) || c == 45 || c == 58 || c == 95 }
    func string(_ b: [UInt8], _ r: Range<Int>) -> String { String(decoding: b[r], as: UTF8.self) }
    func isPrefix(_ b: [UInt8], _ start: Int, _ s: String, insensitive: Bool = false) -> Bool {
        let p = Array(s.utf8)
        guard start + p.count <= b.count else { return false }
        for k in p.indices {
            let c = b[start + k]
            if insensitive ? (c >= 65 && c <= 90 ? c + 32 : c) != p[k] : c != p[k] { return false }
        }
        return true
    }
    func endOf(_ b: [UInt8], _ start: Int, _ delimiter: String) -> Int {
        var i = start
        while i < b.count { if isPrefix(b, i, delimiter) { return i + delimiter.utf8.count }; i += 1 }
        return b.count
    }

    func embed(_ html: String) -> ExportAssetsResult {
        let b = Array(html.utf8)
        var edits: [Edit] = []
        var i = 0
        var raw: String?
        while i < b.count {
            if let tag = raw {
                if tag == "plaintext" { break }
                if b[i] == 60 && isPrefix(b, i, "</" + tag, insensitive: true) {
                    let next = i + tag.utf8.count + 2
                    if next == b.count || space(b[next]) || b[next] == 62 || b[next] == 47 { raw = nil }
                    else { i += 1; continue }
                } else { i += 1; continue }
            }
            guard b[i] == 60 else { i += 1; continue }
            if isPrefix(b, i, "<!--") { i = endOf(b, i + 4, "-->"); continue }
            if isPrefix(b, i, "<![CDATA[") { i = endOf(b, i + 9, "]]>"); continue }
            let start = i
            i += 1
            let closing = i < b.count && b[i] == 47
            if closing { i += 1 }
            let nameStart = i
            while i < b.count && nameByte(b[i]) { i += 1 }
            guard i > nameStart else {
                // Declarations may contain quoted '>' and must not expose fake img tags.
                if i < b.count && (b[i] == 33 || b[i] == 63) { i = tagEnd(b, from: i) }
                else { i = start + 1 }
                continue
            }
            let tag = string(b, nameStart..<i).lowercased()
            let end = tagEnd(b, from: i)
            guard end > i, end <= b.count, b[end - 1] == 62 else { break }
            if !closing && (tag == "img" || tag == "source") {
                for a in attributes(b, from: i, to: end - 1) {
                    let original = string(b, a.range)
                    let replacement: String?
                    if tag == "img" && a.name == "src" { replacement = embedded(original) }
                    else if a.name == "srcset" { replacement = srcset(original) }
                    else { continue }
                    if let replacement {
                        let escaped = replacement.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;").replacingOccurrences(of: "<", with: "&lt;")
                        edits.append(Edit(range: a.range, value: Array((a.quoted ? escaped : "\"" + escaped + "\"").utf8)))
                    }
                }
            }
            if !closing && ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"].contains(tag) { raw = tag }
            i = end
        }
        var output: [UInt8] = []
        var cursor = 0
        for e in edits { output.append(contentsOf: b[cursor..<e.range.lowerBound]); output.append(contentsOf: e.value); cursor = e.range.upperBound }
        output.append(contentsOf: b[cursor..<b.count])
        return ExportAssetsResult(html: String(decoding: output, as: UTF8.self), embeddedCount: embeddedCount, issues: issues)
    }

    func tagEnd(_ b: [UInt8], from: Int) -> Int {
        var i = from
        var quote: UInt8?
        while i < b.count {
            let c = b[i]
            if let q = quote { if c == q { quote = nil } }
            else if c == 34 || c == 39 { quote = c }
            else if c == 62 { return i + 1 }
            i += 1
        }
        return b.count
    }
    func attributes(_ b: [UInt8], from: Int, to: Int) -> [Attribute] {
        var result: [Attribute] = []
        var i = from
        var seen = Set<String>()
        while i < to {
            while i < to && (space(b[i]) || b[i] == 47) { i += 1 }
            let start = i
            while i < to && !space(b[i]) && b[i] != 61 && b[i] != 62 { i += 1 }
            guard i > start else { i += 1; continue }
            let name = string(b, start..<i).lowercased()
            while i < to && space(b[i]) { i += 1 }
            guard i < to && b[i] == 61 else { continue }
            i += 1
            while i < to && space(b[i]) { i += 1 }
            guard i < to else { break }
            let quote = b[i] == 34 || b[i] == 39 ? b[i] : nil
            if quote != nil { i += 1 }
            let valueStart = i
            if let quote { while i < to && b[i] != quote { i += 1 } }
            else { while i < to && !space(b[i]) && b[i] != 62 { i += 1 } }
            // HTML keeps the first duplicate attribute.
            if seen.insert(name).inserted { result.append(Attribute(name: name, range: valueStart..<i, quoted: quote != nil)) }
            if quote != nil && i < to { i += 1 }
        }
        return result
    }

    func issue(_ source: String, _ reason: String) { issues.append(ExportAssetIssue(source: source, reason: reason)) }
    func embedded(_ source: String, alreadyDecoded: Bool = false) -> String? {
        let value = (alreadyDecoded ? source : decodeEntities(source)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.hasPrefix("#"), !value.hasPrefix("//") else { return nil }
        let scheme = value.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression)
        if let scheme, value[scheme].lowercased() != "file:" { return nil }
        var candidates: [URL] = []
        if scheme != nil {
            guard let url = URL(string: value), url.isFileURL, url.host == nil || url.host == "" || url.host?.lowercased() == "localhost" else { issue(source, "Unsupported file URL"); return nil }
            candidates.append(url)
        } else {
            let base: URL?
            if value.hasPrefix("/") { base = URL(fileURLWithPath: "/", isDirectory: true) }
            else { base = documentURL?.isFileURL == true ? documentURL?.deletingLastPathComponent() : nil }
            guard let base else { issue(source, "Relative image has no saved document directory"); return nil }
            // URL percent escapes are decoded exactly once. Try the complete path
            // first to retain literal #/? used by raw HTML, then URL query/fragment.
            let decoded = value.removingPercentEncoding ?? value
            candidates.append(value.hasPrefix("/") ? URL(fileURLWithPath: decoded) : base.appendingPathComponent(decoded))
            if decoded != value { candidates.append(value.hasPrefix("/") ? URL(fileURLWithPath: value) : base.appendingPathComponent(value)) }
            if let url = URL(string: value, relativeTo: base)?.absoluteURL, url.isFileURL { candidates.append(url) }
        }
        for url in candidates {
            let path = url.standardizedFileURL.path
            let fragment = url.fragment.map { "#" + $0 } ?? ""
            if let result = cache[path] { embeddedCount += 1; return result + fragment }
            if failed.contains(path) { continue }
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe) else { failed.insert(path); continue }
            let ext = url.pathExtension.lowercased()
            let known = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp", "avif": "image/avif", "heic": "image/heic", "heif": "image/heif", "bmp": "image/bmp", "ico": "image/x-icon", "tif": "image/tiff", "tiff": "image/tiff"]
            let mime = known[ext] ?? UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
            let result = "data:\(mime);base64,\(data.base64EncodedString())"
            cache[path] = result; embeddedCount += 1
            return result + fragment
        }
        issue(source, "Local image could not be read")
        return nil
    }

    func srcset(_ source: String) -> String? {
        // WHATWG candidate tokenization: a URL ends at ASCII whitespace, not at
        // an internal comma (data URLs contain commas). A trailing comma ends a
        // descriptorless URL. Other unescaped commas/spaces are ambiguous.
        let value = decodeEntities(source)
        let b = Array(value.utf8)
        var i = 0
        var edits: [Edit] = []
        var candidates: [Range<Int>] = []
        while i < b.count {
            while i < b.count && (space(b[i]) || b[i] == 44) { i += 1 }
            if i == b.count { break }
            let start = i
            while i < b.count && !space(b[i]) { i += 1 }
            var end = i
            while end > start && b[end - 1] == 44 { end -= 1 }
            let trailingComma = end != i
            guard end > start else { continue }
            let url = string(b, start..<end)
            if !url.lowercased().hasPrefix("data:") && url.contains(",") {
                issue(source, "Unsupported srcset URL with an unescaped comma"); return nil
            }
            if !trailingComma {
                let descStart = i
                while i < b.count && b[i] != 44 { i += 1 }
                let desc = string(b, descStart..<i).trimmingCharacters(in: .whitespacesAndNewlines)
                if !desc.isEmpty && desc.range(of: "^(?:[0-9]+(?:\\.[0-9]+)?x|[1-9][0-9]*w(?:[ \\t]+[1-9][0-9]*h)?)$", options: .regularExpression) == nil {
                    issue(source, "Unsupported srcset descriptor or unescaped space in URL"); return nil
                }
                if i < b.count { i += 1 }
            }
            candidates.append(start..<end)
        }
        // Validate the entire attribute before reading anything or changing
        // counters. A later malformed candidate must not report phantom embeds.
        for range in candidates {
            if let replacement = embedded(string(b, range), alreadyDecoded: true) { edits.append(Edit(range: range, value: Array(replacement.utf8))) }
        }
        guard !edits.isEmpty else { return nil }
        var output: [UInt8] = [], cursor = 0
        for e in edits { output.append(contentsOf: b[cursor..<e.range.lowerBound]); output.append(contentsOf: e.value); cursor = e.range.upperBound }
        output.append(contentsOf: b[cursor..<b.count])
        return String(decoding: output, as: UTF8.self)
    }

    func decodeEntities(_ source: String) -> String {
        // Common path punctuation plus all numeric references. Unknown named
        // references remain literal, then fail without damaging the original HTML.
        let named: [String: String] = ["amp":"&", "AMP":"&", "quot":"\"", "QUOT":"\"", "apos":"'", "lt":"<", "LT":"<", "gt":">", "GT":">", "nbsp":"\u{a0}", "sol":"/", "bsol":"\\", "colon":":", "semi":";", "comma":",", "period":".", "num":"#", "percnt":"%", "quest":"?", "lpar":"(", "rpar":")", "lsqb":"[", "rsqb":"]", "plus":"+", "equals":"=", "commat":"@", "lowbar":"_", "hyphen":"‐", "ast":"*", "Tab":"\t", "NewLine":"\n", "copy":"©", "reg":"®", "trade":"™", "euro":"€", "cent":"¢", "pound":"£", "yen":"¥", "middot":"·", "ndash":"–", "mdash":"—", "hellip":"…"]
        let expression = try! NSRegularExpression(pattern: "&(#(?:[xX][0-9A-Fa-f]+|[0-9]+)|[A-Za-z][A-Za-z0-9]+);")
        let ns = source as NSString
        var output = source
        for match in expression.matches(in: source, range: NSRange(location: 0, length: ns.length)).reversed() {
            let entity = ns.substring(with: match.range(at: 1))
            var value = named[entity]
            if entity.hasPrefix("#") {
                let hex = entity.hasPrefix("#x") || entity.hasPrefix("#X")
                let digits = String(entity.dropFirst(hex ? 2 : 1))
                if let code = UInt32(digits, radix: hex ? 16 : 10), code != 0, let scalar = UnicodeScalar(code) { value = String(scalar) }
            }
            if let value, let range = Range(match.range, in: output) { output.replaceSubrange(range, with: value) }
        }
        return output
    }
}
