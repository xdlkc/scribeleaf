import Foundation

enum RepeatExport {
    static let formats: Set<String> = [
        "html", "html-plain", "pdf", "png",
        "docx", "odt", "rtf", "epub", "latex", "mediawiki", "rst", "textile", "opml"
    ]
    static let overwriteWarningDefaultsKey = "noWarningForExportOverwrite"

    static func isValidFormat(_ format: String) -> Bool { formats.contains(format) || !format.isEmpty }

    static func fileExtension(for format: String) -> String {
        switch format {
        case "html-plain": return "html"
        case "latex": return "tex"
        case "mediawiki": return "wiki"
        default: return format
        }
    }

    static func identityKey(fileURL: URL?, unsavedID: String) -> String {
        if let fileURL { return fileURL.standardizedFileURL.path }
        return "unsaved:" + unsavedID
    }
}

struct RepeatExportHistory: Equatable {
    var format: String?
    var destinationPath: String?
    var noOverwrite = true
    var hasOutputDestination = true
    var recordedIdentity: String?
    var frozenSettings: [String: Any] = [:]

    static func == (lhs: RepeatExportHistory, rhs: RepeatExportHistory) -> Bool {
        lhs.format == rhs.format && lhs.destinationPath == rhs.destinationPath
            && lhs.noOverwrite == rhs.noOverwrite && lhs.recordedIdentity == rhs.recordedIdentity
    }

    var canExportPrevious: Bool {
        guard let format, RepeatExport.isValidFormat(format), let recordedIdentity, !recordedIdentity.isEmpty else { return false }
        if hasOutputDestination {
            guard let destinationPath, destinationPath.hasPrefix("/"), !destinationPath.contains("\0") else { return false }
        }
        return format != "general"
    }

    var canOverwrite: Bool { canExportPrevious && hasOutputDestination && !noOverwrite }

    mutating func record(format: String, destinationPath: String, identity: String, frozenSettings: [String: Any] = [:]) -> Bool {
        guard destinationPath.hasPrefix("/"), !destinationPath.contains("\0"), !identity.isEmpty else { return false }
        if !RepeatExport.isValidFormat(format) && frozenSettings.isEmpty { return false }
        self.format = format
        self.destinationPath = URL(fileURLWithPath: destinationPath).standardizedFileURL.path
        self.hasOutputDestination = true
        self.noOverwrite = false
        self.recordedIdentity = identity
        self.frozenSettings = frozenSettings
        return true
    }

    mutating func recordWithoutDestination(format: String, identity: String, frozenSettings: [String: Any]) {
        self.format = format; destinationPath = nil; noOverwrite = true
        hasOutputDestination = false; recordedIdentity = identity; self.frozenSettings = frozenSettings
    }

    mutating func noteDocumentIdentity(_ identity: String) {
        guard recordedIdentity != nil, recordedIdentity != identity else { return }
        noOverwrite = true
    }

    func usesExactLastPath(currentIdentity: String) -> Bool {
        canOverwrite && recordedIdentity == currentIdentity
    }

    func panelSuggestion(currentIdentity: String, documentName: String) -> (directory: String, filename: String)? {
        guard canExportPrevious, let destinationPath, let format else { return nil }
        let url = URL(fileURLWithPath: destinationPath)
        if usesExactLastPath(currentIdentity: currentIdentity) {
            return (url.deletingLastPathComponent().path, url.lastPathComponent)
        }
        let base = (documentName as NSString).deletingPathExtension
        let options = frozenSettings["options"] as? [String: Any] ?? [:]
        let type = frozenSettings["type"] as? String ?? format
        let configured = (options["extensions"] as? String ?? "").split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace }).first.map { String($0).trimmingCharacters(in: CharacterSet(charactersIn: ".")) }
        let ext = configured?.isEmpty == false ? configured! : (type == "pandoc" ? url.pathExtension : (type == "image" ? "png" : (type == "wiki" ? "wiki" : (type == "markdown" ? "md" : (type == "latex-pdf" ? "pdf" : RepeatExport.fileExtension(for: type))))))
        return (url.deletingLastPathComponent().path, base + (ext.isEmpty ? "" : "." + ext))
    }
}

/// A renderer reply belongs to one request and one source identity. The native
/// side supplies all fields; the renderer only echoes the request identifier.
struct RepeatExportRequest: Equatable {
    let id: String
    let format: String
    let overwrite: Bool
    let identity: String

    func accepts(id: String, format: String, overwrite: Bool, identity: String) -> Bool {
        self.id == id && self.format == format && self.overwrite == overwrite && self.identity == identity
    }
}
