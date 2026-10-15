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
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.DisplayMetrics
import android.view.WindowManager
import java.io.File

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
    // UC-STR-001 — kept in agreement BY VALUE (Kotlin cannot import the TS
    // authority) with CAPTURE_LIMITS in packages/shared/src/capture-limits.ts and
    // SCREEN_CONTINUOUS_STREAM_BOUNDS; apps/mobile/test/capture-limits-native-sync
    // parses these lines and fails on drift.
    // MAX_SEGMENTS = MAX_EVIDENCE_PARTS - 1: one record part is the manifest.
    const val MAX_SEGMENTS = 199
    const val DEFAULT_SEGMENT_MS = 6000
    const val MIN_SEGMENT_MS = 2000
    const val MAX_SEGMENT_MS = 30000
    private const val BITRATE = 6_000_000
    private const val FRAME_RATE = 12
    private const val MAX_SEGMENT_BYTES = 64L * 1024L * 1024L
    // Total recording ceiling (ms, MONOTONIC — AUD-018), kept below the server
    // capture-session TTL so a session always stops with margin to finalize.
    // Agrees with maxSessionMs.
    private const val MAX_SESSION_MS = 50L * 60L * 1000L
    // Limitations that make a session INTERRUPTED whatever ended it are
    // INCOMPLETE_LIMITATIONS, decided by sessionCompleteness (CaptureDecisions.kt).

    private var projection: MediaProjection? = null
    private var recorder: MediaRecorder? = null
    private var virtualDisplay: VirtualDisplay? = null

    private val segments = mutableListOf<Map<String, Any?>>()
    private val limitations = linkedSetOf<String>()
    // AUD-018 — durations, offsets and the session bound are monotonic
    // (elapsedRealtime); the wall clock only names the session's instants.
    private val timeline = SessionTimeline(SystemCaptureClock)
    private var startedAtUtc = ""
    private var segmentMs = DEFAULT_SEGMENT_MS
    private var maxSegments = MAX_SEGMENTS
    // Session-INITIAL display geometry (the manifest's session-level device block).
    private var widthPx = 0
    private var heightPx = 0
    private var densityDpi = 0
    // Geometry the CURRENT segment is being recorded at (may differ after a
    // rotation; each ORIGINAL segment records its own true geometry).
    private var segW = 0
    private var segH = 0
    private var segDpi = 0
    // AUD-029 — what the encoder actually records the current segment at: the
    // display geometry scaled (aspect kept, aligned) into the device's H.264
    // encoder capabilities. Each segment reports this, its true geometry.
    private var encW = 0
    private var encH = 0
    // AUD-029 — the stable reason the last segment could not start
    // (ENCODER_UNSUPPORTED_SIZE, SEGMENT_START_FAILED), and the stable detail of
    // how the session ended (RECORDER_ERROR_<what>, ...), never raw prose.
    private var segmentStartFailure: String? = null
    private var terminationDetail: String? = null
    private var recorderErrorExtra: Int? = null
    private var currentFile: File? = null
    private var segmentStartElapsedMs = 0L
    @Volatile private var active = false
    private var terminationReason = "USER_STOPPED"
    private var last: Map<String, Any?>? = null

    private var resultCode = 0
    private var resultData: Intent? = null
    private var onStartedCb: ((String) -> Unit)? = null
    // UC-AND-013 — the failure counterpart of onStartedCb: a setup failure after
    // consent REJECTS the JS start instead of leaving it pending forever.
    private var onStartFailedCb: ((String, String) -> Unit)? = null

    var onSegment: ((Map<String, Any?>) -> Unit)? = null
    var onStopped: ((Map<String, Any?>) -> Unit)? = null

    fun isActive(): Boolean = active
    fun segmentCount(): Int = segments.size
    fun lastOutcome(): Map<String, Any?>? = last
    /**
     * UC-AND-004 — every segment finalised in the current (or last) session, so
     * a recreated JS context can resume uploading them instead of orphaning a
     * live recording. The static callbacks are re-bound by each new module.
     */
    fun segmentsSnapshot(): List<Map<String, Any?>> = segments.toList()

    /** Delete every local segment file of the last session and forget it. */
    fun discardSpool(context: Context?) {
      if (active) return
      for (seg in segments) {
        val uri = seg["uri"] as? String ?: continue
        try { File(uri.removePrefix("file://")).delete() } catch (_: Throwable) {}
      }
      try {
        context?.cacheDir?.listFiles()?.filter { it.name.startsWith("proovra-continuous-") && it.name.endsWith(".mp4") }
          ?.forEach { it.delete() }
      } catch (_: Throwable) {}
      segments.clear()
      last = null
    }

    fun start(
      context: Context, code: Int, data: Intent, segMs: Int, maxSeg: Int,
      onStarted: (String) -> Unit, onStartFailed: (String, String) -> Unit,
    ) {
      resultCode = code; resultData = data
      segmentMs = segMs.coerceIn(MIN_SEGMENT_MS, MAX_SEGMENT_MS)
      maxSegments = maxSeg.coerceIn(1, MAX_SEGMENTS)
      onStartedCb = onStarted; onStartFailedCb = onStartFailed
      terminationReason = "USER_STOPPED"
      terminationDetail = null; recorderErrorExtra = null; segmentStartFailure = null
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
    // UC-AND-013 — any setup failure (no token, a null projection, a
    // SecurityException from getMediaProjection, a display that cannot be
    // created) settles the JS start as a rejection.
    try {
      beginProjection()
    } catch (t: Throwable) {
      failStart(START_FAILED, startFailureMessage(t))
    }
    return START_NOT_STICKY
  }

  /** Release whatever setup created and REJECT the pending start (UC-AND-013). */
  private fun failStart(code: String, message: String) {
    active = false
    unregisterDisplayListener()
    try { recorder?.reset(); recorder?.release() } catch (_: Throwable) {}
    recorder = null
    try { virtualDisplay?.release() } catch (_: Throwable) {}
    try { projection?.stop() } catch (_: Throwable) {}
    virtualDisplay = null; projection = null
    currentFile?.delete(); currentFile = null
    val cb = onStartFailedCb
    onStartedCb = null; onStartFailedCb = null
    cb?.invoke(code, message)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
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
    val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    // The decision is obtainProjection (CaptureDecisions.kt), unit-tested on the JVM.
    val mp = when (val outcome = obtainProjection(resultData) { mpm.getMediaProjection(resultCode, it) }) {
      is ProjectionOutcome.Refused -> return failStart(outcome.code, outcome.message)
      is ProjectionOutcome.Ready -> outcome.projection
    }
    projection = mp

    val metrics = DisplayMetrics()
    @Suppress("DEPRECATION")
    (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
    widthPx = metrics.widthPixels; heightPx = metrics.heightPixels; densityDpi = metrics.densityDpi
    segW = widthPx; segH = heightPx; segDpi = densityDpi
    timeline.start(); startedAtUtc = timeline.startUtc()

    mp.registerCallback(object : MediaProjection.Callback() {
      override fun onStop() { finish("PERMISSION_REVOKED") }
    }, null)

    // Deterministic rotation handling: a display geometry change finalizes the
    // current segment and starts the next at the new geometry (same Evidence).
    registerDisplayListener()

    active = true
    if (!startNextSegment()) {
      failStart(segmentStartFailure ?: "RECORDER_UNAVAILABLE", "The screen recorder could not start.")
      return
    }
    onStartedCb?.invoke(startedAtUtc)
    onStartedCb = null; onStartFailedCb = null
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

  /**
   * AUD-029 — the device's H.264 encoder capabilities (MediaCodecList,
   * REGULAR_CODECS), or null when none is listed. clampEncoderConfig
   * (EncoderClamp.kt, JVM-tested) decides from them.
   */
  private fun avcEncoderCaps(): EncoderCaps? = try {
    var found: EncoderCaps? = null
    for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
      if (!info.isEncoder) continue
      if (info.supportedTypes.none { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, ignoreCase = true) }) continue
      val vc = info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).videoCapabilities ?: continue
      found = EncoderCaps(
        widthAlignment = vc.widthAlignment,
        heightAlignment = vc.heightAlignment,
        maxWidth = vc.supportedWidths.upper,
        maxHeight = vc.supportedHeights.upper,
        minWidth = vc.supportedWidths.lower,
        minHeight = vc.supportedHeights.lower,
        minBitrate = vc.bitrateRange.lower,
        maxBitrate = vc.bitrateRange.upper,
        maxFrameRate = vc.supportedFrameRates.upper,
        isSizeSupported = { w, h -> vc.isSizeSupported(w, h) },
      )
      break
    }
    found
  } catch (_: Throwable) {
    null
  }

  private fun newRecorder(outFile: File, config: EncoderConfig): MediaRecorder {
    val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
    // SCREEN ONLY — no audio source is configured on purpose.
    r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    r.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
    // Each segment records at ITS OWN geometry (the current display, clamped into
    // the encoder's capabilities), so a segment started after a rotation encodes
    // at the new geometry — never a stretched/cropped frame.
    r.setVideoSize(config.width, config.height)
    r.setVideoFrameRate(config.frameRate)
    r.setVideoEncodingBitRate(config.bitrate)
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
    // AUD-029 — a runtime recorder/encoder error ends the session with a STABLE
    // detail (RECORDER_ERROR_<what>, plus the extra), never a bare "ERROR".
    r.setOnErrorListener { _, what, extra ->
      recorderErrorExtra = extra
      finish("ERROR", recorderErrorCode(what))
    }
    return r
  }

  /** Start recording the next segment; returns false on setup failure. */
  private fun startNextSegment(): Boolean {
    if (!active) return false
    if (segments.size >= maxSegments || timeline.boundReached(MAX_SESSION_MS)) {
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
    // AUD-029 — never ask the encoder for a size, bitrate or rate it cannot do.
    val config = clampEncoderConfig(segW, segH, BITRATE, FRAME_RATE, avcEncoderCaps())
    if (config == null) {
      segmentStartFailure = ENCODER_UNSUPPORTED_SIZE
      return false
    }
    encW = config.width; encH = config.height
    var started: MediaRecorder? = null
    return try {
      val file = File(cacheDir, "proovra-continuous-${timeline.startWallMs}-${segments.size}.mp4")
      currentFile = file
      val r = newRecorder(file, config)
      started = r
      r.prepare()
      val vd = virtualDisplay
      if (vd == null) {
        virtualDisplay = projection!!.createVirtualDisplay(
          "proovra-continuous", encW, encH, segDpi,
          DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, null,
        )
      } else {
        // Resize to the current geometry FIRST, then bind the new segment's surface.
        try { vd.resize(encW, encH, segDpi) } catch (_: Throwable) {}
        vd.surface = r.surface
      }
      r.start()
      recorder = r
      segmentStartElapsedMs = timeline.nowElapsedMs()
      true
    } catch (t: Throwable) {
      // A recorder that could not prepare/start is released and its empty file
      // removed; the caller records the failure (AUD-029).
      try { started?.reset(); started?.release() } catch (_: Throwable) {}
      try { currentFile?.delete() } catch (_: Throwable) {}
      currentFile = null
      segmentStartFailure = SEGMENT_START_FAILED
      false
    }
  }

  /** Finalize the current segment and start the next (bounded). */
  private fun rolloverSegment() {
    if (!active) return
    finalizeCurrentSegment()
    if (!active) return
    // AUD-029 — a next segment that cannot start is a RECORDED failure that ends
    // the session as ERROR, never a silent stall later sealed as COMPLETE_SESSION.
    if (!startNextSegment()) {
      limitations.add("SEGMENT_WRITE_FAILED")
      finish("ERROR", segmentStartFailure ?: SEGMENT_START_FAILED)
    }
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
    // UC-AND-007 — a stop() that throws leaves an mp4 with no finalised moov
    // box: unplayable, yet it was uploaded and sealed as ORIGINAL video with a
    // wall-clock duration. It is now deleted and recorded as a limitation (which
    // makes the session INTERRUPTED), never emitted as a segment.
    // The decision is closeSegment (CaptureDecisions.kt), unit-tested on the JVM.
    val outcome = closeSegment(
      stop = { r.stop() },
      release = { r.reset(); r.release() },
      writtenBytes = { if (file != null && file.exists()) file.length() else 0L },
      deleteFile = { file?.delete() },
    )
    recorder = null
    try { virtualDisplay?.surface = null } catch (_: Throwable) {}
    if (outcome == SegmentClose.DISCARD_WRITE_FAILED) {
      limitations.add("SEGMENT_WRITE_FAILED")
      currentFile = null
      return
    }
    if (outcome == SegmentClose.EMIT && file != null) {
      val seq = segments.size
      // Record THIS segment's own encoded geometry (encW/encH), which reflects any
      // rotation that took effect at its start boundary — so the manifest's
      // per-segment orientation is truthful across transitions.
      val seg = mapOf<String, Any?>(
        "uri" to "file://${file.absolutePath}",
        "sequence" to seq,
        "startedAtOffsetMs" to timeline.offsetOf(segmentStartElapsedMs),
        "durationMs" to timeline.since(segmentStartElapsedMs),
        "widthPx" to encW,
        "heightPx" to encH,
        "orientation" to if (encW >= encH) "landscape" else "portrait",
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

  private fun finish(reason: String, detail: String? = null) {
    if (!active && last != null) return
    if (detail != null && terminationDetail == null) terminationDetail = detail
    active = false
    unregisterDisplayListener()
    finalizeCurrentSegment()
    try { virtualDisplay?.release() } catch (_: Throwable) {}
    try { projection?.stop() } catch (_: Throwable) {}
    virtualDisplay = null; projection = null

    if (reason !in CLEAN_TERMINATIONS) limitations.add("CAPTURE_INTERRUPTED")
    // A clean stop over a lost stretch (a segment that could not be written) is
    // still not a complete session: sessionCompleteness (CaptureDecisions.kt).
    val completeness = sessionCompleteness(reason, limitations)
    val totalMs = timeline.offsetMs()
    val outcome = mapOf<String, Any?>(
      "osConsentGranted" to true,
      "captureStartedAtUtc" to startedAtUtc,
      "captureEndedAtUtc" to timeline.utcAtOffset(totalMs),
      "device" to mapOf(
        "platform" to "android",
        "osVersion" to (Build.VERSION.RELEASE ?: "unknown"),
        "model" to ((Build.MANUFACTURER ?: "") + " " + (Build.MODEL ?: "")).trim().ifEmpty { "Android device" },
        "appVersion" to appVersionName(),
        "screenW" to widthPx, "screenH" to heightPx, "densityDpi" to densityDpi,
        "orientation" to if (widthPx >= heightPx) "landscape" else "portrait",
      ),
      "totalDurationMs" to totalMs,
      "segmentCount" to segments.size,
      "sessionCompleteness" to completeness,
      "terminationReason" to reason,
      // AUD-029 — the stable code of what failed (null on a clean end).
      "terminationDetail" to terminationDetail,
      "recorderErrorExtra" to recorderErrorExtra,
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

  override fun onDestroy() {
    if (active) finish("INTERRUPTED")
    super.onDestroy()
  }
}
