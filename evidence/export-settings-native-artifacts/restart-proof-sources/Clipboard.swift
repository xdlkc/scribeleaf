import AppKit
import Foundation
import UniformTypeIdentifiers
import ObjectiveC

private var clipboardQueueKey: UInt8 = 0

private final class ClipboardWorkQueue: NSObject {
    var items: [[String: Any]] = []
    var busy = false
}

extension MarkdownDocument {
    func handleClipboardImage(_ body: [String: Any]) {
        enqueueClipboard(snapshotPasteboards(into: body))
    }

    func handleClipboardPasteboard(_ body: [String: Any]) {
        var next = body
        next["usePasteboard"] = true
        enqueueClipboard(snapshotPasteboards(into: next))
    }

    private func snapshotPasteboards(into body: [String: Any]) -> [String: Any] {
        if let path = body["path"] as? String, !path.isEmpty { return body }
        if body["data"] is String,
           !(body["lookupFileURLs"] as? Bool ?? false),
           !(body["usePasteboard"] as? Bool ?? false) { return body }
        var next = body
        let source = body["source"] as? String
        let boardName: NSPasteboard.Name = source == "drop" ? .drag : .general
        let board = NSPasteboard(name: boardName)
        var files: [String] = []
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        if let urls = board.readObjects(forClasses: [NSURL.self], options: options) as? [URL] {
            for url in urls where isImageURL(url) {
                let path = url.standardizedFileURL.path
                if !files.contains(path) { files.append(path) }
            }
        }
        next["_snapFiles"] = files
        if let image = NSImage(pasteboard: board), let png = pngData(from: image) {
            next["_snapPng"] = png.base64EncodedString()
        }
        return next
    }

    private func clipboardWorkQueue() -> ClipboardWorkQueue {
        if let existing = objc_getAssociatedObject(self, &clipboardQueueKey) as? ClipboardWorkQueue {
            return existing
        }
        let created = ClipboardWorkQueue()
        objc_setAssociatedObject(self, &clipboardQueueKey, created, .OBJC_ASSOCIATION_RETAIN)
        return created
    }

    private func enqueueClipboard(_ body: [String: Any]) {
        let queue = clipboardWorkQueue()
        queue.items.append(body)
        processClipboardQueue()
    }

    private func processClipboardQueue() {
        let queue = clipboardWorkQueue()
        guard !queue.busy, let body = queue.items.first else { return }
        queue.busy = true
        queue.items.removeFirst()
        DispatchQueue.main.async { [weak self] in
            self?.performClipboardImage(body) { [weak self] in
                guard let self else { return }
                self.clipboardWorkQueue().busy = false
                self.processClipboardQueue()
            }
        }
    }

    private func performClipboardImage(_ body: [String: Any], done: @escaping () -> Void) {
        let requestId = body["requestId"] as? String ?? ""
        if requestId.isEmpty {
            done()
            return
        }
        if let path = body["path"] as? String, !path.isEmpty {
            handleExistingImage(URL(fileURLWithPath: path), requestId: requestId, done: done)
            return
        }
        let snapFiles = ((body["_snapFiles"] as? [String]) ?? []).map { URL(fileURLWithPath: $0) }.filter { isImageURL($0) }
        let lookup = body["lookupFileURLs"] as? Bool ?? false
        if lookup {
            if let name = body["name"] as? String {
                let named = snapFiles.filter { $0.lastPathComponent == name }
                if named.count == 1 {
                    handleExistingImage(named[0], requestId: requestId, done: done)
                    return
                }
            }
            if let b64 = body["data"] as? String, let data = Data(base64Encoded: b64) {
                handleRawImageData(
                    data,
                    mime: body["mime"] as? String,
                    name: body["name"] as? String,
                    requestId: requestId,
                    done: done
                )
                return
            }
            if let b64 = body["_snapPng"] as? String, let data = Data(base64Encoded: b64) {
                handleRawImageData(data, mime: "image/png", name: body["name"] as? String, requestId: requestId, done: done)
                return
            }
            failClipboard(requestId, "No matching image file was found.", done: done)
            return
        }
        let usePasteboard = body["usePasteboard"] as? Bool ?? false
        if usePasteboard {
            handleSnapOrPasteboard(body, requestId: requestId, done: done)
            return
        }
        if let b64 = body["data"] as? String, let data = Data(base64Encoded: b64) {
            handleRawImageData(
                data,
                mime: body["mime"] as? String,
                name: body["name"] as? String,
                requestId: requestId,
                done: done
            )
            return
        }
        handleSnapOrPasteboard(body, requestId: requestId, done: done)
    }

    private func handleSnapOrPasteboard(_ body: [String: Any], requestId: String, done: @escaping () -> Void) {
        let snapFiles = ((body["_snapFiles"] as? [String]) ?? []).map { URL(fileURLWithPath: $0) }.filter { isImageURL($0) }
        if snapFiles.count == 1 {
            handleExistingImage(snapFiles[0], requestId: requestId, done: done)
            return
        }
        if snapFiles.count > 1 {
            handlePasteboardFiles(snapFiles, requestId: requestId, done: done)
            return
        }
        if let b64 = body["_snapPng"] as? String, let data = Data(base64Encoded: b64) {
            handleRawImageData(data, mime: "image/png", name: body["name"] as? String ?? "image.png", requestId: requestId, done: done)
            return
        }
        failClipboard(requestId, "No image was found on the clipboard.", done: done)
    }

    private func handleExistingImage(_ url: URL, requestId: String, done: @escaping () -> Void) {
        let src = url.standardizedFileURL
        guard FileManager.default.fileExists(atPath: src.path) else {
            failClipboard(requestId, "The image file could not be found.", done: done)
            return
        }
        switch copyImagesTarget() {
        case .directory(let destDir):
            do {
                try FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)
                let dest = uniqueURL(destDir.appendingPathComponent(src.lastPathComponent))
                try FileManager.default.copyItem(at: src, to: dest)
                succeedClipboard(requestId, dest, done: done)
            } catch {
                failClipboard(requestId, error.localizedDescription, done: done)
            }
        case .unresolved:
            guard let data = try? Data(contentsOf: src) else {
                failClipboard(requestId, "The image file could not be read.", done: done)
                return
            }
            promptSave(data: data, fileName: src.lastPathComponent, requestId: requestId, done: done)
        case .absent:
            succeedClipboard(requestId, src, done: done)
        }
    }

    private func handleRawImageData(
        _ data: Data,
        mime: String?,
        name: String?,
        requestId: String,
        done: @escaping () -> Void
    ) {
        let fileName = sanitizedFileName(name, mime: mime)
        switch copyImagesTarget() {
        case .directory(let destDir):
            do {
                try FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)
                let dest = uniqueURL(destDir.appendingPathComponent(fileName))
                try data.write(to: dest, options: .atomic)
                succeedClipboard(requestId, dest, done: done)
            } catch {
                failClipboard(requestId, error.localizedDescription, done: done)
            }
        case .absent, .unresolved:
            promptSave(data: data, fileName: fileName, requestId: requestId, done: done)
        }
    }

    private func handlePasteboardFiles(_ urls: [URL], requestId: String, done: @escaping () -> Void) {
        switch copyImagesTarget() {
        case .directory(let destDir):
            copyFiles(urls, into: destDir, requestId: requestId, done: done)
        case .absent:
            let paths = urls.map { displayPath(for: $0.standardizedFileURL) }
            send("clipboardResult", ["requestId": requestId, "path": paths.first ?? "", "paths": paths])
            done()
        case .unresolved:
            promptCopyDirectory(urls, requestId: requestId, done: done)
        }
    }

    private func copyFiles(_ urls: [URL], into destDir: URL, requestId: String, done: @escaping () -> Void) {
        var stored: [URL] = []
        do {
            try FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)
            for url in urls {
                let dest = uniqueURL(destDir.appendingPathComponent(url.lastPathComponent))
                try FileManager.default.copyItem(at: url, to: dest)
                stored.append(dest)
            }
        } catch {
            failClipboard(requestId, error.localizedDescription, done: done)
            return
        }
        let paths = stored.map { displayPath(for: $0) }
        send("clipboardResult", ["requestId": requestId, "path": paths.first ?? "", "paths": paths])
        done()
    }

    private func promptCopyDirectory(_ urls: [URL], requestId: String, done: @escaping () -> Void) {
        guard let window = windowControllers.first?.window else {
            failClipboard(requestId, "cancelled", done: done)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Copy Images"
        panel.directoryURL = fileURL?.deletingLastPathComponent()
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { done(); return }
            guard response == .OK, let destDir = panel.url else {
                self.failClipboard(requestId, "cancelled", done: done)
                return
            }
            self.copyFiles(urls, into: destDir, requestId: requestId, done: done)
        }
    }

    private func promptSave(data: Data, fileName: String, requestId: String, done: @escaping () -> Void) {
        guard let window = windowControllers.first?.window else {
            failClipboard(requestId, "cancelled", done: done)
            return
        }
        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = fileName
        panel.directoryURL = fileURL?.deletingLastPathComponent()
        if let type = UTType(filenameExtension: (fileName as NSString).pathExtension) {
            panel.allowedContentTypes = [type]
        } else {
            panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .tiff, .heic]
        }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { done(); return }
            guard response == .OK, let dest = panel.url else {
                self.failClipboard(requestId, "cancelled", done: done)
                return
            }
            do {
                let unique = FileManager.default.fileExists(atPath: dest.path) ? self.uniqueURL(dest) : dest
                try data.write(to: unique, options: .atomic)
                self.succeedClipboard(requestId, unique, done: done)
            } catch {
                self.failClipboard(requestId, error.localizedDescription, done: done)
            }
        }
    }

    private func succeedClipboard(_ requestId: String, _ url: URL, done: @escaping () -> Void) {
        send("clipboardResult", ["requestId": requestId, "path": displayPath(for: url)])
        done()
    }

    private func failClipboard(_ requestId: String, _ error: String, done: @escaping () -> Void) {
        send("clipboardResult", ["requestId": requestId, "error": error])
        done()
    }

    private func copyImagesTarget() -> CopyImagesTarget {
        switch parseTyporaCopyImagesTo(markdown) {
        case .absent:
            return .absent
        case .unresolved:
            return .unresolved
        case .path(let relative):
            let expanded = (relative as NSString).expandingTildeInPath
            if expanded.hasPrefix("/") {
                return .directory(URL(fileURLWithPath: expanded, isDirectory: true).standardizedFileURL)
            }
            guard let base = fileURL?.deletingLastPathComponent() else { return .unresolved }
            return .directory(base.appendingPathComponent(expanded).standardizedFileURL)
        }
    }

    private func displayPath(for url: URL) -> String {
        let dest = url.standardizedFileURL
        guard let dir = fileURL?.deletingLastPathComponent() else { return dest.path }
        return relativePath(from: dir.standardizedFileURL, to: dest) ?? dest.path
    }

    private func uniqueURL(_ url: URL) -> URL {
        if !FileManager.default.fileExists(atPath: url.path) { return url }
        let dir = url.deletingLastPathComponent()
        let ext = url.pathExtension
        let stem = url.deletingPathExtension().lastPathComponent
        var i = 1
        while true {
            let name = ext.isEmpty ? "\(stem)-\(i)" : "\(stem)-\(i).\(ext)"
            let candidate = dir.appendingPathComponent(name)
            if !FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            i += 1
        }
    }

    private func sanitizedFileName(_ name: String?, mime: String?) -> String {
        let raw = (name?.isEmpty == false ? name! : "image") as NSString
        var base = raw.lastPathComponent.replacingOccurrences(of: "/", with: "-")
        if (base as NSString).pathExtension.isEmpty {
            base += "." + ext(forMime: mime)
        }
        if base.hasPrefix(".") { base = "image" + base }
        return base
    }

    private func ext(forMime mime: String?) -> String {
        switch mime?.lowercased() ?? "" {
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/gif": return "gif"
        case "image/webp": return "webp"
        case "image/svg+xml": return "svg"
        case "image/bmp": return "bmp"
        case "image/tiff": return "tiff"
        case "image/heic", "image/heif": return "heic"
        default: return "png"
        }
    }

    private func isImageURL(_ url: URL) -> Bool {
        let ext = url.pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "svg"].contains(ext)
    }

    private func pngData(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}

enum CopyImagesParse: Equatable {
    case absent
    case unresolved
    case path(String)
}

enum CopyImagesTarget {
    case absent
    case unresolved
    case directory(URL)
}

func parseTyporaCopyImagesTo(_ markdown: String) -> CopyImagesParse {
    let text = markdown.replacingOccurrences(of: "\r\n", with: "\n")
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    guard let first = lines.first, first == "---" else { return .absent }
    var end = 0
    var foundEnd = false
    for i in 1..<lines.count {
        if lines[i] == "---" {
            end = i
            foundEnd = true
            break
        }
    }
    guard foundEnd else {
        let rest = lines.dropFirst().joined(separator: "\n")
        if rest.contains("typora-copy-images-to") { return .unresolved }
        return .absent
    }
    let block = Array(lines[1..<end])
    var seenCopy: String? = nil
    var seenCopyCount = 0
    for line in block {
        if line.isEmpty || line.hasPrefix("#") { continue }
        if line.hasPrefix(" ") || line.hasPrefix("\t") { return .unresolved }
        guard let parsed = parseSimpleYamlLine(line) else { return .unresolved }
        if parsed.key == "typora-copy-images-to" {
            seenCopyCount += 1
            guard let value = parsed.value else { return .unresolved }
            seenCopy = value
        }
    }
    if seenCopyCount == 0 { return .absent }
    if seenCopyCount > 1 { return .unresolved }
    guard let path = seenCopy, !path.isEmpty else { return .unresolved }
    // Unknown template expressions must reach the destination chooser,
    // rather than create a literal ${...} directory beside the document.
    guard !path.contains("${"), !path.contains("$(") else { return .unresolved }
    return .path(path)
}

private func parseSimpleYamlLine(_ line: String) -> (key: String, value: String?)? {
    guard let colon = line.firstIndex(of: ":") else { return nil }
    let key = String(line[..<colon])
    guard key.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
    let raw = String(line[line.index(after: colon)...])
    if raw.isEmpty { return (key, nil) }
    if raw.hasPrefix(" ") || raw.hasPrefix("\t") {
        let value = String(raw.drop(while: { $0 == " " || $0 == "\t" }))
        return (key, parseYamlScalar(value))
    }
    return nil
}

private func parseYamlScalar(_ raw: String) -> String? {
    if raw.isEmpty { return nil }
    if raw.hasPrefix("|") || raw.hasPrefix(">") { return nil }
    if raw.hasPrefix("{") || raw.hasPrefix("[") { return nil }
    if raw.contains("&") || raw.contains("*") { return nil }
    if raw.hasPrefix("\"") {
        guard raw.count >= 2, raw.last == "\"" else { return nil }
        let inner = String(raw.dropFirst().dropLast())
        if inner.contains("\"") || inner.contains("\\") { return nil }
        return inner
    }
    if raw.hasPrefix("'") {
        guard raw.count >= 2, raw.last == "'" else { return nil }
        let inner = String(raw.dropFirst().dropLast())
        if inner.contains("'") || inner.contains("\\") { return nil }
        return inner
    }
    if raw.contains("#") { return nil }
    if raw.contains(":") { return nil }
    let lower = raw.lowercased()
    if ["true", "false", "null", "~", "yes", "no"].contains(lower) { return nil }
    if Double(raw) != nil { return nil }
    return raw
}

func relativePath(from base: URL, to dest: URL) -> String? {
    let baseParts = base.pathComponents
    let destParts = dest.pathComponents
    var i = 0
    while i < baseParts.count, i < destParts.count, baseParts[i] == destParts[i] { i += 1 }
    if i == 0 { return nil }
    let ups = Array(repeating: "..", count: baseParts.count - i)
    let downs = destParts[i...]
    let parts = ups + downs
    if parts.isEmpty { return dest.lastPathComponent }
    return parts.joined(separator: "/")
}
