/**
 * B7A-F-006 (free-audit 0ea0) — the record screen's "Signed with a withdrawn
 * key" notice, driven through the REAL screen and the REAL apiFetch (a flat
 * `{ code, message }` 409 must still read as the shared copy for its code).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { USER_FACING_ERRORS } from "@proovra/shared";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let B;
let routes = {};
let posts = [];
let postReply = null;
let statusReads = 0;
const ELIG = `/v1/governance/export-eligibility?teamId=${TEST_TEAM_ID}&evidenceId=ev-1`;
const READY = { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", version: 3, latestAvailableVersion: 3 };
const AVAILABLE = {
  outputs: { recordSignature: false, packageSeal: true, latestPackageSeal: true, custodyAttestations: false },
  replacement: "AVAILABLE",
  replacesReportVersion: 3,
  callerMayRequest: true,
};
const status = (keyCompromise) => () => ({
  outputs: {
    report: READY,
    verificationPackage: READY,
    newVersion: { action: "NONE", reason: "PAIR_INCOMPLETE", currentVersion: 3, nextVersion: 4, estimate: null },
    pollIntervalMs: null,
  },
  keyCompromise,
});

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  B = await loadModule("src/ui/runtime-status-banner.tsx");
});
beforeEach(async () => {
  B.resetServiceStatusForTests();
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  posts = [];
  statusReads = 0;
  postReply = {
    status: 202,
    body: { operation: "KEY_COMPROMISE_REPLACEMENT", requestId: "req-1", outcome: "ENQUEUED", replacesReportVersion: 3 },
  };
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/artifacts/status": status(AVAILABLE),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "REPORTED", type: "PHOTO" } }),
    [ELIG]: () => ({ outcome: "ALLOWED", reason: "ok", lifecycleState: "ACTIVE" }),
    "/v1/runtime/status": () => ({ status: "HEALTHY" }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") {
      posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify(postReply.body), { status: postReply.status, headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/evidence/ev-1/artifacts/status") statusReads += 1;
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), {
      status: res ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Artifacts");
  await settle();
  return r;
};

test("no keyCompromise on the status: no notice and no control", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = status(null);
  const r = await render();
  assert.equal(r.byTestId("key-compromise-notice").length, 0);
  assert.equal(r.byLabel("Request replacement").length, 0);
  r.unmount();
});

test("AVAILABLE to this caller: the shared sentences, the control posts the intent, the status is re-read", async () => {
  const r = await render();
  assert.equal(r.byTestId("key-compromise-notice").length, 1);
  assert.ok(r.hasText("Signed with a withdrawn key"));
  assert.ok(r.hasText("You can request a replacement of report version 3"));
  const readsBefore = statusReads;
  await r.press("Request replacement");
  await settle();
  assert.deepEqual(posts, [{ path: "/v1/evidence/ev-1/reports/regenerate", body: { intent: "KEY_COMPROMISE_REPLACEMENT" } }]);
  assert.ok(r.hasText("Replacement requested. It will appear in this record's versions when it is issued."));
  assert.ok(statusReads > readsBefore, "the screen re-read the artifact status after the 202");
  r.unmount();
});

test("a caller without permission sees the state but no control", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = status({ ...AVAILABLE, callerMayRequest: false });
  const r = await render();
  assert.equal(r.byTestId("key-compromise-notice").length, 1);
  assert.equal(r.byLabel("Request replacement").length, 0);
  assert.ok(r.hasText("can be requested by someone with permission to generate this record's outputs"));
  r.unmount();
});

test("a flat 409 refusal through the real apiFetch reads as the shared copy for its code", async () => {
  const code = "KEY_COMPROMISE_REPLACEMENT_NO_TRUSTWORTHY_SIGNER";
  postReply = { status: 409, body: { code, message: "raw server sentence" } };
  const r = await render();
  await r.press("Request replacement");
  await settle();
  assert.ok(r.hasText(USER_FACING_ERRORS[code].title));
  assert.ok(r.hasText(USER_FACING_ERRORS[code].message));
  assert.equal(r.hasText("raw server sentence"), false);
  assert.equal(r.hasText("Please review your input and try again."), false);
  r.unmount();
});

test("record signature not replaceable: both not-replaced sentences, no control", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = status({
    outputs: { recordSignature: true, packageSeal: true, latestPackageSeal: true, custodyAttestations: true },
    replacement: "RECORD_SIGNATURE_NOT_REPLACEABLE",
    replacesReportVersion: null,
    callerMayRequest: true,
  });
  const r = await render();
  assert.ok(r.hasText("No replacement can restore this record's signature."));
  assert.ok(r.texts().some((t) => /own signature was made with the withdrawn key/.test(t)));
  assert.ok(r.texts().some((t) => /Custody-event attestations made with the withdrawn key/.test(t)));
  assert.equal(r.byLabel("Request replacement").length, 0);
  r.unmount();
});
