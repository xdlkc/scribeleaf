import Foundation
import AppKit
import Darwin

@main struct FileImportChecks {
    static func main() async throws {
        let arguments = CommandLine.arguments
        let executable = URL(fileURLWithPath:arguments[1])
        let reportURL = URL(fileURLWithPath:arguments[2])
        let work = URL(fileURLWithPath:arguments[3],isDirectory:true)
        let manager = FileManager.default
        let cache = work.appendingPathComponent("managed media #100% 中文",isDirectory:true)
        let sources = work.appendingPathComponent("source documents #100% 中文",isDirectory:true)
        try manager.createDirectory(at:sources,withIntermediateDirectories:true)
        let sourceImage = sources.appendingPathComponent("图片 #100%.png")
        let imageBytes = Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=")!
        try imageBytes.write(to:sourceImage)
        let markdown = "# IMPORTPROBEHEADING 中文\n\nORIGINALPROBEMARKER text **bold** [local](other.md).\n\n![KEEPIMAGE](<图片%20%23100%25.png>)\n"
        let input = sources.appendingPathComponent("original.md"); try Data(markdown.utf8).write(to:input)
        var results:[[String:Any]]=[]
        func check(_ name:String,_ condition:Bool,_ detail:Any?=nil) {
            var item:[String:Any] = ["name":name,"passed":condition]; if let detail { item["detail"] = detail }; results.append(item)
            print("\(condition ? "PASS" : "FAIL") \(name)")
        }
        func process(_ args:[String],cwd:URL?=nil) throws -> String {
            try ProcessGroupLauncher.run(executable:executable.path,arguments:args,environment:ProcessInfo.processInfo.environment,cwd:cwd?.path,timeout:20,cancellation:ConversionCancellation()).stdout
        }
        func files(_ directory:URL)->[String] { ((try? manager.contentsOfDirectory(atPath:directory.path)) ?? []).sorted() }
        func mediaPaths(_ text:String)->[URL] {
            let pattern = #"file://[^<>\r\n\"\s\)]*?/image-[0-9]+\.[a-z0-9]+"#
            let regex = try! NSRegularExpression(pattern:pattern)
            return regex.matches(in:text,range:NSRange(text.startIndex...,in:text)).compactMap { match in
                guard let range=Range(match.range,in:text) else { return nil }
                return URL(string:String(text[range]))
            }
        }
        let supported = ["docx","odt","epub","rtf","html","htm","xhtml","rst","rest","textile","tex","latex","opml","org","wiki","mediawiki","adoc","asciidoc","fb2","fodt","ipynb","typ","typst"]
        check("supports-known-pinned-readers",supported.allSatisfy{FileImporter.supports(URL(fileURLWithPath:"/tmp/test."+$0))})
        check("supports-is-case-insensitive",FileImporter.supports(URL(fileURLWithPath:"/tmp/UPPER.DOCX")))
        check("unsupported-binary-doc-and-pdf-not-guessed",!["doc","pdf","exe","md","txt"].contains{FileImporter.supports(URL(fileURLWithPath:"/tmp/test."+$0))})
        check("non-file-url-not-supported",!FileImporter.supports(URL(string:"https://example.test/file.docx")!))
        var sourceHashes:[String:String]=[:], outputs:[String:String]=[:]
        for (ext,writer) in [("docx","docx"),("odt","odt"),("epub","epub"),("rtf","rtf"),("html","html"),("rst","rst"),("textile","textile"),("tex","latex"),("opml","opml"),("org","org"),("adoc","asciidoc"),("fb2","fb2"),("fodt","opendocument"),("ipynb","ipynb"),("typ","typst")] {
            let source = sources.appendingPathComponent("generated \(ext) #100% 中文.\(ext)")
            do {
                if ext == "fodt" {
                    let xml = "<office:document xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" office:mimetype=\"application/vnd.oasis.opendocument.text\" office:version=\"1.2\"><office:styles></office:styles><office:automatic-styles></office:automatic-styles><office:body><office:text><text:h text:outline-level=\"1\">IMPORTPROBEHEADING 中文</text:h><text:p>ORIGINALPROBEMARKER</text:p></office:text></office:body></office:document>"
                    try Data(xml.utf8).write(to:source)
                } else {
                    _ = try process(["--from","markdown","--to",writer,"--standalone","--output",source.path,"--",input.path],cwd:sources)
                }
                let before=try Data(contentsOf:source)
                let converted=try await FileImporter.importMarkdown(source:source,pandocURL:executable,timeout:20,mediaCacheURL:cache)
                outputs[ext]=converted
                check("real-\(ext)-text-import",converted.contains("IMPORTPROBEHEADING"),String(converted.prefix(120)))
                check("real-\(ext)-source-byte-preserved",try Data(contentsOf:source)==before)
                sourceHashes[ext]=before.base64EncodedString().prefix(24).description
                let paths=mediaPaths(converted)
                if ["docx","odt","epub","rtf","fb2","ipynb"].contains(ext) {
                    check("real-\(ext)-embedded-image-persistent-path",paths.count==1,converted)
                    check("real-\(ext)-embedded-image-byte-preserved",paths.first.flatMap{try? Data(contentsOf:$0)}==imageBytes)
                    check("real-\(ext)-media-uri-utf8-hash-percent-safe",paths.first?.fragment == nil && paths.first?.query == nil && paths.first?.path.contains("managed media #100% 中文") == true)
                    check("real-\(ext)-no-temporary-media-reference",!converted.contains(".staging-") && converted.range(of:#"/typora-file-import-[0-9a-f]{8}-"#,options:.regularExpression)==nil)
                }
            } catch { check("real-\(ext)-import-threw",false,error.localizedDescription) }
        }
        check("unpacked-media-still-readable-after-another-import",["docx","odt","epub","rtf","fb2","ipynb"].allSatisfy{ext in guard let output=outputs[ext],let path=mediaPaths(output).first else{return false};return (try? Data(contentsOf:path))==imageBytes})
        // Same attachment name in distinct notebook cells must not resolve to
        // the other cell's image. Raw HTML quotes and code examples coexist.
        let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:1,pixelsHigh:1,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:4,bitsPerPixel:32)!
        bitmap.bitmapData![0]=255;bitmap.bitmapData![1]=0;bitmap.bitmapData![2]=0;bitmap.bitmapData![3]=255
        let secondImage=bitmap.representation(using:.png,properties:[:])!
        let notebook=sources.appendingPathComponent("cell attachments.ipynb")
        let notebookObject:[String:Any] = ["nbformat":4,"nbformat_minor":5,"metadata":[:],"cells":[
            ["cell_type":"markdown","metadata":[:],"source":["<img src='attachment:same%20name.png'>\n", "\n```html\n<img src='attachment:same%20name.png'>\n```\n"],"attachments":["same%20name.png":["image/png":imageBytes.base64EncodedString()]]],
            ["cell_type":"markdown","metadata":[:],"source":["<img src=\"attachment:same%20name.png\">\n"],"attachments":["same%20name.png":["image/png":secondImage.base64EncodedString()]]]
        ]]
        let notebookBytes=try JSONSerialization.data(withJSONObject:notebookObject);try notebookBytes.write(to:notebook)
        do {
            let imported=try await FileImporter.importMarkdown(source:notebook,pandocURL:executable,mediaCacheURL:cache)
            let paths=mediaPaths(imported)
            check("notebook-cell-scoped-same-name-attachments",paths.count==2 && paths[0] != paths[1] && (try? Data(contentsOf:paths[0]))==imageBytes && (try? Data(contentsOf:paths[1]))==secondImage,imported)
            check("notebook-raw-html-code-example-untouched",imported.contains("attachment:same%20name.png"))
            check("notebook-source-byte-preserved",try Data(contentsOf:notebook)==notebookBytes)
        }catch{check("notebook-cell-scope-threw",false,error.localizedDescription)}
        let noMedia=sources.appendingPathComponent("no-media.html");try Data("<h1>NO_MEDIA</h1><p>text</p>".utf8).write(to:noMedia)
        let cacheBefore=files(cache)
        do { let text=try await FileImporter.importMarkdown(source:noMedia,pandocURL:executable,mediaCacheURL:cache);check("no-media-document-import",text.contains("NO_MEDIA"));check("no-media-no-persistent-request-folder",files(cache)==cacheBefore) } catch { check("no-media-import-threw",false,error.localizedDescription) }
        let remote=sources.appendingPathComponent("remote-references.html")
        let remoteText="<h1>NO_NETWORK</h1><p><img src=\"http://127.0.0.1:1/must-not-fetch.png\"></p><iframe src=\"http://127.0.0.1:1/must-not-fetch.html\"></iframe>"
        try Data(remoteText.utf8).write(to:remote)
        do { let start=ProcessInfo.processInfo.systemUptime;let text=try await FileImporter.importMarkdown(source:remote,pandocURL:executable,timeout:3,mediaCacheURL:cache);check("remote-image-url-retained-without-fetch",text.contains("http://127.0.0.1:1/must-not-fetch.png") && ProcessInfo.processInfo.systemUptime-start<3);check("remote-iframe-preserved-as-raw-html",text.contains("<iframe")); }catch{check("remote-import-no-fetch-threw",false,error.localizedDescription)}
        let invalid=sources.appendingPathComponent("invalid.docx");try Data("not a zip archive".utf8).write(to:invalid)
        let beforeFailure=files(cache)
        do { _=try await FileImporter.importMarkdown(source:invalid,pandocURL:executable,mediaCacheURL:cache);check("real-reader-failure",false) }catch {check("real-reader-failure",true)}
        check("real-reader-failure-cleans-cache",files(cache)==beforeFailure)
        check("real-reader-failure-source-byte-preserved",try Data(contentsOf:invalid)==Data("not a zip archive".utf8))
        let fake = work.appendingPathComponent("fake converter.sh")
        let fakeScript = """
        #!/bin/sh
        printf 'partial' > "$TYPORA_IMPORT_STAGE/partial.png"
        printf '%s\\n' "$$" > "$TYPORA_FILE_IMPORT_TEST_PID"
        (sleep 0.8; printf leaked > "$TYPORA_FILE_IMPORT_TEST_LATE") &
        child=$!
        printf '%s\\n' "$child" >> "$TYPORA_FILE_IMPORT_TEST_PID"
        wait "$child"
        """
        try Data(fakeScript.utf8).write(to:fake);try manager.setAttributes([.posixPermissions:0o700],ofItemAtPath:fake.path)
        let pidFile=work.appendingPathComponent("pids.txt");setenv("TYPORA_FILE_IMPORT_TEST_PID",pidFile.path,1);defer{unsetenv("TYPORA_FILE_IMPORT_TEST_PID")}
        let lateFile=work.appendingPathComponent("must-not-be-created.txt");setenv("TYPORA_FILE_IMPORT_TEST_LATE",lateFile.path,1);defer{unsetenv("TYPORA_FILE_IMPORT_TEST_LATE")}
        let beforeTimeout=files(cache), timeoutStart=ProcessInfo.processInfo.systemUptime
        do { _=try await FileImporter.importMarkdown(source:noMedia,pandocURL:fake,timeout:0.15,mediaCacheURL:cache);check("timeout-throws",false) }catch { check("timeout-throws",error is DocumentConversionError) }
        check("timeout-bounded",ProcessInfo.processInfo.systemUptime-timeoutStart<3)
        check("timeout-removes-partial-media",files(cache)==beforeTimeout)
        if let text=try? String(contentsOf:pidFile,encoding:.utf8) {let pids=text.split(whereSeparator:{$0.isWhitespace}).compactMap{Int32($0)};check("timeout-process-group-no-live-parent",pids.first.map{kill($0,0) != 0} ?? false)}
        try await Task.sleep(nanoseconds:1_100_000_000)
        check("timeout-kills-descendant-before-side-effect",!manager.fileExists(atPath:lateFile.path))
        let beforeCancel=files(cache)
        let task=Task{try await FileImporter.importMarkdown(source:noMedia,pandocURL:fake,timeout:30,mediaCacheURL:cache)}
        try await Task.sleep(nanoseconds:150_000_000);task.cancel()
        do {_=try await task.value;check("active-cancel-throws",false)}catch {check("active-cancel-throws",error is DocumentConversionError)}
        check("active-cancel-removes-partial-media",files(cache)==beforeCancel)
        try await Task.sleep(nanoseconds:1_100_000_000)
        check("active-cancel-kills-descendant-before-side-effect",!manager.fileExists(atPath:lateFile.path))
        let instant=Task{try await FileImporter.importMarkdown(source:noMedia,pandocURL:fake,timeout:30,mediaCacheURL:cache)};instant.cancel()
        do {_=try await instant.value;check("pre-cancel-throws",false)}catch{check("pre-cancel-throws",true)}
        check("all-failures-source-markdown-byte-preserved",try Data(contentsOf:input)==Data(markdown.utf8))
        check("all-failures-source-image-byte-preserved",try Data(contentsOf:sourceImage)==imageBytes)
        check("no-staging-directory-leaks",!files(cache).contains{$0.hasPrefix(".staging-")})
        let failureScript = "#!/bin/sh\nprintf partial > \"$TYPORA_IMPORT_STAGE/partial.png\"\n/usr/bin/awk 'BEGIN{for(i=0;i<600000;i++)printf \"ERR\"}' >&2\nexit 7\n"
        try Data(failureScript.utf8).write(to:fake)
        let failureCache=files(cache)
        do { _=try await FileImporter.importMarkdown(source:noMedia,pandocURL:fake,timeout:5,mediaCacheURL:cache);check("nonzero-stderr-bounded",false) }
        catch DocumentConversionError.processFailed(let status,let diagnostic) {check("nonzero-stderr-bounded",status==7 && diagnostic.utf8.count<=16384 && diagnostic.contains("truncated"),diagnostic.utf8.count)}
        catch {check("nonzero-stderr-bounded",false,error.localizedDescription)}
        check("nonzero-failure-cleans-partial-media",files(cache)==failureCache)
        let cacheFile=work.appendingPathComponent("not-a-directory");try Data("existing".utf8).write(to:cacheFile)
        do{_=try await FileImporter.importMarkdown(source:noMedia,pandocURL:executable,mediaCacheURL:cacheFile);check("invalid-cache-throws",false)}catch{check("invalid-cache-throws",true)}
        check("invalid-cache-file-preserved",try Data(contentsOf:cacheFile)==Data("existing".utf8))
        do{_=try await FileImporter.importMarkdown(source:input,pandocURL:executable,mediaCacheURL:cache);check("unsupported-input-throws",false)}catch{check("unsupported-input-throws",error is FileImportError)}
        let sourceNames=try manager.contentsOfDirectory(atPath:sources.path).sorted()
        check("source-folder-no-extracted-media-side-effects",!sourceNames.contains{$0=="media" || $0.hasPrefix(".staging-") || $0.hasPrefix("typora-file-import-")})
        let report:[String:Any] = ["generatedAt":ISO8601DateFormatter().string(from:Date()),"passed":results.allSatisfy{$0["passed"] as? Bool == true},"checks":results,"scope":"Actual pinned Pandoc imports from self-generated documents and embedded PNG. Real process timeout/cancellation. All media is test-override managed storage; source bytes remain unchanged.","outputSamples":outputs.mapValues{String($0.prefix(1200))},"sourceWitnesses":sourceHashes,"limitations":["Original Typora import directory/media placement is not proven. Managed ImportedMedia absolute references are not a portable Markdown folder.","GUI new-document routing and resourceOriginURL belong to coordinator integration.","Third-party custom Pandoc versions may differ from bundled 3.12.1."]]
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:reportURL)
        if results.contains(where:{$0["passed"] as? Bool != true}) {exit(1)}
    }
}
