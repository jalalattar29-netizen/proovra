/**
 * MOBILE-003 / INGEST-009 — a capture is never filed into a workspace nobody
 * confirmed.
 *
 * A null activeTeamId used to mean both "personal" and "unknown". When
 * /v1/platform/context failed, Capture sent no teamId, and the server files that
 * in the caller's Personal Space (capture-trust.routes.ts:413-420). An
 * organization member's evidence then sat outside the organization.
 *
 * Each test runs the real screen over the real apiFetch. The negative control is
 * a failing context. The positive controls are an organization workspace (named
 * explicitly in the request) and a confirmed Personal Space (omitted, because
 * that is the server's documented form for Personal).
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, platformContextEnvelope, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let Capture;
let Screen;
let Continuous;
let routes = {};
let requests = [];
let contextUp = true;
let personal = false;

const PERSONAL_ENVELOPE = platformContextEnvelope({
  activeSpace: { id: null, type: "PERSONAL", plan: "FREE", displayName: "Personal Space" },
});
const envelope = () => (personal ? PERSONAL_ENVELOPE : platformContextEnvelope());

const FRAME = { uri: "file:///cache/f0.png", frameIndex: 0, widthPx: 1080, heightPx: 2400, capturedAtOffsetMs: 0 };
const NATIVE_RESULT = {
  osConsentGranted: true,
  captureStartedAtUtc: "2026-09-30T10:00:00.000Z",
  captureEndedAtUtc: "2026-09-30T10:00:02.000Z",
  device: { platform: "android", osVersion: "14", model: "Pixel 7", appVersion: "1.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" },
  frames: [FRAME],
  stopReason: "USER_STOPPED",
  limitations: [],
};

function installNative() {
  globalThis.__NATIVE_MODULES__ = {
    ProovraScreenCapture: {
      isSupported: () => true,
      isContinuousSupported: () => true,
      getState: () => ({ active: false, frameCount: 0 }),
      getContinuousState: () => ({ active: false, segmentCount: 0 }),
      getContinuousSegments: () => [],
      listContinuousRecordings: () => [],
      startCapture: async () => ({ osConsentGranted: true, captureStartedAtUtc: "2026-09-30T10:00:00.000Z", maxFrames: 20 }),
      stopCapture: async () => NATIVE_RESULT,
      startContinuousCapture: async () => ({ recordingId: "rec-1" }),
      stopContinuousCapture: async () => ({}),
      bindContinuousSession: async () => true,
      discardContinuousSpool: async () => {},
    },
  };
}

before(async () => {
  const extras = ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/platform-context.ts"];
  Capture = await loadModule("app/(stack)/capture.tsx", extras);
  Screen = await loadModule("app/(stack)/screen-capture.tsx", extras);
  Continuous = await loadModule("app/(stack)/continuous-capture.tsx", extras);
});

beforeEach(async () => {
  requests = [];
  contextUp = true;
  personal = false;
  globalThis.__RN_OS__ = "android";
  globalThis.__RN_VERSION__ = 34;
  globalThis.__PERMISSION_RESULT__ = "granted";
  globalThis.__PERMISSION_REQUESTS__ = [];
  installNative();
  routes = authenticatedRoutes({
    "/v1/capture/sessions": () => ({ session: { id: "draft-1", status: "DRAFT" } }),
    "/v1/capture/direct-sessions": (path) => {
      if (path.endsWith("/evidence")) return { evidence: { evidenceId: "ev-1" } };
      if (path.includes("/declaration")) return { declaration: { partIndex: 0 }, session: { expiresAtUtc: "2030-01-01T00:00:00.000Z" } };
      return { session: { captureSessionId: "cs-1", expiresAtUtc: "2030-01-01T00:00:00.000Z" } };
    },
    "/v1/evidence/ev-1/parts": () => ({ upload: { putUrl: "https://store.invalid/put", bucket: "b", key: "k" } }),
  });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    if (path === "/v1/platform/context") {
      return contextUp
        ? new Response(JSON.stringify(envelope()), { status: 200 })
        : new Response(JSON.stringify({ message: "down" }), { status: 503 });
    }
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path, init) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res === undefined ? 500 : 200 });
  };
  for (const m of [Capture, Screen, Continuous]) {
    m.AsyncStorage.__reset();
    await signIn(m);
  }
});

const settle = async () => {
  for (let i = 0; i < 14; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mounted = [];
const render = async (M) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
afterEach(async () => {
  for (const r of mounted.splice(0)) await act(async () => r.renderer.unmount());
  delete globalThis.__RN_OS__;
  delete globalThis.__RN_VERSION__;
});

const posts = (path) => requests.filter((q) => q.method === "POST" && q.path === path);
const opens = () => posts("/v1/capture/direct-sessions");
const drafts = () => posts("/v1/capture/sessions");

/** The screen's own document pick: it stages exactly as a tapped file does. */
const stageFile = async (M, r) => {
  globalThis.__DOC_PICK__ = {
    canceled: false,
    assets: [{ uri: "file:///cache/doc.pdf", name: "doc.pdf", mimeType: "application/pdf", size: 10 }],
  };
  await r.press("Files");
  await settle();
};

test("Capture says where the record will go", async () => {
  const r = await render(Capture);
  assert.deepEqual(r.byTestId("capture-destination").length, 1);
  assert.ok(r.hasText("Saving to Test Workspace"));
});

test("a failed context is said on Capture, with a way to retry, and retrying recovers", async () => {
  contextUp = false;
  const r = await render(Capture);
  assert.equal(r.byTestId("capture-destination-unavailable").length, 1);
  assert.equal(r.byTestId("capture-destination").length, 0);
  contextUp = true;
  await r.press("Check workspace again");
  await settle();
  assert.ok(r.hasText("Saving to Test Workspace"));
});

test("an item staged while the workspace is unknown stays staged, and opens no Personal draft", async () => {
  contextUp = false;
  const r = await render(Capture);
  await stageFile(Capture, r);
  assert.equal(drafts().length, 0, "a draft opened now would default to Personal");
  assert.ok(r.hasText("doc.pdf"), "the item must stay staged");

  // Once confirmed, the draft opens in the real workspace.
  contextUp = true;
  await r.press("Check workspace again");
  await settle();
  assert.equal(drafts().length, 1);
  assert.equal(drafts()[0].body.teamId, TEST_TEAM_ID);
});

test("Finish with an unknown workspace reserves nothing and loses nothing", async () => {
  contextUp = false;
  const r = await render(Capture);
  await stageFile(Capture, r);
  await r.press("Finish & Sign (1)");
  await settle();
  assert.equal(opens().length, 0, "no session may open against an unknown workspace");
  assert.equal(requests.filter((q) => q.path.includes("/evidence")).length, 0);
  assert.ok(r.hasText("doc.pdf"));
  assert.ok(r.hasText("could not confirm which workspace"));
});

test("positive control: Finish in an organization names it", async () => {
  const r = await render(Capture);
  await stageFile(Capture, r);
  await r.press("Finish & Sign (1)");
  await settle();
  assert.equal(opens().length, 1);
  assert.equal(opens()[0].body.teamId, TEST_TEAM_ID);
  assert.equal(drafts()[0].body.teamId, TEST_TEAM_ID);
});

test("positive control: a CONFIRMED Personal Space still omits teamId", async () => {
  personal = true;
  const r = await render(Capture);
  assert.ok(r.hasText("Saving to Personal Space"));
  await stageFile(Capture, r);
  await r.press("Finish & Sign (1)");
  await settle();
  assert.equal(opens().length, 1);
  assert.equal("teamId" in opens()[0].body, false);
});

test("a switch after staging does not move the session", async () => {
  const r = await render(Capture);
  await stageFile(Capture, r);
  personal = true;
  await act(async () => { Capture.refreshPlatformContext(); });
  await settle();
  await r.press("Finish & Sign (1)");
  await settle();
  assert.equal(opens()[0].body.teamId, TEST_TEAM_ID, "it files where the draft was opened");
  assert.ok(r.hasText("Saving to Test Workspace"));
});

test("Direct Screen Capture cannot start into an unknown workspace", async () => {
  contextUp = false;
  const r = await render(Screen);
  assert.equal(r.byTestId("capture-destination-unavailable").length, 1);
  await r.press("Start Screen Capture");
  await settle();
  assert.deepEqual(globalThis.__PERMISSION_REQUESTS__, [], "nothing started");
  assert.equal(opens().length, 0);
});

test("positive control: Direct Screen Capture names the workspace it started in", async () => {
  const r = await render(Screen);
  assert.ok(r.hasText("Saving to Test Workspace"));
  await r.press("Start Screen Capture");
  await settle();
  await r.press("Stop & Review");
  await settle();
  // The context failing now cannot change where this capture goes.
  contextUp = false;
  await r.press("Add to capture session");
  await settle();
  assert.equal(opens()[0].body.teamId, TEST_TEAM_ID);
  assert.equal(drafts()[0].body.teamId, TEST_TEAM_ID);
});

test("Continuous Capture cannot start into an unknown workspace", async () => {
  contextUp = false;
  const r = await render(Continuous);
  assert.equal(r.byTestId("capture-destination-unavailable").length, 1);
  await r.press("Start Continuous Capture");
  await settle();
  assert.equal(opens().length, 0);
});

test("positive control: Continuous Capture names the workspace it started in", async () => {
  const r = await render(Continuous);
  assert.ok(r.hasText("Saving to Test Workspace"));
  await r.press("Start Continuous Capture");
  await settle();
  assert.equal(opens().length, 1);
  assert.equal(opens()[0].body.teamId, TEST_TEAM_ID);
});
