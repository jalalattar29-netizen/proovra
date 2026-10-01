package com.proovra.screencapture

import android.app.Activity
import android.content.Context
import android.content.Intent
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
 *   - UC-3: [ContinuousScreenCaptureService] — a bounded continuous recording split
 *           into ORIGINAL segments (MediaRecorder), streamed out as they finalize.
 *
 * Both share this one module and the consent/notification pattern. The module
 * trusts nothing from JS about ownership; it collects NO app inventory,
 * notifications, clipboard, contacts, hardware identifiers or AUDIO, never
 * bypasses FLAG_SECURE, and uses no overlay/Accessibility permission.
 */
class ProovraScreenCaptureModule : Module() {
  // UC-2 frame flow.
  private var startPromise: Promise? = null
  private var framePromise: Promise? = null
  private var stopPromise: Promise? = null
  private var pendingMaxFrames: Int = 20

  // UC-3 continuous flow.
  private var continuousStartPromise: Promise? = null
  private var continuousStopPromise: Promise? = null
  private var pendingSegmentMs: Int = ContinuousScreenCaptureService.DEFAULT_SEGMENT_MS
  private var pendingMaxSegments: Int = ContinuousScreenCaptureService.MAX_SEGMENTS

  // Which flow the pending consent belongs to.
  private var pendingKind: String? = null

  companion object {
    private const val CONSENT_REQUEST = 0x50D1
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
    OnCreate { bindContinuousCallbacks() }

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
      startPromise = promise
      pendingKind = "frame"
      pendingMaxFrames = ((options["maxFrames"] as? Number)?.toInt() ?: 20).coerceIn(1, 60)
      ScreenCaptureService.onFrame = { i, n ->
        framePromise?.resolve(mapOf("frameIndex" to i, "frameCount" to n)); framePromise = null
        sendEvent("onScreenFrame", mapOf("frameIndex" to i, "frameCount" to n))
      }
      ScreenCaptureService.onStopped = { outcome ->
        val js = outcome.toJsMap()
        stopPromise?.resolve(js); stopPromise = null
        framePromise?.resolve(mapOf("frameIndex" to -1, "frameCount" to outcome.frames.size)); framePromise = null
        sendEvent("onScreenCaptureStopped", js)
      }
      launchConsent(activity, promise)
    }

    AsyncFunction("captureFrame") { promise: Promise ->
      val ctx = appContext.reactContext?.applicationContext
      if (!ScreenCaptureService.isActive() || ctx == null) {
        promise.reject(CodedException("NOT_ACTIVE", "No active screen-capture session.", null)); return@AsyncFunction
      }
      if (ScreenCaptureService.frameCount() >= pendingMaxFrames) {
        promise.reject(CodedException("BOUNDS_REACHED", "The frame limit was reached.", null)); return@AsyncFunction
      }
      framePromise?.reject(CodedException("SUPERSEDED", "Replaced by a newer request.", null))
      framePromise = promise
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
      stopPromise = promise
      ScreenCaptureService.requestStop(ctx, "USER_STOPPED")
    }

    // ---- UC-3 continuous flow --------------------------------------------
    AsyncFunction("startContinuousCapture") { options: Map<String, Any?>, promise: Promise ->
      val activity = requireActivity(promise) ?: return@AsyncFunction
      if (continuousStartPromise != null || ScreenCaptureService.isActive() || ContinuousScreenCaptureService.isActive()) {
        promise.reject(CodedException("BUSY", "A capture is already in progress.", null)); return@AsyncFunction
      }
      continuousStartPromise = promise
      pendingKind = "continuous"
      // UC-STR-001 — THE capture limits (by value): segments + manifest fit the record.
      pendingSegmentMs = ((options["segmentMs"] as? Number)?.toInt() ?: ContinuousScreenCaptureService.DEFAULT_SEGMENT_MS)
        .coerceIn(ContinuousScreenCaptureService.MIN_SEGMENT_MS, ContinuousScreenCaptureService.MAX_SEGMENT_MS)
      pendingMaxSegments = ((options["maxSegments"] as? Number)?.toInt() ?: ContinuousScreenCaptureService.MAX_SEGMENTS)
        .coerceIn(1, ContinuousScreenCaptureService.MAX_SEGMENTS)
      bindContinuousCallbacks()
      launchConsent(activity, promise)
    }

    AsyncFunction("stopContinuousCapture") { promise: Promise ->
      val ctx = appContext.reactContext?.applicationContext
      if (!ContinuousScreenCaptureService.isActive() || ctx == null) {
        promise.resolve(ContinuousScreenCaptureService.lastOutcome() ?: emptyMap<String, Any?>()); return@AsyncFunction
      }
      continuousStopPromise = promise
      ContinuousScreenCaptureService.requestStop(ctx, "USER_STOPPED")
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != CONSENT_REQUEST) return@OnActivityResult
      val kind = pendingKind
      pendingKind = null
      val ctx = appContext.reactContext?.applicationContext
      val granted = payload.resultCode == Activity.RESULT_OK && payload.data != null && ctx != null
      if (kind == "continuous") {
        val promise = continuousStartPromise ?: return@OnActivityResult
        continuousStartPromise = null
        if (!granted) {
          promise.reject(CodedException("PERMISSION_DENIED", "Screen capture consent was not granted.", null))
          return@OnActivityResult
        }
        ContinuousScreenCaptureService.start(
          ctx!!, payload.resultCode, payload.data!!, pendingSegmentMs, pendingMaxSegments,
          onStarted = { started ->
            promise.resolve(mapOf("osConsentGranted" to true, "captureStartedAtUtc" to started, "segmentMs" to pendingSegmentMs, "maxSegments" to pendingMaxSegments))
            sendEvent("onScreenContinuousStarted", mapOf("captureStartedAtUtc" to started))
          },
          // UC-AND-013 — a setup failure after consent rejects; never a hung start.
          onStartFailed = { code, message -> promise.reject(CodedException(code, message, null)) },
        )
      } else {
        val promise = startPromise ?: return@OnActivityResult
        startPromise = null
        if (!granted) {
          promise.reject(CodedException("PERMISSION_DENIED", "Screen capture consent was not granted.", null))
          return@OnActivityResult
        }
        ScreenCaptureService.start(
          ctx!!, payload.resultCode, payload.data!!, pendingMaxFrames,
          onStarted = { started ->
            promise.resolve(mapOf("osConsentGranted" to true, "captureStartedAtUtc" to started, "maxFrames" to pendingMaxFrames))
          },
          onStartFailed = { code, message -> promise.reject(CodedException(code, message, null)) },
        )
      }
    }
  }

  private fun bindContinuousCallbacks() {
    ContinuousScreenCaptureService.onSegment = { seg -> sendEvent("onScreenSegment", seg) }
    ContinuousScreenCaptureService.onStopped = { js ->
      continuousStopPromise?.resolve(js); continuousStopPromise = null
      sendEvent("onScreenContinuousStopped", js)
    }
  }

  private fun requireActivity(promise: Promise): Activity? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.reject(CodedException("UNSUPPORTED", "Requires Android 8.0+.", null)); return null
    }
    val activity = appContext.activityProvider?.currentActivity
    if (activity == null) promise.reject(CodedException("NO_ACTIVITY", "No current activity.", null))
    return activity
  }

  private fun launchConsent(activity: Activity, promise: Promise) {
    try {
      val mpm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      activity.startActivityForResult(mpm.createScreenCaptureIntent(), CONSENT_REQUEST)
    } catch (t: Throwable) {
      startPromise = null; continuousStartPromise = null; pendingKind = null
      promise.reject(CodedException("CONSENT_LAUNCH_FAILED", t.message ?: "Could not request consent.", t))
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
