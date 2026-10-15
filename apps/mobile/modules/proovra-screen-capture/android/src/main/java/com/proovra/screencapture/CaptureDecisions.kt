package com.proovra.screencapture

/*
 * The capture services' two failure decisions, with NO Android dependency, so
 * the JVM unit tests (src/test) exercise exactly the code the services run.
 * The services keep the side effects (release, stopSelf, notifications); these
 * functions decide.
 */

/** The outcome of asking Android for the screen-capture session (UC-AND-013). */
internal sealed class ProjectionOutcome<out P> {
  data class Ready<P>(val projection: P) : ProjectionOutcome<P>()
  data class Refused(val code: String, val message: String) : ProjectionOutcome<Nothing>()
}

internal const val NO_CONSENT_TOKEN = "NO_CONSENT_TOKEN"
internal const val PROJECTION_UNAVAILABLE = "PROJECTION_UNAVAILABLE"
internal const val START_FAILED = "START_FAILED"

/**
 * UC-AND-013 — every way the session can fail to materialise is a REFUSAL with
 * a code the start promise is rejected with: no consent token, a NULL
 * projection (Android declined), or a throw from getMediaProjection (e.g. the
 * Android 14 SecurityException). Never a silent return that leaves the JS start
 * pending. Never throws.
 */
internal fun <C : Any, P : Any> obtainProjection(consent: C?, getProjection: (C) -> P?): ProjectionOutcome<P> {
  val token = consent ?: return ProjectionOutcome.Refused(NO_CONSENT_TOKEN, "The screen-capture consent was not available.")
  val projection = try {
    getProjection(token)
  } catch (t: Throwable) {
    return ProjectionOutcome.Refused(START_FAILED, startFailureMessage(t))
  }
  return if (projection == null) {
    ProjectionOutcome.Refused(PROJECTION_UNAVAILABLE, "Android did not provide the screen-capture session.")
  } else {
    ProjectionOutcome.Ready(projection)
  }
}

/** What happens to a recorded segment when its recorder is stopped (UC-AND-007). */
internal enum class SegmentClose {
  /** stop() succeeded and bytes were written: emit it as an ORIGINAL segment. */
  EMIT,

  /** stop() threw: the mp4 has no finalised moov box. Deleted, recorded, never emitted. */
  DISCARD_WRITE_FAILED,

  /** stop() succeeded but nothing was written: nothing to emit. */
  NOTHING_WRITTEN,
}

/**
 * UC-AND-007 — a MediaRecorder.stop() that throws is NOT ignorable: the file is
 * unplayable, so it is deleted and the caller records SEGMENT_WRITE_FAILED
 * (which makes the session INTERRUPTED). The recorder is always released.
 */
internal fun closeSegment(
  stop: () -> Unit,
  release: () -> Unit,
  writtenBytes: () -> Long,
  deleteFile: () -> Unit,
): SegmentClose {
  var stopFailed = false
  try { stop() } catch (_: Throwable) { stopFailed = true }
  try { release() } catch (_: Throwable) {}
  if (stopFailed) {
    try { deleteFile() } catch (_: Throwable) {}
    return SegmentClose.DISCARD_WRITE_FAILED
  }
  return if (writtenBytes() > 0) SegmentClose.EMIT else SegmentClose.NOTHING_WRITTEN
}

/*
 * AUD-029 — STABLE codes for how a recording failed. The service used to
 * surface `t.message` (device- and locale-specific prose) and collapse every
 * runtime failure into finish("ERROR") with no what/extra.
 */

/** A MediaRecorder onError(what, extra): the stable termination detail. */
internal fun recorderErrorCode(what: Int): String = "RECORDER_ERROR_$what"

/** The next segment's recorder could not be prepared or started. */
internal const val SEGMENT_START_FAILED = "SEGMENT_START_FAILED"

/** A stable, non-localised start-failure message: the exception's kind, never its prose. */
internal fun startFailureMessage(t: Throwable): String =
  "Screen capture could not start (${t.javaClass.simpleName.ifEmpty { "Throwable" }})."

/** The terminations after which a session may be complete (the recorder's own rule). */
internal val CLEAN_TERMINATIONS = setOf("USER_STOPPED", "BOUNDS_REACHED")

/** Limitations that make a session INTERRUPTED whatever ended it. */
internal val INCOMPLETE_LIMITATIONS = setOf(
  "CAPTURE_INTERRUPTED", "SEGMENT_UPLOAD_LOST", "SEGMENT_WRITE_FAILED", "BROADCAST_PAUSED",
)

/**
 * AUD-029 — the session's completeness. COMPLETE only after a clean end with
 * no limitation saying a stretch is missing: a recorder error, a segment that
 * could not be written, or a rollover whose next segment never started is
 * never complete.
 */
internal fun sessionCompleteness(reason: String, limitations: Collection<String>): String {
  val complete = reason in CLEAN_TERMINATIONS && limitations.none { it in INCOMPLETE_LIMITATIONS }
  return if (complete) "COMPLETE_SESSION" else "INTERRUPTED_SESSION"
}

/**
 * AUD-029 — a promise is settled AT MOST ONCE. A reload rejects what the dead
 * JS context was awaiting; the service may still answer later, and Expo
 * throws on a second settle in a production build (inside the recorder's own
 * start path, that throw would have torn the recording down).
 */
internal class SettleOnce<P : Any>(private val target: P) {
  private val settled = java.util.concurrent.atomic.AtomicBoolean(false)

  /** Runs [action] on the target the first time only; a throw from it is contained. */
  fun settle(action: (P) -> Unit): Boolean {
    if (!settled.compareAndSet(false, true)) return false
    try { action(target) } catch (_: Throwable) {}
    return true
  }

  val isSettled: Boolean get() = settled.get()
}
