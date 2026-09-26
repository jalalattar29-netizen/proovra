/**
 * EVIDENCE DETAIL (native) UNDER EVERY RUNTIME STATUS.
 *
 * The record screen used to open with a platform panel — "Runtime is in
 * degraded mode … the data on this page may be partial or stale" — driven by
 * readiness checks unrelated to the record. These drive the REAL screen with
 * the real envelope and assert:
 *   * under no status does the record carry a platform diagnostic panel;
 *   * a generation incident is said beside the generation control;
 *   * an already-available download stays enabled while generation is impaired.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let B;
let routes = {};
const ELIG = `/v1/governance/export-eligibility?teamId=${TEST_TEAM_ID}&evidenceId=ev-1`;
const GEN = "Report and package generation is delayed. Requests are queued and will complete automatically.";

const caps = (over = {}) => ({
  uploads: "HEALTHY",
  artifactGeneration: "HEALTHY",
  downloads: "HEALTHY",
  search: "HEALTHY",
  reviewAutomation: "HEALTHY",
  ...over,
});

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  B = await loadModule("src/ui/runtime-status-banner.tsx");
});
beforeEach(async () => {
  B.resetServiceStatusForTests();
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/artifacts/status": () => ({
      outputs: { report: { state: "READY", action: "REGENERATE" } },
    }),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "REPORTED", type: "PHOTO" } }),
    [ELIG]: () => ({ outcome: "ALLOWED", reason: "ok", lifecycleState: "ACTIVE" }),
    "/v1/runtime/status": () => ({ status: "HEALTHY", capabilities: caps() }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
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
const PLATFORM_PANEL = /degraded mode|partial or stale|subsystem|runbook/i;

const VARIANTS = {
  HEALTHY: () => ({ status: "HEALTHY", capabilities: caps() }),
  "generation DEGRADED": () => ({ status: "DEGRADED", capabilities: caps({ artifactGeneration: "DEGRADED" }) }),
  "downloads UNAVAILABLE": () => ({ status: "DEGRADED", capabilities: caps({ downloads: "UNAVAILABLE" }) }),
  UNKNOWN: () => ({ status: "UNAVAILABLE", capabilities: caps({ artifactGeneration: "UNKNOWN", search: "UNKNOWN" }) }),
  "read fails": () => undefined,
};

for (const [name, body] of Object.entries(VARIANTS)) {
  test(`${name}: the record carries no platform diagnostic panel`, async () => {
    routes["/v1/runtime/status"] = body;
    const r = await render();
    assert.ok(!r.texts().some((t) => PLATFORM_PANEL.test(t)), `platform panel text on the record: ${r.texts().filter((t) => PLATFORM_PANEL.test(t)).join(" | ")}`);
    r.unmount();
  });
}

test("a generation incident is said beside Regenerate, and the existing report download stays enabled", async () => {
  routes["/v1/runtime/status"] = VARIANTS["generation DEGRADED"];
  const r = await render();
  assert.ok(r.hasText(GEN));
  assert.equal(r.byTestId("service-notice-artifactGeneration").length, 1);
  assert.ok(r.byLabel("Download report").length > 0);
  assert.ok(!r.byLabel("Download report")[0].props.accessibilityState?.disabled);
  r.unmount();
});

test("healthy: no service notice anywhere on the record", async () => {
  const r = await render();
  assert.ok(!r.hasText(GEN));
  assert.equal(r.byTestId("service-notice-artifactGeneration").length + r.byTestId("service-notice-downloads").length, 0);
  r.unmount();
});

test("a downloads incident is said at the downloads, not as a record warning", async () => {
  routes["/v1/runtime/status"] = VARIANTS["downloads UNAVAILABLE"];
  const r = await render();
  assert.ok(r.hasText("Downloads are temporarily unavailable. Try again later."));
  assert.equal(r.byTestId("service-notice-downloads").length, 1);
  assert.ok(!r.hasText(GEN));
  r.unmount();
});

test("a record's own generation failure stays visible beside a generation incident", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = () => ({
    outputs: { report: { state: "RETRYABLE_FAILURE", action: "RETRY" } },
  });
  routes["/v1/runtime/status"] = VARIANTS["generation DEGRADED"];
  const r = await render();
  assert.equal(r.byTestId("artifact-lifecycle-retryable_failure").length, 1, "the record's failure panel disappeared");
  assert.ok(r.hasText(GEN), "the generation incident was not said beside Retry");
  assert.ok(!r.texts().some((t) => PLATFORM_PANEL.test(t)));
  r.unmount();
});
