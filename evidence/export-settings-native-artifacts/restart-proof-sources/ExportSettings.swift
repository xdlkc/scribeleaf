import Foundation
import AppKit
import Darwin

struct ExportGeneralSettings: Codable, Equatable {
    var exportFolder: String = ""
    var customExportPath: String = ""
    var openExportLocation: Bool = false
}

struct CustomExportEntry: Codable, Equatable {
    var key: String
    var name: String
    var type: String
    var extra: [String: AnyCodableValue]

    enum CodingKeys: String, CodingKey { case key, name, type }

    init(key: String, name: String, type: String, extra: [String: AnyCodableValue] = [:]) {
        self.key = key; self.name = name; self.type = type; self.extra = extra
    }

    init(from decoder: Decoder) throws {
        let keyed = try decoder.container(keyedBy: CodingKeys.self)
        key = try keyed.decode(String.self, forKey: .key)
        name = try keyed.decode(String.self, forKey: .name)
        type = try keyed.decode(String.self, forKey: .type)
        let raw = try decoder.singleValueContainer().decode([String: AnyCodableValue].self)
        extra = raw.filter { $0.key != "key" && $0.key != "name" && $0.key != "type" }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicKey.self)
        try container.encode(key, forKey: DynamicKey("key"))
        try container.encode(name, forKey: DynamicKey("name"))
        try container.encode(type, forKey: DynamicKey("type"))
        for (k, v) in extra { try container.encode(v, forKey: DynamicKey(k)) }
    }
}

struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

enum AnyCodableValue: Codable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([AnyCodableValue])
    case object([String: AnyCodableValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .double(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([AnyCodableValue].self) { self = .array(v) }
        else if let v = try? c.decode([String: AnyCodableValue].self) { self = .object(v) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    var any: Any {
        switch self {
        case .string(let v): return v
        case .int(let v): return v
        case .double(let v): return v
        case .bool(let v): return v
        case .array(let v): return v.map(\.any)
        case .object(let v): return v.mapValues(\.any)
        case .null: return NSNull()
        }
    }

    static func wrap(_ value: Any) -> AnyCodableValue {
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            let value = number.doubleValue
            if value.isFinite, value >= Double(Int.min), value < Double(Int.max), value.rounded() == value { return .int(number.intValue) }
            return value.isFinite ? .double(value) : .null
        }
        switch value {
        case let v as String: return .string(v)
        case let v as Int: return .int(v)
        case let v as Double: return .double(v)
        case let v as Bool: return .bool(v)
        case let v as [Any]: return .array(v.map(wrap))
        case let v as [String: Any]: return .object(v.mapValues(wrap))
        default: return .null
        }
    }
}

struct ExportSettingsDocument: Codable, Equatable {
    var version: Int = 1
    var pandocPath: String = ""
    var general: ExportGeneralSettings = ExportGeneralSettings()
    var formats: [String: [String: AnyCodableValue]] = [:]
    var customExport: [CustomExportEntry] = ExportSettingsDocument.defaultConverters()

    static func defaultConverters() -> [CustomExportEntry] {
        [
            .init(key: "docx", name: "Word (.docx)", type: "docx"),
            .init(key: "odt", name: "OpenOffice", type: "odt"),
            .init(key: "rtf", name: "RTF", type: "rtf"),
            .init(key: "epub", name: "Epub", type: "epub"),
            .init(key: "latex", name: "LaTeX", type: "latex"),
            .init(key: "wiki", name: "Media Wiki", type: "wiki"),
            .init(key: "rst", name: "reStructuredText", type: "rst"),
            .init(key: "textile", name: "Textile", type: "textile"),
            .init(key: "opml", name: "OPML", type: "opml"),
        ]
    }

    func jsonObject() -> [String: Any] {
        let data = try! JSONEncoder().encode(self)
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    static func fromJSON(_ object: Any) -> ExportSettingsDocument {
        var result = ExportSettingsDocument()
        guard let object = object as? [String: Any] else { return result }
        if let path = object["pandocPath"] as? String { result.pandocPath = path }
        if let general = object["general"] as? [String: Any] {
            if let mode = general["exportFolder"] as? String, ["", "same", "custom"].contains(mode) { result.general.exportFolder = mode }
            if let path = general["customExportPath"] as? String { result.general.customExportPath = path }
            if let open = general["openExportLocation"] as? Bool { result.general.openExportLocation = open }
        }
        if let formats = object["formats"] as? [String: Any] {
            for (key, value) in formats { if let fields = value as? [String: Any] { result.formats[key] = fields.mapValues(AnyCodableValue.wrap) } }
        }
        if let entries = object["customExport"] as? [Any] {
            result.customExport = []
            var used = Set(["general", "pdf", "html", "html-plain", "image", "png", "mediawiki"])
            for raw in entries {
                guard let entry = raw as? [String: Any], let rawType = entry["type"] as? String, !rawType.isEmpty else { continue }
                let type = rawType == "png" ? "image" : rawType == "mediawiki" ? "wiki" : rawType
                let requested = entry["key"] as? String ?? ""
                var key = requested
                if key.isEmpty || used.contains(key) {
                    key = type; var suffix = 0
                    while used.contains(key) { suffix += 1; key = type + String(suffix) }
                }
                used.insert(key)
                let suppliedName = entry["name"] as? String ?? ""
                let extra = entry.filter { !["key", "name", "type"].contains($0.key) }.mapValues(AnyCodableValue.wrap)
                result.customExport.append(.init(key: key, name: suppliedName.isEmpty ? key : suppliedName, type: type, extra: extra))
            }
        }
        return result
    }

    func freeze(key: String) -> [String: Any]? {
        guard ["pdf", "html", "html-plain", "image"].contains(key) || customExport.contains(where: { $0.key == key }) else { return nil }
        let type = lookupType(key)
        let name = customExport.first { $0.key == key }?.name ?? key
        var options: [String: Any] = schemaDefaults(type)
        if let extra = customExport.first(where: { $0.key == key })?.extra {
            for (k, v) in extra { options[k] = v.any }
        }
        if let stored = formats[key] {
            for (k, v) in stored { options[k] = v.any }
        }
        return [
            "key": key,
            "type": type,
            "name": name,
            "pandocPath": pandocPath,
            "general": ["exportFolder": general.exportFolder, "customExportPath": general.customExportPath, "openExportLocation": general.openExportLocation],
            "options": options,
        ]
    }

    func lookupType(_ key: String) -> String {
        switch key {
        case "pdf", "html", "html-plain", "image", "general": return key
        default: return customExport.first { $0.key == key }?.type ?? key
        }
    }

    func schemaDefaults(_ type: String) -> [String: Any] {
        switch type {
        case "html": return ["sidebar": false, "exportTheme": "", "appendHead": "", "appendBody": "", "allowPerFileSetting": false]
        case "html-plain": return ["appendHead": "", "appendBody": "", "allowPerFileSetting": false]
        case "pdf": return ["paper": "", "paper.custom": [210, 297], "paper.margin": "", "paper.marginTop": 16, "paper.marginBottom": 16, "paper.marginLeft": 16, "paper.marginRight": 16, "exportTheme": "", "splitPages": false, "header": "", "footer": "", "author": "", "appendBody": "", "allowPerFileSetting": false]
        case "image", "png": return ["imageWidth": 640, "quality": 0, "useThemeFontSize": 0, "imageFontSize": 24, "exportTheme": ""]
        case "docx": return ["extraArguments": "", "reference-doc": ""]
        case "odt": return ["extraArguments": "", "template": ""]
        case "epub": return ["extraArguments": "", "css": "", "toc-depth": 3]
        case "custom": return ["command": "", "saveDialog": "", "extensions": "", "showOutput": false]
        case "pandoc": return ["targetFormat": "", "extensions": "", "extraArguments": "", "raw": ""]
        case "latex-pdf": return ["extraArguments": "", "pdf-engine": "", "template": "", "author": ""]
        case "markdown": return ["variants": "markdown", "hardLineWrap": false, "columns": 130, "eol": "", "tab": "", "ascii": false, "reference-links": false, "reference-location": "", "markdown-headings": "", "webtex": false, "webtex-format": "png", "extraArguments": ""]
        default: return ["extraArguments": ""]
        }
    }

    func replicaFormat(_ key: String) -> String {
        let type = lookupType(key)
        if type == "image" { return "png" }
        if type == "wiki" { return "mediawiki" }
        return type
    }

    func menuItems() -> [(label: String, key: String)] {
        var items = [("PDF", "pdf"), ("HTML", "html"), ("HTML (without styles)", "html-plain"), ("Image", "image")]
        items.append(contentsOf: customExport.map { ($0.name, $0.key) })
        return items
    }
}

enum AppPreferencesStore {
    static let exportKey = "exportSettings.v1"
    static let editorKey = "editorPrefs.v1"

    static var defaults: UserDefaults {
        if let suite = ProcessInfo.processInfo.environment["TYPORA_REPLICA_DEFAULTS_SUITE"], !suite.isEmpty {
            return UserDefaults(suiteName: suite) ?? .standard
        }
        return .standard
    }

    static func loadExport() -> ExportSettingsDocument {
        if let data = defaults.data(forKey: exportKey),
           let decoded = try? JSONDecoder().decode(ExportSettingsDocument.self, from: data) {
            return ExportSettingsDocument.fromJSON(decoded.jsonObject())
        }
        if let object = defaults.object(forKey: exportKey),
           let data = try? JSONSerialization.data(withJSONObject: object),
           let decoded = try? JSONDecoder().decode(ExportSettingsDocument.self, from: data) {
            return ExportSettingsDocument.fromJSON(decoded.jsonObject())
        }
        return ExportSettingsDocument()
    }

    static func saveExport(_ document: ExportSettingsDocument) {
        if let data = try? JSONEncoder().encode(document) {
            defaults.set(data, forKey: exportKey)
        }
        NotificationCenter.default.post(name: .exportSettingsDidChange, object: document.jsonObject())
    }

    static func loadEditorPrefs() -> [String: Any] {
        defaults.dictionary(forKey: editorKey) ?? [:]
    }

    static func saveEditorPrefs(_ prefs: [String: Any]) {
        defaults.set(prefs, forKey: editorKey)
        NotificationCenter.default.post(name: .editorPrefsDidChange, object: prefs)
    }
}

extension Notification.Name {
    static let exportSettingsDidChange = Notification.Name("exportSettingsDidChange")
    static let editorPrefsDidChange = Notification.Name("editorPrefsDidChange")
}

enum PandocArgv {
    static let unsafe = Set(["-o", "-d", "--output", "--output-file", "--extract-media", "--log", "--defaults"])

    enum ParseError: LocalizedError {
        case unterminatedQuote
        case rejected([String])
        var errorDescription: String? {
            switch self {
            case .unterminatedQuote: return "Unterminated quote in extra arguments"
            case .rejected(let items): return "Pandoc extra arguments cannot override the export source or destination: \(items.joined(separator: " "))"
            }
        }
    }

    static func split(_ input: String) throws -> [String] {
        guard !input.contains("\0") else { throw ParseError.rejected(["NUL byte"]) }
        var out: [String] = [], current = "", quote: Character?, started = false
        let chars = Array(input)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            started = started || !ch.isWhitespace
            if let q = quote {
                if ch == "\\" && q == "\"" && i + 1 < chars.count {
                    let next = chars[i + 1]
                    if next == "\"" || next == "\\" || next == "$" || next == "`" { current.append(next); i += 2; continue }
                    if next == "\n" { i += 2; continue }
                    current.append(ch); i += 1; continue
                }
                if ch == q { quote = nil } else { current.append(ch) }
            } else if ch == "\\" && i + 1 < chars.count {
                if chars[i + 1] != "\n" { current.append(chars[i + 1]) }; i += 2; continue
            } else if ch == "\"" || ch == "'" { quote = ch }
            else if ch.isWhitespace {
                if started { out.append(current); current = ""; started = false }
            } else { current.append(ch) }
            i += 1
        }
        if quote != nil { throw ParseError.unterminatedQuote }
        if started { out.append(current) }
        return out
    }

    static func flagName(_ token: String) -> String {
        if token == "--" { return token }
        if token.hasPrefix("--") { return String(token.split(separator: "=").first ?? Substring(token)) }
        if token.hasPrefix("-"), token.count >= 2 { return String(token.prefix(2)) }
        return token
    }

    static func isUnsafe(_ token: String) -> Bool {
        if token == "--" || token.contains("\0") { return true }
        let name = flagName(token)
        if name.hasPrefix("--") { return unsafe.filter { $0.hasPrefix("--") }.contains { $0.hasPrefix(name) } }
        if token.hasPrefix("-"), !token.hasPrefix("--") {
            let valueOptions = Set("frtwMVcFLHBA TD".filter { !$0.isWhitespace })
            for flag in token.dropFirst() {
                if flag == "o" || flag == "d" { return true }
                if valueOptions.contains(flag) { break }
            }
        }
        return false
    }

    static func sanitize(_ extra: String) throws -> [String] {
        let tokens = try split(extra)
        var args: [String] = [], rejected: [String] = []
        var i = 0
        while i < tokens.count {
            let token = tokens[i]
            if token == "--" {
                rejected.append(contentsOf: tokens[i...])
                break
            }
            if isUnsafe(token) {
                rejected.append(token)
                let flag = flagName(token)
                let attached = token.count > flag.count && !token.contains("=") && flag.hasPrefix("-") && !flag.hasPrefix("--")
                if !token.contains("=") && !attached && i + 1 < tokens.count && !tokens[i + 1].hasPrefix("-") {
                    i += 1; rejected.append(tokens[i])
                }
                i += 1; continue
            }
            args.append(token); i += 1
        }
        if !rejected.isEmpty { throw ParseError.rejected(rejected) }
        return args
    }

    static func validate(arguments: [String]) throws {
        var i = 0
        while i < arguments.count {
            let token = arguments[i]
            if isUnsafe(token) {
                throw ParseError.rejected(Array(arguments[i...]))
            }
            i += 1
        }
    }

    static func structuredFlags(_ options: [String: Any]) -> [String] {
        var flags: [String] = []
        func value(_ keys: String...) -> Any? {
            for k in keys { if let v = options[k] { return v } }
            return nil
        }
        if let toc = value("tocDepth", "toc-depth"), "\(toc)" != "" { flags += ["--toc-depth", "\(toc)"] }
        if let split = value("splitLevel", "split-level"), "\(split)" != "" { flags += ["--split-level", "\(split)"] }
        if options["ascii"] as? Bool == true { flags.append("--ascii") }
        if options["reference-links"] as? Bool == true || options["referenceLinks"] as? Bool == true { flags.append("--reference-links") }
        if let loc = value("reference-location", "referenceLocation") as? String, !loc.isEmpty { flags += ["--reference-location", loc] }
        if let h = value("markdown-headings", "markdownHeadings") as? String, !h.isEmpty { flags += ["--markdown-headings", h] }
        if let tab = value("tab") as? String {
            if tab == "tab" { flags.append("--preserve-tabs") }
            else if !tab.isEmpty { flags += ["--tab-stop", tab] }
        }
        if let eol = value("eol") as? String, !eol.isEmpty { flags += ["--eol", eol] }
        if options["hardLineWrap"] as? Bool == true { flags += ["--wrap", "auto", "--columns", "\(value("columns") ?? 130)"] }
        if options["webtex"] as? Bool == true {
            if value("webtex-format", "webtexFormat") as? String == "svg" { flags.append("--webtex=https://latex.codecogs.com/svg.latex?") }
            else { flags.append("--webtex") }
        }
        for key in ["title", "author", "subject", "creator"] {
            if let item = options[key], !(item is NSNull) { flags += ["--metadata", "\(key)=\(item)"] }
        }
        if let ref = value("reference-doc", "referenceDoc") as? String, !ref.isEmpty { flags += ["--reference-doc", ref] }
        if let template = value("template") as? String, !template.isEmpty { flags += ["--template", template] }
        if let css = value("css") as? String, !css.isEmpty { flags += ["--css", css] }
        if let engine = value("pdf-engine", "pdfEngine") as? String, !engine.isEmpty { flags += ["--pdf-engine", engine] }
        return flags
    }
}

@MainActor
enum ExportPostActions {
    static var openFolder: (URL) -> Void = { NSWorkspace.shared.open($0) }
    static var openFile: (URL) -> Void = { NSWorkspace.shared.open($0) }
    static var runPostCommand: ((String, URL?, URL?) throws -> String)?
    static var presentOutput: (String) -> Void = showCommandOutput

    static func fire(options: [String: Any], general: ExportGeneralSettings, destination: URL?, output: String?, sourceDirectory: URL?, succeeded: Bool, snapshot: String? = nil, metadata: [String: String] = [:]) async {
        guard succeeded, !Task.isCancelled else { return }
        let custom = options["type"] as? String == "custom"
        let mode = options["saveDialog"] as? String ?? ""
        let openLocation = (!custom || !mode.isEmpty) && ((options["openExportLocation"] as? Bool) ?? general.openExportLocation)
        if openLocation, let destination {
            let directory = (try? destination.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            openFolder(directory ? destination : destination.deletingLastPathComponent())
        }
        if options["openExportFile"] as? Bool == true, (!custom || mode == "saveFile"), let destination,
           (try? destination.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) != true {
            openFile(destination)
        }
        var combined = output ?? ""
        var failed = false
        if !custom, options["runCommand"] as? Bool == true, let command = options["runCommandStr"] as? String, !command.isEmpty {
            let cancellation = ConversionCancellation()
            let hook = runPostCommand
            do {
                let text: String = try await withTaskCancellationHandler(operation: {
                    if Task.isCancelled { throw DocumentConversionError.cancelled }
                    return try await withCheckedThrowingContinuation { continuation in
                        DispatchQueue.global(qos: .userInitiated).async {
                            do {
                                if cancellation.isCancelled { throw DocumentConversionError.cancelled }
                                let text = try hook?(command, sourceDirectory, destination)
                                    ?? CustomCommandRunner.run(command: command, snapshot: snapshot, sourceDirectory: sourceDirectory, output: destination, metadata: metadata, cancellation: cancellation)
                                continuation.resume(returning: text)
                            } catch { continuation.resume(throwing: error) }
                        }
                    }
                }, onCancel: { cancellation.cancel() })
                combined += text
            } catch {
                if Task.isCancelled || cancellation.isCancelled { return }
                failed = true
                combined += "\n" + error.localizedDescription
            }
        }
        guard !Task.isCancelled else { return }
        if (failed || options["showOutput"] as? Bool == true), !combined.isEmpty { presentOutput(combined) }
    }

    static func showCommandOutput(_ text: String) {
        let alert = NSAlert()
        alert.messageText = "Command output"
        alert.informativeText = String(text.prefix(16_000))
        alert.runModal()
    }
}

enum ExportStaging {
    private static func path(_ url: URL) -> String { url.standardizedFileURL.resolvingSymlinksInPath().path }
    private static func checkSource(_ candidate: URL, source: URL?, replacingDirectory: Bool = false) throws {
        guard let source else { return }
        let original = path(source), proposed = path(candidate)
        if proposed == original || replacingDirectory && original.hasPrefix(proposed + "/") {
            throw DocumentConversionError.invalidDestination("Export cannot overwrite the Markdown source document.")
        }
    }

    static func commitFile(staging: URL, destination: URL, source: URL?) throws {
        guard staging.isFileURL, destination.isFileURL, path(staging) != path(destination) else {
            throw DocumentConversionError.invalidDestination("The staged output must be separate from its destination.")
        }
        // URL resource values may retain a previous export's attributes. Read
        // the actual staged entry; a command may intentionally create an empty file.
        let values = try? FileManager.default.attributesOfItem(atPath: staging.path)
        guard values?[.type] as? FileAttributeType == .typeRegular else { throw DocumentConversionError.missingOutput }
        try checkSource(staging, source: source)
        try checkSource(destination, source: source)
        guard Darwin.rename(staging.path, destination.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    /// Merge produced entries only. Each file replacement is atomic; the batch
    /// has a rollback journal and is deliberately not one directory-wide commit.
    static func commitFolderItems(staging: URL, destination: URL, source: URL?) throws {
        let manager = FileManager.default
        let stagePath = path(staging), targetPath = path(destination)
        guard staging.isFileURL, destination.isFileURL, stagePath != targetPath,
              !stagePath.hasPrefix(targetPath + "/"), !targetPath.hasPrefix(stagePath + "/"),
              (try? destination.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
            throw DocumentConversionError.invalidDestination("Choose a separate output directory for the staged products.")
        }
        let items = try manager.contentsOfDirectory(at: staging, includingPropertiesForKeys: nil).sorted { $0.lastPathComponent < $1.lastPathComponent }
        guard !items.isEmpty else { throw DocumentConversionError.missingOutput }
        let work = destination.appendingPathComponent(".typora-export-transaction-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var journal: [(destination: URL, backup: URL?)] = []
        var keepRecovery = false
        defer { if !keepRecovery { try? manager.removeItem(at: work) } }
        func exists(_ url: URL) -> Bool { (try? manager.attributesOfItem(atPath: url.path)) != nil }
        func install(_ item: URL, at target: URL) throws {
            let entry = try item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            let old = try? target.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            let isDirectory = entry.isDirectory == true && entry.isSymbolicLink != true
            try checkSource(target, source: source, replacingDirectory: !isDirectory && old?.isDirectory == true)
            if isDirectory {
                if exists(target) {
                    guard old?.isDirectory == true, old?.isSymbolicLink != true else {
                        throw DocumentConversionError.invalidDestination("A produced directory conflicts with an existing file: \(target.lastPathComponent)")
                    }
                } else {
                    try manager.createDirectory(at: target, withIntermediateDirectories: false)
                    journal.append((target, nil))
                }
                for child in try manager.contentsOfDirectory(at: item, includingPropertiesForKeys: nil).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                    try install(child, at: target.appendingPathComponent(child.lastPathComponent))
                }
            } else {
                guard old?.isDirectory != true else {
                    throw DocumentConversionError.invalidDestination("A produced file conflicts with an existing directory: \(target.lastPathComponent)")
                }
                let prepared = work.appendingPathComponent("new-\(UUID().uuidString)")
                try manager.copyItem(at: item, to: prepared)
                var backup: URL?
                if exists(target) {
                    let saved = work.appendingPathComponent("old-\(UUID().uuidString)")
                    try manager.copyItem(at: target, to: saved)
                    backup = saved
                }
                guard Darwin.rename(prepared.path, target.path) == 0 else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
                journal.append((target, backup))
            }
        }
        do {
            for item in items { try install(item, at: destination.appendingPathComponent(item.lastPathComponent)) }
        } catch {
            var recoveryFailed = false
            for entry in journal.reversed() {
                do {
                    if let backup = entry.backup {
                        guard Darwin.rename(backup.path, entry.destination.path) == 0 else {
                            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                        }
                    } else if exists(entry.destination) { try manager.removeItem(at: entry.destination) }
                } catch { recoveryFailed = true }
            }
            if recoveryFailed {
                keepRecovery = true
                throw DocumentConversionError.invalidDestination("Output rollback could not finish. Recovery copies remain at \(work.path). \(error.localizedDescription)")
            }
            throw error
        }
    }
}

enum CommandVariables {
    static let names = ["inputPath", "outputPath", "outputFolder", "sourcePath", "currentDir", "currentPath", "currentFileName", "currentFileFullName", "currentFolder", "outputFileName", "outputFileFullName", "title", "author", "today"]

    static func environment(_ variables: [String: String]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: variables.map { (envName($0.key), $0.value) })
    }

    static func rewrite(_ command: String, variables: [String: String] = [:]) -> String {
        let recognized = Set(names).union(variables.keys)
        let chars = Array(command)
        var result = "", index = 0
        var quote: Character?
        while index < chars.count {
            let ch = chars[index]
            if ch == "\\", quote != "'", index + 1 < chars.count {
                result.append(ch); result.append(chars[index + 1]); index += 2; continue
            }
            if ch == "$" {
                var end = index + 1, name = ""
                if end < chars.count, chars[end] == "{", let close = chars[(end + 1)...].firstIndex(of: "}") {
                    name = String(chars[(end + 1)..<close]); end = close + 1
                } else {
                    let start = end
                    while end < chars.count, chars[end].isLetter || chars[end].isNumber || chars[end] == "_" { end += 1 }
                    name = String(chars[start..<end])
                }
                if recognized.contains(name) {
                    let reference = "${" + envName(name) + "}"
                    if quote == "'" { result += "'\"" + reference + "\"'" }
                    else if quote == "\"" { result += reference }
                    else { result += "\"" + reference + "\"" }
                    index = end; continue
                }
            }
            if ch == "'" || ch == "\"" {
                if quote == ch { quote = nil } else if quote == nil { quote = ch }
            }
            result.append(ch); index += 1
        }
        return result
    }

    private static func envName(_ name: String) -> String {
        let known: [String: String] = ["inputPath":"INPUT_PATH", "outputPath":"OUTPUT_PATH", "outputFolder":"OUTPUT_FOLDER", "sourcePath":"SOURCE_PATH", "currentDir":"CURRENT_DIR", "currentPath":"CURRENT_PATH", "currentFileName":"CURRENT_FILE_NAME", "currentFileFullName":"CURRENT_FILE_FULL_NAME", "currentFolder":"CURRENT_FOLDER", "outputFileName":"OUTPUT_FILE_NAME", "outputFileFullName":"OUTPUT_FILE_FULL_NAME", "title":"TITLE", "author":"AUTHOR", "today":"TODAY"]
        return "TYPORA_" + (known[name] ?? "EXPORT_VAR_" + name.utf8.map { String(format: "%02X", $0) }.joined())
    }
}

private struct ExportCommandOutput {
    private var bytes = Data()
    private var truncated = false
    mutating func drain(_ fd: Int32) -> Int {
        var countRead = 0, buffer = [UInt8](repeating: 0, count: 8192)
        for _ in 0..<8 {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { break }
            let available = max(0, 16_384 - bytes.count)
            bytes.append(contentsOf: buffer.prefix(min(count, available)))
            truncated = truncated || count > available
            countRead += count
        }
        return countRead
    }
    var text: String {
        let suffix = truncated ? "\n[Diagnostics truncated]" : ""
        let decoded = String(decoding: bytes, as: UTF8.self)
        var valid = Data(decoded.utf8.prefix(16_384 - suffix.utf8.count))
        while !valid.isEmpty, String(data: valid, encoding: .utf8) == nil { valid.removeLast() }
        return (String(data: valid, encoding: .utf8) ?? "") + suffix
    }
}

enum ProcessGroupLauncher {
    struct Capture { var stdout = ""; var stderr = ""; var status: Int32 = 0; var pgid: pid_t = 0 }

    static func run(executable: String, arguments: [String], environment: [String: String], cwd: String?, timeout: TimeInterval, cancellation: ConversionCancellation) throws -> Capture {
        guard !executable.isEmpty, !executable.contains("\0"), !arguments.contains(where: { $0.contains("\0") }),
              !environment.contains(where: { $0.key.isEmpty || $0.key.contains("=") || $0.key.contains("\0") || $0.value.contains("\0") }),
              cwd?.contains("\0") != true, timeout.isFinite, timeout > 0 else { throw POSIXError(.EINVAL) }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        func checked(_ code: Int32) throws { if code != 0 { throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO) } }
        var attr: posix_spawnattr_t?
        try checked(posix_spawnattr_init(&attr))
        defer { posix_spawnattr_destroy(&attr) }
        try checked(posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)))
        try checked(posix_spawnattr_setpgroup(&attr, 0))
        var actions: posix_spawn_file_actions_t?
        try checked(posix_spawn_file_actions_init(&actions))
        defer { posix_spawn_file_actions_destroy(&actions) }
        var output: [Int32] = [-1, -1], error: [Int32] = [-1, -1]
        guard pipe(&output) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { output.filter { $0 >= 0 }.forEach { Darwin.close($0) } }
        guard pipe(&error) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { error.filter { $0 >= 0 }.forEach { Darwin.close($0) } }
        try checked(posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0))
        for pair in [(output, STDOUT_FILENO), (error, STDERR_FILENO)] {
            try checked(posix_spawn_file_actions_adddup2(&actions, pair.0[1], pair.1))
            try checked(posix_spawn_file_actions_addclose(&actions, pair.0[0]))
            try checked(posix_spawn_file_actions_addclose(&actions, pair.0[1]))
        }
        if let cwd { try checked(posix_spawn_file_actions_addchdir_np(&actions, cwd)) }
        let argv = ([executable] + arguments).map { strdup($0) } + [nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }
        for fd in [output[0], error[0]] {
            guard fcntl(fd, F_SETFL, O_NONBLOCK) != -1 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        var pid: pid_t = 0
        try checked(posix_spawn(&pid, executable, &actions, &attr, argv, envp))
        Darwin.close(output[1]); output[1] = -1
        Darwin.close(error[1]); error[1] = -1
        var reaped = false
        defer {
            if !reaped {
                kill(-pid, SIGKILL)
                var status: Int32 = 0
                while waitpid(pid, &status, 0) < 0 && errno == EINTR { }
            }
        }
        var out = ExportCommandOutput(), err = ExportCommandOutput(), status: Int32 = 0
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        func reap() throws -> Bool {
            if reaped { return true }
            let result = waitpid(pid, &status, WNOHANG)
            if result == pid { reaped = true; return true }
            if result < 0 && errno != EINTR { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ECHILD) }
            return false
        }
        var stopped: DocumentConversionError?
        while true {
            _ = out.drain(output[0]); _ = err.drain(error[0])
            if cancellation.isCancelled { stopped = .cancelled }
            else if ProcessInfo.processInfo.systemUptime >= deadline { stopped = .timedOut(timeout) }
            if stopped != nil {
                kill(-pid, SIGTERM)
                let grace = ProcessInfo.processInfo.systemUptime + 0.25
                while ProcessInfo.processInfo.systemUptime < grace {
                    _ = out.drain(output[0]); _ = err.drain(error[0])
                    _ = try reap()
                    if kill(-pid, 0) != 0 && errno == ESRCH { break }
                    usleep(10_000)
                }
                // Kill surviving descendants even if the group leader already
                // exited on TERM. A reaped leader is never waited a second time.
                kill(-pid, SIGKILL)
                if !reaped {
                    var result: pid_t
                    repeat { result = waitpid(pid, &status, 0) } while result < 0 && errno == EINTR
                    guard result == pid else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ECHILD) }
                    reaped = true
                }
                break
            }
            if try reap() { break }
            usleep(10_000)
        }
        let eofDeadline = ProcessInfo.processInfo.systemUptime + 0.2
        repeat {
            let count = out.drain(output[0]) + err.drain(error[0])
            if count == 0 { break }
        } while ProcessInfo.processInfo.systemUptime < eofDeadline
        if let stopped { throw stopped }
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        let signal = status & 0x7f, code = (status >> 8) & 0xff
        guard signal == 0, code == 0 else { throw DocumentConversionError.processFailed(signal == 0 ? code : -signal, err.text.isEmpty ? out.text : err.text) }
        return Capture(stdout: out.text, stderr: err.text, status: code, pgid: pid)
    }
}

enum CustomCommandRunner {
    static func run(command: String, snapshot: String?, sourceDirectory: URL?, output: URL?, metadata: [String: String] = [:], timeout: TimeInterval = 60, cancellation: ConversionCancellation) throws -> String {
        if cancellation.isCancelled { throw DocumentConversionError.cancelled }
        guard !command.contains("\0"), !metadata.contains(where: { $0.key.contains("\0") || $0.value.contains("\0") }) else { throw POSIXError(.EINVAL) }
        let manager = FileManager.default
        let folder = manager.temporaryDirectory.appendingPathComponent("typora-cmd-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: folder) }
        let input = folder.appendingPathComponent("snapshot.md")
        try Data((snapshot ?? "").utf8).write(to: input)
        let originalPath = metadata["sourcePath"] ?? metadata["currentPath"] ?? ""
        let original = originalPath.isEmpty ? nil : URL(fileURLWithPath: originalPath)
        let currentFolder = sourceDirectory?.path ?? original?.deletingLastPathComponent().path ?? ""
        let directory = (try? output?.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        var variables = metadata
        variables["inputPath"] = input.path
        variables["sourcePath"] = originalPath
        variables["currentPath"] = originalPath
        variables["currentFileName"] = original?.deletingPathExtension().lastPathComponent ?? ""
        variables["currentFileFullName"] = original?.lastPathComponent ?? ""
        variables["currentFolder"] = currentFolder
        variables["currentDir"] = currentFolder
        variables["outputPath"] = output?.path ?? ""
        variables["outputFolder"] = directory ? (output?.path ?? "") : (output?.deletingLastPathComponent().path ?? "")
        variables["outputFileName"] = output?.deletingPathExtension().lastPathComponent ?? ""
        variables["outputFileFullName"] = output?.lastPathComponent ?? ""
        variables["title"] = metadata["title"] ?? ""
        variables["author"] = metadata["author"] ?? ""
        let date = DateFormatter(); date.locale = Locale(identifier: "en_US_POSIX"); date.dateFormat = "yyyy-MM-dd"
        variables["today"] = metadata["today"] ?? date.string(from: Date())
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in CommandVariables.environment(variables) { environment[key] = value }
        let rewritten = CommandVariables.rewrite(command, variables: variables)
        let capture = try ProcessGroupLauncher.run(executable: "/bin/zsh", arguments: ["-c", rewritten], environment: environment, cwd: sourceDirectory?.path, timeout: timeout, cancellation: cancellation)
        return capture.stdout + capture.stderr
    }
}
