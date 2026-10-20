import Foundation
import CoreServices
import Darwin

struct FolderEntry: Equatable {
    let name: String
    let path: String
    let relativePath: String
    var payload: [String: String] { ["name": name, "path": path, "relativePath": relativePath] }
}

struct FolderSnapshot: Equatable {
    let root: String
    let files: [FolderEntry]
    let directories: [FolderEntry]
    var payload: [String: Any] {
        ["root": root, "files": files.map(\.payload), "directories": directories.map(\.payload)]
    }
}

/// A recursive stream notices changes in new subdirectories without one open file
/// descriptor per directory. Enumeration and event coalescing stay on `queue`.
final class FolderMonitor {
    private final class Context {
        weak var monitor: FolderMonitor?
        init(_ monitor: FolderMonitor) { self.monitor = monitor }
    }
    let root: URL
    // Confined to queue after start. The renderer filters this union further
    // according to the current tree/library view.
    private var preferences: FilePreferences
    private let onChange: (FolderSnapshot) -> Void
    private let queue = DispatchQueue(label: "local.typora-replica.folder", qos: .utility)
    private let lock = NSLock()
    private var active = false
    private var generation = 0
    // The following values are confined to queue, apart from final deinit cleanup.
    private var stream: FSEventStreamRef?
    private var scheduledScan: DispatchWorkItem?
    private var forceNextDelivery = false
    private var previous: FolderSnapshot?
    private var directorySources: [String: DispatchSourceFileSystemObject] = [:]
    private var reconciliationTimer: DispatchSourceTimer?
    private var backend = "not-started"
    var observationBackend: String {
        lock.lock(); defer { lock.unlock() }
        return backend
    }

    init(root: URL, extensions: Set<String>, onChange: @escaping (FolderSnapshot) -> Void) {
        self.root = root.standardizedFileURL
        self.preferences = FilePreferences(supportedExtensions: extensions)
        self.onChange = onChange
    }

    init(root: URL, preferences: FilePreferences, onChange: @escaping (FolderSnapshot) -> Void) {
        self.root = root.standardizedFileURL
        self.preferences = preferences
        self.onChange = onChange
    }

    /// Re-enumerate on a filter change, including newly visible hidden files or
    /// extensions. A renderer-only filter cannot recover omitted disk entries.
    func updatePreferences(_ preferences: FilePreferences, forceDelivery: Bool = true) {
        let token = currentGeneration()
        queue.async { [weak self] in
            guard let self, self.isActive(token) else { return }
            self.preferences = preferences
            self.scheduleScan(forceDelivery: forceDelivery, generation: token)
        }
    }

    func start() {
        lock.lock()
        guard !active else { lock.unlock(); return }
        active = true
        generation += 1
        let token = generation
        lock.unlock()
        queue.async { [weak self] in
            guard let self, self.isActive(token) else { return }
            self.startStream()
            if self.stream == nil { self.updateDirectorySources([]) }
            self.scheduleScan(forceDelivery: true, generation: token)
        }
    }

    /// Explicit renderer reloads can request the latest payload. Disk events only
    /// deliver when membership or directory paths actually changed.
    func refresh(forceDelivery: Bool = false) {
        let token = currentGeneration()
        queue.async { [weak self] in
            guard let self, self.isActive(token) else { return }
            self.scheduleScan(forceDelivery: forceDelivery, generation: token)
        }
    }

    /// Invalidates even a main-queue delivery already waiting behind close().
    /// Stream teardown is queued, so main never waits for recursive enumeration.
    func stop() {
        lock.lock()
        active = false
        generation += 1
        lock.unlock()
        queue.async { [self] in
            scheduledScan?.cancel(); scheduledScan = nil
            forceNextDelivery = false
            if let stream {
                FSEventStreamStop(stream)
                FSEventStreamInvalidate(stream)
                FSEventStreamRelease(stream)
                self.stream = nil
            }
            for source in directorySources.values { source.cancel() }
            directorySources.removeAll()
            reconciliationTimer?.cancel(); reconciliationTimer = nil
            previous = nil
        }
    }

    deinit {
        for source in directorySources.values { source.cancel() }
        reconciliationTimer?.cancel()
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    private func currentGeneration() -> Int {
        lock.lock(); defer { lock.unlock() }
        return generation
    }

    private func isActive(_ token: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active && generation == token
    }

    private var canonicalRootPath: String {
        (try? root.resourceValues(forKeys: [.canonicalPathKey]))?.canonicalPath ?? root.path
    }

    private func startStream() {
        guard stream == nil else { return }
        let retainedContext = Context(self)
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(retainedContext).toOpaque(),
            retain: { pointer in
                guard let pointer else { return nil }
                _ = Unmanaged<Context>.fromOpaque(pointer).retain()
                return UnsafeRawPointer(pointer)
            },
            release: { pointer in
                if let pointer { Unmanaged<Context>.fromOpaque(pointer).release() }
            },
            copyDescription: nil
        )
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagNoDefer)
        lock.lock(); backend = "dispatch-sources"; lock.unlock()
        guard let created = FSEventStreamCreate(kCFAllocatorDefault, { _, info, _, _, _, _ in
            guard let info else { return }
            let context = Unmanaged<Context>.fromOpaque(info).takeUnretainedValue()
            context.monitor?.receivedEvents()
        }, &context, [canonicalRootPath] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.15, flags) else { return }
        FSEventStreamSetDispatchQueue(created, queue)
        if FSEventStreamStart(created) {
            stream = created
            lock.lock(); backend = "fsevents"; lock.unlock()
        }
        else { FSEventStreamInvalidate(created); FSEventStreamRelease(created) }
    }

    private func receivedEvents() {
        let token = currentGeneration()
        guard isActive(token) else { return }
        scheduleScan(forceDelivery: false, generation: token)
    }

    private func scheduleScan(forceDelivery: Bool, generation token: Int) {
        forceNextDelivery = forceNextDelivery || forceDelivery
        // One pending scan bounds latency even while events keep arriving.
        guard scheduledScan == nil else { return }
        let task = DispatchWorkItem { [weak self] in
            guard let self, self.isActive(token) else { return }
            self.scheduledScan = nil
            let snapshot = self.scan()
            guard self.isActive(token) else { return }
            if self.stream == nil { self.updateDirectorySources(snapshot.directories) }
            let force = self.forceNextDelivery
            self.forceNextDelivery = false
            guard force || snapshot != self.previous else { return }
            self.previous = snapshot
            DispatchQueue.main.async { [weak self] in
                guard let self, self.isActive(token) else { return }
                self.onChange(snapshot)
            }
        }
        scheduledScan = task
        queue.asyncAfter(deadline: .now() + 0.2, execute: task)
    }

    /// Restricted hosts can refuse FSEventStreamStart. Directory vnode sources
    /// cover immediate membership changes; each completed scan adds new folders.
    /// The parent source also notices replacement or recreation of the root.
    private func updateDirectorySources(_ directories: [FolderEntry]) {
        let fm = FileManager.default
        let parent = root.deletingLastPathComponent()
        let canonicalParent = (try? parent.resourceValues(forKeys: [.canonicalPathKey]))?.canonicalPath ?? parent.path
        var desired = Set([canonicalParent])
        var isDirectory: ObjCBool = false
        if fm.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue {
            desired.insert(canonicalRootPath)
            for directory in directories {
                desired.insert(URL(fileURLWithPath: canonicalRootPath).appendingPathComponent(directory.relativePath).path)
            }
        }
        for path in Array(directorySources.keys) where !desired.contains(path) {
            directorySources.removeValue(forKey: path)?.cancel()
        }
        var allWatched = true
        for path in desired where directorySources[path] == nil {
            let descriptor = open(path, O_EVTONLY)
            guard descriptor >= 0 else { allWatched = false; continue }
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .delete, .rename, .revoke], queue: queue)
            source.setCancelHandler { Darwin.close(descriptor) }
            source.setEventHandler { [weak self] in
                guard let self else { return }
                let flags = self.directorySources[path]?.data ?? []
                if !flags.intersection([.delete, .rename, .revoke]).isEmpty {
                    self.directorySources.removeValue(forKey: path)?.cancel()
                }
                self.receivedEvents()
            }
            directorySources[path] = source
            source.resume()
        }
        // Descriptor limits must not silently omit deep subtrees. Reconcile only
        // while a directory cannot be watched, and still suppress equal payloads.
        if !allWatched, reconciliationTimer == nil {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 5, repeating: 5)
            timer.setEventHandler { [weak self] in self?.receivedEvents() }
            reconciliationTimer = timer; timer.resume()
        } else if allWatched {
            reconciliationTimer?.cancel(); reconciliationTimer = nil
        }
    }

    private func scan() -> FolderSnapshot {
        Self.snapshot(root: root, preferences: preferences)
    }

    /// Shared scanner for live observation and isolated, real-directory QA.
    static func snapshot(root: URL, preferences: FilePreferences) -> FolderSnapshot {
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isRegularFileKey, .isHiddenKey]
        var files: [FolderEntry] = []
        var directories: [FolderEntry] = []
        // FileManager returns canonical URLs (for example /private/var) even
        // when the selected URL uses /var. Compare components in the same space.
        let canonical = (try? root.resourceValues(forKeys: [.canonicalPathKey]))?.canonicalPath ?? root.path
        let scanRoot = URL(fileURLWithPath: canonical, isDirectory: true)
        var options: FileManager.DirectoryEnumerationOptions = [.skipsPackageDescendants]
        if !preferences.showHiddenFiles { options.insert(.skipsHiddenFiles) }
        if let enumerator = FileManager.default.enumerator(at: scanRoot, includingPropertiesForKeys: Array(keys), options: options) {
            for case let url as URL in enumerator {
                let values = try? url.resourceValues(forKeys: keys)
                let relative = url.pathComponents.dropFirst(scanRoot.pathComponents.count).joined(separator: "/")
                let entry = FolderEntry(name: url.lastPathComponent, path: root.appendingPathComponent(relative).path, relativePath: relative)
                if !preferences.showHiddenFiles && values?.isHidden == true {
                    if values?.isDirectory == true { enumerator.skipDescendants() }
                    continue
                }
                if values?.isDirectory == true {
                    if preferences.allowsEnumeratedDirectory(relativePath: relative) { directories.append(entry) }
                    else { enumerator.skipDescendants() }
                } else if values?.isRegularFile == true && preferences.allowsEnumeratedFile(name: entry.name, relativePath: relative) {
                    files.append(entry)
                }
            }
        }
        let sorted: (FolderEntry, FolderEntry) -> Bool = { left, right in
            let comparison = left.relativePath.localizedStandardCompare(right.relativePath)
            return comparison == .orderedSame ? left.path < right.path : comparison == .orderedAscending
        }
        return FolderSnapshot(root: root.path, files: files.sorted(by: sorted), directories: directories.sorted(by: sorted))
    }
}
