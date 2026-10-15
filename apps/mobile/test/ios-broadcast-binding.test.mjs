/**
 * AUD-006 — the JS refuses any iOS broadcast recording that is not the one its
 * capture session bound (src/capture/ios-broadcast-binding.ts).
 *
 * RED on the pre-remediation tree: ANY `started` note opened a server session
 * (a Control Center broadcast included), a persisted live session reattached
 * to whatever broadcast was active (`native.active && !native.stale`), and
 * segments were de-duplicated by sequence only, so another recording's seg-0
 * could be uploaded into the session.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";

let B;
let S;
before(async () => {
  B = await loadModule("src/capture/ios-broadcast-binding.ts");
  S = await loadModule("src/capture/continuous-session-store.ts");
});

const A = "6F1C2D3E-4A5B-4C6D-8E7F-90A1B2C3D4E5";
const OTHER = "0B8E2C61-1D2A-4E35-9B44-6A7C8D9E0F12";
const live = (over = {}) => ({ recordingId: A, captureSessionId: "cs-1", ...over });
const native = (over = {}) => ({
  active: true,
  stale: false,
  segmentCount: 2,
  recordingId: A,
  binding: "BOUND",
  appRequested: true,
  captureSessionId: "cs-1",
  liveRecordingId: A,
  ...over,
});

test("AUD-006: only the broadcast that adopted THIS screen's binding opens a session", () => {
  assert.equal(B.acceptsBroadcastStart("ios", A, { recordingId: A, binding: "BOUND" }), true);
  // Control Center: its own UNBOUND recording.
  assert.equal(B.acceptsBroadcastStart("ios", A, { recordingId: OTHER, binding: "UNBOUND" }), false);
  // The same id but not adopted from the binding (cannot happen natively; refused anyway).
  assert.equal(B.acceptsBroadcastStart("ios", A, { recordingId: A, binding: "UNBOUND" }), false);
  // No binding prepared by this screen, or an event naming no recording.
  assert.equal(B.acceptsBroadcastStart("ios", null, { recordingId: A, binding: "BOUND" }), false);
  assert.equal(B.acceptsBroadcastStart("ios", A, { captureStartedAtUtc: "x" }), false);
  assert.equal(B.acceptsBroadcastStart("ios", A, null), false);
  // Android has one recorder and no namespaces: unchanged.
  assert.equal(B.acceptsBroadcastStart("android", null, { captureStartedAtUtc: "x" }), true);
});

test("AUD-006: a segment of another recording is never uploaded into the session", () => {
  assert.equal(B.segmentBelongsToRecording("ios", A, { recordingId: A }), true);
  assert.equal(B.segmentBelongsToRecording("ios", A, { recordingId: OTHER }), false);
  assert.equal(B.segmentBelongsToRecording("ios", A, {}), false, "a segment that names no recording is refused");
  assert.equal(B.segmentBelongsToRecording("ios", null, { recordingId: A }), false);
  assert.equal(B.segmentBelongsToRecording("android", null, {}), true);
});

test("AUD-006: a remount reattaches only to its own live recording", () => {
  assert.deepEqual(B.decideIosReattach(live(), native()), { kind: "reattach" });
  // Bound before the session was recorded on it natively (killed between open and bind).
  assert.deepEqual(B.decideIosReattach(live(), native({ captureSessionId: null })), { kind: "reattach" });
  // Its own recording ended / the extension died: recover it, do not reattach.
  assert.deepEqual(B.decideIosReattach(live(), native({ active: false, stale: true })), { kind: "ended" });
  assert.deepEqual(B.decideIosReattach(live(), native({ active: false })), { kind: "ended" });
});

test("AUD-006: a remount REFUSES another recording, an unbound one, another session's, or an unproven one", () => {
  const refuse = (reason) => ({ kind: "refuse", reason });
  // The pre-fix defect: session A + a live broadcast B → reattached A to B.
  assert.deepEqual(B.decideIosReattach(live(), native({ recordingId: OTHER, liveRecordingId: OTHER })), refuse("RECORDING_MISMATCH"));
  assert.deepEqual(
    B.decideIosReattach(live(), native({ recordingId: null, binding: "NONE", liveRecordingId: OTHER })),
    refuse("RECORDING_MISSING"),
  );
  assert.deepEqual(B.decideIosReattach(live(), native({ binding: "UNBOUND", appRequested: false })), refuse("RECORDING_UNBOUND"));
  assert.deepEqual(B.decideIosReattach(live(), native({ captureSessionId: "cs-2" })), refuse("SESSION_MISMATCH"));
  // A record persisted before recording ids existed proves nothing.
  assert.deepEqual(B.decideIosReattach(live({ recordingId: null }), native()), refuse("NO_RECORDING_ID"));
  assert.deepEqual(B.decideIosReattach({ captureSessionId: "cs-1" }, native()), refuse("NO_RECORDING_ID"));
});

test("AUD-006: the durable live record carries the recordingId (null on Android or a legacy record)", () => {
  const base = { captureSessionId: "cs-1", evidenceId: "ev-1", expiresAtUtc: "", platform: "ios", declared: [], clientLimitations: [], openedAtIso: "", ownerUserId: "u1" };
  assert.equal(S.parseLiveContinuousSession({ ...base, recordingId: A }, "u1")?.recordingId, A);
  assert.equal(S.parseLiveContinuousSession(base, "u1")?.recordingId, null);
  assert.equal(S.parseLiveContinuousSession({ ...base, recordingId: 42 }, "u1")?.recordingId, null);
});
