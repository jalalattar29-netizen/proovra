/**
 * PRO-NB-05 — captured media do not outlive their purpose, and never go early.
 *
 * On the real Capture screen over a scripted API:
 *   - allowed: once the record is SEALED (the server holds every part) the
 *     app-cache copy of the captured file is deleted;
 *   - refused: a Finish that fails (the server refused the declaration) keeps
 *     the device copy — it may be the only one (DEC-24);
 *   - refused: a file outside the app's own cache (a picker's content:// source)
 *     is never deleted, even after a seal.
 * Sign-out keeping every file is proved in capture-teardown.test.mjs.
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
const waitFor = async (done) => {
  for (let i = 0; i < 40 && !done(); i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 50)); });
  await settle();
};

function finishRoutes(declare) {
  routes["/v1/capture/direct-sessions"] = (p) => {
    if (p === "/v1/capture/direct-sessions") return { session: { captureSessionId: "cs-1", expiresAtUtc: "2099-01-01T00:00:00.000Z" } };
    if (p.endsWith("/evidence")) return { evidence: { evidenceId: "ev-1" } };
    if (p.endsWith("/declaration")) return declare(p);
    if (p.endsWith("/complete")) return { result: { evidenceId: "ev-1" } };
    if (p.endsWith("/discard")) return { result: { discarded: true } };
    return undefined;
  };
  routes["/v1/evidence/ev-1/parts"] = () => ({ upload: { putUrl: "https://storage.test/put" } });
  routes["/v1/evidence/ev-1/artifacts/status"] = () => ({ outputs: { report: { state: "READY" } } });
  routes["/v1/evidence/ev-1"] = () => ({ evidence: { id: "ev-1", tsaStatus: "STAMPED", tsaTokenPresent: true } });
}

const completes = () => requests.filter((q) => q.method === "POST" && q.path === "/v1/capture/direct-sessions/cs-1/complete");

test("allowed: after the seal answers, the captured file's app-cache copy is deleted", async () => {
  finishRoutes(() => ({ declaration: {} }));
  const r = await render();
  await r.press("Files");
  await settle();
  assert.deepEqual(globalThis.__DELETED__, [], "a file was deleted before Finish");
  await r.press("Finish & Sign (1)");
  await r.press("Sign and finalize");
  await waitFor(() => completes().length > 0 && globalThis.__DELETED__.includes("file:///cache/claim.pdf"));

  assert.equal(completes().length, 1, "the record was not sealed");
  assert.ok(globalThis.__DELETED__.includes("file:///cache/claim.pdf"), "a sealed capture's device copy stayed in the app cache");
});

test("refused: a Finish the server refuses keeps the captured file on the device", async () => {
  finishRoutes(() => ({ __status: 400, body: { error: { code: "VALIDATION_ERROR", message: "bad declaration" } } }));
  const r = await render();
  await r.press("Files");
  await settle();
  await r.press("Finish & Sign (1)");
  await r.press("Sign and finalize");
  await waitFor(() => requests.some((q) => q.path.endsWith("/declaration")));
  await waitFor(() => false);

  assert.equal(completes().length, 0, "a refused declaration still sealed");
  assert.ok(!globalThis.__DELETED__.includes("file:///cache/claim.pdf"), "a failed Finish deleted the only copy of the capture");
});

test("refused: a picker source outside the app cache is never deleted, even after a seal", async () => {
  globalThis.__DOC_PICK__ = { canceled: false, assets: [{ uri: "content://picker/claim.pdf", name: "claim.pdf", mimeType: "application/pdf", size: 2048 }] };
  finishRoutes(() => ({ declaration: {} }));
  const r = await render();
  await r.press("Files");
  await settle();
  await r.press("Finish & Sign (1)");
  await r.press("Sign and finalize");
  await waitFor(() => completes().length > 0);
  await waitFor(() => false);

  assert.equal(completes().length, 1, "the record was not sealed");
  assert.ok(!globalThis.__DELETED__.includes("content://picker/claim.pdf"), "the person's own source file was deleted");
});
