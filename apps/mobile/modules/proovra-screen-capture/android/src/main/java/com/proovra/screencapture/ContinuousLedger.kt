package com.proovra.screencapture

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/*
 * AUD-004 — the DURABLE ledger of a continuous recording, with NO Android
 * dependency so the JVM unit tests exercise exactly what the service runs.
 *
 * The service kept its segments, limitations, start instant and outcome in
 * companion statics only. A process death lost all of it while the segment
 * files stayed on disk: the JS recovery path got an empty outcome, could not
 * build a manifest, and could only discard — recorded-but-unuploaded segments
 * were invisible and the lost tail uncountable.
 *
 * Now the service writes this ledger (temp file + fsync + atomic rename, in
 * filesDir) at start, at every segment close and at finish; JS writes the
 * session binding and each confirmed upload through the module. After a JS
 * reload or a process restart the module exposes it, and a ledger with no
 * clean finish becomes INTERRUPTED (CAPTURE_INTERRUPTED, interruption
 * PROCESS_DEATH) — never COMPLETE. Files are deleted only when the ledger says
 * their bytes are confirmed at PROOVRA, when the bound session is committed,
 * or on an explicit discard.
 *
 * One recording (2026-10-29, layout SINGLE_FILE): a Start→Stop session is ONE
 * MediaRecorder file. The ledger names that file from the moment recording
 * starts (`recordingPath`); a clean stop that finalised it records it as
 * segment 0 (so confirm-then-delete, commit and discard are unchanged) and
 * `recordingFinalized = true`. A process death mid-recording leaves a file
 * MediaRecorder never finalised (no moov box: unplayable) — recovered as
 * INTERRUPTED with `finalized = false` and no recordingUri, and kept, like any
 * leftover, until the user explicitly discards it. A ledger without `layout`
 * is a legacy segmented recording and reads exactly as before.
 */

internal const val LEDGER_SCHEMA = 1
internal const val LEDGER_RECORDING = "RECORDING"
internal const val LEDGER_FINISHED = "FINISHED"
internal const val LEDGER_INTERRUPTED = "INTERRUPTED"
internal const val SEGMENT_RECORDED = "RECORDED"
internal const val SEGMENT_UPLOADED = "UPLOADED"
internal const val INTERRUPTION_PROCESS_DEATH = "PROCESS_DEATH"
internal const val LAYOUT_SINGLE_FILE = "SINGLE_FILE"
internal const val AUDIO_TRACK_MICROPHONE = "MICROPHONE"

/** One orientation change of the recorded display (wire contract A's orientationTimeline). */
internal data class LedgerOrientation(
  val atOffsetMs: Long,
  val orientation: String,
  val widthPx: Int,
  val heightPx: Int,
)

/** The recording device, as the manifest's device block states it. */
internal data class LedgerDevice(
  val platform: String,
  val osVersion: String,
  val model: String,
  val appVersion: String,
  val screenW: Int,
  val screenH: Int,
  val densityDpi: Int,
  val orientation: String,
)

/** One finalised ORIGINAL segment. Offsets/durations are monotonic (AUD-018). */
internal data class LedgerSegment(
  val sequence: Int,
  val path: String,
  val sizeBytes: Long,
  /** Set when the upload was confirmed (the digest PROOVRA accepted). */
  val sha256Hex: String?,
  val startedAtOffsetMs: Long,
  val durationMs: Long,
  val widthPx: Int,
  val heightPx: Int,
  val orientation: String,
  /** RECORDED (only on this device) or UPLOADED (declared + stored at PROOVRA). */
  val uploadState: String,
)

internal data class ContinuousLedger(
  val schema: Int = LEDGER_SCHEMA,
  /** A per-recording id (start wall instant + nonce): the ledger's own identity. */
  val recordingId: String,
  /** The PROOVRA session/evidence the recording is bound to (null until JS binds it). */
  val captureSessionId: String? = null,
  val evidenceId: String? = null,
  val ownerUserId: String? = null,
  val startedAtUtc: String,
  val startedAtWallMs: Long,
  val device: LedgerDevice,
  val segments: List<LedgerSegment> = emptyList(),
  val limitations: List<String> = emptyList(),
  val state: String = LEDGER_RECORDING,
  val sessionCompleteness: String? = null,
  val terminationReason: String? = null,
  val terminationDetail: String? = null,
  val interruption: String? = null,
  val endedAtUtc: String? = null,
  /** The last known monotonic offset reached (segment end, or the finish). */
  val totalDurationMs: Long = 0L,
  // ---- one recording (layout SINGLE_FILE); absent in a legacy segmented ledger ----
  val layout: String? = null,
  /** THE recording file, named at start (it exists before it is finalised). */
  val recordingPath: String? = null,
  /** True only when MediaRecorder.stop() finalised the file. */
  val recordingFinalized: Boolean = false,
  /** The encoder canvas (fixed for the whole recording). */
  val canvasW: Int = 0,
  val canvasH: Int = 0,
  val orientationTimeline: List<LedgerOrientation> = emptyList(),
  /** Tracks actually configured on the recorder ([] or ["MICROPHONE"]). */
  val audioTracks: List<String> = emptyList(),
)

// ---------------------------------------------------------------- decisions --

/** A new segment closed: the ledger records it before JS is told. */
internal fun ledgerWithSegment(l: ContinuousLedger, seg: LedgerSegment): ContinuousLedger {
  if (l.segments.any { it.sequence == seg.sequence }) return l
  return l.copy(
    segments = (l.segments + seg).sortedBy { it.sequence },
    totalDurationMs = maxOf(l.totalDurationMs, seg.startedAtOffsetMs + seg.durationMs),
  )
}

/** A clean or unclean finish, recorded by the recorder itself. */
internal fun ledgerFinished(
  l: ContinuousLedger,
  reason: String,
  detail: String?,
  limitations: List<String>,
  completeness: String,
  totalDurationMs: Long,
  endedAtUtc: String,
): ContinuousLedger = l.copy(
  state = LEDGER_FINISHED,
  terminationReason = reason,
  terminationDetail = detail,
  limitations = limitations.distinct(),
  sessionCompleteness = completeness,
  totalDurationMs = maxOf(l.totalDurationMs, totalDurationMs),
  endedAtUtc = endedAtUtc,
)

/**
 * The recovery decision. A ledger still RECORDING while no recorder is active
 * means the process died mid-recording: it becomes INTERRUPTED, states
 * CAPTURE_INTERRUPTED and PROCESS_DEATH, and ends at the last instant the
 * ledger proves (start + last segment end). Idempotent: an already-recovered
 * or finished ledger is returned unchanged.
 */
internal fun recoverLedger(l: ContinuousLedger, recorderActive: Boolean): ContinuousLedger {
  if (l.state != LEDGER_RECORDING || recorderActive) return l
  val limits = (l.limitations + "CAPTURE_INTERRUPTED").distinct()
  return l.copy(
    state = LEDGER_INTERRUPTED,
    interruption = INTERRUPTION_PROCESS_DEATH,
    terminationReason = "UNKNOWN",
    limitations = limits,
    sessionCompleteness = "INTERRUPTED_SESSION",
    endedAtUtc = isoUtc(l.startedAtWallMs + l.totalDurationMs),
  )
}

/**
 * Wire contract B — the ONE recording's fields of a stop result. The uri, size
 * and duration are stated only for a file MediaRecorder FINALISED: an
 * unfinalised MP4 has no moov box and is not playable, so it is never offered
 * (finalized = false says why). Android has no pauses; MediaRecorder exposes no
 * count of frames its encoder skipped, so `droppedFrameCount` is absent (never
 * a claimed 0).
 */
internal fun recordingFieldsToJs(
  recordingPath: String?,
  finalized: Boolean,
  sizeBytes: Long?,
  durationMs: Long?,
  canvasW: Int,
  canvasH: Int,
  orientationTimeline: List<LedgerOrientation>,
  audioTracks: List<String>,
): Map<String, Any?> = mapOf(
  "layout" to LAYOUT_SINGLE_FILE,
  "recordingUri" to if (finalized && recordingPath != null) "file://$recordingPath" else null,
  "recordingSizeBytes" to if (finalized) sizeBytes else null,
  "recordingDurationMs" to if (finalized) durationMs else null,
  "widthPx" to if (canvasW > 0) canvasW else null,
  "heightPx" to if (canvasH > 0) canvasH else null,
  "orientationTimeline" to orientationTimeline.map { orientationToJs(it) },
  "pauses" to emptyList<Map<String, Any?>>(),
  "audioTracks" to audioTracks,
  "finalized" to finalized,
)

internal fun orientationToJs(o: LedgerOrientation): Map<String, Any?> = mapOf(
  "atOffsetMs" to o.atOffsetMs,
  "orientation" to o.orientation,
  "widthPx" to o.widthPx,
  "heightPx" to o.heightPx,
)

/**
 * The orientation timeline after the display reports a [widthPx]x[heightPx]
 * geometry at [atOffsetMs]: unchanged when the geometry did not change;
 * offsets stay strictly ascending (a second change in the same millisecond
 * replaces the previous entry); at most [max] entries (later changes stay
 * named by ORIENTATION_CHANGED_DURING_CAPTURE).
 */
internal fun withOrientation(
  timeline: List<LedgerOrientation>,
  atOffsetMs: Long,
  widthPx: Int,
  heightPx: Int,
  max: Int = 256,
): List<LedgerOrientation> {
  val orientation = if (widthPx >= heightPx) "landscape" else "portrait"
  val last = timeline.lastOrNull()
  if (last != null && last.orientation == orientation && last.widthPx == widthPx && last.heightPx == heightPx) return timeline
  val entry = LedgerOrientation(atOffsetMs, orientation, widthPx, heightPx)
  if (last != null && last.atOffsetMs >= atOffsetMs) return timeline.dropLast(1) + entry.copy(atOffsetMs = last.atOffsetMs)
  if (timeline.size >= max) return timeline
  return timeline + entry
}

/** The session result the manifest is built from, read from the ledger alone. */
internal fun ledgerOutcome(l: ContinuousLedger): Map<String, Any?> {
  val finished = l.state == LEDGER_FINISHED
  // Never COMPLETE unless the recorder itself recorded a clean, complete finish.
  val completeness = if (finished && l.sessionCompleteness == "COMPLETE_SESSION") "COMPLETE_SESSION" else "INTERRUPTED_SESSION"
  val limitations = if (finished || l.state == LEDGER_INTERRUPTED) l.limitations else (l.limitations + "CAPTURE_INTERRUPTED").distinct()
  val base = mapOf(
    "osConsentGranted" to true,
    "captureStartedAtUtc" to l.startedAtUtc,
    "captureEndedAtUtc" to (l.endedAtUtc ?: isoUtc(l.startedAtWallMs + l.totalDurationMs)),
    "device" to mapOf(
      "platform" to l.device.platform,
      "osVersion" to l.device.osVersion,
      "model" to l.device.model,
      "appVersion" to l.device.appVersion,
      "screenW" to l.device.screenW,
      "screenH" to l.device.screenH,
      "densityDpi" to l.device.densityDpi,
      "orientation" to l.device.orientation,
    ),
    "totalDurationMs" to l.totalDurationMs,
    "segmentCount" to l.segments.size,
    "sessionCompleteness" to completeness,
    "terminationReason" to (l.terminationReason ?: "UNKNOWN"),
    "terminationDetail" to l.terminationDetail,
    "limitations" to limitations,
    "interruption" to l.interruption,
  )
  if (l.layout != LAYOUT_SINGLE_FILE) return base
  val recording = l.segments.firstOrNull { it.sequence == 0 }
  return base + recordingFieldsToJs(
    recordingPath = recording?.path ?: l.recordingPath,
    finalized = l.recordingFinalized && recording != null,
    sizeBytes = recording?.sizeBytes,
    durationMs = recording?.durationMs,
    canvasW = l.canvasW,
    canvasH = l.canvasH,
    orientationTimeline = l.orientationTimeline,
    audioTracks = l.audioTracks,
  )
}

internal sealed class BindOutcome {
  data class Bound(val ledger: ContinuousLedger) : BindOutcome()
  /** The ledger already belongs to another session: never merged. */
  object Mismatch : BindOutcome()
}

/**
 * Bind the recording to the PROOVRA session opened for it. Re-binding the SAME
 * session is idempotent; a different session is refused — a recording is
 * never merged into another session's evidence.
 */
internal fun bindLedger(l: ContinuousLedger, captureSessionId: String, evidenceId: String, ownerUserId: String?): BindOutcome {
  if (captureSessionId.isEmpty() || evidenceId.isEmpty()) return BindOutcome.Mismatch
  val bound = l.captureSessionId
  if (bound != null) {
    return if (bound == captureSessionId && l.evidenceId == evidenceId) BindOutcome.Bound(l) else BindOutcome.Mismatch
  }
  return BindOutcome.Bound(l.copy(captureSessionId = captureSessionId, evidenceId = evidenceId, ownerUserId = ownerUserId))
}

/** True when the ledger is bound to exactly this session. */
internal fun ledgerBoundTo(l: ContinuousLedger?, captureSessionId: String?): Boolean =
  l != null && captureSessionId != null && captureSessionId.isNotEmpty() && l.captureSessionId == captureSessionId

/**
 * PROOVRA confirmed a segment (declared digest + stored bytes). Null when the
 * ledger is bound to another session or does not know the segment; the same
 * confirmation twice is a no-op; a DIFFERENT digest for a confirmed segment is
 * refused (null).
 */
internal fun ledgerMarkUploaded(
  l: ContinuousLedger,
  captureSessionId: String,
  sequence: Int,
  sha256Hex: String,
  sizeBytes: Long,
): ContinuousLedger? {
  if (!ledgerBoundTo(l, captureSessionId)) return null
  val seg = l.segments.firstOrNull { it.sequence == sequence } ?: return null
  if (seg.uploadState == SEGMENT_UPLOADED) return if (seg.sha256Hex == sha256Hex) l else null
  val updated = seg.copy(uploadState = SEGMENT_UPLOADED, sha256Hex = sha256Hex, sizeBytes = if (sizeBytes > 0) sizeBytes else seg.sizeBytes)
  return l.copy(segments = l.segments.map { if (it.sequence == sequence) updated else it })
}

/**
 * The ONLY files an automatic cleanup may delete: segments whose bytes PROOVRA
 * confirmed. A RECORDED segment is the only copy and stays until it uploads,
 * the bound session is committed, or the user explicitly discards.
 */
internal fun automaticallyDeletablePaths(l: ContinuousLedger?): List<String> =
  l?.segments?.filter { it.uploadState == SEGMENT_UPLOADED }?.map { it.path } ?: emptyList()

/**
 * A new recording may not overwrite a ledger that still holds segments (it
 * would orphan them), nor one whose single-file recording a process death
 * interrupted (the user is told and decides; never silently replaced). An
 * empty, finished ledger (nothing was kept) may go.
 */
internal fun blocksNewRecording(l: ContinuousLedger?, recorderActive: Boolean): Boolean =
  recorderActive || (l != null && (l.segments.isNotEmpty() || interruptedRecordingPending(l)))

/** A single-file recording that never reached its recorder's own finish. */
internal fun interruptedRecordingPending(l: ContinuousLedger): Boolean =
  l.layout == LAYOUT_SINGLE_FILE && l.recordingPath != null && l.state != LEDGER_FINISHED

/** Segments in the shape the JS binding reads (ScreenSegment + durable state). */
internal fun ledgerSegmentsToJs(l: ContinuousLedger): List<Map<String, Any?>> = l.segments.map { s ->
  mapOf(
    "uri" to "file://${s.path}",
    "sequence" to s.sequence,
    "startedAtOffsetMs" to s.startedAtOffsetMs,
    "durationMs" to s.durationMs,
    "widthPx" to s.widthPx,
    "heightPx" to s.heightPx,
    "orientation" to s.orientation,
    "sizeBytes" to s.sizeBytes,
    "sha256Hex" to s.sha256Hex,
    "uploadState" to s.uploadState,
  )
}

/** The whole ledger for JS (getContinuousLedger). */
internal fun ledgerToJs(l: ContinuousLedger, recorderActive: Boolean): Map<String, Any?> = mapOf(
  "recordingId" to l.recordingId,
  "captureSessionId" to l.captureSessionId,
  "evidenceId" to l.evidenceId,
  "ownerUserId" to l.ownerUserId,
  "state" to l.state,
  "layout" to l.layout,
  "active" to recorderActive,
  "interruption" to l.interruption,
  "outcome" to ledgerOutcome(l),
  "segments" to ledgerSegmentsToJs(l),
)

// ------------------------------------------------------------ serialisation --

internal fun ledgerToJson(l: ContinuousLedger): String = MiniJson.write(
  mapOf(
    "schema" to l.schema,
    "recordingId" to l.recordingId,
    "captureSessionId" to l.captureSessionId,
    "evidenceId" to l.evidenceId,
    "ownerUserId" to l.ownerUserId,
    "startedAtUtc" to l.startedAtUtc,
    "startedAtWallMs" to l.startedAtWallMs,
    "device" to mapOf(
      "platform" to l.device.platform,
      "osVersion" to l.device.osVersion,
      "model" to l.device.model,
      "appVersion" to l.device.appVersion,
      "screenW" to l.device.screenW,
      "screenH" to l.device.screenH,
      "densityDpi" to l.device.densityDpi,
      "orientation" to l.device.orientation,
    ),
    "segments" to l.segments.map { s ->
      mapOf(
        "sequence" to s.sequence,
        "path" to s.path,
        "sizeBytes" to s.sizeBytes,
        "sha256Hex" to s.sha256Hex,
        "startedAtOffsetMs" to s.startedAtOffsetMs,
        "durationMs" to s.durationMs,
        "widthPx" to s.widthPx,
        "heightPx" to s.heightPx,
        "orientation" to s.orientation,
        "uploadState" to s.uploadState,
      )
    },
    "limitations" to l.limitations,
    "state" to l.state,
    "sessionCompleteness" to l.sessionCompleteness,
    "terminationReason" to l.terminationReason,
    "terminationDetail" to l.terminationDetail,
    "interruption" to l.interruption,
    "endedAtUtc" to l.endedAtUtc,
    "totalDurationMs" to l.totalDurationMs,
    "layout" to l.layout,
    "recordingPath" to l.recordingPath,
    "recordingFinalized" to l.recordingFinalized,
    "canvasW" to l.canvasW,
    "canvasH" to l.canvasH,
    "orientationTimeline" to l.orientationTimeline.map { orientationToJs(it) },
    "audioTracks" to l.audioTracks,
  ),
)

private fun Map<*, *>.str(k: String): String? = this[k] as? String
private fun Map<*, *>.long(k: String): Long? = (this[k] as? Number)?.toLong()
private fun Map<*, *>.int(k: String): Int? = (this[k] as? Number)?.toInt()

/** Defensive parse: anything malformed or of another schema is null, never a guess. */
internal fun ledgerFromJson(text: String): ContinuousLedger? {
  val parsed = try { MiniJson.parse(text) } catch (_: Throwable) { return null }
  val root = parsed as? Map<*, *> ?: return null
  if (root.int("schema") != LEDGER_SCHEMA) return null
  val d = root["device"] as? Map<*, *> ?: return null
  val device = LedgerDevice(
    platform = d.str("platform") ?: return null,
    osVersion = d.str("osVersion") ?: return null,
    model = d.str("model") ?: return null,
    appVersion = d.str("appVersion") ?: return null,
    screenW = d.int("screenW") ?: return null,
    screenH = d.int("screenH") ?: return null,
    densityDpi = d.int("densityDpi") ?: return null,
    orientation = d.str("orientation") ?: return null,
  )
  val segs = mutableListOf<LedgerSegment>()
  for (raw in root["segments"] as? List<*> ?: return null) {
    val s = raw as? Map<*, *> ?: return null
    segs.add(
      LedgerSegment(
        sequence = s.int("sequence") ?: return null,
        path = s.str("path") ?: return null,
        sizeBytes = s.long("sizeBytes") ?: return null,
        sha256Hex = s.str("sha256Hex"),
        startedAtOffsetMs = s.long("startedAtOffsetMs") ?: return null,
        durationMs = s.long("durationMs") ?: return null,
        widthPx = s.int("widthPx") ?: return null,
        heightPx = s.int("heightPx") ?: return null,
        orientation = s.str("orientation") ?: return null,
        uploadState = s.str("uploadState") ?: return null,
      ),
    )
  }
  val state = root.str("state") ?: return null
  if (state != LEDGER_RECORDING && state != LEDGER_FINISHED && state != LEDGER_INTERRUPTED) return null
  // The single-file fields are optional: a legacy segmented ledger has none.
  val timeline = mutableListOf<LedgerOrientation>()
  for (raw in root["orientationTimeline"] as? List<*> ?: emptyList<Any?>()) {
    val o = raw as? Map<*, *> ?: return null
    timeline.add(
      LedgerOrientation(
        atOffsetMs = o.long("atOffsetMs") ?: return null,
        orientation = o.str("orientation") ?: return null,
        widthPx = o.int("widthPx") ?: return null,
        heightPx = o.int("heightPx") ?: return null,
      ),
    )
  }
  return ContinuousLedger(
    schema = LEDGER_SCHEMA,
    recordingId = root.str("recordingId") ?: return null,
    captureSessionId = root.str("captureSessionId"),
    evidenceId = root.str("evidenceId"),
    ownerUserId = root.str("ownerUserId"),
    startedAtUtc = root.str("startedAtUtc") ?: return null,
    startedAtWallMs = root.long("startedAtWallMs") ?: return null,
    device = device,
    segments = segs.sortedBy { it.sequence },
    limitations = (root["limitations"] as? List<*>)?.filterIsInstance<String>() ?: emptyList(),
    state = state,
    sessionCompleteness = root.str("sessionCompleteness"),
    terminationReason = root.str("terminationReason"),
    terminationDetail = root.str("terminationDetail"),
    interruption = root.str("interruption"),
    endedAtUtc = root.str("endedAtUtc"),
    totalDurationMs = root.long("totalDurationMs") ?: 0L,
    layout = root.str("layout"),
    recordingPath = root.str("recordingPath"),
    recordingFinalized = root["recordingFinalized"] as? Boolean ?: false,
    canvasW = root.int("canvasW") ?: 0,
    canvasH = root.int("canvasH") ?: 0,
    orientationTimeline = timeline,
    audioTracks = (root["audioTracks"] as? List<*>)?.filterIsInstance<String>() ?: emptyList(),
  )
}

// -------------------------------------------------------------------- store --

/**
 * The ledger file in its own directory (filesDir/proovra-continuous on the
 * device, a temp dir in the tests). Writes are ATOMIC: a temp file is written,
 * flushed to the device (fsync), then renamed over the ledger, so a process
 * death mid-write leaves either the previous ledger or the new one — never a
 * torn file.
 */
internal class LedgerStore(val dir: File) {
  private val file = File(dir, "ledger.json")
  private val tmp = File(dir, "ledger.json.tmp")

  fun read(): ContinuousLedger? {
    if (!file.exists()) return null
    return try { ledgerFromJson(file.readText(Charsets.UTF_8)) } catch (_: Throwable) { null }
  }

  /** Atomic replace; returns false (and keeps the previous ledger) on failure. */
  fun write(l: ContinuousLedger): Boolean = try {
    if (!dir.exists()) dir.mkdirs()
    FileOutputStream(tmp).use { out ->
      out.write(ledgerToJson(l).toByteArray(Charsets.UTF_8))
      out.flush()
      out.fd.sync()
    }
    Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    true
  } catch (_: Throwable) {
    try { tmp.delete() } catch (_: Throwable) {}
    false
  }

  fun clear() {
    try { file.delete() } catch (_: Throwable) {}
    try { tmp.delete() } catch (_: Throwable) {}
  }
}

/**
 * The one in-process holder of the ledger: the service (main thread) and the
 * module (JS threads) both go through it, serialised, and every change is
 * persisted before it is visible.
 */
internal object ContinuousLedgerKeeper {
  private var store: LedgerStore? = null
  private var current: ContinuousLedger? = null
  private var loaded = false

  @Synchronized
  fun attach(dir: File) {
    if (store?.dir == dir) return
    store = LedgerStore(dir)
    loaded = false
    current = null
  }

  @Synchronized
  fun get(): ContinuousLedger? {
    if (!loaded) {
      current = store?.read()
      loaded = true
    }
    return current
  }

  /** Apply [change] (null result = no change) and persist it. Returns the ledger after. */
  @Synchronized
  fun update(change: (ContinuousLedger) -> ContinuousLedger?): ContinuousLedger? {
    val before = get() ?: return null
    val after = change(before) ?: return before
    if (after != before) {
      store?.write(after)
      current = after
    }
    return after
  }

  @Synchronized
  fun replace(l: ContinuousLedger) {
    store?.write(l)
    current = l
    loaded = true
  }

  @Synchronized
  fun clear() {
    store?.clear()
    current = null
    loaded = true
  }

  /** Tests only: forget the in-memory copy, as a process death does. */
  @Synchronized
  fun forgetInMemory() {
    current = null
    loaded = false
  }
}

// --------------------------------------------------------------------- JSON --

/** A minimal JSON reader/writer (objects, arrays, strings, numbers, booleans, null). */
internal object MiniJson {
  fun write(v: Any?): String = StringBuilder().also { append(it, v) }.toString()

  private fun append(sb: StringBuilder, v: Any?) {
    when (v) {
      null -> sb.append("null")
      is String -> quote(sb, v)
      is Boolean -> sb.append(if (v) "true" else "false")
      is Int, is Long, is Short, is Byte -> sb.append(v.toString())
      is Number -> {
        val d = v.toDouble()
        if (d.isNaN() || d.isInfinite()) sb.append("null") else sb.append(d.toString())
      }
      is Map<*, *> -> {
        sb.append('{')
        var first = true
        for ((k, value) in v) {
          if (!first) sb.append(',')
          first = false
          quote(sb, k.toString())
          sb.append(':')
          append(sb, value)
        }
        sb.append('}')
      }
      is Iterable<*> -> {
        sb.append('[')
        var first = true
        for (item in v) {
          if (!first) sb.append(',')
          first = false
          append(sb, item)
        }
        sb.append(']')
      }
      else -> quote(sb, v.toString())
    }
  }

  private fun quote(sb: StringBuilder, s: String) {
    sb.append('"')
    for (c in s) {
      when (c) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        else -> if (c < ' ') sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
      }
    }
    sb.append('"')
  }

  fun parse(text: String): Any? {
    val p = Parser(text)
    val v = p.value()
    p.skipWs()
    if (!p.atEnd()) throw IllegalArgumentException("trailing data")
    return v
  }

  private class Parser(val s: String) {
    var i = 0

    fun atEnd() = i >= s.length

    fun skipWs() {
      while (i < s.length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++
    }

    fun value(): Any? {
      skipWs()
      if (atEnd()) throw IllegalArgumentException("unexpected end")
      return when (s[i]) {
        '{' -> obj()
        '[' -> arr()
        '"' -> str()
        't' -> literal("true", true)
        'f' -> literal("false", false)
        'n' -> literal("null", null)
        else -> num()
      }
    }

    private fun literal(word: String, v: Any?): Any? {
      if (!s.startsWith(word, i)) throw IllegalArgumentException("bad literal")
      i += word.length
      return v
    }

    private fun obj(): Map<String, Any?> {
      val out = LinkedHashMap<String, Any?>()
      i++ // {
      skipWs()
      if (i < s.length && s[i] == '}') { i++; return out }
      while (true) {
        skipWs()
        if (atEnd() || s[i] != '"') throw IllegalArgumentException("expected key")
        val k = str()
        skipWs()
        if (atEnd() || s[i] != ':') throw IllegalArgumentException("expected :")
        i++
        out[k] = value()
        skipWs()
        if (atEnd()) throw IllegalArgumentException("unterminated object")
        if (s[i] == ',') { i++; continue }
        if (s[i] == '}') { i++; return out }
        throw IllegalArgumentException("expected , or }")
      }
    }

    private fun arr(): List<Any?> {
      val out = ArrayList<Any?>()
      i++ // [
      skipWs()
      if (i < s.length && s[i] == ']') { i++; return out }
      while (true) {
        out.add(value())
        skipWs()
        if (atEnd()) throw IllegalArgumentException("unterminated array")
        if (s[i] == ',') { i++; continue }
        if (s[i] == ']') { i++; return out }
        throw IllegalArgumentException("expected , or ]")
      }
    }

    private fun str(): String {
      i++ // opening quote
      val sb = StringBuilder()
      while (true) {
        if (atEnd()) throw IllegalArgumentException("unterminated string")
        val c = s[i++]
        when (c) {
          '"' -> return sb.toString()
          '\\' -> {
            if (atEnd()) throw IllegalArgumentException("bad escape")
            when (val e = s[i++]) {
              '"' -> sb.append('"')
              '\\' -> sb.append('\\')
              '/' -> sb.append('/')
              'b' -> sb.append('\b')
              'f' -> sb.append('\u000C')
              'n' -> sb.append('\n')
              'r' -> sb.append('\r')
              't' -> sb.append('\t')
              'u' -> {
                if (i + 4 > s.length) throw IllegalArgumentException("bad unicode escape")
                sb.append(s.substring(i, i + 4).toInt(16).toChar())
                i += 4
              }
              else -> throw IllegalArgumentException("bad escape $e")
            }
          }
          else -> sb.append(c)
        }
      }
    }

    private fun num(): Number {
      val start = i
      while (i < s.length && (s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i].isDigit())) i++
      val t = s.substring(start, i)
      if (t.isEmpty()) throw IllegalArgumentException("bad number")
      return if (t.contains('.') || t.contains('e') || t.contains('E')) t.toDouble() else t.toLong()
    }
  }
}
