// swift-tools-version:5.9
//
// Jarvis iOS — SwiftUI client for the Jarvis voice loop (US-09, Slice 10).
//
// Two products:
//   - `Jarvis` (library): the SwiftUI views, the WebSocket client, the
//     audio capture/playback engine, and the Keychain-backed userId.
//   - `JarvisApp` (executable on iOS): the @main entry point.
//
// Built with SwiftPM so the project is target-agnostic (the build does
// not require Xcode-only project files; xcodebuild reads Package.swift).
//
// To open in Xcode: `open ios/Jarvis/Package.swift`.
// To build from the command line:
//   xcodebuild -scheme Jarvis -destination 'platform=iOS Simulator,name=iPhone 15'
//
// Why SwiftPM (not an .xcodeproj)?
//   - One source of truth, lints clean, no drift between project file and disk.
//   - Plays nicely with command-line tooling, `swift build`, and CI.
//   - Style guide: idiomatic Swift packaging, protocol-oriented surface.

import PackageDescription

let package = Package(
    name: "Jarvis",
    defaultLocalization: "en",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(name: "Jarvis", targets: ["Jarvis"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "Jarvis",
            path: "Sources/Jarvis"
        ),
        .target(
            name: "JarvisApp",
            dependencies: ["Jarvis"],
            path: "Sources/JarvisApp"
        ),
        .testTarget(
            name: "JarvisTests",
            dependencies: ["Jarvis"],
            path: "Tests/JarvisTests"
        ),
    ]
)
