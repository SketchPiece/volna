// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Pult",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "PultCore", targets: ["PultCore"]),
        .executable(name: "pult-probe", targets: ["pult-probe"]),
        .executable(name: "Pult", targets: ["Pult"]),
    ],
    targets: [
        .target(name: "PultCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "pult-probe", dependencies: ["PultCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "Pult", dependencies: ["PultCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "PultCoreTests", dependencies: ["PultCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
