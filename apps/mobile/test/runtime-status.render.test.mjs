/**
 * T-15 — tenant-safe runtime status on evidence detail (GET /v1/runtime/status).
 * Healthy says nothing; degraded says the data may be partial; a failed read
 * is FAIL-CLOSED (UNKNOWN), never silence that looks like healthy.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let answer;

before(async () => {
  M = await loadModule("src/ui/runtime-status-banner.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  answer = () => ({ status: 200, body: { status: "HEALTHY" } });
  globalThis.fetch = async () => {
    const a = answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
});
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.RuntimeStatusBanner, { pollMs: 0 })));
  await settle();
  return r;
};

test("HEALTHY renders nothing", async () => {
  const r = await render();
  assert.equal(r.byTestId("runtime-status-warn").length + r.byTestId("runtime-status-unknown").length, 0);
});

test("DEGRADED says the data may be partial — and names no subsystem it does not have", async () => {
  answer = () => ({ status: 200, body: { status: "DEGRADED" } });
  const r = await render();
  assert.ok(r.hasText("Runtime is in degraded mode."));
  assert.ok(r.hasText("The data on this page may be partial or stale."));
  assert.ok(!r.hasText("0 subsystem"), "the web's vacuous subsystem count leaked");
});

test("a failed status read is fail-closed UNKNOWN, not silence", async () => {
  answer = () => ({ status: 500, body: {} });
  const r = await render();
  assert.ok(r.hasText("Runtime readiness could not be loaded — treat dashboard as unknown state."));
});

test("an unrecognised answer is treated as UNAVAILABLE", () => {
  assert.equal(M.parseRuntimeStatus({ status: "WHATEVER" }), "UNAVAILABLE");
  assert.equal(M.parseRuntimeStatus(null), "UNAVAILABLE");
});
