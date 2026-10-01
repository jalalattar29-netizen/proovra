package com.proovra.screencapture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import android.view.WindowManager
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * UC-2 — the foreground service that holds one MediaProjection session and takes
 * frames ON DEMAND.
 *
 * It becomes a foreground service (type mediaProjection) with a visible
 * notification carrying "Capture Frame" and "Stop" actions BEFORE creating the
 * projection (Android 14 ordering). A frame is taken only when the user asks —
 * from the notification action or the in-app button, both routed here — so the
 * user can leave PROOVRA, show the target content in another app, and capture it.
 * A timer never captures on its own. It releases the projection/display/reader on
 * Stop, on OS revocation, or when the frame bound is reached, and reports frames
 * + context back through one-shot callbacks. Actions on a non-active service are
 * ignored (stale notification safety).
 *
 * UC-AND-012 — a rotation during the session resizes the ImageReader and the
 * VirtualDisplay, so every frame is captured at, and labelled with, the display
 * geometry it was taken in; the change is recorded as
 * ORIENTATION_CHANGED_DURING_CAPTURE. UC-AND-011 — a FLAG_SECURE window comes
 * back as black pixels WITHOUT an error, so it cannot be detected here and is
 * not claimed; a frame that could not be read or written is FRAME_CAPTURE_FAILED.
 * UC-AND-013 — a setup failure after consent rejects the pending start.
 */
class ScreenCaptureService : Service() {
  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var bgThread: HandlerThread? = null
  private var bgHandler: Handler? = null

  companion object {
    private const val CHANNEL_ID = "proovra_screen_capture"
    private const val NOTIF_ID = 0x50D2
    const val ACTION_CAPTURE_FRAME = "com.proovra.screencapture.CAPTURE_FRAME"
    const val ACTION_STOP = "com.proovra.screencapture.STOP"

    private var projection: MediaProjection? = null
    private val frames = mutableListOf<FrameOut>()
    private val limitations = linkedSetOf<String>()
    private var startedAtMs = 0L
    private var startedAtUtc = ""
    private var maxFrames = 20
    // Session-INITIAL display geometry (the manifest's device block).
    private var widthPx = 0
    private var heightPx = 0
    private var densityDpi = 0
    // The geometry frames are CURRENTLY captured at (changes on rotation).
    private var frameW = 0
    private var frameH = 0
    private var frameDpi = 0
    @Volatile private var active = false
    private var last: ScreenCaptureOutcome? = null

    private var resultCode = 0
    private var resultData: Intent? = null
    private var onStartedCb: ((String) -> Unit)? = null
    private var onStartFailedCb: ((String, String) -> Unit)? = null
    @Volatile private var stopReason: String = "USER_STOPPED"

    var onFrame: ((Int, Int) -> Unit)? = null
    var onStopped: ((ScreenCaptureOutcome) -> Unit)? = null

    fun isActive(): Boolean = active
    fun frameCount(): Int = frames.size
    fun lastOutcome(): ScreenCaptureOutcome? = last

    fun start(
      context: Context, code: Int, data: Intent, max: Int,
      onStarted: (String) -> Unit, onStartFailed: (String, String) -> Unit,
    ) {
      resultCode = code
      resultData = data
      maxFrames = max
      onStartedCb = onStarted
      onStartFailedCb = onStartFailed
      stopReason = "USER_STOPPED"
      frames.clear()
      limitations.clear()
      last = null
      val intent = Intent(context, ScreenCaptureService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }

    fun requestCaptureFrame(context: Context) {
      if (!active) return
      context.startService(Intent(context, ScreenCaptureService::class.java).setAction(ACTION_CAPTURE_FRAME))
    }

    fun requestStop(context: Context, reason: String) {
      stopReason = reason
      context.startService(Intent(context, ScreenCaptureService::class.java).setAction(ACTION_STOP))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_CAPTURE_FRAME -> {
        // Stale-notification safety: only an active projection captures.
        if (active) {
          captureOneFrame()
          updateNotification()
        }
      }
      ACTION_STOP -> finish(stopReason)
      else -> {
        startForegroundWithNotification()
        try {
          beginProjection()
        } catch (t: Throwable) {
          failStart("START_FAILED", t.message ?: "Screen capture could not start.")
        }
      }
    }
    return START_NOT_STICKY
  }

  private fun action(actionName: String, title: String): Notification.Action {
    val pi = PendingIntent.getService(
      this,
      actionName.hashCode(),
      Intent(this, ScreenCaptureService::class.java).setAction(actionName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return Notification.Action.Builder(null, title, pi).build()
  }

  private fun buildNotification(): Notification {
    val builder = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("PROOVRA screen capture is active")
      .setContentText("Captured ${frames.size} frame(s). Show the content, then Capture Frame.")
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setOngoing(true)
      .addAction(action(ACTION_CAPTURE_FRAME, "Capture Frame"))
      .addAction(action(ACTION_STOP, "Stop"))
    return builder.build()
  }

  private fun updateNotification() {
    if (!active) return
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, buildNotification())
  }

  private fun startForegroundWithNotification() {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Screen capture", NotificationManager.IMPORTANCE_LOW),
      )
    }
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(NOTIF_ID, notification)
    }
  }

  /** Release whatever setup created and REJECT the pending start (UC-AND-013). */
  private fun failStart(code: String, message: String) {
    active = false
    unregisterDisplayListener()
    try { virtualDisplay?.release() } catch (_: Throwable) {}
    try { imageReader?.close() } catch (_: Throwable) {}
    try { projection?.stop() } catch (_: Throwable) {}
    bgThread?.quitSafely()
    virtualDisplay = null
    imageReader = null
    projection = null
    val cb = onStartFailedCb
    onStartedCb = null
    onStartFailedCb = null
    cb?.invoke(code, message)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  private fun beginProjection() {
    val data = resultData
    if (data == null) {
      failStart("NO_CONSENT_TOKEN", "The screen-capture consent was not available.")
      return
    }
    val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    // getMediaProjection MUST be called after startForeground on Android 14.
    val mp = mpm.getMediaProjection(resultCode, data)
    if (mp == null) {
      failStart("PROJECTION_UNAVAILABLE", "Android did not provide the screen-capture session.")
      return
    }
    projection = mp

    val metrics = DisplayMetrics()
    @Suppress("DEPRECATION")
    (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
    widthPx = metrics.widthPixels
    heightPx = metrics.heightPixels
    densityDpi = metrics.densityDpi
    frameW = widthPx
    frameH = heightPx
    frameDpi = densityDpi
    startedAtMs = System.currentTimeMillis()
    startedAtUtc = iso(startedAtMs)

    // The OS revoking the projection (e.g. the user ends casting) fails closed.
    mp.registerCallback(object : MediaProjection.Callback() {
      override fun onStop() { finish("PERMISSION_REVOKED") }
    }, null)

    val thread = HandlerThread("proovra-screencap").also { it.start() }
    bgThread = thread
    bgHandler = Handler(thread.looper)

    val reader = ImageReader.newInstance(widthPx, heightPx, PixelFormat.RGBA_8888, 2)
    imageReader = reader
    virtualDisplay = mp.createVirtualDisplay(
      "proovra-screencap",
      widthPx,
      heightPx,
      densityDpi,
      DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
      reader.surface,
      null,
      bgHandler,
    )
    registerDisplayListener()
    active = true
    onStartedCb?.invoke(startedAtUtc)
    onStartedCb = null
    onStartFailedCb = null
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
    dm.registerDisplayListener(l, bgHandler)
  }

  private fun unregisterDisplayListener() {
    val l = displayListener ?: return
    displayListener = null
    try { (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(l) } catch (_: Throwable) {}
  }

  /**
   * UC-AND-012 — a rotation re-sizes the capture surface to the new geometry, so
   * the next frame is taken at (and labelled with) the display it shows, and the
   * orientation change is recorded.
   */
  private fun onDisplayGeometryChanged() {
    if (!active) return
    val m = DisplayMetrics()
    @Suppress("DEPRECATION")
    (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(m)
    if (m.widthPixels == frameW && m.heightPixels == frameH) return
    if ((m.widthPixels >= m.heightPixels) != (widthPx >= heightPx)) {
      limitations.add("ORIENTATION_CHANGED_DURING_CAPTURE")
    }
    val previous = imageReader
    try {
      val next = ImageReader.newInstance(m.widthPixels, m.heightPixels, PixelFormat.RGBA_8888, 2)
      virtualDisplay?.resize(m.widthPixels, m.heightPixels, m.densityDpi)
      virtualDisplay?.surface = next.surface
      imageReader = next
      frameW = m.widthPixels
      frameH = m.heightPixels
      frameDpi = m.densityDpi
      try { previous?.close() } catch (_: Throwable) {}
    } catch (_: Throwable) {
      // Keep capturing at the previous geometry; the frames still carry the
      // geometry they were actually taken at.
    }
  }

  private fun captureOneFrame() {
    if (frames.size >= maxFrames) {
      limitations.add("CAPTURE_BOUNDS_EXCEEDED")
      return
    }
    val reader = imageReader ?: return
    val image = reader.acquireLatestImage()
    val index = frames.size
    if (image == null) {
      // Nothing available yet; report a no-op frame so the UI stays truthful.
      onFrame?.invoke(-1, frames.size)
      return
    }
    try {
      val plane = image.planes[0]
      val buffer = plane.buffer
      val pixelStride = plane.pixelStride
      val rowStride = plane.rowStride
      // The frame is read at the geometry its image actually has (UC-AND-012).
      val w = image.width
      val h = image.height
      val rowPadding = rowStride - pixelStride * w
      val bitmap = Bitmap.createBitmap(w + rowPadding / pixelStride, h, Bitmap.Config.ARGB_8888)
      bitmap.copyPixelsFromBuffer(buffer)
      val cropped = Bitmap.createBitmap(bitmap, 0, 0, w, h)
      bitmap.recycle()

      val file = File(cacheDir, "proovra-screen-${startedAtMs}-$index.png")
      FileOutputStream(file).use { out -> cropped.compress(Bitmap.CompressFormat.PNG, 100, out) }
      cropped.recycle()

      frames.add(
        FrameOut(
          uri = "file://${file.absolutePath}",
          frameIndex = index,
          widthPx = w,
          heightPx = h,
          capturedAtOffsetMs = System.currentTimeMillis() - startedAtMs,
        ),
      )
      onFrame?.invoke(index, frames.size)
    } catch (t: Throwable) {
      // UC-AND-011 — a frame we could not read or write (image read, PNG write,
      // storage full) is FRAME_CAPTURE_FAILED. It is NOT secure content: Android
      // returns FLAG_SECURE windows as black pixels without any error, so this
      // path never observes them and must not claim to.
      limitations.add("FRAME_CAPTURE_FAILED")
      onFrame?.invoke(-1, frames.size)
    } finally {
      image.close()
    }
  }

  private fun finish(reason: String) {
    if (!active && last != null) return
    active = false
    unregisterDisplayListener()
    try { virtualDisplay?.release() } catch (_: Throwable) {}
    try { imageReader?.close() } catch (_: Throwable) {}
    try { projection?.stop() } catch (_: Throwable) {}
    bgThread?.quitSafely()
    virtualDisplay = null
    imageReader = null
    projection = null

    if (frames.isEmpty() && reason != "USER_STOPPED") limitations.add("CAPTURE_INTERRUPTED")
    val orientation = if (widthPx >= heightPx) "landscape" else "portrait"
    val outcome = ScreenCaptureOutcome(
      osConsentGranted = true,
      startedAtUtc = startedAtUtc,
      endedAtUtc = iso(System.currentTimeMillis()),
      osVersion = Build.VERSION.RELEASE ?: "unknown",
      model = ((Build.MANUFACTURER ?: "") + " " + (Build.MODEL ?: "")).trim().ifEmpty { "Android device" },
      appVersion = appVersionName(),
      screenW = widthPx,
      screenH = heightPx,
      densityDpi = densityDpi,
      orientation = orientation,
      frames = frames.toList(),
      stopReason = reason,
      limitations = limitations.toList(),
    )
    last = outcome
    onStopped?.invoke(outcome)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  private fun appVersionName(): String = try {
    packageManager.getPackageInfo(packageName, 0).versionName ?: "unknown"
  } catch (_: Throwable) {
    "unknown"
  }

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
