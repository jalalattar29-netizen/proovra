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
      goodManifest({ segments: segs, limitations: ["ORIENTATION_CHANGED_DURING_CAPTURE"] }),
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
