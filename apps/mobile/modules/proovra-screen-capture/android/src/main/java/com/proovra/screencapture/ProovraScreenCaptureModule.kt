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
 * UC-2 — Android Direct Screen Capture Expo module.
 *
 * Coordinates the MediaProjection CONSENT (a system dialog — nothing is captured
 * before the user grants it), then hands the granted token to
 * [ScreenCaptureService], a foreground service (required for MediaProjection on
 * Android 10+/14+). The USER decides when each frame is taken, via the service's
 * notification "Capture Frame" action or the in-app button (both routed through
 * the SAME native authority); a timer never captures on its own.
 *
 * The module trusts nothing from JS about ownership; it only performs the
 * OS-authorised capture and returns file URIs + coarse context. It collects NO
 * app inventory, notifications, clipboard, contacts or hardware identifiers,
 * never bypasses FLAG_SECURE, and uses no overlay/Accessibility permission.
 */
class ProovraScreenCaptureModule : Module() {
  private var startPromise: Promise? = null
  private var framePromise: Promise? = null
  private var stopPromise: Promise? = null
  private var pendingMaxFrames: Int = 20

  companion object {
    private const val CONSENT_REQUEST = 0x50D1 // "PROOVRA screen"
  }

  override fun definition() = ModuleDefinition {
    Name("ProovraScreenCapture")

    Events("onScreenFrame", "onScreenCaptureStopped")

    Function("isSupported") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
    }

    Function("getState") {
      mapOf(
        "active" to ScreenCaptureService.isActive(),
        "frameCount" to ScreenCaptureService.frameCount(),
      )
    }

    AsyncFunction("startCapture") { options: Map<String, Any?>, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        promise.reject(CodedException("UNSUPPORTED", "Requires Android 8.0+.", null))
        return@AsyncFunction
      }
      val activity: Activity? = appContext.activityProvider?.currentActivity
      if (activity == null) {
        promise.reject(CodedException("NO_ACTIVITY", "No current activity.", null))
        return@AsyncFunction
      }
      if (startPromise != null || ScreenCaptureService.isActive()) {
        promise.reject(CodedException("BUSY", "A capture is already in progress.", null))
        return@AsyncFunction
      }
      startPromise = promise
      pendingMaxFrames = ((options["maxFrames"] as? Number)?.toInt() ?: 20).coerceIn(1, 60)

      // Wire the service -> module callbacks (frame + stopped) before consent.
      ScreenCaptureService.onFrame = { frameIndex, frameCount ->
        framePromise?.resolve(mapOf("frameIndex" to frameIndex, "frameCount" to frameCount))
        framePromise = null
        sendEvent("onScreenFrame", mapOf("frameIndex" to frameIndex, "frameCount" to frameCount))
      }
      ScreenCaptureService.onStopped = { outcome ->
        val js = outcome.toJsMap()
        stopPromise?.resolve(js)
        stopPromise = null
        // Any awaited captureFrame that raced the stop resolves as a no-op.
        framePromise?.resolve(mapOf("frameIndex" to -1, "frameCount" to outcome.frames.size))
        framePromise = null
        sendEvent("onScreenCaptureStopped", js)
      }

      val mpm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      activity.startActivityForResult(mpm.createScreenCaptureIntent(), CONSENT_REQUEST)
    }

    AsyncFunction("captureFrame") { promise: Promise ->
      val ctx = appContext.reactContext?.applicationContext
      if (!ScreenCaptureService.isActive() || ctx == null) {
        promise.reject(CodedException("NOT_ACTIVE", "No active screen-capture session.", null))
        return@AsyncFunction
      }
      if (ScreenCaptureService.frameCount() >= pendingMaxFrames) {
        promise.reject(CodedException("BOUNDS_REACHED", "The frame limit for this session was reached.", null))
        return@AsyncFunction
      }
      framePromise?.reject(CodedException("SUPERSEDED", "A newer capture-frame request replaced this one.", null))
      framePromise = promise
      ScreenCaptureService.requestCaptureFrame(ctx)
    }

    AsyncFunction("stopCapture") { promise: Promise ->
      val ctx = appContext.reactContext?.applicationContext
      if (!ScreenCaptureService.isActive() || ctx == null) {
        // Idempotent: stopping an already-stopped session is not an error.
        promise.resolve(ScreenCaptureService.lastOutcome()?.toJsMap() ?: emptyMap<String, Any?>())
        return@AsyncFunction
      }
      stopPromise = promise
      ScreenCaptureService.requestStop(ctx, "USER_STOPPED")
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != CONSENT_REQUEST) return@OnActivityResult
      val promise = startPromise ?: return@OnActivityResult
      startPromise = null
      val ctx = appContext.reactContext?.applicationContext
      if (payload.resultCode != Activity.RESULT_OK || payload.data == null || ctx == null) {
        // The user declined the consent dialog. Fail closed — nothing captured.
        promise.reject(CodedException("PERMISSION_DENIED", "Screen capture consent was not granted.", null))
        return@OnActivityResult
      }
      // Start the foreground service with the granted token. Session is now ACTIVE
      // but EMPTY — the user triggers each frame.
      ScreenCaptureService.start(ctx, payload.resultCode, payload.data!!, pendingMaxFrames) { started ->
        promise.resolve(
          mapOf(
            "osConsentGranted" to true,
            "captureStartedAtUtc" to started,
            "maxFrames" to pendingMaxFrames,
          ),
        )
      }
    }
  }
}

/** Frames + context the service produces for one session. */
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
        "uri" to f.uri,
        "frameIndex" to f.frameIndex,
        "widthPx" to f.widthPx,
        "heightPx" to f.heightPx,
        "capturedAtOffsetMs" to f.capturedAtOffsetMs,
      )
    }
    return mapOf(
      "osConsentGranted" to osConsentGranted,
      "captureStartedAtUtc" to startedAtUtc,
      "captureEndedAtUtc" to endedAtUtc,
      "device" to mapOf(
        "platform" to "android",
        "osVersion" to osVersion,
        "model" to model,
        "appVersion" to appVersion,
        "screenW" to screenW,
        "screenH" to screenH,
        "densityDpi" to densityDpi,
        "orientation" to orientation,
      ),
      "frames" to frameMaps,
      "stopReason" to stopReason,
      "limitations" to limitations,
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
