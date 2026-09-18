import ReplayKit
import AVFoundation

/**
 * UC-5 — PROOVRA iOS Broadcast Upload Extension (writer side).
 *
 * Apple delivers the user-authorised system screen broadcast to this extension as
 * CMSampleBuffers. It encodes the video into BOUNDED ORIGINAL MP4 segments with
 * AVAssetWriter, writes each finalised segment (+ a sidecar of its bounds) into
 * the shared App Group container, and posts a Darwin notification so the main app
 * re-emits it to JS and streams it to the canonical PROOVRA pipeline. It writes a
 * `state.json` while active and a `result.json` on finish. Audio is ignored
 * (screen-only). Nothing is uploaded from here — transport/seal is the app+server.
 *
 * Bounds (segment duration, max segments) are read from `state.json` written by
 * the app when it began the session, so the extension honours the same limits the
 * client requested. The extension never becomes an Evidence authority.
 */
class SampleHandler: RPBroadcastSampleHandler {
  private static let appGroup = "group.com.jalalattar29.proovra"
  private static let segmentReadyNote = "com.proovra.screencapture.ios.segmentReady"

  private var dir: URL?
  private var writer: AVAssetWriter?
  private var videoInput: AVAssetWriterInput?
  private var sequence = 0
  private var segmentStartPts: CMTime = .zero
  private var sessionStart: Date = Date()
  private var segmentMs = 6000
  private var maxSegments = 600
  private var width = 0
  private var height = 0
  private var stopped = false

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    dir = FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: SampleHandler.appGroup)?
      .appendingPathComponent("uc5-broadcast", isDirectory: true)
    if let dir = dir { try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    if let state = readJson("state.json") {
      segmentMs = (state["segmentMs"] as? Int) ?? 6000
      maxSegments = (state["maxSegments"] as? Int) ?? 600
    }
    sessionStart = Date()
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    guard sampleBufferType == .video, !stopped else { return }
    guard let fmt = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
    let dims = CMVideoFormatDescriptionGetDimensions(fmt)
    if width == 0 { width = Int(dims.width); height = Int(dims.height) }

    if writer == nil { startSegment() }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if segmentStartPts == .zero { segmentStartPts = pts; writer?.startSession(atSourceTime: pts) }

    if let input = videoInput, input.isReadyForMoreMediaData {
      input.append(sampleBuffer)
    }

    // Rotate the segment once it reaches the requested duration.
    let elapsedMs = Int(CMTimeGetSeconds(CMTimeSubtract(pts, segmentStartPts)) * 1000)
    if elapsedMs >= segmentMs {
      finalizeSegment(durationMs: elapsedMs)
      if sequence >= maxSegments { finishBroadcastWithError(nil) }
    }
  }

  override func broadcastFinished() {
    stopped = true
    finalizeSegment(durationMs: 0, force: true)
    writeResult(reason: "USER_STOPPED", completeness: "COMPLETE_SESSION")
  }

  // MARK: - Segment writing

  private func startSegment() {
    guard let dir = dir else { return }
    let url = dir.appendingPathComponent("seg-\(sequence).mp4")
    try? FileManager.default.removeItem(at: url)
    guard let w = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return }
    let settings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = true
    if w.canAdd(input) { w.add(input) }
    w.startWriting()
    writer = w
    videoInput = input
    segmentStartPts = .zero
  }

  private func finalizeSegment(durationMs: Int, force: Bool = false) {
    guard let writer = writer, let dir = dir else { return }
    if writer.status != .writing && !force { return }
    let seq = sequence
    videoInput?.markAsFinished()
    let offsetMs = Int(Date().timeIntervalSince(sessionStart) * 1000) - durationMs
    let group = DispatchGroup(); group.enter()
    writer.finishWriting { group.leave() }
    _ = group.wait(timeout: .now() + 5)
    let sidecar: [String: Any] = [
      "sequence": seq, "startedAtOffsetMs": max(0, offsetMs), "durationMs": durationMs,
      "widthPx": width, "heightPx": height,
      "orientation": width >= height ? "landscape" : "portrait",
    ]
    writeJson(sidecar, "seg-\(seq).json")
    writeJson(["active": true, "segmentCount": seq + 1,
               "startedAtUtc": ISO8601DateFormatter().string(from: sessionStart),
               "segmentMs": segmentMs, "maxSegments": maxSegments], "state.json")
    self.writer = nil; self.videoInput = nil
    sequence += 1
    SampleHandler.postDarwin(SampleHandler.segmentReadyNote)
  }

  private func writeResult(reason: String, completeness: String) {
    let now = ISO8601DateFormatter()
    writeJson([
      "osConsentGranted": true,
      "startedAtUtc": now.string(from: sessionStart),
      "endedAtUtc": now.string(from: Date()),
      "segmentCount": sequence,
      "totalDurationMs": Int(Date().timeIntervalSince(sessionStart) * 1000),
      "sessionCompleteness": completeness,
      "terminationReason": reason,
      "limitations": [] as [String],
    ], "result.json")
    writeJson(["active": false, "segmentCount": sequence], "state.json")
    SampleHandler.postDarwin("com.proovra.screencapture.ios.finished")
  }

  // MARK: - App Group IO + Darwin

  private func readJson(_ name: String) -> [String: Any]? {
    guard let dir = dir, let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
  private func writeJson(_ obj: [String: Any], _ name: String) {
    guard let dir = dir, let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    try? data.write(to: dir.appendingPathComponent(name))
  }
  private static func postDarwin(_ name: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(name as CFString), nil, nil, true)
  }
}
