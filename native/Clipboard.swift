import AppKit
import Foundation
import UniformTypeIdentifiers
import ObjectiveC

private var clipboardQueueKey: UInt8 = 0

struct ClipboardPasteboardSnapshot {
    var files: [URL] = []
    var png: Data?
}
/// The provider is replaceable by a local value fixture in standalone tests.
/// Production keeps drag and paste snapshots on their distinct pasteboards.
enum ClipboardPasteboardReader {
    static var read: (NSPasteboard.Name) -> ClipboardPasteboardSnapshot = { name in
        let board = NSPasteboard(name: name)
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        let files = (board.readObjects(forClasses: [NSURL.self], options: options) as? [URL]) ?? []
        var png: Data?
        if let image = NSImage(pasteboard: board), let tiff = image.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff) { png = rep.representation(using: .png, properties: [:]) }
        return ClipboardPasteboardSnapshot(files: files, png: png)
    }
}

private final class ClipboardRequest {
    let body: [String: Any]
    let settings: ImageInsertionSettings
    let source: URL?
    let policy: [String: Any]
    let cancellation = ConversionCancellation()
    var requestId: String { body["requestId"] as? String ?? "" }
    init(body: [String: Any], settings: ImageInsertionSettings, source: URL?, policy: [String: Any]) {
        self.body = body; self.settings = settings; self.source = source; self.policy = policy
    }
}
private final class ClipboardWorkQueue: NSObject {
    var items: [ClipboardRequest] = []
    var active: ClipboardRequest?
    var panel: NSSavePanel?
}

extension MarkdownDocument {
    func handleClipboardImage(_ body: [String: Any]) { enqueueClipboard(snapshotPasteboards(into: body)) }
    func handleClipboardPasteboard(_ body: [String: Any]) {
        var next = body; next["usePasteboard"] = true
        enqueueClipboard(snapshotPasteboards(into: next))
    }
    func handleClipboardCancel(_ body: [String: Any]) {
        let ids = Set(body["requestIds"] as? [String] ?? [])
        let queue = clipboardWorkQueue()
        queue.items.removeAll { request in
            if ids.contains(request.requestId) { request.cancellation.cancel(); return true }
            return false
        }
        if let request = queue.active, ids.contains(request.requestId) {
            request.cancellation.cancel(); queue.panel?.cancel(nil)
        }
    }
    func cancelAllClipboardImages() {
        let queue = clipboardWorkQueue()
        queue.items.forEach { $0.cancellation.cancel() }; queue.items.removeAll()
        queue.active?.cancellation.cancel(); queue.panel?.cancel(nil)
    }

    private func snapshotPasteboards(into body: [String: Any]) -> [String: Any] {
        if body["remoteURL"] is String { return body }
        if let path = body["path"] as? String, !path.isEmpty { return body }
        if body["data"] is String, !(body["lookupFileURLs"] as? Bool ?? false), !(body["usePasteboard"] as? Bool ?? false) { return body }
        var next = body
        let snapshot = ClipboardPasteboardReader.read(body["source"] as? String == "drop" ? .drag : .general)
        var files: [String] = []
        for url in snapshot.files where isImageURL(url) {
            let path = url.standardizedFileURL.path
            if !files.contains(path) { files.append(path) }
        }
        next["_snapFiles"] = files
        if let png = snapshot.png { next["_snapPng"] = png.base64EncodedString() }
        return next
    }
    private func clipboardWorkQueue() -> ClipboardWorkQueue {
        if let existing = objc_getAssociatedObject(self, &clipboardQueueKey) as? ClipboardWorkQueue { return existing }
        let created = ClipboardWorkQueue()
        objc_setAssociatedObject(self, &clipboardQueueKey, created, .OBJC_ASSOCIATION_RETAIN)
        return created
    }
    private func enqueueClipboard(_ body: [String: Any]) {
        var policy = body["imagePolicy"] as? [String: Any] ?? [:]
        let preferences = AppPreferencesStore.loadEditorPrefs()
        if body["imagePolicy"] == nil, preferences["sourceMode"] as? Bool != true {
            switch parseTyporaCopyImagesTo(markdown) {
            case .path(let path): policy["copyImagesTo"] = path
            case .unresolved: policy["copyImagesInvalid"] = true
            case .absent: break
            }
        }
        let request = ClipboardRequest(body: body, settings: ImageInsertionSettings(preferences), source: fileURL?.standardizedFileURL, policy: policy)
        guard !request.requestId.isEmpty else { return }
        clipboardWorkQueue().items.append(request)
        processClipboardQueue()
    }
    private func processClipboardQueue() {
        let queue = clipboardWorkQueue()
        guard queue.active == nil, !queue.items.isEmpty else { return }
        let request = queue.items.removeFirst(); queue.active = request
        DispatchQueue.main.async { [weak self] in self?.performClipboardImage(request) }
    }
    private func valid(_ request: ClipboardRequest) -> Bool {
        !request.cancellation.isCancelled && fileURL?.standardizedFileURL == request.source
    }
    private func finish(_ request: ClipboardRequest, paths: [String] = [], error: String? = nil) {
        let queue = clipboardWorkQueue()
        guard queue.active === request else { return }
        if valid(request) {
            if let error { send("clipboardResult", ["requestId": request.requestId, "error": error]) }
            else { send("clipboardResult", ["requestId": request.requestId, "path": paths.first ?? "", "paths": paths]) }
        }
        queue.active = nil; queue.panel = nil
        processClipboardQueue()
    }
    private func performClipboardImage(_ request: ClipboardRequest) {
        guard valid(request) else { finish(request); return }
        let body = request.body
        if let remote = body["remoteURL"] as? String {
            guard let url = URL(string: remote), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false else { finish(request, error: "The online image URL is not valid."); return }
            processImage(request, kind: .online, files: [], data: nil, name: sanitizedFileName(url.lastPathComponent, mime: nil), remote: url)
            return
        }
        if let path = body["path"] as? String, !path.isEmpty {
            processImage(request, kind: .local, files: [URL(fileURLWithPath: path)], data: nil, name: "", remote: nil)
            return
        }
        let snapshots = ((body["_snapFiles"] as? [String]) ?? []).map { URL(fileURLWithPath: $0) }.filter(isImageURL)
        if body["lookupFileURLs"] as? Bool == true {
            let named = snapshots.filter { $0.lastPathComponent == body["name"] as? String }
            if named.count == 1 { processImage(request, kind: .local, files: named, data: nil, name: "", remote: nil); return }
        } else if body["usePasteboard"] as? Bool == true, !snapshots.isEmpty {
            processImage(request, kind: .local, files: snapshots, data: nil, name: "", remote: nil); return
        }
        if let b64 = (body["data"] as? String) ?? (body["_snapPng"] as? String), let data = Data(base64Encoded: b64), !data.isEmpty {
            processImage(request, kind: .raw, files: [], data: data, name: sanitizedFileName(body["name"] as? String, mime: body["mime"] as? String), remote: nil)
            return
        }
        finish(request, error: "No matching image was found on the clipboard.")
    }

    private func processImage(_ request: ClipboardRequest, kind: ImageInputKind, files: [URL], data: Data?, name: String, remote: URL?) {
        if kind == .local, request.body["source"] as? String == "drop" {
            let regular = files.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) != true }
            if regular.isEmpty { finish(request, paths: []); return }
            if regular.count != files.count {
                processImage(request, kind: kind, files: regular, data: data, name: name, remote: remote); return
            }
        }
        let plan = ImageInsertionRules.plan(settings: request.settings, kind: kind, document: request.source, policy: request.policy)
        if case .directory(let target) = plan, !files.isEmpty, files.allSatisfy({ $0.deletingLastPathComponent().standardizedFileURL == target.standardizedFileURL }) {
            finish(request, paths: files.map { request.settings.displayPath($0, document: request.source) }); return
        }
        if case .reference = plan {
            if let remote { finish(request, paths: [(request.body["remoteURL"] as? String) ?? remote.absoluteString]); return }
            guard files.allSatisfy({ FileManager.default.fileExists(atPath: $0.path) }) else { finish(request, error: "The image file could not be found."); return }
            finish(request, paths: files.map { request.settings.displayPath($0, document: request.source) }); return
        }
        if case .prompt = plan, !files.isEmpty { promptCopyDirectory(files, request: request); return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var committed: [URL] = []
            do {
                if request.cancellation.isCancelled { throw DocumentConversionError.cancelled }
                var items: [(name: String, data: Data)] = []
                for file in files {
                    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                    guard values.isRegularFile == true else { throw ImageInsertionError.download("The source is not a regular file.") }
                    if (values.fileSize ?? 0) > ImageNetwork.maxBytes { throw ImageInsertionError.tooLarge }
                    items.append((file.lastPathComponent, try Data(contentsOf: file)))
                }
                if let data { guard data.count <= ImageNetwork.maxBytes else { throw ImageInsertionError.tooLarge }; items.append((name, data)) }
                if let remote { items.append((name, try ImageNetwork.request(URLRequest(url: remote), cancellation: request.cancellation))) }
                switch plan {
                case .directory(let directory):
                    committed = try ImageFileTransaction.store(items, into: directory, cancellation: request.cancellation)
                    let paths = committed.map { request.settings.displayPath($0, document: request.source) }
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { committed.forEach { try? FileManager.default.removeItem(at: $0) }; return }
                        if !self.valid(request) { committed.forEach { try? FileManager.default.removeItem(at: $0) } }
                        self.finish(request, paths: paths)
                    }
                case .upload(let uploader):
                    let temp = FileManager.default.temporaryDirectory.appendingPathComponent("typora-upload-\(UUID().uuidString)", isDirectory: true)
                    defer { try? FileManager.default.removeItem(at: temp) }
                    let uploadFiles = files.isEmpty ? try ImageFileTransaction.store(items, into: temp, cancellation: request.cancellation) : files
                    let paths = try ImageUploaderRunner.upload(uploadFiles, settings: request.settings, uploader: uploader, document: request.source, cancellation: request.cancellation)
                    DispatchQueue.main.async { [weak self] in self?.finish(request, paths: paths) }
                case .prompt:
                    guard let item = items.first else { throw ImageInsertionError.download("The image has no data.") }
                    DispatchQueue.main.async { [weak self] in self?.promptSave(item.data, fileName: item.name, request: request) }
                case .reference: break
                }
            } catch {
                committed.forEach { try? FileManager.default.removeItem(at: $0) }
                DispatchQueue.main.async { [weak self] in self?.finish(request, error: error.localizedDescription) }
            }
        }
    }

    private func promptCopyDirectory(_ files: [URL], request: ClipboardRequest) {
        guard valid(request), let window = windowControllers.first?.window else { finish(request, error: "cancelled"); return }
        let panel = NSOpenPanel(); clipboardWorkQueue().panel = panel
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false; panel.canCreateDirectories = true
        panel.prompt = "Copy Images"; panel.directoryURL = request.source?.deletingLastPathComponent()
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            guard response == .OK, let directory = panel.url, self.valid(request) else { self.finish(request, error: "cancelled"); return }
            let redirected = ClipboardRequest(body: request.body, settings: request.settings, source: request.source, policy: ["copyImagesTo": directory.path])
            self.clipboardWorkQueue().active = redirected
            self.processImage(redirected, kind: .raw, files: files, data: nil, name: "", remote: nil)
        }
    }
    private func promptSave(_ data: Data, fileName: String, request: ClipboardRequest) {
        guard valid(request), let window = windowControllers.first?.window else { finish(request, error: "cancelled"); return }
        let panel = NSSavePanel(); clipboardWorkQueue().panel = panel
        panel.canCreateDirectories = true; panel.nameFieldStringValue = fileName; panel.directoryURL = request.source?.deletingLastPathComponent()
        if let type = UTType(filenameExtension: (fileName as NSString).pathExtension) { panel.allowedContentTypes = [type] }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            guard response == .OK, let target = panel.url, self.valid(request) else { self.finish(request, error: "cancelled"); return }
            let redirected = ClipboardRequest(body: request.body, settings: request.settings, source: request.source, policy: ["copyImagesTo": target.deletingLastPathComponent().path])
            self.clipboardWorkQueue().active = redirected
            self.processImage(redirected, kind: .raw, files: [], data: data, name: target.lastPathComponent, remote: nil)
        }
    }
    private func sanitizedFileName(_ name: String?, mime: String?) -> String {
        let raw = (name?.isEmpty == false ? name! : "image") as NSString
        var base = raw.lastPathComponent.replacingOccurrences(of: "/", with: "-")
        if base.isEmpty || base == "." || base == ".." { base = "image" }
        if (base as NSString).pathExtension.isEmpty { base += "." + ext(forMime: mime) }
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
    private func isImageURL(_ url: URL) -> Bool { ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "svg"].contains(url.pathExtension.lowercased()) }

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
    guard !path.replacingOccurrences(of: "${filename}", with: "").contains("${"), !path.contains("$(") else { return .unresolved }
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
