import Foundation
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

/// JPEG XL for iOS with no native code: a hidden WKWebView runs rapier-jxl in a worker.
/// Decoding needs nothing from this package: `UIImage(data:)` reads JPEG XL natively on iOS 17 and later.
@MainActor
public final class JXLCodec {
    private var web: WKWebView?
    private var bridge: Bridge?
    private var ready: [CheckedContinuation<Void, Error>] = []
    private var starting = false
    private var active: (id: String, done: CheckedContinuation<Void, Error>)?
    private var queue: [CheckedContinuation<Void, Never>] = []
    private var busy = false

    /// Called with a job's id when its worker has the input and starts. Tests wait on it before canceling.
    var onStart: ((String) -> Void)?
    /// Result and input bytes still held for jobs that are over; zero between calls.
    var heldBytes: Int { (bridge?.inputs.values.reduce(0) { $0 + $1.count } ?? 0) + (bridge?.outputs.values.reduce(0) { $0 + $1.count } ?? 0) }

    /// When the page was created, loaded, and its worker reported ready: the parts of a first call that are not ours to speed up.
    var marks: [(name: String, at: Date)] = []
    var requestLog: [(at: Date, path: String, bytes: Int)] { bridge?.requests ?? [] }

    public init() {}

    /// Loads the hidden page and its worker now, so the first call does not wait for them. Optional.
    public func warmUp() async throws {
        await turn()
        defer { next() }
        try await start()
    }

    /// Lossy, `quality` 1 to 100 (SSIMULACRA 2 score) and `effort` 1 to 3.
    public func encode(_ data: Data, quality: Double = 80, effort: Int = 3) async throws -> Data {
        try await run("encode", data, mime: Self.mime(of: data), quality: quality, effort: effort)
    }

    /// Every sample kept: the same pixels come back from any decoder. A JPEG is recompressed and restores byte for byte.
    public func encodeExact(_ data: Data, effort: Int = 3) async throws -> Data {
        try await run("encodeExact", data, mime: Self.mime(of: data), effort: effort)
    }

    /// A JPEG's own bytes in a smaller file; `restore(_:)` returns them unchanged.
    public func recompress(jpeg: Data, effort: Int = 3) async throws -> Data {
        try await run("recompress", jpeg, mime: "image/jpeg", effort: effort)
    }

    /// The JPEG a recompressed file was made from, byte for byte.
    public func restore(_ jxl: Data) async throws -> Data {
        try await run("restore", jxl, mime: "image/jxl")
    }

    /// An animated GIF as an animated JPEG XL, with its timing and loops. `effort` 1 to 9.
    public func animate(gif: Data, quality: Double = 80, effort: Int = 3) async throws -> Data {
        try await run("animate", gif, mime: "image/gif", quality: quality, effort: effort)
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

    // MARK: - One job at a time

    private func run(_ op: String, _ input: Data, mime: String, quality: Double = 80, effort: Int = 3) async throws -> Data {
        await turn()
        defer { next() }
        try Task.checkCancellation()
        try await start()
        let id = UUID().uuidString
        bridge!.inputs[id] = input
        defer { bridge?.inputs[id] = nil; bridge?.outputs["\(id)/result"] = nil }
        let job: [String: Any] = ["op": op, "id": id, "mime": mime, "quality": quality, "effort": effort]
        let json = String(data: try JSONSerialization.data(withJSONObject: job), encoding: .utf8)!
        do {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
                    active = (id, done)
                    web!.evaluateJavaScript("rapier.run(\(json))")
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

    private func turn() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { queue.append($0) }
    }

    private func next() {
        if queue.isEmpty { busy = false } else { queue.removeFirst().resume() }
    }

    // MARK: - The hidden page

    private func start() async throws {
        if web != nil, !starting { return }
        if !starting {
            starting = true
            let configuration = WKWebViewConfiguration()
            let bridge = try Bridge(web: Bundle.module.resourceURL!.appendingPathComponent("Web"))
            bridge.onMessage = { [weak self] in self?.receive($0) }
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
        try await withCheckedThrowingContinuation { ready.append($0) }
    }

    private func receive(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "ready":
            marks.append((name: "worker ready", at: Date()))
            starting = false
            ready.forEach { $0.resume() }
            ready = []
        case "started":
            if let id = message["id"] as? String { onStart?(id) }
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

    /// The page or its worker stopped: refuse what waits, and build a new page for the next call.
    private func teardown(_ error: JXLError) {
        web?.stopLoading()
        web = nil
        bridge = nil
        starting = false
        ready.forEach { $0.resume(throwing: error) }
        ready = []
        active?.done.resume(throwing: error)
        active = nil
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
