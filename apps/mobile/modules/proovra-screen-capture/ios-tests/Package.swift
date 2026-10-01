// swift-tools-version:5.9
//
// UC-IOS-012 — XCTest for ProovraDarwinNotify, run on macOS by native-build.yml
// (`swift test`). The target compiles the SHIPPED file: CI copies
// ../ios/ProovraDarwinNotify.swift into Sources/DarwinNotifyBridge/ first
// (that directory is generated, never committed). Darwin notifications work on
// macOS, so the cross-process bridge is exercised for real, not mocked.
import PackageDescription

let package = Package(
  name: "ProovraDarwinNotifyTests",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "DarwinNotifyBridge", path: "Sources/DarwinNotifyBridge"),
    .testTarget(
      name: "ProovraDarwinNotifyTests",
      dependencies: ["DarwinNotifyBridge"],
      path: "Tests/ProovraDarwinNotifyTests"
    ),
  ]
)
