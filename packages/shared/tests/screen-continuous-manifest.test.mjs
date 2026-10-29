import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateScreenContinuousManifest,
  SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
  SCREEN_CONTINUOUS_MANIFEST_BOUNDS,
} from "../dist/screen-continuous-manifest.js";

function segment(over = {}) {
  return {
    role: "screen_segment",
    partIndex: 0,
    sequence: 0,
    expectedSha256: "a".repeat(64),
    sizeBytes: 2048,
    mediaType: "video/mp4",
    startedAtOffsetMs: 0,
    durationMs: 6000,
    widthPx: 1080,
    heightPx: 2400,
    orientation: "portrait",
    ...over,
  };
}

function baseManifest(over = {}) {
  return {
    schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
    captureEndedAtUtc: "2026-09-17T10:00:12.000Z",
    device: {
      platform: "android",
      osVersion: "14",
      model: "Pixel 7",
      appVersion: "1.0.0",
      screenW: 1080,
      screenH: 2400,
      densityDpi: 420,
      orientation: "portrait",
    },
    osConsentGranted: true,
    totalDurationMs: 12000,
    segments: [
      segment({ partIndex: 0, sequence: 0, startedAtOffsetMs: 0 }),
      segment({ partIndex: 1, sequence: 1, startedAtOffsetMs: 6000, expectedSha256: "b".repeat(64) }),
    ],
    sessionCompleteness: "COMPLETE_SESSION",
    terminationReason: "USER_STOPPED",
    limitations: [],
    notes: [],
    ...over,
  };
}

// V2 (UC-STR-002): the recorder's own segment count is part of the contract.
// Unless a case sets it, it is what the listed segments imply.
function goodManifest(over = {}) {
  const m = baseManifest(over);
  if (!("recordedSegmentCount" in over)) {
    m.recordedSegmentCount = Math.max(-1, ...m.segments.map((s) => s.sequence)) + 1;
  }
  return m;
}

test("accepts a well-formed continuous manifest", () => {
  assert.equal(validateScreenContinuousManifest(goodManifest()).ok, true);
});

test("binds to the expected session id", () => {
  const m = goodManifest();
  assert.equal(validateScreenContinuousManifest(m, { expectedSessionId: m.captureSessionId }).ok, true);
  assert.equal(
    validateScreenContinuousManifest(m, { expectedSessionId: "22222222-2222-4222-8222-222222222222" }).ok,
    false,
  );
});

test("rejects an unknown schema version", () => {
  assert.equal(validateScreenContinuousManifest(goodManifest({ schemaVersion: "OTHER" })).ok, false);
});

test("ACCEPTS ios — the same manifest describes an Apple system broadcast", () => {
  // This case asserted the opposite, and the assertion was the defect. UC-5
  // seals through this very pipeline (continuous-capture.service.ts admits
  // DIRECT_SCREEN_CAPTURE_IOS by name), so refusing the platform the iOS
  // broadcast extension honestly reports — "ios",
  // ProovraBroadcastShared.swift:59 — meant no iOS session could be sealed at
  // all. The only way past it was for an iOS app to call itself Android,
  // which is a false statement about the device on a provenance record.
  const m = goodManifest();
  m.device = { ...m.device, platform: "ios" };
  assert.equal(validateScreenContinuousManifest(m).ok, true);
});

test("rejects any OTHER platform — widening is not abolishing", () => {
  for (const platform of ["ios_pro", "windows", "", null, 7]) {
    const m = goodManifest();
    m.device = { ...m.device, platform };
    assert.equal(validateScreenContinuousManifest(m).ok, false, String(platform));
  }
});

test("rejects a bad segment digest", () => {
  const m = goodManifest();
  m.segments[0].expectedSha256 = "not-a-hash";
  assert.equal(validateScreenContinuousManifest(m).ok, false);
});

test("CONTINUITY: rejects a non-contiguous sequence (a missing segment cannot pass as continuous)", () => {
  const gap = goodManifest({
    segments: [
      segment({ partIndex: 0, sequence: 0 }),
      // V2: a segment sits at the part index of its sequence, so the gap is a real missing part 1.
      segment({ partIndex: 2, sequence: 2, expectedSha256: "b".repeat(64) }),
    ],
  });
  const r = validateScreenContinuousManifest(gap);
  assert.equal(r.ok, false);
  assert.match(r.error, /contiguous/);
});

test("rejects a duplicate partIndex and a duplicate sequence", () => {
  const dupPart = goodManifest({
    segments: [
      segment({ partIndex: 0, sequence: 0 }),
      segment({ partIndex: 0, sequence: 1, expectedSha256: "b".repeat(64) }),
    ],
  });
  assert.equal(validateScreenContinuousManifest(dupPart).ok, false);
});

test("out-of-order segments are safe as long as the set is contiguous 0..N-1", () => {
  const shuffled = goodManifest({
    segments: [
      segment({ partIndex: 1, sequence: 1, startedAtOffsetMs: 6000, expectedSha256: "b".repeat(64) }),
      segment({ partIndex: 0, sequence: 0, startedAtOffsetMs: 0 }),
    ],
  });
  assert.equal(validateScreenContinuousManifest(shuffled).ok, true);
});

test("rejects an empty and an oversized segment set", () => {
  assert.equal(validateScreenContinuousManifest(goodManifest({ segments: [] })).ok, false);
  const many = Array.from({ length: SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxSegments + 1 }, (_, i) =>
    segment({ partIndex: i, sequence: i, startedAtOffsetMs: i * 6000 }),
  );
  assert.equal(validateScreenContinuousManifest(goodManifest({ segments: many })).ok, false);
});

const landscape = (over = {}) =>
  segment({ widthPx: 2400, heightPx: 1080, orientation: "landscape", ...over });

test("accepts a portrait-only and a landscape-only session", () => {
  assert.equal(validateScreenContinuousManifest(goodManifest()).ok, true); // portrait-only
  assert.equal(
    validateScreenContinuousManifest(
      goodManifest({
        device: {
          platform: "android", osVersion: "14", model: "Pixel 7", appVersion: "1.0.0",
          screenW: 2400, screenH: 1080, densityDpi: 420, orientation: "landscape",
        },
        segments: [
          landscape({ partIndex: 0, sequence: 0 }),
          landscape({ partIndex: 1, sequence: 1, startedAtOffsetMs: 6000, expectedSha256: "b".repeat(64) }),
        ],
      }),
    ).ok,
    true,
  );
});

test("rejects a segment whose orientation disagrees with its dimensions", () => {
  const bad = goodManifest({ segments: [segment({ partIndex: 0, sequence: 0, orientation: "landscape" })] }); // portrait dims
  const r = validateScreenContinuousManifest(bad);
  assert.equal(r.ok, false);
  assert.match(r.error, /orientation does not match/);
});

test("ORIENTATION TRANSITION: portrait->landscape must be recorded in limitations", () => {
  const segs = [
    segment({ partIndex: 0, sequence: 0 }),
    landscape({ partIndex: 1, sequence: 1, startedAtOffsetMs: 6000, expectedSha256: "b".repeat(64) }),
  ];
  // Without the flag → rejected (silent transition).
  const noFlag = validateScreenContinuousManifest(goodManifest({ segments: segs }));
  assert.equal(noFlag.ok, false);
  assert.match(noFlag.error, /orientation transition/);
  // With the flag → accepted, ONE manifest, transition recorded.
  const flagged = validateScreenContinuousManifest(
    goodManifest({ segments: segs, limitations: ["ORIENTATION_CHANGED_DURING_CAPTURE"] }),
  );
  assert.equal(flagged.ok, true);
});

test("ORIENTATION TRANSITION: multiple transitions still validate with the flag", () => {
  const segs = [
    segment({ partIndex: 0, sequence: 0 }),
    landscape({ partIndex: 1, sequence: 1, startedAtOffsetMs: 6000, expectedSha256: "b".repeat(64) }),
    segment({ partIndex: 2, sequence: 2, startedAtOffsetMs: 12000, expectedSha256: "c".repeat(64) }),
  ];
  assert.equal(
    validateScreenContinuousManifest(
      // Three 6 s segments span 18 s (ET-DC-09: a complete session's segments
      // lie inside its stated window).
      goodManifest({
        segments: segs,
        limitations: ["ORIENTATION_CHANGED_DURING_CAPTURE"],
        captureEndedAtUtc: "2026-09-17T10:00:18.000Z",
        totalDurationMs: 18000,
      }),
    ).ok,
    true,
  );
});

test("accepts INTERRUPTED_SESSION; rejects unknown completeness / termination / limitation", () => {
  assert.equal(
    validateScreenContinuousManifest(
      goodManifest({ sessionCompleteness: "INTERRUPTED_SESSION", terminationReason: "PERMISSION_REVOKED" }),
    ).ok,
    true,
  );
  assert.equal(validateScreenContinuousManifest(goodManifest({ sessionCompleteness: "NONSENSE" })).ok, false);
  assert.equal(validateScreenContinuousManifest(goodManifest({ terminationReason: "NONSENSE" })).ok, false);
  assert.equal(validateScreenContinuousManifest(goodManifest({ limitations: ["NONSENSE"] })).ok, false);
});

// ---- ET-DC-09 — continuity is checked, not taken on the client's word -------
const invalid = (m, opts) => {
  const v = validateScreenContinuousManifest(m, opts);
  assert.equal(v.ok, false, "must be refused");
  return v.error;
};

test("ET-DC-09: a COMPLETE session with an undeclared gap between segments is refused", () => {
  const m = goodManifest({
    captureEndedAtUtc: "2026-09-17T10:00:30.000Z",
    totalDurationMs: 30000,
    segments: [
      segment({ partIndex: 0, sequence: 0, startedAtOffsetMs: 0 }),
      segment({ partIndex: 1, sequence: 1, startedAtOffsetMs: 20000, expectedSha256: "b".repeat(64) }),
    ],
  });
  assert.match(invalid(m), /gap/);
  // The same recording, honestly labelled INTERRUPTED, is accepted.
  assert.equal(
    validateScreenContinuousManifest({ ...m, sessionCompleteness: "INTERRUPTED_SESSION", terminationReason: "INTERRUPTED" }).ok,
    true,
  );
});

test("ET-DC-09: a COMPLETE session cannot have ended by interruption", () => {
  assert.match(invalid(goodManifest({ terminationReason: "PERMISSION_REVOKED" })), /interruption/);
});

test("ET-DC-09: segments outside the stated window, and a duration longer than it, are refused", () => {
  assert.match(invalid(goodManifest({ totalDurationMs: 60000 })), /totalDurationMs/);
  assert.match(invalid(goodManifest({ captureEndedAtUtc: "2026-09-17T10:00:03.000Z", totalDurationMs: 3000 })), /outside the capture window/);
  assert.match(invalid(goodManifest({ captureEndedAtUtc: "2026-09-17T09:59:00.000Z" })), /precedes/);
});

test("ET-DC-09: overlapping segments are refused", () => {
  const m = goodManifest({
    segments: [
      segment({ partIndex: 0, sequence: 0, startedAtOffsetMs: 0 }),
      segment({ partIndex: 1, sequence: 1, startedAtOffsetMs: 3000, expectedSha256: "b".repeat(64) }),
    ],
  });
  assert.match(invalid(m), /overlap/);
});

test("ET-DC-09: the platform must match the session's mode, and the window the server session", () => {
  assert.match(invalid(goodManifest(), { expectedPlatform: "ios" }), /platform/);
  const opened = Date.parse("2026-09-17T11:00:00.000Z");
  assert.match(invalid(goodManifest(), { sessionWindow: { openedAtMs: opened, nowMs: opened + 60_000 } }), /outside the server session/);
  const ok = validateScreenContinuousManifest(goodManifest(), {
    expectedPlatform: "android",
    sessionWindow: { openedAtMs: Date.parse("2026-09-17T09:59:50.000Z"), nowMs: Date.parse("2026-09-17T10:01:00.000Z") },
  });
  assert.equal(ok.ok, true);
});

test("ET-DC-09: the iOS interrupted fallback (no window recorded) is still accepted as INTERRUPTED", () => {
  const m = goodManifest({
    device: { ...goodManifest().device, platform: "ios" },
    captureStartedAtUtc: "2026-09-17T10:00:12.000Z",
    captureEndedAtUtc: "2026-09-17T10:00:12.000Z",
    totalDurationMs: 0,
    sessionCompleteness: "INTERRUPTED_SESSION",
    terminationReason: "INTERRUPTED",
  });
  assert.equal(validateScreenContinuousManifest(m, { expectedPlatform: "ios" }).ok, true);
});

test("ET-DC-09: a sealed session's completeness is read from its end reason, not its status alone", async () => {
  const { captureSessionAcquisitionComplete, continuousEndReasonFor } = await import("../dist/screen-continuous-manifest.js");
  assert.equal(captureSessionAcquisitionComplete(null), true);
  assert.equal(captureSessionAcquisitionComplete({ status: "INTERRUPTED", endReason: null }), false);
  assert.equal(captureSessionAcquisitionComplete({ status: "BOUND", endReason: continuousEndReasonFor("INTERRUPTED_SESSION") }), false);
  assert.equal(captureSessionAcquisitionComplete({ status: "BOUND", endReason: continuousEndReasonFor("COMPLETE_SESSION") }), true);
});

// ---------------------------------------------------------------------------
// UC-4 — segment start offsets for the derived keyframe session timeline.
// ---------------------------------------------------------------------------
import { continuousSegmentStartOffsets } from "../dist/screen-continuous-manifest.js";

test("continuousSegmentStartOffsets maps partIndex → startedAtOffsetMs from a V2 manifest", () => {
  const m = {
    schemaVersion: "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V2",
    segments: [
      { partIndex: 0, startedAtOffsetMs: 0 },
      { partIndex: 1, startedAtOffsetMs: 30250 },
    ],
  };
  assert.deepEqual([...continuousSegmentStartOffsets(m)], [[0, 0], [1, 30250]]);
});

test("continuousSegmentStartOffsets refuses anything it cannot trust (never a guessed offset)", () => {
  assert.equal(continuousSegmentStartOffsets(null), null);
  assert.equal(continuousSegmentStartOffsets({ schemaVersion: "OTHER", segments: [] }), null);
  const v2 = (segments) => ({ schemaVersion: "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V2", segments });
  assert.equal(continuousSegmentStartOffsets(v2([])), null);
  assert.equal(continuousSegmentStartOffsets(v2([{ partIndex: 0, startedAtOffsetMs: -5 }])), null);
  assert.equal(continuousSegmentStartOffsets(v2([{ partIndex: 0, startedAtOffsetMs: 1.5 }])), null);
  assert.equal(
    continuousSegmentStartOffsets(v2([{ partIndex: 0, startedAtOffsetMs: 0 }, { partIndex: 0, startedAtOffsetMs: 10 }])),
    null,
  );
});

// ---------------------------------------------------------------------------
// Contract A (2026-10-29) — SINGLE_FILE: ONE Start→Stop recording = ONE file.
// Legacy SEGMENTED manifests (no recordingLayout) are covered by every case above.
// ---------------------------------------------------------------------------
import {
  continuousRecordingFacts,
  continuousCaptureManifestFactsWithRecording,
  readContinuousRecordingFacts,
  continuousRecordingLayoutOf,
} from "../dist/screen-continuous-manifest.js";
import { CAPTURE_LIMITS } from "../dist/capture-limits.js";
import { continuousRecordingAcquisitionText } from "../dist/evidence-acquisition.js";

function singleFile(over = {}, recOver = {}) {
  return goodManifest({
    recordingLayout: "SINGLE_FILE",
    captureEndedAtUtc: "2026-09-17T10:02:00.000Z",
    totalDurationMs: 120000,
    recordedSegmentCount: 1,
    segments: [
      segment({
        role: "screen_recording",
        sizeBytes: 300 * 1024 * 1024, // above the per-segment bound, inside the session bound
        durationMs: 120000,
        ...recOver,
      }),
    ],
    audioTracks: ["APP", "MICROPHONE"],
    droppedFrameCount: 0,
    pauses: [],
    orientationTimeline: [{ atOffsetMs: 0, orientation: "portrait", widthPx: 1080, heightPx: 2400 }],
    ...over,
  });
}

test("SINGLE_FILE: a complete one-file recording validates, bounded by the SESSION bounds", () => {
  const r = validateScreenContinuousManifest(singleFile());
  assert.equal(r.ok, true, r.error);
  assert.equal(continuousRecordingLayoutOf(r.manifest), "SINGLE_FILE");
  assert.equal(continuousRecordingLayoutOf(goodManifest()), "SEGMENTED");
});

test("SINGLE_FILE: oversize (bytes or duration past the session bound) is refused", () => {
  const big = validateScreenContinuousManifest(singleFile({}, { sizeBytes: CAPTURE_LIMITS.maxContinuousSessionBytes + 1 }));
  assert.equal(big.ok, false);
  assert.match(big.error, /session byte bound/);
  const long = CAPTURE_LIMITS.maxContinuousSessionMs + 60_000;
  const tooLong = validateScreenContinuousManifest(
    singleFile(
      { totalDurationMs: long, captureEndedAtUtc: new Date(Date.parse("2026-09-17T10:00:00.000Z") + long).toISOString() },
      { durationMs: long },
    ),
  );
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /session duration bound/);
});

test("SINGLE_FILE: exactly one screen_recording at part 0 / sequence 0, recordedSegmentCount 1", () => {
  const two = singleFile({
    recordedSegmentCount: 2,
    segments: [
      segment({ role: "screen_recording", durationMs: 60000 }),
      segment({
        role: "screen_recording",
        partIndex: 1,
        sequence: 1,
        startedAtOffsetMs: 60000,
        durationMs: 60000,
        expectedSha256: "b".repeat(64),
      }),
    ],
  });
  assert.equal(validateScreenContinuousManifest(two).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({}, { role: "screen_segment" })).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({}, { partIndex: 1, sequence: 1 })).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({ recordedSegmentCount: 3 })).ok, false);
  // A segmented (legacy) manifest may not carry the single-file role.
  const legacy = goodManifest();
  legacy.segments[0].role = "screen_recording";
  assert.equal(validateScreenContinuousManifest(legacy).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({ recordingLayout: "CHUNKED" })).ok, false);
});

test("SINGLE_FILE: pauses must lie within the duration and be named BROADCAST_PAUSED (never COMPLETE)", () => {
  const paused = {
    pauses: [{ startOffsetMs: 10000, endOffsetMs: 20000 }],
    sessionCompleteness: "INTERRUPTED_SESSION",
    limitations: ["BROADCAST_PAUSED"],
  };
  assert.equal(validateScreenContinuousManifest(singleFile(paused)).ok, true);
  assert.equal(validateScreenContinuousManifest(singleFile({ ...paused, limitations: [] })).ok, false);
  const bad = (pauses) => validateScreenContinuousManifest(singleFile({ ...paused, pauses })).ok;
  assert.equal(bad([{ startOffsetMs: 110000, endOffsetMs: 200000 }]), false);
  assert.equal(bad([{ startOffsetMs: 20000, endOffsetMs: 10000 }]), false);
  assert.equal(bad([{ startOffsetMs: 10000, endOffsetMs: 30000 }, { startOffsetMs: 20000, endOffsetMs: 40000 }]), false);
  // A pause is an unrecorded stretch: a COMPLETE claim over it is refused.
  assert.equal(validateScreenContinuousManifest(singleFile({ ...paused, sessionCompleteness: "COMPLETE_SESSION" })).ok, false);
});

test("SINGLE_FILE: orientation changes are allowed in ONE file, but must be named", () => {
  const timeline = [
    { atOffsetMs: 0, orientation: "portrait" },
    { atOffsetMs: 40000, orientation: "landscape", widthPx: 2400, heightPx: 1080 },
  ];
  const named = ["ORIENTATION_CHANGED_DURING_CAPTURE"];
  assert.equal(validateScreenContinuousManifest(singleFile({ orientationTimeline: timeline, limitations: named })).ok, true);
  assert.equal(validateScreenContinuousManifest(singleFile({ orientationTimeline: timeline })).ok, false);
  // The timeline starts with the recording's initial orientation, ascending, inside the recording.
  assert.equal(
    validateScreenContinuousManifest(singleFile({ orientationTimeline: [{ atOffsetMs: 0, orientation: "landscape" }] })).ok,
    false,
  );
  assert.equal(
    validateScreenContinuousManifest(singleFile({ orientationTimeline: [timeline[1], timeline[0]], limitations: named })).ok,
    false,
  );
  assert.equal(
    validateScreenContinuousManifest(
      singleFile({ orientationTimeline: [timeline[0], { atOffsetMs: 900000, orientation: "landscape" }], limitations: named }),
    ).ok,
    false,
  );
  // The encoded canvas need not match the initial orientation (rotation lives in the timeline).
  assert.equal(validateScreenContinuousManifest(singleFile({}, { widthPx: 2400, heightPx: 1080 })).ok, true);
});

test("SINGLE_FILE: audio tracks — silent needs AUDIO_NOT_CAPTURED; a written track contradicts it", () => {
  assert.equal(validateScreenContinuousManifest(singleFile({ audioTracks: [], limitations: ["AUDIO_NOT_CAPTURED"] })).ok, true);
  assert.equal(validateScreenContinuousManifest(singleFile({ audioTracks: [] })).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({ limitations: ["AUDIO_NOT_CAPTURED"] })).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({ audioTracks: ["SPEAKER"] })).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({ audioTracks: ["APP", "APP"] })).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({ audioTracks: ["MICROPHONE"] })).ok, true);
});

test("SINGLE_FILE: dropped frames are counted and named FRAMES_DROPPED", () => {
  assert.equal(validateScreenContinuousManifest(singleFile({ droppedFrameCount: 7, limitations: ["FRAMES_DROPPED"] })).ok, true);
  assert.equal(validateScreenContinuousManifest(singleFile({ droppedFrameCount: 7 })).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({ droppedFrameCount: 0, limitations: ["FRAMES_DROPPED"] })).ok, false);
  assert.equal(validateScreenContinuousManifest(singleFile({ droppedFrameCount: -1 })).ok, false);
});

test("SINGLE_FILE: COMPLETE only when finalized cleanly; an unfinished file is an honest INTERRUPTED session", () => {
  assert.equal(validateScreenContinuousManifest(singleFile({}, { sizeBytes: 0 })).ok, false);
  assert.equal(
    validateScreenContinuousManifest(singleFile({ terminationReason: "INTERRUPTED", limitations: ["CAPTURE_INTERRUPTED"] })).ok,
    false,
  );
  assert.equal(validateScreenContinuousManifest(singleFile({ limitations: ["SEGMENT_WRITE_FAILED"] })).ok, false);
  const interrupted = singleFile(
    {
      sessionCompleteness: "INTERRUPTED_SESSION",
      terminationReason: "UNKNOWN",
      limitations: ["CAPTURE_INTERRUPTED", "SEGMENT_WRITE_FAILED"],
    },
    { durationMs: 50000 },
  );
  assert.equal(validateScreenContinuousManifest(interrupted).ok, true);
  // A file is whole or not: SEGMENT_UPLOAD_LOST has no meaning for it.
  assert.equal(
    validateScreenContinuousManifest(singleFile({ sessionCompleteness: "INTERRUPTED_SESSION", limitations: ["SEGMENT_UPLOAD_LOST"] })).ok,
    false,
  );
});

test("SINGLE_FILE: start offsets keep working (part 0 at 0)", () => {
  assert.deepEqual([...continuousSegmentStartOffsets(singleFile())], [[0, 0]]);
});

test("SINGLE_FILE: recording facts persist layout, audio, dropped frames, pauses and orientation", () => {
  const m = singleFile({
    pauses: [{ startOffsetMs: 10000, endOffsetMs: 20000 }],
    droppedFrameCount: 3,
    audioTracks: [],
    orientationTimeline: [
      { atOffsetMs: 0, orientation: "portrait" },
      { atOffsetMs: 40000, orientation: "landscape" },
    ],
    sessionCompleteness: "INTERRUPTED_SESSION",
    limitations: ["BROADCAST_PAUSED", "FRAMES_DROPPED", "AUDIO_NOT_CAPTURED", "ORIENTATION_CHANGED_DURING_CAPTURE"],
  });
  const v = validateScreenContinuousManifest(m);
  assert.equal(v.ok, true, v.error);
  const facts = continuousCaptureManifestFactsWithRecording(v.manifest, { manifestSha256: "c".repeat(64), manifestPartIndex: 1 });
  const payload = JSON.parse(JSON.stringify({ stage: "manifest_facts", facts }));
  const read = readContinuousRecordingFacts(payload);
  assert.deepEqual(read, continuousRecordingFacts(v.manifest));
  assert.equal(read.layout, "SINGLE_FILE");
  assert.deepEqual(read.audioTracks, []);
  assert.equal(read.droppedFrameCount, 3);
  assert.deepEqual(read.pauses, [{ startOffsetMs: 10000, endOffsetMs: 20000 }]);
  assert.equal(read.orientationTimeline.length, 2);
  assert.equal(read.recording.partIndex, 0);
  // Facts recorded before contract A read as the legacy layout with nothing stated.
  const legacy = { ...facts };
  delete legacy.continuous;
  const old = readContinuousRecordingFacts({ stage: "manifest_facts", facts: legacy });
  assert.equal(old.layout, "SEGMENTED");
  assert.equal(old.audioTracks, null);
});

test("acquisition text: SINGLE_FILE never says ordered segments; legacy wording kept; audio stated", () => {
  for (const mode of ["DIRECT_SCREEN_CAPTURE_IOS", "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS"]) {
    const one = continuousRecordingAcquisitionText({ acquisitionMode: mode, layout: "SINGLE_FILE", audioTracks: ["APP", "MICROPHONE"] });
    assert.doesNotMatch(one.statement, /segment/i);
    assert.match(one.statement, /one video file/);
    for (const text of Object.values(one.limitationText)) assert.doesNotMatch(text, /ordered segments|sequence of segments/);
    assert.equal(one.audioStatement, "Audio: app audio and microphone recorded");
    const silent = continuousRecordingAcquisitionText({ acquisitionMode: mode, layout: "SINGLE_FILE", audioTracks: [] });
    assert.equal(silent.audioStatement, "No audio was recorded");
    const legacy = continuousRecordingAcquisitionText({ acquisitionMode: mode, layout: null });
    assert.match(legacy.statement, /ordered segments/);
    assert.equal(legacy.audioStatement, null);
  }
  assert.equal(continuousRecordingAcquisitionText({ acquisitionMode: "PROOVRA_WEB_UPLOAD", layout: "SINGLE_FILE" }), null);
});
