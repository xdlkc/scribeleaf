import Foundation

@main struct DependencyChecks {
    static func main() throws {
        let manager = FileManager.default
        let work = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try manager.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: work) }
        let existing = work.appendingPathComponent("trusted existing pandoc")
        let other = work.appendingPathComponent("bundled pandoc")
        let nonExecutable = work.appendingPathComponent("not executable")
        for url in [existing, other, nonExecutable] {
            try Data("fixture; never executed".utf8).write(to: url)
            try manager.setAttributes([.posixPermissions: url == nonExecutable ? 0o600 : 0o700], ofItemAtPath: url.path)
        }
        var checks = 0
        func check(_ name: String, _ condition: Bool) {
            precondition(condition, name); checks += 1; print("PASS \(name)")
        }
        do {
            _ = try DocumentConverter.resolveExecutable(customURL: nil, candidates: [])
            fatalError("Missing dependency silently accepted")
        } catch DocumentConversionError.missingDependency { check("Missing converter throws a user-visible dependency error", true) }
        let en = DocumentConversionError.missingDependencyMessage(language: "en")
        let zh = DocumentConversionError.missingDependencyMessage(language: "zh-Hans")
        check("English remedy explains Full, existing converter and no automatic download", en.contains("Scribeleaf Full") && en.contains("trusted existing Pandoc") && en.contains("No dependency is downloaded"))
        check("Chinese remedy explains Full, existing converter and no automatic download", zh.contains("Scribeleaf Full") && zh.contains("已有 Pandoc") && zh.contains("不会自动下载"))
        let configured = try DocumentConverter.resolveExecutable(customURL: existing, candidates: [other])
        check("Configured existing converter takes precedence", configured == existing)
        let bundled = try DocumentConverter.resolveExecutable(customURL: nil, candidates: [other, existing])
        check("First valid local converter selected", bundled == other)
        do {
            _ = try DocumentConverter.resolveExecutable(customURL: work.appendingPathComponent("missing"), candidates: [other])
            fatalError("Invalid explicit converter silently replaced")
        } catch DocumentConversionError.invalidExecutable { check("Invalid configured converter reports an explicit error", true) }
        do {
            _ = try DocumentConverter.resolveExecutable(customURL: nil, candidates: [work, nonExecutable])
            fatalError("Directory/non-executable accepted")
        } catch DocumentConversionError.missingDependency { check("Directories and non-executables rejected", true) }
        print("PASS: \(checks) dependency behavior checks; fixture executables were never launched")
    }
}
