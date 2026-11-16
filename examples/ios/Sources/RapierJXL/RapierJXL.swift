import Foundation
import UniformTypeIdentifiers
import WebKit
#if canImport(UIKit)
import UIKit
#endif

/// A refusal carries the package's own `JXL_` code, for example `JXL_JPEG_UNSUPPORTED`.
public struct JXLError: Error, LocalizedError, Equatable {
    public let code: String
    public let message: String
    public var errorDescription: String? { "\(code): \(message)" }
}

/// JPEG XL for iOS and macOS with no native code: a hidden WKWebView runs rapier-jxl in a worker; AVFoundation reads a video's frames.
/// Decoding needs nothing from this package: `UIImage(data:)` reads JPEG XL natively on iOS 17 and later.
@MainActor
public final class JXLCodec {
    private var web: WKWebView?
    private(set) var bridge: Bridge?
    private var ready: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var starting = false
    private var active: (id: String, done: CheckedContinuation<Void, Error>, progress: ((Double) -> Void)?)?
    private var queue: [(id: UUID, go: CheckedContinuation<Void, Error>)] = []
    private var busy = false

    /// Called with a job's id when its worker has the input and starts. Tests wait on it before canceling.
    var onStart: ((String) -> Void)?
    /// Result and input bytes still held for jobs that are over; zero between calls.
    var heldBytes: Int { (bridge?.inputs.values.reduce(0) { $0 + $1.count } ?? 0) + (bridge?.outputs.values.reduce(0) { $0 + $1.count } ?? 0) }

    /// When the page was created, loaded, and its worker reported ready: the parts of a first call that are not ours to speed up.
    var marks: [(name: String, at: Date)] = []
    var requestLog: [(at: Date, path: String, bytes: Int)] { bridge?.requests ?? [] }

    /// The page's files. Tests point it at a folder without them to fail the setup once.
    var webRoot = Bundle.module.resourceURL!.appendingPathComponent("Web")

    public init() {}

    /// Loads the hidden page and its worker now, so the first call does not wait for them. Optional.
    public func warmUp() async throws {
        try await turn()
        defer { next() }
        try Task.checkCancellation()
        try await start()
    }

    /// Lossy, `quality` 1 to 100 (SSIMULACRA 2 score) and `effort` 1 to 3.
    public func encode(_ data: Data, quality: Double = 80, effort: Int = 3) async throws -> Data {
        try await run("encode", data, mime: Self.mime(of: data), quality: quality, effort: effort)
    }

    /// Every sample kept: the same pixels come back from any decoder. A JPEG is recompressed and restores exactly.
    public func encodeExact(_ data: Data, effort: Int = 3) async throws -> Data {
        try await run("encodeExact", data, mime: Self.mime(of: data), effort: effort)
    }

    /// A JPEG's own bytes in a smaller file; `restore(_:)` returns them unchanged.
    public func recompress(jpeg: Data, effort: Int = 3) async throws -> Data {
        try await run("recompress", jpeg, mime: "image/jpeg", effort: effort)
    }

    /// The JPEG a recompressed file was made from, exactly.
    public func restore(_ jxl: Data) async throws -> Data {
        try await run("restore", jxl, mime: "image/jxl")
    }

    /// A video as an animated JPEG XL: every frame the file holds, each with its own time, read with AVFoundation. `type` is
    /// its MIME type, for example `video/mp4` or `video/quicktime`. `effort` 1 to 9; `progress` gets 0 to 1 (reading the clip,
    /// then encoding). A clip longer than the device's memory holds is refused with its `JXL_` code.
    public func animate(video: Data, type: String, quality: Double = 80, effort: Int = 3,
                        progress: ((Double) -> Void)? = nil) async throws -> Data {
        let name = UUID().uuidString + "." + (UTType(mimeType: type)?.preferredFilenameExtension ?? "mp4")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do { try video.write(to: url) } catch {
            throw JXLError(code: "JXL_INPUT", message: "The video could not be staged for reading: \(error.localizedDescription)")
        }
        defer { try? FileManager.default.removeItem(at: url) }
        return try await animate(video: url, quality: quality, effort: effort, progress: progress)
    }

    /// A video file, for example the movie a `PhotosPicker` gives, as an animated JPEG XL. AVFoundation reads its frames
    /// faster than real time, with no playback; they reach the page in parts, so a cancel or a stopped page acts between parts.
    public func animate(video url: URL, quality: Double = 80, effort: Int = 3,
                        progress: ((Double) -> Void)? = nil) async throws -> Data {
        try await turn()
        defer { next() }
        try Task.checkCancellation()
        try await start()
        let id = UUID().uuidString
        trace?("video \(id.prefix(8)): opening")
        let clip = try await VideoFrames.open(url)
        guard let page = bridge, let web else { throw Self.stopped }
        // Held on the page until the encoder takes it: an eighth of the device's memory at most, as the browser path holds.
        let budget = Int(ProcessInfo.processInfo.physicalMemory / 8)
        var part = 0, held = 0
        let partBytes = Self.partBytes
        do {
            while true {
                try Task.checkCancellation()
                guard let batch = try await Task.detached(operation: { try clip.read(bytes: partBytes) }).value else { break }
                try Task.checkCancellation()
                guard bridge === page else { throw Self.stopped }
                held += batch.data.count
                if held > budget {
                    throw JXLError(code: "JXL_MEMORY", message: "Video is too long for this device's memory at \(clip.width) x \(clip.height) (\(clip.times.count) frames read); shorten or shrink the clip.")
                }
                let key = "\(id).\(part)"
                page.inputs[key] = batch.data
                defer { page.inputs[key] = nil }
                trace?("video \(id.prefix(8)): part \(part), \(batch.times.count) frames to \(batch.times.last ?? 0) s")
                do {
                    _ = try await web.callAsyncJavaScript("await rapier.frames(job); return true", arguments: ["job": [
                        "id": id, "part": part, "width": clip.width, "height": clip.height, "times": batch.times,
                    ] as [String: Any]], contentWorld: .page)
                } catch {
                    if bridge !== page { throw Self.stopped }
                    throw JXLError(code: "JXL_BRIDGE", message: "The page did not take the frames: \(error.localizedDescription)")
                }
                part += 1
                if clip.duration > 0, clip.duration.isFinite { progress?(min(1, (batch.times.last ?? 0) / clip.duration) / 2) }
            }
            guard !clip.times.isEmpty else { throw JXLError(code: "JXL_INPUT", message: "Video has no frames.") }
            try Task.checkCancellation()
            guard bridge === page else { throw Self.stopped }
            trace?("video \(id.prefix(8)): \(clip.times.count) frames read, encoding")
            let job: [String: Any] = ["op": "animate", "id": id, "mime": "video/frames", "end": clip.end, "quality": quality, "effort": effort]
            let result = try await perform(job, id: id) { progress?(0.5 + $0 / 2) }
            trace?("video \(id.prefix(8)): done, \(result.count) bytes")
            return result
        } catch {
            trace?("video \(id.prefix(8)): stopped at part \(part): \(error)")
            if bridge === page { web.evaluateJavaScript("rapier.drop(\"\(id)\")", completionHandler: nil) }
            throw error
        }
    }

    /// Frames reach the page in parts of about this many bytes.
    static let partBytes = 16 << 20
    private static let stopped = JXLError(code: "JXL_BRIDGE", message: "The page's process stopped; the next call starts a new page.")
    /// Where a call is, for the tests' log.
    var trace: ((String) -> Void)?

    /// An animated GIF as an animated JPEG XL, with its timing and loops. `effort` 1 to 9.
    public func animate(gif: Data, quality: Double = 80, effort: Int = 3, progress: ((Double) -> Void)? = nil) async throws -> Data {
        try await run("animate", gif, mime: "image/gif", quality: quality, effort: effort, progress: progress)
    }

    #if canImport(UIKit)
    public func encode(_ image: UIImage, quality: Double = 80, effort: Int = 3) async throws -> Data {
        try await encode(try Self.png(image), quality: quality, effort: effort)
    }

    public func encodeExact(_ image: UIImage, effort: Int = 3) async throws -> Data {
        try await encodeExact(try Self.png(image), effort: effort)
    }

    private static func png(_ image: UIImage) throws -> Data {
        guard let data = image.pngData() else { throw JXLError(code: "JXL_INPUT", message: "The image has no pixels.") }
        return data
    }
    #endif

    /// Runs `body` as an async function on the page with `arguments`, and returns its value. Tests only.
    func callPage(_ body: String, arguments: [String: Any] = [:]) async throws -> Any? {
        try await start()
        return try await web!.callAsyncJavaScript(body, arguments: arguments, contentWorld: .page)
    }

    /// Stops the page's WebContent process, as iOS does under memory pressure. Tests only.
    func stopPage() {
        guard let web, let bridge else { return }
        let kill = NSSelectorFromString("_killWebContentProcess")
        if web.responds(to: kill) { web.perform(kill) }
        bridge.webViewWebContentProcessDidTerminate(web)   // WebKit does not report a stop the app asked for
    }

    // MARK: - One job at a time

    private func run(_ op: String, _ input: Data, mime: String, quality: Double = 80, effort: Int = 3,
                     progress: ((Double) -> Void)? = nil) async throws -> Data {
        try await turn()
        defer { next() }
        try Task.checkCancellation()
        try await start()
        let id = UUID().uuidString
        bridge!.inputs[id] = input
        defer { bridge?.inputs[id] = nil }
        return try await perform(["op": op, "id": id, "mime": mime, "quality": quality, "effort": effort], id: id, progress: progress)
    }

    /// Runs one job on the current page and returns its result; a cancel asks the page to stop it.
    private func perform(_ job: [String: Any], id: String, progress: ((Double) -> Void)?) async throws -> Data {
        defer { bridge?.outputs["\(id)/result"] = nil }
        let json = String(data: try JSONSerialization.data(withJSONObject: job), encoding: .utf8)!
        do {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
                    guard let web else { return done.resume(throwing: Self.stopped) }
                    active = (id, done, progress)
                    web.evaluateJavaScript("rapier.run(\(json))")
                }
            } onCancel: {
                Task { @MainActor in self.web?.evaluateJavaScript("rapier.cancel(\"\(id)\")") }
            }
        } catch let error as JXLError where error.code == "JXL_CANCELED" {
            throw CancellationError()
        }
        guard let output = bridge?.outputs["\(id)/result"] else {
            throw JXLError(code: "JXL_BRIDGE", message: "The worker finished without a result.")
        }
        return output
    }

    /// Calls waiting for their turn. Tests only.
    var waiting: Int { queue.count }

    /// Waits for this call's turn. A cancel while waiting leaves the queue and throws at once; a turn handed over just
    /// before the cancel is kept, and the caller's own check refuses it. Each waiter is removed before it is resumed,
    /// so it is resumed once. A call that throws here does not hold the turn.
    private func turn() async throws {
        if !busy { busy = true; return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (go: CheckedContinuation<Void, Error>) in
                if Task.isCancelled { go.resume(throwing: CancellationError()) } else { queue.append((id, go)) }
            }
        } onCancel: {
            Task { @MainActor in
                if let index = self.queue.firstIndex(where: { $0.id == id }) { self.queue.remove(at: index).go.resume(throwing: CancellationError()) }
            }
        }
    }

    private func next() {
        if queue.isEmpty { busy = false } else { queue.removeFirst().go.resume() }
    }

    // MARK: - The hidden page

    private func start() async throws {
        if web != nil, !starting { return }
        if !starting {
            // The setup that can throw comes first: a refused setup leaves nothing half started, and the next call tries again.
            let bridge: Bridge
            do { bridge = try Bridge(web: webRoot) } catch {
                throw JXLError(code: "JXL_BRIDGE", message: "The page's files could not be read: \(error.localizedDescription)")
            }
            starting = true
            let configuration = WKWebViewConfiguration()
            // A page torn down can still deliver late: only the current page's messages count.
            bridge.onMessage = { [weak self, weak bridge] message in
                guard let self, let bridge, self.bridge === bridge else { return }
                self.receive(message)
            }
            bridge.onFailed = { [weak self, weak bridge] error in
                guard let self, let bridge, self.bridge === bridge else { return }
                self.teardown(error)
            }
            configuration.setURLSchemeHandler(bridge, forURLScheme: Bridge.scheme)
            configuration.userContentController.add(bridge, name: "rapier")
            let web = WKWebView(frame: .zero, configuration: configuration)
            bridge.onNavigated = { [weak self] in self?.marks.append((name: "page loaded", at: Date())) }
            web.navigationDelegate = bridge
            self.bridge = bridge
            self.web = web
            marks = [(name: "page created", at: Date())]
            web.load(URLRequest(url: Bridge.origin))
        }
        // A cancel while the page loads refuses this call only; the page goes on loading for the next one. The waiter
        // is removed before it is resumed, so ready, teardown and cancel resume it once.
        let waiter = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
                if Task.isCancelled { done.resume(throwing: CancellationError()) } else { ready[waiter] = done }
            }
        } onCancel: {
            Task { @MainActor in self.ready.removeValue(forKey: waiter)?.resume(throwing: CancellationError()) }
        }
    }

    private func receive(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "ready":
            if marks.count < 8 { marks.append((name: "worker ready", at: Date())) }
            starting = false
            let waiting = ready.values
            ready = [:]
            waiting.forEach { $0.resume() }
        case "started":
            if let id = message["id"] as? String { onStart?(id) }
        case "progress":
            if let id = message["id"] as? String, active?.id == id, let fraction = message["fraction"] as? Double { active?.progress?(fraction) }
        case "done":
            if let id = message["id"] as? String, active?.id == id { active?.done.resume(); active = nil }
        case "error":
            let code = message["code"] as? String ?? "JXL_MESSAGE"
            let error = JXLError(code: code, message: message["message"] as? String ?? "")
            if message["id"] is String, let current = active, current.id == message["id"] as? String {
                active = nil
                current.done.resume(throwing: error)
            } else {
                teardown(error)
            }
        default: break
        }
    }

    /// The page did not load, its process stopped, or its worker stopped: refuse what waits, and build a new page for
    /// the next call.
    private func teardown(_ error: JXLError) {
        let old = web
        web = nil
        bridge = nil
        starting = false
        old?.stopLoading()
        let waiting = ready.values, current = active
        ready = [:]
        active = nil
        waiting.forEach { $0.resume(throwing: error) }
        current?.done.resume(throwing: error)
    }

    // MARK: - Input type

    static func mime(of data: Data) -> String {
        let head = [UInt8](data.prefix(12))
        if head.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if head.starts(with: [0xFF, 0xD8]) { return "image/jpeg" }
        if head.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if head.count == 12, head.starts(with: Array("RIFF".utf8)), Array(head[8...]) == Array("WEBP".utf8) { return "image/webp" }
        return "application/octet-stream"
    }
}
