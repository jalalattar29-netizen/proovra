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
  M = await loadModule("app/(stack)/screen-capture.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
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

test("UC-AND-010: staging deletes each screenshot after its upload, and the manifest file", async () => {
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
