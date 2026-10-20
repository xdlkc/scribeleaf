import Foundation
import AppKit
import Darwin

/// Independent consumer of the image preferences. No original executable code
/// is linked or evaluated. Paths remain URL/file values until Markdown output.
struct ImageInsertionSettings {
    var action: String
    var copyLocal: Bool
    var copyOnline: Bool
    var allowUpload: Bool
    var relative: Bool
    var dotPrefix: Bool
    var uploader: String
    var folder: String
    var command: String
    init(_ values: [String: Any]) {
        action = values["imageInsertAction"] as? String ?? ""
        copyLocal = values["imageCopyLocal"] as? Bool ?? false
        copyOnline = values["imageCopyOnline"] as? Bool ?? false
        allowUpload = values["allowImageUpload"] as? Bool ?? true
        relative = values["useRelativeImagePaths"] as? Bool ?? true
        dotPrefix = values["relativeImageDotPrefix"] as? Bool ?? false
        uploader = values["imageUploader"] as? String ?? ""
        folder = values["customImageFolder"] as? String ?? "./${filename}"
        command = values["customImageUploadCommand"] as? String ?? ""
    }
    func displayPath(_ url: URL, document: URL?) -> String {
        let target = url.standardizedFileURL
        guard relative, let base = document?.deletingLastPathComponent(),
              (base.standardizedFileURL.path == "/" || target.path.hasPrefix(base.standardizedFileURL.path + "/")),
              let path = relativePath(from: base.standardizedFileURL, to: target) else { return target.path }
        return dotPrefix && !path.hasPrefix("./") && !path.hasPrefix("../") ? "./" + path : path
    }
}

enum ImageInputKind { case local, raw, online }
enum ImageInsertionPlan {
    case reference, prompt, directory(URL), upload(String)
}

enum ImageInsertionError: LocalizedError {
    case invalidFolder, missingUploader(String), unsupportedUploader(String), invalidCommand, invalidResponse(String), download(String), tooLarge
    var errorDescription: String? {
        switch self {
        case .invalidFolder: return "The image folder is not valid. Choose a relative folder beginning with ./ or ../, or an absolute folder."
        case .missingUploader(let name): return "The image uploader is unavailable: \(name.isEmpty ? "None selected" : name). Install or configure that uploader, then try again."
        case .unsupportedUploader(let name): return "The \(name) integration is not available in this build. Choose another uploader or configure a Custom Command."
        case .invalidCommand: return "The image upload command is empty or contains an invalid byte."
        case .invalidResponse(let detail): return "The image uploader did not return one image URL for each input.\(detail.isEmpty ? "" : "\n" + detail)"
        case .download(let detail): return "The online image could not be downloaded. \(detail)"
        case .tooLarge: return "The image exceeds the 100 MiB limit."
        }
    }
}

enum ImageInsertionRules {
    static func plan(settings: ImageInsertionSettings, kind: ImageInputKind, document: URL?, policy: [String: Any]) -> ImageInsertionPlan {
        let applies = kind == .raw || (kind == .local ? settings.copyLocal : settings.copyOnline)
        if !applies { return .reference }
        if policy["copyImagesInvalid"] as? Bool == true { return .prompt }
        if let path = policy["copyImagesTo"] as? String, !path.isEmpty {
            if path.lowercased() == "upload" || path.lowercased() == "ipic" {
                if settings.allowUpload || settings.action == "ipic" { return .upload(path.lowercased() == "ipic" ? "ipic" : settings.uploader) }
                return kind == .raw ? .prompt : .reference
            }
            return directory(path, document: document, strict: false)
        }
        switch settings.action {
        case "folder": return directory("./", document: document, strict: false)
        case "assert": return directory("./assets", document: document, strict: false)
        case "per-file-assert": return directory("./${filename}.assets", document: document, strict: false)
        case "custom": return directory(settings.folder, document: document, strict: true)
        case "ipic": return .upload(settings.uploader)
        default: return kind == .raw ? .prompt : .reference
        }
    }

    static func directory(_ raw: String, document: URL?, strict: Bool) -> ImageInsertionPlan {
        var path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty, !path.contains("\0"), !path.contains("$(") else { return .prompt }
        if path.contains("${filename}") {
            guard let document else { return .prompt }
            path = path.replacingOccurrences(of: "${filename}", with: document.deletingPathExtension().lastPathComponent)
        }
        guard !path.contains("${") else { return .prompt }
        path = (path as NSString).expandingTildeInPath
        if strict && !path.hasPrefix("/") && !path.hasPrefix("./") && !path.hasPrefix("../") { return .prompt }
        let target: URL
        if path.hasPrefix("/") { target = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL }
        else if let base = document?.deletingLastPathComponent() { target = base.appendingPathComponent(path, isDirectory: true).standardizedFileURL }
        else { return .prompt }
        return target.path == "/" ? .prompt : .directory(target)
    }
}

/// Commit each new file atomically without replacing an existing file. A failed
/// or cancelled batch removes only files this transaction created.
enum ImageFileTransaction {
    static func store(_ items: [(name: String, data: Data)], into directory: URL, cancellation: ConversionCancellation) throws -> [URL] {
        let manager = FileManager.default
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        let existed = manager.fileExists(atPath: directory.path)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var committed: [URL] = []
        do {
            for item in items {
                if cancellation.isCancelled { throw DocumentConversionError.cancelled }
                let baseName = (item.name as NSString).lastPathComponent
                guard !["", ".", "..", "/"].contains(baseName), !baseName.contains("\0") else { throw ImageInsertionError.invalidFolder }
                let stage = directory.appendingPathComponent(".typora-image-\(UUID().uuidString)")
                defer { try? manager.removeItem(at: stage) }
                try item.data.write(to: stage, options: .atomic)
                var target = directory.appendingPathComponent(baseName)
                let stem = target.deletingPathExtension().lastPathComponent, ext = target.pathExtension
                var count = 0
                while Darwin.link(stage.path, target.path) != 0 {
                    guard errno == EEXIST else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
                    count += 1
                    target = directory.appendingPathComponent(stem + "-\(count)" + (ext.isEmpty ? "" : "." + ext))
                }
                committed.append(target)
                if cancellation.isCancelled { throw DocumentConversionError.cancelled }
            }
            return committed
        } catch {
            committed.reversed().forEach { try? manager.removeItem(at: $0) }
            if !existed { try? manager.removeItem(at: directory) }
            throw error
        }
    }
}

enum ImageUploaderRunner {
    /// Only the two documented image macros are expanded, once each. Preserve
    /// unrelated shell variables and quote context; values remain environment
    /// data rather than becoming executable shell text.
    static func expandCommand(_ command: String, document: URL?) -> (command: String, environment: [String: String]) {
        let tokens = ["${filepath}": ("TYPORA_IMAGE_DOCUMENT_PATH", document?.path ?? ""), "${filename}": ("TYPORA_IMAGE_DOCUMENT_NAME", document?.deletingPathExtension().lastPathComponent ?? "")]
        var consumed = Set<String>(), result = "", index = command.startIndex
        var quote: Character?
        while index < command.endIndex {
            if let token = tokens.keys.first(where: { !consumed.contains($0) && command[index...].hasPrefix($0) }), let value = tokens[token] {
                let variable = "${" + value.0 + "}"
                if quote == "'" { result += "'\"" + variable + "\"'" }
                else if quote == "\"" { result += variable }
                else { result += "\"" + variable + "\"" }
                consumed.insert(token); index = command.index(index, offsetBy: token.count); continue
            }
            let char = command[index]
            if char == "\\", quote != "'", command.index(after: index) < command.endIndex {
                result.append(char); index = command.index(after: index); result.append(command[index]); index = command.index(after: index); continue
            }
            if char == "'" || char == "\"" { if quote == char { quote = nil } else if quote == nil { quote = char } }
            result.append(char); index = command.index(after: index)
        }
        return (result, Dictionary(uniqueKeysWithValues: tokens.values.map { ($0.0, $0.1) }))
    }
    static func upload(_ files: [URL], settings: ImageInsertionSettings, uploader: String, document: URL?, timeout: TimeInterval = 60, cancellation: ConversionCancellation) throws -> [String] {
        guard !files.isEmpty else { return [] }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        switch uploader {
        case "custom":
            guard !settings.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !settings.command.contains("\0") else { throw ImageInsertionError.invalidCommand }
            let expanded = expandCommand(settings.command, document: document)
            // Images are positional argv, never shell source.
            let command = expanded.command + " \"$@\""
            var environment = ProcessInfo.processInfo.environment
            for (key, value) in expanded.environment { environment[key] = value }
            let capture = try ProcessGroupLauncher.run(executable: "/bin/bash", arguments: ["-c", command, "typora-image-uploader"] + files.map(\.path), environment: environment, cwd: document?.deletingLastPathComponent().path, timeout: timeout, cancellation: cancellation)
            return try parseOutput(capture.stdout, count: files.count)
        case "upic", "picsee":
            let executable = uploader == "upic" ? "/Applications/uPic.app/Contents/MacOS/uPic" : "/Applications/Picsee.app/Contents/MacOS/Picsee"
            guard FileManager.default.isExecutableFile(atPath: executable) else { throw ImageInsertionError.missingUploader(executable) }
            let flags = uploader == "upic" ? ["-o", "url", "-u"] : ["-u"]
            let capture = try ProcessGroupLauncher.run(executable: executable, arguments: flags + files.map(\.path), environment: ProcessInfo.processInfo.environment, cwd: document?.deletingLastPathComponent().path, timeout: timeout, cancellation: cancellation)
            return try parseOutput(capture.stdout, count: files.count)
        case "picgo-app", "piclist-app":
            let bundle = uploader == "picgo-app" ? "com.molunerfinn.picgo" : "com.kuingsmile.piclist"
            guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw ImageInsertionError.missingUploader(uploader) }
            // The app owns its uploader configuration. Launch is explicit through
            // the selected insertion action; no packages are installed here.
            let launch = NSWorkspace.OpenConfiguration(); launch.activates = false
            NSWorkspace.shared.openApplication(at: app, configuration: launch) { _, _ in }
            let payload = try JSONSerialization.data(withJSONObject: ["list": files.map(\.path)])
            var last: Error = ImageInsertionError.missingUploader(uploader)
            for attempt in 0..<2 {
                if attempt == 1 {
                    let end = ProcessInfo.processInfo.systemUptime + 5
                    while ProcessInfo.processInfo.systemUptime < end { if cancellation.isCancelled { throw DocumentConversionError.cancelled }; usleep(20_000) }
                }
                do {
                    var request = URLRequest(url: URL(string: "http://127.0.0.1:36677/upload")!); request.httpMethod = "POST"; request.httpBody = payload; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    let data = try ImageNetwork.request(request, timeout: min(timeout, 60), cancellation: cancellation)
                    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["success"] as? Bool == true,
                          let urls = object["result"] as? [String], urls.count == files.count, urls.allSatisfy(validURL) else { throw ImageInsertionError.invalidResponse(String(decoding: data.prefix(4096), as: UTF8.self)) }
                    return urls
                } catch { last = error }
            }
            throw last
        default:
            // Vendor app command-line protocols differ. Missing/unsupported
            // programs produce a real error; no fabricated URL is returned.
            if uploader == "ipic" { throw ImageInsertionError.unsupportedUploader("iPic") }
            throw ImageInsertionError.missingUploader(uploader)
        }
    }

    static func validURL(_ text: String) -> Bool {
        guard let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false else { return false }
        return !text.contains(where: { $0.isWhitespace })
    }
    static func parseOutput(_ output: String, count: Int) throws -> [String] {
        var urls: [String] = []
        for line in output.components(separatedBy: .newlines).reversed() {
            let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            var candidate = text
            if candidate.range(of: #"^[a-z0-9]+([\-.][a-z0-9]+)*\.[a-z]{2,5}/.*$"#, options: .regularExpression) != nil { candidate = "http://" + candidate }
            let hasScheme = candidate.range(of: #"^(https?|ftp|file):/"#, options: .regularExpression) != nil
            if hasScheme, URL(string: candidate) != nil { urls.insert(candidate, at: 0) }
            else if !urls.isEmpty { break }
        }
        if count == 1, let last = urls.last { return [last] }
        guard urls.count == count else { throw ImageInsertionError.invalidResponse(String(output.prefix(4096))) }
        return urls
    }
}

private final class ImageNetworkDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var result: Result<Data, Error>?
    func get() -> Result<Data, Error>? { lock.lock(); defer { lock.unlock() }; return result }
    private func fail(_ error: Error) { lock.lock(); if result == nil { result = .failure(error) }; lock.unlock() }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            fail(ImageInsertionError.download("The server returned an error.")); completionHandler(.cancel); return
        }
        guard response.expectedContentLength <= Int64(ImageNetwork.maxBytes) else { fail(ImageInsertionError.tooLarge); completionHandler(.cancel); return }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        if data.count > ImageNetwork.maxBytes - bytes.count {
            result = .failure(ImageInsertionError.tooLarge); lock.unlock(); dataTask.cancel(); return
        }
        bytes.append(data); lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); defer { lock.unlock() }
        guard result == nil else { return }
        if let error { result = .failure(error) }
        else if bytes.isEmpty { result = .failure(ImageInsertionError.download("The response was empty.")) }
        else { result = .success(bytes) }
    }
}

enum ImageNetwork {
    static let maxBytes = 100 * 1024 * 1024
    static func request(_ request: URLRequest, timeout: TimeInterval = 60, cancellation: ConversionCancellation, configuration: URLSessionConfiguration = .ephemeral) throws -> Data {
        let delegate = ImageNetworkDelegate()
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = request; request.timeoutInterval = timeout
        let task = session.dataTask(with: request)
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        task.resume()
        let end = ProcessInfo.processInfo.systemUptime + timeout
        while delegate.get() == nil {
            if cancellation.isCancelled { task.cancel(); throw DocumentConversionError.cancelled }
            if ProcessInfo.processInfo.systemUptime >= end { task.cancel(); throw DocumentConversionError.timedOut(timeout) }
            usleep(10_000)
        }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        return try delegate.get()!.get()
    }
}

/// Preferences' explicit uploader test. It uses two generated PNG fixtures and
/// reports real output. The process group and temporary inputs are cancelled
/// together; no system clipboard contents are read or written.
enum ImageUploaderTester {
    private static let lock = NSLock()
    private static var jobs: [String: ConversionCancellation] = [:]
    static func start(requestId: String, values: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        guard !requestId.isEmpty else { return }
        let cancellation = ConversionCancellation()
        lock.lock(); jobs[requestId]?.cancel(); jobs[requestId] = cancellation; lock.unlock()
        let settings = ImageInsertionSettings(values)
        DispatchQueue.global(qos: .userInitiated).async {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("typora-uploader-test-\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: directory) }
            var result: [String: Any] = ["requestId": requestId]
            do {
                // A complete one-pixel transparent PNG, created by this app.
                let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=")!
                let files = try ImageFileTransaction.store([("test-image-1.png", png), ("test-image-2.png", png)], into: directory, cancellation: cancellation)
                result["paths"] = try ImageUploaderRunner.upload(files, settings: settings, uploader: settings.uploader, document: nil, cancellation: cancellation)
            } catch { result["error"] = error.localizedDescription }
            try? FileManager.default.removeItem(at: directory)
            lock.lock(); let current = jobs[requestId] === cancellation; if current { jobs.removeValue(forKey: requestId) }; lock.unlock()
            if current { DispatchQueue.main.async { completion(result) } }
        }
    }
    static func cancel(requestId: String) {
        lock.lock(); let job = jobs.removeValue(forKey: requestId); lock.unlock(); job?.cancel()
    }
}
