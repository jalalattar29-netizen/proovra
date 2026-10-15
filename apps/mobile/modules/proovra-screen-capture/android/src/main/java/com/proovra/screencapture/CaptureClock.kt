package com.proovra.screencapture

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/*
 * AUD-018 — the capture services' time, with NO Android dependency, so the JVM
 * unit tests (src/test) can move either clock independently.
 *
 * Durations, segment offsets, the session bound and segment ordering are
 * MONOTONIC (SystemClock.elapsedRealtime on the device, SystemCaptureClock.kt):
 * a user or network time change mid-recording used to stretch, shrink or
 * negate them, and could end a session early or never. The wall clock is read
 * once, at start, and only to NAME the session's instants in UTC.
 */

/** The two clocks a capture service reads. */
internal interface CaptureClock {
  /** Monotonic milliseconds (elapsedRealtime): never jumps, never goes back. */
  fun elapsedMs(): Long

  /** Wall-clock epoch milliseconds: descriptive timestamps ONLY. */
  fun wallMs(): Long
}

/**
 * One capture session's timeline. Every offset and duration is a difference of
 * monotonic readings; the UTC end instant is the start instant plus the
 * monotonic elapsed time, so the stated window always equals the stated
 * duration whatever the wall clock did in between.
 */
internal class SessionTimeline(private val clock: CaptureClock) {
  var startElapsedMs = 0L
    private set
  var startWallMs = 0L
    private set

  fun start() {
    startElapsedMs = clock.elapsedMs()
    startWallMs = clock.wallMs()
  }

  /** Monotonic now, for marking a segment start. */
  fun nowElapsedMs(): Long = clock.elapsedMs()

  /** Milliseconds since the session started (never negative). */
  fun offsetMs(): Long = (clock.elapsedMs() - startElapsedMs).coerceAtLeast(0L)

  /** A segment's offset from the session start, from its own monotonic start mark. */
  fun offsetOf(elapsedMark: Long): Long = (elapsedMark - startElapsedMs).coerceAtLeast(0L)

  /** Milliseconds since a monotonic mark (never negative). */
  fun since(elapsedMark: Long): Long = (clock.elapsedMs() - elapsedMark).coerceAtLeast(0L)

  /** The session bound is a monotonic duration, immune to wall-clock jumps. */
  fun boundReached(maxSessionMs: Long): Boolean = offsetMs() >= maxSessionMs

  /** Descriptive UTC instant `offset` ms after the start. */
  fun utcAtOffset(offset: Long): String = isoUtc(startWallMs + offset.coerceAtLeast(0L))

  fun startUtc(): String = isoUtc(startWallMs)
}

/** ISO-8601 UTC with milliseconds, the format both services have always emitted. */
internal fun isoUtc(epochMs: Long): String {
  val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
  fmt.timeZone = TimeZone.getTimeZone("UTC")
  return fmt.format(Date(epochMs))
}
