/**
 * UC-2 Direct Screen Capture screen, rendered for real over a scripted native
 * module and API.
 *
 *   UC-AND-003  Android 13+: POST_NOTIFICATIONS is requested before the native
 *               start; a refusal says Capture Frame will not be available
 *               outside PROOVRA and starts nothing until the user accepts that.
 *   UC-AND-010  the full-resolution screenshots are deleted after their upload
 *               and on Discard — never left in the app cache.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
const calls = [];
const FRAMES = [
  { uri: "file:///cache/proovra-screen-1-0.png", frameIndex: 0, widthPx: 1080, heightPx: 2400, capturedAtOffsetMs: 0 },
  { uri: "file:///cache/proovra-screen-1-1.png", frameIndex: 1, widthPx: 1080, heightPx: 2400, capturedAtOffsetMs: 900 },
];
const RESULT = {
  osConsentGranted: true,
  captureStartedAtUtc: "2026-09-30T10:00:00.000Z",
  captureEndedAtUtc: "2026-09-30T10:00:02.000Z",
  device: { platform: "android", osVersion: "14", model: "Pixel 7", appVersion: "1.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" },
  frames: FRAMES,
  stopReason: "USER_STOPPED",
  limitations: [],
};

before(async () => {
  M = await loadModule("app/(stack)/screen-capture.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/capture/screen-staging-store.ts",
  ]);
});

const mounted = [];
beforeEach(async () => {
  calls.length = 0;
  globalThis.__RN_OS__ = "android";
  globalThis.__RN_VERSION__ = 34;
  globalThis.__PERMISSION_REQUESTS__ = [];
  globalThis.__PERMISSION_RESULT__ = "granted";
  globalThis.__DELETED__ = [];
  globalThis.__NATIVE_MODULES__ = {
    ProovraScreenCapture: {
      isSupported: () => true,
      isContinuousSupported: () => true,
      getState: () => ({ active: false, frameCount: 0 }),
      getContinuousState: () => ({ active: false, segmentCount: 0 }),
      getContinuousSegments: () => [],
      startCapture: async () => {
        calls.push("startCapture");
        return { osConsentGranted: true, captureStartedAtUtc: "2026-09-30T10:00:00.000Z", maxFrames: 20 };
      },
      captureFrame: async () => ({ frameIndex: 0, frameCount: 1 }),
      stopCapture: async () => {
        calls.push("stopCapture");
        return RESULT;
      },
    },
  };
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/parts": () => ({ upload: { putUrl: "https://store.invalid/put", bucket: "b", key: "k" } }),
    "/v1/capture/sessions": () => ({ session: { id: "draft-1" } }),
    "/v1/capture/direct-sessions": (path) => {
      if (path.endsWith("/evidence")) return { evidence: { evidenceId: "ev-1" } };
      if (path.includes("/declaration")) return { declaration: {}, session: { expiresAtUtc: "2026-09-30T11:00:00.000Z" } };
      return { session: { captureSessionId: "cs-1", expiresAtUtc: "2026-09-30T11:00:00.000Z" } };
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path, init) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
  M.AsyncStorage.__reset();
  await signIn(M);
});
afterEach(async () => {
  for (const r of mounted.splice(0)) await act(async () => r.renderer.unmount());
  delete globalThis.__RN_OS__;
  delete globalThis.__RN_VERSION__;
});

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};

test("UC-AND-003: the notification permission is requested before the capture service starts", async () => {
  const r = await render();
  await r.press("Start Screen Capture");
  await settle();
  assert.deepEqual(globalThis.__PERMISSION_REQUESTS__, ["android.permission.POST_NOTIFICATIONS"]);
  assert.deepEqual(calls, ["startCapture"]);
});

test("UC-AND-003: refused — the user is told cross-app capture is unavailable, and nothing starts until they accept", async () => {
  globalThis.__PERMISSION_RESULT__ = "denied";
  const r = await render();
  await r.press("Start Screen Capture");
  await settle();
  assert.ok(r.hasText("Notifications are off"));
  assert.ok(r.texts().some((t) => t.includes("without them PROOVRA can only capture its own screen")));
  assert.deepEqual(calls, []);
  await r.press("Continue with PROOVRA's own screen only");
  await settle();
  assert.deepEqual(calls, ["startCapture"]);
  assert.ok(r.texts().some((t) => t.includes("only PROOVRA's own screen can be captured")));
});

test("UC-AND-010: Discard deletes the captured screenshots from the device", async () => {
  const r = await render();
  await r.press("Start Screen Capture");
  await settle();
  await r.press("Stop & Review");
  await settle();
  await r.press("Discard");
  await settle();
  assert.deepEqual(globalThis.__DELETED__.sort(), FRAMES.map((f) => f.uri).sort());
});

test("UC-AND-010 / AUD-005: once staged and committed, every screenshot and the manifest file are deleted", async () => {
  const r = await render();
  await r.press("Start Screen Capture");
  await settle();
  await r.press("Stop & Review");
  await settle();
  await r.press("Add to capture session");
  await settle();
  for (const f of FRAMES) assert.ok(globalThis.__DELETED__.includes(f.uri), `${f.uri} was left on the device`);
  assert.ok(globalThis.__DELETED__.some((u) => u.includes("proovra-screen-manifest-cs-1.json")), "the manifest file was left");
});

/* ---------------------------------------------------------------- AUD-005 -- */

test("AUD-005: a network failure keeps the frames and offers Retry; Retry stages them into the same session", async () => {
  let declarationsDown = true;
  const base = routes["/v1/capture/direct-sessions"];
  let opens = 0;
  routes["/v1/capture/direct-sessions"] = (path, init) => {
    if (path.includes("/declaration") && declarationsDown) return undefined; // 500: retryable
    if (path === "/v1/capture/direct-sessions") opens += 1;
    return base(path, init);
  };
  const r = await render();
  await r.press("Start Screen Capture");
  await settle();
  await r.press("Stop & Review");
  await settle();
  await r.press("Add to capture session");
  // Bounded retries with backoff (1 s + 2 s + 4 s), then the staging is kept.
  for (let i = 0; i < 90 && !r.hasText("Retry upload"); i += 1) {
    await act(async () => { await new Promise((x) => setTimeout(x, 100)); });
  }
  assert.ok(r.hasText("Retry upload"), "Retry is offered");
  assert.ok(r.texts().some((t) => t.includes("Your frames are kept on this device")));
  assert.deepEqual(globalThis.__DELETED__.filter((u) => u.endsWith(".png")), [], "no frame was deleted");

  declarationsDown = false;
  await r.press("Retry upload");
  await settle();
  assert.equal(opens, 1, "Retry resumed the same session");
  for (const f of FRAMES) assert.ok(globalThis.__DELETED__.includes(f.uri), "committed: now the frames go");
  assert.equal(await M.loadPendingScreenStaging(), null, "the staging record is cleared");
});

test("AUD-005: a staging kept before an app restart is offered again and resumes", async () => {
  // The signed-in user's staging, written by an earlier run of the app.
  const before = await render();
  await act(async () => before.renderer.unmount());
  mounted.splice(mounted.indexOf(before), 1);
  await M.savePendingScreenStaging({
    result: RESULT,
    teamId: null,
    session: { captureSessionId: "cs-1", expiresAtUtc: "2026-09-30T11:00:00.000Z" },
    evidenceId: "ev-1",
    declared: [],
    manifest: null,
    updatedAtIso: "2026-09-30T10:00:03.000Z",
  });
  const opened = [];
  const base = routes["/v1/capture/direct-sessions"];
  routes["/v1/capture/direct-sessions"] = (path, init) => {
    if (path === "/v1/capture/direct-sessions") opened.push(path);
    return base(path, init);
  };
  const r = await render();
  assert.ok(r.hasText("Retry upload"));
  assert.ok(r.texts().some((t) => t.includes("has not finished uploading")));
  await r.press("Retry upload");
  await settle();
  assert.deepEqual(opened, [], "the persisted session is reused");
  assert.ok(FRAMES.every((f) => globalThis.__DELETED__.includes(f.uri)));
});

test("AUD-005: Discard of a kept staging releases its session and deletes its frames", async () => {
  // The signed-in user's staging, written by an earlier run of the app.
  const before = await render();
  await act(async () => before.renderer.unmount());
  mounted.splice(mounted.indexOf(before), 1);
  await M.savePendingScreenStaging({
    result: RESULT, teamId: null,
    session: { captureSessionId: "cs-1", expiresAtUtc: "2026-09-30T11:00:00.000Z" },
    evidenceId: "ev-1", declared: [], manifest: null, updatedAtIso: "2026-09-30T10:00:03.000Z",
  });
  const discarded = [];
  const base = routes["/v1/capture/direct-sessions"];
  routes["/v1/capture/direct-sessions"] = (path, init) => {
    if (path.endsWith("/discard")) { discarded.push(path); return { result: { discarded: true } }; }
    return base(path, init);
  };
  const r = await render();
  await r.press("Discard");
  await settle();
  assert.deepEqual(discarded, ["/v1/capture/direct-sessions/cs-1/discard"]);
  assert.ok(FRAMES.every((f) => globalThis.__DELETED__.includes(f.uri)));
  assert.equal(await M.loadPendingScreenStaging(), null);
});
