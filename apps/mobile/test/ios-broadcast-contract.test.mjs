/**
 * UC-5 iOS broadcast — the native CONTRACT, proven without a Mac.
 *
 * Swift cannot compile here, so this file does two things:
 *   1. CONTRACT FIXTURE (executable): the exact result/sidecar maps the Swift
 *      code writes (test/fixtures/ios-broadcast-result.json) go through the REAL
 *      client builder (src/continuous-manifest.ts) and the REAL server validator
 *      (@proovra/shared). The fixture's keys are pinned to the Swift sources, so
 *      the fixture cannot drift from what the device produces.
 *   2. SOURCE STRUCTURE (the only proof possible for native control flow): the
 *      stop handshake, PTS timing, orientation, pause, writer-outcome checks,
 *      honest fallback and observer lifecycle each have a named construct in the
 *      Swift. Device acceptance is still required (externalProofRemaining).
 *
 * RED on the pre-remediation tree: the Swift device map had 4 keys and the
 * validator refused it ("invalid device.screenW"); SampleHandler observed no
 * stop note; the final segment was finalised with `durationMs: 0`.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

import { validateScreenContinuousManifest, SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION } from "@proovra/shared";
import { loadModule } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(HERE, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const fixture = JSON.parse(read("fixtures/ios-broadcast-result.json"));
const handler = stripComments(read("../plugins/broadcast-extension/SampleHandler.swift"));
const shared = stripComments(read("../modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift"));
const module = stripComments(read("../modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift"));
// UC-IOS-012 — the bridge has its own Foundation-only file, so the XCTest package
// (ios-tests/, run by native-build.yml on macOS) compiles exactly what ships.
const darwinNotify = stripComments(read("../modules/proovra-screen-capture/ios/ProovraDarwinNotify.swift"));
const binding = read("../modules/proovra-screen-capture/index.ts");

let C;
before(async () => {
  C = await loadModule("src/continuous-manifest.ts");
});

const SESSION = "11111111-1111-4111-8111-111111111111";
const declaredFrom = (segments) =>
  segments.map((s, i) => ({
    partIndex: s.sequence,
    sequence: s.sequence,
    sha256Hex: String.fromCharCode(97 + i).repeat(64),
    sizeBytes: 1000 + i,
    startedAtOffsetMs: s.startedAtOffsetMs,
    durationMs: s.durationMs,
    widthPx: s.widthPx,
    heightPx: s.heightPx,
    orientation: s.orientation,
  }));

/* ------------------------------------------------ 1. contract fixture ------ */

test("UC-IOS-001: the fixture's result.json keys are exactly the keys SampleHandler writes", () => {
  const block = handler.match(/var result: \[String: Any\] = \[([\s\S]*?)\]\n/);
  assert.ok(block, "SampleHandler.writeResult dictionary not found");
  const written = new Set([...block[1].matchAll(/"(\w+)":/g)].map((m) => m[1]));
  for (const k of ["startedAtUtc", "device"]) {
    assert.match(handler, new RegExp(`result\\["${k}"\\]`), `writeResult no longer writes ${k}`);
    written.add(k);
  }
  assert.deepEqual([...written].sort(), Object.keys(fixture.resultJson).sort());
  const device = handler.match(/private static func displayDevice[\s\S]*?return \[([\s\S]*?)\]/);
  assert.deepEqual(
    [...device[1].matchAll(/"(\w+)":/g)].map((m) => m[1]).sort(),
    Object.keys(fixture.resultJson.device).sort(),
  );
});

test("UC-IOS-001: the fixture's JS result is the key set ProovraBroadcastResult.toJsMap returns — all 8 device keys", () => {
  const toJs = shared.match(/func toJsMap\(\) -> \[String: Any\] \{\s*var device[\s\S]*?\n  \}\n/);
  assert.ok(toJs, "ProovraBroadcastResult.toJsMap not found");
  const deviceKeys = new Set([...toJs[0].matchAll(/"(platform|osVersion|model|appVersion)":/g)].map((m) => m[1]));
  for (const k of ["screenW", "screenH", "densityDpi", "orientation"]) {
    assert.match(toJs[0], new RegExp(`"${k}"`), `toJsMap does not fill device.${k}`);
    deviceKeys.add(k);
  }
  assert.deepEqual([...deviceKeys].sort(), Object.keys(fixture.jsResult.device).sort());
  const returned = toJs[0].match(/return \[([\s\S]*?)\n    \]/);
  assert.ok(returned, "toJsMap's returned dictionary not found");
  const topKeys = [...returned[1].matchAll(/^\s{6}"(\w+)":/gm)].map((m) => m[1]).sort();
  assert.deepEqual(topKeys, Object.keys(fixture.jsResult).sort());
  // The sidecar keys the reader requires are the ones the writer writes.
  const sidecarWriter = handler.match(/let sidecar: \[String: Any\] = \[([\s\S]*?)\]/);
  assert.deepEqual(
    [...sidecarWriter[1].matchAll(/"(\w+)":/g)].map((m) => m[1]).sort(),
    Object.keys(fixture.sidecars[0]).sort(),
  );
});

test("UC-IOS-001 / UC-IOS-004: the exact Swift result builds a manifest the SERVER validator accepts as COMPLETE", () => {
  const manifest = C.buildContinuousManifest(SESSION, fixture.jsResult, declaredFrom(fixture.jsSegments));
  assert.equal(manifest.schemaVersion, SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.recordedSegmentCount, 3);
  assert.equal(manifest.sessionCompleteness, "COMPLETE_SESSION");
  const v = validateScreenContinuousManifest(JSON.parse(JSON.stringify(manifest)), {
    expectedSessionId: SESSION,
    expectedPlatform: "ios",
  });
  assert.equal(v.ok, true, v.error);
});

test("UC-IOS-001: the pre-remediation 4-key Swift device block is refused with the specific error", () => {
  const legacy = { ...fixture.jsResult, device: { ...fixture.legacyV1DeviceBlock } };
  delete legacy.device._comment;
  assert.throws(() => C.buildContinuousManifest(SESSION, legacy, declaredFrom(fixture.jsSegments)), /invalid device\.screenW/);
  for (const [mutate, error] of [
    [(d) => (d.densityDpi = 0), /invalid device\.densityDpi/],
    [(d) => (d.orientation = "upside-down"), /invalid device\.orientation/],
    [(d) => (d.screenW = 4000), /device\.orientation does not match its dimensions/],
  ]) {
    const r = JSON.parse(JSON.stringify(fixture.jsResult));
    mutate(r.device);
    assert.throws(() => C.buildContinuousManifest(SESSION, r, declaredFrom(fixture.jsSegments)), error);
  }
});

test("UC-IOS-004: the old final-segment rule (duration 0, offset = session end) is refused as COMPLETE", () => {
  const broken = declaredFrom(fixture.jsSegments);
  broken[2] = { ...broken[2], startedAtOffsetMs: 16000, durationMs: 0 };
  const m = C.buildContinuousManifest(SESSION, fixture.jsResult, broken);
  assert.equal(validateScreenContinuousManifest(JSON.parse(JSON.stringify(m))).ok, false);
});

test("UC-IOS-006: a missing result is summarised as INTERRUPTED / UNKNOWN and still validates honestly", () => {
  // What readResult() now returns without result.json: the extension's own
  // start time, end = start + last segment end, UNKNOWN, CAPTURE_INTERRUPTED.
  const fallback = {
    ...fixture.jsResult,
    captureEndedAtUtc: "2026-09-30T10:00:16Z",
    sessionCompleteness: "INTERRUPTED_SESSION",
    terminationReason: "UNKNOWN",
    limitations: ["CAPTURE_INTERRUPTED"],
  };
  const m = C.buildContinuousManifest(SESSION, fallback, declaredFrom(fixture.jsSegments));
  assert.equal(m.sessionCompleteness, "INTERRUPTED_SESSION");
  assert.equal(m.terminationReason, "UNKNOWN");
  assert.equal(validateScreenContinuousManifest(JSON.parse(JSON.stringify(m)), { expectedPlatform: "ios" }).ok, true);
});

/* ------------------------------------------------ 2. source structure ------ */

test("UC-IOS-002: the extension OBSERVES a dedicated stop note and ends the broadcast", () => {
  assert.match(handler, /stopRequestNote = "com\.proovra\.screencapture\.ios\.stopRequested"/);
  assert.match(handler, /CFNotificationCenterAddObserver\([\s\S]*?SampleHandler\.stopRequestNote as CFString/);
  assert.match(handler, /func stopRequestedByApp\(\)[\s\S]*?finalizeSegment\(endPts: lastPts\)[\s\S]*?writeResult\(reason: "USER_STOPPED"\)[\s\S]*?finish\(message:/);
  assert.match(handler, /finishBroadcastWithError\(error\)/);
  assert.match(handler, /CFNotificationCenterRemoveObserver\(/);
  // The app posts THAT note (not the `finished` note it observes itself) and waits for the result.
  assert.match(module, /ProovraDarwinNotify\.post\(ProovraBroadcastNotes\.stopRequested\)/);
  assert.ok(!/ProovraDarwinNotify\.post\(ProovraBroadcastNotes\.finished\)/.test(module), "the app still posts the note it observes");
  assert.match(module, /readWrittenResult\(recordingId: id\) == nil && Date\(\) < deadline/);
  // Both sides agree on every note name.
  for (const [key, name] of Object.entries({
    segmentReady: "com.proovra.screencapture.ios.segmentReady",
    started: "com.proovra.screencapture.ios.started",
    finished: "com.proovra.screencapture.ios.finished",
    stopRequested: "com.proovra.screencapture.ios.stopRequested",
  })) {
    assert.match(shared, new RegExp(`static let ${key} = "${name.replace(/\./g, "\\.")}"`), key);
    assert.ok(handler.includes(`"${name}"`), `SampleHandler lacks ${name}`);
  }
});

test("UC-IOS-004: one PTS clock; a segment ends where the next begins; the final one is measured", () => {
  assert.ok(!/durationMs:\s*0/.test(handler), "a literal zero duration is back");
  assert.ok(!/Date\(\)\.timeIntervalSince\(sessionStart/.test(handler), "offsets mix the wall clock again");
  assert.match(handler, /let durationMs = max\(0, SampleHandler\.ms\(CMTimeSubtract\(end, startPts\)\)\)/);
  assert.match(handler, /let offsetMs = max\(0, SampleHandler\.ms\(CMTimeSubtract\(startPts, sessionFirstPts\)\)\)/);
  assert.match(handler, /finalizeSegment\(endPts: pts\)/, "rotation must end the segment at the next frame's PTS");
});

test("UC-IOS-007: writer outcomes are checked and only a completed segment is published", () => {
  assert.match(handler, /guard w\.startWriting\(\) else/);
  assert.match(handler, /if !input\.append\(sampleBuffer\)/);
  assert.match(handler, /guard waited == \.success, writer\.status == \.completed else/);
  assert.match(handler, /limitations\.insert\("SEGMENT_WRITE_FAILED"\)/);
  assert.match(handler, /volumeAvailableCapacityForImportantUsage/);
});

test("UC-IOS-008 / UC-IOS-009: orientation from RPVideoSampleOrientationKey; pauses end a segment and are recorded", () => {
  assert.match(handler, /CMGetAttachment\(sampleBuffer, key: RPVideoSampleOrientationKey as CFString/);
  assert.match(handler, /input\.transform = SampleHandler\.transform\(for: orientation\)/);
  assert.match(handler, /limitations\.insert\("ORIENTATION_CHANGED_DURING_CAPTURE"\)/);
  assert.match(handler, /override func broadcastPaused\(\)[\s\S]*?limitations\.insert\("BROADCAST_PAUSED"\)[\s\S]*?finalizeSegment/);
  assert.match(handler, /override func broadcastResumed\(\)/);
});

test("UC-IOS-005 / UC-IOS-006 / UC-IOS-010 / UC-IOS-012 / UC-AND-014 — app-side lifecycle", () => {
  // 005: presenting the picker is not a start; the extension's note is.
  assert.match(module, /"awaitingSystemStart": true/);
  assert.match(module, /"osConsentGranted": false/);
  assert.match(module, /sendEvent\("onScreenContinuousStarted"/);
  assert.match(handler, /SampleHandler\.postDarwin\(SampleHandler\.startedNote\)/);
  assert.match(binding, /addListener\("onScreenContinuousStarted"/);
  // 006: no fabricated fallback — no `now` start, UNKNOWN termination, staleness.
  assert.ok(!/startedAtUtc: now/.test(shared), "the fallback fabricates a start time again");
  assert.match(shared, /terminationReason: "UNKNOWN"/);
  assert.match(shared, /staleAfterSeconds/);
  // 010: the spool is never wiped over a pending recording; discard is explicit.
  assert.match(module, /hasPendingRecording\(\)[\s\S]*?PENDING_RECORDING/);
  assert.match(module, /AsyncFunction\("discardContinuousSpool"\)/);
  assert.match(module, /Function\("getContinuousSegments"\)/);
  // 012: one stable observer token, drained on one queue.
  assert.ok(!/passUnretained\(NSObject\(\)\)/.test(darwinNotify + shared), "a throw-away observer identity is back");
  assert.ok(!/class ProovraDarwinNotify/.test(shared), "the bridge is duplicated back into the UIKit file");
  assert.match(darwinNotify, /^import Foundation\s*final class ProovraDarwinNotify/);
  assert.match(darwinNotify, /CFNotificationCenterRemoveEveryObserver\(CFNotificationCenterGetDarwinNotifyCenter\(\), token\)/);
  assert.match(module, /drainQueue\.sync/);
  // AND-014: the frame stop carries the binding's name on iOS too.
  assert.match(module, /AsyncFunction\("stopCapture"\)/);
  assert.ok(!/AsyncFunction\("stop"\)/.test(module));
});

/* ------------------------------------- 3. AUD-006 — one namespace per broadcast */

const spoolSrc = read("../modules/proovra-screen-capture/ios/ProovraBroadcastSpool.swift");
const spool = stripComments(spoolSrc);
const plugin = require_("../plugins/withProovraIosScreenBroadcast.cjs");
const workflow = read("../../../.github/workflows/native-build.yml");
const packageSwift = read("../modules/proovra-screen-capture/ios-tests/Package.swift");
const xctests = read("../modules/proovra-screen-capture/ios-tests/Tests/ProovraBroadcastSpoolTests/ProovraBroadcastSpoolTests.swift");

function require_(rel) {
  return createRequire(import.meta.url)(resolve(HERE, rel));
}

test("AUD-006: the spool is ONE Foundation-only file compiled by the app, the extension and the XCTest package", () => {
  assert.match(spool, /^import Foundation\s*enum ProovraBroadcastBindingState/, "the spool must import Foundation only");
  assert.ok(!/import (UIKit|ReplayKit|AVFoundation)/.test(spool));
  // The extension compiles the SAME file (no by-value copy of the layout).
  assert.deepEqual(plugin.SHARED_FILES, ["ProovraBroadcastSpool.swift"]);
  assert.ok(plugin.EXT_SOURCES.includes("SampleHandler.swift") && plugin.EXT_SOURCES.includes("ProovraBroadcastSpool.swift"));
  assert.ok(!/"uc5-broadcast"/.test(handler), "the extension hard-codes the spool root again");
  assert.ok(!/"seg-\(/.test(handler), "the extension names segment files itself again");
  assert.match(handler, /ProovraBroadcastSpool\.rootURL\(inContainer: container\)/);
  assert.match(shared, /ProovraBroadcastSpool\.rootURL\(inContainer: container\)/);
  // The XCTest package compiles the shipped file and CI demands every test ran.
  assert.match(workflow, /cp \.\.\/ios\/ProovraBroadcastSpool\.swift Sources\/BroadcastSpool\//);
  assert.match(packageSwift, /\.target\(name: "BroadcastSpool", path: "Sources\/BroadcastSpool"\)/);
  assert.match(packageSwift, /name: "ProovraBroadcastSpoolTests",\s*dependencies: \["BroadcastSpool"\]/);
  const declared = [...xctests.matchAll(/^\s*func (test\w+)\(/gm)].length;
  const darwin = [...read("../modules/proovra-screen-capture/ios-tests/Tests/ProovraDarwinNotifyTests/ProovraDarwinNotifyTests.swift").matchAll(/^\s*func (test\w+)\(/gm)].length;
  const min = Number(workflow.match(/"\$\{executed:-0\}" -lt (\d+)/)?.[1]);
  assert.equal(min, declared + darwin, "the executed-count floor must equal every declared XCTest");
  for (const scenario of ["TwoBroadcasts", "StaleAppGroupContent", "Restart", "Interrupted", "Recovery", "Idempotent", "ControlCenter"]) {
    assert.match(xctests, new RegExp(`func test\\w*${scenario}`), `no XCTest for ${scenario}`);
  }
});

test("AUD-006: the extension opens a NEW namespace per broadcast and never overwrites a segment or a result", () => {
  assert.match(handler, /spool\.openRecording\(\s*nowUptime: ProcessInfo\.processInfo\.systemUptime/);
  assert.match(handler, /sequence = spool\.nextSequence\(recording\.recordingId\)/);
  // No delete-then-write of a segment slot: a taken slot is refused before the writer opens it.
  assert.ok(!/removeItem\(at: url\)\s*guard let w = try\? AVAssetWriter/.test(handler), "the extension deletes an existing segment before writing again");
  assert.match(handler, /guard spool\.isSegmentSlotFree\(recordingId, sequence: sequence\) else \{\s*failWriter\(\)[\s\S]*?AVAssetWriter\(outputURL: url/);
  assert.match(handler, /guard spool\.publishSegment\(recordingId, sequence: seq, sidecar: sidecar\) else/);
  assert.match(handler, /spool\.finalize\(recordingId, result: result\)/);
  assert.ok(!/"result\.json"|"state\.json"/.test(handler), "the extension writes fixed-name files again");
  // The spool's publish/finalise are exclusive (first writer wins), and adoption is one atomic rename.
  assert.match(spool, /func writeExclusively[\s\S]*?guard !fm\.fileExists\(atPath: url\.path\)[\s\S]*?fm\.moveItem\(at: tmp, to: url\)/);
  assert.match(spool, /fm\.moveItem\(at: pending, to: claim\)/);
  assert.match(spool, /createDirectory\(at: dir, withIntermediateDirectories: false\)/);
});

test("AUD-006: liveness is a monotonic heartbeat, not the wall clock", () => {
  assert.match(handler, /"heartbeatUptime": ProcessInfo\.processInfo\.systemUptime/);
  assert.match(handler, /"heartbeatSeq": heartbeatSeq/);
  assert.ok(!/lastWriteAtUtc/.test(handler + shared), "the wall-clock heartbeat is back");
  assert.ok(!/Date\(\)\.timeIntervalSince\(last\)/.test(shared), "staleness compares wall-clock times again");
  assert.match(shared, /ProcessInfo\.processInfo\.systemUptime/);
  assert.match(spool, /if age < 0 \|\| age > staleAfterSeconds \{ return \(false, true\) \}/);
});

test("AUD-006: the binding is written before the picker and is fresh exactly as long as the JS waits for it", () => {
  assert.match(module, /self\.store\.prepareRecording\([\s\S]*?ProovraBroadcastPicker\.present\(/);
  assert.match(module, /"recordingId": recordingId,\s*\]\)/, "start must return the bound recordingId");
  const fresh = Number(spool.match(/static let bindingFreshSeconds: TimeInterval = (\d+)/)?.[1]);
  const jsTimeout = Number(read("../src/continuous-capture.ts").match(/BROADCAST_START_TIMEOUT_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
  assert.equal(fresh * 1000, jsTimeout, "binding freshness and the JS picker timeout drifted apart");
  // A cancelled / timed-out picker withdraws the binding.
  assert.match(module, /withdrawPendingBinding\(recordingId: id\)/);
});

test("AUD-006: every app-side read, stop and discard is scoped by recordingId; state exposes the binding", () => {
  assert.match(module, /Function\("getContinuousState"\) \{ \(recordingId: String\?\)/);
  assert.match(module, /Function\("getContinuousSegments"\) \{ \(recordingId: String\?\)/);
  assert.match(module, /AsyncFunction\("stopContinuousCapture"\) \{ \(recordingId: String\?, promise: Promise\)/);
  assert.match(module, /AsyncFunction\("discardContinuousSpool"\) \{ \(recordingId: String\?, promise: Promise\)/);
  assert.match(module, /Function\("listContinuousRecordings"\)/);
  assert.match(module, /AsyncFunction\("bindContinuousSession"\)/);
  // The stop note reaches whichever broadcast runs: only posted for THIS recording.
  assert.match(module, /if self\.store\.liveRecordingId\(\) == id \{\s*ProovraDarwinNotify\.post\(ProovraBroadcastNotes\.stopRequested\)/);
  const stateMap = shared.match(/struct ProovraBroadcastState \{[\s\S]*?func toJsMap\(\) -> \[String: Any\] \{\s*return \[([\s\S]*?)\]/);
  assert.ok(stateMap, "ProovraBroadcastState.toJsMap not found");
  const keys = [...stateMap[1].matchAll(/"(\w+)":/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ["active", "appRequested", "binding", "captureSessionId", "liveRecordingId", "recordingId", "segmentCount", "stale"]);
  // The started event names the recording and its binding.
  assert.match(module, /sendEvent\("onScreenContinuousStarted", \[[\s\S]*?"recordingId": recordingId,[\s\S]*?"binding": state\.binding/);
  // The JS binding passes the recordingId on iOS only (the Kotlin functions take none).
  assert.match(binding, /if \(Platform\.OS === "ios"\) return continuousModule\(\)\.stopContinuousCapture\(recordingId \?\? null\);\s*return continuousModule\(\)\.stopContinuousCapture\(\);/);
  assert.match(binding, /export function listContinuousRecordings\(\)[\s\S]*?if \(Platform\.OS !== "ios"\) return \[\];/);
  // ONE JS bind over both natives: off iOS it never reaches the Swift bind, and
  // on iOS it names the recording (no recordingId: nothing is bound).
  assert.match(
    binding,
    /export async function bindContinuousSession\([\s\S]*?recordingId\?: string \| null;[\s\S]*?if \(Platform\.OS !== "ios"\) return false;\s*if \(!o\.recordingId\) return false;\s*await iosBroadcastModule\(\)\.bindContinuousSession\(o\.recordingId, o\.captureSessionId\);/,
  );
});
