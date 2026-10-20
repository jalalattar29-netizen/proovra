package com.proovra.screencapture

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/*
 * AUD-37 (2026-10-20) — the DURABLE ledger of a single-frame (UC-2) screen
 * capture, with NO Android dependency so the JVM unit tests exercise exactly
 * what the service runs.
 *
 * The service kept its frames, limitations and start instant in companion
 * statics only. A process death (the user left PROOVRA to show other content,
 * and Android reclaimed it) lost all of it while the PNG files stayed in the
 * cache: the frames the user had deliberately captured were unrecoverable.
 *
 * Now the service writes this ledger (temp file + fsync + atomic rename) at
 * start, after every frame and at finish. A ledger still RECORDING with no
 * active service is a process death: it becomes INTERRUPTED (stop reason
 * INTERRUPTED, CAPTURE_INTERRUPTED) with every frame it holds — never a clean
 * USER_STOPPED. JS offers it for review like any stopped capture; the ledger is
 * cleared only when JS commits (staged) or discards it.
 */

internal const val FRAME_LEDGER_SCHEMA = 1
internal const val FRAME_LEDGER_RECORDING = "RECORDING"
internal const val FRAME_LEDGER_FINISHED = "FINISHED"
internal const val FRAME_LEDGER_INTERRUPTED = "INTERRUPTED"

internal data class FrameLedger(
  val schema: Int = FRAME_LEDGER_SCHEMA,
  val recordingId: String,
  val startedAtUtc: String,
  val startedAtWallMs: Long,
  val osVersion: String,
  val model: String,
  val appVersion: String,
  val screenW: Int,
  val screenH: Int,
  val densityDpi: Int,
  val orientation: String,
  val frames: List<FrameOut> = emptyList(),
  val limitations: List<String> = emptyList(),
  val state: String = FRAME_LEDGER_RECORDING,
  val stopReason: String? = null,
  val endedAtUtc: String? = null,
  /** The last monotonic offset the ledger proves (a frame, or the finish). */
  val lastOffsetMs: Long = 0L,
)

/** A frame was written: recorded before JS is told. Idempotent per frame index. */
internal fun frameLedgerWithFrame(l: FrameLedger, f: FrameOut, limitations: List<String>): FrameLedger {
  if (l.frames.any { it.frameIndex == f.frameIndex }) return l
  return l.copy(
    frames = (l.frames + f).sortedBy { it.frameIndex },
    limitations = (l.limitations + limitations).distinct(),
    lastOffsetMs = maxOf(l.lastOffsetMs, f.capturedAtOffsetMs),
  )
}

/** The service finished (any reason) and recorded its own outcome. */
internal fun frameLedgerFinished(l: FrameLedger, o: ScreenCaptureOutcome, endOffsetMs: Long): FrameLedger = l.copy(
  state = FRAME_LEDGER_FINISHED,
  frames = o.frames,
  limitations = o.limitations.distinct(),
  stopReason = o.stopReason,
  endedAtUtc = o.endedAtUtc,
  lastOffsetMs = maxOf(l.lastOffsetMs, endOffsetMs),
)

/**
 * The recovery decision: a ledger still RECORDING while no service is active
 * means the process died mid-capture. Idempotent; a finished ledger is
 * returned unchanged.
 */
internal fun recoverFrameLedger(l: FrameLedger, serviceActive: Boolean): FrameLedger {
  if (l.state != FRAME_LEDGER_RECORDING || serviceActive) return l
  return l.copy(
    state = FRAME_LEDGER_INTERRUPTED,
    stopReason = "INTERRUPTED",
    limitations = (l.limitations + "CAPTURE_INTERRUPTED").distinct(),
    endedAtUtc = isoUtc(l.startedAtWallMs + l.lastOffsetMs),
  )
}

/** The capture result the manifest is built from, read from the ledger alone. */
internal fun frameLedgerOutcome(l: FrameLedger): ScreenCaptureOutcome {
  val finished = l.state == FRAME_LEDGER_FINISHED
  val limitations = if (finished) l.limitations else (l.limitations + "CAPTURE_INTERRUPTED").distinct()
  return ScreenCaptureOutcome(
    osConsentGranted = true,
    startedAtUtc = l.startedAtUtc,
    endedAtUtc = l.endedAtUtc ?: isoUtc(l.startedAtWallMs + l.lastOffsetMs),
    osVersion = l.osVersion,
    model = l.model,
    appVersion = l.appVersion,
    screenW = l.screenW,
    screenH = l.screenH,
    densityDpi = l.densityDpi,
    orientation = l.orientation,
    frames = l.frames,
    // Never a clean stop unless the service itself recorded one.
    stopReason = if (finished) (l.stopReason ?: "INTERRUPTED") else "INTERRUPTED",
    limitations = limitations,
  )
}

/** A recovered capture JS should offer (frames held, no live service). */
internal fun recoverableFrameOutcome(l: FrameLedger?, serviceActive: Boolean): ScreenCaptureOutcome? {
  if (l == null || serviceActive) return null
  val r = recoverFrameLedger(l, serviceActive)
  if (r.frames.isEmpty()) return null
  return frameLedgerOutcome(r)
}

// ------------------------------------------------------------ serialisation --

internal fun frameLedgerToJson(l: FrameLedger): String = MiniJson.write(
  mapOf(
    "schema" to l.schema,
    "recordingId" to l.recordingId,
    "startedAtUtc" to l.startedAtUtc,
    "startedAtWallMs" to l.startedAtWallMs,
    "osVersion" to l.osVersion,
    "model" to l.model,
    "appVersion" to l.appVersion,
    "screenW" to l.screenW,
    "screenH" to l.screenH,
    "densityDpi" to l.densityDpi,
    "orientation" to l.orientation,
    "frames" to l.frames.map { f ->
      mapOf(
        "uri" to f.uri,
        "frameIndex" to f.frameIndex,
        "widthPx" to f.widthPx,
        "heightPx" to f.heightPx,
        "capturedAtOffsetMs" to f.capturedAtOffsetMs,
      )
    },
    "limitations" to l.limitations,
    "state" to l.state,
    "stopReason" to l.stopReason,
    "endedAtUtc" to l.endedAtUtc,
    "lastOffsetMs" to l.lastOffsetMs,
  ),
)

private fun Map<*, *>.fstr(k: String): String? = this[k] as? String
private fun Map<*, *>.flong(k: String): Long? = (this[k] as? Number)?.toLong()
private fun Map<*, *>.fint(k: String): Int? = (this[k] as? Number)?.toInt()

/** Defensive parse: anything malformed or of another schema is null, never a guess. */
internal fun frameLedgerFromJson(text: String): FrameLedger? {
  val root = (try { MiniJson.parse(text) } catch (_: Throwable) { return null }) as? Map<*, *> ?: return null
  if (root.fint("schema") != FRAME_LEDGER_SCHEMA) return null
  val frames = (root["frames"] as? List<*> ?: return null).map { raw ->
    val m = raw as? Map<*, *> ?: return null
    FrameOut(
      uri = m.fstr("uri") ?: return null,
      frameIndex = m.fint("frameIndex") ?: return null,
      widthPx = m.fint("widthPx") ?: return null,
      heightPx = m.fint("heightPx") ?: return null,
      capturedAtOffsetMs = m.flong("capturedAtOffsetMs") ?: return null,
    )
  }
  val state = root.fstr("state") ?: return null
  if (state != FRAME_LEDGER_RECORDING && state != FRAME_LEDGER_FINISHED && state != FRAME_LEDGER_INTERRUPTED) return null
  return FrameLedger(
    recordingId = root.fstr("recordingId") ?: return null,
    startedAtUtc = root.fstr("startedAtUtc") ?: return null,
    startedAtWallMs = root.flong("startedAtWallMs") ?: return null,
    osVersion = root.fstr("osVersion") ?: "unknown",
    model = root.fstr("model") ?: "Android device",
    appVersion = root.fstr("appVersion") ?: "unknown",
    screenW = root.fint("screenW") ?: return null,
    screenH = root.fint("screenH") ?: return null,
    densityDpi = root.fint("densityDpi") ?: return null,
    orientation = root.fstr("orientation") ?: "portrait",
    frames = frames,
    limitations = (root["limitations"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList(),
    state = state,
    stopReason = root.fstr("stopReason"),
    endedAtUtc = root.fstr("endedAtUtc"),
    lastOffsetMs = root.flong("lastOffsetMs") ?: 0L,
  )
}

/** Atomic file store for the frame ledger (frame-ledger.json in its directory). */
internal class FrameLedgerStore(val dir: File) {
  private val file = File(dir, "frame-ledger.json")
  private val tmp = File(dir, "frame-ledger.json.tmp")

  fun read(): FrameLedger? {
    if (!file.exists()) return null
    return try { frameLedgerFromJson(file.readText(Charsets.UTF_8)) } catch (_: Throwable) { null }
  }

  fun write(l: FrameLedger): Boolean = try {
    if (!dir.exists()) dir.mkdirs()
    FileOutputStream(tmp).use { out ->
      out.write(frameLedgerToJson(l).toByteArray(Charsets.UTF_8))
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

/** The one in-process holder of the frame ledger; every change is persisted first. */
internal object FrameLedgerKeeper {
  private var store: FrameLedgerStore? = null
  private var current: FrameLedger? = null
  private var loaded = false

  @Synchronized
  fun attach(dir: File) {
    if (store?.dir == dir) return
    store = FrameLedgerStore(dir)
    loaded = false
    current = null
  }

  @Synchronized
  fun get(): FrameLedger? {
    if (!loaded) {
      current = store?.read()
      loaded = true
    }
    return current
  }

  @Synchronized
  fun update(change: (FrameLedger) -> FrameLedger?): FrameLedger? {
    val before = get() ?: return null
    val after = change(before) ?: return before
    if (after != before) {
      store?.write(after)
      current = after
    }
    return after
  }

  @Synchronized
  fun replace(l: FrameLedger) {
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
