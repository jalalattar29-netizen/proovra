/**
 * CLIENT-X — B6-F-49 (native half).
 *
 * `GET /v1/usage-stats` is now workspace-scoped and says what the cost
 * figures are: `costBasis: "ILLUSTRATIVE_LIST_RATE_ESTIMATE"`,
 * `costIsCharged: false`. Before: native showed "Total Cost $21.50" / "This
 * Month $9.50" with nothing saying they are a list-rate illustration — a Free
 * user read them as charges. The note shows on the old shape too (the figures
 * were never charges).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let usage;

const baseUsage = (extra = {}) => ({
  data: {
    dailyAnalyses: { today: 1, thisWeek: 2, thisMonth: 3 },
    costBreakdown: { totalCost: 21.5, thisMonth: 9.5, averagePerAnalysis: 0.1 },
    topEvidenceTypes: {},
    activeApiKeys: 0,
    activeBatches: 0,
    ...extra,
  },
});

before(async () => {
  M = await loadModule("app/(stack)/operations/quotas.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  usage = () => baseUsage({ costBasis: "ILLUSTRATIVE_LIST_RATE_ESTIMATE", costIsCharged: false, workspaceId: "team-1" });
  const routes = {
    ...authenticatedRoutes(),
    "/v1/quotas": () => ({ data: { analyses: { limit: 10, used: 1, remaining: 9 } } }),
    "/v1/usage-stats": () => usage(),
  };
  globalThis.fetch = async (url) => {
    const bare = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const res = routes[bare] ? routes[bare]() : undefined;
    return new Response(JSON.stringify(res ?? {}), { status: res === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
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

test("B6-F-49: the cost figures are labelled an illustrative list-rate estimate, not a charge", async () => {
  const r = await render();
  assert.equal(r.byTestId("cost-overview").length, 1);
  assert.ok(r.hasText("Illustrative estimate at list rates — nothing is billed per analysis."), r.texts().join(" | "));
  r.unmount();
});

test("B6-F-49: an older API without costBasis still gets the estimate note", async () => {
  usage = () => baseUsage();
  const r = await render();
  assert.ok(r.hasText("Illustrative estimate at list rates — nothing is billed per analysis."));
  r.unmount();
});
