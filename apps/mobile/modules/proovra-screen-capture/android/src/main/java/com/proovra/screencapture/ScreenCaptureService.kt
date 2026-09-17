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
 * UC-2 — the foreground service that runs one bounded MediaProjection capture.
 *
 * It becomes a foreground service (type mediaProjection) with a visible,
 * user-dismissable notification BEFORE creating the projection (Android 14
 * requires that ordering), captures up to `maxFrames` PNG frames at `intervalMs`
 * into the app cache, and stops promptly on the notification's Stop action, on
 * [requestStop], when the bound is reached, or when the OS revokes the
 * projection. It reports the frames + context back through a one-shot callback.
 */
class ScreenCaptureService : Service() {
  private var projection: MediaProjection? = null
  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var bgThread: HandlerThread? = null
  private var bgHandler: Handler? = null

  private val frames = mutableListOf<FrameOut>()
  private val limitations = linkedSetOf<String>()
  private var startedAtMs = 0L
  private var startedAtUtc = ""
  private var maxFrames = 8
  private var intervalMs = 750
  private var widthPx = 0
  private var heightPx = 0
  private var densityDpi = 0
  private var finished = false

  companion object {
    private const val CHANNEL_ID = "proovra_screen_capture"
    private const val NOTIF_ID = 0x50D2
    const val ACTION_STOP = "com.proovra.screencapture.STOP"

    private var completion: ((ScreenCaptureOutcome) -> Unit)? = null
    private var resultCode = 0
    private var resultData: Intent? = null
    private var pendingMaxFrames = 8
    private var pendingIntervalMs = 750
    @Volatile private var stopReason: String = "USER_STOPPED"

    fun start(
      context: Context,
      code: Int,
      data: Intent,
      maxFrames: Int,
      intervalMs: Int,
      onDone: (ScreenCaptureOutcome) -> Unit,
    ) {
      completion = onDone
      resultCode = code
      resultData = data
      pendingMaxFrames = maxFrames
      pendingIntervalMs = intervalMs
      stopReason = "USER_STOPPED"
      val intent = Intent(context, ScreenCaptureService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun requestStop(context: Context?, reason: String) {
      stopReason = reason
      context ?: return
      val intent = Intent(context, ScreenCaptureService::class.java).setAction(ACTION_STOP)
      context.startService(intent)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      finish(stopReason)
      return START_NOT_STICKY
    }
    startForegroundWithNotification()
    beginCapture()
    return START_NOT_STICKY
  }

  private fun startForegroundWithNotification() {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Screen capture", NotificationManager.IMPORTANCE_LOW),
      )
    }
    val stopIntent = PendingIntent.getService(
      this,
      0,
      Intent(this, ScreenCaptureService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val builder = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("PROOVRA is capturing your screen")
      .setContentText("Tap Stop to end the capture.")
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Stop", stopIntent).build())
    val notification = builder.build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(NOTIF_ID, notification)
    }
  }

  private fun beginCapture() {
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

    // The OS revoking the projection (e.g. user ends casting) fails closed.
    mp.registerCallback(object : MediaProjection.Callback() {
      override fun onStop() {
        finish("PERMISSION_REVOKED")
      }
    }, null)

    val thread = HandlerThread("proovra-screencap").also { it.start() }
    bgThread = thread
    val handler = Handler(thread.looper)
    bgHandler = handler

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
      handler,
    )

    // Bounded frame loop: grab the latest image every intervalMs up to maxFrames.
    maxFrames = pendingMaxFrames
    intervalMs = pendingIntervalMs
    scheduleFrame(handler, 0)
  }

  private fun scheduleFrame(handler: Handler, index: Int) {
    if (finished) return
    if (index >= maxFrames) {
      limitations.add("CAPTURE_BOUNDS_EXCEEDED")
      finish("BOUNDS_REACHED")
      return
    }
    handler.postDelayed({
      if (finished) return@postDelayed
      captureOneFrame(index)
      scheduleFrame(handler, index + 1)
    }, intervalMs.toLong())
  }

  private fun captureOneFrame(index: Int) {
    val reader = imageReader ?: return
    val image = reader.acquireLatestImage() ?: return
    try {
      val plane = image.planes[0]
      val buffer = plane.buffer
      val pixelStride = plane.pixelStride
      val rowStride = plane.rowStride
      val rowPadding = rowStride - pixelStride * widthPx
      val bitmap = Bitmap.createBitmap(
        widthPx + rowPadding / pixelStride,
        heightPx,
        Bitmap.Config.ARGB_8888,
      )
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
    } catch (t: Throwable) {
      // A frame we could not read (e.g. a FLAG_SECURE window) is recorded as a
      // truthful limitation rather than a silent gap.
      limitations.add("SECURE_CONTENT_OMITTED")
    } finally {
      image.close()
    }
  }

  private fun finish(reason: String) {
    if (finished) return
    finished = true
    try { virtualDisplay?.release() } catch (_: Throwable) {}
    try { imageReader?.close() } catch (_: Throwable) {}
    try { projection?.stop() } catch (_: Throwable) {}
    bgThread?.quitSafely()

    if (frames.isEmpty()) limitations.add("CAPTURE_INTERRUPTED")
    val orientation = if (widthPx >= heightPx) "landscape" else "portrait"
    val completeness = reason
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
      stopReason = completeness,
      limitations = limitations.toList(),
    )
    val cb = completion
    completion = null
    resultData = null
    cb?.invoke(outcome)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION") stopForeground(true)
    }
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
    if (!finished) finish("INTERRUPTED")
    super.onDestroy()
  }
}
