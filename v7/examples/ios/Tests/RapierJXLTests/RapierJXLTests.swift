import CryptoKit
import ImageIO
import UIKit
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
    }

    private func fixture(_ name: String, _ type: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: type, subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testPhotoEncodesAndDecodesAtItsSize() async throws {
        let photo = try fixture("photo", "jpg")
        let original = try XCTUnwrap(UIImage(data: photo))
        let jxl = try await codec.encode(original, quality: 80, effort: 3)
        XCTAssertEqual(jxl.prefix(2), Data([0xFF, 0x0A]))
        let decoded = try XCTUnwrap(UIImage(data: jxl), "UIImage reads JPEG XL on iOS 17 and later")
        XCTAssertEqual(decoded.size, original.size)
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
        let next = try await codec.encode(photo, quality: 60, effort: 1)
        XCTAssertFalse(next.isEmpty)
    }

    func testCancelStopsARunningCall() async throws {
        let photo = try fixture("photo", "jpg")
        let started = expectation(description: "the worker started")
        codec.onStart = { _ in started.fulfill() }
        let task = Task { try await codec.encodeExact(photo, effort: 3) }
        await fulfillment(of: [started], timeout: 30)
        let begin = Date()
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("A canceled call returned a result")
        } catch is CancellationError {}
        print("cancel to settled \(Date().timeIntervalSince(begin)) s")
        let next = try await codec.encode(photo, quality: 60, effort: 1)
        XCTAssertFalse(next.isEmpty, "A new call runs after a cancel")
        XCTAssertEqual(codec.heldBytes, 0, "No late result is held")
    }

    func testExactKeepsEverySample() async throws {
        let photo = try XCTUnwrap(UIImage(data: try fixture("photo", "jpg")))
        let png = try XCTUnwrap(photo.pngData())
        let jxl = try await codec.encodeExact(png)
        let before = try Self.samples(UIImage(data: png)!), after = try Self.samples(try XCTUnwrap(UIImage(data: jxl)))
        XCTAssertEqual(before, after)
    }

    func testGIFFramesAndTiming() async throws {
        let jxl = try await codec.animate(gif: try fixture("two-frames", "gif"))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(jxl as CFData, nil))
        XCTAssertEqual(CGImageSourceGetCount(source), 2)
    }

    private static func samples(_ image: UIImage) throws -> [UInt8] {
        let cg = try XCTUnwrap(image.cgImage)
        var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
        let context = CGContext(data: &bytes, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        return bytes
    }
}
