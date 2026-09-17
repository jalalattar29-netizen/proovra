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
import org.json.JSONArray
import org.json.JSONObject

/**
 * UC-2 — Android Direct Screen Capture Expo module.
 *
 * Coordinates the MediaProjection CONSENT (a system dialog — nothing is captured
 * before the user grants it), then hands the granted token to
 * [ScreenCaptureService], a foreground service (required for MediaProjection on
 * Android 10+/14+) that runs the bounded capture and reports the frames back.
 *
 * The module trusts nothing from JS about ownership; it only performs the
 * OS-authorised capture and returns file URIs + coarse context. It collects NO
 * app inventory, notifications, clipboard, contacts or hardware identifiers, and
 * never bypasses FLAG_SECURE.
 */
class ProovraScreenCaptureModule : Module() {
  private var pending: Promise? = null
  private var pendingMaxFrames: Int = 8
  private var pendingIntervalMs: Int = 750

  companion object {
    private const val CONSENT_REQUEST = 0x50D1 // "PROOVRA screen"
  }

  override fun definition() = ModuleDefinition {
    Name("ProovraScreenCapture")

    Function("isSupported") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
    }

    AsyncFunction("requestConsentAndCapture") { options: Map<String, Any?>, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        promise.reject(CodedException("UNSUPPORTED", "Requires Android 8.0+.", null))
        return@AsyncFunction
      }
      val activity: Activity? = appContext.activityProvider?.currentActivity
      if (activity == null) {
        promise.reject(CodedException("NO_ACTIVITY", "No current activity.", null))
        return@AsyncFunction
      }
      if (pending != null) {
        promise.reject(CodedException("BUSY", "A capture is already in progress.", null))
        return@AsyncFunction
      }
      pending = promise
      pendingMaxFrames = ((options["maxFrames"] as? Number)?.toInt() ?: 8).coerceIn(1, 60)
      pendingIntervalMs = ((options["intervalMs"] as? Number)?.toInt() ?: 750).coerceAtLeast(200)

      val mpm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      // The consent dialog. Capture cannot start until this returns RESULT_OK.
      activity.startActivityForResult(mpm.createScreenCaptureIntent(), CONSENT_REQUEST)
    }

    AsyncFunction("stop") { promise: Promise ->
      ScreenCaptureService.requestStop(appContext.reactContext?.applicationContext, "USER_STOPPED")
      promise.resolve(null)
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != CONSENT_REQUEST) return@OnActivityResult
      val promise = pending ?: return@OnActivityResult
      pending = null
      val ctx = appContext.reactContext?.applicationContext
      if (payload.resultCode != Activity.RESULT_OK || payload.data == null || ctx == null) {
        // The user declined the consent dialog. Fail closed — nothing captured.
        promise.reject(CodedException("PERMISSION_DENIED", "Screen capture consent was not granted.", null))
        return@OnActivityResult
      }
      // Hand the granted token to the foreground service; it reports back here.
      ScreenCaptureService.start(
        ctx,
        payload.resultCode,
        payload.data!!,
        pendingMaxFrames,
        pendingIntervalMs,
      ) { result ->
        promise.resolve(result.toJsMap())
      }
    }
  }
}

/** Frames + context the service produces for one bounded session. */
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
    val framesJson = JSONArray()
    frames.forEach { f ->
      framesJson.put(
        JSONObject()
          .put("uri", f.uri)
          .put("frameIndex", f.frameIndex)
          .put("widthPx", f.widthPx)
          .put("heightPx", f.heightPx)
          .put("capturedAtOffsetMs", f.capturedAtOffsetMs),
      )
    }
    // Return a plain Map the Expo bridge serialises directly.
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
