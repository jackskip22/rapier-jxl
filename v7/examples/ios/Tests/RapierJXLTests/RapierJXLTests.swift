import CryptoKit
import ImageIO
#if canImport(UIKit)
import UIKit
#endif
import XCTest
@testable import RapierJXL

@MainActor
final class RapierJXLTests: XCTestCase {
    private var codec = JXLCodec()

    /// The page's first load is timed apart, so each test's own time reads cleanly.
    override func setUp() async throws {
        codec = JXLCodec()
        let start = Date()
        try await codec.warmUp()
        print("warm-up \(Date().timeIntervalSince(start)) s")
        let t0 = codec.marks.first?.at ?? start
        for mark in codec.marks { print("  \(mark.name) at \(mark.at.timeIntervalSince(t0)) s") }
        let first = Date()
        _ = try await codec.encode(try fixture("small", "jpg"), quality: 60, effort: 1)
        print("first call \(Date().timeIntervalSince(first)) s")
        for request in codec.requestLog { print("  served \(request.path) \(request.bytes) bytes at \(request.at.timeIntervalSince(t0)) s") }

    }

    private func fixture(_ name: String, _ type: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: type, subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testPhotoEncodesAndDecodesAtItsSize() async throws {
        let photo = try fixture("photo", "jpg")
        let original = try Self.image(photo)
        #if canImport(UIKit)
        let jxl = try await codec.encode(try XCTUnwrap(UIImage(data: photo)), quality: 80, effort: 3)
        #else
        let jxl = try await codec.encode(photo, quality: 80, effort: 3)
        #endif
        XCTAssertEqual(jxl.prefix(2), Data([0xFF, 0x0A]))
        let decoded = try Self.image(jxl)   // ImageIO reads JPEG XL on iOS 17 and macOS 14 and later
        XCTAssertEqual(decoded.width, original.width)
        XCTAssertEqual(decoded.height, original.height)
    }

    func testJPEGRestoresToTheSameSHA256() async throws {
        let jpeg = try fixture("photo", "jpg")
        let jxl = try await codec.recompress(jpeg: jpeg)
        XCTAssertLessThan(jxl.count, jpeg.count)
        let restored = try await codec.restore(jxl)
        XCTAssertEqual(SHA256.hash(data: restored), SHA256.hash(data: jpeg))
    }

    func testGIFAnimates() async throws {
        let jxl = try await codec.animate(gif: try fixture("two-frames", "gif"))
        XCTAssertGreaterThan(jxl.count, 2)
        XCTAssertEqual(jxl.prefix(2), Data([0xFF, 0x0A]))
    }

    func testVideoAnimates() async throws {
        let mp4 = try fixture("train", "mp4")   // 2 s, 24 frames of H.264
        var seen: [Double] = []
        let jxl = try await codec.animate(video: mp4, type: "video/mp4", effort: 1) { seen.append($0) }
        XCTAssertEqual(jxl.prefix(2), Data([0xFF, 0x0A]))
        XCTAssertFalse(seen.isEmpty, "Progress was reported")
        let read = try await readBack(jxl)
        print("video \(mp4.count) → \(jxl.count) bytes, \(read.frames) frames, \(read.seconds) s")
        XCTAssertGreaterThan(read.frames, 1)
        XCTAssertEqual(read.seconds, 2.0, accuracy: 0.1, "The clip's duration")
    }

    func testVideoFileCancels() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("train.mp4")
        try fixture("train", "mp4").write(to: url)
        let reading = expectation(description: "the page is reading the clip")
        reading.assertForOverFulfill = false
        let task = Task { try await codec.animate(video: url, effort: 3) { _ in reading.fulfill() } }
        await fulfillment(of: [reading], timeout: 30)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("A canceled call returned a result")
        } catch is CancellationError {}
        let next = try await codec.animate(video: url, effort: 1)
        XCTAssertFalse(next.isEmpty, "A new call runs after a cancel")
        XCTAssertEqual(codec.heldBytes, 0, "No late result is held")
    }

    func testCancelDuringColdStartRefuses() async throws {
        let small = try fixture("small", "jpg")
        for warm in [true, false] {
            let cold = JXLCodec()
            let task = Task { if warm { try await cold.warmUp() } else { _ = try await cold.encode(small, quality: 60, effort: 1) } }
            while cold.marks.isEmpty { await Task.yield() }   // the page is created and loading, not ready
            task.cancel()
            do {
                try await task.value
                XCTFail("A call canceled while the page loaded went on")
            } catch is CancellationError {}
            let next = try await cold.encode(small, quality: 60, effort: 1)
            XCTAssertEqual(next.prefix(2), Data([0xFF, 0x0A]), "The next call starts after a cold cancel")
            XCTAssertEqual(cold.heldBytes, 0)
        }
    }

    func testQueuedCallsCancelWhileAnotherRuns() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("train.mp4")
        try fixture("train", "mp4").write(to: url)
        let small = try fixture("small", "jpg")
        let reading = expectation(description: "the first call is reading the clip")
        reading.assertForOverFulfill = false
        let firstEnded = Flag()
        let first = Task { defer { firstEnded.value = true }; return try await codec.animate(video: url, effort: 3) { _ in reading.fulfill() } }
        await fulfillment(of: [reading], timeout: 30)
        let queuedEncode = Task { try await codec.encode(small, quality: 60, effort: 1) }
        let queuedWarmUp = Task { try await codec.warmUp() }
        while codec.waiting < 2 { await Task.yield() }
        queuedEncode.cancel()
        queuedWarmUp.cancel()
        do { _ = try await queuedEncode.value; XCTFail("A canceled queued encode ran") } catch is CancellationError {}
        do { try await queuedWarmUp.value; XCTFail("A canceled queued warmUp succeeded") } catch is CancellationError {}
        XCTAssertFalse(firstEnded.value, "The queued calls settled while the first still ran")
        XCTAssertEqual(codec.waiting, 0)
        let video = try await first.value
        XCTAssertEqual(video.prefix(2), Data([0xFF, 0x0A]), "The running call is untouched")
        // A cancel racing the hand-over: each call either runs or refuses, once.
        for _ in 0..<5 {
            let running = Task { try await codec.encode(small, quality: 60, effort: 1) }
            let queued = Task { try await codec.encode(small, quality: 60, effort: 1) }
            while codec.waiting < 1 { await Task.yield() }
            Task { _ = try? await running.value; queued.cancel() }
            _ = try await running.value
            do { _ = try await queued.value } catch is CancellationError {}
        }
        let next = try await codec.encode(small, quality: 60, effort: 1)
        XCTAssertEqual(next.prefix(2), Data([0xFF, 0x0A]), "The next call runs")
        XCTAssertEqual(codec.heldBytes, 0, "Nothing is held")
    }

    func testFailedSetupRefusesOnceAndTheNextCallStarts() async throws {
        let cold = JXLCodec(), small = try fixture("small", "jpg"), files = cold.webRoot
        cold.webRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)   // no page files
        do {
            _ = try await cold.encode(small, quality: 60, effort: 1)
            XCTFail("A setup without the page's files went on")
        } catch let error as JXLError {
            XCTAssertEqual(error.code, "JXL_BRIDGE")
        }
        cold.webRoot = files
        let next = try await cold.encode(small, quality: 60, effort: 1)
        XCTAssertEqual(next.prefix(2), Data([0xFF, 0x0A]), "The next call starts a fresh page")
    }

    func testStoppedPageRefusesAndTheNextCallStartsANewOne() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("train.mp4")
        try fixture("train", "mp4").write(to: url)
        let reading = expectation(description: "the page is reading the clip")
        reading.assertForOverFulfill = false
        let task = Task { try await codec.animate(video: url, effort: 3) { _ in reading.fulfill() } }
        await fulfillment(of: [reading], timeout: 30)
        let page = codec.bridge
        codec.stopPage()
        do {
            _ = try await task.value
            XCTFail("A call on a stopped page returned a result")
        } catch let error as JXLError {
            XCTAssertEqual(error.code, "JXL_BRIDGE")
        }
        let next = try await codec.encode(try fixture("small", "jpg"), quality: 60, effort: 1)
        XCTAssertEqual(next.prefix(2), Data([0xFF, 0x0A]), "The next call starts a new page")
        XCTAssertFalse(codec.bridge === page)
        XCTAssertEqual(codec.heldBytes, 0)
    }

    /// Frames and total seconds of an animated JPEG XL, read by the package's decoder in the page.
    private func readBack(_ jxl: Data) async throws -> (frames: Int, seconds: Double) {
        let bridge = try XCTUnwrap(codec.bridge)
        bridge.served["jpegxl/decode.mjs"] = try XCTUnwrap(Bundle.module.url(forResource: "decode", withExtension: "mjs", subdirectory: "Fixtures"))
        bridge.inputs["readback"] = jxl
        defer { bridge.inputs["readback"] = nil }
        let value = try await codec.callPage("""
            const {decode} = await import('./jpegxl/decode.mjs');
            const image = await decode(new Uint8Array(await (await fetch('/in/readback')).arrayBuffer()));
            return [image.frames.length, image.frames.reduce((sum, frame) => sum + frame.durationSeconds, 0)];
            """)
        let pair = try XCTUnwrap(value as? [Any])
        return (try XCTUnwrap((pair[0] as? NSNumber)?.intValue), try XCTUnwrap((pair[1] as? NSNumber)?.doubleValue))
    }

    func testBadInputRefusesWithItsCode() async throws {
        do {
            _ = try await codec.recompress(jpeg: Data([0, 1, 2]))
            XCTFail("A refusal was expected")
        } catch let error as JXLError {
            XCTAssertTrue(error.code.hasPrefix("JXL_"), error.code)
        }
        let next = try await codec.recompress(jpeg: try fixture("photo", "jpg"))
        XCTAssertFalse(next.isEmpty, "The next call recovers")
    }

    func testCancelBeforeStartRefuses() async throws {
        let photo = try fixture("photo", "jpg")
        let task = Task { try await codec.encodeExact(photo, effort: 3) }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("The call finished after cancel")
        } catch is CancellationError {}
        let next = try await codec.encode(try fixture("small", "jpg"), quality: 60, effort: 1)
        XCTAssertFalse(next.isEmpty)
    }

    func testCancelStopsARunningCall() async throws {
        let photo = try fixture("photo", "jpg")
        let started = expectation(description: "the worker started")
        codec.onStart = { [codec] _ in codec.onStart = nil; started.fulfill() }   // once: later calls start too
        let task = Task { try await codec.encodeExact(photo, effort: 3) }
        await fulfillment(of: [started], timeout: 30)
        let begin = Date()
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("A canceled call returned a result")
        } catch is CancellationError {}
        print("cancel to settled \(Date().timeIntervalSince(begin)) s")
        let next = try await codec.encode(try fixture("small", "jpg"), quality: 60, effort: 1)
        XCTAssertFalse(next.isEmpty, "A new call runs after a cancel")
        XCTAssertEqual(codec.heldBytes, 0, "No late result is held")
    }

    func testExactKeepsEverySample() async throws {
        let png = try Self.png(try Self.image(try fixture("photo", "jpg")))
        let jxl = try await codec.encodeExact(png)
        let before = try Self.samples(try Self.image(png)), after = try Self.samples(try Self.image(jxl))
        XCTAssertEqual(before, after)
    }

    func testGIFReadsBack() async throws {
        let jxl = try await codec.animate(gif: try fixture("two-frames", "gif"))
        // This floor proves only that iOS recognizes the file's first frame (the simulator's ImageIO reads one of two).
        // The frames and delays are checked by the package's decoder on the bytes WebKit wrote, in the WebKit proof.
        let source = try XCTUnwrap(CGImageSourceCreateWithData(jxl as CFData, nil))
        XCTAssertGreaterThanOrEqual(CGImageSourceGetCount(source), 1)
        print("ImageIO frames \(CGImageSourceGetCount(source))")
    }

    private static func image(_ data: Data) throws -> CGImage {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil), "ImageIO reads the file")
    }

    private static func png(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private static func samples(_ cg: CGImage) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
        let context = CGContext(data: &bytes, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        return bytes
    }
}

/// A mark a task sets on the main actor.
@MainActor final class Flag { var value = false }
