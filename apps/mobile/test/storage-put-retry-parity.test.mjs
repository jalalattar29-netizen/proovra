/**
 * F-P1-08 (Free-user audit of 4d9b78963) — native keeps its own storage-PUT
 * rule (src/upload-utils.ts `storageRefusal` + src/capture/capture-retry.ts;
 * capture-retry stays import-free because tests load it standalone, and the
 * C-03 HELD class is native-only), and is held here to THE shared rule web and
 * the extension use (@proovra/shared classifyStoragePutStatus and the same
 * backoff/Retry-After policy).
 *
 * 425 Too Early was the one divergence (native refused it); since F-P1-08
 * parity (2026-11-15) native retries it like the shared rule.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { classifyStoragePutStatus, STORAGE_PUT_RETRY, storagePutRetryDelayMs } from "@proovra/shared";

import { loadModule } from "./support/render.mjs";

let M;
before(async () => {
  M = await loadModule("src/capture/capture-retry.ts", ["src/upload-utils.ts", "test/support/expo-stub.mjs"]);
});

const nativeClass = (status) => {
  const c = M.classifyCaptureError(M.storageRefusal(status));
  // Native "RETRYABLE" with code STORAGE_URL_REJECTED is the re-presign path.
  if (c === "RETRYABLE" && M.storageRefusal(status).code === "STORAGE_URL_REJECTED") return "REPRESIGN";
  return c;
};

test("every storage refusal status is classified alike", () => {
  const statuses = [400, 401, 403, 404, 408, 409, 411, 412, 413, 422, 425, 429, 500, 502, 503, 504];
  for (const status of statuses) {
    const shared = classifyStoragePutStatus(status);
    const native = nativeClass(status);
    assert.equal(native, shared, `status ${status}`);
  }
  // No HTTP answer at all is retryable on both sides, never success.
  assert.equal(classifyStoragePutStatus(0), "RETRYABLE");
  assert.equal(M.classifyCaptureError(new Error("Network request failed")), "RETRYABLE");
});

test("the backoff policy and Retry-After ceiling are the native ones", () => {
  assert.deepEqual(
    { attempts: STORAGE_PUT_RETRY.attempts, baseDelayMs: STORAGE_PUT_RETRY.baseDelayMs, maxDelayMs: STORAGE_PUT_RETRY.maxDelayMs, maxRetryAfterMs: STORAGE_PUT_RETRY.maxRetryAfterMs },
    { attempts: M.DEFAULT_CAPTURE_RETRY.attempts, baseDelayMs: M.DEFAULT_CAPTURE_RETRY.baseDelayMs, maxDelayMs: M.DEFAULT_CAPTURE_RETRY.maxDelayMs, maxRetryAfterMs: M.DEFAULT_CAPTURE_RETRY.maxRetryAfterMs },
  );
  for (const retry of [1, 2, 3, 5]) {
    for (const rnd of [0, 0.5, 1]) {
      assert.equal(
        storagePutRetryDelayMs(retry, null, () => rnd),
        M.retryDelayMs(retry, { ...M.DEFAULT_CAPTURE_RETRY, random: () => rnd }),
      );
    }
  }
  assert.equal(storagePutRetryDelayMs(1, 7_000, () => 0), M.retryDelayMs(1, { ...M.DEFAULT_CAPTURE_RETRY, random: () => 0 }, { retryAfterMs: 7_000 }));
  assert.equal(storagePutRetryDelayMs(1, 120_000), null);
  assert.equal(M.retryDelayMs(1, M.DEFAULT_CAPTURE_RETRY, { retryAfterMs: 120_000 }), null);
});
