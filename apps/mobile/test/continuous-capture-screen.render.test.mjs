/**
 * The Continuous Screen Capture screen, rendered for real (react-test-renderer)
 * over a scripted native module and a scripted API. Covers:
 *
 *   UC-AND-003  Android 13+: POST_NOTIFICATIONS is requested BEFORE the native
 *               start; a refusal explains the consequence and starts nothing.
 *   UC-STR-004  a refused OS consent opens NO server session; Discard / Try
 *               Again from an opened session DISCARD it on the server.
 *   UC-IOS-005  iOS waits for the broadcast to actually start; the session is
 *               opened only on the extension's `started` event.
 *   UC-IOS-011  the iOS intro speaks about Apple's picker / status bar, not
 *               Android's notification and restrictions.
 *   UC-PROV-010 the device-reported completeness is neutral, not "verified".
 *   UC-AND-004 / UC-IOS-010  a remounted screen REATTACHES to the persisted
 *               session of a live recording — no second session is opened.
 *   UC-STR-002  Stop reconciles recorded vs declared: a lost tail is shown as
 *               interrupted, never "complete".
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const native = { calls: [], state: {} };

const RESULT = {
  osConsentGranted: true,
  captureStartedAtUtc: "2026-09-30T10:00:00.000Z",
  captureEndedAtUtc: "2026-09-30T10:00:18.000Z",
  device: { platform: "android", osVersion: "14", model: "Pixel 7", appVersion: "1.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" },
  totalDurationMs: 18000,
  segmentCount: 3,
  sessionCompleteness: "COMPLETE_SESSION",
  terminationReason: "USER_STOPPED",
  limitations: [],
};

function installNative() {
  native.calls = [];
  native.state = {
    continuous: { active: false, segmentCount: 0 },
    segments: [],
    start: async () => ({ osConsentGranted: true, captureStartedAtUtc: "2026-09-30T10:00:00.000Z", segmentMs: 6000, maxSegments: 199 }),
    stop: async () => RESULT,
  };
  globalThis.__NATIVE_MODULES__ = {
    ProovraScreenCapture: {
      isSupported: () => true,
      isContinuousSupported: () => true,
      getState: () => ({ active: false, frameCount: 0 }),
      getContinuousState: () => native.state.continuous,
      getContinuousSegments: () => native.state.segments,
      startContinuousCapture: async (o) => {
        native.calls.push("startContinuousCapture");
        return native.state.start(o);
      },
      stopContinuousCapture: async () => {
        native.calls.push("stopContinuousCapture");
        return native.state.stop();
      },
      discardContinuousSpool: async () => native.calls.push("discardContinuousSpool"),
    },
  };
}

before(async () => {
  M = await loadModule("app/(stack)/continuous-capture.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(async () => {
  requests = [];
  globalThis.__RN_OS__ = "android";
  globalThis.__RN_VERSION__ = 34;
  globalThis.__PERMISSION_REQUESTS__ = [];
  globalThis.__PERMISSION_RESULT__ = "granted";
  installNative();
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/parts": () => ({ upload: { putUrl: "https://store.invalid/put", bucket: "b", key: "k" } }),
    "/v1/capture/direct-sessions": (path) => {
      if (path.includes("/declaration")) return { declaration: { partIndex: 0 }, session: { expiresAtUtc: "2026-09-30T11:30:00.000Z" } };
      if (path.endsWith("/evidence")) return { evidence: { evidenceId: "ev-1" } };
      if (path.endsWith("/discard")) return { result: { discarded: true, releasedEvidenceId: "ev-1" } };
      return { session: { captureSessionId: "cs-1", expiresAtUtc: "2026-09-30T11:00:00.000Z" } };
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path, init) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
  M.AsyncStorage.__reset();
  await signIn(M);
});

const mounted = [];
afterEach(async () => {
  // Unmount every screen so its native listeners leave the shared event bus.
  for (const r of mounted.splice(0)) await act(async () => r.renderer.unmount());
  delete globalThis.__RN_OS__;
  delete globalThis.__RN_VERSION__;
  delete globalThis.__PERMISSION_RESULT__;
});

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
/** The recorder finalises segment i: the screen uploads + declares it. */
const emitSegment = async (i) => {
  await act(async () =>
    globalThis.__emitNative("onScreenSegment", {
      uri: `file:///cache/proovra-continuous-1-${i}.mp4`,
      sequence: i,
      startedAtOffsetMs: i * 6000,
      durationMs: 6000,
      widthPx: 1080,
      heightPx: 2400,
      orientation: "portrait",
    }),
  );
  await settle();
};
const opens = () => requests.filter((q) => q.method === "POST" && q.path === "/v1/capture/direct-sessions");
const discards = () => requests.filter((q) => q.method === "POST" && q.path.endsWith("/discard"));

test("UC-AND-003: Android 13+ asks for POST_NOTIFICATIONS before the native start", async () => {
  const r = await render();
  await r.press("Start Continuous Capture");
  await settle();
  assert.deepEqual(globalThis.__PERMISSION_REQUESTS__, ["android.permission.POST_NOTIFICATIONS"]);
  assert.deepEqual(native.calls, ["startContinuousCapture"]);
  assert.equal(opens().length, 1, "the session opens once the OS is recording");
});

test("UC-AND-003: a refused notification permission explains the consequence and starts nothing until confirmed", async () => {
  globalThis.__PERMISSION_RESULT__ = "denied";
  const r = await render();
  await r.press("Start Continuous Capture");
  await settle();
  assert.ok(r.hasText("Notifications are off"), "the refusal was not explained");
  assert.ok(r.texts().some((t) => t.includes("you will have to return to PROOVRA to stop it")));
  assert.deepEqual(native.calls, [], "the recording started without the notification being acknowledged");
  assert.equal(opens().length, 0);
  await r.press("Continue without the notification");
  await settle();
  assert.deepEqual(native.calls, ["startContinuousCapture"]);
});

test("UC-AND-003: below Android 13 there is no runtime request", async () => {
  globalThis.__RN_VERSION__ = 31;
  const r = await render();
  await r.press("Start Continuous Capture");
  await settle();
  assert.deepEqual(globalThis.__PERMISSION_REQUESTS__, []);
  assert.deepEqual(native.calls, ["startContinuousCapture"]);
});

test("UC-STR-004: a refused OS consent opens no server session and reserves no record", async () => {
  native.state.start = async () => {
    throw Object.assign(new Error("Screen capture consent was not granted."), { code: "PERMISSION_DENIED" });
  };
  const r = await render();
  await r.press("Start Continuous Capture");
  await settle();
  assert.equal(opens().length, 0, "a session was opened for a recording the OS never started");
  assert.ok(r.hasText("Try Again"));
});

test("UC-STR-004: Discard from an opened session discards it on the server and releases the spool", async () => {
  const r = await render();
  await r.press("Start Continuous Capture");
  await settle();
  assert.equal(opens().length, 1);
  native.state.continuous = { active: false, segmentCount: 0 };
  await r.press("Stop & Review");
  await settle();
  await r.press("Discard");
  await settle();
  assert.equal(discards().length, 1, "Discard left the server session and its reserved record open");
  assert.equal(discards()[0].path, "/v1/capture/direct-sessions/cs-1/discard");
  assert.ok(native.calls.includes("discardContinuousSpool"));
});

test("UC-IOS-005: iOS waits for the broadcast to start; the session opens only on the extension's started event", async () => {
  globalThis.__RN_OS__ = "ios";
  native.state.start = async () => ({ osConsentGranted: false, captureStartedAtUtc: null, awaitingSystemStart: true, segmentMs: 6000, maxSegments: 199 });
  const r = await render();
  await r.press("Start Continuous Capture");
  await settle();
  assert.ok(r.hasText("Waiting for Start Broadcast"));
  assert.ok(!r.hasText("Continuous capture active"), "the picker was treated as a start");
  assert.equal(opens().length, 0);
  assert.deepEqual(globalThis.__PERMISSION_REQUESTS__, [], "iOS has no notification permission to ask for");
  await act(async () => globalThis.__emitNative("onScreenContinuousStarted", { captureStartedAtUtc: "2026-09-30T10:00:01Z" }));
  await settle();
  assert.equal(opens().length, 1);
  assert.ok(r.hasText("Continuous capture active"));
});

test("UC-IOS-011: the iOS intro describes Apple's picker and controls — not Android's", async () => {
  globalThis.__RN_OS__ = "ios";
  const r = await render();
  const all = r.texts().join("\n");
  assert.ok(!/Android restrictions/.test(all), "iOS users are told about Android restrictions");
  assert.ok(!/capture notification/.test(all), "iOS users are told to use a notification iOS does not show");
  assert.ok(/status-bar recording indicator or Control Center/.test(all));
  assert.ok(/appears black: Apple does not let any app record it/.test(all));
});

test("UC-PROV-010 / UC-STR-002: the review states the device's own report neutrally, and a lost tail is interrupted", async () => {
  const r = await render();
  await r.press("Start Continuous Capture");
  await settle();
  // Three segments recorded, all declared → reported complete (neutral badge).
  for (const i of [0, 1, 2]) await emitSegment(i);
  await r.press("Stop & Review");
  await settle();
  const badge = r.root.findAll((n) => n.props?.label === "Reported complete by this device — no known interruption");
  assert.ok(badge.length > 0, "the neutral completeness wording is missing");
  assert.ok(badge.every((n) => n.props.tone !== "verified"), "a client claim is styled as verified");
  assert.ok(!r.hasText("Complete — no known interruption"));
});

test("UC-STR-002: recorded 3, none declared → the review says interrupted, never complete", async () => {
  native.state.stop = async () => ({ ...RESULT, segmentCount: 3 });
  const r = await render();
  await r.press("Start Continuous Capture");
  await settle();
  await r.press("Stop & Review");
  await settle();
  assert.ok(r.root.findAll((n) => n.props?.label?.startsWith?.("Interrupted")).length > 0);
});

test("UC-AND-004 / UC-IOS-010: a remounted screen reattaches to the live recording's persisted session", async () => {
  // A first mount opens the session and persists it…
  const first = await render();
  await first.press("Start Continuous Capture");
  await settle();
  assert.equal(opens().length, 1);
  await act(async () => first.renderer.unmount());
  mounted.splice(mounted.indexOf(first), 1);
  // …the recorder keeps going while the UI is gone…
  native.state.continuous = { active: true, segmentCount: 2 };
  native.state.segments = [];
  // …and a NEW mount reattaches: no second session, the active state shown.
  const second = await render();
  assert.equal(opens().length, 1, "a second server session was opened over a live recording");
  assert.ok(second.hasText("Continuous capture active"), second.texts().join(" / "));
});
