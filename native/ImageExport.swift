import AppKit
import WebKit
import UniformTypeIdentifiers

struct FullDocumentImageExportResult {
    let destination: URL
    /// PNG pixels. Equals CSS size when pixelScale is 1.
    let width: Int
    let height: Int
    let tileCount: Int
}

enum FullDocumentImageExportError: LocalizedError {
    case invalidOptions
    case timedOut
    case resourceFailed(String)
    case snapshotFailed(String)
    case documentTooLarge(width: Int, height: Int, limit: Int)
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .invalidOptions: return "Image export received an invalid destination, size, or timeout."
        case .timedOut: return "Image export timed out."
        case .resourceFailed(let reason): return "An image export resource did not load: \(reason)"
        case .snapshotFailed(let reason): return "WebKit could not capture the document: \(reason)"
        case .documentTooLarge(let width, let height, let limit):
            return "The document image is \(width) × \(height) pixels and exceeds the \(limit)-pixel export limit."
        case .encodingFailed: return "The document image could not be encoded as PNG."
        }
    }
}

/// Captures standalone export HTML, rather than the editor's virtual viewport.
/// Every snapshot covers at most tileHeight CSS pixels. The last tile uses the
/// actual scroll offset, so WebKit's bottom scroll clamp cannot omit the tail.
@MainActor
enum FullDocumentImageExporter {
    static func export(html: String, baseURL: URL?, destination: URL,
                       width: CGFloat = 960, timeout: TimeInterval = 30,
                       tileHeight: Int = 2048, maxPixelCount: Int = 100_000_000,
                       pixelScale: CGFloat = 1) async throws -> FullDocumentImageExportResult {
        try Task.checkCancellation()
        guard destination.isFileURL, width.isFinite, width >= 1, width <= 16_384,
              timeout.isFinite, timeout > 0, tileHeight > 0, tileHeight <= 4096,
              maxPixelCount > 0, pixelScale.isFinite, pixelScale > 0 else {
            throw FullDocumentImageExportError.invalidOptions
        }
        let cancellation = ImageExportCancellation()
        let job = ImageExportSession(html: html, baseURL: baseURL, destination: destination,
                                     width: Int(ceil(width)), timeout: timeout,
                                     tileHeight: tileHeight, maxPixelCount: maxPixelCount,
                                     pixelScale: pixelScale, cancellation: cancellation)
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in job.start(continuation) }
        }, onCancel: {
            // Record cancellation before hopping to the main actor. A large
            // PNG encode must not commit while that hop waits for the UI thread.
            cancellation.cancel()
            Task { @MainActor in job.cancel() }
        })
    }
}

private final class ImageExportCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
}

@MainActor
private final class ImageExportSession: NSObject, WKNavigationDelegate {
    let html: String
    let baseURL: URL?
    let destination: URL
    let width: Int
    let timeout: TimeInterval
    let tileHeight: Int
    let maxPixelCount: Int
    let pixelScale: CGFloat
    let cancellation: ImageExportCancellation
    private var continuation: CheckedContinuation<FullDocumentImageExportResult, Error>?
    private var web: WKWebView?
    private var window: NSWindow?
    private var timer: Timer?
    private var deadline = Date.distantFuture
    private var finished = false
    private var prepared = false
    private var height = 0
    private var nextY = 0
    private var tileCount = 0
    private var canvas: CGContext?
    private let positionedStateKey = "typoraImageExport_" + UUID().uuidString

    private var physicalWidth = 0
    private var physicalHeight = 0

    init(html: String, baseURL: URL?, destination: URL, width: Int, timeout: TimeInterval,
         tileHeight: Int, maxPixelCount: Int, pixelScale: CGFloat, cancellation: ImageExportCancellation) {
        self.html = html; self.baseURL = baseURL; self.destination = destination
        self.width = width; self.timeout = timeout; self.tileHeight = tileHeight
        self.maxPixelCount = maxPixelCount; self.pixelScale = pixelScale
        self.cancellation = cancellation
    }

    func start(_ continuation: CheckedContinuation<FullDocumentImageExportResult, Error>) {
        self.continuation = continuation
        deadline = Date().addingTimeInterval(timeout)
        guard checkActive() else { return }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        var loadBaseURL = baseURL
        if let baseURL, baseURL.isFileURL {
            // loadHTMLString cannot grant WebKit read access to local files.
            // Resolve only this document's local relative assets through a
            // public URL scheme handler; no source-directory writes are needed.
            configuration.setURLSchemeHandler(ImageExportLocalAssets(baseURL: baseURL), forURLScheme: "typora-image-export")
            loadBaseURL = URL(string: "typora-image-export://local/")
        }
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 1), configuration: configuration)
        web.navigationDelegate = self
        self.web = web
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        // Closing a programmatically owned NSWindow must not release it again.
        window.isReleasedWhenClosed = false
        window.identifier = NSUserInterfaceItemIdentifier("TyporaReplica.ImageExport")
        window.contentView = web
        self.window = window
        let timer = Timer(timeInterval: timeout, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish(.failure(FullDocumentImageExportError.timedOut)) }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        web.loadHTMLString(html, baseURL: loadBaseURL)
    }

    func cancel() { finish(.failure(CancellationError())) }

    private func checkActive() -> Bool {
        guard !finished else { return false }
        if cancellation.isCancelled { finish(.failure(CancellationError())); return false }
        if Date() >= deadline { finish(.failure(FullDocumentImageExportError.timedOut)); return false }
        return true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard checkActive(), !prepared else { return }
        prepared = true
        webView.callAsyncJavaScript("""
        for (const image of document.images) image.loading = 'eager';
        await document.fonts.ready;
        await Promise.all(Array.from(document.images).map(async image => {
          if (!image.complete) await new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, {once:true});
            image.addEventListener('error', () => reject(new Error(image.currentSrc || image.src || 'image')), {once:true});
          });
          if (!image.naturalWidth || !image.naturalHeight) throw new Error(image.currentSrc || image.src || 'image');
          if (image.decode) await image.decode();
        }));
        for (const element of [document.documentElement, document.body]) {
          element.style.setProperty('scroll-behavior', 'auto', 'important');
          element.style.setProperty('scroll-snap-type', 'none', 'important');
        }
        return true;
        """, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self, self.checkActive() else { return }
            switch result {
            case .failure(let error): self.finish(.failure(FullDocumentImageExportError.resourceFailed(error.localizedDescription)))
            case .success: self.measure(pass: 0)
            }
        }
    }

    private func measure(pass: Int) {
        guard checkActive(), let web else { return }
        web.callAsyncJavaScript("""
        await new Promise(resolve => setTimeout(resolve, 25));
        const body = document.body, root = document.documentElement;
        return Math.ceil(Math.max(1, root.scrollHeight, body.scrollHeight,
          body.getBoundingClientRect().bottom + window.scrollY + (parseFloat(getComputedStyle(body).marginBottom) || 0)));
        """, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self, self.checkActive(), let web = self.web else { return }
            guard case .success(let value) = result, let number = value as? NSNumber,
                  number.doubleValue.isFinite, number.doubleValue >= 1, number.doubleValue <= Double(Int32.max) else {
                self.finish(.failure(FullDocumentImageExportError.snapshotFailed("The document height is unavailable."))); return
            }
            let measured = number.intValue
            guard let physical = Self.physicalSize(cssWidth: self.width, cssHeight: measured, scale: self.pixelScale) else {
                self.finish(.failure(FullDocumentImageExportError.invalidOptions)); return
            }
            guard Double(physical.width) * Double(physical.height) <= Double(self.maxPixelCount) else {
                self.finish(.failure(FullDocumentImageExportError.documentTooLarge(width: physical.width, height: physical.height, limit: self.maxPixelCount))); return
            }
            let viewport = min(measured, self.tileHeight)
            if Int(web.frame.height) != viewport && pass < 4 {
                self.window?.setContentSize(NSSize(width: self.width, height: viewport))
                web.setFrameSize(NSSize(width: self.width, height: viewport))
                self.measure(pass: pass + 1); return
            }
            self.freezePositionedContent(documentHeight: measured)
        }
    }

    /// A static page has one header/footer and keeps sticky boxes in their
    /// initial flow positions. Measure viewport-fixed boxes against the full
    /// page once, then restore the tile viewport before freezing their geometry.
    /// Normal content retains its original viewport units and media queries.
    private func freezePositionedContent(documentHeight: Int) {
        guard checkActive(), let web else { return }
        let viewportHeight = Int(web.frame.height)
        guard documentHeight > viewportHeight else { allocateCanvas(height: documentHeight); return }
        web.callAsyncJavaScript("""
        window.scrollTo(0, 0);
        const state = {fixed: []};
        state.place = (element, target, position) => {
          const style = element.style;
          style.setProperty('transition', 'none', 'important');
          style.setProperty('animation-play-state', 'paused', 'important');
          style.setProperty('position', position, 'important');
          style.setProperty('inset', 'auto', 'important');
          style.setProperty('inset-block', 'auto', 'important');
          style.setProperty('inset-inline', 'auto', 'important');
          style.setProperty('right', 'auto', 'important');
          style.setProperty('bottom', 'auto', 'important');
          style.setProperty('isolation', 'isolate', 'important');
          let x = 0, y = 0;
          const set = () => { style.setProperty('left', x + 'px', 'important'); style.setProperty('top', y + 'px', 'important'); };
          set();
          // Relative offsets also work inside scaled/rotated ancestors. Measure
          // their local-to-page basis instead of assuming one CSS pixel is one
          // page pixel. This leaves each element's own transform intact.
          for (let i = 0; i < 8; i++) {
            const current = element.getBoundingClientRect();
            const dx = target.left - current.left, dy = target.top - current.top;
            if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return;
            style.setProperty('left', (x + 1) + 'px', 'important');
            const horizontal = element.getBoundingClientRect();
            set();
            style.setProperty('top', (y + 1) + 'px', 'important');
            const vertical = element.getBoundingClientRect();
            set();
            const a = horizontal.left - current.left, b = vertical.left - current.left;
            const c = horizontal.top - current.top, d = vertical.top - current.top;
            const determinant = a * d - b * c;
            if (Math.abs(determinant) < 0.000001) {
              if (!current.width || !current.height) return;
              throw new Error('A positioned element has a non-invertible layout.');
            }
            x += (dx * d - b * dy) / determinant;
            y += (a * dy - dx * c) / determinant;
            set();
          }
          throw new Error('A positioned element could not keep its initial location.');
        };
        const elements = Array.from(document.querySelectorAll('*'));
        for (const element of elements) {
          if (getComputedStyle(element).position === 'sticky') {
            state.place(element, element.getBoundingClientRect(), 'relative');
          }
        }
        state.fixed = elements.filter(element => getComputedStyle(element).position === 'fixed');
        globalThis[key] = state;
        return state.fixed.length;
        """, arguments: ["key": positionedStateKey], in: nil, in: .page) { [weak self] result in
            guard let self, self.checkActive(), let web = self.web else { return }
            guard case .success(let value) = result, let count = value as? NSNumber else {
                self.finish(.failure(FullDocumentImageExportError.snapshotFailed("Sticky content could not be frozen."))); return
            }
            if count.intValue == 0 {
                web.evaluateJavaScript("delete globalThis[\"\(self.positionedStateKey)\"]")
                self.allocateCanvas(height: documentHeight); return
            }
            self.window?.setContentSize(NSSize(width: self.width, height: documentHeight))
            web.setFrameSize(NSSize(width: self.width, height: documentHeight))
            web.callAsyncJavaScript("""
            await new Promise(resolve => setTimeout(resolve, 25));
            const state = globalThis[key];
            for (const element of state.fixed) {
              const css = getComputedStyle(element), rect = element.getBoundingClientRect();
              state.targets ||= new Map();
              state.targets.set(element, {rect, width: css.width, height: css.height,
                boxSizing: css.boxSizing, margins: [css.marginTop, css.marginRight, css.marginBottom, css.marginLeft]});
            }
            return true;
            """, arguments: ["key": self.positionedStateKey], in: nil, in: .page) { [weak self] result in
                guard let self, self.checkActive(), let web = self.web else { return }
                self.window?.setContentSize(NSSize(width: self.width, height: viewportHeight))
                web.setFrameSize(NSSize(width: self.width, height: viewportHeight))
                guard case .success = result else {
                    self.finish(.failure(FullDocumentImageExportError.snapshotFailed("Fixed content could not be measured."))); return
                }
                web.callAsyncJavaScript("""
                await new Promise(resolve => setTimeout(resolve, 25));
                const state = globalThis[key];
                // DOM order freezes an outer viewport-fixed box before testing
                // fixed descendants. A transformed containing block then moves
                // with the page and its children keep their original positioning.
                for (const element of state.fixed) {
                  window.scrollTo(0, 0);
                  const before = element.getBoundingClientRect();
                  window.scrollTo(0, 1);
                  const distance = window.scrollY, after = element.getBoundingClientRect();
                  window.scrollTo(0, 0);
                  if (distance < 0.5 || Math.abs(after.top - before.top) > 0.25 || Math.abs(after.left - before.left) > 0.25) continue;
                  const target = state.targets.get(element), style = element.style;
                  style.setProperty('box-sizing', target.boxSizing, 'important');
                  style.setProperty('width', target.width, 'important');
                  style.setProperty('height', target.height, 'important');
                  ['margin-top','margin-right','margin-bottom','margin-left'].forEach((name, i) => style.setProperty(name, target.margins[i], 'important'));
                  state.place(element, target.rect, 'absolute');
                }
                window.scrollTo(0, 0);
                delete globalThis[key];
                await document.fonts.ready;
                await Promise.all(Array.from(document.images).map(image => image.decode ? image.decode() : Promise.resolve()));
                return true;
                """, arguments: ["key": self.positionedStateKey], in: nil, in: .page) { [weak self] result in
                    guard let self, self.checkActive() else { return }
                    switch result {
                    case .success: self.allocateCanvas(height: documentHeight)
                    case .failure: self.finish(.failure(FullDocumentImageExportError.snapshotFailed("Fixed content could not be frozen.")))
                    }
                }
            }
        }
    }

    private static func physicalSize(cssWidth: Int, cssHeight: Int, scale: CGFloat) -> (width: Int, height: Int)? {
        guard scale.isFinite, scale > 0, cssWidth > 0, cssHeight > 0 else { return nil }
        let width = ceil(Double(cssWidth) * Double(scale))
        let height = ceil(Double(cssHeight) * Double(scale))
        guard width.isFinite, height.isFinite, width >= 1, height >= 1,
              width <= Double(Int.max), height <= Double(Int.max) else { return nil }
        let bytes = width * height * 4
        guard bytes.isFinite, bytes <= Double(Int.max) else { return nil }
        return (Int(width), Int(height))
    }

    private func scaledPixel(_ css: Int) -> Int {
        Int(ceil(CGFloat(css) * pixelScale))
    }

    private func allocateCanvas(height: Int) {
        guard checkActive() else { return }
        self.height = height
        guard let physical = Self.physicalSize(cssWidth: width, cssHeight: height, scale: pixelScale) else {
            finish(.failure(FullDocumentImageExportError.invalidOptions)); return
        }
        guard Double(physical.width) * Double(physical.height) <= Double(maxPixelCount) else {
            finish(.failure(FullDocumentImageExportError.documentTooLarge(width: physical.width, height: physical.height, limit: maxPixelCount))); return
        }
        physicalWidth = physical.width
        physicalHeight = physical.height
        guard physical.width <= Int.max / 4,
              let context = CGContext(data: nil, width: physical.width, height: physical.height,
                                      bitsPerComponent: 8, bytesPerRow: physical.width * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            finish(.failure(FullDocumentImageExportError.encodingFailed)); return
        }
        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: physical.width, height: physical.height))
        canvas = context
        captureTile()
    }

    private func captureTile() {
        guard checkActive(), let web else { return }
        if nextY >= height { commit(); return }
        let top = nextY
        let rows = min(tileHeight, height - top)
        web.callAsyncJavaScript("""
        window.scrollTo(0, top);
        await new Promise(resolve => setTimeout(resolve, 30));
        return window.scrollY;
        """, arguments: ["top": top], in: nil, in: .page) { [weak self] result in
            guard let self, self.checkActive(), let web = self.web else { return }
            guard case .success(let value) = result, let scroll = value as? NSNumber else {
                self.finish(.failure(FullDocumentImageExportError.snapshotFailed("WebKit could not scroll to the next image tile."))); return
            }
            let offset = CGFloat(top) - CGFloat(scroll.doubleValue)
            guard offset >= -0.5, offset + CGFloat(rows) <= web.bounds.height + 0.5 else {
                self.finish(.failure(FullDocumentImageExportError.snapshotFailed("The document changed size while it was captured."))); return
            }
            let config = WKSnapshotConfiguration()
            config.rect = CGRect(x: 0, y: max(0, offset), width: CGFloat(self.width), height: CGFloat(rows))
            config.snapshotWidth = NSNumber(value: self.physicalWidth)
            config.afterScreenUpdates = true
            web.takeSnapshot(with: config) { [weak self] image, error in
                guard let self, self.checkActive() else { return }
                guard let image, let pixels = image.cgImage(forProposedRect: nil, context: nil, hints: nil), error == nil else {
                    self.finish(.failure(FullDocumentImageExportError.snapshotFailed(error?.localizedDescription ?? "WebKit returned no image."))); return
                }
                let pixelTop = self.scaledPixel(top)
                let pixelBottom = self.scaledPixel(top + rows)
                let pixelRows = max(1, pixelBottom - pixelTop)
                self.canvas?.draw(pixels, in: CGRect(x: 0, y: self.physicalHeight - pixelBottom, width: self.physicalWidth, height: pixelRows))
                self.nextY += rows; self.tileCount += 1
                self.captureTile()
            }
        }
    }

    private func commit() {
        guard checkActive(), let image = canvas?.makeImage(),
              let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            if !finished { finish(.failure(FullDocumentImageExportError.encodingFailed)) }; return
        }
        // The output is untouched during resource loading, capture, cancellation
        // and encoding. Foundation writes a sibling temporary file then renames.
        guard checkActive() else { return }
        do {
            try data.write(to: destination, options: .atomic)
            finish(.success(FullDocumentImageExportResult(destination: destination, width: physicalWidth, height: physicalHeight, tileCount: tileCount)))
        } catch { finish(.failure(error)) }
    }

    private func finish(_ result: Result<FullDocumentImageExportResult, Error>) {
        guard !finished else { return }
        finished = true
        timer?.invalidate(); timer = nil
        web?.stopLoading(); web?.navigationDelegate = nil
        let ownedWindow = window
        ownedWindow?.orderOut(nil)
        ownedWindow?.contentView = nil
        ownedWindow?.close()
        window = nil; web = nil; canvas = nil
        let continuation = self.continuation
        self.continuation = nil
        continuation?.resume(with: result)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(.failure(FullDocumentImageExportError.snapshotFailed("The WebKit content process terminated.")))
    }
}

private final class ImageExportLocalAssets: NSObject, WKURLSchemeHandler {
    let baseURL: URL
    init(baseURL: URL) { self.baseURL = baseURL.standardizedFileURL.resolvingSymlinksInPath() }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.host == "local" else {
            urlSchemeTask.didFailWithError(URLError(.badURL)); return
        }
        let relative = String(url.path.drop(while: { $0 == "/" }))
        let file = baseURL.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(baseURL.path.hasSuffix("/") ? baseURL.path : baseURL.path + "/") else {
            urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile)); return
        }
        do {
            let data = try Data(contentsOf: file, options: .mappedIfSafe)
            let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                           headerFields: ["Content-Type": mime, "Access-Control-Allow-Origin": "*"])!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { }
}
