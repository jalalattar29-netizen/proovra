package com.proovra.screencapture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AUD-018 — durations, offsets and the session bound follow the MONOTONIC
 * clock; a wall-clock jump (user change, NTP correction, time zone sync)
 * moves neither them nor the stated window.
 */
class CaptureClockTest {
  private class FakeClock(var elapsed: Long, var wall: Long) : CaptureClock {
    override fun elapsedMs(): Long = elapsed
    override fun wallMs(): Long = wall
    fun advance(ms: Long) { elapsed += ms; wall += ms }
  }

  private val start = 1_790_000_000_000L // 2026-09-21T...

  @Test
  fun aBackwardWallClockJumpDoesNotShrinkOrNegateASegment() {
    val clock = FakeClock(elapsed = 50_000L, wall = start)
    val t = SessionTimeline(clock)
    t.start()
    clock.advance(6_000)
    val segStart = t.nowElapsedMs()
    clock.wall -= 3_600_000 // the user set the clock back one hour mid-segment
    clock.elapsed += 6_000
    assertEquals(6_000L, t.offsetOf(segStart))
    assertEquals(6_000L, t.since(segStart))
    assertEquals(12_000L, t.offsetMs())
  }

  @Test
  fun aForwardWallClockJumpDoesNotEndTheSessionEarly() {
    val clock = FakeClock(elapsed = 0L, wall = start)
    val t = SessionTimeline(clock)
    t.start()
    clock.advance(60_000)
    clock.wall += 2L * 60L * 60L * 1000L // +2h wall jump
    assertFalse("a wall jump must not reach the 50-minute bound", t.boundReached(50L * 60L * 1000L))
    clock.elapsed += 50L * 60L * 1000L
    assertTrue("the monotonic duration reaches the bound", t.boundReached(50L * 60L * 1000L))
  }

  @Test
  fun theStatedEndInstantIsStartPlusMonotonicElapsedNeverBeforeStart() {
    val clock = FakeClock(elapsed = 10L, wall = start)
    val t = SessionTimeline(clock)
    t.start()
    clock.elapsed += 30_000
    clock.wall -= 86_400_000 // wall went back a day
    val endUtc = t.utcAtOffset(t.offsetMs())
    assertEquals(isoUtc(start + 30_000), endUtc)
    assertTrue("end must not precede start", endUtc >= t.startUtc())
  }

  @Test
  fun offsetsAreNeverNegativeEvenForAMarkBeforeTheStart() {
    val clock = FakeClock(elapsed = 1_000L, wall = start)
    val t = SessionTimeline(clock)
    t.start()
    assertEquals(0L, t.offsetOf(500L))
    assertEquals(0L, t.since(5_000L))
  }

  @Test
  fun isoUtcIsMillisecondUtc() {
    assertEquals("1970-01-01T00:00:01.234Z", isoUtc(1_234L))
  }
}
