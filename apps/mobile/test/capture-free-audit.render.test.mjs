/**
 * Free audit — the canonical Capture screen, rendered for real over a scripted
 * API (the real apiFetch with fetch replaced):
 *
 *   F-06  a failed draft call no longer drops the item just captured: it is
 *         staged, the error says it is kept, and Retry opens the draft;
 *   F-04  a record-limit refusal at Finish names its next step ("View plans"
 *         → the native Billing screen) instead of a bare sentence;
 *   F-11  the ordinary Finish path retries a dropped PUT at the same part and
 *         completes once.
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
let draftFails = 0;
let putFails = 0;

before(async () => {
  M = await loadModule("app/(stack)/capture.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/capture/capture-session-store.ts",
  ]);
});

beforeEach(async () => {
  requests = [];
  draftFails = 0;
  putFails = 0;
  routes = {
    ...authenticatedRoutes(),
    "/v1/capture/intake-templates": () => ({ templates: [] }),
    "/v1/capture/sessions?status=DRAFT": () => ({ sessions: [] }),
    "/v1/capture/sessions": (_p, init) => {
      if (init.method === "POST" && draftFails > 0) {
        draftFails -= 1;
        return { __status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "busy" } } };
      }
      return { session: { id: "draft-new", status: "DRAFT" } };
    },
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
  // The storage PUT (expo-file-system uploadAsync in the expo stub).
  globalThis.__UPLOAD_ASYNC__ = async (putUrl) => {
    requests.push({ path: putUrl, method: "PUT" });
    if (putFails > 0) {
      putFails -= 1;
      throw new TypeError("Network request failed");
    }
    return { status: 200 };
  };
  globalThis.__DOC_PICK__ = { canceled: false, assets: [{ uri: "file:///cache/claim.pdf", name: "claim.pdf", mimeType: "application/pdf", size: 2048 }] };
  await M.AsyncStorage.__reset?.();
  M.calls.reset();
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

const sealRoutes = (evidenceId, reserve) => {
  routes["/v1/capture/direct-sessions"] = (p) => {
    if (p === "/v1/capture/direct-sessions") return { session: { captureSessionId: "cs-new", expiresAtUtc: "2099-01-01T00:00:00.000Z" } };
    if (p.endsWith("/evidence")) return reserve ? reserve() : { evidence: { evidenceId } };
    if (p.endsWith("/declaration")) return { declaration: {} };
    if (p.endsWith("/complete")) return { result: { evidenceId } };
    if (p.endsWith("/discard")) return { result: { discarded: true } };
    return undefined;
  };
  routes[`/v1/evidence/${evidenceId}/parts`] = () => ({ upload: { putUrl: "https://storage.test/put" } });
  routes[`/v1/evidence/${evidenceId}/artifacts/status`] = () => ({ outputs: { report: { state: "READY" } } });
  routes[`/v1/evidence/${evidenceId}`] = () => ({ evidence: { id: evidenceId, tsaStatus: "STAMPED", tsaTokenPresent: true } });
};

test("F-06: a failed draft call keeps the picked file staged and offers Retry", async () => {
  draftFails = 1;
  const r = await render();
  await r.press("Files");
  await settle();
  assert.ok(r.byLabel("Finish & Sign (1)").length > 0, `the item was dropped: ${r.texts().join(" / ")}`);
  assert.ok(r.texts().some((t) => t.includes("Your item is kept on this device")), r.texts().join(" / "));
  await r.press("Retry");
  await settle();
  assert.equal(requests.filter((q) => q.method === "POST" && q.path === "/v1/capture/sessions").length, 2, "Retry did not open the draft");
  assert.ok(!r.texts().some((t) => t.includes("Your item is kept on this device")), "the error outlived a successful retry");
  assert.ok(r.byLabel("Finish & Sign (1)").length > 0);
});

test("F-04: a Free record-limit refusal at Finish offers View plans → the Billing screen", async () => {
  sealRoutes("ev-1", () => ({ __status: 409, body: { denial: "FREE_LIMIT_REACHED" } }));
  const r = await render();
  await r.press("Files");
  await settle();
  await r.press("Finish & Sign (1)");
  await r.press("Sign and finalize");
  await settle();
  assert.ok(r.texts().some((t) => t.includes("Free plan includes")), r.texts().join(" / "));
  await r.press("View plans");
  assert.equal(M.calls.push.at(-1), "/billing");
});

test("F-11: a dropped PUT on the ordinary Finish path is retried at the same part; one completion", async () => {
  sealRoutes("ev-1");
  putFails = 1;
  const r = await render();
  await r.press("Files");
  await settle();
  await r.press("Finish & Sign (1)");
  await r.press("Sign and finalize");
  // The retry waits a jittered backoff (≤ 1 s) before the second PUT.
  for (let i = 0; i < 30 && !requests.some((q) => q.path.endsWith("/complete")); i += 1) {
    await act(async () => { await new Promise((x) => setTimeout(x, 100)); });
  }
  await settle();
  assert.equal(requests.filter((q) => q.method === "PUT").length, 2, "the dropped PUT was not retried");
  const declarations = requests.filter((q) => q.path.endsWith("/declaration")).map((q) => q.path);
  assert.equal(new Set(declarations).size, 1, `declared at more than one part: ${declarations.join(", ")}`);
  assert.equal(requests.filter((q) => q.path === "/v1/capture/direct-sessions/cs-new/complete").length, 1);
});
