import ExpoModulesCore
import ReplayKit

/**
 * UC-5 — PROOVRA iOS native screen capture (main-app side).
 *
 * iOS does NOT allow an app to silently capture the whole screen the way Android
 * MediaProjection does. The only user-authorised, system-wide path is a ReplayKit
 * BROADCAST: the user starts and stops it from Apple's own system UI
 * (`RPSystemBroadcastPickerView`), and a separate Broadcast Upload Extension
 * (see BroadcastExtension/SampleHandler.swift) receives the frames. That extension
 * writes bounded ORIGINAL segment files into a shared App Group container and
 * posts a Darwin notification as each segment finalises; this module (the main
 * app) observes the container and re-emits those segments to JS as
 * `onScreenSegment`, and the session summary as `onScreenContinuousStopped` —
 * the SAME event/argument shape the Android continuous module uses, so the shared
 * JS binding and the canonical continuous upload/seal pipeline are reused with no
 * iOS-specific branch.
 *
 * This module exposes ONLY the continuous surface on iOS. The deliberate-frame
 * (UC-2) methods reject on iOS: Apple exposes one user-authorised system-broadcast
 * path, which is inherently continuous, so a single canonical iOS mode
 * (DIRECT_SCREEN_CAPTURE_IOS) is the honest representation. The app never captures
 * outside the OS-authorised broadcast, never bypasses protected (DRM) content,
 * collects no app inventory/clipboard/contacts, and uses no private API.
 */
public class ProovraScreenCaptureModule: Module {
  // The App Group both the app and the broadcast extension share. Must match the
  // `group.<bundle>` value injected into both targets' entitlements by the config
  // plugin (withProovraIosScreenBroadcast).
  private static let appGroup = "group.com.jalalattar29.proovra"
  // The Darwin notification the extension posts as each segment file is finalised.
  private static let segmentReadyNote = "com.proovra.screencapture.ios.segmentReady"
  private static let broadcastFinishedNote = "com.proovra.screencapture.ios.finished"

  private let store = ProovraBroadcastSharedStore(appGroup: ProovraScreenCaptureModule.appGroup)
  private var observing = false
  private var lastEmittedSequence = -1

  public func definition() -> ModuleDefinition {
    Name("ProovraScreenCapture")

    Events("onScreenFrame", "onScreenCaptureStopped", "onScreenSegment", "onScreenContinuousStopped")

    // Capability probes. iOS supports ONLY the continuous (broadcast) mode.
    Function("isSupported") { false }
    Function("isContinuousSupported") {
      if #available(iOS 12.0, *) { return true }
      return false
    }

    Function("getState") { ["active": false, "frameCount": 0] as [String: Any] }
    Function("getContinuousState") { () -> [String: Any] in
      let state = self.store.readState()
      return ["active": state.active, "segmentCount": state.segmentCount]
    }

    // ---- UC-2 deliberate-frame flow: not supported on iOS -----------------
    AsyncFunction("startCapture") { (_: [String: Any?], promise: Promise) in
      promise.reject("UNSUPPORTED", "Deliberate-frame screen capture is not available on iOS. Use continuous capture.")
    }
    AsyncFunction("captureFrame") { (promise: Promise) in
      promise.reject("UNSUPPORTED", "Deliberate-frame screen capture is not available on iOS.")
    }
    AsyncFunction("stop") { (promise: Promise) in
      promise.resolve([String: Any]())
    }

    // ---- UC-5 continuous (system broadcast) flow --------------------------
    AsyncFunction("startContinuousCapture") { (options: [String: Any?], promise: Promise) in
      guard #available(iOS 12.0, *) else {
        promise.reject("UNSUPPORTED", "Requires iOS 12.0+."); return
      }
      // Reset the shared container for a fresh session and begin observing.
      self.store.beginSession(
        segmentMs: (options["segmentMs"] as? Int) ?? 6000,
        maxSegments: (options["maxSegments"] as? Int) ?? 600
      )
      self.lastEmittedSequence = -1
      self.startObserving()
      // Present Apple's SYSTEM broadcast picker on the main thread; the user must
      // tap "Start Broadcast". We cannot force-start a broadcast programmatically
      // (Apple forbids it) and we do not observe frames outside the authorised
      // broadcast — so we report that the picker was presented, not that capture
      // is already active. The `onScreenSegment` events confirm real capture.
      DispatchQueue.main.async {
        ProovraBroadcastPicker.present(preferredExtensionBundleId: "com.jalalattar29.proovra.broadcast")
        promise.resolve([
          "osConsentGranted": true,
          "captureStartedAtUtc": ISO8601DateFormatter().string(from: Date()),
          "segmentMs": (options["segmentMs"] as? Int) ?? 6000,
          "maxSegments": (options["maxSegments"] as? Int) ?? 600,
        ])
      }
    }

    AsyncFunction("stopContinuousCapture") { (promise: Promise) in
      // Ask the extension to finish (it also finishes when the user stops from the
      // system UI). Drain the container, stop observing, and return the summary.
      ProovraDarwinNotify.post(ProovraScreenCaptureModule.broadcastFinishedNote)
      self.drainSegments()
      let result = self.store.readResult()
      self.stopObserving()
      promise.resolve(result.toJsMap())
    }

    OnStartObserving { self.startObserving() }
    OnStopObserving { self.stopObserving() }
  }

  // MARK: - Container observation

  private func startObserving() {
    guard !observing else { return }
    observing = true
    ProovraDarwinNotify.observe(ProovraScreenCaptureModule.segmentReadyNote) { [weak self] in
      self?.drainSegments()
    }
    ProovraDarwinNotify.observe(ProovraScreenCaptureModule.broadcastFinishedNote) { [weak self] in
      guard let self = self else { return }
      self.drainSegments()
      self.sendEvent("onScreenContinuousStopped", self.store.readResult().toJsMap())
    }
  }

  private func stopObserving() {
    guard observing else { return }
    observing = false
    ProovraDarwinNotify.removeAll()
  }

  /// Emit every newly-finalised segment file the extension wrote, in order, once.
  private func drainSegments() {
    let segments = store.readNewSegments(after: lastEmittedSequence)
    for seg in segments {
      lastEmittedSequence = max(lastEmittedSequence, seg.sequence)
      sendEvent("onScreenSegment", seg.toJsMap())
    }
  }
}
