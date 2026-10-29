/**
 * ONE Start→Stop screen recording = ONE complete video file (wire contracts
 * A/B, 2026-10-29) — the iOS ReplayKit extension and the Android
 * MediaProjection recorder, pinned at source level.
 *
 * Swift and Kotlin cannot compile here (native-build.yml compiles both and runs
 * the XCTest / JVM suites); this is the SOURCE-STRUCTURE proof that each rule
 * has one named construct, plus a key-level check that what the natives return
 * is what the JS binding (index.ts) declares. Device acceptance (a real
 * broadcast / MediaProjection session) is still required.
 *
 * RED on the pre-remediation tree: SampleHandler rolled a new AVAssetWriter
 * every segmentMs and on every rotation, returned on every non-video buffer,
 * and skipped frames silently when the input was not ready; the Android
 * service capped each file with setMaxDuration(segmentMs) and recreated the
 * MediaRecorder on every rollover and rotation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { CAPTURE_LIMITS, SCREEN_CONTINUOUS_MANIFEST_BOUNDS, SCREEN_CONTINUOUS_STREAM_BOUNDS } from "@proovra/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(HERE, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const KT = "../modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture";
const handler = stripComments(read("../plugins/broadcast-extension/SampleHandler.swift"));
const shared = stripComments(read("../modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift"));
const spool = stripComments(read("../modules/proovra-screen-capture/ios/ProovraBroadcastSpool.swift"));
const iosModule = stripComments(read("../modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift"));
const service = stripComments(read(`${KT}/ContinuousScreenCaptureService.kt`));
const ledger = stripComments(read(`${KT}/ContinuousLedger.kt`));
const ktModule = stripComments(read(`${KT}/ProovraScreenCaptureModule.kt`));
const frames = stripComments(read(`${KT}/ScreenCaptureService.kt`));
const manifest = read("../modules/proovra-screen-capture/android/src/main/AndroidManifest.xml");
const binding = read("../modules/proovra-screen-capture/index.ts");
const num = (src, re, what) => {
  const m = src.match(re);
  assert.ok(m, `${what} not found`);
  return m[1].split("*").map((x) => Number(x.trim().replace(/_/g, "").replace(/L$/, ""))).reduce((a, b) => a * b, 1);
};
/** The keys a TS object type declares (top level, `key?:` or `key:`). */
const tsTypeKeys = (src, name) => {
  const m = src.match(new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(m, `type ${name} not found in index.ts`);
  return new Set([...m[1].matchAll(/^ {2}(\w+)\??:/gm)].map((x) => x[1]));
};
const CONTRACT_B_KEYS = [
  "layout", "recordingUri", "recordingSizeBytes", "recordingDurationMs", "widthPx", "heightPx",
  "orientationTimeline", "pauses", "audioTracks", "finalized",
];

/* ------------------------------------------------------------- iOS ------ */

test("iOS: ONE AVAssetWriter per broadcast — no rollover, no restart, no per-segment output", () => {
  assert.equal((handler.match(/AVAssetWriter\(outputURL:/g) ?? []).length, 1, "exactly one writer construction");
  assert.match(handler, /if writer == nil \{\s*guard startWriter\(/, "the writer is created once, at the first frame");
  for (const gone of [/segmentStartPts/, /finalizeSegment/, /elapsedMs >= segmentMs/, /orientationChanged/, /publishSegment/, /segmentMediaURL/, /segmentReadyNote/]) {
    assert.ok(!gone.test(handler), `rollover construct is back: ${gone}`);
  }
  // The recording file and its sidecar come from the shared spool, never hard-coded.
  assert.match(handler, /spool\.recordingMediaURL\(recordingId\)/);
  assert.ok(!/"recording\.(mp4|json)"/.test(handler));
  assert.match(spool, /static let recordingMediaName = "recording\.mp4"/);
  assert.match(spool, /static let recordingSidecarName = "recording\.json"/);
});

test("iOS: fragmented .mp4 (≈2 s) with a key frame per fragment, H.264 real-time input", () => {
  assert.match(handler, /AVAssetWriter\(outputURL: url, fileType: \.mp4\)/);
  assert.match(handler, /w\.movieFragmentInterval = CMTime\(seconds: SampleHandler\.fragmentSeconds, preferredTimescale: 600\)/);
  assert.match(handler, /private static let fragmentSeconds: Double = 2\n/);
  assert.match(handler, /AVVideoMaxKeyFrameIntervalDurationKey: SampleHandler\.fragmentSeconds/);
  assert.match(handler, /AVVideoCodecKey: AVVideoCodecType\.h264/);
  assert.match(handler, /video\.expectsMediaDataInRealTime = true/);
  assert.equal(num(handler, /private static let videoBitrateBps = ([\d_]+)/, "videoBitrateBps"), SCREEN_CONTINUOUS_STREAM_BOUNDS.videoBitrateBps);
  // movieFragmentInterval must be set before startWriting.
  assert.ok(handler.indexOf("w.movieFragmentInterval") < handler.indexOf("w.startWriting()"));
});

test("iOS: the canvas is fixed; a rotation is recorded, a buffer of another size is refused AND counted", () => {
  assert.match(handler, /canvasRawW = rawW\s*canvasRawH = rawH\s*canvasW = orientedW\s*canvasH = orientedH/);
  assert.match(handler, /guard rawW == canvasRawW, rawH == canvasRawH else \{\s*droppedFrameCount \+= 1\s*return\s*\}/);
  assert.match(handler, /noteOrientation\(orientedW: orientedW, orientedH: orientedH, atMs: atMs\)/);
  assert.match(handler, /orientationTimeline\.append\(entry\)/);
  assert.match(handler, /if label != initialOrientation \{ limitations\.insert\("ORIENTATION_CHANGED_DURING_CAPTURE"\) \}/);
  // Strictly ascending offsets and the validator's bounds.
  assert.match(handler, /previous >= atMs \{\s*orientationTimeline\[orientationTimeline\.count - 1\] = entry/);
  assert.equal(num(handler, /maxTimelineEntries = (\d+)/, "maxTimelineEntries"), SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxOrientationChanges);
  assert.equal(num(handler, /maxPauses = (\d+)/, "maxPauses"), SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxPauses);
});

test("iOS: every refused or failed append is counted in droppedFrameCount — never a silent skip", () => {
  assert.match(handler, /guard let input = videoInput, input\.isReadyForMoreMediaData else \{\s*droppedFrameCount \+= 1/);
  assert.match(handler, /if input\.append\(sampleBuffer\) \{[\s\S]*?\} else \{\s*droppedFrameCount \+= 1/);
  assert.ok(!/input\.isReadyForMoreMediaData else \{ return \}/.test(handler), "a not-ready frame is skipped silently again");
  // FRAMES_DROPPED exactly when the count is positive (the validator rejects either mismatch).
  assert.match(handler, /if droppedFrameCount > 0 \{ limitations\.insert\("FRAMES_DROPPED"\) \}/);
  assert.match(handler, /"droppedFrameCount": droppedFrameCount/);
});

test("iOS: app and microphone audio go to their own AAC inputs and are written ONLY when they arrive", () => {
  assert.match(handler, /case \.audioApp:\s*queue\.sync \{ self\.handleAudio\(sampleBuffer, microphone: false\) \}/);
  assert.match(handler, /case \.audioMic:\s*queue\.sync \{ self\.handleAudio\(sampleBuffer, microphone: true\) \}/);
  assert.ok(!/guard sampleBufferType == \.video else \{ return \}/.test(handler), "audio is dropped again");
  assert.match(handler, /AVFormatIDKey: kAudioFormatMPEG4AAC/);
  assert.match(handler, /input\.expectsMediaDataInRealTime = true\s*return input/);
  // Appended only on arrival, after the recording started; tracks listed only when they got samples.
  assert.match(handler, /guard !stopped, writer != nil, let input = microphone \? micAudioInput : appAudioInput else \{ return \}/);
  assert.match(handler, /if microphone \{ micAudioSamples \+= 1 \} else \{ appAudioSamples \+= 1 \}/);
  assert.match(handler, /if appAudioSamples > 0 \{ tracks\.append\("APP"\) \}\s*if micAudioSamples > 0 \{ tracks\.append\("MICROPHONE"\) \}/);
  assert.match(handler, /if tracks\.isEmpty \{ limitations\.insert\("AUDIO_NOT_CAPTURED"\) \}/);
  assert.match(handler, /droppedAudioBufferCount \+= 1/);
  // The OS picker is the microphone consent.
  assert.match(shared, /view\.showsMicrophoneButton = true/);
  assert.ok(!/showsMicrophoneButton = false/.test(shared));
});

test("iOS: pause/resume keeps the ONE writer and records the gap on the PTS timeline", () => {
  assert.match(handler, /if !paused, let start = pauseStartOffsetMs \{\s*closePause\(start: start, end: atMs\)/);
  assert.match(handler, /guard end > start else \{ return \}/, "an empty pause is never recorded (the validator needs end > start)");
  assert.match(handler, /"pauses": pauses/);
});

test("iOS: THE session bounds finish the file and end the broadcast with BOUNDS_REACHED — never a split", () => {
  assert.equal(num(handler, /private static let maxSessionMs = ([\d* ]+)\n/, "maxSessionMs"), CAPTURE_LIMITS.maxContinuousSessionMs);
  assert.equal(num(handler, /private static let maxSessionBytes: Int64 = ([\d* ]+)\n/, "maxSessionBytes"), CAPTURE_LIMITS.maxContinuousSessionBytes);
  assert.equal(num(handler, /private static let minFreeBytes: Int64 = ([\d* ]+)\n/, "minFreeBytes"), 200 * 1024 * 1024);
  assert.match(handler, /if atMs >= SampleHandler\.maxSessionMs \{\s*reachBounds\(\)/);
  assert.match(handler, /size \+ SampleHandler\.sessionBytesMargin >= SampleHandler\.maxSessionBytes \{\s*reachBounds\(\)/);
  assert.match(handler, /free < SampleHandler\.minFreeBytes \{\s*reachBounds\(\)/);
  assert.match(handler, /private func reachBounds\(\) \{[\s\S]*?limitations\.insert\("SESSION_BOUNDS_REACHED"\)\s*finishRecording\(reason: "BOUNDS_REACHED"\)\s*endBroadcast\(/);
});

test("iOS: the sidecar states the recording's facts and the host returns them as wire contract B", () => {
  const sidecar = handler.match(/var sidecar: \[String: Any\] = \[([\s\S]*?)\n {4}\]/);
  assert.ok(sidecar, "the recording sidecar dictionary was not found");
  const written = new Set([...sidecar[1].matchAll(/"(\w+)":/g)].map((m) => m[1]));
  written.add("startedAtUtc"); // added when the first frame was seen
  for (const k of ["sizeBytes", "durationMs", "widthPx", "heightPx", "orientationTimeline", "pauses", "droppedFrameCount",
    "audioTracks", "finalized", "limitations", "terminationReason", "startedAtUtc", "endedAtUtc"]) {
    assert.ok(written.has(k), `the sidecar lacks ${k}`);
  }
  // The spool stamps the identity and layout; the reader reads back only keys the writer writes
  // (from the sidecar, or — extension killed — the heartbeat's state.json).
  assert.match(spool, /body\["layout"\] = "SINGLE_FILE"\s*body\["fileName"\] = ProovraBroadcastSpool\.recordingMediaName/);
  const reader = spool.match(/func recordingFile\(_ recordingId: String\)[\s\S]*?\n {2}\}\n/)[0];
  const stateBlock = handler.match(/var state: \[String: Any\] = \[([\s\S]*?)\n {4}\]/)[1];
  for (const k of new Set([...reader.matchAll(/(?:source|\$0)\["(\w+)"\]/g)].map((m) => m[1]))) {
    assert.ok(written.has(k), `recordingFile reads ${k}, which the sidecar does not write`);
    if (k !== "durationMs" && k !== "finalized") assert.ok(stateBlock.includes(`"${k}"`), `a killed extension's state.json lacks ${k}`);
  }
  // Without the sidecar: no duration, not finalized.
  assert.match(reader, /durationMs: sidecar\.flatMap \{ \$0\["durationMs"\] as\? Int \}/);
  assert.match(reader, /finalized: mediaExists && \(\(sidecar\?\["finalized"\] as\? Bool\) \?\? false\)/);
  // Wire contract B: every key the host returns is declared by the JS binding.
  const fields = spool.match(/func toJsFields\(\) -> \[String: Any\] \{\s*return \[([\s\S]*?)\n {4}\]/)[1];
  const returned = [...fields.matchAll(/"(\w+)":/g)].map((m) => m[1]);
  const declared = tsTypeKeys(binding, "ScreenContinuousResult");
  for (const k of CONTRACT_B_KEYS) assert.ok(returned.includes(k), `iOS toJsFields lacks ${k}`);
  for (const k of returned) assert.ok(declared.has(k), `iOS returns ${k}, which ScreenContinuousResult does not declare`);
  assert.match(fields, /"layout": "SINGLE_FILE"/);
  // Merged into the stop result (written result, and the honest fallback).
  assert.match(shared, /recording: spool\?\.recordingFile\(recordingId\)/);
  assert.match(shared, /let recording = recordingId\.flatMap \{ spool\?\.recordingFile\(\$0\) \}/);
  assert.match(shared, /completeness: "INTERRUPTED_SESSION",\s*terminationReason: "UNKNOWN"/);
  // The app waits long enough for the extension to finish the one file.
  assert.ok(num(iosModule, /stopWaitSeconds: TimeInterval = (\d+)/, "stopWaitSeconds") > num(handler, /finishWaitSeconds = (\d+)/, "finishWaitSeconds"));
});

test("iOS: a recording file left by a killed extension is recoverable, never presented as complete", () => {
  assert.match(spool, /func recoverable\(nowUptime: TimeInterval\)[\s\S]*?\$0\.hasRecordingFile \|\| \$0\.segmentCount > 0/);
  // A failed writer keeps the fragments it wrote; only an empty file of THIS broadcast is removed.
  assert.match(handler, /let hasMedia = lastPts\.isValid\s*if let w = failed, w\.status == \.writing, !hasMedia \{ w\.cancelWriting\(\) \}/);
  assert.match(handler, /"finalized": hasMedia && finalized/);
});

/* --------------------------------------------------------- Android ------ */

test("Android: ONE MediaRecorder per session — no rollover, no restart, no next file", () => {
  for (const gone of [/rolloverSegment/, /startNextSegment/, /setNextOutputFile/, /setMaxDuration\(segmentMs\)/, /MAX_SEGMENT_BYTES\)/, /onSegment/]) {
    assert.ok(!gone.test(service), `rollover construct is back: ${gone}`);
  }
  assert.ok(!/vd\.resize|virtualDisplay\?\.resize/.test(service), "the VirtualDisplay is resized mid-recording again");
  // The recorder is created in exactly one place, started once per session (a
  // screen-only retry only when the microphone could not be configured).
  assert.equal((service.match(/newRecorder\(file, config, maxBytes, withMicrophone\)/g) ?? []).length, 1);
  assert.match(service, /if \(tryStartRecorder\(file, config, maxBytes, withMicrophone = true\)\)/);
  assert.match(service, /return tryStartRecorder\(file, config, maxBytes, withMicrophone = false\)/);
  assert.equal((service.match(/createVirtualDisplay\(/g) ?? []).length, 1);
});

test("Android: the max duration / size ARE the session bounds and reaching one stops with BOUNDS_REACHED", () => {
  assert.equal(num(service, /MAX_SESSION_MS = ([\dL *]+)\n/, "MAX_SESSION_MS"), CAPTURE_LIMITS.maxContinuousSessionMs);
  assert.equal(num(service, /MAX_SESSION_BYTES = ([\dL *]+)\n/, "MAX_SESSION_BYTES"), CAPTURE_LIMITS.maxContinuousSessionBytes);
  assert.equal(num(service, /MIN_FREE_BYTES = ([\dL *]+)\n/, "MIN_FREE_BYTES"), 200 * 1024 * 1024);
  assert.match(service, /r\.setMaxDuration\(MAX_SESSION_MS\.toInt\(\)\)/);
  assert.match(service, /val maxBytes = minOf\(MAX_SESSION_BYTES, dir\.usableSpace - MIN_FREE_BYTES\)/);
  assert.match(service, /r\.setMaxFileSize\(maxBytes\)/);
  assert.match(
    service,
    /MEDIA_RECORDER_INFO_MAX_DURATION_REACHED \|\|\s*what == MediaRecorder\.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED\s*\) \{\s*limitations\.add\("SESSION_BOUNDS_REACHED"\)\s*finish\("BOUNDS_REACHED"\)\s*\}/,
  );
});

test("Android: rotation keeps the canvas and is recorded on the orientation timeline", () => {
  assert.match(service, /private fun onDisplayGeometryChanged\(\) \{[\s\S]*?withOrientation\(orientationTimeline, timeline\.offsetMs\(\), m\.widthPixels, m\.heightPixels\)/);
  const onChange = service.match(/private fun onDisplayGeometryChanged\(\) \{[\s\S]*?\n {2}\}/)[0];
  assert.ok(!/closeRecording|startRecorder|resize|newRecorder/.test(onChange), "a rotation restarts or resizes the recorder again");
  assert.match(onChange, /limitations\.add\("ORIENTATION_CHANGED_DURING_CAPTURE"\)/);
  assert.match(onChange, /ContinuousLedgerKeeper\.update \{ it\.copy\(orientationTimeline = orientationTimeline/);
  assert.match(ledger, /if \(last != null && last\.atOffsetMs >= atOffsetMs\) return timeline\.dropLast\(1\)/);
  assert.match(ledger, /max: Int = 256/);
});

test("Android: the microphone ONLY on the explicit option with RECORD_AUDIO granted; never other apps' audio", () => {
  // The module: explicit `microphone: true`, refused without the runtime grant (never requested natively).
  assert.match(ktModule, /val microphone = options\["microphone"\] == true/);
  assert.match(ktModule, /if \(microphone && activity\.checkSelfPermission\(Manifest\.permission\.RECORD_AUDIO\) != PackageManager\.PERMISSION_GRANTED\) \{\s*promise\.reject\(CodedException\("MICROPHONE_PERMISSION_REQUIRED"/);
  assert.ok(!/requestPermissions/.test(ktModule), "the module requests a runtime permission itself");
  // The service: an audio source only with the explicit flag.
  assert.equal((service.match(/setAudioSource\(/g) ?? []).length, 1);
  assert.match(service, /if \(withMicrophone\) r\.setAudioSource\(MediaRecorder\.AudioSource\.MIC\)/);
  assert.match(service, /r\.setAudioEncoder\(MediaRecorder\.AudioEncoder\.AAC\)/);
  assert.ok(!/AudioSource\.(REMOTE_SUBMIX|VOICE_CALL|DEFAULT)|AudioPlaybackCapture/.test(service));
  assert.match(service, /if \(microphoneRequested && Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.R\)[\s\S]*?FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or ServiceInfo\.FOREGROUND_SERVICE_TYPE_MICROPHONE/);
  assert.match(service, /private fun audioTracks\(\): List<String> = if \(microphoneActive\) listOf\(AUDIO_TRACK_MICROPHONE\) else emptyList\(\)/);
  assert.match(service, /if \(tracks\.isEmpty\(\)\) limitations\.add\("AUDIO_NOT_CAPTURED"\)/);
  // Declared once, explained, and typed for the microphone FGS.
  assert.match(manifest, /<uses-permission android:name="android\.permission\.RECORD_AUDIO" \/>/);
  assert.match(manifest, /<uses-permission android:name="android\.permission\.FOREGROUND_SERVICE_MICROPHONE" \/>/);
  assert.match(manifest, /android:name="com\.proovra\.screencapture\.ContinuousScreenCaptureService"\s+android:exported="false"\s+android:foregroundServiceType="mediaProjection\|microphone"/);
  assert.match(manifest, /android:name="com\.proovra\.screencapture\.ScreenCaptureService"\s+android:exported="false"\s+android:foregroundServiceType="mediaProjection"/);
  // The JS binding sends the flag only when it is literally true.
  assert.match(binding, /microphone: options\.microphone === true,/);
});

test("Android: an interruption finalises what MediaRecorder allows and says so truthfully", () => {
  assert.match(service, /override fun onDestroy\(\) \{\s*if \(active\) finish\("INTERRUPTED"\)/);
  assert.match(service, /override fun onStop\(\) \{ finish\("PERMISSION_REVOKED"\) \}/);
  assert.match(service, /val finalized = closeRecording\(\)/);
  assert.match(service, /if \(outcome == SegmentClose\.DISCARD_WRITE_FAILED\) \{\s*limitations\.add\("SEGMENT_WRITE_FAILED"\)\s*return false\s*\}/);
  // The uri/size/duration are stated only for a finalised file.
  assert.match(ledger, /"recordingUri" to if \(finalized && recordingPath != null\) "file:\/\/\$recordingPath" else null/);
  assert.match(ledger, /"recordingSizeBytes" to if \(finalized\) sizeBytes else null/);
  assert.ok(!/"droppedFrameCount"/.test(ledger + service), "Android claims a dropped-frame count it cannot observe");
  // A process death mid-recording keeps the ledger (unfinalised) until the user decides.
  assert.match(ledger, /l\.layout == LAYOUT_SINGLE_FILE && l\.recordingPath != null && l\.state != LEDGER_FINISHED/);
  // Wire contract B: every key Android returns is declared by the JS binding.
  const fields = ledger.match(/internal fun recordingFieldsToJs\([\s\S]*?\): Map<String, Any\?> = mapOf\(([\s\S]*?)\n\)/)[1];
  const returned = [...fields.matchAll(/"(\w+)" to/g)].map((m) => m[1]);
  const declared = tsTypeKeys(binding, "ScreenContinuousResult");
  for (const k of CONTRACT_B_KEYS) assert.ok(returned.includes(k), `Android recordingFieldsToJs lacks ${k}`);
  for (const k of returned) assert.ok(declared.has(k), `Android returns ${k}, which ScreenContinuousResult does not declare`);
  assert.match(service, /\) \+ recordingFieldsToJs\(/);
});

test("Android frames: an unchanged screen (-1) is a DISTINCT status, not a failure", () => {
  assert.match(frames, /onFrame\?\.invoke\(-1, frames\.size, FRAME_UNCHANGED\)/);
  assert.match(frames, /onFrame\?\.invoke\(-1, frames\.size, FRAME_FAILED\)/);
  assert.match(frames, /onFrame\?\.invoke\(index, frames\.size, FRAME_CAPTURED\)/);
  assert.match(ktModule, /val frame = mapOf\("frameIndex" to i, "frameCount" to n, "status" to status\)/);
  assert.match(ktModule, /"status" to FRAME_STOPPED/);
  assert.match(binding, /export type ScreenFrameStatus = "CAPTURED" \| "UNCHANGED" \| "FAILED" \| "STOPPED";/);
  assert.match(binding, /export type ScreenFrameEvent = \{ frameIndex: number; frameCount: number; status\?: ScreenFrameStatus \};/);
  assert.match(binding, /captureFrame\(\): Promise<ScreenFrameEvent>;/);
});

/* ------------------------------------------------------------ binding --- */

test("JS binding: contract B types are declared, legacy fields kept, no segment events documented for new builds", () => {
  const result = tsTypeKeys(binding, "ScreenContinuousResult");
  for (const k of [...CONTRACT_B_KEYS, "droppedFrameCount", "segmentCount", "totalDurationMs", "limitations", "sessionCompleteness"]) {
    assert.ok(result.has(k), `ScreenContinuousResult lacks ${k}`);
  }
  assert.ok(tsTypeKeys(binding, "ScreenContinuousOptions").has("microphone"));
  assert.match(binding, /export type ScreenContinuousAudioTrack = "APP" \| "MICROPHONE";/);
  assert.match(binding, /export type ScreenContinuousPause = \{ startOffsetMs: number; endOffsetMs: number \};/);
  // Legacy segment surface still exists (older builds, recovered recordings).
  assert.match(binding, /export function addScreenSegmentListener\(/);
  assert.match(binding, /export type ScreenSegment = \{/);
  assert.match(binding, /emit NO `onScreenSegment` events for new recordings/);
});
