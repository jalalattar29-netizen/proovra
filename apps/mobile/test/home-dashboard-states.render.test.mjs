/**
 * T-14 — HomeDashboardSections (:580 Checking…, :685 "+N … tracked", :1101
 * Preserved files) and a parser defect found with them: GET
 * /v1/dashboard/records-by-type answers { records, files }, and native read
 * total/byCategory at the top level, so "Records by type" was always empty.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let hold = null;
/** trust-summary.service.ts TrustSummary carrying five open workspace facts. */
const TRUST = () => ({
  totalEvidence: 30,
  signed: 30,
  tsa: { stamped: 29, pending: 0, failed: 1, none: 0 },
  ots: { anchored: 20, pending: 6, failed: 2, none: 0 },
  needingAttention: 4,
  publicVerify: { published: 0, unpublished: 30, suspended: 0 },
  intake: { submissionsAwaitingReview: 3 },
});

before(async () => {
  M = await loadModule("app/(tabs)/index.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  hold = null;
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence": () => ({ items: [] }),
    "/v1/dashboard/command-center": () => ({ sections: {} }),
    "/v1/dashboard/trust-summary": TRUST,
    "/v1/dashboard/records-by-type": () => ({
      records: { total: 4, byCategory: { Images: 3, Documents: 1 } },
      files: { total: 9, byCategory: { Images: 6, Documents: 3 } },
    }),
    "/v1/billing/overview": () => ({}),
    "/v1/reports": () => ({ items: [] }),
    "/v1/workflow/intake-links": () => ({ links: [] }),
    "/v1/me/inbox": () => ({ items: [] }),
    "/v1/ops/summary": () => ({ summary: { mayAssertAllClear: true, clearRefusalReason: null }, workspace: { operatorCount: 1 } }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (hold && path.startsWith("/v1/ops/summary")) await hold;
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("while the sources load, priorities say Checking… — never all-clear", async () => {
  routes["/v1/dashboard/trust-summary"] = () => ({ totalEvidence: 3, signed: 3 });
  let release;
  hold = new Promise((x) => (release = x));
  const r = await render();
  assert.ok(r.hasText("Checking…"));
  assert.equal(r.hasText("All clear"), false, "claimed all clear before it knew");
  release();
  await settle();
  assert.equal(r.hasText("Checking…"), false);
  assert.ok(r.hasText("All clear"));
});

test("an unreadable Operations summary refuses the all-clear, not reports it", async () => {
  routes["/v1/dashboard/trust-summary"] = () => ({ totalEvidence: 3, signed: 3 });
  routes["/v1/ops/summary"] = () => ({ __status: 503, message: "down" });
  const r = await render();
  assert.ok(r.hasText("Operations status unavailable"));
  assert.equal(r.hasText("All clear"), false);
});

test("three priorities are shown and the rest are counted", async () => {
  const r = await render();
  // Critical first: the two terminal/TSA failures, then the largest warning.
  assert.ok(r.hasText("2 anchoring failures are terminal"));
  assert.ok(r.hasText("1 TSA timestamp failed"));
  assert.ok(r.hasText("6 OTS proofs are still pending"));
  assert.equal(r.hasText("4 records need integrity review"), false, "a fourth priority was shown");
  assert.ok(r.hasText("+2 lower-priority items tracked"));
});

test("records by type reads the server's { records, files } and offers Preserved files", async () => {
  const r = await render();
  await r.press("Workspace views: Analytics");
  assert.ok(r.hasText("4 records in this workspace"), "the records aggregate was not read");
  await act(async () => { r.byLabel("Records or preserved files: Preserved files")[0].props.onPress(); });
  await settle();
  assert.ok(r.hasText("9 files preserved · inside evidence records"));
});
