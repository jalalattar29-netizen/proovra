/**
 * Free audit F-11 — an ordinary native upload (camera photo / video / audio,
 * picked file) is no longer one whole-file PUT with a fixed 120 s deadline and
 * no retry.
 *
 * Run as real code (esbuild bundle): the real direct-capture client, retry
 * rule, upload layer and api client, over in-memory files and the fake server
 * that enforces the real idempotency (fake-capture-server.mjs).
 *
 * RED on the pre-remediation tree:
 *   - the PUT deadline for a 500 MB file was 120 s (no size scaling);
 *   - `uploadDirectCaptureItemAllocated` had no retry: one dropped PUT failed
 *     the whole Finish;
 *   - a storage 403 (expired upload URL) was a code-less Error, so nothing
 *     re-presigned it and the copy read "You appear to be offline";
 *   - retries had no jitter and ignored Retry-After.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";
import { installFakeCaptureServer } from "./support/fake-capture-server.mjs";

let M;
let server;
let completes;
const FAST = { attempts: 4, baseDelayMs: 0, maxDelayMs: 0, random: () => 0 };
const FILE = "file:///cache/camera-video.mp4";

before(async () => {
  M = await loadModule("src/direct-capture.ts", [
    "src/capture/capture-retry.ts",
    "src/upload-utils.ts",
    "src/errors/safe-error.ts",
    "test/support/expo-stub.mjs",
  ]);
});

beforeEach(async () => {
  globalThis.__FS__ = new Map([[FILE, "video bytes"]]);
  server = installFakeCaptureServer();
  // The fake server has no /complete route: count completions here.
  completes = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (/\/complete$/.test(String(url))) {
      completes += 1;
      return new Response(JSON.stringify({ result: { evidenceId: "ev-cs-1" } }), { status: 200 });
    }
    return inner(url, init);
  };
});

async function openAndReserve() {
  const session = await M.openDirectCaptureSession("PROOVRA_MOBILE_APP");
  const evidenceId = await M.reserveDirectCaptureEvidence(session, {
    type: "VIDEO",
    mimeType: "video/mp4",
    deviceTimeIso: "2026-11-13T09:00:00.000Z",
  });
  return { session, evidenceId };
}

const ITEM = { uri: FILE, mimeType: "video/mp4", source: "CAMERA" };
const puts = () => server.state.requests.filter((r) => r.method === "PUT");
const presigns = () => server.state.requests.filter((r) => r.method === "POST" && /\/v1\/evidence\/[^/]+\/parts$/.test(r.path));

test("F-11: the whole-file PUT deadline scales with the file (floor 120 s, ~250 KB/s)", () => {
  assert.equal(M.putTimeoutMsForSize(0), 120_000);
  assert.equal(M.putTimeoutMsForSize(null), 120_000);
  assert.equal(M.putTimeoutMsForSize(10 * 1024 * 1024), 120_000, "a 10 MB file keeps the floor");
  // 500 MiB at 250 KiB/s = 2048 s.
  assert.equal(M.putTimeoutMsForSize(500 * 1024 * 1024), 2_048_000);
  assert.ok(M.putTimeoutMsForSize(250 * 1024 * 1024) > 120_000, "a 250 MB Free-plan file is no longer capped at 120 s");
});

test("F-11: a dropped PUT and a timed-out PUT are retried at the SAME part; one declaration, one completion", async () => {
  const { session, evidenceId } = await openAndReserve();
  server.failNext(/^PUT /, "network", 1);
  server.failNext(/^PUT /, "hang", 1);
  const up = await M.uploadDirectCaptureItemAllocated(session, evidenceId, ITEM, {
    freshSession: true,
    timeouts: { putMs: 30 },
    retry: FAST,
  });
  assert.equal(up.partIndex, 0);
  assert.equal(puts().length, 3, "two failed attempts, then the PUT that stored the bytes");
  assert.equal(server.declarations(session.captureSessionId).length, 1, "the retry re-declared the same digest: no second custody event");
  assert.deepEqual([...server.state.storage.keys()], [`${evidenceId}/0`], "one object, at the same part");
  await M.completeDirectCapture(session);
  assert.equal(completes, 1, "exactly one completion");
});

test("F-11: an expired upload URL (storage 403) is re-presigned and retried; a refused body is not", async () => {
  const { session, evidenceId } = await openAndReserve();
  server.failNext(/^PUT /, { status: 403, code: "AccessDenied" }, 1);
  await M.uploadDirectCaptureItemAllocated(session, evidenceId, ITEM, { freshSession: true, retry: FAST });
  assert.equal(presigns().length, 2, "the retry asked the API for a fresh upload URL");
  assert.equal(puts().length, 2);
  assert.equal(server.declarations(session.captureSessionId).length, 1);

  const err = M.storageRefusal(403);
  assert.equal(M.classifyCaptureError(err), "RETRYABLE");
  assert.equal(M.classifyCaptureError(M.storageRefusal(503)), "RETRYABLE");
  assert.equal(M.classifyCaptureError(M.storageRefusal(400)), "TERMINAL", "a refused digest cannot succeed by resending");
  assert.equal(err.statusCode, undefined, "a storage status is never mistaken for an API status");

  // A refused body stops at once: one PUT, no retry.
  globalThis.__FS__.set("file:///cache/second.jpg", "jpeg");
  server.failNext(/^PUT /, { status: 400, code: "BadDigest" }, 1);
  const before = puts().length;
  await assert.rejects(
    () =>
      M.uploadDirectCaptureItemAllocated(session, evidenceId, { uri: "file:///cache/second.jpg", mimeType: "image/jpeg", source: "CAMERA" }, {
        taken: [0],
        freshSession: true,
        retry: FAST,
      }),
    (e) => e.code === "STORAGE_UPLOAD_REFUSED",
  );
  assert.equal(puts().length - before, 1);
});

test("F-11: retries are bounded and the final timeout reads as a slow connection, not 'Please try again'", async () => {
  const { session, evidenceId } = await openAndReserve();
  server.failNext(/^PUT /, "hang", 10);
  await assert.rejects(
    () =>
      M.uploadDirectCaptureItemAllocated(session, evidenceId, ITEM, {
        freshSession: true,
        timeouts: { putMs: 20 },
        retry: { ...FAST, attempts: 3 },
      }),
    (e) => {
      assert.equal(e.code, "TIMEOUT");
      const safe = M.toSafeUserError(e);
      assert.equal(safe.title, "The connection was too slow");
      assert.match(safe.message, /still on this device/);
      return true;
    },
  );
  assert.equal(puts().length, 3, "attempts are bounded");
  assert.equal(completes, 0, "nothing completes a session whose upload failed");
});

test("F-11: interruption — a cancelled capture (shouldStop) stops retrying", async () => {
  const { session, evidenceId } = await openAndReserve();
  server.failNext(/^PUT /, "network", 10);
  let stop = false;
  await assert.rejects(() =>
    M.uploadDirectCaptureItemAllocated(session, evidenceId, ITEM, {
      freshSession: true,
      retry: {
        ...FAST,
        sleep: async () => {
          stop = true;
        },
        shouldStop: () => stop,
      },
    }),
  );
  assert.equal(puts().length, 1, "no attempt after the capture was cancelled");
});

test("F-11: without a retry policy one attempt is made (other callers unchanged)", async () => {
  const { session, evidenceId } = await openAndReserve();
  server.failNext(/^PUT /, "network", 1);
  await assert.rejects(() => M.uploadDirectCaptureItemAllocated(session, evidenceId, ITEM, { freshSession: true }));
  assert.equal(puts().length, 1);
});

test("F-11: backoff is jittered and never earlier than a bounded Retry-After", async () => {
  const policy = { baseDelayMs: 1000, maxDelayMs: 15_000, maxRetryAfterMs: 60_000 };
  assert.equal(M.retryDelayMs(1, { ...policy, random: () => 0 }), 500, "equal jitter: half fixed");
  assert.equal(M.retryDelayMs(1, { ...policy, random: () => 1 }), 1000);
  assert.equal(M.retryDelayMs(3, { ...policy, random: () => 0.5 }), 3000);
  // Retry-After from the header (api.ts) or the API's 429 body.
  assert.equal(M.retryDelayMs(1, { ...policy, random: () => 0 }, { retryAfterMs: 7000 }), 7000);
  assert.equal(M.retryDelayMs(1, { ...policy, random: () => 0 }, { body: { retryAfterSec: 9 } }), 9000);
  assert.equal(M.retryDelayMs(1, { ...policy, random: () => 0 }, { retryAfterMs: 120_000 }), null, "longer than the bound: not retried early");

  // The real loop: a 429 asking for 2 s waits 2 s; one asking for 10 min is thrown.
  const waits = [];
  let n = 0;
  const out = await M.retryCapture(
    async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error("slow down"), { statusCode: 429, code: "RATE_LIMITED", body: { retryAfterSec: 2 } });
      return "ok";
    },
    { ...policy, attempts: 4, random: () => 0, sleep: async (ms) => void waits.push(ms) },
  );
  assert.equal(out, "ok");
  assert.deepEqual(waits, [2000]);
  n = 0;
  await assert.rejects(() =>
    M.retryCapture(
      async () => {
        n += 1;
        throw Object.assign(new Error("later"), { statusCode: 429, retryAfterMs: 600_000 });
      },
      { ...policy, attempts: 4, sleep: async () => {} },
    ),
  );
  assert.equal(n, 1, "a wait beyond the bound is not hammered");
});
