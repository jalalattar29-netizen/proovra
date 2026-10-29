package com.proovra.screencapture

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * UC-2 + UC-3 — Android screen-capture Expo module.
 *
 * Coordinates the MediaProjection CONSENT (a system dialog — nothing is captured
 * before the user grants it), then hands the granted token to the right
 * foreground service:
 *   - UC-2: [ScreenCaptureService] — the user takes deliberate frames on demand.
 *   - UC-3: [ContinuousScreenCaptureService] — a bounded continuous recording as
 *           ONE video file (MediaRecorder, layout SINGLE_FILE), returned in the
 *           stop result; no per-segment events.
 *
 * Both share this one module and the consent/notification pattern. The module
 * trusts nothing from JS about ownership; it collects NO app inventory,
 * notifications, clipboard, contacts or hardware identifiers, never bypasses
 * FLAG_SECURE, and uses no overlay/Accessibility permission. The MICROPHONE is
 * recorded only when JS passes `microphone: true` after the user's in-app
 * consent, and only with the RECORD_AUDIO runtime grant (refused otherwise).
 *
 * The frame flow's `onScreenFrame` carries a `status`: CAPTURED, UNCHANGED (the
 * screen produced no new image since the last frame — nothing was saved),
 * FAILED (FRAME_CAPTURE_FAILED) or STOPPED, so JS can tell the user which.
 *
 * AUD-029 — every promise this module holds is a [SettleOnce]: a JS reload
 * rejects what the dead context awaited (MODULE_RELOADED), and a service
 * answering later can no longer double-settle it.
 */
private typealias Pending = SettleOnce<Promise>

private fun Pending.resolveWith(value: Any?) {
  settle { it.resolve(value) }
}

private fun Pending.rejectWith(code: String, message: String) {
  settle { it.reject(CodedException(code, message, null)) }
}

class ProovraScreenCaptureModule : Module() {
  // UC-2 frame flow.
  private var startPromise: Pending? = null
  private var framePromise: Pending? = null
  private var stopPromise: Pending? = null
  private var pendingMaxFrames: Int = 20

  // UC-3 continuous flow.
  private var continuousStartPromise: Pending? = null
  private var continuousStopPromise: Pending? = null
  private var pendingSegmentMs: Int = ContinuousScreenCaptureService.DEFAULT_SEGMENT_MS
  private var pendingMaxSegments: Int = ContinuousScreenCaptureService.MAX_SEGMENTS
  private var pendingMicrophone: Boolean = false

  // Which flow the pending consent belongs to.
  private var pendingKind: String? = null

  companion object {
    private const val CONSENT_REQUEST = 0x50D1
    // AUD-029 — the stable code a promise is rejected with when the JS context
    // that awaited it was torn down (a reload) before native could settle it.
    const val MODULE_RELOADED = "MODULE_RELOADED"
  }

  override fun definition() = ModuleDefinition {
    Name("ProovraScreenCapture")

    Events(
      "onScreenFrame", "onScreenCaptureStopped", "onScreenSegment", "onScreenContinuousStopped",
      "onScreenContinuousStarted",
    )

    // UC-AND-004 — the recorder outlives the JS context. Each new module
    // instance (a reloaded / recreated JS runtime) re-binds the service's static
    // callbacks to ITSELF, so segments recorded after the UI came back reach the
    // new listeners instead of a dead closure.
    // AUD-029 — the FRAME service's callbacks were bound only in startCapture,
    // so after a JS reload stopCapture/captureFrame settled the dead module's
    // promises and the new ones hung. Both services re-bind here.
    OnCreate {
      bindContinuousCallbacks()
      bindFrameCallbacks()
      // AUD-004 — the durable ledger is readable from the first call, so a
      // relaunched process sees the recording its predecessor left behind.
      appContext.reactContext?.applicationContext?.let { ContinuousScreenCaptureService.attachLedger(it) }
      // AUD-37 — likewise the single-frame ledger.
      appContext.reactContext?.applicationContext?.let { ScreenCaptureService.attachLedger(it) }
    }

    // AUD-029 — a reload orphans whatever this instance was awaiting (a
    // pending consent, a stop, a frame): each is rejected with a stable code
    // rather than left pending against a dead context.
    OnDestroy { rejectOrphanedPromises() }

    Function("isSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.O }
    Function("isContinuousSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.O }

    Function("getState") {
      mapOf("active" to ScreenCaptureService.isActive(), "frameCount" to ScreenCaptureService.frameCount())
    }
    Function("getContinuousState") {
      mapOf(
        "active" to ContinuousScreenCaptureService.isActive(),
        "segmentCount" to ContinuousScreenCaptureService.segmentCount(),
      )
    }
    Function("getContinuousSegments") { ContinuousScreenCaptureService.segmentsSnapshot() }
    // AUD-37 — a single-frame capture a dead process left behind (INTERRUPTED,
    // with its frames), or null.
    Function("getRecoveredScreenCapture") { ScreenCaptureService.recoveredOutcome()?.toJsMap() }
    AsyncFunction("clearScreenCaptureLedger") { promise: Promise ->
      if (!ScreenCaptureService.clearLedger()) {
        promise.reject(CodedException("BUSY", "Stop the capture before clearing it.", null)); return@AsyncFunction
      }
      promise.resolve(null)
    }
    // AUD-004 — the durable ledger (recovered: INTERRUPTED after a process
    // death), or null when there is no recording to recover.
    Function("getContinuousLedger") { ContinuousScreenCaptureService.ledgerForJs() }

    // AUD-004 — bind the recording to the PROOVRA session JS opened for it.
    // A ledger bound to another session is never merged: BINDING_MISMATCH.
    AsyncFunction("bindContinuousSession") { options: Map<String, Any?>, promise: Promise ->
      val sessionId = options["captureSessionId"] as? String
      val evidenceId = options["evidenceId"] as? String
      if (sessionId.isNullOrEmpty() || evidenceId.isNullOrEmpty()) {
        promise.reject(CodedException("INVALID_BINDING", "A session and evidence id are required.", null)); return@AsyncFunction
      }
      if (!ContinuousScreenCaptureService.bindSession(sessionId, evidenceId, options["ownerUserId"] as? String)) {
        promise.reject(CodedException("BINDING_MISMATCH", "This recording belongs to another capture session.", null)); return@AsyncFunction
      }
      promise.resolve(true)
    }

    // AUD-004 — PROOVRA confirmed a segment; the ledger records it, then the
    // local copy may go. Resolves false when the ledger refuses (other session).
    AsyncFunction("markContinuousSegmentUploaded") { options: Map<String, Any?>, promise: Promise ->
      val sessionId = options["captureSessionId"] as? String ?: ""
      val sequence = (options["sequence"] as? Number)?.toInt() ?: -1
      val sha = options["sha256Hex"] as? String ?: ""
      val size = (options["sizeBytes"] as? Number)?.toLong() ?: 0L
      promise.resolve(sequence >= 0 && sha.isNotEmpty() && ContinuousScreenCaptureService.markSegmentUploaded(sessionId, sequence, sha, size))
    }

    // AUD-004 — the bound session is staged: release its spool. Resolves false
    // (nothing deleted) unless the ledger is bound to exactly this session.
    AsyncFunction("commitContinuousSpool") { options: Map<String, Any?>, promise: Promise ->
      val sessionId = options["captureSessionId"] as? String ?: ""
      promise.resolve(ContinuousScreenCaptureService.commitSpool(appContext.reactContext?.applicationContext, sessionId))
    }
    // UC-AND-004 / UC-IOS-010 — the explicit discard of a leftover recording's
    // local files (never while recording).
    AsyncFunction("discardContinuousSpool") { promise: Promise ->
      val ctx = appContext.reactContext?.applicationContext
      if (ContinuousScreenCaptureService.isActive()) {
        promise.reject(CodedException("BUSY", "Stop the recording before discarding it.", null)); return@AsyncFunction
      }
      ContinuousScreenCaptureService.discardSpool(ctx)
      promise.resolve(null)
    }

    // ---- UC-2 frame flow --------------------------------------------------
    AsyncFunction("startCapture") { options: Map<String, Any?>, promise: Promise ->
      val activity = requireActivity(promise) ?: return@AsyncFunction
      if (startPromise != null || ScreenCaptureService.isActive() || ContinuousScreenCaptureService.isActive()) {
        promise.reject(CodedException("BUSY", "A capture is already in progress.", null)); return@AsyncFunction
      }
      // AUD-37 — a new capture never overwrites recovered frames.
      if (ScreenCaptureService.recoveredOutcome() != null) {
        promise.reject(CodedException("RECOVERY_PENDING", "Review or discard the recovered capture first.", null)); return@AsyncFunction
      }
      val pending = Pending(promise)
      startPromise = pending
      pendingKind = "frame"
      pendingMaxFrames = ((options["maxFrames"] as? Number)?.toInt() ?: 20).coerceIn(1, 60)
      bindFrameCallbacks()
      launchConsent(activity, pending)
    }

    AsyncFunction("captureFrame") { promise: Promise ->
      val ctx = appContext.reactContext?.applicationContext
      if (!ScreenCaptureService.isActive() || ctx == null) {
        promise.reject(CodedException("NOT_ACTIVE", "No active screen-capture session.", null)); return@AsyncFunction
      }
      if (ScreenCaptureService.frameCount() >= pendingMaxFrames) {
        promise.reject(CodedException("BOUNDS_REACHED", "The frame limit was reached.", null)); return@AsyncFunction
      }
      framePromise?.rejectWith("SUPERSEDED", "Replaced by a newer request.")
      framePromise = Pending(promise)
      ScreenCaptureService.requestCaptureFrame(ctx)
    }

    // F5 — the native name MUST match the JS binding's public method
    // (`ProovraScreenCapture.stopCapture()` in modules/.../index.ts). It was
    // "stop", so `stopScreenCapture()` invoked a native method that did not
    // exist and rejected at runtime. Aligned to the one canonical name.
    AsyncFunction("stopCapture") { promise: Promise ->
      val ctx = appContext.reactContext?.applicationContext
      if (!ScreenCaptureService.isActive() || ctx == null) {
        promise.resolve(ScreenCaptureService.lastOutcome()?.toJsMap() ?: emptyMap<String, Any?>()); return@AsyncFunction
      }
      stopPromise?.rejectWith("SUPERSEDED", "Replaced by a newer request.")
      stopPromise = Pending(promise)
      ScreenCaptureService.requestStop(ctx, "USER_STOPPED")
    }

    // ---- UC-3 continuous flow --------------------------------------------
    AsyncFunction("startContinuousCapture") { options: Map<String, Any?>, promise: Promise ->
      val activity = requireActivity(promise) ?: return@AsyncFunction
      if (continuousStartPromise != null || ScreenCaptureService.isActive() || ContinuousScreenCaptureService.isActive()) {
        promise.reject(CodedException("BUSY", "A capture is already in progress.", null)); return@AsyncFunction
      }
      // AUD-004 — a new recording never overwrites one the ledger still holds.
      appContext.reactContext?.applicationContext?.let { ContinuousScreenCaptureService.attachLedger(it) }
      if (ContinuousScreenCaptureService.newRecordingBlocked()) {
        promise.reject(CodedException("PENDING_RECORDING", "An earlier recording is still on this device.", null)); return@AsyncFunction
      }
      // The microphone only on an explicit request, and only with the runtime
      // grant JS obtained first (never requested from here, never assumed).
      val microphone = options["microphone"] == true
      if (microphone && activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        promise.reject(CodedException("MICROPHONE_PERMISSION_REQUIRED", "Microphone recording needs the microphone permission.", null)); return@AsyncFunction
      }
      val pending = Pending(promise)
      continuousStartPromise = pending
      pendingKind = "continuous"
      // UC-STR-001 — THE capture limits (by value): segments + manifest fit the record.
      pendingSegmentMs = ((options["segmentMs"] as? Number)?.toInt() ?: ContinuousScreenCaptureService.DEFAULT_SEGMENT_MS)
        .coerceIn(ContinuousScreenCaptureService.MIN_SEGMENT_MS, ContinuousScreenCaptureService.MAX_SEGMENT_MS)
      pendingMaxSegments = ((options["maxSegments"] as? Number)?.toInt() ?: ContinuousScreenCaptureService.MAX_SEGMENTS)
        .coerceIn(1, ContinuousScreenCaptureService.MAX_SEGMENTS)
      pendingMicrophone = microphone
      bindContinuousCallbacks()
      launchConsent(activity, pending)
    }

    AsyncFunction("stopContinuousCapture") { promise: Promise ->
      val ctx = appContext.reactContext?.applicationContext
      if (!ContinuousScreenCaptureService.isActive() || ctx == null) {
        // AUD-004 — after a process death the outcome comes from the durable
        // ledger (INTERRUPTED); with no recording at all, a refusal — never an
        // empty map that no manifest can be built from.
        val outcome = ContinuousScreenCaptureService.lastOutcome()
        if (outcome == null) {
          promise.reject(CodedException("NO_RECORDING", "There is no recording to stop.", null)); return@AsyncFunction
        }
        promise.resolve(outcome); return@AsyncFunction
      }
      continuousStopPromise?.rejectWith("SUPERSEDED", "Replaced by a newer request.")
      continuousStopPromise = Pending(promise)
      ContinuousScreenCaptureService.requestStop(ctx, "USER_STOPPED")
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != CONSENT_REQUEST) return@OnActivityResult
      val kind = pendingKind
      pendingKind = null
      val ctx = appContext.reactContext?.applicationContext
      val granted = payload.resultCode == Activity.RESULT_OK && payload.data != null && ctx != null
      if (kind == "continuous") {
        val pending = continuousStartPromise ?: return@OnActivityResult
        continuousStartPromise = null
        if (!granted) {
          pending.rejectWith("PERMISSION_DENIED", "Screen capture consent was not granted.")
          return@OnActivityResult
        }
        ContinuousScreenCaptureService.start(
          ctx!!, payload.resultCode, payload.data!!, pendingSegmentMs, pendingMaxSegments, pendingMicrophone,
          onStarted = { started ->
            pending.resolveWith(
              mapOf(
                "osConsentGranted" to true, "captureStartedAtUtc" to started,
                "segmentMs" to pendingSegmentMs, "maxSegments" to pendingMaxSegments,
                "layout" to LAYOUT_SINGLE_FILE, "microphoneRequested" to pendingMicrophone,
              ),
            )
            sendEvent("onScreenContinuousStarted", mapOf("captureStartedAtUtc" to started))
          },
          // UC-AND-013 — a setup failure after consent rejects; never a hung start.
          onStartFailed = { code, message -> pending.rejectWith(code, message) },
        )
      } else {
        val pending = startPromise ?: return@OnActivityResult
        startPromise = null
        if (!granted) {
          pending.rejectWith("PERMISSION_DENIED", "Screen capture consent was not granted.")
          return@OnActivityResult
        }
        ScreenCaptureService.start(
          ctx!!, payload.resultCode, payload.data!!, pendingMaxFrames,
          onStarted = { started ->
            pending.resolveWith(mapOf("osConsentGranted" to true, "captureStartedAtUtc" to started, "maxFrames" to pendingMaxFrames))
          },
          onStartFailed = { code, message -> pending.rejectWith(code, message) },
        )
      }
    }
  }

  private fun bindFrameCallbacks() {
    // frameIndex -1 is never ambiguous: `status` says UNCHANGED (no new image),
    // FAILED or STOPPED.
    ScreenCaptureService.onFrame = { i, n, status ->
      val frame = mapOf("frameIndex" to i, "frameCount" to n, "status" to status)
      framePromise?.resolveWith(frame); framePromise = null
      sendEvent("onScreenFrame", frame)
    }
    ScreenCaptureService.onStopped = { outcome ->
      val js = outcome.toJsMap()
      stopPromise?.resolveWith(js); stopPromise = null
      framePromise?.resolveWith(mapOf("frameIndex" to -1, "frameCount" to outcome.frames.size, "status" to FRAME_STOPPED)); framePromise = null
      sendEvent("onScreenCaptureStopped", js)
    }
  }

  // One recording: the result carries the file; no per-segment event is sent.
  private fun bindContinuousCallbacks() {
    ContinuousScreenCaptureService.onStopped = { js ->
      continuousStopPromise?.resolveWith(js); continuousStopPromise = null
      sendEvent("onScreenContinuousStopped", js)
    }
  }

  private fun rejectOrphanedPromises() {
    val orphaned = listOfNotNull(startPromise, framePromise, stopPromise, continuousStartPromise, continuousStopPromise)
    startPromise = null; framePromise = null; stopPromise = null
    continuousStartPromise = null; continuousStopPromise = null
    pendingKind = null
    for (p in orphaned) p.rejectWith(MODULE_RELOADED, "The app reloaded before the screen capture answered.")
  }

  private fun requireActivity(promise: Promise): Activity? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.reject(CodedException("UNSUPPORTED", "Requires Android 8.0+.", null)); return null
    }
    val activity = appContext.activityProvider?.currentActivity
    if (activity == null) promise.reject(CodedException("NO_ACTIVITY", "No current activity.", null))
    return activity
  }

  private fun launchConsent(activity: Activity, pending: Pending) {
    try {
      val mpm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      activity.startActivityForResult(mpm.createScreenCaptureIntent(), CONSENT_REQUEST)
    } catch (t: Throwable) {
      startPromise = null; continuousStartPromise = null; pendingKind = null
      pending.rejectWith("CONSENT_LAUNCH_FAILED", startFailureMessage(t))
    }
  }
}

/** Frames + context the UC-2 frame service produces for one session. */
data class ScreenCaptureOutcome(
  val osConsentGranted: Boolean,
  val startedAtUtc: String,
  val endedAtUtc: String,
  val osVersion: String,
  val model: String,
  val appVersion: String,
  val screenW: Int,
  val screenH: Int,
  val densityDpi: Int,
  val orientation: String,
  val frames: List<FrameOut>,
  val stopReason: String,
  val limitations: List<String>,
) {
  fun toJsMap(): Map<String, Any?> {
    val frameMaps = frames.map { f ->
      mapOf(
        "uri" to f.uri, "frameIndex" to f.frameIndex, "widthPx" to f.widthPx,
        "heightPx" to f.heightPx, "capturedAtOffsetMs" to f.capturedAtOffsetMs,
      )
    }
    return mapOf(
      "osConsentGranted" to osConsentGranted,
      "captureStartedAtUtc" to startedAtUtc,
      "captureEndedAtUtc" to endedAtUtc,
      "device" to mapOf(
        "platform" to "android", "osVersion" to osVersion, "model" to model, "appVersion" to appVersion,
        "screenW" to screenW, "screenH" to screenH, "densityDpi" to densityDpi, "orientation" to orientation,
      ),
      "frames" to frameMaps, "stopReason" to stopReason, "limitations" to limitations,
    )
  }
}

data class FrameOut(
  val uri: String,
  val frameIndex: Int,
  val widthPx: Int,
  val heightPx: Int,
  val capturedAtOffsetMs: Long,
)
