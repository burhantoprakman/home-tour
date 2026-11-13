// swift-tools-version: 6.0
import PackageDescription

// Pure capture logic (no ARKit/UIKit) so it is unit-tested on the Mac with `swift test`.
let package = Package(
    name: "CaptureCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "CaptureCore", targets: ["CaptureCore"])],
    targets: [
        .target(name: "CaptureCore"),
        .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore"]),
    ]
)
