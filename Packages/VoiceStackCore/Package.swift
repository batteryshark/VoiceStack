// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "VoiceStackCore",
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [.library(name: "VoiceStackCore", targets: ["VoiceStackCore"])],
    targets: [.target(name: "VoiceStackCore"), .testTarget(name: "VoiceStackCoreTests", dependencies: ["VoiceStackCore"])],
    swiftLanguageModes: [.v5]
)
