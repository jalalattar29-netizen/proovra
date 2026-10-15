package com.proovra.screencapture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AUD-029 — the continuous recorder's encoder configuration (EncoderClamp.kt)
 * and its failure decisions (CaptureDecisions.kt), on the JVM.
 */
class RecorderFailureTest {
  /** A typical mid-range AVC encoder: 16-aligned, 1920x1920 max, 1080p-class sizes only. */
  private fun caps(
    maxW: Int = 1920,
    maxH: Int = 1920,
    align: Int = 16,
    maxPixels: Int = 1920 * 1088,
    minBitrate: Int = 64_000,
    maxBitrate: Int = 4_000_000,
    maxFps: Int = 30,
  ) = EncoderCaps(
    widthAlignment = align, heightAlignment = align,
    maxWidth = maxW, maxHeight = maxH, minWidth = 32, minHeight = 32,
    minBitrate = minBitrate, maxBitrate = maxBitrate, maxFrameRate = maxFps,
    isSizeSupported = { w, h -> w % align == 0 && h % align == 0 && w <= maxW && h <= maxH && w * h <= maxPixels },
  )

  @Test
  fun aQhdPanelIsScaledIntoTheEncoderPreservingAspectAndAlignment() {
    val c = clampEncoderConfig(1440, 3200, 6_000_000, 12, caps())
    assertNotNull(c)
    c!!
    assertEquals(0, c.width % 16)
    assertEquals(0, c.height % 16)
    assertTrue(c.width <= 1920 && c.height <= 1920)
    assertTrue("within the encoder's pixel budget", c.width * c.height <= 1920 * 1088)
    // Aspect within one alignment step of the panel's 0.45.
    val aspect = c.width.toDouble() / c.height
    assertTrue("aspect kept: $aspect", kotlin.math.abs(aspect - 1440.0 / 3200.0) < 0.02)
    assertTrue("portrait stays portrait", c.height > c.width)
  }

  @Test
  fun bitrateAndFrameRateAreClampedIntoTheEncoderRanges() {
    val c = clampEncoderConfig(720, 1280, 6_000_000, 12, caps(maxBitrate = 4_000_000, maxFps = 10))!!
    assertEquals(4_000_000, c.bitrate)
    assertEquals(10, c.frameRate)
    val low = clampEncoderConfig(720, 1280, 10, 12, caps())!!
    assertEquals(64_000, low.bitrate)
  }

  @Test
  fun aSizeTheEncoderAlreadySupportsIsKeptExactly() {
    val c = clampEncoderConfig(720, 1280, 2_000_000, 12, caps())!!
    assertEquals(720, c.width)
    assertEquals(1280, c.height)
    assertEquals(2_000_000, c.bitrate)
    assertEquals(12, c.frameRate)
  }

  @Test
  fun anEncoderThatAcceptsNoSizeIsUnsupportedNotAGuess() {
    val none = caps().copy(isSizeSupported = { _, _ -> false })
    assertNull(clampEncoderConfig(1080, 2400, 6_000_000, 12, none))
    assertNull(clampEncoderConfig(0, 2400, 6_000_000, 12, caps()))
  }

  @Test
  fun withoutCapabilitiesTheRequestIsKeptButEvenAligned() {
    val c = clampEncoderConfig(1081, 2401, 6_000_000, 12, null)!!
    assertEquals(1080, c.width)
    assertEquals(2400, c.height)
  }

  @Test
  fun alignDownNeverRoundsUp() {
    assertEquals(1072, alignDown(1080, 16))
    assertEquals(7, alignDown(7, 0))
  }

  @Test
  fun aRecorderErrorOrAFailedRolloverIsNeverComplete() {
    assertEquals("INTERRUPTED_SESSION", sessionCompleteness("ERROR", emptyList()))
    // A user stop after a segment that never started (SEGMENT_WRITE_FAILED).
    assertEquals("INTERRUPTED_SESSION", sessionCompleteness("USER_STOPPED", listOf("SEGMENT_WRITE_FAILED")))
    assertEquals("INTERRUPTED_SESSION", sessionCompleteness("BOUNDS_REACHED", listOf("CAPTURE_INTERRUPTED")))
    assertEquals("COMPLETE_SESSION", sessionCompleteness("USER_STOPPED", listOf("ORIENTATION_CHANGED_DURING_CAPTURE")))
    assertEquals("COMPLETE_SESSION", sessionCompleteness("BOUNDS_REACHED", listOf("SESSION_BOUNDS_REACHED")))
  }

  @Test
  fun failureCodesAreStable() {
    assertEquals("RECORDER_ERROR_100", recorderErrorCode(100))
    assertEquals("RECORDER_ERROR_1", recorderErrorCode(1))
    assertEquals("Screen capture could not start (IllegalStateException).", startFailureMessage(IllegalStateException("Gerät beschäftigt")))
    assertEquals("ENCODER_UNSUPPORTED_SIZE", ENCODER_UNSUPPORTED_SIZE)
    assertEquals("SEGMENT_START_FAILED", SEGMENT_START_FAILED)
  }

  @Test
  fun aPromiseIsSettledAtMostOnceAndAThrowingSettleIsContained() {
    val calls = mutableListOf<String>()
    val once = SettleOnce("promise")
    assertTrue(once.settle { calls.add("reject MODULE_RELOADED") })
    assertFalse("a late service answer cannot settle it again", once.settle { calls.add("resolve") })
    assertEquals(listOf("reject MODULE_RELOADED"), calls)
    assertTrue(once.isSettled)
    val throwing = SettleOnce("p2")
    assertTrue(throwing.settle { throw IllegalStateException("already settled") })
  }
}
