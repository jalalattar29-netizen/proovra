/**
 * PRO-NB-01 — the SCREEN-LEVEL paths of the native capture lifetime fix, on the
 * real Capture screen over a scripted API (the review found them untested):
 *
 *   - refreshPendingRecords: a stale record whose files are still on the
 *     device has its server session released, and its files are KEPT as a
 *     device-only record in the workspace it was bound to — never forgotten;
 *   - the same, when the server answers that it KEPT the session because it
 *     holds staged content: the device record is left exactly as it was;
 *   - Finish re-open: a session the server closed is re-opened by the next
 *     Finish with a new session, the items still staged;
 *   - review gap 2: a record that is already SEALED is not a gone session —
 *     nothing is re-opened under the sealed record's ids.
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
    "src/capture/capture-retry.ts",
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
  globalThis.__UPLOAD_ASYNC__ = async (putUrl) => {
    requests.push({ path: putUrl, method: "PUT" });
    return { status: 200 };
  };
  globalThis.__DOC_PICK__ = { canceled: false, assets: [{ uri: "file:///cache/claim.pdf", name: "claim.pdf", mimeType: "application/pdf", size: 2048 }] };
  globalThis.__DELETED__ = [];
  await M.AsyncStorage.__reset?.();
  await signIn(M);
  M.setCaptureSessionOwner("user-1");
});

afterEach(() => {
  delete globalThis.__DOC_PICK__;
  delete globalThis.__UPLOAD_ASYNC__;
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

const WORKSPACE = { teamId: "team-7", name: "Field team" };
// Stale by the device's last-heard expiry, nothing uploaded: the file is on the device.
const STALE_LOCAL = {
  captureSessionId: "cs-old",
  expiresAtUtc: "2020-01-01T00:00:00.000Z",
  evidenceId: "ev-old",
  draftId: null,
  type: "PHOTO",
  items: [{ id: "i1", uri: "file:///cache/photo.jpg", mimeType: "image/jpeg", partIndex: 0, source: "CAMERA", uploaded: false, originalFilename: "photo.jpg" }],
  workspace: WORKSPACE,
};

test("refreshPendingRecords: a stale record's session is released and its files are kept as a device-only record in its own workspace", async () => {
  await M.saveCaptureSession(STALE_LOCAL);
  routes["/v1/capture/direct-sessions"] = (p) => (p.endsWith("/discard") ? { result: { discarded: true, releasedEvidenceId: "ev-old" } } : undefined);

  await render();

  const discards = requests.filter((q) => q.method === "POST" && q.path === "/v1/capture/direct-sessions/cs-old/discard");
  assert.equal(discards.length, 1, "the stale record's server session was not released");
  assert.deepEqual(discards[0].body, {}, "an automatic release must never carry the person's confirmation");
  const kept = await M.loadCaptureSessions();
  assert.equal(kept.length, 1, "the device forgot the capture");
  assert.ok(kept[0].captureSessionId.startsWith("local:"), `not a device-only record: ${kept[0].captureSessionId}`);
  assert.deepEqual(kept[0].items.map((it) => [it.uri, it.uploaded, it.partIndex]), [["file:///cache/photo.jpg", false, 0]]);
  assert.deepEqual(kept[0].workspace, WORKSPACE, "the record lost the workspace it was bound to (DEC-27)");
  assert.deepEqual(globalThis.__DELETED__, [], "a captured file was deleted");
});

test("refreshPendingRecords: when the server KEPT the session (it holds staged content) the device record is left as it was", async () => {
  await M.saveCaptureSession(STALE_LOCAL);
  routes["/v1/capture/direct-sessions"] = (p) =>
    p.endsWith("/discard")
      ? { result: { discarded: false, releasedEvidenceId: null, keptStagedContent: true, keptUntilUtc: "2099-01-01T00:00:00.000Z" } }
      : undefined;

  await render();

  const kept = await M.loadCaptureSessions();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].captureSessionId, "cs-old", "the device forgot a session the server still holds");
  assert.equal(kept[0].evidenceId, "ev-old");
  assert.deepEqual(globalThis.__DELETED__, []);
});

function finishRoutes(declare) {
  let opened = 0;
  routes["/v1/capture/direct-sessions"] = (p) => {
    if (p === "/v1/capture/direct-sessions") {
      opened += 1;
      return { session: { captureSessionId: `cs-${opened}`, expiresAtUtc: "2099-01-01T00:00:00.000Z" } };
    }
    if (p.endsWith("/evidence")) return { evidence: { evidenceId: `ev-${p.split("/")[4].slice(3)}` } };
    if (p.endsWith("/declaration")) return declare(p);
    if (p.endsWith("/complete")) return { result: { evidenceId: `ev-${p.split("/")[4].slice(3)}` } };
    if (p.endsWith("/discard")) return { result: { discarded: true } };
    return undefined;
  };
  for (const id of ["ev-1", "ev-2"]) {
    routes[`/v1/evidence/${id}/parts`] = () => ({ upload: { putUrl: "https://storage.test/put" } });
    routes[`/v1/evidence/${id}/artifacts/status`] = () => ({ outputs: { report: { state: "READY" } } });
    routes[`/v1/evidence/${id}`] = () => ({ evidence: { id, tsaStatus: "STAMPED", tsaTokenPresent: true } });
  }
}
const opens = () => requests.filter((q) => q.method === "POST" && q.path === "/v1/capture/direct-sessions");
const waitFor = async (done) => {
  for (let i = 0; i < 40 && !done(); i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 50)); });
  await settle();
};

test("Finish re-open: a session the server closed keeps the items staged and the next Finish files them through a new session", async () => {
  finishRoutes((p) => (p.includes("/cs-1/") ? { __status: 409, body: { denial: "CAPTURE_WINDOW_EXPIRED" } } : { declaration: {} }));
  const r = await render();
  await r.press("Files");
  await settle();
  await r.press("Finish & Sign (1)");
  await r.press("Sign and finalize");
  await waitFor(() => r.texts().some((t) => t.includes("The capture window closed")));

  assert.ok(r.texts().some((t) => t.includes("Nothing was lost")), r.texts().join(" / "));
  assert.ok(r.byLabel("Finish & Sign (1)").length > 0, "the item was dropped");
  assert.equal(opens().length, 1, "nothing is re-opened until the person asks");
  assert.deepEqual(globalThis.__DELETED__, [], "a captured file was deleted");
  assert.deepEqual(requests.filter((q) => q.path.endsWith("/discard")), [], "the closed session was discarded by the device");

  await r.press("Finish & Sign (1)");
  await r.press("Sign and finalize");
  await waitFor(() => requests.some((q) => q.path === "/v1/capture/direct-sessions/cs-2/complete"));
  assert.equal(opens().length, 2, "the next Finish did not open a new session");
  assert.equal(requests.filter((q) => q.path === "/v1/capture/direct-sessions/cs-2/complete").length, 1);
  assert.equal(requests.filter((q) => q.path === "/v1/capture/direct-sessions/cs-1/complete").length, 0);
});

test("review gap 2: EVIDENCE_NOT_OPEN because the record is SEALED is not a gone session", async () => {
  assert.equal(M.isRecordSealed({ code: "EVIDENCE_NOT_OPEN", body: { detail: "RECORD_SEALED" } }), true);
  assert.equal(M.isRecordSealed({ code: "EVIDENCE_NOT_OPEN", body: { detail: "RECORD_RELEASED" } }), false);
  assert.equal(M.isRecordSealed({ code: "EVIDENCE_NOT_OPEN" }), false, "an older API sends no detail: read as before");
  assert.equal(M.isSessionGone({ code: "EVIDENCE_NOT_OPEN" }), true);

  finishRoutes(() => ({ __status: 409, body: { denial: "EVIDENCE_NOT_OPEN", detail: "RECORD_SEALED" } }));
  const r = await render();
  await r.press("Files");
  await settle();
  await r.press("Finish & Sign (1)");
  await r.press("Sign and finalize");
  await waitFor(() => r.texts().some((t) => t.includes("already sealed")));

  assert.ok(r.texts().some((t) => t.includes("already sealed and is in your library")), r.texts().join(" / "));
  assert.ok(!r.texts().some((t) => t.includes("The capture window closed")), "a sealed record was reported as a closed window");
  // What the sealed record does not hold stays on the device as its own capture.
  assert.ok(r.byLabel("Finish & Sign (1)").length > 0);
  const kept = await M.loadCaptureSessions();
  assert.ok(kept.every((k) => k.captureSessionId !== "cs-1" && k.evidenceId !== "ev-1"), "the device still points at the sealed record's session");
  assert.equal(opens().length, 1);
  assert.deepEqual(globalThis.__DELETED__, []);
});
