import Foundation
import CoreServices

@main
struct FilePreferencesVerifier {
    static func main() throws {
        var checks: [[String: Any]] = []
        func check(_ name: String, _ passed: Bool, _ actual: Any? = nil) {
            var result: [String: Any] = ["name": name, "passed": passed]
            if let actual { result["actual"] = actual }
            checks.append(result)
        }
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
        for row in fixture {
            let actual = FilePreferences.matchesPatterns(name: row["name"] as! String, relativePath: row["path"] as! String,
                patterns: row["patterns"] as! [String], supported: row["supported"] as! Bool)
            check("glob-" + (row["id"] as! String), actual == (row["expected"] as! Bool), actual)
        }
        let defaults = FilePreferences()
        check("default-md", defaults.effectiveDefaultExtension == "md")
        check("supports-extensionless-and-rmarkdown", defaults.isSupportedFile(named: "README") && defaults.isSupportedFile(named: "notes.rmarkdown"))
        check("custom-extension-normalization", FilePreferences.normalizeExtension(" .NOTE.Book /junk") == "note.book")
        check("invalid-extension-prefix-cleared", FilePreferences.normalizeExtension("!!md") == "")
        let custom = FilePreferences(values: ["defaultExtension": ".FOO"])
        check("custom-extension-added-to-supported", custom.effectiveDefaultExtension == "foo" && custom.isSupportedFile(named: "sample.FOO"))
        let invalid = FilePreferences(values: ["showHiddenFiles": 1, "recordRecentFiles": "false", "restoreWhenLaunch": true,
            "libraryFileFilterMode": "all", "treeFileFilterPatterns": ["*.csv", 5]])
        check("native-json-type-validation", !invalid.showHiddenFiles && invalid.recordRecentFiles && invalid.restoreWhenLaunch == 0 && invalid.libraryFileFilterMode == "supported" && invalid.treeFileFilterPatterns == ["*.csv"])
        check("native-hidden-file-rejected-before-all", !FilePreferences(values: ["treeFileFilterMode": "all"]).allowsFile(name: ".data.csv", relativePath: "nested/.data.csv", view: .tree))
        check("node-modules-file-is-not-directory", defaults.allowsFile(name: "node_modules", relativePath: "node_modules", view: .tree))
        check("node-modules-directory-hidden-in-supported", !defaults.allowsDirectory(relativePath: "node_modules", view: .tree))
        let all = FilePreferences(values: ["treeFileFilterMode": "all"])
        check("node-modules-directory-visible-only-in-tree-all", all.allowsDirectory(relativePath: "node_modules", view: .tree) && !all.allowsDirectory(relativePath: "node_modules", view: .library))
        let target = URL(fileURLWithPath: "/synthetic/notes.md")
        let drop = FilePreferences(values: ["folderDropAction": "link", "markdownDropAction": "link", "importDropAction": "link"])
        check("drop-folder-policy", drop.dropAction(for: target, isDirectory: true, importable: false) == .link)
        check("drop-markdown-policy", drop.dropAction(for: target, isDirectory: false, importable: true) == .link)
        check("drop-import-policy", defaults.dropAction(for: URL(fileURLWithPath: "/synthetic/book.docx"), isDirectory: false, importable: true) == .import)
        check("drop-unsupported-fallback-link", defaults.dropAction(for: URL(fileURLWithPath: "/synthetic/data.bin"), isDirectory: false, importable: false) == .link)
        check("switch-save-system-override", defaults.shouldSaveOnFileSwitch(systemAlwaysConfirmsChanges: false) && !defaults.shouldSaveOnFileSwitch())
        check("switch-save-setting", FilePreferences(values: ["saveOnFileSwitch": true]).shouldSaveOnFileSwitch())
        let files = ["/synthetic/a.md", "/synthetic/a.md", ""]
        let folders = ["/synthetic/project", "/synthetic/project"]
        check("launch-new-empty-plan", defaults.launchPlan(previousFiles: files, previousFolders: folders).isEmpty)
        let foldersPlan = FilePreferences(values: ["restoreWhenLaunch": 1]).launchPlan(previousFiles: files, previousFolders: folders)
        check("launch-folders-only-deduplicated", foldersPlan == [FileLaunchTarget(path: folders[0], isDirectory: true)])
        let restore = FilePreferences(values: ["restoreWhenLaunch": 2])
        check("launch-files-and-folders", restore.launchPlan(previousFiles: files, previousFolders: folders) == [FileLaunchTarget(path: files[0], isDirectory: false), FileLaunchTarget(path: folders[0], isDirectory: true)])
        check("launch-explicit-open-wins", restore.launchPlan(previousFiles: files, previousFolders: folders, explicitOpenRequested: true).isEmpty)
        check("launch-system-close-wins", restore.launchPlan(previousFiles: files, previousFolders: folders, systemClosesWindows: true).isEmpty)
        check("launch-pinned-folder", FilePreferences(values: ["restoreWhenLaunch": 3, "pinFolder": "/synthetic/pin"]).launchPlan(previousFiles: files, previousFolders: folders) == [FileLaunchTarget(path: "/synthetic/pin", isDirectory: true)])
        check("launch-pinned-folder-explicit-policy-survives-system-close", FilePreferences(values: ["restoreWhenLaunch": 3, "pinFolder": "/synthetic/pin"]).launchPlan(previousFiles: files, previousFolders: folders, systemClosesWindows: true) == [FileLaunchTarget(path: "/synthetic/pin", isDirectory: true)])
        check("launch-unset-pin-no-path", FilePreferences(values: ["restoreWhenLaunch": 3]).launchPlan(previousFiles: files, previousFolders: folders).isEmpty)

        // These are the only files this verifier creates. No preferences or user
        // directories are read, written, restored or added to Recent Documents.
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("typora-file-preferences-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let paths = ["README", "node_modules", "notes.md", "data.csv", "notes.rmarkdown", "😀.md", ".hidden.md", "nested/notes.md", "nested/draft-copy.md", "nested/table.csv", "nested/image.png", "hidden-folder/.ignore.txt", ".private/notes.md", "node_modules-folder/node_modules/pkg.md"]
        for path in paths {
            let url = root.appendingPathComponent(path)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("synthetic fixture".utf8).write(to: url)
        }
        try fm.createDirectory(at: root.appendingPathComponent("empty-assets"), withIntermediateDirectories: true)
        func snapshot(_ values: [String: Any]) -> FolderSnapshot { FolderMonitor.snapshot(root: root, preferences: FilePreferences(values: values)) }
        let supported = snapshot([:])
        check("disk-supported-selection", Set(supported.files.map(\.relativePath)) == Set(["README", "node_modules", "notes.md", "notes.rmarkdown", "😀.md", "nested/notes.md", "nested/draft-copy.md"]))
        check("disk-empty-and-assets-directories-preserved", Set(supported.directories.map(\.relativePath)).isSuperset(of: ["nested", "empty-assets", "hidden-folder"]))
        check("disk-hidden-directory-pruned", !supported.directories.contains { $0.relativePath == ".private" })
        let shown = snapshot(["showHiddenFiles": true])
        check("disk-hidden-enabled", Set(shown.files.map(\.relativePath)).isSuperset(of: [".hidden.md", ".private/notes.md", "hidden-folder/.ignore.txt"]))
        let allSnapshot = snapshot(["treeFileFilterMode": "all"])
        check("disk-tree-all-adds-assets-and-node-modules", Set(allSnapshot.files.map(\.relativePath)).isSuperset(of: ["data.csv", "nested/image.png", "node_modules-folder/node_modules/pkg.md"]))
        check("disk-tree-all-still-hides-hidden", !allSnapshot.files.contains { $0.relativePath.hasPrefix(".") })
        let customSnapshot = snapshot(["treeFileFilterMode": "custom", "treeFileFilterPatterns": ["*.csv", "!**/draft-*.md"], "libraryFileFilterMode": "custom", "libraryFileFilterPatterns": ["!**/draft-*.md"]])
        check("disk-custom-union-and-exclusion", customSnapshot.files.contains { $0.relativePath == "nested/table.csv" } && !customSnapshot.files.contains { $0.relativePath == "nested/draft-copy.md" })
        let emojiSnapshot = snapshot(["treeFileFilterMode": "custom", "treeFileFilterPatterns": ["!?.md"], "libraryFileFilterMode": "custom", "libraryFileFilterPatterns": ["!?.md"]])
        check("disk-emoji-not-falsely-excluded-by-one-unit-glob", emojiSnapshot.files.contains { $0.relativePath == "😀.md" })
        let union = snapshot(["treeFileFilterMode": "custom", "treeFileFilterPatterns": ["*.csv"], "libraryFileFilterMode": "custom", "libraryFileFilterPatterns": ["*.png"]])
        check("disk-modes-enumerate-union", union.files.contains { $0.name == "table.csv" } && union.files.contains { $0.name == "image.png" })
        check("disk-paths-retain-selected-root", union.files.allSatisfy { $0.path == root.appendingPathComponent($0.relativePath).path } && union.root == root.path)
        check("disk-natural-order", union.files.map(\.relativePath) == union.files.map(\.relativePath).sorted { $0.localizedStandardCompare($1) == .orderedAscending })
        var deliveries: [FolderSnapshot] = []
        let monitor = FolderMonitor(root: root, preferences: defaults) { deliveries.append($0) }
        monitor.start()
        let firstDeadline = Date().addingTimeInterval(5)
        while deliveries.isEmpty && Date() < firstDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        check("monitor-initial-delivery", deliveries.first?.files == supported.files)
        monitor.updatePreferences(FilePreferences(values: ["treeFileFilterMode": "all", "showHiddenFiles": true]))
        let updateDeadline = Date().addingTimeInterval(5)
        while deliveries.count < 2 && Date() < updateDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        check("monitor-live-preference-rescan", deliveries.count >= 2 && deliveries.last!.files.contains { $0.relativePath == ".hidden.md" } && deliveries.last!.files.contains { $0.relativePath == "data.csv" })
        monitor.stop()
        let count = deliveries.count
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        check("monitor-stopped-no-extra-delivery", deliveries.count == count)
        let passed = checks.allSatisfy { $0["passed"] as? Bool == true }
        let result: [String: Any] = ["passed": passed, "checks": checks, "observationBackend": monitor.observationBackend,
            "scope": "Real Swift policy parsing, temporary-directory enumeration, and live monitor update. Session/drop/save plans are helper contracts; App.swift wiring is verified separately. No user session, files or settings used."]
        print("FILE_PREFS_NATIVE_JSON:" + String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
        if !passed { exit(1) }
    }
}
