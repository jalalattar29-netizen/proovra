package com.proovra.screencapture

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * AUD-004 — the durable continuous-capture ledger (ContinuousLedger.kt): what
 * survives a process death, how it is recovered, and what may be deleted.
 */
class ContinuousLedgerTest {
  private lateinit var dir: File

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("ledger-test").toFile()
    ContinuousLedgerKeeper.attach(dir)
    ContinuousLedgerKeeper.clear()
  }

  @After
  fun tearDown() {
    ContinuousLedgerKeeper.clear()
    dir.deleteRecursively()
  }

  private val device = LedgerDevice("android", "14", "Pixel 8", "1.0.0", 1080, 2400, 420, "portrait")
  private val startWall = 1_790_000_000_000L

  private fun fresh() = ContinuousLedger(
    recordingId = "rec-1",
    startedAtUtc = isoUtc(startWall),
    startedAtWallMs = startWall,
    device = device,
  )

  private fun seg(seq: Int, state: String = SEGMENT_RECORDED, sha: String? = null) = LedgerSegment(
    sequence = seq, path = File(dir, "proovra-continuous-$startWall-$seq.mp4").absolutePath,
    sizeBytes = 4096L, sha256Hex = sha, startedAtOffsetMs = seq * 6000L, durationMs = 6000L,
    widthPx = 1072, heightPx = 2384, orientation = "portrait", uploadState = state,
  )

  /** The service's own sequence: start, then N segment closes, each durable. */
  private fun recordSegments(n: Int) {
    ContinuousLedgerKeeper.replace(fresh())
    for (i in 0 until n) ContinuousLedgerKeeper.update { ledgerWithSegment(it, seg(i)) }
  }

  @Test
  fun processDeathAfterNSegmentsIsRecoveredAsInterruptedWithEverySegment() {
    recordSegments(3)
    ContinuousLedgerKeeper.forgetInMemory() // the process died: only the file is left
    val read = ContinuousLedgerKeeper.get()!!
    assertEquals(LEDGER_RECORDING, read.state)
    val recovered = recoverLedger(read, recorderActive = false)
    assertEquals(LEDGER_INTERRUPTED, recovered.state)
    assertEquals(INTERRUPTION_PROCESS_DEATH, recovered.interruption)
    val outcome = ledgerOutcome(recovered)
    assertEquals("INTERRUPTED_SESSION", outcome["sessionCompleteness"])
    assertEquals("UNKNOWN", outcome["terminationReason"])
    assertTrue((outcome["limitations"] as List<*>).contains("CAPTURE_INTERRUPTED"))
    assertEquals(3, outcome["segmentCount"])
    assertEquals(18_000L, outcome["totalDurationMs"])
    assertEquals(isoUtc(startWall + 18_000L), outcome["captureEndedAtUtc"])
    // The device block the manifest needs comes from the ledger, not from memory.
    assertEquals(1080, (outcome["device"] as Map<*, *>)["screenW"])
  }

  @Test
  fun recoveryIsIdempotent() {
    recordSegments(2)
    val once = recoverLedger(ContinuousLedgerKeeper.get()!!, false)
    ContinuousLedgerKeeper.replace(once)
    ContinuousLedgerKeeper.forgetInMemory()
    val twice = recoverLedger(ContinuousLedgerKeeper.get()!!, false)
    assertEquals(once, twice)
  }

  @Test
  fun aJsReloadWhileRecordingChangesNothingAndNeverClaimsComplete() {
    recordSegments(2)
    val l = ContinuousLedgerKeeper.get()!!
    assertSame("an active recorder is not a process death", l, recoverLedger(l, recorderActive = true))
    assertEquals("INTERRUPTED_SESSION", ledgerOutcome(l)["sessionCompleteness"])
  }

  @Test
  fun aCleanFinishSurvivesARestartAsTheRecorderStatedIt() {
    recordSegments(2)
    ContinuousLedgerKeeper.update {
      ledgerFinished(it, "USER_STOPPED", null, emptyList(), "COMPLETE_SESSION", 12_100L, isoUtc(startWall + 12_100L))
    }
    ContinuousLedgerKeeper.forgetInMemory()
    val l = recoverLedger(ContinuousLedgerKeeper.get()!!, false)
    assertEquals(LEDGER_FINISHED, l.state)
    val outcome = ledgerOutcome(l)
    assertEquals("COMPLETE_SESSION", outcome["sessionCompleteness"])
    assertEquals("USER_STOPPED", outcome["terminationReason"])
    assertEquals(12_100L, outcome["totalDurationMs"])
  }

  @Test
  fun aRecordingIsNeverMergedIntoAnotherSession() {
    recordSegments(1)
    val bound = bindLedger(ContinuousLedgerKeeper.get()!!, "cs-1", "ev-1", "user-1")
    assertTrue(bound is BindOutcome.Bound)
    val l = (bound as BindOutcome.Bound).ledger
    assertTrue("re-binding the same session is idempotent", bindLedger(l, "cs-1", "ev-1", "user-1") is BindOutcome.Bound)
    assertEquals(BindOutcome.Mismatch, bindLedger(l, "cs-2", "ev-2", "user-1"))
    assertEquals(BindOutcome.Mismatch, bindLedger(l, "cs-1", "ev-OTHER", "user-1"))
    assertNull("another session cannot confirm this recording's segments", ledgerMarkUploaded(l, "cs-2", 0, "a".repeat(64), 1L))
    assertFalse(ledgerBoundTo(l, "cs-2"))
    assertTrue(ledgerBoundTo(l, "cs-1"))
  }

  @Test
  fun aConfirmedUploadIsIdempotentAndADifferentDigestIsRefused() {
    recordSegments(2)
    val l = (bindLedger(ContinuousLedgerKeeper.get()!!, "cs-1", "ev-1", null) as BindOutcome.Bound).ledger
    val sha = "b".repeat(64)
    val once = ledgerMarkUploaded(l, "cs-1", 1, sha, 5000L)!!
    assertEquals(SEGMENT_UPLOADED, once.segments[1].uploadState)
    assertEquals(sha, once.segments[1].sha256Hex)
    assertEquals(once, ledgerMarkUploaded(once, "cs-1", 1, sha, 5000L))
    assertNull(ledgerMarkUploaded(once, "cs-1", 1, "c".repeat(64), 5000L))
    assertNull("an unknown segment cannot be confirmed", ledgerMarkUploaded(once, "cs-1", 9, sha, 1L))
  }

  @Test
  fun aReaperBeforeRecoveryMayDeleteOnlyConfirmedSegments() {
    recordSegments(3)
    val bound = (bindLedger(ContinuousLedgerKeeper.get()!!, "cs-1", "ev-1", null) as BindOutcome.Bound).ledger
    val partial = ledgerMarkUploaded(bound, "cs-1", 0, "d".repeat(64), 4096L)!!
    // JS memory is gone; an automatic cleanup consults the ledger.
    assertEquals(listOf(seg(0).path), automaticallyDeletablePaths(partial))
    assertEquals(emptyList<String>(), automaticallyDeletablePaths(null))
    val js = ledgerSegmentsToJs(partial)
    assertEquals(listOf(SEGMENT_UPLOADED, SEGMENT_RECORDED, SEGMENT_RECORDED), js.map { it["uploadState"] })
    assertEquals("d".repeat(64), js[0]["sha256Hex"])
    assertEquals("file://${seg(1).path}", js[1]["uri"])
  }

  @Test
  fun aNewRecordingNeverOverwritesALedgerThatHoldsSegments() {
    assertFalse(blocksNewRecording(null, recorderActive = false))
    assertFalse(blocksNewRecording(fresh(), recorderActive = false))
    assertTrue(blocksNewRecording(fresh().copy(segments = listOf(seg(0))), recorderActive = false))
    assertTrue(blocksNewRecording(null, recorderActive = true))
  }

  @Test
  fun theLedgerRoundTripsThroughItsAtomicStore() {
    recordSegments(2)
    val bound = (bindLedger(ContinuousLedgerKeeper.get()!!, "cs-\"quoted\"\\1", "ev-1", "u\u00e9") as BindOutcome.Bound).ledger
    val full = ledgerMarkUploaded(bound, "cs-\"quoted\"\\1", 0, "e".repeat(64), 77L)!!
      .copy(limitations = listOf("ORIENTATION_CHANGED_DURING_CAPTURE"), terminationDetail = "RECORDER_ERROR_100")
    val store = LedgerStore(dir)
    assertTrue(store.write(full))
    assertEquals(full, store.read())
    assertFalse("no temp file is left behind", File(dir, "ledger.json.tmp").exists())
  }

  @Test
  fun aTornWriteNeverReplacesTheLastGoodLedger() {
    val store = LedgerStore(dir)
    val good = fresh().copy(segments = listOf(seg(0)))
    assertTrue(store.write(good))
    // A death mid-write leaves only a partial temp file.
    File(dir, "ledger.json.tmp").writeText("{\"schema\":1,\"recordingId\":\"rec")
    assertEquals(good, store.read())
  }

  @Test
  fun aMalformedOrForeignLedgerIsNullNeverAGuess() {
    assertNull(ledgerFromJson("not json"))
    assertNull(ledgerFromJson("{\"schema\":2}"))
    assertNull(ledgerFromJson(ledgerToJson(fresh()).replace("\"RECORDING\"", "\"WHATEVER\"")))
    assertNotNull(ledgerFromJson(ledgerToJson(fresh())))
  }

  // ------------------------------------------- one recording (SINGLE_FILE) --

  private val recordingPath get() = File(dir, "proovra-continuous-$startWall.mp4").absolutePath

  /** The service's single-file start: the ledger names the file before it is finalised. */
  private fun startSingleFile(audio: List<String> = emptyList()) = ContinuousLedgerKeeper.replace(
    fresh().copy(
      layout = LAYOUT_SINGLE_FILE,
      recordingPath = recordingPath,
      canvasW = 1072,
      canvasH = 2384,
      orientationTimeline = withOrientation(emptyList(), 0L, 1080, 2400),
      audioTracks = audio,
      limitations = if (audio.isEmpty()) listOf("AUDIO_NOT_CAPTURED") else emptyList(),
    ),
  )

  @Test
  fun aCleanSingleFileStopReportsTheOneFinalisedRecording() {
    startSingleFile(audio = listOf(AUDIO_TRACK_MICROPHONE))
    ContinuousLedgerKeeper.update {
      ledgerWithSegment(
        it,
        seg(0).copy(path = recordingPath, durationMs = 61_000L, sizeBytes = 9_000_000L),
      ).copy(recordingFinalized = true)
    }
    ContinuousLedgerKeeper.update {
      ledgerFinished(it, "USER_STOPPED", null, emptyList(), "COMPLETE_SESSION", 61_200L, isoUtc(startWall + 61_200L))
    }
    ContinuousLedgerKeeper.forgetInMemory()
    val outcome = ledgerOutcome(recoverLedger(ContinuousLedgerKeeper.get()!!, false))
    assertEquals(LAYOUT_SINGLE_FILE, outcome["layout"])
    assertEquals(true, outcome["finalized"])
    assertEquals("file://$recordingPath", outcome["recordingUri"])
    assertEquals(9_000_000L, outcome["recordingSizeBytes"])
    assertEquals(61_000L, outcome["recordingDurationMs"])
    assertEquals(1072, outcome["widthPx"])
    assertEquals(listOf(AUDIO_TRACK_MICROPHONE), outcome["audioTracks"])
    assertEquals(emptyList<Any>(), outcome["pauses"])
    assertEquals(1, outcome["segmentCount"])
    assertEquals("COMPLETE_SESSION", outcome["sessionCompleteness"])
    assertFalse("Android never claims a dropped-frame count it cannot observe", outcome.containsKey("droppedFrameCount"))
    // The one file stays until it is confirmed, committed or discarded.
    assertTrue(blocksNewRecording(ContinuousLedgerKeeper.get(), recorderActive = false))
  }

  @Test
  fun aProcessDeathMidRecordingIsInterruptedUnfinalisedAndNeverOffersTheFile() {
    startSingleFile()
    ContinuousLedgerKeeper.forgetInMemory() // died while MediaRecorder was writing (no moov box)
    val recovered = recoverLedger(ContinuousLedgerKeeper.get()!!, recorderActive = false)
    assertEquals(LEDGER_INTERRUPTED, recovered.state)
    val outcome = ledgerOutcome(recovered)
    assertEquals(false, outcome["finalized"])
    assertNull("an unfinalised MediaRecorder MP4 is not playable: no uri", outcome["recordingUri"])
    assertNull(outcome["recordingSizeBytes"])
    assertNull(outcome["recordingDurationMs"])
    assertEquals("INTERRUPTED_SESSION", outcome["sessionCompleteness"])
    assertEquals("UNKNOWN", outcome["terminationReason"])
    assertTrue((outcome["limitations"] as List<*>).containsAll(listOf("CAPTURE_INTERRUPTED", "AUDIO_NOT_CAPTURED")))
    assertEquals(0, outcome["segmentCount"])
    assertTrue("the user decides about an interrupted recording", blocksNewRecording(recovered, recorderActive = false))
    assertTrue(interruptedRecordingPending(recovered))
    // A finished ledger whose file could not be finalised holds nothing to keep.
    val finishedEmpty = recovered.copy(state = LEDGER_FINISHED)
    assertFalse(blocksNewRecording(finishedEmpty, recorderActive = false))
  }

  @Test
  fun theOrientationTimelineIsAscendingDeduplicatedAndBounded() {
    var tl = withOrientation(emptyList(), 0L, 1080, 2400)
    assertEquals(listOf(LedgerOrientation(0L, "portrait", 1080, 2400)), tl)
    assertSame("the same geometry is not a change", tl, withOrientation(tl, 500L, 1080, 2400))
    tl = withOrientation(tl, 4_000L, 2400, 1080)
    assertEquals("landscape", tl.last().orientation)
    // A second change in the same millisecond replaces the entry: offsets stay strictly ascending.
    tl = withOrientation(tl, 4_000L, 1080, 2400)
    assertEquals(2, tl.size)
    assertEquals(LedgerOrientation(4_000L, "portrait", 1080, 2400), tl.last())
    var capped = withOrientation(emptyList(), 0L, 1080, 2400, max = 3)
    for (i in 1..10) capped = withOrientation(capped, i * 1_000L, if (i % 2 == 1) 2400 else 1080, if (i % 2 == 1) 1080 else 2400, max = 3)
    assertEquals(3, capped.size)
    assertEquals(listOf(0L, 1_000L, 2_000L), capped.map { it.atOffsetMs })
  }

  @Test
  fun theSingleFileLedgerRoundTripsAndALegacyLedgerReadsAsBefore() {
    startSingleFile(audio = listOf(AUDIO_TRACK_MICROPHONE))
    val full = ContinuousLedgerKeeper.get()!!.copy(
      orientationTimeline = withOrientation(withOrientation(emptyList(), 0L, 1080, 2400), 7_000L, 2400, 1080),
      recordingFinalized = true,
    )
    val store = LedgerStore(dir)
    assertTrue(store.write(full))
    assertEquals(full, store.read())
    // A ledger written before the single-file fields existed parses unchanged.
    val legacyJson = ledgerToJson(fresh().copy(segments = listOf(seg(0))))
      .replace(Regex(",\"layout\":null,.*\"audioTracks\":\\[\\]\\}$"), "}")
    assertFalse(legacyJson.contains("recordingPath"))
    val legacy = ledgerFromJson(legacyJson)!!
    assertNull(legacy.layout)
    assertFalse(ledgerOutcome(legacy).containsKey("layout"))
    assertEquals(1, ledgerOutcome(legacy)["segmentCount"])
  }

  @Test
  fun miniJsonReadsWhatItWrites() {
    val v = mapOf("a" to listOf(1L, -2L, 3.5, true, null), "s" to "tab\there \"q\" \\ \u0001 \u00fc")
    assertEquals(v, MiniJson.parse(MiniJson.write(v)))
    assertEquals(mapOf("x" to "A"), MiniJson.parse(" { \"x\" : \"\\u0041\" } "))
  }
}
