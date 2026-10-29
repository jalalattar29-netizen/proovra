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
 * ONE video file (layout SINGLE_FILE, wire contracts A/B).
 *
 * It becomes a foreground service (type mediaProjection, plus microphone when
 * the user asked for it) with a visible notification carrying a Stop action
 * BEFORE creating the projection (Android 14 ordering), then records with ONE
 * MediaRecorder into a VirtualDisplay-backed Surface from Start to Stop.
 *
 * One recording (2026-10-29) — it used to cap every segment with
 * setMaxDuration(segmentMs) and stop/release/recreate the recorder on every
 * rollover and rotation: real frame gaps between files. Now:
 *   - ONE MediaRecorder for the whole session; no rollover, no restart, no
 *     next-file. setMaxDuration / setMaxFileSize are the SESSION bounds
 *     (MAX_SESSION_MS; MAX_SESSION_BYTES, lowered so the 200 MB free-space floor
 *     is kept): reaching one STOPS the recording with BOUNDS_REACHED +
 *     SESSION_BOUNDS_REACHED — never a split.
 *   - Rotation: the encoder and the VirtualDisplay keep the initial canvas
 *     (the system mirrors the rotated display into it, aspect preserved). The
 *     DisplayListener records each change in `orientationTimeline` (+
 *     ORIENTATION_CHANGED_DURING_CAPTURE); nothing is resized mid-recording.
 *   - Audio: the MICROPHONE only, only when JS asked (`microphone: true`) after
 *     the user's in-app consent AND the RECORD_AUDIO runtime grant (the module
 *     refuses otherwise). MediaRecorder cannot capture other apps' audio, so
 *     `audioTracks` is [] or ["MICROPHONE"] — stated, never implied; [] is
 *     AUDIO_NOT_CAPTURED. A microphone Android refuses (FGS type, busy mic)
 *     falls back to a silent recording that says so.
 *   - Interruption (projection revoked, onDestroy, recorder error) stops what
 *     MediaRecorder allows. A stop() that throws leaves an MP4 with no moov box
 *     (unplayable): the file is deleted and the result says finalized=false
 *     with SEGMENT_WRITE_FAILED — never presented as a recording. A process
 *     death is recovered from the durable ledger (ContinuousLedger.kt).
 *
 * No FLAG_SECURE bypass, no overlay, no Accessibility. Bounded memory by
 * design: bytes stream to disk, never RAM. No per-segment events: JS receives
 * the one recording in the stop result.
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
    // The segment values are only the legacy start options the module still
    // clamps and echoes: this recorder writes ONE file and never rolls over.
    const val MAX_SEGMENTS = 199
    const val DEFAULT_SEGMENT_MS = 6000
    const val MIN_SEGMENT_MS = 2000
    const val MAX_SEGMENT_MS = 30000
    private const val BITRATE = 6_000_000
    private const val FRAME_RATE = 12
    // Legacy per-segment ceiling (SEGMENTED layout); the one file's ceiling is MAX_SESSION_BYTES.
    private const val MAX_SEGMENT_BYTES = 64L * 1024L * 1024L
    // THE byte bound of the one recording file (maxContinuousSessionBytes).
    private const val MAX_SESSION_BYTES = 512L * 1024L * 1024L
    // Never record into the last 200 MB of free space.
    private const val MIN_FREE_BYTES = 200L * 1024L * 1024L
    // Refuse to start a recording that could not hold even this much.
    private const val MIN_RECORDING_BYTES = 16L * 1024L * 1024L
    private const val AUDIO_BITRATE = 128_000
    private const val AUDIO_SAMPLE_RATE = 44_100
    // AUD-004 — the durable spool (the recording file + ledger.json) under filesDir.
    private const val SPOOL_DIR = "proovra-continuous"
    private const val SEGMENT_PREFIX = "proovra-continuous-"
    // Total recording ceiling (ms, MONOTONIC — AUD-018), kept below the server
    // capture-session TTL so a session always stops with margin to finalize.
    // Agrees with maxSessionMs.
    private const val MAX_SESSION_MS = 50L * 60L * 1000L
    // Limitations that make a session INTERRUPTED whatever ended it are
    // INCOMPLETE_LIMITATIONS, decided by sessionCompleteness (CaptureDecisions.kt).
    const val STORAGE_LOW = "STORAGE_LOW"

    private var projection: MediaProjection? = null
    private var recorder: MediaRecorder? = null
    private var virtualDisplay: VirtualDisplay? = null

    // The ONE recording once finalised (as segment 0), for snapshots and cleanup.
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
    // AUD-029 — the canvas the encoder records the WHOLE file at: the initial
    // display geometry scaled (aspect kept, aligned) into the device's H.264
    // encoder capabilities. Fixed for the recording.
    private var encW = 0
    private var encH = 0
    // Contract A — the display's orientation over the recording.
    private var orientationTimeline: List<LedgerOrientation> = emptyList()
    // The microphone: asked for by JS, and actually configured on the recorder.
    private var microphoneRequested = false
    private var microphoneActive = false
    // AUD-029 — the stable reason the recorder could not start
    // (ENCODER_UNSUPPORTED_SIZE, SEGMENT_START_FAILED, STORAGE_LOW), and the
    // stable detail of how the session ended (RECORDER_ERROR_<what>, ...).
    private var startFailure: String? = null
    private var terminationDetail: String? = null
    private var recorderErrorExtra: Int? = null
    private var currentFile: File? = null
    private var recordingStartElapsedMs = 0L
    @Volatile private var active = false
    private var terminationReason = "USER_STOPPED"
    private var last: Map<String, Any?>? = null

    private var resultCode = 0
    private var resultData: Intent? = null
    private var onStartedCb: ((String) -> Unit)? = null
    // UC-AND-013 — the failure counterpart of onStartedCb: a setup failure after
    // consent REJECTS the JS start instead of leaving it pending forever.
    private var onStartFailedCb: ((String, String) -> Unit)? = null

    var onStopped: ((Map<String, Any?>) -> Unit)? = null

    fun isActive(): Boolean = active
    fun segmentCount(): Int = segments.size

    /**
     * AUD-004 — the recording file and the durable ledger live in filesDir (the
     * OS may purge cacheDir under storage pressure, and this may be the only
     * copy of a recording). The ledger is attached by the module at creation
     * and by every start.
     */
    fun spoolDir(context: Context): File = File(context.filesDir, SPOOL_DIR)

    fun attachLedger(context: Context) {
      ContinuousLedgerKeeper.attach(spoolDir(context))
    }

    /**
     * The last session's outcome: the in-memory one, or — after a process
     * death wiped it — the one the durable ledger proves (INTERRUPTED unless
     * the recorder recorded a clean finish). Null when there is no recording.
     */
    fun lastOutcome(): Map<String, Any?>? {
      last?.let { return it }
      if (active) return null
      val l = recoveredLedger() ?: return null
      return ledgerOutcome(l)
    }

    /**
     * AUD-004 — the durable ledger, recovered: a ledger still RECORDING with no
     * active recorder is a process death, persisted as INTERRUPTED (idempotent).
     */
    internal fun recoveredLedger(): ContinuousLedger? {
      val l = ContinuousLedgerKeeper.get() ?: return null
      val recovered = recoverLedger(l, active)
      if (recovered != l) ContinuousLedgerKeeper.replace(recovered)
      return recovered
    }

    fun ledgerForJs(): Map<String, Any?>? = recoveredLedger()?.let { ledgerToJs(it, active) }

    /**
     * UC-AND-004 — the finalised recording of the current (or last) session, so
     * a recreated JS context can upload it instead of orphaning it. Empty while
     * recording (the one file is not finalised yet). AUD-004 — after a process
     * death the durable ledger's not-yet-uploaded recording is returned instead.
     */
    fun segmentsSnapshot(): List<Map<String, Any?>> {
      if (segments.isNotEmpty() || active) return segments.toList()
      val l = ContinuousLedgerKeeper.get() ?: return emptyList()
      return ledgerSegmentsToJs(l).filter { it["uploadState"] == SEGMENT_RECORDED }
    }

    /** A new recording may not overwrite one the ledger still holds (AUD-004). */
    fun newRecordingBlocked(): Boolean = blocksNewRecording(ContinuousLedgerKeeper.get(), active)

    /**
     * AUD-004 — bind the recording to the PROOVRA session JS opened for it.
     * False when the ledger is bound to another session (never merged).
     */
    fun bindSession(captureSessionId: String, evidenceId: String, ownerUserId: String?): Boolean {
      var ok = false
      ContinuousLedgerKeeper.update { l ->
        when (val outcome = bindLedger(l, captureSessionId, evidenceId, ownerUserId)) {
          is BindOutcome.Bound -> { ok = true; outcome.ledger }
          BindOutcome.Mismatch -> null
        }
      }
      return ok
    }

    /**
     * AUD-004 — PROOVRA confirmed the recording (sequence 0): the ledger says so
     * FIRST, and only then is the local file (no longer the only copy) deleted.
     * False when the ledger is bound to another session or refuses it.
     */
    fun markSegmentUploaded(captureSessionId: String, sequence: Int, sha256Hex: String, sizeBytes: Long): Boolean {
      var ok = false
      val after = ContinuousLedgerKeeper.update { l ->
        val next = ledgerMarkUploaded(l, captureSessionId, sequence, sha256Hex, sizeBytes)
        ok = next != null
        next
      }
      if (!ok || after == null) return false
      val seg = after.segments.firstOrNull { it.sequence == sequence }
      if (seg != null && seg.path in automaticallyDeletablePaths(after)) {
        try { File(seg.path).delete() } catch (_: Throwable) {}
      }
      return true
    }

    /**
     * AUD-004 — the bound session is staged (declared, stored, and its manifest
     * uploaded): the spool is released. Refused (false, nothing deleted) unless
     * the ledger is bound to exactly this session.
     */
    fun commitSpool(context: Context?, captureSessionId: String): Boolean {
      if (active) return false
      if (!ledgerBoundTo(ContinuousLedgerKeeper.get(), captureSessionId)) return false
      deleteSpoolFiles(context)
      return true
    }

    /**
     * The user's EXPLICIT discard of the last recording: its local file (and
     * any legacy segment files) and the durable ledger. Never automatic (AUD-004).
     */
    fun discardSpool(context: Context?) {
      if (active) return
      deleteSpoolFiles(context)
    }

    private fun deleteSpoolFiles(context: Context?) {
      for (seg in segments) {
        val uri = seg["uri"] as? String ?: continue
        try { File(uri.removePrefix("file://")).delete() } catch (_: Throwable) {}
      }
      val l = ContinuousLedgerKeeper.get()
      for (seg in l?.segments ?: emptyList()) {
        try { File(seg.path).delete() } catch (_: Throwable) {}
      }
      // The one recording, finalised or not (an unfinalised file is unplayable).
      l?.recordingPath?.let { path -> try { File(path).delete() } catch (_: Throwable) {} }
      try {
        if (context != null) {
          spoolDir(context).listFiles()?.filter { it.name.startsWith(SEGMENT_PREFIX) && it.name.endsWith(".mp4") }
            ?.forEach { it.delete() }
          // Files written by builds that spooled into cacheDir.
          context.cacheDir?.listFiles()?.filter { it.name.startsWith(SEGMENT_PREFIX) && it.name.endsWith(".mp4") }
            ?.forEach { it.delete() }
        }
      } catch (_: Throwable) {}
      ContinuousLedgerKeeper.clear()
      segments.clear()
      last = null
    }

    fun start(
      context: Context, code: Int, data: Intent, segMs: Int, maxSeg: Int, microphone: Boolean,
      onStarted: (String) -> Unit, onStartFailed: (String, String) -> Unit,
    ) {
      resultCode = code; resultData = data
      segmentMs = segMs.coerceIn(MIN_SEGMENT_MS, MAX_SEGMENT_MS)
      maxSegments = maxSeg.coerceIn(1, MAX_SEGMENTS)
      microphoneRequested = microphone; microphoneActive = false
      onStartedCb = onStarted; onStartFailedCb = onStartFailed
      terminationReason = "USER_STOPPED"
      terminationDetail = null; recorderErrorExtra = null; startFailure = null
      segments.clear(); limitations.clear(); last = null
      orientationTimeline = emptyList(); currentFile = null; encW = 0; encH = 0
      // AUD-004 — the module refused the start if the ledger still holds a
      // recording (blocksNewRecording); one that holds nothing is released.
      attachLedger(context)
      if (!blocksNewRecording(ContinuousLedgerKeeper.get(), false)) ContinuousLedgerKeeper.clear()
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
    // UC-AND-013 — any setup failure (the foreground start, no token, a null
    // projection, a SecurityException from getMediaProjection, a display that
    // cannot be created) settles the JS start as a rejection.
    try {
      startForegroundWithNotification()
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
    // AUD-004 — a start that never recorded leaves no ledger behind.
    if (!blocksNewRecording(ContinuousLedgerKeeper.get(), false)) ContinuousLedgerKeeper.clear()
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
      .setContentText(
        if (microphoneRequested) "Screen and microphone recording is active. Tap Stop to end."
        else "Screen recording is active. Tap Stop to end.",
      )
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Stop", stopPi).build())
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // Android 11+ gives a foreground service the microphone only when it is
      // typed `microphone`; Android 14 refuses that type without RECORD_AUDIO.
      if (microphoneRequested && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        try {
          startForeground(
            NOTIF_ID, notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
          )
          return
        } catch (_: Throwable) {
          // Refused: record the screen without the microphone, and say so.
          microphoneRequested = false
          limitations.add("AUDIO_NOT_CAPTURED")
        }
      }
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

    val metrics = currentMetrics()
    widthPx = metrics.widthPixels; heightPx = metrics.heightPixels; densityDpi = metrics.densityDpi
    timeline.start(); startedAtUtc = timeline.startUtc()
    orientationTimeline = withOrientation(emptyList(), 0L, widthPx, heightPx)

    mp.registerCallback(object : MediaProjection.Callback() {
      override fun onStop() { finish("PERMISSION_REVOKED") }
    }, null)

    // Rotation is RECORDED (orientationTimeline), never a new file or a resize.
    registerDisplayListener()

    active = true
    if (!startRecorder()) {
      failStart(startFailure ?: "RECORDER_UNAVAILABLE", "The screen recorder could not start.")
      return
    }
    if (!microphoneActive) limitations.add("AUDIO_NOT_CAPTURED")
    // AUD-004 — the durable ledger exists from the moment recording does, and
    // names the one file before it is finalised.
    ContinuousLedgerKeeper.replace(
      ContinuousLedger(
        recordingId = "${timeline.startWallMs}-${java.util.UUID.randomUUID()}",
        startedAtUtc = startedAtUtc,
        startedAtWallMs = timeline.startWallMs,
        device = deviceBlock(),
        limitations = limitations.toList(),
        layout = LAYOUT_SINGLE_FILE,
        recordingPath = currentFile?.absolutePath,
        canvasW = encW,
        canvasH = encH,
        orientationTimeline = orientationTimeline,
        audioTracks = audioTracks(),
      ),
    )
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

  private fun currentMetrics(): DisplayMetrics {
    val m = DisplayMetrics()
    @Suppress("DEPRECATION")
    (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(m)
    return m
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

  private fun newRecorder(outFile: File, config: EncoderConfig, maxBytes: Long, withMicrophone: Boolean): MediaRecorder {
    val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
    // The microphone only when the user asked for it (and RECORD_AUDIO is granted).
    if (withMicrophone) r.setAudioSource(MediaRecorder.AudioSource.MIC)
    r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    r.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
    if (withMicrophone) {
      r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      r.setAudioEncodingBitRate(AUDIO_BITRATE)
      r.setAudioSamplingRate(AUDIO_SAMPLE_RATE)
      r.setAudioChannels(1)
    }
    // The whole file records at ONE canvas: the initial display geometry,
    // clamped into the encoder's capabilities.
    r.setVideoSize(config.width, config.height)
    r.setVideoFrameRate(config.frameRate)
    r.setVideoEncodingBitRate(config.bitrate)
    r.setOutputFile(outFile.absolutePath)
    // THE session bounds of the one file. Reaching one stops the recording;
    // it is never continued into another file.
    r.setMaxDuration(MAX_SESSION_MS.toInt())
    r.setMaxFileSize(maxBytes)
    r.setOnInfoListener { _, what, _ ->
      if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED ||
        what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED
      ) {
        limitations.add("SESSION_BOUNDS_REACHED")
        finish("BOUNDS_REACHED")
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

  /**
   * Start THE recorder for the whole session; false on setup failure (the
   * reason is in startFailure). A microphone that cannot be configured falls
   * back to a screen-only recording (AUDIO_NOT_CAPTURED), never to no recording.
   */
  private fun startRecorder(): Boolean {
    if (!active) return false
    // AUD-029 — never ask the encoder for a size, bitrate or rate it cannot do.
    val config = clampEncoderConfig(widthPx, heightPx, BITRATE, FRAME_RATE, avcEncoderCaps())
    if (config == null) {
      startFailure = ENCODER_UNSUPPORTED_SIZE
      return false
    }
    encW = config.width; encH = config.height
    val dir = spoolDir(this)
    if (!dir.exists()) dir.mkdirs()
    // The byte bound keeps the free-space floor: the file stops (BOUNDS_REACHED)
    // before the device drops below MIN_FREE_BYTES.
    val maxBytes = minOf(MAX_SESSION_BYTES, dir.usableSpace - MIN_FREE_BYTES)
    if (maxBytes < MIN_RECORDING_BYTES) {
      startFailure = STORAGE_LOW
      return false
    }
    val file = File(dir, "$SEGMENT_PREFIX${timeline.startWallMs}.mp4")
    // Never overwrite a file this recorder did not create.
    if (file.exists()) {
      startFailure = SEGMENT_START_FAILED
      return false
    }
    currentFile = file
    if (microphoneRequested) {
      if (tryStartRecorder(file, config, maxBytes, withMicrophone = true)) {
        microphoneActive = true
        return true
      }
      // The microphone is busy or refused: record the screen alone, and say so.
      microphoneActive = false
    }
    return tryStartRecorder(file, config, maxBytes, withMicrophone = false)
  }

  private fun tryStartRecorder(file: File, config: EncoderConfig, maxBytes: Long, withMicrophone: Boolean): Boolean {
    var started: MediaRecorder? = null
    return try {
      val r = newRecorder(file, config, maxBytes, withMicrophone)
      started = r
      r.prepare()
      val vd = virtualDisplay
      if (vd == null) {
        // The VirtualDisplay is created ONCE, at the fixed canvas.
        virtualDisplay = projection!!.createVirtualDisplay(
          "proovra-continuous", encW, encH, densityDpi,
          DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, null,
        )
      } else {
        vd.surface = r.surface
      }
      r.start()
      recorder = r
      recordingStartElapsedMs = timeline.nowElapsedMs()
      true
    } catch (_: Throwable) {
      // A recorder that could not prepare/start is released and the file it
      // created removed; the caller records the failure (AUD-029).
      try { started?.reset(); started?.release() } catch (_: Throwable) {}
      try { virtualDisplay?.surface = null } catch (_: Throwable) {}
      try { file.delete() } catch (_: Throwable) {}
      startFailure = SEGMENT_START_FAILED
      false
    }
  }

  /**
   * A display geometry change is RECORDED on the orientation timeline (and
   * named when the orientation differs from the initial one). The encoder and
   * the VirtualDisplay keep the initial canvas: nothing restarts, nothing is
   * resized, no frame is lost to a rotation.
   */
  private fun onDisplayGeometryChanged() {
    if (!active) return
    val m = currentMetrics()
    val next = withOrientation(orientationTimeline, timeline.offsetMs(), m.widthPixels, m.heightPixels)
    if (next == orientationTimeline) return
    orientationTimeline = next
    if ((m.widthPixels >= m.heightPixels) != (widthPx >= heightPx)) limitations.add("ORIENTATION_CHANGED_DURING_CAPTURE")
    // Durable: a process death still knows the rotations it recorded.
    ContinuousLedgerKeeper.update { it.copy(orientationTimeline = orientationTimeline, limitations = limitations.toList()) }
  }

  /**
   * Stop THE recorder and keep the file only if MediaRecorder finalised it.
   * Returns true when the one recording is a playable, finalised MP4.
   */
  private fun closeRecording(): Boolean {
    val r = recorder ?: return false
    val file = currentFile
    // UC-AND-007 — a stop() that throws leaves an mp4 with no finalised moov
    // box: unplayable. It is deleted and recorded (SEGMENT_WRITE_FAILED, which
    // makes the session INTERRUPTED), never presented as the recording.
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
      return false
    }
    if (outcome != SegmentClose.EMIT || file == null) {
      // Nothing was written: there is no recording to keep.
      try { file?.delete() } catch (_: Throwable) {}
      limitations.add("SEGMENT_WRITE_FAILED")
      return false
    }
    val duration = timeline.since(recordingStartElapsedMs)
    val offset = timeline.offsetOf(recordingStartElapsedMs)
    val orientation = if (widthPx >= heightPx) "landscape" else "portrait"
    val seg = mapOf<String, Any?>(
      "uri" to "file://${file.absolutePath}",
      "sequence" to 0,
      "startedAtOffsetMs" to offset,
      "durationMs" to duration,
      "widthPx" to encW,
      "heightPx" to encH,
      "orientation" to orientation,
    )
    // AUD-004 — durable BEFORE JS hears of it.
    ContinuousLedgerKeeper.update {
      ledgerWithSegment(
        it,
        LedgerSegment(
          sequence = 0, path = file.absolutePath, sizeBytes = file.length(), sha256Hex = null,
          startedAtOffsetMs = offset, durationMs = duration, widthPx = encW, heightPx = encH,
          orientation = orientation, uploadState = SEGMENT_RECORDED,
        ),
      ).copy(recordingFinalized = true)
    }
    segments.add(seg)
    return true
  }

  private fun audioTracks(): List<String> = if (microphoneActive) listOf(AUDIO_TRACK_MICROPHONE) else emptyList()

  private fun finish(reason: String, detail: String? = null) {
    if (!active && last != null) return
    if (detail != null && terminationDetail == null) terminationDetail = detail
    active = false
    unregisterDisplayListener()
    val finalized = closeRecording()
    try { virtualDisplay?.release() } catch (_: Throwable) {}
    try { projection?.stop() } catch (_: Throwable) {}
    virtualDisplay = null; projection = null

    if (reason !in CLEAN_TERMINATIONS) limitations.add("CAPTURE_INTERRUPTED")
    val tracks = audioTracks()
    if (tracks.isEmpty()) limitations.add("AUDIO_NOT_CAPTURED")
    // A clean stop whose file could not be finalised is still not a complete
    // session: sessionCompleteness (CaptureDecisions.kt).
    val completeness = sessionCompleteness(reason, limitations)
    val totalMs = timeline.offsetMs()
    val endedAtUtc = timeline.utcAtOffset(totalMs)
    val device = deviceBlock()
    val file = currentFile
    val outcome = mapOf<String, Any?>(
      "osConsentGranted" to true,
      "captureStartedAtUtc" to startedAtUtc,
      "captureEndedAtUtc" to endedAtUtc,
      "device" to mapOf(
        "platform" to device.platform,
        "osVersion" to device.osVersion,
        "model" to device.model,
        "appVersion" to device.appVersion,
        "screenW" to device.screenW, "screenH" to device.screenH, "densityDpi" to device.densityDpi,
        "orientation" to device.orientation,
      ),
      "totalDurationMs" to totalMs,
      "segmentCount" to segments.size,
      "sessionCompleteness" to completeness,
      "terminationReason" to reason,
      // AUD-029 — the stable code of what failed (null on a clean end).
      "terminationDetail" to terminationDetail,
      "recorderErrorExtra" to recorderErrorExtra,
      "limitations" to limitations.toList(),
    ) + recordingFieldsToJs(
      recordingPath = file?.absolutePath,
      finalized = finalized,
      sizeBytes = if (finalized && file != null) file.length() else null,
      durationMs = if (finalized) (segments.firstOrNull()?.get("durationMs") as? Long) else null,
      canvasW = encW,
      canvasH = encH,
      orientationTimeline = orientationTimeline,
      audioTracks = tracks,
    )
    // AUD-004 — the clean (or unclean) finish is durable before anyone is told.
    ContinuousLedgerKeeper.update {
      ledgerFinished(it, reason, terminationDetail, limitations.toList(), completeness, totalMs, endedAtUtc)
        .copy(recordingFinalized = finalized, orientationTimeline = orientationTimeline, audioTracks = tracks)
    }
    last = outcome
    onStopped?.invoke(outcome)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  /** The session-INITIAL device block (manifest + ledger). */
  private fun deviceBlock(): LedgerDevice = LedgerDevice(
    platform = "android",
    osVersion = Build.VERSION.RELEASE ?: "unknown",
    model = ((Build.MANUFACTURER ?: "") + " " + (Build.MODEL ?: "")).trim().ifEmpty { "Android device" },
    appVersion = appVersionName(),
    screenW = widthPx,
    screenH = heightPx,
    densityDpi = densityDpi,
    orientation = if (widthPx >= heightPx) "landscape" else "portrait",
  )

  private fun appVersionName(): String = try {
    packageManager.getPackageInfo(packageName, 0).versionName ?: "unknown"
  } catch (_: Throwable) { "unknown" }

  override fun onDestroy() {
    if (active) finish("INTERRUPTED")
    super.onDestroy()
  }
}
