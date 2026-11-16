import Accelerate
import AVFoundation
import Foundation

/// A video's frames, read with AVFoundation: every frame the file holds, in presentation order, decoded faster than real
/// time with no playback and no window. Each frame is RGBA, turned as the file asks to be shown. A frame unchanged from the
/// one before it is dropped, so the one before lasts longer. One reader per call; `read` runs off the main actor.
final class VideoFrames: @unchecked Sendable {
    /// The frames' size as shown, known once the first frame is read.
    private(set) var width = 0
    private(set) var height = 0
    /// The clip's length in seconds, as the file states it.
    let duration: Double
    /// The time of each frame kept, in seconds.
    private(set) var times: [Double] = []

    private let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private let turn: Int   // quarter turns clockwise, 0 to 3
    private var stored = (width: 0, height: 0)
    private var last: Data?
    private var ended = false

    static func open(_ url: URL) async throws -> VideoFrames {
        let asset = AVURLAsset(url: url)
        do {
            guard let track = try await asset.loadTracks(withMediaType: .video).first else {
                throw JXLError(code: "JXL_INPUT", message: "Video has no frames.")
            }
            let transform = try await track.load(.preferredTransform)
            let length = try await asset.load(.duration)
            return try VideoFrames(asset: asset, track: track, transform: transform, length: length)
        } catch let error as JXLError {
            throw error
        } catch {
            throw JXLError(code: "JXL_INPUT", message: "Video cannot be played: \(error.localizedDescription).")
        }
    }

    private init(asset: AVAsset, track: AVAssetTrack, transform: CGAffineTransform, length: CMTime) throws {
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw JXLError(code: "JXL_INPUT", message: "Video cannot be played: its track cannot be read.") }
        reader.add(output)
        self.reader = reader
        self.output = output
        turn = VideoFrames.quarterTurns(transform)
        duration = length.seconds
        guard reader.startReading() else {
            throw JXLError(code: "JXL_INPUT", message: "Video cannot be played: \(reader.error?.localizedDescription ?? "the system cannot decode it").")
        }
    }

    deinit { if reader.status == .reading { reader.cancelReading() } }

    /// The next frames kept, one after another in one buffer of about `bytes` at most, with their times; nil after the last.
    func read(bytes: Int) throws -> (data: Data, times: [Double])? {
        var data = Data(), found: [Double] = []
        while !ended, data.isEmpty || data.count + width * height * 4 <= bytes {
            guard let sample = output.copyNextSampleBuffer() else {
                if reader.status == .failed {
                    throw JXLError(code: "JXL_INPUT", message: "Video cannot be read: \(reader.error?.localizedDescription ?? "the system cannot decode it").")
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
            guard w > 0, h > 0 else { throw JXLError(code: "JXL_INPUT", message: "Video has no frames.") }
            stored = (w, h)
            width = turn % 2 == 1 ? h : w
            height = turn % 2 == 1 ? w : h
        }
        guard w == stored.width, h == stored.height else {
            throw JXLError(code: "JXL_INPUT", message: "Video changes size inside the clip; pass its decoded frames.")
        }
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixels) else { throw JXLError(code: "JXL_INPUT", message: "Video frame has no pixels.") }
        var source = vImage_Buffer(data: base, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: CVPixelBufferGetBytesPerRow(pixels))
        let order: [UInt8] = [2, 1, 0, 3]   // BGRA to RGBA
        let quarter = turn, shownWidth = width, shownHeight = height
        var frame = Data(count: shownWidth * shownHeight * 4)
        let status: vImage_Error = frame.withUnsafeMutableBytes { (out: UnsafeMutableRawBufferPointer) -> vImage_Error in
            var target = vImage_Buffer(data: out.baseAddress, height: vImagePixelCount(shownHeight), width: vImagePixelCount(shownWidth),
                                       rowBytes: shownWidth * 4)
            if quarter == 0 { return vImagePermuteChannels_ARGB8888(&source, &target, order, vImage_Flags(kvImageNoFlags)) }
            var upright = [UInt8](repeating: 0, count: w * h * 4)
            return upright.withUnsafeMutableBytes { (scratch: UnsafeMutableRawBufferPointer) -> vImage_Error in
                var flat = vImage_Buffer(data: scratch.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w * 4)
                let permuted = vImagePermuteChannels_ARGB8888(&source, &flat, order, vImage_Flags(kvImageNoFlags))
                if permuted != kvImageNoError { return permuted }
                let rotations = [kRotate0DegreesClockwise, kRotate90DegreesClockwise, kRotate180DegreesClockwise, kRotate270DegreesClockwise]
                let black: [UInt8] = [0, 0, 0, 0]
                return vImageRotate90_ARGB8888(&flat, &target, UInt8(rotations[quarter]), black, vImage_Flags(kvImageNoFlags))
            }
        }
        guard status == kvImageNoError else { throw JXLError(code: "JXL_INPUT", message: "Video frame cannot be read (vImage \(status)).") }
        return frame
    }

    /// The quarter turns clockwise a track's transform shows its frames at; a mirrored or skewed transform is shown as stored.
    private static func quarterTurns(_ t: CGAffineTransform) -> Int {
        switch (t.a.rounded(), t.b.rounded(), t.c.rounded(), t.d.rounded()) {
        case (0, 1, -1, 0): return 1
        case (-1, 0, 0, -1): return 2
        case (0, -1, 1, 0): return 3
        default: return 0
        }
    }
}
