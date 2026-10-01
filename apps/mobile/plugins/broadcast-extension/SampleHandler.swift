import ReplayKit
import AVFoundation
import ImageIO
import UIKit

/**
 * UC-5 — PROOVRA iOS Broadcast Upload Extension (writer side).
 *
 * Apple delivers the user-authorised system screen broadcast to this extension as
 * CMSampleBuffers. It encodes the video into BOUNDED ORIGINAL MP4 segments with
 * AVAssetWriter, writes each finalised segment (+ a sidecar of its bounds) into
 * the shared App Group container, and posts a Darwin notification so the main app
 * re-emits it to JS and streams it to the canonical PROOVRA pipeline. It writes a
 * `state.json` (with a heartbeat) while active and a `result.json` on finish.
 * Audio is ignored (screen-only). Nothing is uploaded from here — transport/seal
 * is the app+server. The extension never becomes an Evidence authority.
 *
 * This file is compiled ALONE into the extension target, so the container
 * layout, the Darwin note names and THE capture limits are repeated here BY
 * VALUE; apps/mobile/test/ios-broadcast-contract.test.mjs and
 * capture-limits-native-sync.test.mjs pin them against the app side and
 * packages/shared/src/capture-limits.ts.
 *
 * Remediation (2026-09-30):
 *   UC-IOS-002  the app can STOP the broadcast: a dedicated stop note is observed
 *               here (CFNotificationCenter, one stable observer = self), the final
 *               segment is finalised, result.json written, and the broadcast ends
 *               with finishBroadcastWithError (the only API ReplayKit offers).
 *   UC-IOS-004  ONE clock: every offset and duration comes from presentation
 *               timestamps relative to the session's first frame; a segment ends
 *               where the next begins; the final segment is measured (last PTS −
 *               segment start), never a literal 0.
 *   UC-IOS-001  result.json carries the display device block the manifest needs
 *               (screenW/screenH in native pixels, densityDpi = scale × 160,
 *               orientation), taken from the first frame's oriented geometry.
 *   UC-IOS-005  broadcastStarted writes state.json and posts a `started` note.
 *   UC-IOS-007  AVAssetWriter outcomes are checked: startWriting / append /
 *               finishWriting (and a timeout) — a failed segment is deleted and
 *               recorded as SEGMENT_WRITE_FAILED; a writer failure (e.g. storage
 *               full) ends the broadcast with an explicit reason.
 *   UC-IOS-008  orientation comes from RPVideoSampleOrientationKey per buffer;
 *               the writer input carries the matching transform; a change starts
 *               a new segment and records ORIENTATION_CHANGED_DURING_CAPTURE.
 *   UC-IOS-009  broadcastPaused / broadcastResumed end the current segment and
 *               record BROADCAST_PAUSED (the session is then INTERRUPTED).
 */
class SampleHandler: RPBroadcastSampleHandler {
  // ---- Contract with the app (ProovraBroadcastShared.swift), by value ------
  private static let appGroup = "group.com.jalalattar29.proovra"
  private static let segmentReadyNote = "com.proovra.screencapture.ios.segmentReady"
  private static let startedNote = "com.proovra.screencapture.ios.started"
  private static let finishedNote = "com.proovra.screencapture.ios.finished"
  /// UC-IOS-002 — app → extension. Deliberately NOT the `finished` name the app observes.
  private static let stopRequestNote = "com.proovra.screencapture.ios.stopRequested"
  // ---- UC-STR-001 — THE capture limits (packages/shared/src/capture-limits.ts) ----
  private static let maxSegmentsLimit = 199
  private static let defaultSegmentMs = 6000
  private static let minSegmentMs = 2000
  private static let maxSegmentMsLimit = 30000
  /// Refuse to start a segment with less free space than this (UC-IOS-007).
  private static let minFreeBytes: Int64 = 200 * 1024 * 1024
  private static let heartbeatSeconds = 5

  /// Every state mutation happens on this one queue (sample buffers, the stop
  /// request, pause/resume, the heartbeat).
  private let queue = DispatchQueue(label: "com.proovra.broadcast.writer")
  private var heartbeat: DispatchSourceTimer?

  private var dir: URL?
  private var writer: AVAssetWriter?
  private var videoInput: AVAssetWriterInput?
  private var sequence = 0
  private var segmentMs = SampleHandler.defaultSegmentMs
  private var maxSegments = SampleHandler.maxSegmentsLimit

  // UC-IOS-004 — one clock: presentation timestamps.
  private var sessionFirstPts: CMTime = .invalid
  private var segmentStartPts: CMTime = .invalid
  private var lastPts: CMTime = .invalid
  private var sessionStartDate: Date?

  // UC-IOS-008 — the oriented geometry of the CURRENT segment.
  private var segmentOrientation: CGImagePropertyOrientation = .up
  private var segmentW = 0
  private var segmentH = 0
  private var initialLandscape: Bool?
  private var deviceBlock: [String: Any]?

  private var limitations = Set<String>()
  private var stopped = false
  private var paused = false
  private var observing = false
  private let teardownLock = NSLock()

  // MARK: - Broadcast lifecycle

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    queue.sync {
      dir = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: SampleHandler.appGroup)?
        .appendingPathComponent("uc5-broadcast", isDirectory: true)
      if let dir = dir { try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
      let prior = readJson("state.json")
      if let prior = prior {
        segmentMs = min(max((prior["segmentMs"] as? Int) ?? SampleHandler.defaultSegmentMs, SampleHandler.minSegmentMs),
                        SampleHandler.maxSegmentMsLimit)
        maxSegments = min(max((prior["maxSegments"] as? Int) ?? SampleHandler.maxSegmentsLimit, 1),
                          SampleHandler.maxSegmentsLimit)
      }
      // A broadcast PROOVRA did not request (started from Control Center) is
      // still written, and marked so the app offers it for recovery or discard
      // instead of silently wiping it at the next start (UC-IOS-010).
      let requestedByApp = (prior?["appRequested"] as? Bool) ?? false
      writeState(active: true, extra: ["appRequested": requestedByApp])
    }
    registerStopObserver()
    startHeartbeat()
    SampleHandler.postDarwin(SampleHandler.startedNote)
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    guard sampleBufferType == .video else { return }
    queue.sync { self.handleVideo(sampleBuffer) }
  }

  override func broadcastPaused() {
    queue.sync {
      guard !stopped, !paused else { return }
      paused = true
      // UC-IOS-009 — the paused interval is not recorded; say so.
      limitations.insert("BROADCAST_PAUSED")
      finalizeSegment(endPts: lastPts)
    }
  }

  override func broadcastResumed() {
    queue.sync { paused = false }
  }

  override func broadcastFinished() {
    queue.sync {
      guard !stopped else { return }
      stopped = true
      finalizeSegment(endPts: lastPts)
      writeResult(reason: "USER_STOPPED")
    }
    tearDown()
  }

  deinit {
    tearDown()
  }

  // MARK: - Stop from the app (UC-IOS-002)

  private func registerStopObserver() {
    guard !observing else { return }
    observing = true
    let callback: CFNotificationCallback = { _, observer, _, _, _ in
      guard let observer = observer else { return }
      let handler = Unmanaged<SampleHandler>.fromOpaque(observer).takeUnretainedValue()
      handler.stopRequestedByApp()
    }
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      callback,
      SampleHandler.stopRequestNote as CFString,
      nil,
      .deliverImmediately
    )
  }

  private func tearDown() {
    teardownLock.lock()
    defer { teardownLock.unlock() }
    heartbeat?.cancel()
    heartbeat = nil
    guard observing else { return }
    observing = false
    CFNotificationCenterRemoveObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      CFNotificationName(SampleHandler.stopRequestNote as CFString),
      nil
    )
  }

  private func stopRequestedByApp() {
    var shouldFinish = false
    queue.sync {
      guard !stopped else { return }
      stopped = true
      finalizeSegment(endPts: lastPts)
      writeResult(reason: "USER_STOPPED")
      shouldFinish = true
    }
    guard shouldFinish else { return }
    tearDown()
    finish(message: "You stopped the recording in PROOVRA. Return to PROOVRA to review it.")
  }

  // MARK: - Frames

  private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
    guard !stopped, !paused, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let orientation = SampleHandler.orientation(of: sampleBuffer)
    let rawW = CVPixelBufferGetWidth(pixelBuffer)
    let rawH = CVPixelBufferGetHeight(pixelBuffer)
    let rotated = orientation == .left || orientation == .right || orientation == .leftMirrored || orientation == .rightMirrored
    let orientedW = rotated ? rawH : rawW
    let orientedH = rotated ? rawW : rawH

    if !sessionFirstPts.isValid {
      sessionFirstPts = pts
      sessionStartDate = Date()
      initialLandscape = orientedW >= orientedH
      deviceBlock = SampleHandler.displayDevice(orientedW: orientedW, orientedH: orientedH)
    }

    // A segment ends where the next begins: rotate BEFORE appending (UC-IOS-004),
    // on the requested duration or on an orientation change (UC-IOS-008).
    if writer != nil {
      let elapsedMs = SampleHandler.ms(CMTimeSubtract(pts, segmentStartPts))
      let orientationChanged = orientation != segmentOrientation
      if elapsedMs >= segmentMs || orientationChanged {
        finalizeSegment(endPts: pts)
        if sequence >= maxSegments {
          limitations.insert("SESSION_BOUNDS_REACHED")
          stopped = true
          writeResult(reason: "BOUNDS_REACHED")
          DispatchQueue.global().async {
            self.tearDown()
            self.finish(message: "PROOVRA reached the recording limit. Return to PROOVRA to review it.")
          }
          return
        }
      }
    }

    if writer == nil {
      guard startSegment(at: pts, orientation: orientation, rawW: rawW, rawH: rawH,
                         orientedW: orientedW, orientedH: orientedH) else { return }
    }

    lastPts = pts
    guard let input = videoInput, input.isReadyForMoreMediaData else { return }
    if !input.append(sampleBuffer) {
      // UC-IOS-007 — a failed append on a failed writer is a stalled recording.
      if writer?.status == .failed { failWriter() }
    }
  }

  // MARK: - Segment writing

  private func startSegment(at pts: CMTime, orientation: CGImagePropertyOrientation,
                            rawW: Int, rawH: Int, orientedW: Int, orientedH: Int) -> Bool {
    guard let dir = dir else { return false }
    // UC-IOS-007 — never start a segment the device cannot hold.
    if let free = try? dir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        .volumeAvailableCapacityForImportantUsage, free < SampleHandler.minFreeBytes {
      failWriter(storage: true)
      return false
    }
    let url = dir.appendingPathComponent("seg-\(sequence).mp4")
    try? FileManager.default.removeItem(at: url)
    guard let w = try? AVAssetWriter(outputURL: url, fileType: .mp4) else {
      failWriter()
      return false
    }
    let settings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: rawW,
      AVVideoHeightKey: rawH,
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = true
    // UC-IOS-008 — the buffer stays in native layout; the track's transform
    // presents it upright, and the sidecar states the ORIENTED geometry.
    input.transform = SampleHandler.transform(for: orientation)
    guard w.canAdd(input) else { failWriter(); return false }
    w.add(input)
    guard w.startWriting() else { failWriter(); return false }
    w.startSession(atSourceTime: pts)
    writer = w
    videoInput = input
    segmentStartPts = pts
    segmentOrientation = orientation
    segmentW = orientedW
    segmentH = orientedH
    if let initial = initialLandscape, initial != (orientedW >= orientedH) {
      limitations.insert("ORIENTATION_CHANGED_DURING_CAPTURE")
    }
    return true
  }

  /// Finish the current segment at `endPts` (the next segment's first frame, or
  /// the last appended frame when the session ends). Publishes it ONLY when the
  /// writer completed (UC-IOS-007).
  private func finalizeSegment(endPts: CMTime) {
    guard let writer = writer, let dir = dir else { return }
    let seq = sequence
    let startPts = segmentStartPts
    let end = endPts.isValid ? endPts : startPts
    let durationMs = max(0, SampleHandler.ms(CMTimeSubtract(end, startPts)))
    let offsetMs = max(0, SampleHandler.ms(CMTimeSubtract(startPts, sessionFirstPts)))
    self.writer = nil
    self.videoInput?.markAsFinished()
    self.videoInput = nil

    let group = DispatchGroup()
    group.enter()
    if end.isValid && CMTimeCompare(end, startPts) > 0 { writer.endSession(atSourceTime: end) }
    writer.finishWriting { group.leave() }
    let waited = group.wait(timeout: .now() + 5)
    let mp4 = dir.appendingPathComponent("seg-\(seq).mp4")
    guard waited == .success, writer.status == .completed else {
      // Unplayable or unfinished: never published as an ORIGINAL segment.
      if writer.status == .writing { writer.cancelWriting() }
      try? FileManager.default.removeItem(at: mp4)
      limitations.insert("SEGMENT_WRITE_FAILED")
      writeState(active: !stopped)
      return
    }
    let sidecar: [String: Any] = [
      "sequence": seq,
      "startedAtOffsetMs": offsetMs,
      "durationMs": durationMs,
      "widthPx": segmentW,
      "heightPx": segmentH,
      "orientation": segmentW >= segmentH ? "landscape" : "portrait",
    ]
    writeJson(sidecar, "seg-\(seq).json")
    sequence += 1
    writeState(active: !stopped)
    SampleHandler.postDarwin(SampleHandler.segmentReadyNote)
  }

  /// UC-IOS-007 — the writer failed (storage full, encoder error): stop with a reason.
  private func failWriter(storage: Bool = false) {
    guard !stopped else { return }
    stopped = true
    if let writer = writer {
      if writer.status == .writing { writer.cancelWriting() }
      if let dir = dir { try? FileManager.default.removeItem(at: dir.appendingPathComponent("seg-\(sequence).mp4")) }
    }
    writer = nil
    videoInput = nil
    limitations.insert("SEGMENT_WRITE_FAILED")
    writeResult(reason: "ERROR")
    let message = storage
      ? "PROOVRA stopped recording because this device is running out of storage. The segments saved so far are kept — return to PROOVRA to review them."
      : "PROOVRA could not save the recording. The segments saved so far are kept — return to PROOVRA to review them."
    DispatchQueue.global().async {
      self.tearDown()
      self.finish(message: message)
    }
  }

  private func finish(message: String) {
    let error = NSError(
      domain: "com.proovra.broadcast",
      code: 0,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
    finishBroadcastWithError(error)
  }

  // MARK: - result.json / state.json

  private static let incompleteLimitations: Set<String> = [
    "CAPTURE_INTERRUPTED", "SEGMENT_UPLOAD_LOST", "SEGMENT_WRITE_FAILED", "BROADCAST_PAUSED",
  ]

  private func writeResult(reason: String) {
    let iso = ISO8601DateFormatter()
    let cleanEnd = reason == "USER_STOPPED" || reason == "BOUNDS_REACHED"
    if !cleanEnd { limitations.insert("CAPTURE_INTERRUPTED") }
    let complete = cleanEnd && sequence > 0 && limitations.isDisjoint(with: SampleHandler.incompleteLimitations)
    let totalMs = (sessionFirstPts.isValid && lastPts.isValid)
      ? max(0, SampleHandler.ms(CMTimeSubtract(lastPts, sessionFirstPts))) : 0
    var result: [String: Any] = [
      "osConsentGranted": sessionFirstPts.isValid,
      "endedAtUtc": iso.string(from: Date()),
      "segmentCount": sequence,
      "totalDurationMs": totalMs,
      "sessionCompleteness": complete ? "COMPLETE_SESSION" : "INTERRUPTED_SESSION",
      "terminationReason": reason,
      "limitations": Array(limitations).sorted(),
    ]
    if let start = sessionStartDate { result["startedAtUtc"] = iso.string(from: start) }
    if let device = deviceBlock { result["device"] = device }
    writeJson(result, "result.json")
    writeState(active: false)
    SampleHandler.postDarwin(SampleHandler.finishedNote)
  }

  private func writeState(active: Bool, extra: [String: Any] = [:]) {
    let iso = ISO8601DateFormatter()
    var state = readJson("state.json") ?? [:]
    state["active"] = active
    state["segmentCount"] = sequence
    state["segmentMs"] = segmentMs
    state["maxSegments"] = maxSegments
    state["lastWriteAtUtc"] = iso.string(from: Date())
    if let start = sessionStartDate { state["startedAtUtc"] = iso.string(from: start) }
    for (k, v) in extra { state[k] = v }
    writeJson(state, "state.json")
  }

  /// UC-IOS-006 — lets the app tell a live broadcast from a killed one.
  private func startHeartbeat() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + .seconds(SampleHandler.heartbeatSeconds),
                   repeating: .seconds(SampleHandler.heartbeatSeconds))
    timer.setEventHandler { [weak self] in
      guard let self = self, !self.stopped else { return }
      self.writeState(active: true)
    }
    timer.resume()
    heartbeat = timer
  }

  // MARK: - Geometry, time, IO

  /// UC-IOS-001 — the display block, from the first frame's ORIENTED geometry.
  /// densityDpi = UIScreen scale × 160: the Android-equivalent logical density
  /// (iOS does not expose the panel's physical PPI).
  private static func displayDevice(orientedW: Int, orientedH: Int) -> [String: Any] {
    return [
      "screenW": orientedW,
      "screenH": orientedH,
      "densityDpi": Int((UIScreen.main.scale * 160).rounded()),
      "orientation": orientedW >= orientedH ? "landscape" : "portrait",
    ]
  }

  private static func orientation(of sampleBuffer: CMSampleBuffer) -> CGImagePropertyOrientation {
    guard let raw = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil)
            as? NSNumber,
          let value = CGImagePropertyOrientation(rawValue: raw.uint32Value) else { return .up }
    return value
  }

  private static func transform(for orientation: CGImagePropertyOrientation) -> CGAffineTransform {
    switch orientation {
    case .left, .leftMirrored: return CGAffineTransform(rotationAngle: .pi / 2)
    case .right, .rightMirrored: return CGAffineTransform(rotationAngle: -.pi / 2)
    case .down, .downMirrored: return CGAffineTransform(rotationAngle: .pi)
    default: return .identity
    }
  }

  private static func ms(_ t: CMTime) -> Int {
    guard t.isValid, !t.isIndefinite else { return 0 }
    return Int((CMTimeGetSeconds(t) * 1000).rounded())
  }

  private func readJson(_ name: String) -> [String: Any]? {
    guard let dir = dir, let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
  private func writeJson(_ obj: [String: Any], _ name: String) {
    guard let dir = dir, let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    try? data.write(to: dir.appendingPathComponent(name), options: .atomic)
  }
  private static func postDarwin(_ name: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(name as CFString), nil, nil, true)
  }
}
