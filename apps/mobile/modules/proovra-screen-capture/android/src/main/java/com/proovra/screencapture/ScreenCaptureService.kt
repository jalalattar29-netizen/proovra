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
    private var widthPx = 0
    private var heightPx = 0
    private var densityDpi = 0
    @Volatile private var active = false
    private var last: ScreenCaptureOutcome? = null

    private var resultCode = 0
    private var resultData: Intent? = null
    private var onStartedCb: ((String) -> Unit)? = null
    @Volatile private var stopReason: String = "USER_STOPPED"

    var onFrame: ((Int, Int) -> Unit)? = null
    var onStopped: ((ScreenCaptureOutcome) -> Unit)? = null

    fun isActive(): Boolean = active
    fun frameCount(): Int = frames.size
    fun lastOutcome(): ScreenCaptureOutcome? = last

    fun start(context: Context, code: Int, data: Intent, max: Int, onStarted: (String) -> Unit) {
      resultCode = code
      resultData = data
      maxFrames = max
      onStartedCb = onStarted
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
        beginProjection()
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

  private fun beginProjection() {
    val data = resultData
    if (data == null) {
      finish("ERROR")
      return
    }
    val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    // getMediaProjection MUST be called after startForeground on Android 14.
    val mp = mpm.getMediaProjection(resultCode, data)
    if (mp == null) {
      finish("ERROR")
      return
    }
    projection = mp

    val metrics = DisplayMetrics()
    @Suppress("DEPRECATION")
    (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
    widthPx = metrics.widthPixels
    heightPx = metrics.heightPixels
    densityDpi = metrics.densityDpi
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
    active = true
    onStartedCb?.invoke(startedAtUtc)
    onStartedCb = null
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
      val rowPadding = rowStride - pixelStride * widthPx
      val bitmap = Bitmap.createBitmap(widthPx + rowPadding / pixelStride, heightPx, Bitmap.Config.ARGB_8888)
      bitmap.copyPixelsFromBuffer(buffer)
      val cropped = Bitmap.createBitmap(bitmap, 0, 0, widthPx, heightPx)
      bitmap.recycle()

      val file = File(cacheDir, "proovra-screen-${startedAtMs}-$index.png")
      FileOutputStream(file).use { out -> cropped.compress(Bitmap.CompressFormat.PNG, 100, out) }
      cropped.recycle()

      frames.add(
        FrameOut(
          uri = "file://${file.absolutePath}",
          frameIndex = index,
          widthPx = widthPx,
          heightPx = heightPx,
          capturedAtOffsetMs = System.currentTimeMillis() - startedAtMs,
        ),
      )
      onFrame?.invoke(index, frames.size)
    } catch (t: Throwable) {
      // A frame we could not read (e.g. a FLAG_SECURE window) is a truthful
      // limitation, never a silent gap.
      limitations.add("SECURE_CONTENT_OMITTED")
      onFrame?.invoke(-1, frames.size)
    } finally {
      image.close()
    }
  }

  private fun finish(reason: String) {
    if (!active && last != null) return
    active = false
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
