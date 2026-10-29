/**
 * CAPTURE REMEDIATION (2026-10-29) — the canonical Capture screen, rendered
 * for real over a scripted API:
 *
 *   - two pending records coexist, each with its own Resume / Discard, and a
 *     Discard releases THAT record's server session only;
 *   - a resumed screen recording + a file ⇒ the mixed-origin guard blocks and
 *     offers a SEPARATE linked record (never staged into the screen session);
 *   - a restart after resume still seals through continuous-complete (the
 *     acquisition survives the resume re-save);
 *   - location off ⇒ NOT_REQUESTED; on + denied ⇒ asked, never silent;
 *   - a resumed session's parts are allocated by the server's list, and a
 *     PART_ALREADY_DECLARED refusal is re-read and retried.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let mounted = [];

before(async () => {
  M = await loadModule("app/(stack)/capture.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/capture/capture-session-store.ts",
  ]);
});

beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/capture/intake-templates": () => ({ templates: [] }),
    "/v1/capture/sessions?status=DRAFT": () => ({ sessions: [] }),
    "/v1/capture/sessions": (_p, init) => ({ session: { id: init.method === "POST" ? "draft-new" : "draft-x", status: "DRAFT" } }),
    "/v1/evidence?scope=active": () => ({ items: [] }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path, init) : undefined;
    if (res && res.__status) {
      return new Response(JSON.stringify(res.body), { status: res.__status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), {
      status: res === undefined ? 500 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.__DOC_PICK__ = { canceled: false, assets: [{ uri: "file:///cache/claim.pdf", name: "claim.pdf", mimeType: "application/pdf", size: 2048 }] };
  await M.AsyncStorage.__reset?.();
  await signIn(M);
  // The durable store is per user; the signed-in fixture is user-1.
  M.setCaptureSessionOwner("user-1");
});

afterEach(() => {
  delete globalThis.__DOC_PICK__;
  delete globalThis.__ALERT__;
  delete globalThis.__LOCATION__;
  for (const r of mounted) r.unmount?.() ?? r.renderer?.unmount();
  mounted = [];
});

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r.renderer);
  await settle();
  return r;
};

const SCREEN_RECORD = (over = {}) => ({
  captureSessionId: "cs-screen",
  expiresAtUtc: "2099-01-01T00:00:00.000Z",
  evidenceId: "ev-screen",
  draftId: null,
  type: "VIDEO",
  items: [
    // Saved by an OLDER build: no itemSourceLabel on the item. Its origin must
    // be restored from the acquisition, or the guard is inert.
    { id: "cs-screen", uri: "", mimeType: "video/mp4", partIndex: 0, originalFilename: "screen-recording.mp4", source: "SCREEN_RECORDING", uploaded: true },
  ],
  acquisition: { mode: "DIRECT_SCREEN_CAPTURE_IOS", manifestJson: "{\"recordingLayout\":\"SINGLE_FILE\"}" },
  location: { useLocation: true, outcome: "GRANTED", recordedAtStart: true },
  ...over,
});

const sealRoutes = (evidenceId) => {
  routes["/v1/capture/direct-sessions"] = (p) => {
    if (p === "/v1/capture/direct-sessions") return { session: { captureSessionId: "cs-new", expiresAtUtc: "2099-01-01T00:00:00.000Z" } };
    if (p.endsWith("/evidence")) return { evidence: { evidenceId } };
    if (p.endsWith("/declaration")) return { declaration: {} };
    if (p.endsWith("/complete") || p.endsWith("/continuous-complete")) return { result: { evidenceId } };
    if (p.endsWith("/discard")) return { result: { discarded: true } };
    return undefined;
  };
  routes[`/v1/evidence/${evidenceId}/parts`] = () => ({ upload: { putUrl: "https://storage.test/put" } });
  routes[`/v1/evidence/${evidenceId}/artifacts/status`] = () => ({ outputs: { report: { state: "READY" } } });
  routes[`/v1/evidence/${evidenceId}`] = () => ({ evidence: { id: evidenceId, tsaStatus: "STAMPED", tsaTokenPresent: true } });
};

test("two pending records coexist, each with its own Resume / Discard; Discard releases only that one", async () => {
  sealRoutes("ev-screen");
  await M.saveCaptureSession(SCREEN_RECORD());
  await M.saveCaptureSession(SCREEN_RECORD({ captureSessionId: "cs-other", evidenceId: "ev-other", acquisition: { mode: "DIRECT_SCREEN_CAPTURE_ANDROID", manifestJson: "{}" } }));
  const r = await render();
  assert.equal(r.byTestId("capture-pending-record").length, 2, r.texts().join(" / "));
  assert.ok(r.hasText("2 unfinished captures"));
  await r.press("Discard Screen capture");
  await settle();
  const discards = requests.filter((q) => q.method === "POST" && q.path.endsWith("/discard")).map((q) => q.path);
  assert.deepEqual(discards, ["/v1/capture/direct-sessions/cs-other/discard"]);
  assert.deepEqual((await M.loadCaptureSessions()).map((x) => x.captureSessionId), ["cs-screen"]);
  assert.equal(r.byTestId("capture-pending-record").length, 1);
});

test("a resumed screen recording + a file: the guard blocks and offers a SEPARATE linked record", async () => {
  sealRoutes("ev-screen");
  await M.saveCaptureSession(SCREEN_RECORD());
  const r = await render();
  await r.press("Resume");
  await settle();
  assert.ok(r.texts().some((t) => t.includes("Location recorded at the start of the recording.")), "the carried location is not stated");
  await r.press("Files");
  await settle();
  assert.ok(r.hasText("Screen recordings are sealed as their own evidence record. Add this as a separate record linked to this recording?"));
  // Nothing was staged into the screen session.
  assert.equal(requests.filter((q) => q.path.startsWith("/v1/capture/sessions") && q.method !== "GET").length, 0);
  await r.press("Add as a separate linked record");
  await settle();
  // A NEW draft holds the file; the recording is still a pending record of its own, in a link group.
  assert.ok(requests.some((q) => q.method === "POST" && q.path === "/v1/capture/sessions"));
  const records = await M.loadCaptureSessions();
  const screen = records.find((x) => x.captureSessionId === "cs-screen");
  assert.ok(screen, "the recording's record was lost");
  assert.ok(screen.linkGroupId, "the recording joined no link group");
  assert.equal(screen.acquisition.mode, "DIRECT_SCREEN_CAPTURE_IOS");
  const file = records.find((x) => x.draftId === "draft-new");
  assert.equal(file?.linkGroupId, screen.linkGroupId);
  assert.equal(file.acquisition, null);
  assert.equal(r.byTestId("capture-pending-record").length, 1, "the recording is not offered as pending");
});

test("a restart after resume still seals through continuous-complete", async () => {
  sealRoutes("ev-screen");
  await M.saveCaptureSession(SCREEN_RECORD());
  const first = await render();
  await first.press("Resume");
  await settle(); // the resume re-save runs here
  first.renderer.unmount();
  mounted = [];
  // The re-saved record still names its acquisition.
  const [saved] = await M.loadCaptureSessions();
  assert.equal(saved.acquisition?.mode, "DIRECT_SCREEN_CAPTURE_IOS", "the resume re-save wiped the manifest");
  const r = await render();
  await r.press("Resume");
  await settle();
  await r.press("Finish & Sign (1)");
  await settle();
  assert.ok(requests.some((q) => q.method === "POST" && q.path === "/v1/capture/direct-sessions/cs-screen/continuous-complete"));
  assert.ok(!requests.some((q) => q.path === "/v1/capture/direct-sessions/cs-screen/complete"), "sealed through /complete (MANIFEST_SEAL_ROUTE_REQUIRED)");
});

test("location OFF ⇒ the reservation says NOT_REQUESTED", async () => {
  sealRoutes("ev-1");
  const r = await render();
  await r.press("Files");
  await settle();
  await r.press("Finish & Sign (1)");
  await settle();
  const reserve = requests.find((q) => q.path === "/v1/capture/direct-sessions/cs-new/evidence");
  assert.equal(reserve.body.locationRequestOutcome, "NOT_REQUESTED");
  assert.equal(reserve.body.gps, undefined);
});

test("location ON: the toggle states the device's answer at once; a denial at Finish is ASKED, and proceeding records DENIED", async () => {
  sealRoutes("ev-1");
  globalThis.__LOCATION__ = { granted: false };
  const asked = [];
  globalThis.__ALERT__ = (title, message, buttons) => {
    asked.push(buttons.map((b) => b.text));
    buttons.find((b) => b.text === "Finish without location").onPress();
  };
  const r = await render();
  const toggle = r.byLabel("Include location metadata").find((n) => n.props.onValueChange);
  await act(async () => toggle.props.onValueChange(true));
  await settle();
  assert.ok(r.texts().some((t) => t.includes("Location permission is off for PROOVRA")), r.texts().join(" / "));
  await r.press("Files");
  await settle();
  await r.press("Finish & Sign (1)");
  await settle();
  assert.deepEqual(asked, [["Retry", "Finish without location", "Cancel"]]);
  const reserve = requests.find((q) => q.path === "/v1/capture/direct-sessions/cs-new/evidence");
  assert.equal(reserve.body.locationRequestOutcome, "DENIED");
});

test("location ON + Cancel at Finish reserves nothing", async () => {
  sealRoutes("ev-1");
  globalThis.__LOCATION__ = { fail: true };
  globalThis.__ALERT__ = (_t, _m, buttons) => buttons.find((b) => b.text === "Cancel").onPress();
  const r = await render();
  const toggle = r.byLabel("Include location metadata").find((n) => n.props.onValueChange);
  await act(async () => toggle.props.onValueChange(true));
  await r.press("Files");
  await settle();
  await r.press("Finish & Sign (1)");
  await settle();
  assert.equal(requests.filter((q) => q.path.startsWith("/v1/capture/direct-sessions")).length, 0);
  assert.ok(r.hasText("Finish cancelled. Nothing was reserved; your items are still staged."));
});

test("a resumed session's new part goes after the server's parts, and PART_ALREADY_DECLARED is re-read and retried", async () => {
  sealRoutes("ev-1");
  globalThis.__FS__ = undefined;
  let serverParts = [{ partIndex: 0, sha256: "a", state: "UPLOADED", source: "CAMERA" }, { partIndex: 1, sha256: "b", state: "DECLARED", source: "CAMERA" }];
  const declaredAt = [];
  const base = routes["/v1/capture/direct-sessions"];
  routes["/v1/capture/direct-sessions"] = (p, init) => {
    if (p === "/v1/capture/direct-sessions/cs-old/parts") return { parts: serverParts };
    const m = p.match(/\/parts\/(\d+)\/declaration$/);
    if (m) {
      declaredAt.push(Number(m[1]));
      if (m[1] === "2") {
        serverParts = [...serverParts, { partIndex: 2, sha256: "c", state: "DECLARED", source: "CAMERA" }];
        return { __status: 409, body: { denial: "PART_ALREADY_DECLARED", message: "Part 2 is already declared." } };
      }
    }
    return base(p, init);
  };
  await M.saveCaptureSession({
    captureSessionId: "cs-old",
    expiresAtUtc: "2099-01-01T00:00:00.000Z",
    evidenceId: "ev-1",
    draftId: "draft-old",
    type: "DOCUMENT",
    items: [
      { id: "a", uri: "file:///cache/a.pdf", mimeType: "application/pdf", partIndex: 0, source: "FILE_PICKER", uploaded: true },
      { id: "b", uri: "file:///cache/b.pdf", mimeType: "application/pdf", partIndex: 1, source: "FILE_PICKER", uploaded: false },
    ],
  });
  const r = await render();
  await r.press("Resume");
  await settle();
  await r.press("Finish & Sign (2)");
  await settle();
  assert.deepEqual(declaredAt, [2, 3], `declared at ${JSON.stringify(declaredAt)}`);
  assert.ok(requests.some((q) => q.path === "/v1/capture/direct-sessions/cs-old/complete"));
});
