package com.proovra.screencapture

/*
 * AUD-029 — the continuous recorder's encoder configuration, decided with NO
 * Android dependency so the JVM unit tests exercise the exact arithmetic the
 * service runs. The service reads the device's H.264 encoder capabilities
 * (MediaCodecList(REGULAR_CODECS) -> VideoCapabilities) into [EncoderCaps];
 * this decides what to ask MediaRecorder for.
 *
 * It used to ask for the raw display size at a fixed 6 Mbit/s and 12 fps. A
 * 1440x3200 panel exceeds many devices' AVC encoders, so prepare()/start()
 * failed (or the encoder errored a few frames in) and nothing said why.
 */

/** What the device's video encoder supports (from MediaCodecInfo.VideoCapabilities). */
internal data class EncoderCaps(
  val widthAlignment: Int,
  val heightAlignment: Int,
  val maxWidth: Int,
  val maxHeight: Int,
  val minWidth: Int,
  val minHeight: Int,
  val minBitrate: Int,
  val maxBitrate: Int,
  val maxFrameRate: Int,
  /** VideoCapabilities.isSizeSupported — the encoder's own verdict on a size. */
  val isSizeSupported: (Int, Int) -> Boolean,
)

/** The configuration MediaRecorder is given. */
internal data class EncoderConfig(val width: Int, val height: Int, val bitrate: Int, val frameRate: Int)

internal const val ENCODER_UNSUPPORTED_SIZE = "ENCODER_UNSUPPORTED_SIZE"

/** Largest multiple of [align] that is <= [value] (align < 1 is treated as 1). */
internal fun alignDown(value: Int, align: Int): Int {
  val a = if (align < 1) 1 else align
  return (value / a) * a
}

/**
 * The encoder configuration for a [reqW]x[reqH] display, or null when no size
 * the encoder accepts can represent it (the caller fails with
 * ENCODER_UNSUPPORTED_SIZE). The size is scaled down PRESERVING THE ASPECT
 * RATIO until it fits the encoder's maxima and its own isSizeSupported, each
 * side aligned down to the encoder's alignment (H.264 wants even, often 16);
 * bitrate and frame rate are clamped into the encoder's ranges. Without
 * capabilities (no AVC encoder listed) the request is kept, aligned to 2.
 */
internal fun clampEncoderConfig(
  reqW: Int,
  reqH: Int,
  reqBitrate: Int,
  reqFrameRate: Int,
  caps: EncoderCaps?,
): EncoderConfig? {
  if (reqW <= 0 || reqH <= 0) return null
  if (caps == null) {
    val w = alignDown(reqW, 2)
    val h = alignDown(reqH, 2)
    if (w <= 0 || h <= 0) return null
    return EncoderConfig(w, h, reqBitrate.coerceAtLeast(1), reqFrameRate.coerceAtLeast(1))
  }
  // The largest scale (<= 1) that fits both maxima, then step down 5% at a time
  // until the encoder accepts the aligned size. Bounded: at most ~90 steps.
  var scale = minOf(1.0, caps.maxWidth.toDouble() / reqW, caps.maxHeight.toDouble() / reqH)
  var chosen: Pair<Int, Int>? = null
  var steps = 0
  while (scale > 0.0 && steps < 90) {
    val w = alignDown((reqW * scale).toInt(), caps.widthAlignment)
    val h = alignDown((reqH * scale).toInt(), caps.heightAlignment)
    if (w < caps.minWidth || h < caps.minHeight || w <= 0 || h <= 0) break
    if (w <= caps.maxWidth && h <= caps.maxHeight && caps.isSizeSupported(w, h)) {
      chosen = Pair(w, h)
      break
    }
    scale *= 0.95
    steps += 1
  }
  val size = chosen ?: return null
  val lowBitrate = if (caps.minBitrate < 1) 1 else caps.minBitrate
  val highBitrate = if (caps.maxBitrate < lowBitrate) lowBitrate else caps.maxBitrate
  val highFps = if (caps.maxFrameRate < 1) 1 else caps.maxFrameRate
  return EncoderConfig(
    width = size.first,
    height = size.second,
    bitrate = reqBitrate.coerceIn(lowBitrate, highBitrate),
    frameRate = reqFrameRate.coerceIn(1, highFps),
  )
}
