/**
 * B5B-F-105 — the record screen's Artifacts tab hands verification-link
 * management (revoke reviewer links, withdraw the page) to the web record's
 * Verification page section, with the instructions beside the button; a
 * record outside this app's active workspace goes to the web workspaces
 * entry instead. The phone never calls the revoke / withdraw routes.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
const REF = "pvr_7pLuIsF1Z_JiaqHKByYM72RwUcM";
const RW = (teamId) => ({
  relationships: { items: [], caseId: null, caseName: null },
  reviewWorkflow: { status: "NOT_STARTED", teamId },
  reviewerAlerts: [],
  sourceContext: { clientSignalsSummary: {} },
  publicVerificationSummary: { state: "AVAILABLE", disclosureMode: "VERIFICATION_ONLY", showRecordedLocation: false, sharePath: null, analyticsAvailable: true },
  canonicalVerification: { status: "AVAILABLE", reference: REF, verifyPath: `/verify/${REF}`, issuedAtUtc: null, refusalReason: null },
});

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
let writes = [];
beforeEach(async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  globalThis.__LINKING_OPENED__ = [];
  writes = [];
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => platformContextEnvelope() }),
    "/v1/evidence/ev-1/review-workspace": () => RW(TEST_TEAM_ID),
    "/v1/evidence/ev-1/artifacts/status": () => ({ outputs: { report: { state: "READY" }, verificationPackage: { state: "READY" } } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
  };
  globalThis.fetch = async (url, init) => {
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${String(url)}`);
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? {}), { status: res === undefined ? 500 : res.__status ?? 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
async function openArtifacts() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Artifacts");
  await settle();
  return r;
}

test("a record in the active workspace hands off to its Verification page section on the web — record id only, no token", async () => {
  const r = await openArtifacts();
  assert.equal(r.byTestId("verification-links-handoff").length, 1, "no handoff card");
  assert.ok(r.hasText("Reviewer links and withdrawal"));
  await r.press("Manage links and withdrawal on the web");
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://www.proovra.com/evidence/ev-1?tab=artifacts#verification-page"]);
  assert.ok(!/token|pvr_|pvs_/i.test(globalThis.__LINKING_OPENED__[0]));
  // Management stays on the web: the phone writes nothing.
  assert.ok(!writes.some((w) => /verify-links|verification-access\/withdraw/.test(w)), writes.join(","));
  r.unmount();
});

test("a record outside the active workspace opens the web workspaces entry and says how to reach the record", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () => RW("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const r = await openArtifacts();
  assert.ok(r.hasText("This app could not confirm which workspace holds this record, so the web app opens on your workspaces. Sign in with the same account, switch to the workspace that holds this record, then open the record and go to Artifacts → Verification page to revoke reviewer links or withdraw the page."));
  await r.press("Manage links and withdrawal on the web");
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://www.proovra.com/workspaces"]);
  r.unmount();
});
