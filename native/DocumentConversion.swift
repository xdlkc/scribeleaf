import Foundation
import UniformTypeIdentifiers
import Darwin

/// The Pandoc export items captured from Typora 1.14.10's File > Export menu.
enum DocumentConversionFormat: String, CaseIterable {
    case docx, odt, rtf, epub, latex, mediawiki, rst, textile, opml

    var title: String {
        switch self {
        case .docx: return "Word (.docx)"
        case .odt: return "OpenOffice"
        case .rtf: return "RTF"
        case .epub: return "Epub"
        case .latex: return "LaTeX"
        case .mediawiki: return "Media Wiki"
        case .rst: return "reStructuredText"
        case .textile: return "Textile"
        case .opml: return "OPML"
        }
    }

    var fileExtension: String {
        switch self {
        case .latex: return "tex"
        case .mediawiki: return "wiki"
        default: return rawValue
        }
    }

    var contentType: UTType {
        let base: UTType
        switch self {
        case .docx, .odt, .epub: base = .data
        case .rtf: return .rtf
        case .opml: base = .xml
        default: base = .plainText
        }
        return UTType(filenameExtension: fileExtension, conformingTo: base) ?? base
    }
}

struct DocumentConversionResult {
    let destination: URL
    /// Pandoc diagnostics, limited to 16 KiB of UTF-8 bytes.
    let warnings: String
}

enum DocumentConversionError: LocalizedError {
    case missingDependency
    case invalidExecutable(String)
    case invalidDestination(String)
    case invalidResourceDirectory(String)
    case timedOut(TimeInterval)
    case cancelled
    case processFailed(Int32, String)
    case missingOutput

    static func missingDependencyMessage(language: String) -> String {
        if language.lowercased().hasPrefix("zh") {
            return "此功能需要 Pandoc。Scribeleaf Lite 不内置转换器；请安装 Scribeleaf Full 完整版，或在「文件 → 导出 → Export Settings…」中配置可信的已有 Pandoc。应用不会自动下载或安装依赖。"
        }
        return "This feature requires Pandoc. Scribeleaf Lite does not bundle the converter. Install Scribeleaf Full, or configure a trusted existing Pandoc in File > Export > Export Settings… . No dependency is downloaded or installed automatically."
    }

    var errorDescription: String? {
        switch self {
        case .missingDependency:
            return Self.missingDependencyMessage(language: Locale.preferredLanguages.first ?? "en")
        case .invalidExecutable(let path):
            return "The selected Pandoc executable cannot be run: \(path)"
        case .invalidDestination(let reason):
            return "The export destination is not valid. \(reason)"
        case .invalidResourceDirectory(let path):
            return "The document's resource folder is unavailable: \(path)"
        case .timedOut(let seconds):
            return "Pandoc did not finish within \(Int(seconds.rounded(.up))) seconds."
        case .cancelled:
            return "The export was cancelled."
        case .processFailed(let status, let detail):
            return "Pandoc failed (exit \(status)).\(detail.isEmpty ? "" : "\n" + detail)"
        case .missingOutput:
            return "Pandoc finished without producing an output file."
        }
    }
}

/// Conversion is isolated from the editor's document identity, encoding and files.
/// CLI flags and writer names: https://pandoc.org/MANUAL.html
enum DocumentConverter {
    /// The transport owns its output path. Validate again at this lowest entry
    /// point so callers cannot bypass the preferences argument parser.
    private static func validateExtraArguments(_ arguments: [String]) throws {
        let unsafe: Set<String> = ["-o", "--output", "--output-file", "--extract-media", "--log", "--defaults", "-d"]
        for token in arguments {
            let flag = token.hasPrefix("--") ? String(token.split(separator: "=").first ?? Substring(token)) : (token.hasPrefix("-") ? String(token.prefix(2)) : token)
            let abbreviated = flag.hasPrefix("--") && unsafe.contains { $0.hasPrefix("--") && $0.hasPrefix(flag) }
            if unsafe.contains(flag) || abbreviated || token == "--" {
                throw DocumentConversionError.invalidDestination("Extra arguments cannot override managed input/output: \(token)")
            }
        }
    }

    static func executableURL(customURL: URL? = nil) throws -> URL {
        let manager = FileManager.default
        let home = manager.homeDirectoryForCurrentUser
        // GUI applications do not necessarily inherit a login shell's PATH.
        let standard = ["/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc", "/opt/local/bin/pandoc", "/usr/bin/pandoc"]
        let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":")
            .filter { $0.hasPrefix("/") }.map { String($0) + "/pandoc" }
        let bundled = Bundle.main.resourceURL.map { $0.appendingPathComponent("Converters/pandoc") }
        let candidates = [bundled].compactMap { $0 } + standard.map { URL(fileURLWithPath: $0) }
            + [home.appendingPathComponent(".local/bin/pandoc"), home.appendingPathComponent(".cabal/bin/pandoc")]
            + paths.map { URL(fileURLWithPath: $0) }
        return try resolveExecutable(customURL: customURL, candidates: candidates)
    }

    /// A deterministic filesystem boundary shared by bundled and externally configured converters.
    static func resolveExecutable(customURL: URL?, candidates: [URL]) throws -> URL {
        let manager = FileManager.default
        func executable(_ url: URL) -> Bool {
            var isDirectory: ObjCBool = false
            return url.isFileURL && manager.fileExists(atPath: url.path, isDirectory: &isDirectory)
                && !isDirectory.boolValue && manager.isExecutableFile(atPath: url.path)
        }
        if let customURL {
            guard executable(customURL) else { throw DocumentConversionError.invalidExecutable(customURL.path) }
            return customURL.standardizedFileURL
        }
        if let found = candidates.first(where: executable) { return found.standardizedFileURL }
        throw DocumentConversionError.missingDependency
    }

    /// Pass the source URL (also for unsaved duplicates) or an explicit asset root.
    /// A UTF-8 snapshot supplies unsaved text. The source document is never opened for writing.
    static func convert(markdown: String, format: DocumentConversionFormat, destination: URL,
                        documentURL: URL? = nil, resourceDirectoryURL: URL? = nil,
                        pandocURL: URL? = nil, timeout: TimeInterval = 60,
                        extraArguments: [String] = [], extraFlags: [String] = [],
                        rawType: String = "") async throws -> DocumentConversionResult {
        let cancellation = ConversionCancellation()
        return try await withTaskCancellationHandler(operation: {
            if Task.isCancelled { throw DocumentConversionError.cancelled }
            return try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        let result = try perform(markdown: markdown, format: format, destination: destination,
                                                 documentURL: documentURL, resourceDirectoryURL: resourceDirectoryURL,
                                                 pandocURL: pandocURL, timeout: timeout, cancellation: cancellation,
                                                 extraArguments: extraArguments, extraFlags: extraFlags, rawType: rawType)
                        continuation.resume(returning: result)
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }, onCancel: { cancellation.cancel() })
    }

    static func convertWriter(markdown: String, writer: String, destination: URL, fileExtension: String,
                              documentURL: URL? = nil, pandocURL: URL? = nil, extraArguments: [String] = [],
                              timeout: TimeInterval = 60) async throws -> DocumentConversionResult {
        guard let format = DocumentConversionFormat(rawValue: writer == "mediawiki" ? "mediawiki" : writer) else {
            return try await convertGeneric(markdown: markdown, writer: writer, destination: destination,
                                            fileExtension: fileExtension, documentURL: documentURL, pandocURL: pandocURL,
                                            extraArguments: extraArguments, timeout: timeout)
        }
        return try await convert(markdown: markdown, format: format, destination: destination, documentURL: documentURL,
                                 pandocURL: pandocURL, extraArguments: extraArguments)
    }

    static func convertGeneric(markdown: String, writer: String, destination: URL, fileExtension: String,
                               documentURL: URL?, pandocURL: URL?, extraArguments: [String],
                               timeout: TimeInterval, rawType: String = "") async throws -> DocumentConversionResult {
        let cancellation = ConversionCancellation()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        let result = try performWriter(markdown: markdown, writer: writer, destination: destination,
                                                       fileExtension: fileExtension, documentURL: documentURL,
                                                       pandocURL: pandocURL, extraArguments: extraArguments,
                                                       timeout: timeout, cancellation: cancellation, rawType: rawType)
                        continuation.resume(returning: result)
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }, onCancel: { cancellation.cancel() })
    }

    private static func performWriter(markdown: String, writer: String, destination: URL, fileExtension: String,
                                      documentURL: URL?, pandocURL: URL?, extraArguments: [String],
                                      timeout: TimeInterval, cancellation: ConversionCancellation,
                                      rawType: String) throws -> DocumentConversionResult {
        let manager = FileManager.default
        try validateExtraArguments(extraArguments)
        guard destination.isFileURL, !destination.lastPathComponent.isEmpty, timeout.isFinite, timeout > 0 else {
            throw DocumentConversionError.invalidDestination("Choose a local file and a finite positive timeout.")
        }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        let target = destination.standardizedFileURL
        if let source = documentURL, source.standardizedFileURL.resolvingSymlinksInPath() == target.resolvingSymlinksInPath() {
            throw DocumentConversionError.invalidDestination("Export cannot overwrite the Markdown source document.")
        }
        let parent = target.deletingLastPathComponent()
        var directory: ObjCBool = false
        guard manager.fileExists(atPath: parent.path, isDirectory: &directory), directory.boolValue else {
            throw DocumentConversionError.invalidDestination("The destination folder does not exist.")
        }
        if manager.fileExists(atPath: target.path, isDirectory: &directory), directory.boolValue {
            throw DocumentConversionError.invalidDestination("The destination is a folder.")
        }
        let inputFolder = manager.temporaryDirectory.appendingPathComponent("typora-conversion-\(UUID().uuidString)", isDirectory: true)
        let outputFolder = parent.appendingPathComponent(".typora-conversion-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: inputFolder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: inputFolder) }
        try manager.createDirectory(at: outputFolder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: outputFolder) }
        let input = inputFolder.appendingPathComponent("snapshot.md")
        let output = outputFolder.appendingPathComponent("output." + fileExtension)
        let executable = try executableURL(customURL: pandocURL)
        let process = Process()
        process.executableURL = executable
        process.currentDirectoryURL = documentURL?.deletingLastPathComponent() ?? inputFolder
        var args = ["--from", "markdown", "--standalone", "--output", output.path]
        if !writer.isEmpty { args += ["--to", writer] }
        // An empty writer lets Pandoc infer the format from the staged output's
        // real extension. Only known native formats supply an Auto TOC raw type.
        let tocWriter = writer.isEmpty
            ? DocumentConversionFormat.allCases.first(where: { $0.fileExtension.lowercased() == fileExtension.lowercased() })?.rawValue ?? ""
            : writer
        let prepared = try addTOCFilter(markdown: markdown, rawType: rawType, writer: tocWriter, folder: inputFolder, arguments: &args)
        try Data(prepared.utf8).write(to: input)
        args.append(contentsOf: extraArguments)
        args.append(input.path)
        process.arguments = args
        let warnings = try runProcess(process, output: output, target: target, timeout: timeout, cancellation: cancellation)
        return DocumentConversionResult(destination: target, warnings: warnings)
    }

    private static func runProcess(_ process: Process, output: URL, target: URL, timeout: TimeInterval, cancellation: ConversionCancellation) throws -> String {
        let stdout = Pipe(), stderr = Pipe()
        process.standardOutput = stdout; process.standardError = stderr
        process.standardInput = FileHandle.nullDevice
        defer {
            try? stdout.fileHandleForReading.close(); try? stdout.fileHandleForWriting.close()
            try? stderr.fileHandleForReading.close(); try? stderr.fileHandleForWriting.close()
        }
        let outFD = stdout.fileHandleForReading.fileDescriptor, errFD = stderr.fileHandleForReading.fileDescriptor
        guard fcntl(outFD, F_SETFL, O_NONBLOCK) != -1, fcntl(errFD, F_SETFL, O_NONBLOCK) != -1 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        try process.run()
        try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close()
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var out = BoundedConversionOutput(), err = BoundedConversionOutput()
        var stopped: DocumentConversionError?
        while process.isRunning {
            out.drain(outFD); err.drain(errFD)
            if cancellation.isCancelled { stopped = .cancelled; break }
            if ProcessInfo.processInfo.systemUptime >= deadline { stopped = .timedOut(timeout); break }
            usleep(10_000)
        }
        if stopped != nil {
            kill(process.processIdentifier, SIGTERM)
            let grace = ProcessInfo.processInfo.systemUptime + 0.25
            while process.isRunning && ProcessInfo.processInfo.systemUptime < grace { out.drain(outFD); err.drain(errFD); usleep(10_000) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        process.waitUntilExit()
        out.drain(outFD); err.drain(errFD)
        if let stopped { throw stopped }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            throw DocumentConversionError.processFailed(process.terminationStatus, err.text.isEmpty ? out.text : err.text)
        }
        let values = try? output.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values?.isRegularFile == true, (values?.fileSize ?? 0) > 0 else { throw DocumentConversionError.missingOutput }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        guard rename(output.path, target.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        return err.text
    }

    /// Keep this compatibility entry point byte preserving. TOC conversion needs
    /// Pandoc's parsed paragraphs so code examples and raw HTML remain literal.
    static func prepareRawMarkdown(_ markdown: String, rawType: String, writer: String) -> String {
        markdown
    }

    /// Mark only unescaped source candidates, then let Pandoc decide whether each
    /// is a plain paragraph. Keep the original token so reference links still parse.
    private static func addTOCFilter(markdown: String, rawType: String, writer: String, folder: URL, arguments: inout [String]) throws -> String {
        let raw = rawType.trimmingCharacters(in: .whitespacesAndNewlines)
        let selected = raw.isEmpty ? String(writer.prefix { $0 != "+" && $0 != "-" }) : raw
        let format: String, content: String
        switch selected {
        case "wiki", "mediawiki": format = "mediawiki"; content = "__TOC__"
        case "latex", "beamer": format = selected; content = "\\tableofcontents"
        default: return markdown
        }
        let candidates = try NSRegularExpression(pattern: #"(?im)^[\t ]*(\[toc\])[\t ]*\r?$"#)
        let matches = candidates.matches(in: markdown, range: NSRange(markdown.startIndex..., in: markdown))
        guard !matches.isEmpty else { return markdown }
        var marker: String
        repeat { marker = "<typora-toc-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() + "/>" }
        while markdown.contains(marker)
        let prepared = NSMutableString(string: markdown)
        for match in matches.reversed() { prepared.insert(marker, at: NSMaxRange(match.range(at: 1))) }
        // The marker contains only this fixed template and a generated UUID;
        // raw/writer names use the whitelist above and are never executable Lua.
        let lua = """
        local marker = '\(marker)'
        local pattern = marker:gsub('([^%w])', '%%%1')
        local function restore(node)
          node.text = node.text:gsub(pattern, '')
          return node
        end
        function Pandoc(doc)
          doc = doc:walk { Para = function(block)
            local c = block.content
            if #c == 2 and c[1].t == 'Str' and c[1].text:lower() == '[toc]'
               and c[2].t == 'RawInline' and c[2].format == 'html' and c[2].text == marker then
              return pandoc.RawBlock('\(format)', [=[\(content)]=])
            end
          end }
          return doc:walk {
            Str = restore, Code = restore, CodeBlock = restore,
            RawBlock = restore, Math = restore,
            RawInline = function(node)
              if node.text == marker then return {} end
              return restore(node)
            end
          }
        end
        """
        let filter = folder.appendingPathComponent("toc-paragraphs.lua")
        try Data(lua.utf8).write(to: filter)
        arguments += ["--lua-filter", filter.path]
        return prepared as String
    }

    private static func perform(markdown: String, format: DocumentConversionFormat, destination: URL,
                                documentURL: URL?, resourceDirectoryURL: URL?, pandocURL: URL?,
                                timeout: TimeInterval, cancellation: ConversionCancellation,
                                extraArguments: [String], extraFlags: [String], rawType: String) throws -> DocumentConversionResult {
        let manager = FileManager.default
        try validateExtraArguments(extraArguments + extraFlags)
        guard destination.isFileURL, !destination.lastPathComponent.isEmpty else {
            throw DocumentConversionError.invalidDestination("Choose a local file.")
        }
        let target = destination.standardizedFileURL
        if let source = documentURL, source.isFileURL,
           source.standardizedFileURL.resolvingSymlinksInPath() == target.resolvingSymlinksInPath() {
            throw DocumentConversionError.invalidDestination("Export cannot overwrite the Markdown source document.")
        }
        var directory: ObjCBool = false
        let parent = target.deletingLastPathComponent()
        guard manager.fileExists(atPath: parent.path, isDirectory: &directory), directory.boolValue else {
            throw DocumentConversionError.invalidDestination("The destination folder does not exist.")
        }
        if manager.fileExists(atPath: target.path, isDirectory: &directory), directory.boolValue {
            throw DocumentConversionError.invalidDestination("The destination is a folder.")
        }
        guard timeout.isFinite, timeout > 0 else { throw DocumentConversionError.invalidDestination("The conversion timeout must be finite and positive.") }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        let executable = try executableURL(customURL: pandocURL)
        let inputFolder = manager.temporaryDirectory.appendingPathComponent("typora-conversion-\(UUID().uuidString)", isDirectory: true)
        // Same filesystem as the destination, so rename commits the entire file atomically.
        let outputFolder = parent.appendingPathComponent(".typora-conversion-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: inputFolder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: inputFolder) }
        try manager.createDirectory(at: outputFolder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: outputFolder) }
        let input = inputFolder.appendingPathComponent("snapshot.md")
        let output = outputFolder.appendingPathComponent("output." + format.fileExtension)
        let resourceRoot = resourceDirectoryURL ?? documentURL?.deletingLastPathComponent() ?? inputFolder
        guard resourceRoot.isFileURL,
              manager.fileExists(atPath: resourceRoot.path, isDirectory: &directory), directory.boolValue else {
            throw DocumentConversionError.invalidResourceDirectory(resourceRoot.path)
        }
        let process = Process()
        process.executableURL = executable
        // cwd is Pandoc's default resource path. This also permits ':' in a folder name,
        // which cannot be represented as one component of --resource-path on macOS.
        process.currentDirectoryURL = resourceRoot
        var args = ["--from", "markdown", "--to", format.rawValue, "--standalone", "--output", output.path]
        switch format {
        case .latex, .mediawiki, .rst, .textile, .opml:
            let filter = inputFolder.appendingPathComponent("resource-paths.lua")
            try Data(resourcePathFilter.utf8).write(to: filter)
            args.append(contentsOf: ["--lua-filter", filter.path])
        default: break
        }
        let prepared = try addTOCFilter(markdown: markdown, rawType: rawType, writer: format.rawValue, folder: inputFolder, arguments: &args)
        try Data(prepared.utf8).write(to: input)
        args.append(contentsOf: extraFlags)
        args.append(contentsOf: extraArguments)
        args.append(input.path)
        process.arguments = args
        let stdout = Pipe(), stderr = Pipe()
        process.standardOutput = stdout; process.standardError = stderr
        process.standardInput = FileHandle.nullDevice
        defer {
            try? stdout.fileHandleForReading.close(); try? stdout.fileHandleForWriting.close()
            try? stderr.fileHandleForReading.close(); try? stderr.fileHandleForWriting.close()
        }
        let outFD = stdout.fileHandleForReading.fileDescriptor
        let errFD = stderr.fileHandleForReading.fileDescriptor
        guard fcntl(outFD, F_SETFL, O_NONBLOCK) != -1, fcntl(errFD, F_SETFL, O_NONBLOCK) != -1 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        var out = BoundedConversionOutput(), err = BoundedConversionOutput()
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        try process.run()
        // Only the child keeps write ends open. Never block on pipe EOF: a descendant
        // could inherit it, and diagnostics must not delay timeout or cancellation.
        try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close()
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var stopped: DocumentConversionError?
        while process.isRunning {
            out.drain(outFD); err.drain(errFD)
            if cancellation.isCancelled { stopped = .cancelled; break }
            if ProcessInfo.processInfo.systemUptime >= deadline { stopped = .timedOut(timeout); break }
            usleep(10_000)
        }
        if stopped != nil {
            kill(process.processIdentifier, SIGTERM)
            let grace = ProcessInfo.processInfo.systemUptime + 0.25
            while process.isRunning && ProcessInfo.processInfo.systemUptime < grace {
                out.drain(outFD); err.drain(errFD); usleep(10_000)
            }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        // A killed child is reaped before cleanup. This does not wait for pipe EOF.
        process.waitUntilExit()
        out.drain(outFD); err.drain(errFD)
        if let stopped { throw stopped }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            let details = err.text.isEmpty ? out.text : err.text
            throw DocumentConversionError.processFailed(process.terminationStatus, details)
        }
        let values = try? output.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values?.isRegularFile == true, (values?.fileSize ?? 0) > 0 else { throw DocumentConversionError.missingOutput }
        // Cancellation is checked immediately before the single commit operation.
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        guard rename(output.path, target.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return DocumentConversionResult(destination: target, warnings: err.text)
    }

    // Lua Image.src and pandoc.system.get_working_directory are documented at
    // https://pandoc.org/lua-filters.html. Percent encoding iterates UTF-8 bytes:
    // Lua pattern character classes can classify multibyte characters differently.
    private static let resourcePathFilter = """
    function Image(image)
      local src = image.src
      if src:match('^%a[%w+.-]*:') or src:sub(1, 2) == '//' or src:sub(1, 1) == '#' then return nil end
      local decoded = src:gsub('%%(%x%x)', function(hex) return string.char(tonumber(hex, 16)) end)
      local path = decoded:sub(1, 1) == '/' and decoded or pandoc.system.get_working_directory() .. '/' .. decoded
      local ok, file = pcall(io.open, path, 'rb')
      if not ok or not file then return nil end
      file:close()
      local encoded = {}
      for i = 1, #path do
        local b = string.byte(path, i)
        if (b >= 65 and b <= 90) or (b >= 97 and b <= 122) or (b >= 48 and b <= 57)
           or b == 45 or b == 46 or b == 95 or b == 126 or b == 47 then
          encoded[#encoded + 1] = string.char(b)
        else encoded[#encoded + 1] = string.format('%%%02X', b) end
      end
      image.src = table.concat(encoded)
      return image
    end
    """
}

final class ConversionCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
}

private struct BoundedConversionOutput {
    private var bytes = Data()
    private var truncated = false
    private let limit = 16_384
    mutating func drain(_ descriptor: Int32) {
        var buffer = [UInt8](repeating: 0, count: 8192)
        // Limit work per iteration so a continuously writing process cannot hide
        // cancellation/deadline checks. Excess diagnostics are drained and discarded.
        for _ in 0..<8 {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count <= 0 { break }
            let available = max(0, limit - bytes.count)
            bytes.append(contentsOf: buffer.prefix(min(count, available)))
            if count > available { truncated = true }
        }
    }
    var text: String {
        let decoded = String(decoding: bytes, as: UTF8.self)
        let didTruncate = truncated || decoded.utf8.count > limit
        let suffix = didTruncate ? "\n[Diagnostics truncated]" : ""
        var validBytes = Data(decoded.utf8.prefix(limit - suffix.utf8.count))
        // Preserve a valid UTF-8 boundary even if a child emits invalid bytes or
        // truncation lands in the middle of a multibyte character.
        while !validBytes.isEmpty, String(data: validBytes, encoding: .utf8) == nil { validBytes.removeLast() }
        return (String(data: validBytes, encoding: .utf8) ?? "") + suffix
    }
}
