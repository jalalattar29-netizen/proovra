/**
 * AUD-005 — a single-frame (UC-2) screen capture is no longer destroyed by one
 * network failure. Run as real code (esbuild bundle): the real
 * stageScreenCapture, direct-capture client, retry rule and durable staging
 * store, over in-memory frame files and a fake server that enforces the real
 * idempotency (fake-capture-server.mjs).
 *
 * RED on the pre-remediation tree: a failed declaration made sealDirectCapture
 * discard the server session and the outer catch delete every PNG; each frame
 * was deleted right after its PUT, before staging finished; nothing retried,
 * nothing had a timeout, and nothing survived an app restart.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";
import { installFakeCaptureServer } from "./support/fake-capture-server.mjs";

let M;
let server;
const FAST = { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

const frames = (n) =>
  Array.from({ length: n }, (_, i) => ({
    uri: `file:///cache/proovra-screen-1-${i}.png`,
    frameIndex: i,
    widthPx: 1080,
    heightPx: 2400,
    capturedAtOffsetMs: i * 900,
  }));
const RESULT = (n = 3) => ({
  osConsentGranted: true,
  captureStartedAtUtc: "2026-10-15T09:00:00.000Z",
  captureEndedAtUtc: "2026-10-15T09:00:05.000Z",
  device: { platform: "android", osVersion: "14", model: "Pixel 8", appVersion: "1.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" },
  frames: frames(n),
  stopReason: "USER_STOPPED",
  limitations: [],
});

before(async () => {
  M = await loadModule("src/screen-capture.ts", [
    "src/capture/screen-staging-store.ts",
    "src/capture/capture-retry.ts",
    "src/capture/capture-session-store.ts",
    "src/screen-capture-flow.ts",
    "test/support/expo-stub.mjs",
  ]);
});

beforeEach(() => {
  globalThis.__FS__ = new Map(frames(3).map((f) => [f.uri, `png bytes ${f.frameIndex}`]));
  globalThis.__DELETED__ = [];
  server = installFakeCaptureServer();
  M.AsyncStorage.__reset();
  M.setCaptureSessionOwner("user-1");
});

const framesOnDevice = () => [...globalThis.__FS__.keys()].filter((u) => u.endsWith(".png")).length;
const declaredParts = (sessionId = "cs-1") => server.declarations(sessionId).map((d) => d.partIndex);

test("AUD-005 disconnect: the session, the reservation and every frame are KEPT, and Retry resumes them", async () => {
  server.failNext(/parts\/1\/declaration$/, "network", 99);
  const err = await M.stageScreenCapture(RESULT(), { retry: FAST, persist: M.savePendingScreenStaging }).then(() => null, (e) => e);
  assert.ok(err instanceof M.ScreenStagingError);
  assert.equal(err.retryable, true);
  assert.equal(framesOnDevice(), 3, "no frame deleted — they are the only copy");
  assert.equal(server.state.sessions.get("cs-1").status, "ACTIVE", "the server session was NOT discarded");
  assert.equal(server.state.requests.filter((r) => /parts\/1\/declaration$/.test(r.path)).length, 3, "bounded retries");

  server.state.faults = [];
  const pending = await M.loadPendingScreenStaging();
  const staged = await M.stageScreenCapture(RESULT(), { retry: FAST, persist: M.savePendingScreenStaging, pending });
  assert.equal(staged.session.captureSessionId, "cs-1");
  assert.equal(server.opens().length, 1, "no second session");
  assert.equal(server.reservations().length, 1, "no second reservation");
  assert.deepEqual(declaredParts(), [0, 1, 2, 3], "three frames and one manifest, each declared once");
  // Staging itself still deletes nothing; the screen commits, then deletes.
  assert.equal(framesOnDevice(), 3);
});

test("AUD-005 timeout: a hung request is bounded, retried, and never hangs the staging", async () => {
  server.failNext(/\/v1\/evidence\/[^/]+\/parts$/, "hang", 1);
  const staged = await M.stageScreenCapture(RESULT(2), { retry: FAST, timeouts: { requestMs: 40, putMs: 40 } });
  assert.equal(staged.frameCount, 2);
  assert.deepEqual(declaredParts(), [0, 1, 2]);

  server.failNext(/declaration$/, "hang", 99);
  const err = await M.stageScreenCapture(RESULT(2), { retry: FAST, timeouts: { requestMs: 40, putMs: 40 } }).then(() => null, (e) => e);
  assert.equal(err.retryable, true);
  assert.equal(err.code, "TIMEOUT");
  assert.equal(framesOnDevice(), 3);
});

test("AUD-005 app restart: the persisted staging resumes the SAME session after a restart", async () => {
  server.failNext(/parts\/2\/declaration$/, "network", 99);
  await M.stageScreenCapture(RESULT(), { retry: FAST, persist: M.savePendingScreenStaging }).catch(() => undefined);

  // The process restarts: memory is gone, AsyncStorage remains.
  server.state.faults = [];
  const restored = await M.loadPendingScreenStaging();
  assert.ok(restored, "the staging survived the restart");
  assert.equal(restored.session.captureSessionId, "cs-1");
  assert.deepEqual(restored.declared.map((d) => d.partIndex), [0, 1]);
  assert.equal(restored.result.frames.length, 3);

  const staged = await M.stageScreenCapture(restored.result, { retry: FAST, persist: M.savePendingScreenStaging, pending: restored });
  assert.equal(staged.session.captureSessionId, "cs-1");
  assert.deepEqual(declaredParts(), [0, 1, 2, 3]);
  // Another user never sees it.
  M.setCaptureSessionOwner("user-2");
  assert.equal(await M.loadPendingScreenStaging(), null);
});

test("AUD-005 duplicate retry: a retry after the staging already finished re-declares nothing and stages the same manifest", async () => {
  const first = await M.stageScreenCapture(RESULT(), { retry: FAST, persist: M.savePendingScreenStaging });
  // The app died before the staging record was cleared; the user taps Retry.
  const pending = await M.loadPendingScreenStaging();
  const again = await M.stageScreenCapture(RESULT(), { retry: FAST, persist: M.savePendingScreenStaging, pending });
  assert.equal(again.manifestJson, first.manifestJson);
  assert.deepEqual(declaredParts(), [0, 1, 2, 3], "no duplicate declaration (custody event)");
  // Two concurrent retries are equally harmless: same index + digest.
  await Promise.all([
    M.stageScreenCapture(RESULT(), { retry: FAST, pending }),
    M.stageScreenCapture(RESULT(), { retry: FAST, pending }),
  ]);
  assert.deepEqual(declaredParts(), [0, 1, 2, 3]);
  assert.equal(server.opens().length, 1);
});

test("AUD-005: 5xx and 429 are retried with backoff inside one staging", async () => {
  server.failNext(/parts\/0\/declaration$/, { status: 503, code: "UNAVAILABLE" }, 1);
  server.failNext(/parts\/1\/declaration$/, { status: 429, code: "RATE_LIMITED" }, 1);
  const delays = [];
  const staged = await M.stageScreenCapture(RESULT(), {
    retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000, sleep: async (ms) => { delays.push(ms); } },
  });
  assert.equal(staged.frameCount, 3);
  assert.deepEqual(delays, [100, 100]);
});

test("AUD-005: a session reaped before the retry is replaced once — the frames are staged, not lost", async () => {
  server.failNext(/parts\/1\/declaration$/, "network", 99);
  await M.stageScreenCapture(RESULT(), { retry: FAST, persist: M.savePendingScreenStaging }).catch(() => undefined);
  server.state.faults = [];
  server.reap("cs-1");
  const pending = await M.loadPendingScreenStaging();
  const staged = await M.stageScreenCapture(RESULT(), { retry: FAST, persist: M.savePendingScreenStaging, pending });
  assert.equal(staged.session.captureSessionId, "cs-2");
  assert.deepEqual(declaredParts("cs-2"), [0, 1, 2, 3]);
  assert.equal(framesOnDevice(), 3);
});

test("AUD-005: only a TERMINAL refusal releases the session and deletes the frames", async () => {
  server.failNext(/parts\/1\/declaration$/, { status: 409, code: "PART_ALREADY_DECLARED" }, 1);
  const err = await M.stageScreenCapture(RESULT(), { retry: FAST, persist: M.savePendingScreenStaging }).then(() => null, (e) => e);
  assert.equal(err.retryable, false);
  assert.equal(server.state.sessions.get("cs-1").status, "DISCARDED");
  assert.equal(framesOnDevice(), 0);
});

test("AUD-005: the retry rule — retryable vs terminal, backoff, timeout", async () => {
  const c = M.classifyCaptureError;
  assert.equal(c(new TypeError("Network request failed")), "RETRYABLE");
  assert.equal(c({ code: "TIMEOUT" }), "RETRYABLE");
  assert.equal(c({ statusCode: 500 }), "RETRYABLE");
  assert.equal(c({ statusCode: 503 }), "RETRYABLE");
  assert.equal(c({ statusCode: 429 }), "RETRYABLE");
  assert.equal(c({ statusCode: 408 }), "RETRYABLE");
  assert.equal(c({ statusCode: 409, code: "SESSION_BUSY" }), "RETRYABLE");
  assert.equal(c({ statusCode: 400, code: "INVALID_DIGEST" }), "TERMINAL");
  assert.equal(c({ statusCode: 403, code: "FORBIDDEN" }), "TERMINAL");
  assert.equal(c({ statusCode: 415, code: "FILE_VALIDATION_BLOCKED" }), "TERMINAL");
  assert.equal(c({ code: "LOCAL_FILE_MISSING" }), "TERMINAL");
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => M.backoffDelayMs(n, { baseDelayMs: 1000, maxDelayMs: 5000 })), [1000, 2000, 4000, 5000, 5000]);
  await assert.rejects(
    () => M.withTimeout(() => new Promise(() => {}), 20, "probe"),
    (e) => e.code === "TIMEOUT",
  );
  let attempts = 0;
  await assert.rejects(() =>
    M.retryCapture(async () => {
      attempts += 1;
      throw Object.assign(new Error("x"), { statusCode: 422 });
    }, FAST),
  );
  assert.equal(attempts, 1, "a terminal failure is never retried");
});

test("AUD-005: the flow keeps a retryable staging as `pending` and offers it again after a restart", () => {
  const r = M.screenFlowReducer;
  const uploading = { phase: "uploading", frameCount: 3 };
  const pending = r(uploading, { type: "STAGE_PENDING", frameCount: 3, message: "kept" });
  assert.deepEqual(pending, { phase: "pending", frameCount: 3, message: "kept" });
  assert.deepEqual(r(pending, { type: "FINALIZE" }), { phase: "uploading", frameCount: 3 });
  assert.deepEqual(r({ phase: "intro" }, { type: "RESUME_PENDING", frameCount: 2, message: "m" }), { phase: "pending", frameCount: 2, message: "m" });
  assert.deepEqual(r({ phase: "active", frameCount: 1 }, { type: "RESUME_PENDING", frameCount: 2, message: "m" }), { phase: "active", frameCount: 1 });
});
