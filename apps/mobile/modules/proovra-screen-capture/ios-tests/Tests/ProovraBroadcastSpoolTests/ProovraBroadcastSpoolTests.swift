import Foundation
import XCTest

@testable import BroadcastSpool

/// AUD-006 — the iOS broadcast spool, on a real file system. The package
/// compiles the SHIPPED ProovraBroadcastSpool.swift (copied in by
/// native-build.yml), the same file the app module and the ProovraBroadcast
/// extension compile.
///
/// The defect: one fixed `uc5-broadcast/` directory. A Control Center
/// broadcast over a leftover recording restarted at seg-0 and overwrote it,
/// left the old seg-k and result.json in place, the reader mixed both, and any
/// `started` note was attached to whatever capture session the app held.
final class ProovraBroadcastSpoolTests: XCTestCase {
  private var root: URL!
  private var spool: ProovraBroadcastSpool!
  private let fm = FileManager.default

  override func setUp() {
    super.setUp()
    root = fm.temporaryDirectory
      .appendingPathComponent("proovra-spool-\(UUID().uuidString)", isDirectory: true)
      .appendingPathComponent(ProovraBroadcastSpool.rootDirectoryName, isDirectory: true)
    spool = ProovraBroadcastSpool(root: root)
  }

  override func tearDown() {
    try? fm.removeItem(at: root.deletingLastPathComponent())
    super.tearDown()
  }

  // MARK: - helpers

  private func binding(_ id: String = UUID().uuidString, uptime: TimeInterval) -> ProovraBroadcastBinding {
    return ProovraBroadcastBinding(
      recordingId: id,
      captureSessionId: nil,
      appRequested: true,
      createdAtUtc: "2026-10-15T10:00:00Z",
      createdAtUptime: uptime,
      segmentMs: 4000,
      maxSegments: 50
    )
  }

  private func openBroadcast(at uptime: TimeInterval) -> ProovraBroadcastRecording {
    let rec = spool.openRecording(nowUptime: uptime, nowUtc: "2026-10-15T10:00:05Z")
    XCTAssertNotNil(rec, "a broadcast always gets a namespace")
    return rec!
  }

  private func sidecar(_ seq: Int) -> [String: Any] {
    return ["startedAtOffsetMs": seq * 6000, "durationMs": 6000, "widthPx": 1179, "heightPx": 2556, "orientation": "portrait"]
  }

  @discardableResult
  private func writeSegment(_ id: String, _ seq: Int, bytes: [UInt8] = [0x01]) -> Bool {
    guard let media = spool.segmentMediaURL(id, sequence: seq) else { return false }
    fm.createFile(atPath: media.path, contents: Data(bytes))
    return spool.publishSegment(id, sequence: seq, sidecar: sidecar(seq))
  }

  private func flags(_ r: (active: Bool, stale: Bool)) -> [Bool] {
    return [r.active, r.stale]
  }

  private func beat(_ id: String, active: Bool, uptime: TimeInterval) {
    spool.updateState(id, ["active": active, "heartbeatUptime": uptime, "startedAtUtc": "2026-10-15T10:00:05Z"])
  }

  // MARK: - binding adoption

  func testTheAppBindingIsAdoptedOnceAndConsumed() {
    let b = binding(uptime: 100)
    XCTAssertTrue(spool.writePendingBinding(b))
    let first = openBroadcast(at: 110)
    XCTAssertEqual(first.recordingId, b.recordingId)
    XCTAssertEqual(first.binding, .bound)
    XCTAssertTrue(first.appRequested)
    XCTAssertEqual(first.segmentMs, 4000, "the app's bounds travel with the binding")
    XCTAssertEqual(first.maxSegments, 50)
    XCTAssertNil(spool.pendingBinding(), "adoption consumes the binding")

    let second = openBroadcast(at: 111)
    XCTAssertNotEqual(second.recordingId, b.recordingId, "a consumed binding is never adopted twice")
    XCTAssertEqual(second.binding, .unbound)
    XCTAssertFalse(second.appRequested)
  }

  func testAControlCenterBroadcastIsUnboundAndCannotBeAttachedToASession() {
    let rec = openBroadcast(at: 50)
    XCTAssertEqual(rec.binding, .unbound)
    XCTAssertFalse(rec.appRequested)
    XCTAssertNil(rec.captureSessionId)
    XCTAssertEqual(spool.bindCaptureSession(recordingId: rec.recordingId, captureSessionId: "cs-1"), .refusedUnbound)
    XCTAssertNil(spool.recording(rec.recordingId)?.captureSessionId)
  }

  func testAStaleBindingIsNotAdoptedAndIsStillConsumed() {
    let b = binding(uptime: 100)
    spool.writePendingBinding(b)
    let rec = openBroadcast(at: 100 + ProovraBroadcastSpool.bindingFreshSeconds + 1)
    XCTAssertEqual(rec.binding, .unbound)
    XCTAssertNotEqual(rec.recordingId, b.recordingId)
    XCTAssertNil(spool.pendingBinding(), "a stale binding cannot be adopted later either")
  }

  func testABindingFromBeforeARebootIsNotFresh() {
    spool.writePendingBinding(binding(uptime: 5000))
    XCTAssertEqual(openBroadcast(at: 12).binding, .unbound, "uptime restarted: the binding is from an earlier boot")
    XCTAssertFalse(ProovraBroadcastSpool.isBindingFresh(createdAtUptime: 5000, nowUptime: 12))
    XCTAssertTrue(ProovraBroadcastSpool.isBindingFresh(createdAtUptime: 10, nowUptime: 12))
  }

  func testAWithdrawnBindingCannotBeAdopted() {
    let b = binding(uptime: 100)
    spool.writePendingBinding(b)
    XCTAssertFalse(spool.withdrawPendingBinding(recordingId: UUID().uuidString), "only the named binding is withdrawn")
    XCTAssertNotNil(spool.pendingBinding())
    XCTAssertTrue(spool.withdrawPendingBinding(recordingId: b.recordingId))
    XCTAssertEqual(openBroadcast(at: 101).binding, .unbound)
  }

  func testAnExistingNamespaceIsNeverReused() {
    let first = openBroadcast(at: 10)
    writeSegment(first.recordingId, 0)
    // A binding that (wrongly) names an existing recording does not reopen it.
    spool.writePendingBinding(binding(first.recordingId, uptime: 20))
    let second = openBroadcast(at: 21)
    XCTAssertNotEqual(second.recordingId, first.recordingId)
    XCTAssertEqual(second.binding, .unbound)
    XCTAssertEqual(spool.segments(first.recordingId, after: -1).count, 1, "the earlier recording is untouched")
  }

  // MARK: - two broadcasts, stale content

  func testTwoBroadcastsNeverMixSegmentsOrResults() {
    spool.writePendingBinding(binding(uptime: 100))
    let a = openBroadcast(at: 101)
    XCTAssertTrue(writeSegment(a.recordingId, 0, bytes: [0xA0]))
    XCTAssertTrue(writeSegment(a.recordingId, 1, bytes: [0xA1]))
    XCTAssertTrue(spool.finalize(a.recordingId, result: ["terminationReason": "USER_STOPPED", "segmentCount": 2]))

    // A second broadcast (Control Center) over the existing spool.
    let b = openBroadcast(at: 200)
    XCTAssertNotEqual(a.recordingId, b.recordingId)
    XCTAssertEqual(spool.nextSequence(b.recordingId), 0, "a new broadcast starts its OWN sequence")
    XCTAssertTrue(writeSegment(b.recordingId, 0, bytes: [0xB0]))

    let segA = spool.segments(a.recordingId, after: -1)
    let segB = spool.segments(b.recordingId, after: -1)
    XCTAssertEqual(segA.map { $0.sequence }, [0, 1])
    XCTAssertEqual(segB.map { $0.sequence }, [0])
    XCTAssertTrue(segA.allSatisfy { $0.recordingId == a.recordingId })
    XCTAssertTrue(segB.allSatisfy { $0.recordingId == b.recordingId })
    XCTAssertEqual(try Data(contentsOf: URL(string: segA[0].uri)!), Data([0xA0]), "A's seg-0 was not overwritten by B's")
    XCTAssertEqual(try Data(contentsOf: URL(string: segB[0].uri)!), Data([0xB0]))

    XCTAssertNil(spool.readResult(b.recordingId), "B has no result yet — A's is never returned for it")
    XCTAssertEqual(spool.readResult(a.recordingId)?["recordingId"] as? String, a.recordingId)
    XCTAssertTrue(spool.finalize(b.recordingId, result: ["terminationReason": "ERROR"]))
    XCTAssertEqual(spool.readResult(b.recordingId)?["terminationReason"] as? String, "ERROR")
    XCTAssertEqual(spool.readResult(a.recordingId)?["terminationReason"] as? String, "USER_STOPPED")
    XCTAssertEqual(spool.recordingIds().count, 2)
  }

  func testStaleAppGroupContentFromTheFixedLayoutIsNeverRead() throws {
    // What the pre-AUD-006 extension left directly under uc5-broadcast/.
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    for name in ["seg-0.mp4", "seg-1.mp4"] { fm.createFile(atPath: root.appendingPathComponent(name).path, contents: Data([0xEE])) }
    let legacy: [String: Any] = ["sequence": 0, "startedAtOffsetMs": 0, "durationMs": 6000, "widthPx": 1, "heightPx": 2, "orientation": "portrait"]
    try JSONSerialization.data(withJSONObject: legacy).write(to: root.appendingPathComponent("seg-0.json"))
    try JSONSerialization.data(withJSONObject: ["terminationReason": "USER_STOPPED", "startedAtUtc": "x", "endedAtUtc": "y"])
      .write(to: root.appendingPathComponent("result.json"))
    try JSONSerialization.data(withJSONObject: ["active": true, "appRequested": true]).write(to: root.appendingPathComponent("state.json"))
    // Directories that are not canonical recording ids.
    for name in ["not-a-uuid", UUID().uuidString.lowercased()] {
      try fm.createDirectory(at: root.appendingPathComponent(name), withIntermediateDirectories: true)
    }

    let rec = openBroadcast(at: 10)
    XCTAssertEqual(rec.binding, .unbound, "a stale state.json's appRequested is not a binding")
    XCTAssertEqual(spool.nextSequence(rec.recordingId), 0)
    XCTAssertEqual(spool.segments(rec.recordingId, after: -1).count, 0)
    XCTAssertNil(spool.readResult(rec.recordingId))
    XCTAssertEqual(spool.recordingIds(), [rec.recordingId])
    XCTAssertNil(spool.directory(for: "../etc"))
    XCTAssertNil(spool.directory(for: rec.recordingId.lowercased()))
  }

  func testASidecarNamingAnotherRecordingIsNotItsSegment() throws {
    let a = openBroadcast(at: 1)
    let b = openBroadcast(at: 2)
    writeSegment(a.recordingId, 0)
    let dirB = try XCTUnwrap(spool.directory(for: b.recordingId))
    let dirA = try XCTUnwrap(spool.directory(for: a.recordingId))
    try fm.copyItem(at: dirA.appendingPathComponent("seg-0.json"), to: dirB.appendingPathComponent("seg-0.json"))
    try fm.copyItem(at: dirA.appendingPathComponent("seg-0.mp4"), to: dirB.appendingPathComponent("seg-0.mp4"))
    XCTAssertEqual(spool.segments(b.recordingId, after: -1).count, 0)
  }

  // MARK: - sequence continuity

  func testAPublishedSegmentIsNeverOverwritten() throws {
    let rec = openBroadcast(at: 1)
    XCTAssertTrue(spool.isSegmentSlotFree(rec.recordingId, sequence: 0))
    XCTAssertTrue(writeSegment(rec.recordingId, 0))
    XCTAssertFalse(spool.isSegmentSlotFree(rec.recordingId, sequence: 0))
    let sidecarURL = try XCTUnwrap(spool.directory(for: rec.recordingId)).appendingPathComponent("seg-0.json")
    let before = try Data(contentsOf: sidecarURL)
    var other = sidecar(0)
    other["durationMs"] = 1
    XCTAssertFalse(spool.publishSegment(rec.recordingId, sequence: 0, sidecar: other), "a second publish of seq 0 is refused")
    XCTAssertEqual(try Data(contentsOf: sidecarURL), before)
  }

  func testRestartContinuesTheSequenceAndTheReaderStopsAtAGap() {
    let rec = openBroadcast(at: 1)
    writeSegment(rec.recordingId, 0)
    writeSegment(rec.recordingId, 1)
    XCTAssertEqual(spool.nextSequence(rec.recordingId), 2)
    // An unpublished leftover media file still blocks its slot.
    fm.createFile(atPath: spool.segmentMediaURL(rec.recordingId, sequence: 3)!.path, contents: Data([0x00]))
    XCTAssertEqual(spool.nextSequence(rec.recordingId), 4)
    XCTAssertEqual(spool.segments(rec.recordingId, after: -1).map { $0.sequence }, [0, 1])
    XCTAssertEqual(spool.segments(rec.recordingId, after: 0).map { $0.sequence }, [1])
  }

  // MARK: - finalisation

  func testFinalizationIsIdempotentAndNamesTheRecording() {
    let rec = openBroadcast(at: 1)
    XCTAssertNil(spool.readResult(rec.recordingId))
    XCTAssertTrue(spool.finalize(rec.recordingId, result: ["terminationReason": "USER_STOPPED"]))
    XCTAssertFalse(spool.finalize(rec.recordingId, result: ["terminationReason": "ERROR"]), "the first result stands")
    let result = spool.readResult(rec.recordingId)
    XCTAssertEqual(result?["terminationReason"] as? String, "USER_STOPPED")
    XCTAssertEqual(result?["recordingId"] as? String, rec.recordingId)
    XCTAssertFalse(spool.finalize(UUID().uuidString, result: [:]), "no result for a recording that does not exist")
  }

  // MARK: - interruption, liveness, recovery

  func testLivenessUsesTheMonotonicHeartbeat() {
    XCTAssertEqual(flags(ProovraBroadcastSpool.liveness(stateActive: false, heartbeatUptime: 10, nowUptime: 11)), [false, false])
    XCTAssertEqual(flags(ProovraBroadcastSpool.liveness(stateActive: true, heartbeatUptime: nil, nowUptime: 11)), [false, true])
    XCTAssertEqual(flags(ProovraBroadcastSpool.liveness(stateActive: true, heartbeatUptime: 100, nowUptime: 110)), [true, false])
    XCTAssertEqual(flags(ProovraBroadcastSpool.liveness(stateActive: true, heartbeatUptime: 100,
                                                 nowUptime: 100 + ProovraBroadcastSpool.staleAfterSeconds + 1)), [false, true])
    XCTAssertEqual(flags(ProovraBroadcastSpool.liveness(stateActive: true, heartbeatUptime: 900, nowUptime: 20)), [false, true],
                  "a heartbeat from before a reboot is stale, whatever the wall clock says")
  }

  func testAnInterruptedRecordingIsPreservedAndListedForRecovery() {
    spool.writePendingBinding(binding(uptime: 100))
    let rec = openBroadcast(at: 100)
    writeSegment(rec.recordingId, 0)
    writeSegment(rec.recordingId, 1)
    beat(rec.recordingId, active: true, uptime: 105)

    XCTAssertEqual(spool.liveRecordingId(nowUptime: 110), rec.recordingId)
    XCTAssertTrue(spool.recoverable(nowUptime: 110).isEmpty, "a live broadcast is not a leftover")

    // The extension died: no heartbeat, no result.
    let later: TimeInterval = 105 + ProovraBroadcastSpool.staleAfterSeconds + 5
    XCTAssertNil(spool.liveRecordingId(nowUptime: later))
    let recoverable = spool.recoverable(nowUptime: later)
    XCTAssertEqual(recoverable.map { $0.recording.recordingId }, [rec.recordingId])
    XCTAssertEqual(recoverable.first?.segmentCount, 2)
    XCTAssertEqual(recoverable.first?.stale, true)
    XCTAssertEqual(recoverable.first?.finalized, false)
    XCTAssertEqual(recoverable.first?.recording.binding, .bound)
    XCTAssertEqual(spool.segments(rec.recordingId, after: -1).count, 2, "nothing is deleted without an explicit discard")

    // The next broadcast does not touch it.
    let next = openBroadcast(at: later + 1)
    writeSegment(next.recordingId, 0)
    XCTAssertEqual(spool.segments(rec.recordingId, after: -1).count, 2)
  }

  func testTheCaptureSessionBindingIsIdempotentAndExclusive() {
    spool.writePendingBinding(binding(uptime: 1))
    let rec = openBroadcast(at: 2)
    XCTAssertEqual(spool.bindCaptureSession(recordingId: rec.recordingId, captureSessionId: "cs-1"), .bound)
    XCTAssertEqual(spool.bindCaptureSession(recordingId: rec.recordingId, captureSessionId: "cs-1"), .bound)
    XCTAssertEqual(spool.bindCaptureSession(recordingId: rec.recordingId, captureSessionId: "cs-2"), .refusedOtherSession)
    XCTAssertEqual(spool.recording(rec.recordingId)?.captureSessionId, "cs-1")
    XCTAssertEqual(spool.bindCaptureSession(recordingId: UUID().uuidString, captureSessionId: "cs-1"), .missing)
  }

  func testDiscardRemovesOnlyTheNamedRecording() {
    let a = openBroadcast(at: 1)
    let b = openBroadcast(at: 2)
    writeSegment(a.recordingId, 0)
    writeSegment(b.recordingId, 0)
    XCTAssertTrue(spool.discard(recordingId: a.recordingId))
    XCTAssertNil(spool.recording(a.recordingId))
    XCTAssertEqual(spool.segments(b.recordingId, after: -1).count, 1)
    XCTAssertFalse(spool.discard(recordingId: "../\(b.recordingId)"))
    XCTAssertEqual(spool.recordingIds(), [b.recordingId])
  }
}
