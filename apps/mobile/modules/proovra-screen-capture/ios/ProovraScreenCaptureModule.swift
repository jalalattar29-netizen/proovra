import ExpoModulesCore
import ReplayKit

/**
 * UC-5 — PROOVRA iOS native screen capture (main-app side).
 *
 * iOS does NOT allow an app to silently capture the whole screen the way Android
 * MediaProjection does. The only user-authorised, system-wide path is a ReplayKit
 * BROADCAST: the user starts and stops it from Apple's own system UI
 * (`RPSystemBroadcastPickerView`), and a separate Broadcast Upload Extension
 * (see plugins/broadcast-extension/SampleHandler.swift) receives the frames. That
 * extension writes bounded ORIGINAL segment files into a shared App Group
 * container and posts Darwin notifications; this module (the main app) observes
 * the container and re-emits those segments to JS as `onScreenSegment`, the start
 * as `onScreenContinuousStarted` and the session summary as
 * `onScreenContinuousStopped` — the SAME event/argument shapes the Android module
 * uses, so the shared JS binding and the canonical continuous pipeline are reused.
 *
 * This module exposes ONLY the continuous surface on iOS; the deliberate-frame
 * (UC-2) methods reject. The app never captures outside the OS-authorised
 * broadcast, never bypasses protected (DRM) content, collects no app
 * inventory/clipboard/contacts, and uses no private API.
 *
 * One recording (2026-10-29, wire contract B): the extension writes ONE
 * fragmented MP4 per broadcast and emits no per-segment events for it. The stop
 * result (and `onScreenContinuousStopped`) carries `layout: "SINGLE_FILE"`,
 * `recordingUri`, its size/duration/canvas, `orientationTimeline`, `pauses`,
 * `droppedFrameCount`, `audioTracks` and `finalized`. `segmentReady` /
 * `onScreenSegment` remain only for a recording an older, segmenting extension
 * left on the device. `startContinuousCapture({ microphone })` is ignored here:
 * on iOS the microphone is the user's own choice in Apple's broadcast picker.
 *
 * Remediation (2026-09-30):
 *   UC-IOS-002  stop is a real handshake: post the extension's stop note, wait
 *               (bounded) for its result.json, then drain and resolve.
 *   UC-IOS-005  start resolves `awaitingSystemStart: true` when the picker is
 *               presented; the extension's `started` note emits
 *               onScreenContinuousStarted.
 *   UC-IOS-006  a missing result is summarised from what was written, never
 *               fabricated (ProovraBroadcastSharedStore.readResult).
 *   UC-IOS-010  start refuses to wipe a spool that still holds a recording;
 *               `discardContinuousSpool` is the explicit discard, and
 *               `getContinuousSegments` lets a relaunched UI recover it.
 *   UC-IOS-012  one stable Darwin observer; draining is serialised on one queue.
 *   UC-AND-014  the frame stop is `stopCapture`, the JS binding's name.
 *
 * AUD-006 (2026-10-15): one spool namespace per broadcast
 * (ProovraBroadcastSpool.swift). Start writes the binding before the picker and
 * returns its recordingId; `started` names the recording and its binding;
 * segments, state, stop, result and discard are all scoped by recordingId;
 * `bindContinuousSession` records the capture session on a BOUND recording only;
 * `listContinuousRecordings` lists what is left for explicit recovery/discard.
 */
public class ProovraScreenCaptureModule: Module {
  // The App Group both the app and the broadcast extension share. Must match the
  // `group.<bundle>` value injected into both targets' entitlements by the config
  // plugin (withProovraIosScreenBroadcast).
  private static let appGroup = "group.com.jalalattar29.proovra"
  private static let extensionBundleId = "com.jalalattar29.proovra.broadcast"
  /// How long a stop waits for the extension's result.json before summarising
  /// what exists: the extension may spend up to 10 s finishing the one file.
  private static let stopWaitSeconds: TimeInterval = 15

  private let store = ProovraBroadcastSharedStore(appGroup: ProovraScreenCaptureModule.appGroup)
  /// UC-IOS-012 — every read of the container and every segment emission runs here.
  private let drainQueue = DispatchQueue(label: "com.proovra.screencapture.drain")
  private var observing = false
  private var lastEmittedSequence = -1
  /// AUD-006 — the recording this instance prepared, bound or is stopping (guarded by drainQueue).
  private var focusRecordingId: String?

  public func definition() -> ModuleDefinition {
    Name("ProovraScreenCapture")

    Events(
      "onScreenFrame", "onScreenCaptureStopped", "onScreenSegment", "onScreenContinuousStopped",
      "onScreenContinuousStarted"
    )

    // Capability probes. iOS supports ONLY the continuous (broadcast) mode.
    Function("isSupported") { false }
    Function("isContinuousSupported") { () -> Bool in
      if #available(iOS 12.0, *) { return true }
      return false
    }

    Function("getState") { ["active": false, "frameCount": 0] as [String: Any] }
    // AUD-006 — every continuous read names ONE recording. A nil `recordingId`
    // means the recording this app instance prepared or bound, else the
    // broadcast running now. The state says whose recording it is.
    Function("getContinuousState") { (recordingId: String?) -> [String: Any] in
      return self.store.readState(recordingId: recordingId ?? self.focus()).toJsMap()
    }
    Function("getContinuousSegments") { (recordingId: String?) -> [[String: Any]] in
      guard let id = recordingId ?? self.focus() else { return [] }
      return self.store.readNewSegments(recordingId: id, after: -1).map { $0.toJsMap() }
    }
    /// AUD-006 — every recording on this device, for EXPLICIT recovery or discard.
    Function("listContinuousRecordings") { () -> [[String: Any]] in
      return self.store.listRecordings().map { $0.toJsMap() }
    }

    // ---- UC-2 deliberate-frame flow: not supported on iOS -----------------
    AsyncFunction("startCapture") { (_: [String: Any?], promise: Promise) in
      promise.reject("UNSUPPORTED", "Deliberate-frame screen capture is not available on iOS. Use continuous capture.")
    }
    AsyncFunction("captureFrame") { (promise: Promise) in
      promise.reject("UNSUPPORTED", "Deliberate-frame screen capture is not available on iOS.")
    }
    // UC-AND-014 — the JS binding calls `stopCapture` (the F5 name on Android).
    AsyncFunction("stopCapture") { (promise: Promise) in
      promise.reject("UNSUPPORTED", "Deliberate-frame screen capture is not available on iOS.")
    }

    // ---- UC-5 continuous (system broadcast) flow --------------------------
    AsyncFunction("startContinuousCapture") { (options: [String: Any?], promise: Promise) in
      guard #available(iOS 12.0, *) else {
        promise.reject("UNSUPPORTED", "Requires iOS 12.0+."); return
      }
      if self.store.liveRecordingId() != nil {
        promise.reject("BUSY", "A screen broadcast is already running."); return
      }
      // UC-IOS-010 — a recording nobody staged or discarded is offered first.
      if self.store.hasPendingRecording() {
        promise.reject("PENDING_RECORDING", "A previous recording is still on this device. Recover or discard it first."); return
      }
      let segmentMs = min(max((options["segmentMs"] as? Int) ?? ProovraBroadcastLimits.defaultSegmentMs, 2000), 30000)
      let maxSegments = min(max((options["maxSegments"] as? Int) ?? ProovraBroadcastLimits.maxSegments, 1),
                            ProovraBroadcastLimits.maxSegments)
      // AUD-006 — the binding is written BEFORE the picker: only the broadcast
      // that adopts it is this recording; any other one gets its own namespace.
      guard let recordingId = self.store.prepareRecording(segmentMs: segmentMs, maxSegments: maxSegments) else {
        promise.reject("SPOOL_UNAVAILABLE", "The shared recording container is not available."); return
      }
      self.setFocus(recordingId)
      self.startObserving()
      // Present Apple's SYSTEM broadcast picker on the main thread. Presenting is
      // not consent and not a start (UC-IOS-005): the extension's `started` note
      // does that, and JS waits for it.
      DispatchQueue.main.async {
        let presented = ProovraBroadcastPicker.present(preferredExtensionBundleId: ProovraScreenCaptureModule.extensionBundleId)
        guard presented else {
          self.store.withdrawPendingBinding(recordingId: recordingId)
          promise.reject("PICKER_UNAVAILABLE", "Apple's broadcast picker could not be shown."); return
        }
        promise.resolve([
          "osConsentGranted": false,
          "captureStartedAtUtc": NSNull(),
          "awaitingSystemStart": true,
          "segmentMs": segmentMs,
          "maxSegments": maxSegments,
          "recordingId": recordingId,
        ])
      }
    }

    /// AUD-006 — record which capture session holds a recording. Refuses a
    /// recording PROOVRA did not request (Control Center) and a second session.
    AsyncFunction("bindContinuousSession") { (recordingId: String, captureSessionId: String, promise: Promise) in
      switch self.store.bindCaptureSession(recordingId: recordingId, captureSessionId: captureSessionId) {
      case .bound:
        self.setFocus(recordingId)
        promise.resolve(["recordingId": recordingId, "captureSessionId": captureSessionId])
      case .refusedUnbound:
        promise.reject("BINDING_REFUSED", "This recording was not started from PROOVRA, so it cannot be attached to a capture session.")
      case .refusedOtherSession:
        promise.reject("BINDING_REFUSED", "This recording belongs to a different capture session.")
      case .missing:
        promise.reject("RECORDING_NOT_FOUND", "This recording is no longer on this device.")
      }
    }

    AsyncFunction("stopContinuousCapture") { (recordingId: String?, promise: Promise) in
      let target = recordingId ?? self.focus()
      guard let id = target, self.store.recordingExists(id) else {
        // No broadcast ever adopted this binding (picker cancelled / timed out):
        // withdraw it so no later broadcast can.
        if let id = target { self.store.withdrawPendingBinding(recordingId: id) }
        DispatchQueue.main.async { ProovraBroadcastPicker.dismiss() }
        self.stopObserving()
        promise.resolve(self.store.readResult(recordingId: nil).toJsMap())
        return
      }
      self.setFocus(id)
      // UC-IOS-002 — ask the EXTENSION to stop (it observes this note), then wait
      // bounded for the result it writes. The note reaches whichever broadcast is
      // running, so it is posted only when that broadcast IS this recording.
      if self.store.liveRecordingId() == id {
        ProovraDarwinNotify.post(ProovraBroadcastNotes.stopRequested)
      }
      DispatchQueue.global().async {
        let deadline = Date().addingTimeInterval(ProovraScreenCaptureModule.stopWaitSeconds)
        while self.store.readWrittenResult(recordingId: id) == nil && Date() < deadline
                && self.store.readState(recordingId: id).active {
          Thread.sleep(forTimeInterval: 0.2)
        }
        self.drainSegments()
        // Idempotent: the recording's ONE result (or its honest summary).
        let result = self.store.readResult(recordingId: id)
        DispatchQueue.main.async { ProovraBroadcastPicker.dismiss() }
        self.stopObserving()
        promise.resolve(result.toJsMap())
      }
    }

    /// UC-IOS-010 — the user's explicit discard of ONE leftover recording.
    AsyncFunction("discardContinuousSpool") { (recordingId: String?, promise: Promise) in
      guard let id = recordingId ?? self.focus() else { promise.resolve(); return }
      if self.store.liveRecordingId() == id {
        promise.reject("BUSY", "Stop the broadcast before discarding it."); return
      }
      self.store.discard(recordingId: id)
      self.clearFocus(ifEqual: id)
      promise.resolve()
    }

    /// STREAMING SHA-256 + MD5 of a capture file (1 MiB chunks, off the main
    /// thread): the integrity claim of a long recording without holding it in
    /// JS memory (ProovraFileDigest.swift).
    AsyncFunction("hashFile") { (uri: String, promise: Promise) in
      DispatchQueue.global(qos: .utility).async {
        do {
          promise.resolve(try ProovraFileDigest.digest(uri: uri).toJsMap())
        } catch ProovraFileDigest.Failure.notFound {
          promise.reject("FILE_NOT_FOUND", "The file to hash is not on this device.")
        } catch {
          promise.reject("HASH_FAILED", "The file could not be read to compute its digest.")
        }
      }
    }

    OnStartObserving { self.startObserving() }
    OnStopObserving { self.stopObserving() }
  }

  // MARK: - Focus (AUD-006): the ONE recording this app instance drains

  private func focus() -> String? {
    return drainQueue.sync { focusRecordingId }
  }

  private func setFocus(_ recordingId: String) {
    drainQueue.sync {
      if focusRecordingId != recordingId {
        focusRecordingId = recordingId
        lastEmittedSequence = -1
      }
    }
  }

  private func clearFocus(ifEqual recordingId: String) {
    drainQueue.sync {
      if focusRecordingId == recordingId {
        focusRecordingId = nil
        lastEmittedSequence = -1
      }
    }
  }

  private func startObserving() {
    guard !observing else { return }
    observing = true
    let bridge = ProovraDarwinNotify.shared
    bridge.observe(ProovraBroadcastNotes.segmentReady) { [weak self] in
      self?.drainSegments()
    }
    bridge.observe(ProovraBroadcastNotes.started) { [weak self] in
      guard let self = self else { return }
      DispatchQueue.main.async { ProovraBroadcastPicker.dismiss() }
      // AUD-006 — say WHICH recording started and how it is bound; JS opens a
      // capture session only for the one it prepared, never for another broadcast.
      let state = self.store.readState(recordingId: nil)
      guard let recordingId = state.recordingId else { return }
      let started = state.startedAtUtc ?? ISO8601DateFormatter().string(from: Date())
      self.sendEvent("onScreenContinuousStarted", [
        "captureStartedAtUtc": started,
        "recordingId": recordingId,
        "binding": state.binding,
        "appRequested": state.appRequested,
      ])
    }
    bridge.observe(ProovraBroadcastNotes.finished) { [weak self] in
      guard let self = self, let recordingId = self.focus(),
            let result = self.store.readWrittenResult(recordingId: recordingId) else { return }
      self.drainSegments()
      self.sendEvent("onScreenContinuousStopped", result.toJsMap())
    }
  }

  private func stopObserving() {
    guard observing else { return }
    observing = false
    ProovraDarwinNotify.shared.removeAll()
  }

  /// Emit every newly-finalised segment of the FOCUSED recording, in order,
  /// once — serialised on one queue whatever thread asked (UC-IOS-012).
  private func drainSegments() {
    drainQueue.sync {
      guard let recordingId = focusRecordingId else { return }
      let segments = store.readNewSegments(recordingId: recordingId, after: lastEmittedSequence)
      for seg in segments {
        lastEmittedSequence = max(lastEmittedSequence, seg.sequence)
        sendEvent("onScreenSegment", seg.toJsMap())
      }
    }
  }
}
