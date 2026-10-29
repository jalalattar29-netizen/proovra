import Foundation

/**
 * AUD-006 — THE on-disk spool of the iOS broadcast pipeline: one NAMESPACE per
 * broadcast, so two broadcasts can never write into, read from or finalise each
 * other's files.
 *
 * The spool used to be one fixed directory: a broadcast started from Control
 * Center over a leftover recording restarted at seg-0 and overwrote it, left the
 * old seg-k and the old result.json in place (the app read a mix of both, and a
 * stop returned the OLD result at once), and any `started` note was attached to
 * whatever capture session the app held. Now:
 *
 *   <AppGroup>/uc5-broadcast/
 *     pending-binding.json   the app's binding, written BEFORE it shows Apple's picker:
 *                            { recordingId, captureSessionId, appRequested, createdAtUtc,
 *                              createdAtUptime, segmentMs, maxSegments }
 *     <recordingId>/         one directory per broadcast (a UUID), created exclusively
 *       binding.json         { recordingId, binding: BOUND|UNBOUND, appRequested,
 *                              captureSessionId, createdAtUtc, adoptedAtUtc, segmentMs, maxSegments }
 *       state.json           { recordingId, active, segmentCount, startedAtUtc,
 *                              heartbeatSeq, heartbeatUptime, segmentMs, maxSegments }
 *       recording.mp4        THE recording (layout SINGLE_FILE): one fragmented MP4 per
 *                            broadcast, never overwritten (the slot must be free to open it)
 *       recording.json       its sidecar, written ONCE at finish: { layout, fileName, sizeBytes,
 *                            durationMs, widthPx, heightPx, orientation, orientationTimeline,
 *                            pauses, droppedFrameCount, droppedAudioBufferCount, audioTracks,
 *                            finalized, limitations, terminationReason, startedAtUtc, endedAtUtc }
 *       seg-<n>.mp4/.json    LEGACY (layout SEGMENTED, builds before 2026-10-29): read only, so
 *                            a recording an older extension left behind is still recoverable
 *       result.json          written ONCE (first finaliser wins), carries recordingId
 *
 * A killed extension leaves recording.mp4 without recording.json: the file is
 * playable up to its last movie fragment (~2 s), and is reported finalized=false.
 *
 * The extension ADOPTS the pending binding by renaming it (one atomic rename: at
 * most one broadcast can consume it), only when it is fresh. A broadcast with no
 * fresh unconsumed binding — Control Center, a stale or withdrawn binding — gets
 * its own UNBOUND namespace, which the app never attaches to a capture session.
 *
 * Liveness uses the shared monotonic uptime clock (`ProcessInfo.systemUptime`,
 * the same for the app and its extension within one boot), not the wall clock a
 * user can change: a heartbeat older than `staleAfterSeconds` — or one from
 * "the future", i.e. before a reboot — is stale.
 *
 * Foundation only: this one file is compiled into the app (the
 * ProovraScreenCapture pod), into the ProovraBroadcast extension (the config
 * plugin adds it to that target) and into the SwiftPM XCTest package
 * (ios-tests/, run by native-build.yml), so all three use the same code.
 */

enum ProovraBroadcastBindingState: String {
  /// The extension adopted the app's fresh, unconsumed binding.
  case bound = "BOUND"
  /// No binding was adopted (Control Center, stale or withdrawn binding).
  case unbound = "UNBOUND"
}

/// What the app writes before it requests the broadcast.
struct ProovraBroadcastBinding {
  let recordingId: String
  /// Nil until the app has opened its capture session (after the broadcast started).
  let captureSessionId: String?
  let appRequested: Bool
  let createdAtUtc: String
  let createdAtUptime: TimeInterval
  let segmentMs: Int
  let maxSegments: Int

  func toJson() -> [String: Any] {
    return [
      "recordingId": recordingId,
      "captureSessionId": ProovraBroadcastSpool.jsonValue(captureSessionId),
      "appRequested": appRequested,
      "createdAtUtc": createdAtUtc,
      "createdAtUptime": createdAtUptime,
      "segmentMs": segmentMs,
      "maxSegments": maxSegments,
    ]
  }

  static func from(_ obj: [String: Any]) -> ProovraBroadcastBinding? {
    guard let recordingId = obj["recordingId"] as? String, ProovraBroadcastSpool.isRecordingId(recordingId),
          let createdAtUptime = (obj["createdAtUptime"] as? NSNumber)?.doubleValue,
          let createdAtUtc = obj["createdAtUtc"] as? String else { return nil }
    return ProovraBroadcastBinding(
      recordingId: recordingId,
      captureSessionId: obj["captureSessionId"] as? String,
      appRequested: (obj["appRequested"] as? Bool) ?? false,
      createdAtUtc: createdAtUtc,
      createdAtUptime: createdAtUptime,
      segmentMs: (obj["segmentMs"] as? Int) ?? ProovraBroadcastSpool.defaultSegmentMs,
      maxSegments: (obj["maxSegments"] as? Int) ?? ProovraBroadcastSpool.maxSegmentsLimit
    )
  }
}

/// One namespace's binding.json: who this recording belongs to.
struct ProovraBroadcastRecording {
  let recordingId: String
  let binding: ProovraBroadcastBindingState
  let appRequested: Bool
  let captureSessionId: String?
  let createdAtUtc: String
  let segmentMs: Int
  let maxSegments: Int

  func toJson(adoptedAtUtc: String) -> [String: Any] {
    return [
      "recordingId": recordingId,
      "binding": binding.rawValue,
      "appRequested": appRequested,
      "captureSessionId": ProovraBroadcastSpool.jsonValue(captureSessionId),
      "createdAtUtc": createdAtUtc,
      "adoptedAtUtc": adoptedAtUtc,
      "segmentMs": segmentMs,
      "maxSegments": maxSegments,
    ]
  }

  static func from(_ obj: [String: Any]) -> ProovraBroadcastRecording? {
    guard let recordingId = obj["recordingId"] as? String, ProovraBroadcastSpool.isRecordingId(recordingId),
          let raw = obj["binding"] as? String,
          let binding = ProovraBroadcastBindingState(rawValue: raw) else { return nil }
    return ProovraBroadcastRecording(
      recordingId: recordingId,
      binding: binding,
      appRequested: (obj["appRequested"] as? Bool) ?? false,
      captureSessionId: obj["captureSessionId"] as? String,
      createdAtUtc: (obj["createdAtUtc"] as? String) ?? "",
      segmentMs: (obj["segmentMs"] as? Int) ?? ProovraBroadcastSpool.defaultSegmentMs,
      maxSegments: (obj["maxSegments"] as? Int) ?? ProovraBroadcastSpool.maxSegmentsLimit
    )
  }
}

/// One finalised ORIGINAL segment, as the app re-emits it to JS.
struct ProovraScreenSegment {
  let recordingId: String
  let uri: String
  let sequence: Int
  let startedAtOffsetMs: Int
  let durationMs: Int
  let widthPx: Int
  let heightPx: Int
  let orientation: String

  func toJsMap() -> [String: Any] {
    return [
      "recordingId": recordingId,
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

/**
 * THE one recording of a broadcast (layout SINGLE_FILE), as the app returns it
 * (wire contract B). Read from recording.json when the extension finished it;
 * when the extension was killed, only what is provable is stated: the file (if
 * it exists — playable to its last fragment), its size on disk, the geometry
 * and counters of the last heartbeat, no duration, and finalized=false.
 */
struct ProovraBroadcastRecordingFile {
  let recordingId: String
  /// file:// URI of recording.mp4, nil when no media was written.
  let uri: String?
  let sizeBytes: Int64?
  /// Nil when the extension never finished the file (the playable length is the file's own).
  let durationMs: Int?
  let widthPx: Int?
  let heightPx: Int?
  let orientationTimeline: [[String: Any]]
  let pauses: [[String: Any]]
  let droppedFrameCount: Int
  let droppedAudioBufferCount: Int
  let audioTracks: [String]
  /// True only when the extension's writer completed the file (finishWriting succeeded).
  let finalized: Bool
  /// recording.json exists (the extension reached its finish, cleanly or not).
  let sidecarWritten: Bool

  /// Wire contract B's recording fields (merged into the stop result).
  func toJsFields() -> [String: Any] {
    return [
      "layout": "SINGLE_FILE",
      "recordingUri": ProovraBroadcastSpool.jsonValue(uri),
      "recordingSizeBytes": ProovraBroadcastSpool.jsonNumber(sizeBytes),
      "recordingDurationMs": ProovraBroadcastSpool.jsonNumber(durationMs.map { Int64($0) }),
      "widthPx": ProovraBroadcastSpool.jsonNumber(widthPx.map { Int64($0) }),
      "heightPx": ProovraBroadcastSpool.jsonNumber(heightPx.map { Int64($0) }),
      "orientationTimeline": orientationTimeline,
      "pauses": pauses,
      "droppedFrameCount": droppedFrameCount,
      "droppedAudioBufferCount": droppedAudioBufferCount,
      "audioTracks": audioTracks,
      "finalized": finalized,
    ]
  }
}

/// A recording the app can list for explicit recovery or discard.
struct ProovraBroadcastRecordingSummary {
  let recording: ProovraBroadcastRecording
  let segmentCount: Int
  /// The broadcast wrote its ONE recording file (layout SINGLE_FILE).
  let hasRecordingFile: Bool
  let active: Bool
  let stale: Bool
  let finalized: Bool

  func toJsMap() -> [String: Any] {
    return [
      "recordingId": recording.recordingId,
      "binding": recording.binding.rawValue,
      "appRequested": recording.appRequested,
      "captureSessionId": ProovraBroadcastSpool.jsonValue(recording.captureSessionId),
      "createdAtUtc": recording.createdAtUtc,
      "segmentCount": segmentCount,
      "layout": hasRecordingFile || segmentCount == 0 ? "SINGLE_FILE" : "SEGMENTED",
      "hasRecordingFile": hasRecordingFile,
      "active": active,
      "stale": stale,
      "finalized": finalized,
    ]
  }
}

enum ProovraBroadcastSessionBindOutcome: Equatable {
  /// The capture session is now (or already was) recorded on this recording.
  case bound
  /// The recording was not adopted from the app's binding (e.g. Control Center).
  case refusedUnbound
  /// The recording already belongs to a different capture session.
  case refusedOtherSession
  /// No such recording on this device.
  case missing
}

final class ProovraBroadcastSpool {
  static let rootDirectoryName = "uc5-broadcast"
  static let pendingBindingName = "pending-binding.json"
  static let bindingName = "binding.json"
  static let stateName = "state.json"
  static let resultName = "result.json"
  /// THE one recording of a broadcast (layout SINGLE_FILE) and its sidecar.
  static let recordingMediaName = "recording.mp4"
  static let recordingSidecarName = "recording.json"
  /// A binding is adoptable this long after the app wrote it — the same budget
  /// the JS gives Apple's picker (BROADCAST_START_TIMEOUT_MS, src/continuous-capture.ts).
  static let bindingFreshSeconds: TimeInterval = 120
  /// A live broadcast heartbeats every 5 s; no heartbeat for this long = the extension died.
  static let staleAfterSeconds: TimeInterval = 30
  // UC-STR-001 — THE capture limits (packages/shared/src/capture-limits.ts), by value.
  static let maxSegmentsLimit = 199
  static let defaultSegmentMs = 6000

  let root: URL
  private let fm = FileManager.default

  init(root: URL) { self.root = root }

  /// The App Group container's spool root.
  static func rootURL(inContainer container: URL) -> URL {
    return container.appendingPathComponent(rootDirectoryName, isDirectory: true)
  }

  // MARK: - Pure decisions

  /// A namespace name is a canonical (upper-case) UUID and nothing else: no path tricks.
  static func isRecordingId(_ value: String) -> Bool {
    guard let uuid = UUID(uuidString: value) else { return false }
    return uuid.uuidString == value
  }

  /// A JSON value for an optional string: the string, or null.
  static func jsonValue(_ value: String?) -> Any {
    if let value = value { return value }
    return NSNull()
  }

  /// A JSON value for an optional integer: the number, or null.
  static func jsonNumber(_ value: Int64?) -> Any {
    if let value = value { return NSNumber(value: value) }
    return NSNull()
  }

  /// A file's size on disk, read fresh (a new URL: resource values are cached per
  /// URL instance). `.fileSizeKey` is not a required-reason (timestamp) API.
  static func fileSize(_ url: URL) -> Int64? {
    let fresh = URL(fileURLWithPath: url.path)
    guard let size = try? fresh.resourceValues(forKeys: [.fileSizeKey]).fileSize else { return nil }
    return Int64(size)
  }

  /// Fresh = written by the app within the budget, on this boot (uptime only moves forward).
  static func isBindingFresh(createdAtUptime: TimeInterval, nowUptime: TimeInterval) -> Bool {
    let age = nowUptime - createdAtUptime
    return age >= 0 && age <= bindingFreshSeconds
  }

  /// Liveness from the monotonic heartbeat: (active && !stale, stale).
  static func liveness(stateActive: Bool, heartbeatUptime: TimeInterval?, nowUptime: TimeInterval) -> (active: Bool, stale: Bool) {
    guard stateActive else { return (false, false) }
    guard let beat = heartbeatUptime else { return (false, true) }
    let age = nowUptime - beat
    // A heartbeat "from the future" was written before a reboot: nothing survives one.
    if age < 0 || age > staleAfterSeconds { return (false, true) }
    return (true, false)
  }

  static func segmentMediaName(_ sequence: Int) -> String { "seg-\(sequence).mp4" }
  static func segmentSidecarName(_ sequence: Int) -> String { "seg-\(sequence).json" }

  // MARK: - App side: the binding

  /// Written (atomically) before the app presents Apple's picker. Replaces an
  /// earlier unconsumed binding — that one never started, so it holds nothing.
  @discardableResult
  func writePendingBinding(_ binding: ProovraBroadcastBinding) -> Bool {
    guard ensureRoot() else { return false }
    return writeJson(binding.toJson(), to: root.appendingPathComponent(ProovraBroadcastSpool.pendingBindingName))
  }

  func pendingBinding() -> ProovraBroadcastBinding? {
    return readJson(root.appendingPathComponent(ProovraBroadcastSpool.pendingBindingName))
      .flatMap(ProovraBroadcastBinding.from)
  }

  /// The picker was cancelled / timed out: a later broadcast must not adopt it.
  @discardableResult
  func withdrawPendingBinding(recordingId: String) -> Bool {
    guard let pending = pendingBinding(), pending.recordingId == recordingId else { return false }
    return (try? fm.removeItem(at: root.appendingPathComponent(ProovraBroadcastSpool.pendingBindingName))) != nil
  }

  // MARK: - Extension side: open a NEW namespace for this broadcast

  /**
   * Called once per broadcast (broadcastStarted). Adopts the pending binding if
   * — and only if — it is fresh and this call won the atomic rename; otherwise
   * opens an UNBOUND namespace. Never returns an existing namespace: a broadcast
   * cannot write into another one's spool.
   */
  func openRecording(nowUptime: TimeInterval, nowUtc: String,
                     newRecordingId: () -> String = { UUID().uuidString }) -> ProovraBroadcastRecording? {
    guard ensureRoot() else { return nil }
    var adopted: ProovraBroadcastBinding?
    let pending = root.appendingPathComponent(ProovraBroadcastSpool.pendingBindingName)
    let claim = root.appendingPathComponent(".claim-\(UUID().uuidString).json")
    if (try? fm.moveItem(at: pending, to: claim)) != nil {
      // Consumed: whatever it said, it can never be adopted again.
      adopted = readJson(claim).flatMap(ProovraBroadcastBinding.from)
      try? fm.removeItem(at: claim)
      if let b = adopted, !ProovraBroadcastSpool.isBindingFresh(createdAtUptime: b.createdAtUptime, nowUptime: nowUptime) {
        adopted = nil
      }
    }

    if let b = adopted, let dir = directory(for: b.recordingId), createExclusively(dir) {
      let recording = ProovraBroadcastRecording(
        recordingId: b.recordingId,
        binding: .bound,
        appRequested: b.appRequested,
        captureSessionId: b.captureSessionId,
        createdAtUtc: b.createdAtUtc,
        segmentMs: b.segmentMs,
        maxSegments: b.maxSegments
      )
      guard writeJson(recording.toJson(adoptedAtUtc: nowUtc), to: dir.appendingPathComponent(ProovraBroadcastSpool.bindingName)) else { return nil }
      return recording
    }

    for _ in 0..<3 {
      let id = newRecordingId()
      guard let dir = directory(for: id), createExclusively(dir) else { continue }
      let recording = ProovraBroadcastRecording(
        recordingId: id,
        binding: .unbound,
        appRequested: false,
        captureSessionId: nil,
        createdAtUtc: nowUtc,
        segmentMs: ProovraBroadcastSpool.defaultSegmentMs,
        maxSegments: ProovraBroadcastSpool.maxSegmentsLimit
      )
      guard writeJson(recording.toJson(adoptedAtUtc: nowUtc), to: dir.appendingPathComponent(ProovraBroadcastSpool.bindingName)) else { return nil }
      return recording
    }
    return nil
  }

  // MARK: - Namespaces

  func directory(for recordingId: String) -> URL? {
    guard ProovraBroadcastSpool.isRecordingId(recordingId) else { return nil }
    return root.appendingPathComponent(recordingId, isDirectory: true)
  }

  func recording(_ recordingId: String) -> ProovraBroadcastRecording? {
    guard let dir = directory(for: recordingId),
          let rec = readJson(dir.appendingPathComponent(ProovraBroadcastSpool.bindingName)).flatMap(ProovraBroadcastRecording.from),
          rec.recordingId == recordingId else { return nil }
    return rec
  }

  /// Every namespace on the device, oldest first.
  func recordingIds() -> [String] {
    let names = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
    return names
      .filter { ProovraBroadcastSpool.isRecordingId($0) }
      .compactMap { recording($0) }
      .sorted { ($0.createdAtUtc, $0.recordingId) < ($1.createdAtUtc, $1.recordingId) }
      .map { $0.recordingId }
  }

  /// The app records which capture session holds a BOUND recording. Idempotent
  /// for the same session; refuses an UNBOUND recording or a second session.
  func bindCaptureSession(recordingId: String, captureSessionId: String) -> ProovraBroadcastSessionBindOutcome {
    guard let dir = directory(for: recordingId),
          let obj = readJson(dir.appendingPathComponent(ProovraBroadcastSpool.bindingName)),
          let rec = ProovraBroadcastRecording.from(obj), rec.recordingId == recordingId else { return .missing }
    guard rec.binding == .bound else { return .refusedUnbound }
    if let existing = rec.captureSessionId {
      return existing == captureSessionId ? .bound : .refusedOtherSession
    }
    var next = obj
    next["captureSessionId"] = captureSessionId
    return writeJson(next, to: dir.appendingPathComponent(ProovraBroadcastSpool.bindingName)) ? .bound : .missing
  }

  /// The user's explicit discard of ONE recording.
  @discardableResult
  func discard(recordingId: String) -> Bool {
    guard let dir = directory(for: recordingId), fm.fileExists(atPath: dir.path) else { return false }
    return (try? fm.removeItem(at: dir)) != nil
  }

  // MARK: - state.json

  func readState(_ recordingId: String) -> [String: Any]? {
    guard let dir = directory(for: recordingId) else { return nil }
    return readJson(dir.appendingPathComponent(ProovraBroadcastSpool.stateName))
  }

  /// Merges `changes` into the namespace's state.json (it stays scoped by recordingId).
  @discardableResult
  func updateState(_ recordingId: String, _ changes: [String: Any]) -> Bool {
    guard let dir = directory(for: recordingId), fm.fileExists(atPath: dir.path) else { return false }
    var state = readState(recordingId) ?? [:]
    for (k, v) in changes { state[k] = v }
    state["recordingId"] = recordingId
    return writeJson(state, to: dir.appendingPathComponent(ProovraBroadcastSpool.stateName))
  }

  func liveness(_ recordingId: String, nowUptime: TimeInterval) -> (active: Bool, stale: Bool) {
    let state = readState(recordingId)
    return ProovraBroadcastSpool.liveness(
      stateActive: (state?["active"] as? Bool) ?? false,
      heartbeatUptime: (state?["heartbeatUptime"] as? NSNumber)?.doubleValue,
      nowUptime: nowUptime
    )
  }

  /// The broadcast running right now, if any (the freshest live heartbeat).
  func liveRecordingId(nowUptime: TimeInterval) -> String? {
    var best: (id: String, beat: Double)?
    for id in recordingIds() where liveness(id, nowUptime: nowUptime).active {
      let beat = (readState(id)?["heartbeatUptime"] as? NSNumber)?.doubleValue ?? 0
      if best == nil || beat > best!.beat { best = (id, beat) }
    }
    return best?.id
  }

  // MARK: - Segments

  /// A slot is free when neither its media nor its sidecar exists: a published
  /// segment is never overwritten.
  func isSegmentSlotFree(_ recordingId: String, sequence: Int) -> Bool {
    guard let dir = directory(for: recordingId) else { return false }
    return !fm.fileExists(atPath: dir.appendingPathComponent(ProovraBroadcastSpool.segmentMediaName(sequence)).path)
      && !fm.fileExists(atPath: dir.appendingPathComponent(ProovraBroadcastSpool.segmentSidecarName(sequence)).path)
  }

  /// The next sequence that continues this namespace (0 for a new one).
  func nextSequence(_ recordingId: String) -> Int {
    guard let dir = directory(for: recordingId) else { return 0 }
    let names = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
    var next = 0
    for name in names where name.hasPrefix("seg-") {
      let core = name.dropFirst(4).split(separator: ".").first.map { String($0) } ?? ""
      if let n = Int(core), n >= next { next = n + 1 }
    }
    return next
  }

  func segmentMediaURL(_ recordingId: String, sequence: Int) -> URL? {
    return directory(for: recordingId)?.appendingPathComponent(ProovraBroadcastSpool.segmentMediaName(sequence))
  }

  /// Publishes a finalised segment's sidecar exclusively: false (and nothing
  /// written) when that sequence was already published.
  func publishSegment(_ recordingId: String, sequence: Int, sidecar: [String: Any]) -> Bool {
    guard let dir = directory(for: recordingId) else { return false }
    var body = sidecar
    body["sequence"] = sequence
    body["recordingId"] = recordingId
    return writeExclusively(body, to: dir.appendingPathComponent(ProovraBroadcastSpool.segmentSidecarName(sequence)))
  }

  /// Segments with sequence > `after`, ascending and contiguous, whose sidecar
  /// names THIS recording and whose media exists.
  func segments(_ recordingId: String, after: Int) -> [ProovraScreenSegment] {
    guard let dir = directory(for: recordingId) else { return [] }
    var out: [ProovraScreenSegment] = []
    var seq = after + 1
    while true {
      let sidecar = dir.appendingPathComponent(ProovraBroadcastSpool.segmentSidecarName(seq))
      let media = dir.appendingPathComponent(ProovraBroadcastSpool.segmentMediaName(seq))
      guard fm.fileExists(atPath: media.path),
            let obj = readJson(sidecar),
            (obj["recordingId"] as? String) == recordingId,
            let sequence = obj["sequence"] as? Int, sequence == seq,
            let offset = obj["startedAtOffsetMs"] as? Int,
            let duration = obj["durationMs"] as? Int,
            let width = obj["widthPx"] as? Int,
            let height = obj["heightPx"] as? Int,
            let orientation = obj["orientation"] as? String else { break }
      out.append(ProovraScreenSegment(
        recordingId: recordingId,
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

  // MARK: - THE recording (layout SINGLE_FILE)

  func recordingMediaURL(_ recordingId: String) -> URL? {
    return directory(for: recordingId)?.appendingPathComponent(ProovraBroadcastSpool.recordingMediaName)
  }

  /// The recording slot is free when neither recording.mp4 nor its sidecar
  /// exists: a written recording is never overwritten.
  func isRecordingSlotFree(_ recordingId: String) -> Bool {
    guard let dir = directory(for: recordingId) else { return false }
    return !fm.fileExists(atPath: dir.appendingPathComponent(ProovraBroadcastSpool.recordingMediaName).path)
      && !fm.fileExists(atPath: dir.appendingPathComponent(ProovraBroadcastSpool.recordingSidecarName).path)
  }

  func hasRecordingMedia(_ recordingId: String) -> Bool {
    guard let url = recordingMediaURL(recordingId) else { return false }
    return fm.fileExists(atPath: url.path)
  }

  /// Publishes the recording's sidecar exclusively (once): false, and nothing
  /// written, when it was already published.
  func publishRecording(_ recordingId: String, sidecar: [String: Any]) -> Bool {
    guard let dir = directory(for: recordingId), fm.fileExists(atPath: dir.path) else { return false }
    var body = sidecar
    body["recordingId"] = recordingId
    body["layout"] = "SINGLE_FILE"
    body["fileName"] = ProovraBroadcastSpool.recordingMediaName
    return writeExclusively(body, to: dir.appendingPathComponent(ProovraBroadcastSpool.recordingSidecarName))
  }

  /// The sidecar of THIS recording, or nil while it has none.
  func readRecordingSidecar(_ recordingId: String) -> [String: Any]? {
    guard let dir = directory(for: recordingId),
          let obj = readJson(dir.appendingPathComponent(ProovraBroadcastSpool.recordingSidecarName)),
          (obj["recordingId"] as? String) == recordingId else { return nil }
    return obj
  }

  /**
   * THE recording of `recordingId`, or nil when the broadcast wrote neither a
   * recording file nor its sidecar (a legacy segmented recording, or one killed
   * before its first frame). The size is always the file's real size on disk.
   * Without a sidecar (the extension was killed) the geometry and counters come
   * from the last heartbeat's state.json, the duration is unknown and the file
   * is NOT finalized.
   */
  func recordingFile(_ recordingId: String) -> ProovraBroadcastRecordingFile? {
    guard let media = recordingMediaURL(recordingId) else { return nil }
    let sidecar = readRecordingSidecar(recordingId)
    let mediaExists = fm.fileExists(atPath: media.path)
    guard mediaExists || sidecar != nil else { return nil }
    let source = sidecar ?? readState(recordingId) ?? [:]
    return ProovraBroadcastRecordingFile(
      recordingId: recordingId,
      uri: mediaExists ? media.absoluteString : nil,
      sizeBytes: mediaExists ? ProovraBroadcastSpool.fileSize(media) : nil,
      durationMs: sidecar.flatMap { $0["durationMs"] as? Int },
      // 0 = no frame was ever seen: no canvas, stated as null.
      widthPx: (source["widthPx"] as? Int).flatMap { $0 > 0 ? $0 : nil },
      heightPx: (source["heightPx"] as? Int).flatMap { $0 > 0 ? $0 : nil },
      orientationTimeline: (source["orientationTimeline"] as? [[String: Any]]) ?? [],
      pauses: (source["pauses"] as? [[String: Any]]) ?? [],
      droppedFrameCount: (source["droppedFrameCount"] as? Int) ?? 0,
      droppedAudioBufferCount: (source["droppedAudioBufferCount"] as? Int) ?? 0,
      audioTracks: (source["audioTracks"] as? [String]) ?? [],
      finalized: mediaExists && ((sidecar?["finalized"] as? Bool) ?? false),
      sidecarWritten: sidecar != nil
    )
  }

  // MARK: - result.json (finalisation)

  /// Writes the recording's result ONCE. Returns true when this call finalised
  /// it, false when it was already final (the first result stands) or missing.
  @discardableResult
  func finalize(_ recordingId: String, result: [String: Any]) -> Bool {
    guard let dir = directory(for: recordingId), fm.fileExists(atPath: dir.path) else { return false }
    var body = result
    body["recordingId"] = recordingId
    return writeExclusively(body, to: dir.appendingPathComponent(ProovraBroadcastSpool.resultName))
  }

  /// The recording's own result, or nil while it has none.
  func readResult(_ recordingId: String) -> [String: Any]? {
    guard let dir = directory(for: recordingId),
          let obj = readJson(dir.appendingPathComponent(ProovraBroadcastSpool.resultName)),
          (obj["recordingId"] as? String) == recordingId else { return nil }
    return obj
  }

  // MARK: - Recovery listing

  func summary(_ recordingId: String, nowUptime: TimeInterval) -> ProovraBroadcastRecordingSummary? {
    guard let rec = recording(recordingId) else { return nil }
    let live = liveness(recordingId, nowUptime: nowUptime)
    return ProovraBroadcastRecordingSummary(
      recording: rec,
      segmentCount: segments(recordingId, after: -1).count,
      hasRecordingFile: hasRecordingMedia(recordingId),
      active: live.active,
      stale: live.stale,
      finalized: readResult(recordingId) != nil
    )
  }

  func summaries(nowUptime: TimeInterval) -> [ProovraBroadcastRecordingSummary] {
    return recordingIds().compactMap { summary($0, nowUptime: nowUptime) }
  }

  /// Recordings that hold media (the one recording file, or legacy segments)
  /// and are not running: kept until the user recovers or discards them explicitly.
  func recoverable(nowUptime: TimeInterval) -> [ProovraBroadcastRecordingSummary] {
    return summaries(nowUptime: nowUptime).filter { !$0.active && ($0.hasRecordingFile || $0.segmentCount > 0) }
  }

  // MARK: - IO

  private func ensureRoot() -> Bool {
    if fm.fileExists(atPath: root.path) { return true }
    return (try? fm.createDirectory(at: root, withIntermediateDirectories: true)) != nil
  }

  /// mkdir that fails when the directory already exists.
  private func createExclusively(_ dir: URL) -> Bool {
    return (try? fm.createDirectory(at: dir, withIntermediateDirectories: false)) != nil
  }

  @discardableResult
  private func writeJson(_ obj: [String: Any], to url: URL) -> Bool {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return false }
    return (try? data.write(to: url, options: .atomic)) != nil
  }

  /// Write to a private temporary file, then move it into place; the move fails
  /// when the destination exists, so the first writer wins and nothing is replaced.
  private func writeExclusively(_ obj: [String: Any], to url: URL) -> Bool {
    guard !fm.fileExists(atPath: url.path),
          let data = try? JSONSerialization.data(withJSONObject: obj) else { return false }
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".tmp-\(UUID().uuidString)")
    guard (try? data.write(to: tmp, options: .atomic)) != nil else { return false }
    if (try? fm.moveItem(at: tmp, to: url)) != nil { return true }
    try? fm.removeItem(at: tmp)
    return false
  }

  private func readJson(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}
