/**
 * UC-AND-007 / UC-AND-011 / UC-AND-012 / UC-AND-013 / UC-AND-004 — Android
 * screen-capture service behaviour, pinned at source level.
 *
 * Kotlin cannot compile or run here (no Android SDK / device), so this is a
 * SOURCE-STRUCTURE proof: each defect's control flow has one named construct,
 * and this fails if it disappears. Device acceptance remains required.
 *
 * RED on the pre-remediation tree: `try { r.stop() } catch (_: Throwable) {}`
 * then the segment was emitted anyway; every frame failure was reported as
 * SECURE_CONTENT_OMITTED; the frame service had no display listener; a setup
 * failure after consent called finish("ERROR") and never settled the promise.
 *
 * 2026-10-29 — the continuous service records ONE file per session (no
 * rollover, no restart); the one-file rules (bounds, rotation, microphone,
 * interruption) are pinned in ios-broadcast-contract-single-file.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const KT = resolve(HERE, "../modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture");
const code = (f) => readFileSync(resolve(KT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const continuous = code("ContinuousScreenCaptureService.kt");
const frames = code("ScreenCaptureService.kt");
const module = code("ProovraScreenCaptureModule.kt");
const decisions = code("CaptureDecisions.kt");

test("UC-AND-007: a recording whose MediaRecorder.stop() threw is deleted, recorded, and never offered", () => {
  // The decision lives in CaptureDecisions.kt (JVM-unit-tested by
  // CaptureDecisionsTest.kt); the service must route stop() through it and act
  // on the discard verdict.
  assert.match(decisions, /try \{ stop\(\) \} catch \(_: Throwable\) \{ stopFailed = true \}/);
  assert.match(decisions, /if \(stopFailed\) \{\s*try \{ deleteFile\(\) \}[\s\S]*?return SegmentClose\.DISCARD_WRITE_FAILED/);
  assert.match(continuous, /closeSegment\(\s*stop = \{ r\.stop\(\) \}/);
  assert.match(continuous, /if \(outcome == SegmentClose\.DISCARD_WRITE_FAILED\) \{\s*limitations\.add\("SEGMENT_WRITE_FAILED"\)\s*return false\s*\}/);
  assert.ok(!/try \{ r\.stop\(\) \} catch \(_: Throwable\) \{\}/.test(continuous), "the swallowed stop() is back");
  // A clean stop over a lost stretch is not COMPLETE (sessionCompleteness, JVM-tested).
  assert.match(continuous, /val completeness = sessionCompleteness\(reason, limitations\)/);
  assert.match(decisions, /val complete = reason in CLEAN_TERMINATIONS && limitations\.none \{ it in INCOMPLETE_LIMITATIONS \}/);
});

test("UC-AND-011: a frame failure is FRAME_CAPTURE_FAILED; secure content is never claimed", () => {
  assert.match(frames, /limitations\.add\("FRAME_CAPTURE_FAILED"\)/);
  assert.ok(!/limitations\.add\("SECURE_CONTENT_OMITTED"\)/.test(frames), "the frame service still claims to detect secure content");
});

test("UC-AND-012: a rotation resizes the capture surface; frames carry their own geometry and the change is recorded", () => {
  assert.match(frames, /registerDisplayListener\(\)/);
  assert.match(frames, /override fun onDisplayChanged\(displayId: Int\) \{ onDisplayGeometryChanged\(\) \}/);
  assert.match(frames, /virtualDisplay\?\.resize\(m\.widthPixels, m\.heightPixels, m\.densityDpi\)/);
  assert.match(frames, /limitations\.add\("ORIENTATION_CHANGED_DURING_CAPTURE"\)/);
  assert.match(frames, /widthPx = w,\s*heightPx = h,/);
});

test("UC-AND-013: a setup failure after consent REJECTS the start (both services)", () => {
  for (const [name, src] of [["continuous", continuous], ["frames", frames]]) {
    assert.match(src, /private fun failStart\(code: String, message: String\)/, name);
    assert.match(src, /try \{\s*(startForegroundWithNotification\(\)\s*)?beginProjection\(\)\s*\} catch \(t: Throwable\) \{\s*failStart\(/, name);
    assert.match(src, /cb\?\.invoke\(code, message\)/, name);
    assert.ok(!/getMediaProjection\(resultCode, data\) \?: return finish\("ERROR"\)/.test(src), `${name}: the hung-start path is back`);
    // Consent / null projection / a throw are decided by obtainProjection
    // (JVM-unit-tested) and every refusal goes to failStart.
    assert.match(src, /obtainProjection\(resultData\) \{ mpm\.getMediaProjection\(resultCode, it\) \}/, name);
    assert.match(src, /is ProjectionOutcome\.Refused -> [\s\S]{0,20}failStart\(outcome\.code, outcome\.message\)/, name);
  }
  assert.match(decisions, /if \(projection == null\) \{\s*ProjectionOutcome\.Refused\(PROJECTION_UNAVAILABLE/);
  assert.equal((module.match(/onStartFailed = \{ code, message -> pending\.rejectWith\(code, message\) \}/g) ?? []).length, 2);
});

test("UC-AND-004: the recorder's segments are listable and callbacks re-bind to a recreated module", () => {
  assert.match(module, /Function\("getContinuousSegments"\) \{ ContinuousScreenCaptureService\.segmentsSnapshot\(\) \}/);
  assert.match(module, /OnCreate \{\s*bindContinuousCallbacks\(\)/);
  assert.match(module, /AsyncFunction\("discardContinuousSpool"\)/);
  // AUD-004 — the in-memory list while the process lives; the durable
  // ledger's unconfirmed segments after a process death.
  assert.match(continuous, /fun segmentsSnapshot\(\): List<Map<String, Any\?>> \{\s*if \(segments\.isNotEmpty\(\) \|\| active\) return segments\.toList\(\)/);
  assert.match(continuous, /return ledgerSegmentsToJs\(l\)\.filter \{ it\["uploadState"\] == SEGMENT_RECORDED \}/);
});

/* ---------------------------------------------------------------- AUD-029 -- */

test("AUD-029(a): a recreated module re-binds BOTH services and rejects what a dead context awaited", () => {
  assert.match(module, /OnCreate \{\s*bindContinuousCallbacks\(\)\s*bindFrameCallbacks\(\)/);
  assert.match(module, /OnDestroy \{ rejectOrphanedPromises\(\) \}/);
  assert.match(module, /p\.rejectWith\(MODULE_RELOADED, /);
  assert.match(module, /const val MODULE_RELOADED = "MODULE_RELOADED"/);
  // Every held promise settles at most once (SettleOnce, JVM-tested).
  assert.match(module, /private typealias Pending = SettleOnce<Promise>/);
  assert.ok(!/private var \w+Promise: Promise\?/.test(module), "a raw Promise field is back: it can double-settle");
  // The frame callbacks are bound by ONE function, used by start and OnCreate.
  assert.equal((module.match(/(?<!Continuous)ScreenCaptureService\.onStopped = /g) ?? []).length, 1);
});

test("AUD-029(b): the recorder is configured inside the encoder's capabilities", () => {
  assert.match(continuous, /MediaCodecList\(MediaCodecList\.REGULAR_CODECS\)/);
  assert.match(continuous, /getCapabilitiesForType\(MediaFormat\.MIMETYPE_VIDEO_AVC\)\.videoCapabilities/);
  assert.match(continuous, /val config = clampEncoderConfig\(widthPx, heightPx, BITRATE, FRAME_RATE, avcEncoderCaps\(\)\)/);
  assert.match(continuous, /startFailure = ENCODER_UNSUPPORTED_SIZE/);
  assert.match(continuous, /r\.setVideoSize\(config\.width, config\.height\)/);
  assert.match(continuous, /r\.setVideoEncodingBitRate\(config\.bitrate\)/);
  assert.ok(!/setVideoSize\((segW|widthPx), (segH|heightPx)\)/.test(continuous), "the raw display size reaches the encoder again");
});

test("AUD-029(b): a recorder that cannot start REJECTS the start with a stable code — never a silent stall", () => {
  assert.match(
    continuous,
    /if \(!startRecorder\(\)\) \{\s*failStart\(startFailure \?: "RECORDER_UNAVAILABLE", "The screen recorder could not start\."\)\s*return\s*\}/,
  );
  assert.match(continuous, /startFailure = SEGMENT_START_FAILED\s*false/);
  assert.match(continuous, /startFailure = STORAGE_LOW/);
  // No mid-session restart exists that could stall unnoticed.
  assert.ok(!/startNextSegment|rolloverSegment/.test(continuous), "the rollover is back");
});

test("AUD-029(c): failures carry stable codes, never raw exception prose", () => {
  for (const [name, src] of [["continuous", continuous], ["frames", frames], ["module", module]]) {
    assert.ok(!/t\.message/.test(src), `${name} surfaces a raw t.message`);
  }
  assert.match(decisions, /internal fun startFailureMessage\(t: Throwable\): String/);
  assert.match(continuous, /r\.setOnErrorListener \{ _, what, extra ->\s*recorderErrorExtra = extra\s*finish\("ERROR", recorderErrorCode\(what\)\)/);
  assert.match(continuous, /"terminationDetail" to terminationDetail/);
});

test("AUD-029: both services run as mediaProjection foreground services; audio ONLY on the continuous recorder's explicit microphone option", () => {
  const manifest = readFileSync(resolve(KT, "../../../../AndroidManifest.xml"), "utf8");
  for (const [name, src, type] of [
    ["ContinuousScreenCaptureService", continuous, "mediaProjection\\|microphone"],
    ["ScreenCaptureService", frames, "mediaProjection"],
  ]) {
    assert.match(src, /startForeground\(NOTIF_ID, notification, ServiceInfo\.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION\)/, name);
    assert.match(
      manifest,
      new RegExp(`android:name="com\\.proovra\\.screencapture\\.${name}"\\s+android:exported="false"\\s+android:foregroundServiceType="${type}"`),
      name,
    );
  }
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_MEDIA_PROJECTION/);
  // RECORD_AUDIO is declared for ONE use: the continuous recorder's explicit microphone option.
  assert.equal((manifest.match(/android\.permission\.RECORD_AUDIO/g) ?? []).length, 1);
  assert.ok(!/setAudioSource|AudioRecord|RECORD_AUDIO/.test(frames), "the frame service touches audio");
  assert.match(continuous, /if \(withMicrophone\) r\.setAudioSource\(MediaRecorder\.AudioSource\.MIC\)/);
  assert.match(module, /val microphone = options\["microphone"\] == true/);
});

/* ---------------------------------------------------------------- AUD-004 -- */

test("AUD-004: the service writes the durable ledger at start (naming the one file), at its close (before JS hears) and at finish", () => {
  assert.match(continuous, /ContinuousLedgerKeeper\.replace\(\s*ContinuousLedger\([\s\S]*?layout = LAYOUT_SINGLE_FILE,\s*recordingPath = currentFile\?\.absolutePath,/);
  assert.match(continuous, /ContinuousLedgerKeeper\.update \{\s*ledgerWithSegment\([\s\S]*?\)\.copy\(recordingFinalized = true\)\s*\}\s*segments\.add\(seg\)\s*return true/);
  assert.match(continuous, /ContinuousLedgerKeeper\.update \{\s*ledgerFinished\(it, reason, terminationDetail, limitations\.toList\(\), completeness, totalMs, endedAtUtc\)\s*\.copy\(recordingFinalized = finalized, orientationTimeline = orientationTimeline, audioTracks = tracks\)\s*\}\s*last = outcome\s*onStopped\?\.invoke\(outcome\)/);
  // New builds emit no per-segment event.
  assert.ok(!/onSegment/.test(continuous + module), "a per-segment event is emitted again");
  // The spool lives in filesDir (cacheDir can be purged under storage pressure).
  assert.match(continuous, /fun spoolDir\(context: Context\): File = File\(context\.filesDir, SPOOL_DIR\)/);
  assert.ok(!/File\(cacheDir, "proovra-continuous-/.test(continuous), "segments are written to cacheDir again");
});

test("AUD-004: nothing is deleted on lost JS memory — only a confirmed upload, a bound commit, or an explicit discard", () => {
  // Confirmation: the ledger first, then only a path the ledger says is confirmed.
  assert.match(continuous, /if \(seg != null && seg\.path in automaticallyDeletablePaths\(after\)\)/);
  // Commit: only for exactly the bound session.
  assert.match(continuous, /if \(!ledgerBoundTo\(ContinuousLedgerKeeper\.get\(\), captureSessionId\)\) return false/);
  // A new recording never overwrites a ledger that holds segments.
  assert.match(module, /if \(ContinuousScreenCaptureService\.newRecordingBlocked\(\)\) \{\s*promise\.reject\(CodedException\("PENDING_RECORDING"/);
  // Binding mismatch is a refusal, never a merge.
  assert.match(module, /promise\.reject\(CodedException\("BINDING_MISMATCH"/);
});

test("AUD-004: stop after a process death answers the ledger's outcome, never an empty map", () => {
  assert.ok(!/lastOutcome\(\) \?: emptyMap<String, Any\?>\(\)/.test(module), "the empty continuous outcome is back");
  assert.match(module, /promise\.reject\(CodedException\("NO_RECORDING"/);
  assert.match(continuous, /val l = recoveredLedger\(\) \?: return null\s*return ledgerOutcome\(l\)/);
  assert.match(module, /Function\("getContinuousLedger"\) \{ ContinuousScreenCaptureService\.ledgerForJs\(\) \}/);
});
