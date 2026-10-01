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
 */
public class ProovraScreenCaptureModule: Module {
  // The App Group both the app and the broadcast extension share. Must match the
  // `group.<bundle>` value injected into both targets' entitlements by the config
  // plugin (withProovraIosScreenBroadcast).
  private static let appGroup = "group.com.jalalattar29.proovra"
  private static let extensionBundleId = "com.jalalattar29.proovra.broadcast"
  /// How long a stop waits for the extension's result.json before summarising what exists.
  private static let stopWaitSeconds: TimeInterval = 6

  private let store = ProovraBroadcastSharedStore(appGroup: ProovraScreenCaptureModule.appGroup)
  /// UC-IOS-012 — every read of the container and every segment emission runs here.
  private let drainQueue = DispatchQueue(label: "com.proovra.screencapture.drain")
  private var observing = false
  private var lastEmittedSequence = -1

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
    Function("getContinuousState") { () -> [String: Any] in
      let state = self.store.readState()
      return ["active": state.active, "segmentCount": state.segmentCount, "stale": state.stale]
    }
    Function("getContinuousSegments") { () -> [[String: Any]] in
      return self.store.readNewSegments(after: -1).map { $0.toJsMap() }
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
      if self.store.readState().active {
        promise.reject("BUSY", "A screen broadcast is already running."); return
      }
      // UC-IOS-010 — never wipe a recording nobody staged or discarded.
      if self.store.hasPendingRecording() {
        promise.reject("PENDING_RECORDING", "A previous recording is still on this device. Recover or discard it first."); return
      }
      let segmentMs = min(max((options["segmentMs"] as? Int) ?? ProovraBroadcastLimits.defaultSegmentMs, 2000), 30000)
      let maxSegments = min(max((options["maxSegments"] as? Int) ?? ProovraBroadcastLimits.maxSegments, 1),
                            ProovraBroadcastLimits.maxSegments)
      self.store.beginSession(segmentMs: segmentMs, maxSegments: maxSegments)
      self.drainQueue.sync { self.lastEmittedSequence = -1 }
      self.startObserving()
      // Present Apple's SYSTEM broadcast picker on the main thread. Presenting is
      // not consent and not a start (UC-IOS-005): the extension's `started` note
      // does that, and JS waits for it.
      DispatchQueue.main.async {
        let presented = ProovraBroadcastPicker.present(preferredExtensionBundleId: ProovraScreenCaptureModule.extensionBundleId)
        guard presented else {
          promise.reject("PICKER_UNAVAILABLE", "Apple's broadcast picker could not be shown."); return
        }
        promise.resolve([
          "osConsentGranted": false,
          "captureStartedAtUtc": NSNull(),
          "awaitingSystemStart": true,
          "segmentMs": segmentMs,
          "maxSegments": maxSegments,
        ])
      }
    }

    AsyncFunction("stopContinuousCapture") { (promise: Promise) in
      // UC-IOS-002 — ask the EXTENSION to stop (it observes this note), then wait
      // bounded for the result it writes. The broadcast indicator goes away
      // because the extension itself finishes the broadcast.
      if self.store.readState().active {
        ProovraDarwinNotify.post(ProovraBroadcastNotes.stopRequested)
      }
      DispatchQueue.global().async {
        let deadline = Date().addingTimeInterval(ProovraScreenCaptureModule.stopWaitSeconds)
        while self.store.readWrittenResult() == nil && Date() < deadline && self.store.readState().active {
          Thread.sleep(forTimeInterval: 0.2)
        }
        self.drainSegments()
        let result = self.store.readResult()
        DispatchQueue.main.async { ProovraBroadcastPicker.dismiss() }
        self.stopObserving()
        promise.resolve(result.toJsMap())
      }
    }

    /// UC-IOS-010 — the user's explicit discard of a leftover recording.
    AsyncFunction("discardContinuousSpool") { (promise: Promise) in
      if self.store.readState().active {
        promise.reject("BUSY", "Stop the broadcast before discarding it."); return
      }
      self.store.discardSpool()
      self.drainQueue.sync { self.lastEmittedSequence = -1 }
      promise.resolve()
    }

    OnStartObserving { self.startObserving() }
    OnStopObserving { self.stopObserving() }
  }

  // MARK: - Container observation

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
      let started = self.store.readState().startedAtUtc ?? ISO8601DateFormatter().string(from: Date())
      self.sendEvent("onScreenContinuousStarted", ["captureStartedAtUtc": started])
    }
    bridge.observe(ProovraBroadcastNotes.finished) { [weak self] in
      guard let self = self else { return }
      self.drainSegments()
      self.sendEvent("onScreenContinuousStopped", self.store.readResult().toJsMap())
    }
  }

  private func stopObserving() {
    guard observing else { return }
    observing = false
    ProovraDarwinNotify.shared.removeAll()
  }

  /// Emit every newly-finalised segment the extension wrote, in order, once —
  /// serialised on one queue whatever thread asked (UC-IOS-012).
  private func drainSegments() {
    drainQueue.sync {
      let segments = store.readNewSegments(after: lastEmittedSequence)
      for seg in segments {
        lastEmittedSequence = max(lastEmittedSequence, seg.sequence)
        sendEvent("onScreenSegment", seg.toJsMap())
      }
    }
  }
}
