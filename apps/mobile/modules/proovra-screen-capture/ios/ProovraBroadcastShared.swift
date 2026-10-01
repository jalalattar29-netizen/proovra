import Foundation
import ReplayKit
import UIKit

/**
 * Main-app side helpers for the UC-5 iOS broadcast pipeline: read the segment
 * files the Broadcast Upload Extension writes into the shared App Group
 * container, present Apple's system broadcast picker, and bridge Darwin
 * notifications. The extension is the WRITER; this side is the READER. The file
 * layout under the container's `uc5-broadcast/` directory is the contract:
 *   - state.json      { active, segmentCount, startedAtUtc, segmentMs, maxSegments,
 *                       lastWriteAtUtc (heartbeat), appRequested }
 *   - result.json     the session summary (on stop) — see ProovraBroadcastResult
 *   - seg-<n>.mp4     ordered ORIGINAL segments (n = 0,1,2,…)
 *   - seg-<n>.json    { sequence, startedAtOffsetMs, durationMs, widthPx, heightPx, orientation }
 *
 * apps/mobile/test/ios-broadcast-contract.test.mjs pins this layout, the note
 * names and the device block against SampleHandler.swift and the JS/TS contract.
 */

/// THE Darwin note names shared with SampleHandler.swift (by value).
enum ProovraBroadcastNotes {
  static let segmentReady = "com.proovra.screencapture.ios.segmentReady"
  static let started = "com.proovra.screencapture.ios.started"
  static let finished = "com.proovra.screencapture.ios.finished"
  /// UC-IOS-002 — app → extension. NOT `finished`, which this side observes.
  static let stopRequested = "com.proovra.screencapture.ios.stopRequested"
}

/// UC-STR-001 — THE capture limits (packages/shared/src/capture-limits.ts), by value.
enum ProovraBroadcastLimits {
  static let maxSegments = 199
  static let defaultSegmentMs = 6000
}

struct ProovraScreenSegment {
  let uri: String
  let sequence: Int
  let startedAtOffsetMs: Int
  let durationMs: Int
  let widthPx: Int
  let heightPx: Int
  let orientation: String

  func toJsMap() -> [String: Any] {
    return [
      "uri": uri,
      "sequence": sequence,
      "startedAtOffsetMs": startedAtOffsetMs,
      "durationMs": durationMs,
      "widthPx": widthPx,
      "heightPx": heightPx,
      "orientation": orientation,
    ]
  }
}

struct ProovraBroadcastState {
  let active: Bool
  let segmentCount: Int
  /// UC-IOS-006 — "active" on disk, but no heartbeat for too long: the extension died.
  let stale: Bool
  let startedAtUtc: String?
  let appRequested: Bool
}

struct ProovraBroadcastResult {
  let osConsentGranted: Bool
  let startedAtUtc: String
  let endedAtUtc: String
  let segmentCount: Int
  let totalDurationMs: Int
  let completeness: String // COMPLETE_SESSION | INTERRUPTED_SESSION
  let terminationReason: String
  let limitations: [String]
  /// The display block the extension measured (screenW/screenH/densityDpi/orientation), if it saw a frame.
  let display: [String: Any]?

  /**
   * UC-IOS-001 — THE device block of the continuity manifest, all eight keys:
   * platform/osVersion/model/appVersion from this app, screenW/screenH (native
   * pixels, oriented) + densityDpi (UIScreen scale × 160) + orientation from the
   * extension's first frame, or — when it never saw one — from UIScreen.
   */
  func toJsMap() -> [String: Any] {
    var device: [String: Any] = [
      "platform": "ios",
      "osVersion": UIDevice.current.systemVersion,
      "model": UIDevice.current.model,
      "appVersion": (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "unknown",
    ]
    let screen = ProovraBroadcastResult.screenDisplay()
    for key in ["screenW", "screenH", "densityDpi", "orientation"] {
      device[key] = display?[key] ?? screen[key]
    }
    return [
      "osConsentGranted": osConsentGranted,
      "captureStartedAtUtc": startedAtUtc,
      "captureEndedAtUtc": endedAtUtc,
      "device": device,
      "totalDurationMs": totalDurationMs,
      "segmentCount": segmentCount,
      "sessionCompleteness": completeness,
      "terminationReason": terminationReason,
      "limitations": limitations,
    ]
  }

  static func screenDisplay() -> [String: Any] {
    let bounds = UIScreen.main.nativeBounds // portrait-up, native pixels
    let w = Int(bounds.width.rounded())
    let h = Int(bounds.height.rounded())
    return [
      "screenW": w,
      "screenH": h,
      "densityDpi": Int((UIScreen.main.scale * 160).rounded()),
      "orientation": w >= h ? "landscape" : "portrait",
    ]
  }
}

final class ProovraBroadcastSharedStore {
  private let appGroup: String
  /// A live broadcast rewrites state.json at least this often (extension heartbeat: 5 s).
  static let staleAfterSeconds: TimeInterval = 30
  private var containerURL: URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent("uc5-broadcast", isDirectory: true)
  }

  init(appGroup: String) { self.appGroup = appGroup }

  /**
   * UC-IOS-010 — true when the container still holds a recording nobody staged
   * or discarded (a killed app, or a broadcast started from Control Center).
   * `beginSession` refuses to run over it: un-uploaded segments are never
   * deleted without the user's explicit discard.
   */
  func hasPendingRecording() -> Bool {
    guard let dir = containerURL else { return false }
    let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    return files.contains { $0.hasPrefix("seg-") && $0.hasSuffix(".json") }
  }

  func beginSession(segmentMs: Int, maxSegments: Int) {
    guard let dir = containerURL else { return }
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let state: [String: Any] = [
      "active": false, // the EXTENSION sets active when the broadcast actually starts
      "segmentCount": 0,
      "segmentMs": segmentMs,
      "maxSegments": maxSegments,
      "appRequested": true,
    ]
    writeJson(state, to: dir.appendingPathComponent("state.json"))
  }

  /** UC-IOS-010 — the explicit discard: removes the whole spool. */
  func discardSpool() {
    guard let dir = containerURL else { return }
    try? FileManager.default.removeItem(at: dir)
  }

  func readState() -> ProovraBroadcastState {
    guard let dir = containerURL,
          let obj = readJson(dir.appendingPathComponent("state.json")) else {
      return ProovraBroadcastState(active: false, segmentCount: 0, stale: false, startedAtUtc: nil, appRequested: false)
    }
    let active = (obj["active"] as? Bool) ?? false
    var stale = false
    if active, let last = (obj["lastWriteAtUtc"] as? String).flatMap({ ISO8601DateFormatter().date(from: $0) }) {
      stale = Date().timeIntervalSince(last) > ProovraBroadcastSharedStore.staleAfterSeconds
    }
    return ProovraBroadcastState(
      active: active && !stale,
      segmentCount: (obj["segmentCount"] as? Int) ?? 0,
      stale: stale,
      startedAtUtc: obj["startedAtUtc"] as? String,
      appRequested: (obj["appRequested"] as? Bool) ?? false
    )
  }

  /// Segments with sequence > `after`, in ascending order, whose sidecar exists.
  func readNewSegments(after: Int) -> [ProovraScreenSegment] {
    guard let dir = containerURL else { return [] }
    var out: [ProovraScreenSegment] = []
    var seq = after + 1
    while true {
      let sidecar = dir.appendingPathComponent("seg-\(seq).json")
      let media = dir.appendingPathComponent("seg-\(seq).mp4")
      guard FileManager.default.fileExists(atPath: sidecar.path),
            FileManager.default.fileExists(atPath: media.path),
            let obj = readJson(sidecar),
            let sequence = obj["sequence"] as? Int,
            let offset = obj["startedAtOffsetMs"] as? Int,
            let duration = obj["durationMs"] as? Int,
            let width = obj["widthPx"] as? Int,
            let height = obj["heightPx"] as? Int,
            let orientation = obj["orientation"] as? String else { break }
      out.append(ProovraScreenSegment(
        uri: media.absoluteString,
        sequence: sequence,
        startedAtOffsetMs: offset,
        durationMs: duration,
        widthPx: width,
        heightPx: height,
        orientation: orientation
      ))
      seq += 1
    }
    return out
  }

  /// The result.json the extension wrote, or nil while it has not written one.
  func readWrittenResult() -> ProovraBroadcastResult? {
    guard let dir = containerURL,
          let obj = readJson(dir.appendingPathComponent("result.json")),
          let startedAtUtc = obj["startedAtUtc"] as? String,
          let endedAtUtc = obj["endedAtUtc"] as? String else { return nil }
    return ProovraBroadcastResult(
      osConsentGranted: (obj["osConsentGranted"] as? Bool) ?? false,
      startedAtUtc: startedAtUtc,
      endedAtUtc: endedAtUtc,
      segmentCount: (obj["segmentCount"] as? Int) ?? 0,
      totalDurationMs: (obj["totalDurationMs"] as? Int) ?? 0,
      completeness: (obj["sessionCompleteness"] as? String) ?? "INTERRUPTED_SESSION",
      terminationReason: (obj["terminationReason"] as? String) ?? "UNKNOWN",
      limitations: (obj["limitations"] as? [String]) ?? [],
      display: obj["device"] as? [String: Any]
    )
  }

  /**
   * THE session summary. When result.json is missing (extension killed / jetsam
   * / still running) nothing is fabricated (UC-IOS-006): the start time is the
   * one the extension wrote to state.json, the end and duration come from the
   * last finalised segment, the termination is UNKNOWN, the session is
   * INTERRUPTED with CAPTURE_INTERRUPTED, and consent is claimed only when a
   * segment proves the broadcast ran.
   */
  func readResult() -> ProovraBroadcastResult {
    if let written = readWrittenResult() { return written }
    let state = readState()
    let segments = readNewSegments(after: -1)
    let iso = ISO8601DateFormatter()
    let lastEndMs = segments.map { $0.startedAtOffsetMs + $0.durationMs }.max() ?? 0
    let started = state.startedAtUtc.flatMap { iso.date(from: $0) }
    let startedAtUtc = state.startedAtUtc ?? ""
    let endedAtUtc = started.map { iso.string(from: $0.addingTimeInterval(TimeInterval(lastEndMs) / 1000)) } ?? startedAtUtc
    return ProovraBroadcastResult(
      osConsentGranted: !segments.isEmpty,
      startedAtUtc: startedAtUtc,
      endedAtUtc: endedAtUtc,
      segmentCount: segments.count,
      totalDurationMs: lastEndMs,
      completeness: "INTERRUPTED_SESSION",
      terminationReason: "UNKNOWN",
      limitations: ["CAPTURE_INTERRUPTED"],
      display: nil
    )
  }

  private func writeJson(_ obj: [String: Any], to url: URL) {
    if let data = try? JSONSerialization.data(withJSONObject: obj) { try? data.write(to: url, options: .atomic) }
  }
  private func readJson(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}

/// Presents Apple's system broadcast picker, pre-targeted at our extension.
enum ProovraBroadcastPicker {
  /// Kept alive (hidden, in the key window) while Apple's sheet is up.
  private static var picker: RPSystemBroadcastPickerView?

  static func present(preferredExtensionBundleId: String) -> Bool {
    guard #available(iOS 12.0, *) else { return false }
    picker?.removeFromSuperview()
    let view = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    view.preferredExtension = preferredExtensionBundleId
    view.showsMicrophoneButton = false
    view.isHidden = true
    // UC-IOS-005 — a picker outside the view hierarchy may show nothing at all.
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
    window?.addSubview(view)
    picker = view
    // Programmatically trigger the picker's own button (this shows Apple's system
    // sheet; it does NOT start a broadcast without the user's explicit tap).
    var triggered = false
    for sub in view.subviews {
      if let button = sub as? UIButton {
        button.sendActions(for: .touchUpInside)
        triggered = true
      }
    }
    return triggered
  }

  static func dismiss() {
    picker?.removeFromSuperview()
    picker = nil
  }
}

/**
 * Thin Darwin (cross-process) notification bridge between app and extension.
 *
 * UC-IOS-012 — ONE stable observer identity (this bridge's token object), each
 * name registered at most once, and removal with the SAME token. The previous
 * version passed a fresh NSObject per registration and per removal, so no
 * observer was ever removed and each new session multiplied the callbacks.
 * Handlers are read and written under a lock.
 */
final class ProovraDarwinNotify {
  static let shared = ProovraDarwinNotify()

  private let lock = NSLock()
  private var handlers: [String: () -> Void] = [:]
  private var token: UnsafeRawPointer { UnsafeRawPointer(Unmanaged.passUnretained(self).toOpaque()) }

  static func post(_ name: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(name as CFString), nil, nil, true
    )
  }

  func observe(_ name: String, _ handler: @escaping () -> Void) {
    lock.lock()
    let alreadyRegistered = handlers[name] != nil
    handlers[name] = handler
    lock.unlock()
    guard !alreadyRegistered else { return }
    let cb: CFNotificationCallback = { _, observer, cfName, _, _ in
      guard let observer = observer, let cfName = cfName else { return }
      let bridge = Unmanaged<ProovraDarwinNotify>.fromOpaque(observer).takeUnretainedValue()
      bridge.dispatch(cfName.rawValue as String)
    }
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      token,
      cb, name as CFString, nil, .deliverImmediately
    )
  }

  func removeAll() {
    lock.lock()
    handlers.removeAll()
    lock.unlock()
    CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), token)
  }

  private func dispatch(_ name: String) {
    lock.lock()
    let handler = handlers[name]
    lock.unlock()
    handler?()
  }
}
