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

test("UC-AND-007: a segment whose MediaRecorder.stop() threw is deleted, recorded, and never emitted", () => {
  // The decision lives in CaptureDecisions.kt (JVM-unit-tested by
  // CaptureDecisionsTest.kt); the service must route stop() through it and act
  // on the discard verdict.
  assert.match(decisions, /try \{ stop\(\) \} catch \(_: Throwable\) \{ stopFailed = true \}/);
  assert.match(decisions, /if \(stopFailed\) \{\s*try \{ deleteFile\(\) \}[\s\S]*?return SegmentClose\.DISCARD_WRITE_FAILED/);
  assert.match(continuous, /closeSegment\(\s*stop = \{ r\.stop\(\) \}/);
  assert.match(continuous, /if \(outcome == SegmentClose\.DISCARD_WRITE_FAILED\) \{\s*limitations\.add\("SEGMENT_WRITE_FAILED"\)[\s\S]*?return\s*\}/);
  assert.ok(!/try \{ r\.stop\(\) \} catch \(_: Throwable\) \{\}/.test(continuous), "the swallowed stop() is back");
  // A clean stop over a lost stretch is not COMPLETE.
  assert.match(continuous, /val complete = cleanEnd && limitations\.none \{ it in INCOMPLETE_LIMITATIONS \}/);
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
    assert.match(src, /try \{\s*beginProjection\(\)\s*\} catch \(t: Throwable\) \{\s*failStart\(/, name);
    assert.match(src, /cb\?\.invoke\(code, message\)/, name);
    assert.ok(!/getMediaProjection\(resultCode, data\) \?: return finish\("ERROR"\)/.test(src), `${name}: the hung-start path is back`);
    // Consent / null projection / a throw are decided by obtainProjection
    // (JVM-unit-tested) and every refusal goes to failStart.
    assert.match(src, /obtainProjection\(resultData\) \{ mpm\.getMediaProjection\(resultCode, it\) \}/, name);
    assert.match(src, /is ProjectionOutcome\.Refused -> [\s\S]{0,20}failStart\(outcome\.code, outcome\.message\)/, name);
  }
  assert.match(decisions, /if \(projection == null\) \{\s*ProjectionOutcome\.Refused\(PROJECTION_UNAVAILABLE/);
  assert.equal((module.match(/onStartFailed = \{ code, message -> promise\.reject\(CodedException\(code, message, null\)\) \}/g) ?? []).length, 2);
});

test("UC-AND-004: the recorder's segments are listable and callbacks re-bind to a recreated module", () => {
  assert.match(module, /Function\("getContinuousSegments"\) \{ ContinuousScreenCaptureService\.segmentsSnapshot\(\) \}/);
  assert.match(module, /OnCreate \{ bindContinuousCallbacks\(\) \}/);
  assert.match(module, /AsyncFunction\("discardContinuousSpool"\)/);
  assert.match(continuous, /fun segmentsSnapshot\(\): List<Map<String, Any\?>> = segments\.toList\(\)/);
});
