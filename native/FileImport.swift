import Foundation

/// Imports a supported document into a new Markdown snapshot. The input is
/// never opened for writing. Embedded media lives in this app's managed storage,
/// not in a temporary folder that disappears when conversion returns.
enum FileImporter {
    /// These formats use the configured or bundled Pandoc converter. Existing Markdown
    /// and plain text belong to the normal document-opening path.
    static let readers: [String: String] = [
        "docx":"docx", "odt":"odt", "epub":"epub", "rtf":"rtf",
        "html":"html+raw_html", "htm":"html+raw_html", "xhtml":"html+raw_html",
        "rst":"rst", "rest":"rst", "textile":"textile", "tex":"latex", "latex":"latex",
        "opml":"opml", "org":"org", "wiki":"mediawiki", "mediawiki":"mediawiki",
        "adoc":"asciidoc", "asciidoc":"asciidoc", "fb2":"fb2", "fodt":"fodt",
        "ipynb":"ipynb", "typ":"typst", "typst":"typst"
    ]
    static func supports(_ url: URL) -> Bool { url.isFileURL && readers[url.pathExtension.lowercased()] != nil }

    static func importMarkdown(source: URL, pandocURL: URL? = nil, timeout: TimeInterval = 60,
                               mediaCacheURL: URL? = nil) async throws -> String {
        let cancellation = ConversionCancellation()
        return try await withTaskCancellationHandler(operation: {
            if Task.isCancelled { throw DocumentConversionError.cancelled }
            return try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        continuation.resume(returning: try perform(source: source, pandocURL: pandocURL,
                                                                  timeout: timeout, mediaCacheURL: mediaCacheURL,
                                                                  cancellation: cancellation))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }, onCancel: { cancellation.cancel() })
    }

    private static func perform(source: URL, pandocURL: URL?, timeout: TimeInterval,
                                mediaCacheURL: URL?, cancellation: ConversionCancellation) throws -> String {
        guard let reader = readers[source.pathExtension.lowercased()], source.isFileURL else { throw FileImportError.unsupported(source.pathExtension) }
        let source = source.standardizedFileURL
        let manager = FileManager.default
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isReadableKey])
        guard values.isRegularFile == true, values.isReadable == true else { throw FileImportError.unreadable }
        guard timeout.isFinite, timeout > 0 else { throw FileImportError.invalidTimeout }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        let executable = try DocumentConverter.executableURL(customURL: pandocURL)
        let root = try mediaCacheURL ?? defaultMediaCacheURL()
        guard root.isFileURL, root.standardizedFileURL.path != "/" else { throw FileImportError.invalidCache }
        let identity = UUID().uuidString.lowercased()
        let media = root.appendingPathComponent(identity, isDirectory: true)
        let stage = root.appendingPathComponent(".staging-" + identity, isDirectory: true)
        let workspace = manager.temporaryDirectory.appendingPathComponent("typora-file-import-" + identity, isDirectory: true)
        try manager.createDirectory(at: workspace, withIntermediateDirectories: false, attributes: [.posixPermissions:0o700])
        var mediaCommitted = false
        defer {
            try? manager.removeItem(at: workspace)
            try? manager.removeItem(at: stage)
            if !mediaCommitted { try? manager.removeItem(at: media) }
        }
        try manager.createDirectory(at: stage, withIntermediateDirectories: true, attributes: [.posixPermissions:0o700])
        let dataDirectory = workspace.appendingPathComponent("pandoc-data", isDirectory: true)
        try manager.createDirectory(at: dataDirectory, withIntermediateDirectories: false)
        let output = workspace.appendingPathComponent("imported.md")
        let filter = workspace.appendingPathComponent("retain-embedded-media.lua")
        let manifest = workspace.appendingPathComponent("media.txt")
        let prepared = try prepareNotebook(source: source, workspace: workspace, stage: stage, media: media, cancellation: cancellation)
        try Data(mediaFilter.utf8).write(to: filter)
        var environment = ProcessInfo.processInfo.environment
        environment["TYPORA_IMPORT_STAGE"] = stage.path
        environment["TYPORA_IMPORT_MEDIA"] = media.absoluteString.hasSuffix("/") ? String(media.absoluteString.dropLast()) : media.absoluteString
        environment["TYPORA_IMPORT_MANIFEST"] = manifest.path
        environment["TYPORA_IMPORT_ATTACHMENTS"] = prepared.metadata.path
        let arguments = [
            "--sandbox", "--data-dir", dataDirectory.path,
            "--from", reader, "--to", "gfm", "--wrap=none",
            "--lua-filter", filter.path, "--output", output.path, "--", prepared.input.path
        ]
        _ = try ProcessGroupLauncher.run(executable: executable.path, arguments: arguments,
                                         environment: environment, cwd: source.deletingLastPathComponent().path,
                                         timeout: timeout, cancellation: cancellation)
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        let outputValues = try output.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard outputValues.isRegularFile == true, (outputValues.fileSize ?? 0) <= 64 * 1024 * 1024 else { throw FileImportError.invalidOutput }
        let data = try Data(contentsOf: output)
        guard let markdown = String(data: data, encoding: .utf8) else { throw FileImportError.invalidOutput }
        let files = try String(contentsOf: manifest, encoding: .utf8).split(separator:"\n").map(String.init)
        for name in files {
            guard name.range(of: #"^image-[0-9]+\.[a-z0-9]+$"#, options:.regularExpression) != nil else { throw FileImportError.invalidOutput }
            let path = stage.appendingPathComponent(name)
            let attributes = try path.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard attributes.isRegularFile == true, attributes.isSymbolicLink != true,
                  (attributes.fileSize ?? 0) > 0, (attributes.fileSize ?? 0) <= 100 * 1024 * 1024 else { throw FileImportError.invalidOutput }
        }
        // The commit is one directory rename on the same volume. An interrupted
        // attempt cannot leave references to half-written embedded resources.
        if !files.isEmpty {
            let record: [String: Any] = ["version":1,"sourceName":source.lastPathComponent,"createdAt":ISO8601DateFormatter().string(from:Date()),"files":files]
            try JSONSerialization.data(withJSONObject:record, options:[.prettyPrinted,.sortedKeys]).write(to:stage.appendingPathComponent("import.json"), options:.atomic)
            if cancellation.isCancelled { throw DocumentConversionError.cancelled }
            try manager.moveItem(at:stage, to:media)
        }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        mediaCommitted = !files.isEmpty
        return markdown
    }

    /// Notebook attachment references inside raw HTML are not resolved by the
    /// Pandoc reader. Decode only those explicit cell attachments into managed
    /// files and give the fixed Lua filter a cell-scoped mapping. The original
    /// notebook remains byte-for-byte unchanged.
    private static func prepareNotebook(source: URL, workspace: URL, stage: URL, media: URL,
                                        cancellation: ConversionCancellation) throws -> (input: URL, metadata: URL) {
        let metadata = workspace.appendingPathComponent("attachments.json")
        var maps: [String: [String: String]] = [:], names: [String] = []
        var input = source, total = 0
        if source.pathExtension.lowercased() == "ipynb" {
            let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 64 * 1024 * 1024 else { throw FileImportError.invalidOutput }
            guard var notebook = try JSONSerialization.jsonObject(with: Data(contentsOf: source)) as? [String: Any],
                  var cells = notebook["cells"] as? [[String: Any]] else { throw FileImportError.invalidOutput }
            let extensions = ["image/png":"png", "image/jpeg":"jpg", "image/gif":"gif", "image/svg+xml":"svg", "image/webp":"webp", "image/tiff":"tiff", "image/bmp":"bmp"]
            for index in cells.indices {
                if cancellation.isCancelled { throw DocumentConversionError.cancelled }
                guard cells[index]["cell_type"] as? String == "markdown",
                      let attachments = cells[index]["attachments"] as? [String: [String: String]], !attachments.isEmpty else { continue }
                let id = "typora-import-cell-" + UUID().uuidString.lowercased()
                cells[index]["id"] = id
                var map: [String: String] = [:]
                for key in attachments.keys.sorted() {
                    guard let types = attachments[key], let mime = types.keys.sorted().first(where: { extensions[$0] != nil }),
                          let encoded = types[mime], let bytes = Data(base64Encoded: encoded, options:.ignoreUnknownCharacters) else { continue }
                    total += bytes.count
                    guard bytes.count <= 100 * 1024 * 1024, total <= 512 * 1024 * 1024, names.count < 10000 else { throw FileImportError.invalidOutput }
                    let name = "image-\(names.count + 1)." + extensions[mime]!
                    try bytes.write(to:stage.appendingPathComponent(name),options:.atomic)
                    names.append(name)
                    let target = media.appendingPathComponent(name).absoluteString
                    for variant in Set([key, key.removingPercentEncoding ?? key]) {
                        map[variant] = target; map["attachment:" + variant] = target
                    }
                }
                maps[id] = map
            }
            notebook["cells"] = cells
            input = workspace.appendingPathComponent("snapshot.ipynb")
            try JSONSerialization.data(withJSONObject:notebook).write(to:input,options:.atomic)
        }
        try JSONSerialization.data(withJSONObject:["cells":maps,"names":names,"bytes":total], options:.sortedKeys).write(to:metadata,options:.atomic)
        return (input, metadata)
    }

    static func defaultMediaCacheURL() throws -> URL {
        let support = try FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:false)
        return support.appendingPathComponent(Bundle.main.bundleIdentifier ?? "local.typora-replica.editor",isDirectory:true)
            .appendingPathComponent("ImportedMedia",isDirectory:true)
    }

    /// Only reader-populated mediabag entries are read. No fetch/fill or
    /// --extract-media call may turn remote image references into downloads.
    /// Generated paths/names remain data; source text is never Lua source code.
    private static let mediaFilter = #"""
    local stage = assert(os.getenv('TYPORA_IMPORT_STAGE'))
    local media = assert(os.getenv('TYPORA_IMPORT_MEDIA'))
    local manifest = assert(os.getenv('TYPORA_IMPORT_MANIFEST'))
    local attachmentFile = assert(io.open(assert(os.getenv('TYPORA_IMPORT_ATTACHMENTS')), 'rb'))
    local attachments = pandoc.json.decode(attachmentFile:read('*a')); attachmentFile:close()
    local written, names, total = {}, attachments.names or {}, attachments.bytes or 0
    local count = #names
    local extensions = { ['image/png']='png', ['image/jpeg']='jpg', ['image/gif']='gif',
      ['image/svg+xml']='svg', ['image/webp']='webp', ['image/tiff']='tiff',
      ['image/bmp']='bmp', ['image/heic']='heic', ['image/avif']='avif' }
    local function retain(image, scope)
      local original = image.src
      if scope and scope[original] then image.src = scope[original]; return image end
      local target = written[original]
      if not target then
        local function decode(value)
          return value:gsub('%%(%x%x)', function(hex) return string.char(tonumber(hex, 16)) end)
        end
        local mime, bytes = pandoc.mediabag.lookup(original)
        if not bytes then mime, bytes = pandoc.mediabag.lookup(decode(original)) end
        if not bytes and original:match('^attachment:') then
          mime, bytes = pandoc.mediabag.lookup(decode(original:sub(12)))
        end
        if not bytes then return image end
        count, total = count + 1, total + #bytes
        assert(count <= 10000 and #bytes <= 104857600 and total <= 536870912, 'Embedded media is too large')
        local ext = extensions[mime] or 'bin'
        local name = 'image-' .. count .. '.' .. ext
        local file = assert(io.open(stage .. '/' .. name, 'wb'))
        assert(file:write(bytes)); assert(file:close())
        names[#names+1] = name
        target = media .. '/' .. name
        written[original] = target
      end
      image.src = target
      return image
    end
    local function retainHTML(raw, scope)
      if raw.format ~= 'html' then return raw end
      raw.text = raw.text:gsub('(<[iI][mM][gG]%s[^>]-[sS][rR][cC]%s*=%s*)(["\'])(.-)%2', function(prefix, quote, source)
        local target = scope[source] or scope[source:gsub('&amp;', '&')]
        return prefix .. quote .. (target or source) .. quote
      end)
      return raw
    end
    function Pandoc(document)
      document = document:walk{
        traverse='topdown',
        Div=function(div)
          local scope = attachments.cells and attachments.cells[div.identifier]
          if not scope then return nil end
          return div:walk{ Image=function(image) return retain(image, scope) end,
            RawBlock=function(raw) return retainHTML(raw, scope) end,
            RawInline=function(raw) return retainHTML(raw, scope) end }, false
        end,
        Image=function(image) return retain(image, nil) end
      }
      local file = assert(io.open(manifest, 'wb'))
      assert(file:write(table.concat(names, '\n'))); assert(file:close())
      return document
    end
    """#
}

enum FileImportError: LocalizedError {
    case unsupported(String), unreadable, invalidTimeout, invalidCache, invalidOutput
    var errorDescription: String? {
        switch self {
        case .unsupported(let ext): return "This document format cannot be imported: \(ext)"
        case .unreadable: return "The source document is not a readable regular file."
        case .invalidTimeout: return "The import timeout is not valid."
        case .invalidCache: return "The imported media folder is not valid."
        case .invalidOutput: return "The document converter did not produce a valid Markdown snapshot and media manifest."
        }
    }
}
