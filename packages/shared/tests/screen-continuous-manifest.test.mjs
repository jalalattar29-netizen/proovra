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

function goodManifest(over = {}) {
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
      segment({ partIndex: 1, sequence: 2, expectedSha256: "b".repeat(64) }),
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
