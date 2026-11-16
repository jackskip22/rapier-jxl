// swift-tools-version:5.9
import PackageDescription

// No native code: one hidden WKWebView runs the rapier-jxl modules that `node prepare-assets.mjs` copies into Web/.
let package = Package(
    name: "RapierJXL",
    platforms: [.iOS("16.4"), .macOS("13.3")],
    products: [.library(name: "RapierJXL", targets: ["RapierJXL"])],
    targets: [
        .target(name: "RapierJXL", resources: [.copy("Web")]),
        .testTarget(name: "RapierJXLTests", dependencies: ["RapierJXL"], resources: [.copy("Fixtures")]),
    ]
)
