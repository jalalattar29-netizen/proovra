import ReplayKit
import AVFoundation
import ImageIO
import UIKit

/**
 * UC-5 — PROOVRA iOS Broadcast Upload Extension (writer side).
 *
 * Apple delivers the user-authorised system screen broadcast to this extension as
 * CMSampleBuffers. It encodes ONE Start→Stop broadcast into ONE MP4 with ONE
 * AVAssetWriter (layout SINGLE_FILE, wire contracts A/B), writes the recording's
 * sidecar (recording.json) and the session summary (result.json) into the
 * shared App Group container, and posts Darwin notifications so the main app
 * returns it to JS and streams it to the canonical PROOVRA pipeline. It writes a
 * `state.json` (with a heartbeat) while active. Nothing is uploaded from here —
 * transport/seal is the app+server. The extension never becomes an Evidence
 * authority.
 *
 * This file is compiled with ProovraBroadcastSpool.swift only, so the note
 * names and THE capture limits are repeated here BY VALUE;
 * apps/mobile/test/ios-broadcast-contract.test.mjs and
 * capture-limits-native-sync.test.mjs pin them against the app side and
 * packages/shared/src/capture-limits.ts.
 *
 * One recording (2026-10-29) — it used to roll a new writer every segmentMs and
 * on every orientation change (real gaps between files), dropped all audio and
 * silently skipped frames the writer was not ready for. Now:
 *   - ONE writer per broadcast, `.mp4` with `movieFragmentInterval` = 2 s and a
 *     key frame at least every 2 s: a killed extension leaves a file playable up
 *     to its last fragment (reported finalized=false, never as complete).
 *   - The canvas is the first buffer's geometry, fixed for the whole file. An
 *     orientation change is RECORDED (orientationTimeline +
 *     ORIENTATION_CHANGED_DURING_CAPTURE), never a new file. ReplayKit keeps the
 *     buffer in the panel's native layout and states the rotation per buffer;
 *     the track carries the INITIAL orientation's transform. A buffer whose pixel
 *     size differs from the canvas is REFUSED and counted (droppedFrameCount +
 *     FRAMES_DROPPED): scaling it into the canvas would need a second pixel
 *     buffer pool and a CIContext inside the extension's ~50 MB memory budget,
 *     which risks jetsam killing the whole recording to save a few frames.
 *   - Every frame the writer refuses (not ready, failed append) is counted in
 *     droppedFrameCount; nothing is skipped silently.
 *   - Pause/resume: the writer keeps running; each pause is recorded on the PTS
 *     timeline (`pauses`, BROADCAST_PAUSED). The gap stays a gap — never filled.
 *   - Audio: `.audioApp` and `.audioMic` go to their own AAC inputs and are
 *     appended only when ReplayKit actually delivers them (the microphone only
 *     when the user turned it on in Apple's picker). `audioTracks` lists the
 *     tracks that received samples; none ⇒ AUDIO_NOT_CAPTURED.
 *   - Session bounds (duration, bytes, the 200 MB free-space floor) FINISH the
 *     file and end the broadcast with BOUNDS_REACHED + SESSION_BOUNDS_REACHED —
 *     never split.
 *
 * Kept from the 2026-09-30 remediation: the app can STOP the broadcast through
 * a dedicated Darwin note (UC-IOS-002); one PTS clock (UC-IOS-004); the device
 * block from the first frame (UC-IOS-001); `started` note + state.json
 * (UC-IOS-005); every writer outcome checked (UC-IOS-007); orientation from
 * RPVideoSampleOrientationKey (UC-IOS-008).
 *
 * AUD-006 (2026-10-15): every broadcast writes into its OWN namespace
 * (ProovraBroadcastSpool.swift, compiled into this target by the config plugin):
 * it adopts the app's fresh pending binding atomically, or — started from
 * Control Center, or over a stale binding — opens an UNBOUND recording the app
 * never attaches to a capture session. A written recording is never
 * overwritten; recording.json and result.json are written once and name the
 * recording; liveness is a monotonic heartbeat.
 */
class SampleHandler: RPBroadcastSampleHandler {
  // ---- Contract with the app (ProovraBroadcastShared.swift), by value ------
  private static let appGroup = "group.com.jalalattar29.proovra"
  private static let startedNote = "com.proovra.screencapture.ios.started"
  private static let finishedNote = "com.proovra.screencapture.ios.finished"
  /// UC-IOS-002 — app → extension. Deliberately NOT the `finished` name the app observes.
  private static let stopRequestNote = "com.proovra.screencapture.ios.stopRequested"
  // ---- UC-STR-001 — THE capture limits (packages/shared/src/capture-limits.ts) ----
  // The segment values are only the binding's legacy fields, echoed in
  // state.json for older readers: this extension records ONE file.
  private static let maxSegmentsLimit = 199
  private static let defaultSegmentMs = 6000
  private static let minSegmentMs = 2000
  private static let maxSegmentMsLimit = 30000
  /// THE session bounds of the one recording file (maxContinuousSessionMs / Bytes).
  private static let maxSessionMs = 50 * 60 * 1000
  private static let maxSessionBytes: Int64 = 512 * 1024 * 1024
  /// The byte bound is checked on the heartbeat: stop this far below it.
  private static let sessionBytesMargin: Int64 = 16 * 1024 * 1024
  /// Never record on with less free space than this (UC-IOS-007).
  private static let minFreeBytes: Int64 = 200 * 1024 * 1024
  private static let heartbeatSeconds = 5
  /// Crash resilience: a movie fragment (and a key frame) at least this often.
  private static let fragmentSeconds: Double = 2
  /// SCREEN_CONTINUOUS_STREAM_BOUNDS.videoBitrateBps (the Android recorder's rate).
  private static let videoBitrateBps = 6_000_000
  private static let finishWaitSeconds = 10
  /// Contract A bounds (SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxOrientationChanges / maxPauses).
  private static let maxTimelineEntries = 256
  private static let maxPauses = 256

  /// Every state mutation happens on this one queue (sample buffers, the stop
  /// request, pause/resume, the heartbeat).
  private let queue = DispatchQueue(label: "com.proovra.broadcast.writer")
  private var heartbeat: DispatchSourceTimer?

  private var spool: ProovraBroadcastSpool?
  /// AUD-006 — this broadcast's namespace; nil until broadcastStarted opened one.
  private var recordingId: String?
  private var heartbeatSeq = 0
  private var segmentMs = SampleHandler.defaultSegmentMs
  private var maxSegments = SampleHandler.maxSegmentsLimit

  // THE one writer and its inputs.
  private var writer: AVAssetWriter?
  private var videoInput: AVAssetWriterInput?
  private var appAudioInput: AVAssetWriterInput?
  private var micAudioInput: AVAssetWriterInput?
  /// Set once THIS broadcast created recording.mp4 (never another recording's file).
  private var recordingURL: URL?

  // UC-IOS-004 — one clock: presentation timestamps.
  private var sessionFirstPts: CMTime = .invalid
  /// The PTS of the last video frame the writer ACCEPTED.
  private var lastPts: CMTime = .invalid
  private var sessionStartDate: Date?

  // The fixed canvas: the first buffer's raw (native) and oriented geometry.
  private var canvasRawW = 0
  private var canvasRawH = 0
  private var canvasW = 0
  private var canvasH = 0
  private var initialOrientation = "portrait"
  private var deviceBlock: [String: Any]?

  // Contract A facts.
  private var orientationTimeline: [[String: Any]] = []
  private var timelineLabel: String?
  private var timelineW = 0
  private var timelineH = 0
  private var pauses: [[String: Any]] = []
  private var pauseStartOffsetMs: Int?
  private var droppedFrameCount = 0
  private var droppedAudioBufferCount = 0
  private var appAudioSamples = 0
  private var micAudioSamples = 0

  private var limitations = Set<String>()
  private var stopped = false
  private var paused = false
  private var observing = false
  private let teardownLock = NSLock()

  // MARK: - Broadcast lifecycle

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    var opened = false
    queue.sync {
      guard let container = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: SampleHandler.appGroup) else { return }
      let spool = ProovraBroadcastSpool(root: ProovraBroadcastSpool.rootURL(inContainer: container))
      // AUD-006 — a NEW namespace for this broadcast: the app's binding when it is
      // fresh and unconsumed, otherwise an UNBOUND recording (e.g. Control Center)
      // that is still written, and offered for recovery or discard (UC-IOS-010).
      guard let recording = spool.openRecording(
        nowUptime: ProcessInfo.processInfo.systemUptime,
        nowUtc: ISO8601DateFormatter().string(from: Date())
      ) else { return }
      self.spool = spool
      recordingId = recording.recordingId
      segmentMs = min(max(recording.segmentMs, SampleHandler.minSegmentMs), SampleHandler.maxSegmentMsLimit)
      maxSegments = min(max(recording.maxSegments, 1), SampleHandler.maxSegmentsLimit)
      writeState(active: true, extra: [
        "appRequested": recording.appRequested,
        "binding": recording.binding.rawValue,
      ])
      opened = true
    }
    guard opened else {
      finish(message: "PROOVRA could not prepare storage for the recording. Nothing was recorded.")
      return
    }
    registerStopObserver()
    startHeartbeat()
    SampleHandler.postDarwin(SampleHandler.startedNote)
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    switch sampleBufferType {
    case .video:
      queue.sync { self.handleVideo(sampleBuffer) }
    case .audioApp:
      queue.sync { self.handleAudio(sampleBuffer, microphone: false) }
    case .audioMic:
      queue.sync { self.handleAudio(sampleBuffer, microphone: true) }
    @unknown default:
      return
    }
  }

  override func broadcastPaused() {
    queue.sync {
      guard !stopped, !paused else { return }
      paused = true
      // The writer keeps running; the paused stretch is a PTS gap in the file,
      // recorded here and named (UC-IOS-009). Before the first frame there is
      // no recording yet, so nothing to record.
      guard sessionFirstPts.isValid, pauseStartOffsetMs == nil else { return }
      pauseStartOffsetMs = lastPts.isValid ? SampleHandler.offsetMs(lastPts, from: sessionFirstPts) : 0
      limitations.insert("BROADCAST_PAUSED")
    }
  }

  override func broadcastResumed() {
    // The pause closes at the next video frame's PTS (handleVideo).
    queue.sync { paused = false }
  }

  override func broadcastFinished() {
    queue.sync {
      guard !stopped else { return }
      finishRecording(reason: "USER_STOPPED")
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
      finishRecording(reason: "USER_STOPPED")
      shouldFinish = true
    }
    guard shouldFinish else { return }
    tearDown()
    finish(message: "You stopped the recording in PROOVRA. Return to PROOVRA to review it.")
  }

  // MARK: - Frames

  private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
    guard !stopped else { return }
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      // A video buffer without an image cannot be written: counted, never hidden.
      if writer != nil { droppedFrameCount += 1 }
      return
    }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let orientation = SampleHandler.orientation(of: sampleBuffer)
    let rawW = CVPixelBufferGetWidth(pixelBuffer)
    let rawH = CVPixelBufferGetHeight(pixelBuffer)
    let rotated = orientation == .left || orientation == .right || orientation == .leftMirrored || orientation == .rightMirrored
    let orientedW = rotated ? rawH : rawW
    let orientedH = rotated ? rawW : rawH

    if writer == nil {
      guard startWriter(at: pts, orientation: orientation, rawW: rawW, rawH: rawH,
                        orientedW: orientedW, orientedH: orientedH) else { return }
    }
    let atMs = SampleHandler.offsetMs(pts, from: sessionFirstPts)

    // A resumed broadcast: the pause ends at the first frame after it.
    if !paused, let start = pauseStartOffsetMs {
      closePause(start: start, end: atMs)
    }
    noteOrientation(orientedW: orientedW, orientedH: orientedH, atMs: atMs)

    // THE duration bound: finish the ONE file and end the broadcast, never split.
    if atMs >= SampleHandler.maxSessionMs {
      reachBounds()
      return
    }
    // The canvas is fixed: a buffer of another pixel size is refused and counted.
    guard rawW == canvasRawW, rawH == canvasRawH else {
      droppedFrameCount += 1
      return
    }
    guard let input = videoInput, input.isReadyForMoreMediaData else {
      droppedFrameCount += 1
      if writer?.status == .failed { failWriter() }
      return
    }
    if input.append(sampleBuffer) {
      if !lastPts.isValid || CMTimeCompare(pts, lastPts) > 0 { lastPts = pts }
    } else {
      droppedFrameCount += 1
      // UC-IOS-007 — a failed append on a failed writer is a stalled recording.
      if writer?.status == .failed { failWriter() }
    }
  }

  /// App / microphone audio, appended ONLY when ReplayKit delivers it and only
  /// once the recording (the first video frame) has started.
  private func handleAudio(_ sampleBuffer: CMSampleBuffer, microphone: Bool) {
    guard !stopped, writer != nil, let input = microphone ? micAudioInput : appAudioInput else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    // Audio from before the first video frame is not part of the recording.
    guard pts.isValid, CMTimeCompare(pts, sessionFirstPts) >= 0 else { return }
    guard input.isReadyForMoreMediaData else {
      droppedAudioBufferCount += 1
      if writer?.status == .failed { failWriter() }
      return
    }
    if input.append(sampleBuffer) {
      if microphone { micAudioSamples += 1 } else { appAudioSamples += 1 }
    } else {
      droppedAudioBufferCount += 1
      if writer?.status == .failed { failWriter() }
    }
  }

  // MARK: - THE writer

  private func startWriter(at pts: CMTime, orientation: CGImagePropertyOrientation,
                           rawW: Int, rawH: Int, orientedW: Int, orientedH: Int) -> Bool {
    guard let spool = spool, let recordingId = recordingId,
          let dir = spool.directory(for: recordingId),
          let url = spool.recordingMediaURL(recordingId) else {
      failWriter()
      return false
    }
    // UC-IOS-007 — never start a recording the device cannot hold.
    if let free = SampleHandler.freeBytes(at: dir), free < SampleHandler.minFreeBytes {
      failWriter(storage: true)
      return false
    }
    // AUD-006 — never overwrite: a slot that already holds a recording is refused.
    guard spool.isRecordingSlotFree(recordingId) else {
      failWriter()
      return false
    }
    guard let w = try? AVAssetWriter(outputURL: url, fileType: .mp4) else {
      failWriter()
      return false
    }
    recordingURL = url
    // Crash resilience: a fragment every 2 s keeps an interrupted file playable.
    w.movieFragmentInterval = CMTime(seconds: SampleHandler.fragmentSeconds, preferredTimescale: 600)
    let compression: [String: Any] = [
      AVVideoAverageBitRateKey: SampleHandler.videoBitrateBps,
      AVVideoMaxKeyFrameIntervalDurationKey: SampleHandler.fragmentSeconds,
    ]
    let settings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: rawW,
      AVVideoHeightKey: rawH,
      AVVideoCompressionPropertiesKey: compression,
    ]
    let video = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    video.expectsMediaDataInRealTime = true
    // UC-IOS-008 — the buffer stays in native layout; the track's transform
    // presents the INITIAL orientation upright; later rotations are recorded
    // in orientationTimeline (the canvas never changes mid-file).
    video.transform = SampleHandler.transform(for: orientation)
    guard w.canAdd(video) else { failWriter(); return false }
    w.add(video)
    // Both audio inputs exist from the start (an input cannot be added once
    // writing began); each receives samples only if ReplayKit delivers them.
    let app = SampleHandler.audioInput(channels: 2)
    if w.canAdd(app) {
      w.add(app)
      appAudioInput = app
    }
    let mic = SampleHandler.audioInput(channels: 1)
    if w.canAdd(mic) {
      w.add(mic)
      micAudioInput = mic
    }
    writer = w
    videoInput = video
    guard w.startWriting() else { failWriter(); return false }
    w.startSession(atSourceTime: pts)
    sessionFirstPts = pts
    sessionStartDate = Date()
    canvasRawW = rawW
    canvasRawH = rawH
    canvasW = orientedW
    canvasH = orientedH
    initialOrientation = orientedW >= orientedH ? "landscape" : "portrait"
    deviceBlock = SampleHandler.displayDevice(orientedW: orientedW, orientedH: orientedH)
    noteOrientation(orientedW: orientedW, orientedH: orientedH, atMs: 0)
    writeState(active: true)
    return true
  }

  /// Finish the ONE writer. True only when the file is complete (finishWriting
  /// succeeded); otherwise the fragments written so far stay on disk.
  private func finishWriter() -> Bool {
    guard let writer = writer else { return false }
    self.writer = nil
    guard writer.status == .writing else { return writer.status == .completed }
    videoInput?.markAsFinished()
    appAudioInput?.markAsFinished()
    micAudioInput?.markAsFinished()
    if lastPts.isValid && CMTimeCompare(lastPts, sessionFirstPts) > 0 {
      writer.endSession(atSourceTime: lastPts)
    }
    let group = DispatchGroup()
    group.enter()
    writer.finishWriting { group.leave() }
    let waited = group.wait(timeout: .now() + .seconds(SampleHandler.finishWaitSeconds))
    return waited == .success && writer.status == .completed
  }

  /// End the recording: finish the file, then write its sidecar and the result.
  private func finishRecording(reason: String) {
    guard !stopped else { return }
    stopped = true
    let completed = finishWriter()
    sealRecording(reason: reason, finalized: completed)
  }

  /// A session bound (duration, bytes, free space): finish — never split.
  private func reachBounds() {
    guard !stopped else { return }
    limitations.insert("SESSION_BOUNDS_REACHED")
    finishRecording(reason: "BOUNDS_REACHED")
    endBroadcast(message: "PROOVRA reached the recording limit. The recording is saved — return to PROOVRA to review it.")
  }

  /// UC-IOS-007 — the writer failed (storage full, encoder error): stop with a reason.
  private func failWriter(storage: Bool = false) {
    guard !stopped else { return }
    stopped = true
    let failed = writer
    writer = nil
    let hasMedia = lastPts.isValid
    if let w = failed, w.status == .writing, !hasMedia { w.cancelWriting() }
    // A file THIS broadcast created with no frame in it holds nothing: removed.
    // One with frames is kept — playable up to its last fragment, never complete.
    if !hasMedia, let url = recordingURL {
      try? FileManager.default.removeItem(at: url)
    }
    limitations.insert("SEGMENT_WRITE_FAILED")
    sealRecording(reason: "ERROR", finalized: false)
    let message = storage
      ? "PROOVRA stopped recording because this device is running out of storage. Return to PROOVRA to review what was saved."
      : "PROOVRA could not save the recording. Return to PROOVRA to review what was saved."
    endBroadcast(message: message)
  }

  private func endBroadcast(message: String) {
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

  // MARK: - Contract A facts

  /// Records the orientation when it (or the oriented geometry) changes. Offsets
  /// are strictly ascending: a second change in the same millisecond replaces
  /// the previous entry.
  private func noteOrientation(orientedW: Int, orientedH: Int, atMs: Int) {
    let label = orientedW >= orientedH ? "landscape" : "portrait"
    guard label != timelineLabel || orientedW != timelineW || orientedH != timelineH else { return }
    timelineLabel = label
    timelineW = orientedW
    timelineH = orientedH
    if label != initialOrientation { limitations.insert("ORIENTATION_CHANGED_DURING_CAPTURE") }
    let entry: [String: Any] = ["atOffsetMs": atMs, "orientation": label, "widthPx": orientedW, "heightPx": orientedH]
    if let previous = orientationTimeline.last?["atOffsetMs"] as? Int, previous >= atMs {
      orientationTimeline[orientationTimeline.count - 1] = entry
    } else if orientationTimeline.count < SampleHandler.maxTimelineEntries {
      orientationTimeline.append(entry)
    }
  }

  /// One paused stretch [start, end). Past the bound, the last pause is widened
  /// (it then overstates the unrecorded stretch — never understates it).
  private func closePause(start: Int, end: Int) {
    pauseStartOffsetMs = nil
    guard end > start else { return }
    if pauses.count >= SampleHandler.maxPauses, !pauses.isEmpty {
      pauses[pauses.count - 1]["endOffsetMs"] = end
    } else {
      pauses.append(["startOffsetMs": start, "endOffsetMs": end])
    }
  }

  /// A pause still open when the recording ends is not a gap INSIDE the file
  /// (the file ends at its last frame); it stays named by BROADCAST_PAUSED.
  private func dropOpenPause() {
    pauseStartOffsetMs = nil
  }

  private func audioTracks() -> [String] {
    var tracks: [String] = []
    if appAudioSamples > 0 { tracks.append("APP") }
    if micAudioSamples > 0 { tracks.append("MICROPHONE") }
    return tracks
  }

  private func recordedMs() -> Int {
    guard sessionFirstPts.isValid, lastPts.isValid else { return 0 }
    return SampleHandler.offsetMs(lastPts, from: sessionFirstPts)
  }

  // MARK: - recording.json / result.json / state.json

  private static let incompleteLimitations: Set<String> = [
    "CAPTURE_INTERRUPTED", "SEGMENT_UPLOAD_LOST", "SEGMENT_WRITE_FAILED", "BROADCAST_PAUSED",
  ]

  /// Writes the recording's sidecar, then the session result, once.
  private func sealRecording(reason: String, finalized: Bool) {
    guard let spool = spool, let recordingId = recordingId else { return }
    dropOpenPause()
    let cleanEnd = reason == "USER_STOPPED" || reason == "BOUNDS_REACHED"
    if !cleanEnd { limitations.insert("CAPTURE_INTERRUPTED") }
    if droppedFrameCount > 0 { limitations.insert("FRAMES_DROPPED") }
    let tracks = audioTracks()
    if tracks.isEmpty { limitations.insert("AUDIO_NOT_CAPTURED") }
    let hasMedia = lastPts.isValid && recordingURL.map { FileManager.default.fileExists(atPath: $0.path) } == true
    // A file the writer could not finish is never presented as complete.
    if hasMedia && !finalized { limitations.insert("SEGMENT_WRITE_FAILED") }
    let iso = ISO8601DateFormatter()
    let endedAtUtc = iso.string(from: Date())
    let sizeBytes = recordingURL.flatMap { ProovraBroadcastSpool.fileSize($0) } ?? 0
    var sidecar: [String: Any] = [
      "sizeBytes": NSNumber(value: sizeBytes),
      "durationMs": recordedMs(),
      "widthPx": canvasW,
      "heightPx": canvasH,
      "orientation": initialOrientation,
      "orientationTimeline": orientationTimeline,
      "pauses": pauses,
      "droppedFrameCount": droppedFrameCount,
      "droppedAudioBufferCount": droppedAudioBufferCount,
      "audioTracks": tracks,
      "finalized": hasMedia && finalized,
      "limitations": Array(limitations).sorted(),
      "terminationReason": reason,
      "endedAtUtc": endedAtUtc,
    ]
    if let start = sessionStartDate { sidecar["startedAtUtc"] = iso.string(from: start) }
    // Written once: a recording's sidecar is never replaced.
    _ = spool.publishRecording(recordingId, sidecar: sidecar)
    writeResult(reason: reason, finalized: hasMedia && finalized, hasMedia: hasMedia, endedAtUtc: endedAtUtc)
  }

  private func writeResult(reason: String, finalized: Bool, hasMedia: Bool, endedAtUtc: String) {
    guard let spool = spool, let recordingId = recordingId else { return }
    let cleanEnd = reason == "USER_STOPPED" || reason == "BOUNDS_REACHED"
    let complete = cleanEnd && finalized && limitations.isDisjoint(with: SampleHandler.incompleteLimitations)
    var result: [String: Any] = [
      "recordingId": recordingId,
      "osConsentGranted": sessionFirstPts.isValid,
      "endedAtUtc": endedAtUtc,
      "segmentCount": hasMedia ? 1 : 0,
      "totalDurationMs": recordedMs(),
      "sessionCompleteness": complete ? "COMPLETE_SESSION" : "INTERRUPTED_SESSION",
      "terminationReason": reason,
      "limitations": Array(limitations).sorted(),
    ]
    if let start = sessionStartDate { result["startedAtUtc"] = iso8601(start) }
    if let device = deviceBlock { result["device"] = device }
    // AUD-006 — finalised ONCE per recording: the first result stands.
    spool.finalize(recordingId, result: result)
    writeState(active: false)
    SampleHandler.postDarwin(SampleHandler.finishedNote)
  }

  private func writeState(active: Bool, extra: [String: Any] = [:]) {
    guard let spool = spool, let recordingId = recordingId else { return }
    heartbeatSeq += 1
    var state: [String: Any] = [
      "active": active,
      "layout": "SINGLE_FILE",
      "segmentCount": lastPts.isValid ? 1 : 0,
      "segmentMs": segmentMs,
      "maxSegments": maxSegments,
      // What a killed extension leaves the app to state (never a guess):
      "recordedMs": recordedMs(),
      "widthPx": canvasW,
      "heightPx": canvasH,
      "orientationTimeline": orientationTimeline,
      "pauses": pauses,
      "droppedFrameCount": droppedFrameCount,
      "droppedAudioBufferCount": droppedAudioBufferCount,
      "audioTracks": audioTracks(),
      // UC-IOS-006 / AUD-006 — the heartbeat is on the monotonic clock the app
      // shares within one boot, not the wall clock.
      "heartbeatSeq": heartbeatSeq,
      "heartbeatUptime": ProcessInfo.processInfo.systemUptime,
    ]
    if let start = sessionStartDate { state["startedAtUtc"] = iso8601(start) }
    for (k, v) in extra { state[k] = v }
    spool.updateState(recordingId, state)
  }

  /// UC-IOS-006 — lets the app tell a live broadcast from a killed one. Also
  /// enforces the byte bound and the free-space floor on the growing file.
  private func startHeartbeat() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + .seconds(SampleHandler.heartbeatSeconds),
                   repeating: .seconds(SampleHandler.heartbeatSeconds))
    timer.setEventHandler { [weak self] in
      guard let self = self, !self.stopped else { return }
      self.checkStorageBounds()
      guard !self.stopped else { return }
      self.writeState(active: true)
    }
    timer.resume()
    heartbeat = timer
  }

  private func checkStorageBounds() {
    guard writer != nil, let url = recordingURL else { return }
    if let size = ProovraBroadcastSpool.fileSize(url),
       size + SampleHandler.sessionBytesMargin >= SampleHandler.maxSessionBytes {
      reachBounds()
      return
    }
    if let free = SampleHandler.freeBytes(at: url.deletingLastPathComponent()), free < SampleHandler.minFreeBytes {
      reachBounds()
    }
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

  private static func audioInput(channels: Int) -> AVAssetWriterInput {
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: channels,
      AVSampleRateKey: 44_100,
      AVEncoderBitRateKey: channels == 1 ? 64_000 : 128_000,
    ]
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
    input.expectsMediaDataInRealTime = true
    return input
  }

  /// The free space for important usage on the container's volume (DiskSpace API, declared).
  private static func freeBytes(at dir: URL) -> Int64? {
    return try? dir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
      .volumeAvailableCapacityForImportantUsage
  }

  private static func offsetMs(_ pts: CMTime, from first: CMTime) -> Int {
    return max(0, ms(CMTimeSubtract(pts, first)))
  }

  private static func ms(_ t: CMTime) -> Int {
    guard t.isValid, !t.isIndefinite else { return 0 }
    return Int((CMTimeGetSeconds(t) * 1000).rounded())
  }

  private func iso8601(_ date: Date) -> String {
    return ISO8601DateFormatter().string(from: date)
  }

  private static func postDarwin(_ name: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(name as CFString), nil, nil, true)
  }
}
