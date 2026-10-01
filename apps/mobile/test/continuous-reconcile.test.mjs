/**
 * UC-STR-002 / UC-STR-003 / UC-IOS-003 / UC-AND-006 — the client's honest
 * bookkeeping for a continuous recording, run as real code (esbuild bundle).
 *
 * RED on the pre-remediation tree: completeness came from the recorder alone
 * (declared 0..7 of 10 recorded → COMPLETE_SESSION), the manifest part index was
 * `declared.length` (collides with segment 9 when segment 4 is lost), the staged
 * record kept the open-time expiry, an iOS burst of 20 segments tripped the
 * 8-segment backpressure stop, and the durable store had one device-wide key.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";

let C;
let F;
let D;
let S;
let L;
before(async () => {
  C = await loadModule("src/continuous-manifest.ts");
  F = await loadModule("src/continuous-capture-flow.ts");
  D = await loadModule("src/direct-capture.ts");
  S = await loadModule("src/capture/capture-session-store.ts", ["src/capture/continuous-session-store.ts", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  S.AsyncStorage?.__reset?.();
  S.setCaptureSessionOwner(null);
});

const result = (over = {}) => ({
  osConsentGranted: true,
  captureStartedAtUtc: "2026-09-30T10:00:00.000Z",
  captureEndedAtUtc: "2026-09-30T10:01:00.000Z",
  device: { platform: "android", osVersion: "14", model: "Pixel 7", appVersion: "1.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" },
  totalDurationMs: 60000,
  segmentCount: 10,
  sessionCompleteness: "COMPLETE_SESSION",
  terminationReason: "USER_STOPPED",
  limitations: [],
  ...over,
});
const seg = (i) => ({ partIndex: i, sequence: i, sha256Hex: "a".repeat(64), sizeBytes: 10, startedAtOffsetMs: i * 6000, durationMs: 6000, widthPx: 1080, heightPx: 2400, orientation: "portrait" });
const range = (n, skip = []) => Array.from({ length: n }, (_, i) => i).filter((i) => !skip.includes(i)).map(seg);

test("UC-STR-002: a lost TAIL is INTERRUPTED + SEGMENT_UPLOAD_LOST, recorded count kept, manifest after the last declared part", () => {
  const r = C.reconcileContinuousUploads(result(), range(8));
  assert.equal(r.sessionCompleteness, "INTERRUPTED_SESSION");
  assert.deepEqual(r.missingSequences, [8, 9]);
  assert.ok(r.limitations.includes("SEGMENT_UPLOAD_LOST"));
  assert.equal(r.recordedSegmentCount, 10);
  assert.equal(r.manifestPartIndex, 8);
  const m = C.buildContinuousManifest("s-1", result(), range(8));
  assert.equal(m.sessionCompleteness, "INTERRUPTED_SESSION");
  assert.equal(m.recordedSegmentCount, 10);
});

test("UC-STR-002: a lost MIDDLE segment never collides — the manifest goes after segment 9, not at declared.length", () => {
  const r = C.reconcileContinuousUploads(result(), range(10, [4]));
  assert.deepEqual(r.missingSequences, [4]);
  assert.equal(r.manifestPartIndex, 10, "declared.length (9) is segment 9's part index");
  assert.equal(r.sessionCompleteness, "INTERRUPTED_SESSION");
});

test("UC-STR-002: every recorded segment declared + a clean stop stays COMPLETE", () => {
  const r = C.reconcileContinuousUploads(result(), range(10));
  assert.equal(r.sessionCompleteness, "COMPLETE_SESSION");
  assert.deepEqual(r.limitations, []);
  assert.equal(r.manifestPartIndex, 10);
});

test("UC-STR-002: a write failure or an UNKNOWN end downgrades to INTERRUPTED", () => {
  assert.equal(C.reconcileContinuousUploads(result({ limitations: ["SEGMENT_WRITE_FAILED"] }), range(10)).sessionCompleteness, "INTERRUPTED_SESSION");
  assert.equal(C.reconcileContinuousUploads(result({ terminationReason: "UNKNOWN" }), range(10)).sessionCompleteness, "INTERRUPTED_SESSION");
  // Unknown codes never reach the manifest.
  assert.deepEqual(C.reconcileContinuousUploads(result({ limitations: ["NOT_A_CODE"] }), range(10)).limitations, []);
});

test("UC-STR-002: finalize retries exactly the recorded-but-undeclared segments", async () => {
  const L2 = await loadModule("src/continuous-capture.ts", ["test/support/expo-stub.mjs"]);
  const seen = [0, 1, 2, 3, 4].map((i) => ({ sequence: i, uri: `file:///seg-${i}.mp4` }));
  assert.deepEqual(L2.undeclaredSegments(seen, range(5, [1, 3])).map((s) => s.sequence), [1, 3]);
  assert.deepEqual(L2.undeclaredSegments([...seen, seen[1]], range(5, [1])).map((s) => s.sequence), [1]);
});

test("UC-STR-003: the handle adopts the server's slid expiry from a declaration (never an earlier one)", () => {
  const session = { captureSessionId: "cs", expiresAtUtc: "2026-09-30T11:00:00.000Z" };
  D.adoptServerSessionExpiry(session, { session: { expiresAtUtc: "2026-09-30T11:51:00.000Z" } });
  assert.equal(session.expiresAtUtc, "2026-09-30T11:51:00.000Z");
  D.adoptServerSessionExpiry(session, { session: { expiresAtUtc: "2026-09-30T11:10:00.000Z" } });
  assert.equal(session.expiresAtUtc, "2026-09-30T11:51:00.000Z");
  D.adoptServerSessionExpiry(session, { declaration: {} });
  assert.equal(session.expiresAtUtc, "2026-09-30T11:51:00.000Z");
});

test("UC-IOS-003: an iOS burst of 20 segments on return never trips the backpressure stop; Android still does", () => {
  assert.equal(F.shouldStopForBackpressure(20, 0, 8, "ios"), false);
  assert.equal(F.shouldStopForBackpressure(20, 0, 8, "android"), true);
  assert.equal(F.backpressureApplies("ios"), false);
});

test("UC-AND-006: the durable capture store is per user; another user reads nothing", async () => {
  S.setCaptureSessionOwner("user-a");
  await S.saveCaptureSession({ captureSessionId: "cs-a", expiresAtUtc: "", evidenceId: "ev-a", type: "VIDEO", items: [{ id: "i", uri: "", mimeType: "video/mp4", partIndex: 0, source: "SCREEN_SEGMENT", uploaded: true }] });
  assert.equal((await S.loadCaptureSession())?.captureSessionId, "cs-a");
  S.setCaptureSessionOwner("user-b");
  assert.equal(await S.loadCaptureSession(), null, "user B was offered user A's capture");
  S.setCaptureSessionOwner(null);
  assert.equal(await S.loadCaptureSession(), null);
  // A record that names another owner is refused even under the right key.
  assert.equal(S.isRecordOwnedBy({ ownerUserId: "user-a" }, "user-b"), false);
  assert.notEqual(S.captureSessionStorageKey("user-a"), S.captureSessionStorageKey("user-b"));
  // The live continuous record follows the same rule.
  S.setCaptureSessionOwner("user-a");
  await S.saveLiveContinuousSession({ captureSessionId: "cs-a", evidenceId: "ev-a", expiresAtUtc: "", platform: "ios", declared: [seg(0)], clientLimitations: [], openedAtIso: "" });
  assert.equal((await S.loadLiveContinuousSession())?.declared.length, 1);
  S.setCaptureSessionOwner("user-b");
  assert.equal(await S.loadLiveContinuousSession(), null);
});

test("UC-AND-006: the unattributable v1 device-wide record is dropped, never offered", async () => {
  const AsyncStorage = S.AsyncStorage;
  await AsyncStorage.setItem("proovra.capture.session.v1", JSON.stringify({ captureSessionId: "old", evidenceId: "ev", type: "VIDEO", items: [] }));
  S.setCaptureSessionOwner("user-b");
  assert.equal(await S.loadCaptureSession(), null);
  assert.equal(await AsyncStorage.getItem("proovra.capture.session.v1"), null);
});
