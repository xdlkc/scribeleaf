import Foundation
import AppKit
import Darwin

final class ImageTestURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: request.url!.path == "/fail" ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"image/png"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data([1,2,3,4]))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct ImagePreferencesChecks {
    static func main() throws {
        if let suite = ProcessInfo.processInfo.environment["TYPORA_REPLICA_DEFAULTS_SUITE"] {
            AppPreferencesStore.defaults.removePersistentDomain(forName:suite)
        }
        defer { if let suite = ProcessInfo.processInfo.environment["TYPORA_REPLICA_DEFAULTS_SUITE"] { AppPreferencesStore.defaults.removePersistentDomain(forName:suite) } }
        var results: [[String: Any]] = []
        func check(_ name: String, _ condition: @autoclosure () throws -> Bool) {
            let passed: Bool
            do { passed = try condition() } catch { print("ERROR \(name): \(error)"); passed = false }; results.append(["name":name,"passed":passed])
            print("\(passed ? "PASS" : "FAIL") \(name)")
        }
        func throwsCheck(_ name: String, _ block: () throws -> Void) {
            do { try block(); check(name, false) } catch { check(name, true) }
        }
        let manager = FileManager.default
        let directory = manager.temporaryDirectory.appendingPathComponent("typora-image-preferences-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? manager.removeItem(at: directory) }
        let sourceFolder = directory.appendingPathComponent("文档 #100%", isDirectory:true)
        try manager.createDirectory(at: sourceFolder, withIntermediateDirectories:true)
        let document = sourceFolder.appendingPathComponent("note.v1.md")
        let original = Data("# untouched 原稿\n".utf8); try original.write(to: document)
        let source = directory.appendingPathComponent("图片 #100% `$(touch HACKED)`.png")
        let image = Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=")!
        try image.write(to: source)
        var values: [String: Any] = ["imageInsertAction":"assert", "imageCopyLocal":true,"imageCopyOnline":true,"useRelativeImagePaths":true,"relativeImageDotPrefix":true,"allowImageUpload":true]
        func plan(_ kind: ImageInputKind = .local, policy: [String:Any] = [:], doc: URL? = document) -> ImageInsertionPlan { ImageInsertionRules.plan(settings:ImageInsertionSettings(values),kind:kind,document:doc,policy:policy) }
        func target(_ result: ImageInsertionPlan) -> URL? { if case .directory(let url) = result { return url }; return nil }
        check("global-assets", target(plan()) == sourceFolder.appendingPathComponent("assets",isDirectory:true))
        values["imageInsertAction"] = "folder"; check("global-current-folder", target(plan()) == sourceFolder)
        values["imageInsertAction"] = "per-file-assert"; check("per-file-strips-last-extension", target(plan())?.lastPathComponent == "note.v1.assets")
        values["imageInsertAction"] = "custom"; values["customImageFolder"] = "../${filename}/${filename}"
        check("custom-all-filename-tokens", target(plan())?.path == directory.appendingPathComponent("note.v1/note.v1").path)
        check("yaml-copy-overrides-global", target(plan(policy:["copyImagesTo":"./other"]))?.lastPathComponent == "other")
        values["imageCopyLocal"] = false
        if case .reference = plan(policy:["copyImagesTo":"./other"]) { check("yaml-local-gate",true) } else { check("yaml-local-gate",false) }
        check("raw-data-gets-global-rule", target(plan(.raw)) != nil)
        values["imageCopyLocal"] = true; values["imageCopyOnline"] = false
        if case .reference = plan(.online,policy:["copyImagesTo":"./other"]) { check("yaml-online-gate",true) } else { check("yaml-online-gate",false) }
        values["imageCopyOnline"] = true
        values["imageUploader"] = "custom"; values["allowImageUpload"] = false; values["imageInsertAction"] = "assert"
        if case .reference = plan(policy:["copyImagesTo":"upload"]) { check("yaml-upload-denied-retains-reference",true) } else { check("yaml-upload-denied-retains-reference",false) }
        values["imageInsertAction"] = "ipic"
        if case .upload(let uploader) = plan() { check("global-upload-ignores-yaml-permission",uploader == "custom") } else { check("global-upload-ignores-yaml-permission",false) }
        if case .upload(let uploader) = plan(policy:["copyImagesTo":"IPIC"]) { check("yaml-ipic-forces-provider",uploader == "ipic") } else { check("yaml-ipic-forces-provider",false) }
        if case .prompt = plan(policy:["copyImagesTo":"./${unknown}"]) { check("unknown-folder-token-prompts",true) } else { check("unknown-folder-token-prompts",false) }
        if case .prompt = plan(policy:["copyImagesTo":"./${filename}"],doc:nil) { check("untitled-filename-token-prompts",true) } else { check("untitled-filename-token-prompts",false) }
        if case .prompt = ImageInsertionRules.directory("/",document:document,strict:true) { check("root-folder-rejected",true) } else { check("root-folder-rejected",false) }
        var settings = ImageInsertionSettings(values)
        let nested = sourceFolder.appendingPathComponent("assets/图片 #100%.png")
        check("relative-dot-syntax", settings.displayPath(nested,document:document) == "./assets/图片 #100%.png")
        check("outside-document-keeps-absolute",settings.displayPath(source,document:document) == source.path)
        settings.relative = false; check("absolute-preference",settings.displayPath(nested,document:document) == nested.path)

        let copyFolder = sourceFolder.appendingPathComponent("copied",isDirectory:true)
        let token = ConversionCancellation()
        let stored = try ImageFileTransaction.store([("图片 #100%.png",image),("图片 #100%.png",image)],into:copyFolder,cancellation:token)
        check("atomic-collision-unique",stored.count == 2 && stored[0] != stored[1] && stored[1].lastPathComponent == "图片 #100%-1.png")
        check("copy-byte-exact",try Data(contentsOf:stored[0]) == image && Data(contentsOf:stored[1]) == image)
        check("no-staging-files",try manager.contentsOfDirectory(atPath:copyFolder.path).count == 2)
        throwsCheck("batch-rollback-on-write-failure") {
            _ = try ImageFileTransaction.store([("ok.png",image),("/",image)],into:copyFolder,cancellation:ConversionCancellation())
        }
        check("failed-batch-preserves-existing",try manager.contentsOfDirectory(atPath:copyFolder.path).count == 2)
        let stopped = ConversionCancellation(); stopped.cancel()
        throwsCheck("cancel-before-file-write") { _ = try ImageFileTransaction.store([("cancel.png",image)],into:copyFolder,cancellation:stopped) }
        check("cancel-created-no-file",!manager.fileExists(atPath:copyFolder.appendingPathComponent("cancel.png").path))

        let uploadScript = directory.appendingPathComponent("fake upload.sh")
        let argumentsFile = directory.appendingPathComponent("argv.txt")
        // The script sees document macros followed by literal image argv.
        let script = "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$TYPORA_IMAGE_TEST_ARGS\"\nshift 2\nfor image in \"$@\"; do printf 'https://images.example.test/image.png\\n'; done\n"
        try Data(script.utf8).write(to:uploadScript); try manager.setAttributes([.posixPermissions:0o700],ofItemAtPath:uploadScript.path)
        setenv("TYPORA_IMAGE_TEST_ARGS",argumentsFile.path,1)
        defer { unsetenv("TYPORA_IMAGE_TEST_ARGS") }
        values["customImageUploadCommand"] = "'" + uploadScript.path.replacingOccurrences(of:"'",with:"'\\''") + "' '${filepath}' \"${filename}\""
        settings = ImageInsertionSettings(values)
        let uploaded = try ImageUploaderRunner.upload([source],settings:settings,uploader:"custom",document:document,cancellation:ConversionCancellation())
        check("custom-real-process-url",uploaded == ["https://images.example.test/image.png"])
        let args = try String(contentsOf:argumentsFile,encoding:.utf8).components(separatedBy:.newlines)
        check("document-macros-and-image-argv-literal",Array(args.prefix(3)) == [document.path,"note.v1",source.path])
        check("path-shell-injection-not-executed",!manager.fileExists(atPath:sourceFolder.appendingPathComponent("HACKED").path))
        check("stdout-last-contiguous-group",try ImageUploaderRunner.parseOutput("log\nhttps://ignore.test/old\nseparator\nhttps://one.test/a\nexample.com/b\nDone\n",count:2) == ["https://one.test/a","http://example.com/b"])
        check("single-image-last-url",try ImageUploaderRunner.parseOutput("https://one.test/a\nhttps://two.test/b\n",count:1) == ["https://two.test/b"])
        throwsCheck("wrong-output-count-fails") { _ = try ImageUploaderRunner.parseOutput("https://one.test/a\n",count:2) }
        throwsCheck("missing-uploader-real-error") { _ = try ImageUploaderRunner.upload([source],settings:settings,uploader:"",document:document,cancellation:ConversionCancellation()) }
        settings.command = "/bin/sh -c 'echo failed >&2; exit 9'"
        throwsCheck("nonzero-command-fails") { _ = try ImageUploaderRunner.upload([source],settings:settings,uploader:"custom",document:document,cancellation:ConversionCancellation()) }
        settings.command = "/bin/sleep 20 #"
        let start = ProcessInfo.processInfo.systemUptime
        throwsCheck("command-timeout") { _ = try ImageUploaderRunner.upload([source],settings:settings,uploader:"custom",document:document,timeout:0.12,cancellation:ConversionCancellation()) }
        check("timeout-bounded",ProcessInfo.processInfo.systemUptime - start < 3)
        let cancel = ConversionCancellation()
        DispatchQueue.global().asyncAfter(deadline:.now()+0.12) { cancel.cancel() }
        let cancelStart = ProcessInfo.processInfo.systemUptime
        throwsCheck("command-active-cancel") { _ = try ImageUploaderRunner.upload([source],settings:settings,uploader:"custom",document:document,cancellation:cancel) }
        check("cancel-bounded",ProcessInfo.processInfo.systemUptime - cancelStart < 3)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ImageTestURLProtocol.self]
        check("online-request-actual-urlsession-local-protocol",try ImageNetwork.request(URLRequest(url:URL(string:"https://unit.invalid/image.png")!),cancellation:ConversionCancellation(),configuration:config) == Data([1,2,3,4]))
        throwsCheck("online-http-error") { _ = try ImageNetwork.request(URLRequest(url:URL(string:"https://unit.invalid/fail")!),cancellation:ConversionCancellation(),configuration:config) }
        throwsCheck("online-cancel-before-request") { _ = try ImageNetwork.request(URLRequest(url:URL(string:"https://unit.invalid/image.png")!),cancellation:stopped,configuration:config) }

        var uploaderTestResult: [String: Any]?
        var testValues = values; testValues["imageUploader"] = "custom"
        ImageUploaderTester.start(requestId:"two-generated-images",values:testValues) { uploaderTestResult = $0 }
        let testEnd = Date().addingTimeInterval(4)
        while uploaderTestResult == nil && Date() < testEnd { RunLoop.current.run(until:Date().addingTimeInterval(0.01)) }
        check("explicit-uploader-test-real-two-urls",(uploaderTestResult?["paths"] as? [String])?.count == 2 && uploaderTestResult?["error"] == nil)
        let testArgs = try String(contentsOf:argumentsFile,encoding:.utf8).components(separatedBy:.newlines).filter{ !$0.isEmpty }
        if let testFile = testArgs.first { check("explicit-uploader-test-temp-cleaned",!manager.fileExists(atPath:URL(fileURLWithPath:testFile).deletingLastPathComponent().path)) }
        var cancelledTestReturned = false
        ImageUploaderTester.start(requestId:"cancel-uploader-test",values:["imageUploader":"custom","customImageUploadCommand":"/bin/sleep 20 #"]) { _ in cancelledTestReturned = true }
        RunLoop.current.run(until:Date().addingTimeInterval(0.08)); ImageUploaderTester.cancel(requestId:"cancel-uploader-test")
        RunLoop.current.run(until:Date().addingTimeInterval(0.4))
        check("explicit-uploader-test-cancel-no-ui-result",!cancelledTestReturned)

        // Real production queue with file/data requests. No NSPasteboard access.
        let doc = MarkdownDocument(); doc.fileURL = document; doc.markdown = String(decoding:original,as:UTF8.self)
        func waitFor(_ count: Int, timeout: TimeInterval = 3) {
            let end = Date().addingTimeInterval(timeout)
            while doc.messages.count < count && Date() < end { RunLoop.current.run(until:Date().addingTimeInterval(0.01)) }
        }
        AppPreferencesStore.saveEditorPrefs(["imageInsertAction":"assert","imageCopyLocal":true,"useRelativeImagePaths":true,"relativeImageDotPrefix":true])
        doc.handleClipboardImage(["requestId":"native-copy","path":source.path,"imagePolicy":["copyImagesTo":"./${filename}.assets"]])
        waitFor(1)
        let first = doc.messages.last ?? [:]
        check("native-queued-copy-actual-file",(first["path"] as? String)?.hasPrefix("./note.v1.assets/") == true && manager.fileExists(atPath:sourceFolder.appendingPathComponent("note.v1.assets/" + source.lastPathComponent).path))
        doc.handleClipboardImage(["requestId":"native-same","path":sourceFolder.appendingPathComponent("note.v1.assets/" + source.lastPathComponent).path,"imagePolicy":["copyImagesTo":"./${filename}.assets"]])
        waitFor(2)
        check("native-target-same-folder-no-extra-copy",try manager.contentsOfDirectory(atPath:sourceFolder.appendingPathComponent("note.v1.assets").path).count == 1)
        AppPreferencesStore.saveEditorPrefs(["imageInsertAction":"assert","imageCopyLocal":false,"useRelativeImagePaths":true])
        doc.handleClipboardImage(["requestId":"native-gated","path":source.path,"imagePolicy":["copyImagesTo":"./blocked"]]); waitFor(3)
        check("native-local-gate-no-copy",!manager.fileExists(atPath:sourceFolder.appendingPathComponent("blocked").path) && doc.messages.last?["path"] as? String == source.path)
        doc.handleClipboardImage(["requestId":"native-raw","data":image.base64EncodedString(),"name":"raw.png","imagePolicy":[:]]); waitFor(4)
        check("native-raw-global-rule-consumer",manager.fileExists(atPath:sourceFolder.appendingPathComponent("assets/raw.png").path))
        doc.handleClipboardImage(["requestId":"native-online","remoteURL":"https://unchanged.example.test/图 a.png?q=1#x","imagePolicy":[:]]); waitFor(5)
        check("native-online-disabled-no-network",doc.messages.last?["path"] as? String == "https://unchanged.example.test/图 a.png?q=1#x")
        AppPreferencesStore.saveEditorPrefs(["imageInsertAction":"ipic","imageCopyLocal":true,"imageUploader":"custom","customImageUploadCommand":"/bin/sleep 20 #"])
        doc.handleClipboardImage(["requestId":"native-cancel","path":source.path,"imagePolicy":[:]])
        RunLoop.current.run(until:Date().addingTimeInterval(0.08)); doc.handleClipboardCancel(["requestIds":["native-cancel"]])
        AppPreferencesStore.saveEditorPrefs(["imageCopyLocal":false])
        doc.handleClipboardImage(["requestId":"native-after-cancel","path":source.path,"imagePolicy":[:]]); waitFor(6)
        check("native-cancel-suppresses-old-result-and-drains-queue",doc.messages.count == 6 && doc.messages.last?["requestId"] as? String == "native-after-cancel")
        check("original-markdown-file-byte-exact",try Data(contentsOf:document) == original)
        check("original-image-file-byte-exact",try Data(contentsOf:source) == image)
        let output = CommandLine.arguments[1]
        let report: [String: Any] = ["generatedAt":ISO8601DateFormatter().string(from:Date()),"passed":results.allSatisfy{$0["passed"] as? Bool == true},"checks":results,"scope":"Real Foundation file/process/network-protocol tests and production Clipboard queue. URLSession is intercepted locally; no system clipboard or cloud uploads.","limitations":["Third-party app live installation/account/protocol roundtrips not executed.","iPic keyed archive IPC not implemented; selecting it returns an unavailable error.","Raw screenshot native Typora gate not proven; replica preserves existing raw-image save/copy behavior.","Project image settings/root-url not implemented."]]
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:output))
        if results.contains(where:{$0["passed"] as? Bool != true}) { exit(1) }
    }
}
