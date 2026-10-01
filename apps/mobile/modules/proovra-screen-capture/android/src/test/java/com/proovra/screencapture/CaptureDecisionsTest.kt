package com.proovra.screencapture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests of the decisions both capture services run (CaptureDecisions.kt).
 * Run by native-build.yml (Gradle testDebugUnitTest on this module).
 */
class CaptureDecisionsTest {
  private class FakeProjection

  // ---- UC-AND-013 ---------------------------------------------------------

  @Test
  fun nullProjectionIsRefusedWithProjectionUnavailable() {
    var asked = 0
    val outcome = obtainProjection<String, FakeProjection>("consent") { asked += 1; null }
    assertEquals(ProjectionOutcome.Refused(PROJECTION_UNAVAILABLE, "Android did not provide the screen-capture session."), outcome)
    assertEquals("Android was asked exactly once", 1, asked)
  }

  @Test
  fun missingConsentIsRefusedWithoutAskingAndroid() {
    var asked = false
    val outcome = obtainProjection<String, FakeProjection>(null) { asked = true; FakeProjection() }
    assertTrue(outcome is ProjectionOutcome.Refused)
    assertEquals(NO_CONSENT_TOKEN, (outcome as ProjectionOutcome.Refused).code)
    assertFalse("no consent: getMediaProjection must not be called", asked)
  }

  @Test
  fun aThrowFromGetMediaProjectionIsARefusalNotACrash() {
    val outcome = obtainProjection<String, FakeProjection>("consent") {
      throw SecurityException("Media projections require a foreground service of type mediaProjection")
    }
    assertEquals(
      ProjectionOutcome.Refused(START_FAILED, "Media projections require a foreground service of type mediaProjection"),
      outcome,
    )
  }

  @Test
  fun aGrantedProjectionIsReady() {
    val granted = FakeProjection()
    val outcome = obtainProjection<String, FakeProjection>("consent") { granted }
    assertEquals(ProjectionOutcome.Ready(granted), outcome)
  }

  // ---- UC-AND-007 ---------------------------------------------------------

  @Test
  fun aStopThatThrowsDiscardsTheSegmentAndStillReleasesTheRecorder() {
    var released = false
    var deleted = false
    val outcome = closeSegment(
      stop = { throw RuntimeException("stop failed") }, // MediaRecorder.stop()'s failure mode
      release = { released = true },
      writtenBytes = { 4_096L }, // bytes ARE on disk — they are still unplayable
      deleteFile = { deleted = true },
    )
    assertEquals(SegmentClose.DISCARD_WRITE_FAILED, outcome)
    assertTrue("the recorder is released even when stop() throws", released)
    assertTrue("the unfinalised mp4 is deleted", deleted)
  }

  @Test
  fun aFailingReleaseOrDeleteDoesNotChangeTheVerdict() {
    val outcome = closeSegment(
      stop = { throw IllegalStateException("stop") },
      release = { throw IllegalStateException("release") },
      writtenBytes = { 1L },
      deleteFile = { throw SecurityException("delete") },
    )
    assertEquals(SegmentClose.DISCARD_WRITE_FAILED, outcome)
  }

  @Test
  fun aCleanStopWithBytesIsEmittedAndNothingIsDeleted() {
    var deleted = false
    val outcome = closeSegment(stop = {}, release = {}, writtenBytes = { 10L }, deleteFile = { deleted = true })
    assertEquals(SegmentClose.EMIT, outcome)
    assertFalse(deleted)
  }

  @Test
  fun aCleanStopWithNoBytesEmitsNothing() {
    val outcome = closeSegment(stop = {}, release = {}, writtenBytes = { 0L }, deleteFile = {})
    assertEquals(SegmentClose.NOTHING_WRITTEN, outcome)
  }
}
