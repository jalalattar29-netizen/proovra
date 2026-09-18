import Foundation
import ReplayKit

/**
 * Main-app side helpers for the UC-5 iOS broadcast pipeline: read the segment
 * files the Broadcast Upload Extension writes into the shared App Group
 * container, present Apple's system broadcast picker, and bridge Darwin
 * notifications. The extension is the WRITER; this side is the READER. The file
 * layout under the container's `uc5-broadcast/` directory is the contract:
 *   - state.json      { active, segmentCount, startedAtUtc, segmentMs, maxSegments }
 *   - result.json     the ScreenContinuousResult-shaped session summary (on stop)
 *   - seg-<n>.mp4     ordered ORIGINAL segments (n = 0,1,2,…)
 *   - seg-<n>.json    { sequence, startedAtOffsetMs, durationMs, widthPx, heightPx, orientation }
 */

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

  func toJsMap() -> [String: Any] {
    return [
      "osConsentGranted": osConsentGranted,
      "captureStartedAtUtc": startedAtUtc,
      "captureEndedAtUtc": endedAtUtc,
      "device": [
        "platform": "ios",
        "osVersion": UIDevice.current.systemVersion,
        "model": UIDevice.current.model,
        "appVersion": (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "",
      ],
      "totalDurationMs": totalDurationMs,
      "segmentCount": segmentCount,
      "sessionCompleteness": completeness,
      "terminationReason": terminationReason,
      "limitations": limitations,
    ]
  }
}

final class ProovraBroadcastSharedStore {
  private let appGroup: String
  private var containerURL: URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent("uc5-broadcast", isDirectory: true)
  }

  init(appGroup: String) { self.appGroup = appGroup }

  func beginSession(segmentMs: Int, maxSegments: Int) {
    guard let dir = containerURL else { return }
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let state: [String: Any] = [
      "active": true,
      "segmentCount": 0,
      "startedAtUtc": ISO8601DateFormatter().string(from: Date()),
      "segmentMs": segmentMs,
      "maxSegments": maxSegments,
    ]
    writeJson(state, to: dir.appendingPathComponent("state.json"))
  }

  func readState() -> ProovraBroadcastState {
    guard let dir = containerURL,
          let obj = readJson(dir.appendingPathComponent("state.json")) else {
      return ProovraBroadcastState(active: false, segmentCount: 0)
    }
    return ProovraBroadcastState(
      active: (obj["active"] as? Bool) ?? false,
      segmentCount: (obj["segmentCount"] as? Int) ?? 0
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
            let obj = readJson(sidecar) else { break }
      out.append(ProovraScreenSegment(
        uri: media.absoluteString,
        sequence: (obj["sequence"] as? Int) ?? seq,
        startedAtOffsetMs: (obj["startedAtOffsetMs"] as? Int) ?? 0,
        durationMs: (obj["durationMs"] as? Int) ?? 0,
        widthPx: (obj["widthPx"] as? Int) ?? 0,
        heightPx: (obj["heightPx"] as? Int) ?? 0,
        orientation: (obj["orientation"] as? String) ?? "portrait"
      ))
      seq += 1
    }
    return out
  }

  func readResult() -> ProovraBroadcastResult {
    let now = ISO8601DateFormatter().string(from: Date())
    guard let dir = containerURL,
          let obj = readJson(dir.appendingPathComponent("result.json")) else {
      // No result file → the session was interrupted before a clean finish.
      let count = readState().segmentCount
      return ProovraBroadcastResult(
        osConsentGranted: true, startedAtUtc: now, endedAtUtc: now, segmentCount: count,
        totalDurationMs: 0, completeness: "INTERRUPTED_SESSION",
        terminationReason: "INTERRUPTED", limitations: []
      )
    }
    return ProovraBroadcastResult(
      osConsentGranted: (obj["osConsentGranted"] as? Bool) ?? true,
      startedAtUtc: (obj["startedAtUtc"] as? String) ?? now,
      endedAtUtc: (obj["endedAtUtc"] as? String) ?? now,
      segmentCount: (obj["segmentCount"] as? Int) ?? 0,
      totalDurationMs: (obj["totalDurationMs"] as? Int) ?? 0,
      completeness: (obj["sessionCompleteness"] as? String) ?? "COMPLETE_SESSION",
      terminationReason: (obj["terminationReason"] as? String) ?? "USER_STOPPED",
      limitations: (obj["limitations"] as? [String]) ?? []
    )
  }

  private func writeJson(_ obj: [String: Any], to url: URL) {
    if let data = try? JSONSerialization.data(withJSONObject: obj) { try? data.write(to: url) }
  }
  private func readJson(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}

/// Presents Apple's system broadcast picker, pre-targeted at our extension.
enum ProovraBroadcastPicker {
  static func present(preferredExtensionBundleId: String) {
    guard #available(iOS 12.0, *) else { return }
    let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 60, height: 60))
    picker.preferredExtension = preferredExtensionBundleId
    picker.showsMicrophoneButton = false
    // Programmatically trigger the picker's own button (this shows Apple's system
    // sheet; it does NOT start a broadcast without the user's explicit tap).
    for sub in picker.subviews {
      if let button = sub as? UIButton {
        button.sendActions(for: .touchUpInside)
      }
    }
  }
}

/// Thin Darwin (cross-process) notification bridge between app and extension.
enum ProovraDarwinNotify {
  private static var handlers: [String: () -> Void] = [:]

  static func post(_ name: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(name as CFString), nil, nil, true
    )
  }

  static func observe(_ name: String, _ handler: @escaping () -> Void) {
    handlers[name] = handler
    let cb: CFNotificationCallback = { _, _, cfName, _, _ in
      guard let cfName = cfName else { return }
      ProovraDarwinNotify.handlers[cfName.rawValue as String]?()
    }
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(NSObject()).toOpaque(),
      cb, name as CFString, nil, .deliverImmediately
    )
  }

  static func removeAll() {
    handlers.removeAll()
    CFNotificationCenterRemoveEveryObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(NSObject()).toOpaque()
    )
  }
}
