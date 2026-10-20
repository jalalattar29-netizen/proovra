package com.proovra.screencapture

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * AUD-37 (2026-10-20) — the durable single-frame capture ledger
 * (FrameLedger.kt): frames the user captured survive a process death and come
 * back as an INTERRUPTED capture, never a clean stop and never lost.
 */
class FrameLedgerTest {
  private lateinit var dir: File

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("frame-ledger-test").toFile()
    FrameLedgerKeeper.attach(dir)
    FrameLedgerKeeper.clear()
  }

  @After
  fun tearDown() {
    FrameLedgerKeeper.clear()
    dir.deleteRecursively()
  }

  private val startWall = 1_790_000_000_000L

  private fun fresh() = FrameLedger(
    recordingId = "rec-1",
    startedAtUtc = isoUtc(startWall),
    startedAtWallMs = startWall,
    osVersion = "14",
    model = "Google Pixel 8",
    appVersion = "1.0.0",
    screenW = 1080,
    screenH = 2400,
    densityDpi = 420,
    orientation = "portrait",
  )

  private fun frame(i: Int) = FrameOut(
    uri = "file://${File(dir, "proovra-screen-$startWall-$i.png").absolutePath}",
    frameIndex = i,
    widthPx = 1080,
    heightPx = 2400,
    capturedAtOffsetMs = 1000L * (i + 1),
  )

  /** The service's own sequence: start, then N frames, each durable. */
  private fun captureFrames(n: Int, limitations: List<String> = emptyList()) {
    FrameLedgerKeeper.replace(fresh())
    for (i in 0 until n) FrameLedgerKeeper.update { frameLedgerWithFrame(it, frame(i), limitations) }
  }

  @Test
  fun processDeathAfterNFramesIsRecoveredAsInterruptedWithEveryFrame() {
    captureFrames(3)
    FrameLedgerKeeper.forgetInMemory() // the process died: only the file is left
    val recovered = recoverableFrameOutcome(FrameLedgerKeeper.get(), serviceActive = false)
    assertNotNull(recovered)
    recovered!!
    assertEquals(listOf(0, 1, 2), recovered.frames.map { it.frameIndex })
    assertEquals("INTERRUPTED", recovered.stopReason)
    assertTrue(recovered.limitations.contains("CAPTURE_INTERRUPTED"))
    // Ends at the last instant the ledger proves (the last frame), never "now".
    assertEquals(isoUtc(startWall + 3000L), recovered.endedAtUtc)
  }

  @Test
  fun aLiveServiceIsNeverTreatedAsRecovered() {
    captureFrames(2)
    assertNull(recoverableFrameOutcome(FrameLedgerKeeper.get(), serviceActive = true))
    assertEquals(FRAME_LEDGER_RECORDING, recoverFrameLedger(FrameLedgerKeeper.get()!!, serviceActive = true).state)
  }

  @Test
  fun aCleanFinishKeepsItsOwnStopReasonAndLimitations() {
    captureFrames(2, listOf("ORIENTATION_CHANGED_DURING_CAPTURE"))
    val o = frameLedgerOutcome(FrameLedgerKeeper.get()!!).copy(stopReason = "USER_STOPPED", endedAtUtc = isoUtc(startWall + 5000L))
    FrameLedgerKeeper.update { frameLedgerFinished(it, o, 5000L) }
    FrameLedgerKeeper.forgetInMemory()
    val l = FrameLedgerKeeper.get()!!
    assertEquals(FRAME_LEDGER_FINISHED, recoverFrameLedger(l, serviceActive = false).state)
    val out = frameLedgerOutcome(l)
    assertEquals("USER_STOPPED", out.stopReason)
    assertTrue(out.limitations.contains("ORIENTATION_CHANGED_DURING_CAPTURE"))
    assertTrue(!out.limitations.contains("CAPTURE_INTERRUPTED"))
  }

  @Test
  fun aLedgerWithNoFrameOffersNothingToRecover() {
    FrameLedgerKeeper.replace(fresh())
    FrameLedgerKeeper.forgetInMemory()
    assertNull(recoverableFrameOutcome(FrameLedgerKeeper.get(), serviceActive = false))
  }

  @Test
  fun aFrameIsRecordedOnceAndInOrder() {
    FrameLedgerKeeper.replace(fresh())
    FrameLedgerKeeper.update { frameLedgerWithFrame(it, frame(1), emptyList()) }
    FrameLedgerKeeper.update { frameLedgerWithFrame(it, frame(0), emptyList()) }
    FrameLedgerKeeper.update { frameLedgerWithFrame(it, frame(1), emptyList()) }
    assertEquals(listOf(0, 1), FrameLedgerKeeper.get()!!.frames.map { it.frameIndex })
  }

  @Test
  fun aMalformedOrForeignLedgerIsIgnoredNeverGuessed() {
    File(dir, "frame-ledger.json").writeText("{\"schema\":99,\"frames\":[]}")
    FrameLedgerKeeper.forgetInMemory()
    assertNull(FrameLedgerKeeper.get())
    assertNull(frameLedgerFromJson("not json"))
  }

  @Test
  fun theLedgerRoundTripsThroughJson() {
    captureFrames(2, listOf("FRAME_CAPTURE_FAILED"))
    val l = FrameLedgerKeeper.get()!!
    assertEquals(l, frameLedgerFromJson(frameLedgerToJson(l)))
  }

  @Test
  fun clearingTheLedgerLeavesNothingToRecover() {
    captureFrames(1)
    FrameLedgerKeeper.clear()
    FrameLedgerKeeper.forgetInMemory()
    assertNull(FrameLedgerKeeper.get())
  }
}
