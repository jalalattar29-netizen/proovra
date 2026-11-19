/**
 * UC-AND-006 â€” capture ends with the account session.
 *
 * RED on the pre-remediation tree: sign-out called only logout + token clear â€”
 * a running MediaProjection recording kept going, the open server sessions and
 * their reserved records stayed open, the local spool stayed on disk and the
 * device-wide durable record was offered to the next account.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";

let T;
const native = [];
let requests = [];

before(async () => {
  T = await loadModule("src/capture/capture-teardown.ts", [
    "src/capture/capture-session-store.ts",
    "src/capture/continuous-session-store.ts",
    "src/auth/account-switch.ts",
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

// PRO-NBC-03 / PRO-NA-13 / DEC-24 â€” sign-out stops capture but is never consent
// to delete evidence: no server discard, no file deletion, the records stay
// for their owner (and only for their owner).
test("PRO-NBC-03: sign-out stops the recorder and preserves every staged capture, server session and file", async () => {
  T.setCaptureSessionOwner("user-a");
  await T.saveLiveContinuousSession({ captureSessionId: "cs-live", evidenceId: "ev-1", expiresAtUtc: "", platform: "android", declared: [], clientLimitations: [], openedAtIso: "" });
  await T.saveCaptureSession({
    captureSessionId: "cs-staged", expiresAtUtc: "", evidenceId: "ev-2", type: "PHOTO",
    items: [{ id: "i1", uri: "file:///cache/photo.jpg", mimeType: "image/jpeg", partIndex: 0, source: "CAMERA", uploaded: true }],
  });

  await T.teardownCaptureOnSignOut();

  assert.ok(native.includes("stopContinuousCapture"), "the recording kept running after sign-out");
  assert.ok(!native.includes("discardContinuousSpool"), "the recording's spool was deleted on sign-out");
  const discards = requests.filter((r) => r.method === "POST" && r.path.endsWith("/discard"));
  assert.deepEqual(discards, [], "sign-out discarded a staged capture on the server");
  assert.deepEqual(globalThis.__DELETED__, [], "sign-out deleted a captured file");
  // The owner's records are still there for them ...
  assert.equal((await T.loadCaptureSession())?.captureSessionId, "cs-staged");
  assert.equal((await T.loadLiveContinuousSession())?.captureSessionId, "cs-live");
  // ... and unreadable by anyone else on the device.
  T.setCaptureSessionOwner("user-b");
  assert.equal(await T.loadCaptureSession(), null);
  assert.equal(await T.loadLiveContinuousSession(), null);
});

// PRO-NBC-03 (review gap 3) â€” behavioural, over the real sign-out sequence
// (signOutOnDevice, used by Settings and the invitation's "switch account"):
// the recorder is stopped only once the server confirmed the sign-out.
test("PRO-NBC-03: a sign-out the server did not complete leaves the recording running; a confirmed one stops it", async () => {
  T.setCaptureSessionOwner("user-a");
  const logoutAnswers = (status, body) => {
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      if (path.startsWith("/v1/auth/logout")) {
        if (status === 200) native.push("logout");
        if (status === 0) throw new TypeError("Network request failed");
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      }
      requests.push({ path, method: init.method ?? "GET" });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
  };

  for (const [status, body] of [[0, null], [503, { error: { code: "SERVER_BUSY", message: "busy" } }], [503, { error: { code: "logout_incomplete", message: "incomplete" } }]]) {
    logoutAnswers(status, body);
    const outcome = await T.signOutOnDevice();
    assert.equal(outcome.ok, false, `status ${status}`);
    assert.deepEqual(native, [], "the recorder was stopped although the person is still signed in");
  }

  logoutAnswers(200, { ok: true });
  const done = await T.signOutOnDevice();
  assert.equal(done.ok, true);
  assert.deepEqual(native, ["logout", "stopContinuousCapture"], "the recorder stops after the server confirmed the sign-out");

  assert.deepEqual(requests.filter((r) => r.path.endsWith("/discard")), [], "sign-out discarded a capture");
});

