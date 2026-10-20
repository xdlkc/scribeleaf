
import Foundation
import Darwin

@main
struct RestartProof {
    static func main() throws {
        let id = Bundle.main.bundleIdentifier ?? ""
        guard CommandLine.arguments.count == 5 else { exit(2) }
        let expectedID = CommandLine.arguments[1]
        let expectedOutput = CommandLine.arguments[2]
        let expectedPandoc = CommandLine.arguments[3]
        let previousPID = Int(CommandLine.arguments[4]) ?? 0
        setenv("TYPORA_REPLICA_DEFAULTS_SUITE", id, 1)
        let defaults = AppPreferencesStore.defaults
        let sentinel = defaults.string(forKey: "qa.restart.sentinel")
        let editor = AppPreferencesStore.loadEditorPrefs()
        let settings = AppPreferencesStore.loadExport()
        let fields: [String: Any] = [
            "sentinel": sentinel ?? NSNull(),
            "theme": editor["theme"] ?? NSNull(),
            "qaPersist": editor["qaPersist"] ?? NSNull(),
            "general": ["exportFolder": settings.general.exportFolder,
                "customExportPath": settings.general.customExportPath,
                "openExportLocation": settings.general.openExportLocation],
            "pandocPath": settings.pandocPath,
            "htmlExportTheme": settings.formats["html"]?["exportTheme"]?.any ?? NSNull()
        ]
        let checks: [String: Bool] = [
            "sameRealBundleIdentifier": id == expectedID && !id.isEmpty,
            "newProcess": ProcessInfo.processInfo.processIdentifier != previousPID,
            "sentinelThroughProductionStore": sentinel == "QA_RESTART_SENTINEL",
            "editorThemeNight": editor["theme"] as? String == "night",
            "editorWitness": editor["qaPersist"] as? String == "1",
            "exportFolderCustom": settings.general.exportFolder == "custom",
            "exactQAOutputPath": settings.general.customExportPath == expectedOutput,
            "exactQAPandocPath": settings.pandocPath == expectedPandoc,
            "explicitHTMLThemeNight": settings.formats["html"]?["exportTheme"]?.any as? String == "night"
        ]
        let passed = checks.values.allSatisfy { $0 }
        let result: [String: Any] = [
            "bundleIdentifier": id,
            "bundlePath": Bundle.main.bundlePath,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "previousQAPID": previousPID,
            "fields": fields,
            "checks": checks,
            "passed": passed,
            "scope": "New Foundation-only process. Actual production AppPreferencesStore reads. No NSApplication, no defaults writes."
        ]
        let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(passed ? 0 : 1)
    }
}
