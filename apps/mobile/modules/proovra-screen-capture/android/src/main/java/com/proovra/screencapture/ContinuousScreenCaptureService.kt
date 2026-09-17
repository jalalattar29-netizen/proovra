package com.proovra.screencapture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.DisplayMetrics
import android.view.WindowManager
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * UC-3 — the foreground service that records a CONTINUOUS screen session as
 * bounded ORIGINAL SEGMENTS.
 *
 * It becomes a foreground service (type mediaProjection) with a visible
 * notification carrying a Stop action BEFORE creating the projection (Android 14
 * ordering), then records with MediaRecorder into a VirtualDisplay-backed
 * Surface. Each segment is capped by `setMaxDuration(segmentMs)`; on the
 * max-duration signal the current segment is finalized (emitted for streaming
 * upload) and the next begins, up to `maxSegments` (BOUNDS_REACHED). SCREEN ONLY
 * — no audio source is configured. Stop, OS revocation, or process death end the
 * session; the already-finalized segments are preserved and the session is marked
 * COMPLETE or INTERRUPTED truthfully. No FLAG_SECURE bypass, no overlay, no
 * Accessibility. Bounded memory by design: bytes stream to disk, never RAM.
 */
class ContinuousScreenCaptureService : Service() {

  companion object {
    private const val CHANNEL_ID = "proovra_continuous_capture"
    private const val NOTIF_ID = 0x50D3
    const val ACTION_STOP = "com.proovra.screencapture.CONTINUOUS_STOP"
    // Kept in agreement (by value, since Kotlin cannot import the TS authority) with
    // SCREEN_CONTINUOUS_STREAM_BOUNDS in packages/shared/src/screen-continuous-manifest.ts:
    // videoBitrateBps, videoFrameRate, maxSegmentBytes.
    private const val BITRATE = 6_000_000
    private const val FRAME_RATE = 12
    private const val MAX_SEGMENT_BYTES = 64L * 1024L * 1024L
    // Total wall-clock ceiling (ms), kept below the server capture-session TTL so a
    // session always stops with margin to finalize. Agrees with maxSessionMs in
    // SCREEN_CONTINUOUS_STREAM_BOUNDS.
    private const val MAX_SESSION_MS = 50L * 60L * 1000L

    private var projection: MediaProjection? = null
    private var recorder: MediaRecorder? = null
    private var virtualDisplay: VirtualDisplay? = null

    private val segments = mutableListOf<Map<String, Any?>>()
    private val limitations = linkedSetOf<String>()
    private var startedAtMs = 0L
    private var startedAtUtc = ""
    private var segmentMs = 6000
    private var maxSegments = 600
    // Session-INITIAL display geometry (the manifest's session-level device block).
    private var widthPx = 0
    private var heightPx = 0
    private var densityDpi = 0
    // Geometry the CURRENT segment is being recorded at (may differ after a
    // rotation; each ORIGINAL segment records its own true geometry).
    private var segW = 0
    private var segH = 0
    private var segDpi = 0
    private var currentFile: File? = null
    private var segmentStartMs = 0L
    @Volatile private var active = false
    private var terminationReason = "USER_STOPPED"
    private var last: Map<String, Any?>? = null

    private var resultCode = 0
    private var resultData: Intent? = null
    private var onStartedCb: ((String) -> Unit)? = null

    var onSegment: ((Map<String, Any?>) -> Unit)? = null
    var onStopped: ((Map<String, Any?>) -> Unit)? = null

    fun isActive(): Boolean = active
    fun segmentCount(): Int = segments.size
    fun lastOutcome(): Map<String, Any?>? = last

    fun start(context: Context, code: Int, data: Intent, segMs: Int, maxSeg: Int, onStarted: (String) -> Unit) {
      resultCode = code; resultData = data; segmentMs = segMs; maxSegments = maxSeg; onStartedCb = onStarted
      terminationReason = "USER_STOPPED"
      segments.clear(); limitations.clear(); last = null
      val intent = Intent(context, ContinuousScreenCaptureService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }

    fun requestStop(context: Context, reason: String) {
      terminationReason = reason
      context.startService(Intent(context, ContinuousScreenCaptureService::class.java).setAction(ACTION_STOP))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      finish(terminationReason)
      return START_NOT_STICKY
    }
    startForegroundWithNotification()
    beginProjection()
    return START_NOT_STICKY
  }

  private fun startForegroundWithNotification() {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Continuous screen capture", NotificationManager.IMPORTANCE_LOW))
    }
    val stopPi = PendingIntent.getService(
      this, 0,
      Intent(this, ContinuousScreenCaptureService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("PROOVRA is recording your screen")
      .setContentText("Continuous capture is active. Tap Stop to end.")
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Stop", stopPi).build())
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(NOTIF_ID, notification)
    }
  }

  private fun beginProjection() {
    val data = resultData ?: return finish("ERROR")
    val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    val mp = mpm.getMediaProjection(resultCode, data) ?: return finish("ERROR")
    projection = mp

    val metrics = DisplayMetrics()
    @Suppress("DEPRECATION")
    (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
    widthPx = metrics.widthPixels; heightPx = metrics.heightPixels; densityDpi = metrics.densityDpi
    segW = widthPx; segH = heightPx; segDpi = densityDpi
    startedAtMs = System.currentTimeMillis(); startedAtUtc = iso(startedAtMs)

    mp.registerCallback(object : MediaProjection.Callback() {
      override fun onStop() { finish("PERMISSION_REVOKED") }
    }, null)

    // Deterministic rotation handling: a display geometry change finalizes the
    // current segment and starts the next at the new geometry (same Evidence).
    registerDisplayListener()

    active = true
    onStartedCb?.invoke(startedAtUtc)
    onStartedCb = null
    if (!startNextSegment()) finish("ERROR")
  }

  private var displayListener: DisplayManager.DisplayListener? = null

  private fun registerDisplayListener() {
    val dm = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    val l = object : DisplayManager.DisplayListener {
      override fun onDisplayChanged(displayId: Int) { onDisplayGeometryChanged() }
      override fun onDisplayAdded(displayId: Int) {}
      override fun onDisplayRemoved(displayId: Int) {}
    }
    displayListener = l
    dm.registerDisplayListener(l, null)
  }

  private fun unregisterDisplayListener() {
    val l = displayListener ?: return
    displayListener = null
    try { (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(l) } catch (_: Throwable) {}
  }

  private fun newRecorder(outFile: File): MediaRecorder {
    val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
    // SCREEN ONLY — no audio source is configured on purpose.
    r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    r.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
    // Each segment records at ITS OWN geometry (segW/segH), so a segment started
    // after a rotation encodes at the new geometry — never a stretched/cropped frame.
    r.setVideoSize(segW, segH)
    r.setVideoFrameRate(FRAME_RATE)
    r.setVideoEncodingBitRate(BITRATE)
    r.setOutputFile(outFile.absolutePath)
    r.setMaxDuration(segmentMs)
    // Defence-in-depth byte bound: if a segment reaches the size ceiling before its
    // duration window, MediaRecorder signals MAX_FILESIZE_REACHED and we roll over —
    // so no single segment file can grow without limit even if the encoder overruns.
    r.setMaxFileSize(MAX_SEGMENT_BYTES)
    r.setOnInfoListener { _, what, _ ->
      if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED ||
        what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED
      ) {
        rolloverSegment()
      }
    }
    r.setOnErrorListener { _, _, _ -> finish("ERROR") }
    return r
  }

  /** Start recording the next segment; returns false on setup failure. */
  private fun startNextSegment(): Boolean {
    if (!active) return false
    if (segments.size >= maxSegments || (System.currentTimeMillis() - startedAtMs) >= MAX_SESSION_MS) {
      limitations.add("SESSION_BOUNDS_REACHED")
      finish("BOUNDS_REACHED")
      return true
    }
    // Capture the CURRENT display geometry for THIS segment. On a rotation the next
    // segment is recorded at the new geometry (the VirtualDisplay is resized), so a
    // transition is represented as a clean segment boundary — never a corrupted or
    // stretched frame, and never a new Evidence.
    val m = DisplayMetrics()
    @Suppress("DEPRECATION")
    (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(m)
    segW = m.widthPixels; segH = m.heightPixels; segDpi = m.densityDpi
    if ((segW >= segH) != (widthPx >= heightPx)) limitations.add("ORIENTATION_CHANGED_DURING_CAPTURE")
    return try {
      val file = File(cacheDir, "proovra-continuous-${startedAtMs}-${segments.size}.mp4")
      currentFile = file
      val r = newRecorder(file)
      r.prepare()
      val vd = virtualDisplay
      if (vd == null) {
        virtualDisplay = projection!!.createVirtualDisplay(
          "proovra-continuous", segW, segH, segDpi,
          DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, null,
        )
      } else {
        // Resize to the current geometry FIRST, then bind the new segment's surface.
        try { vd.resize(segW, segH, segDpi) } catch (_: Throwable) {}
        vd.surface = r.surface
      }
      r.start()
      recorder = r
      segmentStartMs = System.currentTimeMillis()
      true
    } catch (t: Throwable) {
      false
    }
  }

  /** Finalize the current segment and start the next (bounded). */
  private fun rolloverSegment() {
    if (!active) return
    finalizeCurrentSegment()
    startNextSegment()
  }

  /**
   * A display geometry change during an active segment finalizes the current
   * ORIGINAL segment and starts a new one at the new geometry — a deterministic
   * transition boundary. Same session, same Evidence, continuous sequence.
   */
  private fun onDisplayGeometryChanged() {
    if (!active) return
    val m = DisplayMetrics()
    @Suppress("DEPRECATION")
    (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(m)
    if (m.widthPixels != segW || m.heightPixels != segH) rolloverSegment()
  }

  private fun finalizeCurrentSegment() {
    val r = recorder ?: return
    val file = currentFile
    try { r.stop() } catch (_: Throwable) {}
    try { r.reset(); r.release() } catch (_: Throwable) {}
    recorder = null
    try { virtualDisplay?.surface = null } catch (_: Throwable) {}
    if (file != null && file.exists() && file.length() > 0) {
      val seq = segments.size
      // Record THIS segment's own geometry (segW/segH), which reflects any rotation
      // that took effect at its start boundary — so the manifest's per-segment
      // orientation is truthful across transitions.
      val seg = mapOf<String, Any?>(
        "uri" to "file://${file.absolutePath}",
        "sequence" to seq,
        "startedAtOffsetMs" to (segmentStartMs - startedAtMs),
        "durationMs" to (System.currentTimeMillis() - segmentStartMs),
        "widthPx" to segW,
        "heightPx" to segH,
        "orientation" to if (segW >= segH) "landscape" else "portrait",
      )
      segments.add(seg)
      updateNotification(seq + 1)
      onSegment?.invoke(seg)
    }
    currentFile = null
  }

  private fun updateNotification(count: Int) {
    if (!active) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val stopPi = PendingIntent.getService(
      this, 0,
      Intent(this, ContinuousScreenCaptureService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    nm.notify(
      NOTIF_ID,
      Notification.Builder(this, CHANNEL_ID)
        .setContentTitle("PROOVRA is recording your screen")
        .setContentText("Continuous capture active — $count segment(s). Tap Stop to end.")
        .setSmallIcon(android.R.drawable.ic_menu_camera)
        .setOngoing(true)
        .addAction(Notification.Action.Builder(null, "Stop", stopPi).build())
        .build(),
    )
  }

  private fun finish(reason: String) {
    if (!active && last != null) return
    active = false
    unregisterDisplayListener()
    finalizeCurrentSegment()
    try { virtualDisplay?.release() } catch (_: Throwable) {}
    try { projection?.stop() } catch (_: Throwable) {}
    virtualDisplay = null; projection = null

    val complete = reason == "USER_STOPPED" || reason == "BOUNDS_REACHED"
    if (!complete) limitations.add("CAPTURE_INTERRUPTED")
    val outcome = mapOf<String, Any?>(
      "osConsentGranted" to true,
      "captureStartedAtUtc" to startedAtUtc,
      "captureEndedAtUtc" to iso(System.currentTimeMillis()),
      "device" to mapOf(
        "platform" to "android",
        "osVersion" to (Build.VERSION.RELEASE ?: "unknown"),
        "model" to ((Build.MANUFACTURER ?: "") + " " + (Build.MODEL ?: "")).trim().ifEmpty { "Android device" },
        "appVersion" to appVersionName(),
        "screenW" to widthPx, "screenH" to heightPx, "densityDpi" to densityDpi,
        "orientation" to if (widthPx >= heightPx) "landscape" else "portrait",
      ),
      "totalDurationMs" to (System.currentTimeMillis() - startedAtMs),
      "segmentCount" to segments.size,
      "sessionCompleteness" to if (complete) "COMPLETE_SESSION" else "INTERRUPTED_SESSION",
      "terminationReason" to reason,
      "limitations" to limitations.toList(),
    )
    last = outcome
    onStopped?.invoke(outcome)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  private fun appVersionName(): String = try {
    packageManager.getPackageInfo(packageName, 0).versionName ?: "unknown"
  } catch (_: Throwable) { "unknown" }

  private fun iso(ms: Long): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    fmt.timeZone = TimeZone.getTimeZone("UTC")
    return fmt.format(Date(ms))
  }

  override fun onDestroy() {
    if (active) finish("INTERRUPTED")
    super.onDestroy()
  }
}
