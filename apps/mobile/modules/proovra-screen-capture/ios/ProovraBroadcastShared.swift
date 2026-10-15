import Foundation
import ReplayKit
import UIKit

/**
 * Main-app side helpers for the UC-5 iOS broadcast pipeline: read the segment
 * files the Broadcast Upload Extension writes into the shared App Group
 * container, present Apple's system broadcast picker, and bridge Darwin
 * notifications. The extension is the WRITER; this side is the READER.
 *
 * AUD-006 — the container layout (one namespace per broadcast, the binding the
 * app writes before it shows the picker, the monotonic heartbeat) is owned by
 * ProovraBroadcastSpool.swift, which the extension compiles too:
 *   uc5-broadcast/pending-binding.json
 *   uc5-broadcast/<recordingId>/{binding.json, state.json, seg-<n>.mp4|json, result.json}
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

struct ProovraBroadcastState {
  let active: Bool
  let segmentCount: Int
  /// UC-IOS-006 — "active" on disk, but no heartbeat for too long: the extension died.
  let stale: Bool
  let startedAtUtc: String?
  /// AUD-006 — whose recording this is: the namespace, how it was bound, and
  /// which capture session (if any) the app recorded on it.
  let recordingId: String?
  let binding: String // BOUND | UNBOUND | NONE
  let appRequested: Bool
  let captureSessionId: String?
  /// The broadcast running right now, which may be ANOTHER recording.
  let liveRecordingId: String?

  func toJsMap() -> [String: Any] {
    return [
      "active": active,
      "segmentCount": segmentCount,
      "stale": stale,
      "recordingId": ProovraBroadcastSpool.jsonValue(recordingId),
      "binding": binding,
      "appRequested": appRequested,
      "captureSessionId": ProovraBroadcastSpool.jsonValue(captureSessionId),
      "liveRecordingId": ProovraBroadcastSpool.jsonValue(liveRecordingId),
    ]
  }
}

struct ProovraBroadcastResult {
  /// AUD-006 — the recording this summary belongs to (nil: no broadcast ever started).
  let recordingId: String?
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
      "recordingId": ProovraBroadcastSpool.jsonValue(recordingId),
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

/**
 * The app's view of the spool (ProovraBroadcastSpool.swift owns the layout).
 * Every read names ONE recording: segments, state and result never mix two
 * broadcasts.
 */
final class ProovraBroadcastSharedStore {
  private let appGroup: String
  /// A live broadcast heartbeats at least this often (extension heartbeat: 5 s).
  static let staleAfterSeconds: TimeInterval = ProovraBroadcastSpool.staleAfterSeconds

  init(appGroup: String) { self.appGroup = appGroup }

  private var spool: ProovraBroadcastSpool? {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
    return ProovraBroadcastSpool(root: ProovraBroadcastSpool.rootURL(inContainer: container))
  }

  /// The monotonic clock app and extension share within one boot.
  static func nowUptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

  /**
   * AUD-006 — the binding the extension adopts, written BEFORE Apple's picker is
   * shown. No capture session exists yet (one is opened only once the broadcast
   * really started, UC-IOS-005); the app records it later with bindCaptureSession.
   */
  func prepareRecording(segmentMs: Int, maxSegments: Int) -> String? {
    guard let spool = spool else { return nil }
    let recordingId = UUID().uuidString
    let binding = ProovraBroadcastBinding(
      recordingId: recordingId,
      captureSessionId: nil,
      appRequested: true,
      createdAtUtc: ISO8601DateFormatter().string(from: Date()),
      createdAtUptime: ProovraBroadcastSharedStore.nowUptime(),
      segmentMs: segmentMs,
      maxSegments: maxSegments
    )
    return spool.writePendingBinding(binding) ? recordingId : nil
  }

  /// The picker was cancelled or timed out: no later broadcast may adopt the binding.
  func withdrawPendingBinding(recordingId: String) {
    spool?.withdrawPendingBinding(recordingId: recordingId)
  }

  func recordingExists(_ recordingId: String) -> Bool {
    return spool?.recording(recordingId) != nil
  }

  /**
   * UC-IOS-010 — true when a recording that is not running still holds segments
   * nobody staged or discarded (a killed app, or a broadcast started from
   * Control Center). Nothing is deleted without the user's explicit discard.
   */
  func hasPendingRecording() -> Bool {
    return !(spool?.recoverable(nowUptime: ProovraBroadcastSharedStore.nowUptime()).isEmpty ?? true)
  }

  func liveRecordingId() -> String? {
    return spool?.liveRecordingId(nowUptime: ProovraBroadcastSharedStore.nowUptime())
  }

  /// The state of `recordingId`, or — when nil — of the broadcast running now.
  func readState(recordingId: String?) -> ProovraBroadcastState {
    let now = ProovraBroadcastSharedStore.nowUptime()
    let live = spool?.liveRecordingId(nowUptime: now)
    guard let spool = spool, let id = recordingId ?? live, let rec = spool.recording(id) else {
      return ProovraBroadcastState(active: false, segmentCount: 0, stale: false, startedAtUtc: nil,
                                   recordingId: nil, binding: "NONE", appRequested: false,
                                   captureSessionId: nil, liveRecordingId: live)
    }
    let state = spool.readState(id)
    let liveness = spool.liveness(id, nowUptime: now)
    return ProovraBroadcastState(
      active: liveness.active,
      segmentCount: (state?["segmentCount"] as? Int) ?? 0,
      stale: liveness.stale,
      startedAtUtc: state?["startedAtUtc"] as? String,
      recordingId: id,
      binding: rec.binding.rawValue,
      appRequested: rec.appRequested,
      captureSessionId: rec.captureSessionId,
      liveRecordingId: live
    )
  }

  func bindCaptureSession(recordingId: String, captureSessionId: String) -> ProovraBroadcastSessionBindOutcome {
    guard let spool = spool else { return .missing }
    return spool.bindCaptureSession(recordingId: recordingId, captureSessionId: captureSessionId)
  }

  /// Recordings on this device, for explicit recovery or discard.
  func listRecordings() -> [ProovraBroadcastRecordingSummary] {
    return spool?.summaries(nowUptime: ProovraBroadcastSharedStore.nowUptime()) ?? []
  }

  /** UC-IOS-010 — the explicit discard of ONE recording. */
  func discard(recordingId: String) {
    spool?.withdrawPendingBinding(recordingId: recordingId)
    spool?.discard(recordingId: recordingId)
  }

  /// Segments of `recordingId` with sequence > `after`, in ascending order.
  func readNewSegments(recordingId: String, after: Int) -> [ProovraScreenSegment] {
    return spool?.segments(recordingId, after: after) ?? []
  }

  /// The result.json the extension wrote for THIS recording, or nil while it has none.
  func readWrittenResult(recordingId: String) -> ProovraBroadcastResult? {
    guard let obj = spool?.readResult(recordingId),
          let startedAtUtc = obj["startedAtUtc"] as? String,
          let endedAtUtc = obj["endedAtUtc"] as? String else { return nil }
    return ProovraBroadcastResult(
      recordingId: recordingId,
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
   * THE session summary of one recording. When result.json is missing
   * (extension killed / jetsam / still running) nothing is fabricated
   * (UC-IOS-006): the start time is the one the extension wrote to state.json,
   * the end and duration come from the last finalised segment, the termination
   * is UNKNOWN, the session is INTERRUPTED with CAPTURE_INTERRUPTED, and consent
   * is claimed only when a segment proves the broadcast ran.
   */
  func readResult(recordingId: String?) -> ProovraBroadcastResult {
    if let id = recordingId, let written = readWrittenResult(recordingId: id) { return written }
    let state = recordingId.map { readState(recordingId: $0) }
    let segments = recordingId.map { readNewSegments(recordingId: $0, after: -1) } ?? []
    let iso = ISO8601DateFormatter()
    let lastEndMs = segments.map { $0.startedAtOffsetMs + $0.durationMs }.max() ?? 0
    let started = state?.startedAtUtc.flatMap { iso.date(from: $0) }
    let startedAtUtc = state?.startedAtUtc ?? ""
    let endedAtUtc = started.map { iso.string(from: $0.addingTimeInterval(TimeInterval(lastEndMs) / 1000)) } ?? startedAtUtc
    return ProovraBroadcastResult(
      recordingId: state?.recordingId,
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
