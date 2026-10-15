// swift-tools-version:5.9
//
// XCTest for the Foundation-only iOS capture files, run on macOS by
// native-build.yml (`swift test`). Each target compiles the SHIPPED file: CI
// copies them from ../ios/ into Sources/<target>/ first (those directories are
// generated, never committed):
//   * UC-IOS-012 — ProovraDarwinNotify.swift → Sources/DarwinNotifyBridge/.
//     Darwin notifications work on macOS, so the cross-process bridge is
//     exercised for real, not mocked.
//   * AUD-006 — ProovraBroadcastSpool.swift → Sources/BroadcastSpool/: the
//     per-broadcast spool namespaces, binding adoption, sequence continuity,
//     liveness and idempotent finalisation, on a real file system.
import PackageDescription

let package = Package(
  name: "ProovraDarwinNotifyTests",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "DarwinNotifyBridge", path: "Sources/DarwinNotifyBridge"),
    .target(name: "BroadcastSpool", path: "Sources/BroadcastSpool"),
    .testTarget(
      name: "ProovraDarwinNotifyTests",
      dependencies: ["DarwinNotifyBridge"],
      path: "Tests/ProovraDarwinNotifyTests"
    ),
    .testTarget(
      name: "ProovraBroadcastSpoolTests",
      dependencies: ["BroadcastSpool"],
      path: "Tests/ProovraBroadcastSpoolTests"
    ),
  ]
)
