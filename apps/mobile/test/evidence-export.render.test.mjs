/**
 * T-15 — governed-export preflight (GET /v1/governance/export-eligibility)
 * before a report download, and a custody-chain DEFECT fixed with it:
 * evidence detail minted `GET /report/latest` (which RECORDS A DOWNLOAD) on
 * every load of a record whose report was ready — writing a download into the
 * custody chain for anyone who merely opened the record. It is now minted on
 * tap, and only when the preflight says ALLOWED.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const ELIG = `/v1/governance/export-eligibility?teamId=${TEST_TEAM_ID}&evidenceId=ev-1`;

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/artifacts/status": () => ({ outputs: { report: { state: "READY" } } }),
    "/v1/evidence/ev-1/report/latest": () => ({ url: "https://files.example/report.pdf" }),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
    [ELIG]: () => ({ outcome: "ALLOWED", reason: "ok", lifecycleState: "ACTIVE" }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const minted = () => requests.filter((p) => p === "/v1/evidence/ev-1/report/latest").length;

test("opening a record with a READY report records NO download (the URL is not minted on load)", async () => {
  const r = await render();
  await r.press("Artifacts");
  await settle();
  assert.equal(minted(), 0, "a custody download was recorded without anyone downloading");
});

test("ALLOWED: Download report is enabled and mints the URL only on tap, after the preflight", async () => {
  const r = await render();
  await r.press("Artifacts");
  await settle();
  assert.ok(requests.includes(ELIG), "the governed-export preflight never ran");
  assert.ok(!r.byLabel("Download report")[0].props.accessibilityState?.disabled);
  await r.press("Download report");
  await settle();
  assert.equal(minted(), 1);
  const iElig = requests.lastIndexOf(ELIG);
  const iMint = requests.indexOf("/v1/evidence/ev-1/report/latest");
  assert.ok(iElig < iMint, "the URL was minted before eligibility was re-checked");
});

test("BLOCKED: the verdict and next step are shown, the download is disabled, nothing is minted", async () => {
  routes[ELIG] = () => ({ outcome: "BLOCKED_BY_HOLD", reason: "active_legal_hold", lifecycleState: "ACTIVE" });
  const r = await render();
  await r.press("Artifacts");
  await settle();
  assert.ok(r.hasText("Blocked by legal hold"));
  assert.ok(r.hasText("Release the active legal hold from the governance surface before retrying."));
  assert.ok(r.byLabel("Download report")[0].props.accessibilityState.disabled);
  await r.press("Download report");
  await settle();
  assert.equal(minted(), 0);
});

test("a failed eligibility check is said, and the download stays disabled", async () => {
  routes[ELIG] = () => undefined;
  const r = await render();
  await r.press("Artifacts");
  await settle();
  assert.ok(r.hasText("Could not check export eligibility."));
  assert.ok(r.byLabel("Download report")[0].props.accessibilityState.disabled);
});
