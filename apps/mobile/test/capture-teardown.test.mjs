/**
 * UC-AND-006 — capture ends with the account session.
 *
 * RED on the pre-remediation tree: sign-out called only logout + token clear —
 * a running MediaProjection recording kept going, the open server sessions and
 * their reserved records stayed open, the local spool stayed on disk and the
 * device-wide durable record was offered to the next account.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadModule } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let T;
const native = [];
let requests = [];

before(async () => {
  T = await loadModule("src/capture/capture-teardown.ts", [
    "src/capture/capture-session-store.ts",
    "src/capture/continuous-session-store.ts",
    "test/support/expo-stub.mjs",
  ]);
});

beforeEach(() => {
  native.length = 0;
  requests = [];
  globalThis.__RN_OS__ = "android";
  globalThis.__DELETED__ = [];
  T.AsyncStorage.__reset();
  globalThis.__NATIVE_MODULES__ = {
    ProovraScreenCapture: {
      isSupported: () => true,
      isContinuousSupported: () => true,
      getState: () => ({ active: false, frameCount: 0 }),
      getContinuousState: () => ({ active: true, segmentCount: 2 }),
      getContinuousSegments: () => [{ uri: "file:///cache/proovra-continuous-1-1.mp4", sequence: 1 }],
      stopContinuousCapture: async () => native.push("stopContinuousCapture"),
      discardContinuousSpool: async () => native.push("discardContinuousSpool"),
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ path: String(url).replace(/^https?:\/\/[^/]+/, ""), method: init.method ?? "GET" });
    return new Response(JSON.stringify({ result: { discarded: true } }), { status: 200, headers: { "content-type": "application/json" } });
  };
});

test("sign-out stops the recorder, discards every open session, deletes the spool and clears the records", async () => {
  T.setCaptureSessionOwner("user-a");
  await T.saveLiveContinuousSession({ captureSessionId: "cs-live", evidenceId: "ev-1", expiresAtUtc: "", platform: "android", declared: [], clientLimitations: [], openedAtIso: "" });
  await T.saveCaptureSession({
    captureSessionId: "cs-staged", expiresAtUtc: "", evidenceId: "ev-2", type: "PHOTO",
    items: [{ id: "i1", uri: "file:///cache/photo.jpg", mimeType: "image/jpeg", partIndex: 0, source: "CAMERA", uploaded: false }],
  });

  await T.teardownCaptureOnSignOut();

  assert.ok(native.includes("stopContinuousCapture"), "the recording kept running after sign-out");
  assert.ok(native.includes("discardContinuousSpool"));
  const discards = requests.filter((r) => r.method === "POST" && r.path.endsWith("/discard")).map((r) => r.path).sort();
  assert.deepEqual(discards, ["/v1/capture/direct-sessions/cs-live/discard", "/v1/capture/direct-sessions/cs-staged/discard"]);
  assert.ok(globalThis.__DELETED__.includes("file:///cache/photo.jpg"));
  assert.ok(globalThis.__DELETED__.includes("file:///cache/proovra-continuous-1-1.mp4"));
  // The owner is unbound, and the next user finds nothing.
  assert.equal(T.getCaptureSessionOwner(), null);
  T.setCaptureSessionOwner("user-a");
  assert.equal(await T.loadCaptureSession(), null);
  assert.equal(await T.loadLiveContinuousSession(), null);
});

test("the settings sign-out runs the teardown BEFORE the token is revoked", () => {
  const src = readFileSync(resolve(HERE, "../app/(tabs)/settings.tsx"), "utf8");
  const body = src.match(/const doLogout = useCallback\(async \(\) => \{([\s\S]*?)\}, \[/);
  assert.ok(body, "doLogout not found");
  const teardown = body[1].indexOf("teardownCaptureOnSignOut()");
  const logout = body[1].indexOf("await logoutApi()");
  assert.ok(teardown >= 0 && logout > teardown, "capture teardown must run while the token is still valid");
});
