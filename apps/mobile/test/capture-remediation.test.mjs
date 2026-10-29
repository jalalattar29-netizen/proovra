/**
 * CAPTURE REMEDIATION (2026-10-29) — the units behind the three product
 * decisions, driven through their REAL modules (bundled by the render
 * harness, so expo-location / AsyncStorage / FileSystem are the test stubs):
 *
 *   decision 2  location on / off / denied / timeout / required, through the
 *               reservation fields, and carried on a persisted record;
 *   decision 1  a SINGLE_FILE native result uploads ONE file as part 0
 *               (SCREEN_RECORDING) and the contract-A manifest as part 1, and
 *               the manifest is accepted by THE server validator;
 *   decision 3  many pending records coexist (one never overwrites another),
 *               linked records link only once both sealed;
 *   draft safety  server-authoritative part allocation retries on
 *               PART_ALREADY_DECLARED; refusals map to actionable copy.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { validateScreenContinuousManifest } from "@proovra/shared";
import { loadModule } from "./support/render.mjs";

let L; // device-location
let S; // capture-session-store
let D; // direct-capture
let C; // continuous-capture (+ single-file builder)
let K; // capture-links
let E; // safe-error
let N; // completion-notice

before(async () => {
  [L, S, D, C, K, E, N] = await Promise.all([
    loadModule("src/capture/device-location.ts"),
    loadModule("src/capture/capture-session-store.ts", ["test/support/expo-stub.mjs"]),
    loadModule("src/direct-capture.ts"),
    loadModule("src/continuous-capture.ts", ["src/continuous-single-file.ts", "test/support/expo-stub.mjs"]),
    loadModule("src/capture/capture-links.ts", ["src/capture/capture-session-store.ts", "test/support/expo-stub.mjs"]),
    loadModule("src/errors/safe-error.ts"),
    loadModule("src/capture/completion-notice.ts"),
  ]);
});

/* ------------------------------------------------------------ decision 2 -- */

const api = (over = {}) => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: async () => ({ granted: over.granted !== false }),
  getCurrentPositionAsync: over.get ?? (async () => ({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 8 }, timestamp: Date.now() })),
});

test("location ON with a fix: coordinates (mock flag kept), never an outcome beside them", async () => {
  const r = await L.acquireDeviceLocation({
    location: api({ get: async () => ({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 8 }, timestamp: Date.now(), mocked: true }) }),
  });
  assert.equal(r.outcome, "GRANTED");
  assert.deepEqual(r.gps, { lat: 51.5, lng: -0.12, accuracyMeters: 8, providerReportedMock: true });
  const f = L.reservationLocationFields({ useLocation: true, result: r });
  assert.ok(f.gps);
  assert.equal(f.locationRequestOutcome, undefined);
});

test("zero coordinates are a location, not a missing one", async () => {
  const r = await L.acquireDeviceLocation({ location: api({ get: async () => ({ coords: { latitude: 0, longitude: 0, accuracy: 3 }, timestamp: 0 }) }) });
  assert.equal(r.outcome, "GRANTED");
  assert.equal(r.gps.lat, 0);
  assert.equal(r.gps.lng, 0);
});

test("location OFF ⇒ NOT_REQUESTED; DENIED / UNAVAILABLE / TIMEOUT are each stated", async () => {
  assert.deepEqual(L.reservationLocationFields({ useLocation: false, result: null }), { locationRequestOutcome: "NOT_REQUESTED" });
  const denied = await L.acquireDeviceLocation({ location: api({ granted: false }) });
  assert.equal(denied.outcome, "DENIED");
  const unavailable = await L.acquireDeviceLocation({ location: api({ get: async () => { throw new Error("no fix"); } }) });
  assert.equal(unavailable.outcome, "UNAVAILABLE");
  const timeout = await L.acquireDeviceLocation({ timeoutMs: 20, location: api({ get: () => new Promise(() => {}) }) });
  assert.equal(timeout.outcome, "TIMEOUT");
  assert.deepEqual(L.reservationLocationFields({ useLocation: true, result: timeout }), { locationRequestOutcome: "TIMEOUT" });
  // On, but no attempt recorded: UNAVAILABLE — never "not requested".
  assert.deepEqual(L.reservationLocationFields({ useLocation: true, result: null }), { locationRequestOutcome: "UNAVAILABLE" });
});

test("a cached (stale) fix is never used as where the device is", async () => {
  const r = await L.acquireDeviceLocation({
    now: () => Date.parse("2026-10-29T12:00:00Z"),
    location: api({ get: async () => ({ coords: { latitude: 1, longitude: 1 }, timestamp: Date.parse("2026-10-29T11:00:00Z") }) }),
  });
  assert.equal(r.outcome, "UNAVAILABLE");
});

test("a failure asks Retry / proceed / Cancel — proceed is NOT offered when the plan requires location", async () => {
  assert.deepEqual(L.locationFailurePrompt("DENIED", { required: false }).buttons.map((b) => b.choice), ["retry", "proceed", "cancel"]);
  assert.deepEqual(L.locationFailurePrompt("TIMEOUT", { required: true }).buttons.map((b) => b.choice), ["retry", "cancel"]);

  // Retry then succeed.
  let n = 0;
  const acquired = await L.acquireLocationWithChoice({
    required: false,
    acquire: async () => (++n === 1 ? { outcome: "TIMEOUT", gps: null } : { outcome: "GRANTED", gps: { lat: 1, lng: 2 }, acquiredAtIso: "x" }),
    ask: async () => "retry",
  });
  assert.equal(acquired.kind, "acquired");
  assert.equal(n, 2);
  // Proceed without location (not required).
  const proceed = await L.acquireLocationWithChoice({ required: false, acquire: async () => ({ outcome: "DENIED", gps: null }), ask: async () => "proceed" });
  assert.equal(proceed.kind, "proceed");
  assert.deepEqual(L.reservationLocationFields({ useLocation: true, result: proceed.result }), { locationRequestOutcome: "DENIED" });
  // Required: a "proceed" answer is never honoured.
  const required = await L.acquireLocationWithChoice({ required: true, acquire: async () => ({ outcome: "DENIED", gps: null }), ask: async () => "proceed" });
  assert.equal(required.kind, "cancel");
});

test("the system alert carries exactly the prompt's buttons and resolves with the pressed one", async () => {
  let shown;
  const choice = L.askLocationFailure("UNAVAILABLE", { required: false }, (title, message, buttons) => {
    shown = { title, message, labels: buttons.map((b) => b.text) };
    buttons.find((b) => b.text === "Finish without location").onPress();
  });
  assert.equal(await choice, "proceed");
  assert.deepEqual(shown.labels, ["Retry", "Finish without location", "Cancel"]);
});

test("a recording's start location is read-only afterwards, and stated", () => {
  assert.equal(L.carriedLocationStatus({ useLocation: true, outcome: "GRANTED", recordedAtStart: true }), "Location recorded at the start of the recording.");
  assert.match(L.carriedLocationStatus({ useLocation: true, outcome: "TIMEOUT", recordedAtStart: true }), /did not provide a location in time/);
  assert.equal(L.carriedLocationStatus({ useLocation: true, outcome: "GRANTED", recordedAtStart: false }), null);
  assert.match(L.LOCATION_CANNOT_BE_ADDED_LATER, /cannot be added to a recording that has already started/);
  assert.equal(L.locationParam("1"), true);
  assert.equal(L.locationParam(["0"]), false);
});

/* -------------------------------------------- decision 3: pending records -- */

const record = (over = {}) => ({
  captureSessionId: "cs-a",
  expiresAtUtc: "2099-01-01T00:00:00.000Z",
  evidenceId: "ev-a",
  type: "VIDEO",
  items: [{ id: "i", uri: "", mimeType: "video/mp4", partIndex: 0, source: "SCREEN_RECORDING", uploaded: true, itemSourceLabel: "DIRECT_SCREEN_CAPTURE_IOS" }],
  acquisition: { mode: "DIRECT_SCREEN_CAPTURE_IOS", manifestJson: "{\"m\":1}" },
  draftId: "draft-a",
  location: { useLocation: true, outcome: "GRANTED", recordedAtStart: true },
  ...over,
});

beforeEach(() => {
  S.AsyncStorage.__reset();
  S.setCaptureSessionOwner("user-1");
});

test("two pending records coexist — staging a second never overwrites the first", async () => {
  await S.saveCaptureSession(record());
  await S.saveCaptureSession(record({ captureSessionId: "cs-b", evidenceId: "ev-b", draftId: "draft-b" }));
  const all = await S.loadCaptureSessions();
  assert.deepEqual(all.map((r) => r.captureSessionId).sort(), ["cs-a", "cs-b"]);
  // Re-saving one replaces only that one.
  await S.saveCaptureSession(record({ items: [] }));
  assert.equal((await S.loadCaptureSessions()).length, 2);
  // Clearing one by its key keeps the other.
  await S.clearCaptureSession({ captureSessionId: "cs-a", draftId: "draft-a" });
  assert.deepEqual((await S.loadCaptureSessions()).map((r) => r.captureSessionId), ["cs-b"]);
});

test("the record keeps its acquisition, item origin and start location across a restart", async () => {
  await S.saveCaptureSession(record());
  const [r] = await S.loadCaptureSessions();
  assert.deepEqual(r.acquisition, { mode: "DIRECT_SCREEN_CAPTURE_IOS", manifestJson: "{\"m\":1}" });
  assert.equal(r.items[0].itemSourceLabel, "DIRECT_SCREEN_CAPTURE_IOS");
  assert.deepEqual(r.location, { useLocation: true, outcome: "GRANTED", recordedAtStart: true });
});

test("the legacy single slot is migrated into the list, never lost", async () => {
  await S.AsyncStorage.setItem(
    S.captureSessionStorageKey("user-1"),
    JSON.stringify({ ...record({ captureSessionId: "cs-old", draftId: null }), updatedAtIso: new Date().toISOString(), ownerUserId: "user-1" }),
  );
  await S.saveCaptureSession(record());
  const ids = (await S.loadCaptureSessions()).map((r) => r.captureSessionId).sort();
  assert.deepEqual(ids, ["cs-a", "cs-old"]);
  assert.equal(await S.AsyncStorage.getItem(S.captureSessionStorageKey("user-1")), null);
});

test("linked records link only once BOTH sealed, then forget the group", async () => {
  K.setCaptureSessionOwner("user-1");
  K.AsyncStorage.__reset();
  const posts = [];
  const post = async (a, b) => posts.push([a, b]);
  await K.registerLinkedRecord("g1", "draft-screen");
  await K.registerLinkedRecord("g1", "draft-photo");
  assert.equal(await K.recordSealedAndLink("g1", "draft-photo", "ev-photo", post), "WAITING");
  assert.deepEqual(posts, []);
  assert.equal(await K.recordSealedAndLink("g1", "draft-screen", "ev-screen", post), "LINKED");
  assert.deepEqual(posts, [["ev-screen", "ev-photo"]]);
  assert.equal(await K.recordSealedAndLink("g1", "draft-screen", "ev-screen", post), "NONE");
  // A discarded member dissolves a pair.
  assert.deepEqual(K.dropLinkMember([{ id: "g2", members: [{ key: "a", evidenceId: null }, { key: "b", evidenceId: null }] }], "g2", "a"), []);
});

/* ------------------------------------------------- server part allocation -- */

test("parts are allocated after every part the server holds, and PART_ALREADY_DECLARED re-reads and retries", async () => {
  const session = { captureSessionId: "cs-1", expiresAtUtc: "" };
  let serverParts = [{ partIndex: 0 }, { partIndex: 1 }];
  const tried = [];
  const upload = async (_s, _e, item) => {
    tried.push(item.partIndex);
    if (item.partIndex === 2) {
      serverParts = [...serverParts, { partIndex: 2 }]; // a racing declaration took it
      throw Object.assign(new Error("taken"), { code: "PART_ALREADY_DECLARED", statusCode: 409 });
    }
    return { partIndex: item.partIndex, sha256Hex: "a".repeat(64), sizeBytes: 1 };
  };
  const out = await D.uploadDirectCaptureItemAllocated(session, "ev-1", { uri: "file:///p.jpg", mimeType: "image/jpeg", source: "CAMERA" }, {
    listParts: async () => serverParts,
    upload,
  });
  assert.deepEqual(tried, [2, 3]);
  assert.equal(out.partIndex, 3);
  // Bounded: a server that always refuses surfaces the refusal.
  await assert.rejects(
    D.uploadDirectCaptureItemAllocated(session, "ev-1", { uri: "x", mimeType: "image/jpeg", source: "CAMERA" }, {
      listParts: async () => [],
      upload: async () => { throw Object.assign(new Error("taken"), { code: "PART_ALREADY_DECLARED" }); },
    }),
    /taken/,
  );
  // An API without contract C (404) falls back to this client's own count.
  const fallback = await D.uploadDirectCaptureItemAllocated(session, "ev-1", { uri: "x", mimeType: "image/jpeg", source: "CAMERA" }, {
    taken: [0, 4],
    listParts: async () => { throw Object.assign(new Error("nf"), { statusCode: 404 }); },
    upload: async (_s, _e, item) => ({ partIndex: item.partIndex, sha256Hex: "b", sizeBytes: 1 }),
  });
  assert.equal(fallback.partIndex, 5);
  assert.deepEqual(D.parseDirectCaptureParts({ parts: [{ partIndex: 1, sha256: "s", state: "LOST", source: "CAMERA" }, { partIndex: -1 }] }), [
    { partIndex: 1, sha256: "s", state: "LOST", source: "CAMERA" },
  ]);
});

test("capture refusals read as actionable copy, preferring the server's own message", () => {
  for (const code of ["PART_ALREADY_DECLARED", "PART_LOST", "MANIFEST_SEAL_ROUTE_REQUIRED", "CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH", "SESSION_ALREADY_RESERVED", "MICROPHONE_PERMISSION_REQUIRED", "STORAGE_LOW"]) {
    const e = E.toSafeUserError(Object.assign(new Error("HTTP 409: API error"), { statusCode: 409, code }));
    assert.equal(e.explained, true, code);
    assert.notEqual(e.title, "We couldn’t complete that action", code);
  }
  const withServer = E.toSafeUserError(
    Object.assign(new Error("x"), { statusCode: 409, code: "PART_ALREADY_DECLARED", body: { denial: "PART_ALREADY_DECLARED", message: "Part 3 is already declared for this session." } }),
  );
  assert.equal(withServer.message, "Part 3 is already declared for this session.");
});

test("a record sealed without a trusted timestamp gets the shared degraded notice; a stamped one none", () => {
  assert.equal(N.sealedTimestampNotice({ tsaStatus: "STAMPED", tsaTokenPresent: true, tsaValidatedAtUtc: "2026-10-29T10:00:00Z" }), null);
  const n = N.sealedTimestampNotice({ tsaStatus: "FAILED", tsaFailureCode: "tsa_provider_timeout" });
  assert.equal(n?.tone, "warning");
  assert.match(n.title, /Evidence sealed/);
});

/* ------------------------------------------------ decision 1: single file -- */

const DEVICE = { platform: "ios", osVersion: "18.1", model: "iPhone15,2", appVersion: "1.0.0", screenW: 1179, screenH: 2556, densityDpi: 460, orientation: "portrait" };
const SINGLE = (over = {}) => ({
  layout: "SINGLE_FILE",
  osConsentGranted: true,
  captureStartedAtUtc: new Date(Date.now() - 60_000).toISOString(),
  captureEndedAtUtc: new Date(Date.now() - 30_000).toISOString(),
  device: DEVICE,
  totalDurationMs: 30_000,
  segmentCount: 0,
  sessionCompleteness: "COMPLETE_SESSION",
  terminationReason: "USER_STOPPED",
  limitations: [],
  recordingUri: "file:///cache/recording.mp4",
  recordingSizeBytes: 9,
  recordingDurationMs: 30_000,
  widthPx: 1179,
  heightPx: 2556,
  orientationTimeline: [{ atOffsetMs: 0, orientation: "portrait" }],
  pauses: [],
  droppedFrameCount: 0,
  audioTracks: ["APP"],
  finalized: true,
  ...over,
});

const validate = (manifestJson, sessionId = "cs-1") => {
  const m = JSON.parse(manifestJson);
  assert.equal(m.captureSessionId, sessionId);
  return validateScreenContinuousManifest(m);
};

test("a legacy (segmented) result is not read as single-file; a new one is, defensively", () => {
  assert.equal(C.readSingleFileRecording({ segmentCount: 3 }), null);
  const rec = C.readSingleFileRecording(SINGLE({ droppedFrameCount: undefined, finalized: undefined }));
  assert.equal(rec.droppedFrameCount, null, "Android reports no dropped-frame count: never claimed as 0");
  assert.equal(rec.finalized, false, "absent finalized is NOT finalized");
});

test("the contract-A manifest is accepted by the server validator — complete, silent, Android (unknown drops) and interrupted", () => {
  const declared = { sha256Hex: "a".repeat(64), sizeBytes: 9 };
  const complete = C.buildSingleFileManifest("cs-1", SINGLE(), C.readSingleFileRecording(SINGLE()), declared);
  assert.equal(complete.recordingLayout, "SINGLE_FILE");
  assert.equal(complete.segments.length, 1);
  assert.equal(complete.segments[0].role, "screen_recording");
  assert.equal(complete.sessionCompleteness, "COMPLETE_SESSION");
  assert.deepEqual(validate(JSON.stringify(complete)).ok, true, JSON.stringify(validate(JSON.stringify(complete))));

  const silentAndroid = SINGLE({ audioTracks: [], droppedFrameCount: undefined, device: { ...DEVICE, platform: "android" } });
  const m2 = C.buildSingleFileManifest("cs-1", silentAndroid, C.readSingleFileRecording(silentAndroid), declared);
  assert.ok(m2.limitations.includes("AUDIO_NOT_CAPTURED"));
  assert.equal("droppedFrameCount" in m2, false);
  assert.equal(validate(JSON.stringify(m2)).ok, true, JSON.stringify(validate(JSON.stringify(m2))));

  // iOS killed broadcast: a URI, no duration, finalized false — INTERRUPTED, never complete.
  const killed = SINGLE({ finalized: false, recordingDurationMs: null, terminationReason: "UNKNOWN", sessionCompleteness: "INTERRUPTED_SESSION" });
  const rec = C.readSingleFileRecording(killed);
  const m3 = C.buildSingleFileManifest("cs-1", killed, rec, declared);
  assert.equal(m3.sessionCompleteness, "INTERRUPTED_SESSION");
  assert.ok(m3.limitations.includes("CAPTURE_INTERRUPTED"));
  assert.equal(validate(JSON.stringify(m3)).ok, true, JSON.stringify(validate(JSON.stringify(m3))));
  assert.equal(C.singleFileOutcome(killed, rec).kind, "INTERRUPTED");
  assert.equal(C.singleFileOutcome(SINGLE({ recordingUri: null, finalized: false }), C.readSingleFileRecording(SINGLE({ recordingUri: null, finalized: false }))).kind, "NO_FILE");

  // Dropped frames and pauses are each named.
  const rough = SINGLE({ droppedFrameCount: 4, pauses: [{ startOffsetMs: 1000, endOffsetMs: 2000 }] });
  const m4 = C.buildSingleFileManifest("cs-1", rough, C.readSingleFileRecording(rough), declared);
  assert.ok(m4.limitations.includes("FRAMES_DROPPED") && m4.limitations.includes("BROADCAST_PAUSED"));
  assert.equal(validate(JSON.stringify(m4)).ok, true, JSON.stringify(validate(JSON.stringify(m4))));
});

test("staging a single-file recording uploads ONE file as part 0 (SCREEN_RECORDING) then the manifest as part 1", async () => {
  const bytes = "recording";
  globalThis.__FS__ = new Map([["file:///cache/recording.mp4", bytes]]);
  const puts = [];
  globalThis.__UPLOAD_ASYNC__ = async (url, uri) => {
    puts.push(uri);
    return { status: 200 };
  };
  const declarations = [];
  const parts = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = init.body ? JSON.parse(init.body) : {};
    let res = {};
    if (path.includes("/declaration")) {
      declarations.push({ path, body });
      res = { declaration: {} };
    } else if (path.endsWith("/parts")) {
      parts.push(body);
      res = { upload: { putUrl: "https://store.invalid/put" } };
    }
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = SINGLE();
  const rec = C.readSingleFileRecording(result);
  let persisted = null;
  const staged = await C.stageSingleFileRecording({ captureSessionId: "cs-1", expiresAtUtc: "" }, "ev-1", result, rec, {
    onDeclared: async (d) => {
      persisted = d;
    },
  });
  assert.deepEqual(declarations.map((d) => [d.path.split("/parts/")[1], d.body.clientReportedSource]), [
    ["0/declaration", "SCREEN_RECORDING"],
    ["1/declaration", "CONTINUOUS_MANIFEST"],
  ]);
  assert.equal(declarations[0].body.recordedThrough, undefined, "a single file carries no recordedThrough");
  assert.equal(declarations[0].body.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(parts[0].originalFileName, /^screen-recording-.*\.mp4$/);
  assert.equal(puts[0], "file:///cache/recording.mp4");
  assert.equal(staged.layout, "SINGLE_FILE");
  assert.equal(staged.manifestPartIndex, 1);
  assert.equal(staged.sizeBytes, bytes.length);
  assert.equal(validate(staged.manifestJson).ok, true);
  assert.equal(persisted.sizeBytes, bytes.length);

  // A retry with the part-0 declaration persisted never uploads the file again.
  declarations.length = 0;
  await C.stageSingleFileRecording({ captureSessionId: "cs-1", expiresAtUtc: "" }, "ev-1", result, rec, { declared: persisted });
  assert.deepEqual(declarations.map((d) => d.body.clientReportedSource), ["CONTINUOUS_MANIFEST"]);
  delete globalThis.__FS__;
  delete globalThis.__UPLOAD_ASYNC__;
});

test("the limits are stated before recording, from THE capture limits", () => {
  assert.equal(C.formatSingleFileLimits({ maxSessionMs: 50 * 60_000, maxSessionBytes: 512 * 1024 * 1024 }), "50 minutes or 512 MB");
  assert.match(C.audioTracksLabel([]), /silent/);
  assert.match(C.audioTracksLabel(["APP", "MICROPHONE"]), /app audio and microphone/);
  assert.ok(C.singleFilePutTimeoutMs(500 * 1024 * 1024) > 120_000);
});
