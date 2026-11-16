import Accelerate
import AVFoundation
import Flutter

/// Reads a video's frames for the Dart side, which sends them to the page in parts: every frame the file holds, in
/// presentation order, decoded faster than real time with no playback and no window (a hidden web view does not play video).
/// System frameworks only. Calls: `open` (id, path), `read` (id, bytes), `end` (id), `close` (id).
public final class RapierJxlPlugin: NSObject, FlutterPlugin {
    private var clips: [String: VideoFrames] = [:]   // touched on the main thread only
    private let reading = DispatchQueue(label: "app.rapier.jxl.video")

    public static func register(with registrar: FlutterPluginRegistrar) {
        registrar.addMethodCallDelegate(RapierJxlPlugin(), channel: FlutterMethodChannel(name: "app.rapier.jxl/video", binaryMessenger: registrar.messenger()))
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let arguments = call.arguments as? [String: Any] ?? [:]
        guard let id = arguments["id"] as? String else { return result(FlutterError(code: "JXL_BRIDGE", message: "The call has no clip id.", details: nil)) }
        func fail(_ error: Error) {
            let e = error as? ClipError ?? ClipError(code: "JXL_INPUT", message: "Video cannot be read: \(error.localizedDescription).")
            DispatchQueue.main.async { result(FlutterError(code: e.code, message: e.message, details: nil)) }
        }
        switch call.method {
        case "open":
            guard let path = arguments["path"] as? String else { return result(FlutterError(code: "JXL_BRIDGE", message: "The call has no path.", details: nil)) }
            Task {
                do {
                    let clip = try await VideoFrames.open(URL(fileURLWithPath: path))
                    DispatchQueue.main.async {
                        self.clips[id] = clip
                        result(["duration": clip.duration, "memory": Int(ProcessInfo.processInfo.physicalMemory)])
                    }
                } catch { fail(error) }
            }
        case "read":
            guard let clip = clips[id] else { return result(FlutterError(code: "JXL_BRIDGE", message: "The clip is not open.", details: nil)) }
            let bytes = arguments["bytes"] as? Int ?? 16 << 20
            reading.async {
                do {
                    let part = try clip.read(bytes: bytes)
                    DispatchQueue.main.async {
                        result(part.map { ["data": FlutterStandardTypedData(bytes: $0.data), "times": $0.times, "width": clip.width, "height": clip.height] as [String: Any] })
                    }
                } catch { fail(error) }
            }
        case "end": result(clips[id]?.end ?? 0)
        case "close": clips[id] = nil; result(nil)
        default: result(FlutterMethodNotImplemented)
        }
    }
}

struct ClipError: Error {
    let code: String
    let message: String
}

/// One reader per clip. Each frame is RGBA, turned as the file asks to be shown; a frame unchanged from the one before is
/// dropped, so the one before lasts longer.
final class VideoFrames: @unchecked Sendable {
    private(set) var width = 0, height = 0   // as shown, known once the first frame is read
    let duration: Double
    private var times: [Double] = []
    private let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private let turn: Int   // quarter turns clockwise, 0 to 3
    private var stored = (width: 0, height: 0)
    private var last: Data?
    private var ended = false

    static func open(_ url: URL) async throws -> VideoFrames {
        let asset = AVURLAsset(url: url)
        do {
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw ClipError(code: "JXL_INPUT", message: "Video has no frames.") }
            return try VideoFrames(asset: asset, track: track, transform: try await track.load(.preferredTransform), length: try await asset.load(.duration))
        } catch let error as ClipError {
            throw error
        } catch {
            throw ClipError(code: "JXL_INPUT", message: "Video cannot be played: \(error.localizedDescription).")
        }
    }

    private init(asset: AVAsset, track: AVAssetTrack, transform t: CGAffineTransform, length: CMTime) throws {
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        guard reader.canAdd(output) else { throw ClipError(code: "JXL_INPUT", message: "Video cannot be played: its track cannot be read.") }
        reader.add(output)
        guard reader.startReading() else {
            throw ClipError(code: "JXL_INPUT", message: "Video cannot be played: \(reader.error?.localizedDescription ?? "the system cannot decode it").")
        }
        self.reader = reader
        self.output = output
        duration = length.seconds
        // A mirrored or skewed transform is shown as stored.
        switch (t.a.rounded(), t.b.rounded(), t.c.rounded(), t.d.rounded()) {
        case (0, 1, -1, 0): turn = 1
        case (-1, 0, 0, -1): turn = 2
        case (0, -1, 1, 0): turn = 3
        default: turn = 0
        }
    }

    deinit { if reader.status == .reading { reader.cancelReading() } }

    /// The next frames kept, one after another in one buffer of about `bytes` at most, with their times; nil after the last.
    func read(bytes: Int) throws -> (data: Data, times: [Double])? {
        var data = Data(), found: [Double] = []
        while !ended, data.isEmpty || data.count + width * height * 4 <= bytes {
            guard let sample = output.copyNextSampleBuffer() else {
                if reader.status == .failed {
                    throw ClipError(code: "JXL_INPUT", message: "Video cannot be read: \(reader.error?.localizedDescription ?? "the system cannot decode it").")
                }
                ended = true
                break
            }
            guard let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
            let frame = try rgba(pixels)
            if frame == last { continue }
            last = frame
            data.append(frame)
            found.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
        }
        times += found
        return found.isEmpty ? nil : (data, found)
    }

    /// When the last frame ends: the clip's end, or where the end is not past it, as long as the frames before it.
    var end: Double {
        guard let lastTime = times.last, let firstTime = times.first else { return 0 }
        let span = times.count > 1 ? (lastTime - firstTime) / Double(times.count - 1) : 1.0 / 60
        return duration.isFinite && duration > lastTime + 1e-3 ? duration : lastTime + span
    }

    private func rgba(_ pixels: CVPixelBuffer) throws -> Data {
        let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels)
        if stored.width == 0 {
            guard w > 0, h > 0 else { throw ClipError(code: "JXL_INPUT", message: "Video has no frames.") }
            stored = (w, h)
            (width, height) = turn % 2 == 1 ? (h, w) : (w, h)
        }
        guard w == stored.width, h == stored.height else {
            throw ClipError(code: "JXL_INPUT", message: "Video changes size inside the clip; pass its decoded frames.")
        }
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixels) else { throw ClipError(code: "JXL_INPUT", message: "Video frame has no pixels.") }
        var source = vImage_Buffer(data: base, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: CVPixelBufferGetBytesPerRow(pixels))
        let order: [UInt8] = [2, 1, 0, 3]   // BGRA to RGBA
        let quarter = turn, shownWidth = width, shownHeight = height
        var frame = Data(count: shownWidth * shownHeight * 4)
        let status: vImage_Error = frame.withUnsafeMutableBytes { (out: UnsafeMutableRawBufferPointer) -> vImage_Error in
            var target = vImage_Buffer(data: out.baseAddress, height: vImagePixelCount(shownHeight), width: vImagePixelCount(shownWidth), rowBytes: shownWidth * 4)
            if quarter == 0 { return vImagePermuteChannels_ARGB8888(&source, &target, order, vImage_Flags(kvImageNoFlags)) }
            var upright = [UInt8](repeating: 0, count: w * h * 4)
            return upright.withUnsafeMutableBytes { (scratch: UnsafeMutableRawBufferPointer) -> vImage_Error in
                var flat = vImage_Buffer(data: scratch.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w * 4)
                let permuted = vImagePermuteChannels_ARGB8888(&source, &flat, order, vImage_Flags(kvImageNoFlags))
                if permuted != kvImageNoError { return permuted }
                let rotations = [kRotate0DegreesClockwise, kRotate90DegreesClockwise, kRotate180DegreesClockwise, kRotate270DegreesClockwise]
                return vImageRotate90_ARGB8888(&flat, &target, UInt8(rotations[quarter]), [0, 0, 0, 0], vImage_Flags(kvImageNoFlags))
            }
        }
        guard status == kvImageNoError else { throw ClipError(code: "JXL_INPUT", message: "Video frame cannot be read (vImage \(status)).") }
        return frame
    }
}
