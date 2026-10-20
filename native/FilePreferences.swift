import Foundation
import CoreFoundation

enum FileBrowserView { case tree, library }
enum FileDropAction: String { case open, link, `import` }

struct FileLaunchTarget: Equatable {
    let path: String
    let isDirectory: Bool
}

/// Independent defaults, shared with file-preferences.ts. Installed macOS
/// factory defaults remain unproven. This type does not read user preferences.
struct FilePreferences: Equatable {
    private static let globCache: NSCache<NSString, NSRegularExpression> = {
        let cache = NSCache<NSString, NSRegularExpression>()
        cache.countLimit = 256
        return cache
    }()
    var defaultExtension = "md"
    var restoreWhenLaunch = 0
    var pinFolder = ""
    var collapsibleOutline = false
    var saveOnFileSwitch = false
    var recordRecentFiles = true
    var folderDropAction = FileDropAction.open
    var markdownDropAction = FileDropAction.open
    var importDropAction = FileDropAction.import
    var showHiddenFiles = false
    var treeFileFilterMode = "supported"
    var libraryFileFilterMode = "supported"
    var treeFileFilterPatterns: [String] = []
    var libraryFileFilterPatterns: [String] = []
    private var extensionOverride: Set<String>?

    static let standardExtensions = Set(["md", "markdown", "mmd", "mkd", "mdwn", "mdown", "mdx", "mdtxt", "mdtext", "apib", "rmarkdown", "rmd", "qmd", "txt", "text"])

    init(values: [String: Any] = [:], supportedExtensions: Set<String>? = nil) {
        extensionOverride = supportedExtensions
        if let text = values["defaultExtension"] as? String { defaultExtension = Self.normalizeExtension(text) }
        if let number = Self.integer(values["restoreWhenLaunch"]), (0...3).contains(number) { restoreWhenLaunch = number }
        if let text = values["pinFolder"] as? String { pinFolder = text }
        if let flag = Self.boolean(values["collapsibleOutline"]) { collapsibleOutline = flag }
        if let flag = Self.boolean(values["saveOnFileSwitch"]) { saveOnFileSwitch = flag }
        if let flag = Self.boolean(values["recordRecentFiles"]) { recordRecentFiles = flag }
        if let flag = Self.boolean(values["showHiddenFiles"]) { showHiddenFiles = flag }
        if let action = values["folderDropAction"] as? String, ["open", "link"].contains(action) { folderDropAction = FileDropAction(rawValue: action)! }
        if let action = values["markdownDropAction"] as? String, ["open", "link"].contains(action) { markdownDropAction = FileDropAction(rawValue: action)! }
        if let action = values["importDropAction"] as? String, ["import", "link"].contains(action) { importDropAction = FileDropAction(rawValue: action)! }
        if let mode = values["treeFileFilterMode"] as? String, ["supported", "custom", "all"].contains(mode) { treeFileFilterMode = mode }
        if let mode = values["libraryFileFilterMode"] as? String, ["supported", "custom"].contains(mode) { libraryFileFilterMode = mode }
        if let patterns = values["treeFileFilterPatterns"] as? [Any] { treeFileFilterPatterns = patterns.compactMap { $0 as? String } }
        if let patterns = values["libraryFileFilterPatterns"] as? [Any] { libraryFileFilterPatterns = patterns.compactMap { $0 as? String } }
    }

    static func normalizeExtension(_ value: String) -> String {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let range = text.range(of: "^\\.?[a-z0-9_-]+(\\.[a-z0-9_-]+)*", options: .regularExpression) else { return "" }
        let result = String(text[range])
        return result.hasPrefix(".") ? String(result.dropFirst()) : result
    }

    var effectiveDefaultExtension: String { defaultExtension.isEmpty ? "md" : defaultExtension }
    var supportedExtensions: Set<String> {
        if let extensionOverride { return extensionOverride }
        return Self.standardExtensions.union([effectiveDefaultExtension])
    }

    func isSupportedFile(named name: String) -> Bool {
        guard let dot = name.lastIndex(of: "."), dot < name.index(before: name.endIndex) else { return true }
        return supportedExtensions.contains(String(name[name.index(after: dot)...]).lowercased())
    }

    func allowsDirectory(relativePath: String, view: FileBrowserView) -> Bool {
        let components = relativePath.replacingOccurrences(of: "\\", with: "/").split(separator: "/").map(String.init)
        if !showHiddenFiles && components.contains(where: { $0.hasPrefix(".") }) { return false }
        return view == .tree && treeFileFilterMode == "all" || !components.contains("node_modules")
    }

    func allowsFile(name: String, relativePath: String, view: FileBrowserView) -> Bool {
        let components = relativePath.replacingOccurrences(of: "\\", with: "/").split(separator: "/").map(String.init)
        if !showHiddenFiles && components.contains(where: { $0.hasPrefix(".") }) { return false }
        guard allowsDirectory(relativePath: components.dropLast().joined(separator: "/"), view: view) else { return false }
        let mode = view == .tree ? treeFileFilterMode : libraryFileFilterMode
        if mode == "all" { return true }
        let supported = isSupportedFile(named: name)
        if mode != "custom" { return supported }
        return Self.matchesPatterns(name: name, relativePath: relativePath,
            patterns: view == .tree ? treeFileFilterPatterns : libraryFileFilterPatterns, supported: supported)
    }

    func allowsEnumeratedDirectory(relativePath: String) -> Bool {
        allowsDirectory(relativePath: relativePath, view: .tree) || allowsDirectory(relativePath: relativePath, view: .library)
    }

    func allowsEnumeratedFile(name: String, relativePath: String) -> Bool {
        allowsFile(name: name, relativePath: relativePath, view: .tree) || allowsFile(name: name, relativePath: relativePath, view: .library)
    }

    /// Explicit OS open requests take precedence over a saved launch policy.
    /// A true systemClosesWindows models the documented system override.
    func launchPlan(previousFiles: [String], previousFolders: [String], explicitOpenRequested: Bool = false,
                    systemClosesWindows: Bool = false) -> [FileLaunchTarget] {
        guard !explicitOpenRequested else { return [] }
        if systemClosesWindows && (restoreWhenLaunch == 1 || restoreWhenLaunch == 2) { return [] }
        var seen = Set<String>()
        func unique(_ paths: [String], directory: Bool) -> [FileLaunchTarget] {
            paths.filter { !$0.isEmpty && seen.insert($0).inserted }.map { FileLaunchTarget(path: $0, isDirectory: directory) }
        }
        switch restoreWhenLaunch {
        case 1: return unique(previousFolders, directory: true)
        case 2: return unique(previousFiles, directory: false) + unique(previousFolders, directory: true)
        case 3: return unique([pinFolder], directory: true)
        default: return []
        }
    }

    func shouldSaveOnFileSwitch(systemAlwaysConfirmsChanges: Bool = true) -> Bool {
        saveOnFileSwitch || !systemAlwaysConfirmsChanges
    }

    func dropAction(for url: URL, isDirectory: Bool, importable: Bool) -> FileDropAction {
        if isDirectory { return folderDropAction }
        if isSupportedFile(named: url.lastPathComponent) { return markdownDropAction }
        return importable ? importDropAction : .link
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue else { return nil }
        return number.intValue
    }

    static func matchesPatterns(name: String, relativePath: String, patterns: [String], supported: Bool) -> Bool {
        var included = supported
        var excluded = false
        let path = relativePath.replacingOccurrences(of: "\\", with: "/").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        for raw in patterns {
            var pattern = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let exclude = pattern.hasPrefix("!")
            if exclude { pattern = String(pattern.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines) }
            guard !pattern.isEmpty, let expression = globExpression(pattern) else { continue }
            let candidate = Self.regexUTF16Units(pattern.contains("/") ? path : name)
            guard expression.firstMatch(in: candidate, range: NSRange(candidate.startIndex..., in: candidate)) != nil else { continue }
            if exclude { excluded = true } else { included = true }
        }
        return included && !excluded
    }

    static func globExpression(_ pattern: String) -> NSRegularExpression? {
        if let cached = globCache.object(forKey: pattern as NSString) { return cached }
        // JS's non-u regular expressions consume UTF-16 units. ICU consumes
        // scalar values. Map each non-ASCII unit to one distinct PUA scalar so
        // '?' and character classes also agree on emoji and combining text.
        let chars = Array(regexUTF16Units(pattern))
        let anySequence = "[^\\n\\r\\x{F2028}\\x{F2029}]*"
        var expression = ""
        var index = 0
        while index < chars.count {
            let char = chars[index]
            if char == "*" {
                if index + 1 < chars.count && chars[index + 1] == "*" {
                    index += 1
                    if index + 1 < chars.count && chars[index + 1] == "/" { index += 1; expression += "(?:" + anySequence + "/)?" }
                    else { expression += anySequence }
                } else { expression += "[^/]*" }
            } else if char == "?" { expression += "[^/]" }
            else if char == "[" {
                var end = index + 1
                var group = ""
                if end < chars.count && (chars[end] == "!" || chars[end] == "^") { group = "^"; end += 1 }
                while end < chars.count && chars[end] != "]" {
                    let item = chars[end]
                    if item == "\\" && end + 1 < chars.count { group += "\\" + String(chars[end + 1]); end += 2 }
                    else { group += ".^$+(){}=|".contains(item) ? "\\" + String(item) : String(item); end += 1 }
                }
                guard end < chars.count else { return nil }
                expression += "[" + group + "]"; index = end
            } else { expression += ".^$+(){}=!|\\".contains(char) ? "\\" + String(char) : String(char) }
            index += 1
        }
        // JavaScript '$' also permits a final line terminator. The lookahead
        // preserves that behavior after mapping U+2028/U+2029 to PUA scalars.
        guard let compiled = try? NSRegularExpression(pattern: "\\A" + expression + "(?=\\z|[\\n\\r\\x{F2028}\\x{F2029}]\\z|\\r\\n\\z)") else { return nil }
        globCache.setObject(compiled, forKey: pattern as NSString)
        return compiled
    }

    private static func regexUTF16Units(_ text: String) -> String {
        var result = String.UnicodeScalarView()
        for unit in text.utf16 { result.append(UnicodeScalar(unit < 128 ? UInt32(unit) : 0xF0000 + UInt32(unit))!) }
        return String(result)
    }
}
