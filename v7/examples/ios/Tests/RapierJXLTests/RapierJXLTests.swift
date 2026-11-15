import CryptoKit
import UIKit
import XCTest
@testable import RapierJXL

@MainActor
final class RapierJXLTests: XCTestCase {
    private func fixture(_ name: String, _ type: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: type, subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testPhotoEncodesAndDecodesAtItsSize() async throws {
        let photo = try fixture("photo", "jpg")
        let original = try XCTUnwrap(UIImage(data: photo))
        let jxl = try await JXLCodec().encode(original, quality: 80, effort: 3)
        XCTAssertEqual(jxl.prefix(2), Data([0xFF, 0x0A]))
        let decoded = try XCTUnwrap(UIImage(data: jxl), "UIImage reads JPEG XL on iOS 17 and later")
        XCTAssertEqual(decoded.size, original.size)
    }

    func testJPEGRestoresToTheSameSHA256() async throws {
        let jpeg = try fixture("photo", "jpg")
        let codec = JXLCodec()
        let jxl = try await codec.recompress(jpeg: jpeg)
        XCTAssertLessThan(jxl.count, jpeg.count)
        let restored = try await codec.restore(jxl)
        XCTAssertEqual(SHA256.hash(data: restored), SHA256.hash(data: jpeg))
    }

    func testGIFAnimates() async throws {
        let jxl = try await JXLCodec().animate(gif: try fixture("two-frames", "gif"))
        XCTAssertGreaterThan(jxl.count, 2)
        XCTAssertEqual(jxl.prefix(2), Data([0xFF, 0x0A]))
    }

    func testBadInputRefusesWithItsCode() async throws {
        let codec = JXLCodec()
        do {
            _ = try await codec.recompress(jpeg: Data([0, 1, 2]))
            XCTFail("A refusal was expected")
        } catch let error as JXLError {
            XCTAssertTrue(error.code.hasPrefix("JXL_"), error.code)
        }
        let next = try await codec.recompress(jpeg: try fixture("photo", "jpg"))
        XCTAssertFalse(next.isEmpty, "The next call recovers")
    }

    func testCancellationStops() async throws {
        let codec = JXLCodec()
        let photo = try fixture("photo", "jpg")
        let task = Task { try await codec.encodeExact(photo, effort: 3) }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("The call finished after cancel")
        } catch is CancellationError {}
        let next = try await codec.encode(photo, quality: 60, effort: 1)
        XCTAssertFalse(next.isEmpty, "A new call runs after a cancel")
    }
}
