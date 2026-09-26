/**
 * SERVICE STATUS (native) — contextual notices and the header chip, driven by
 * the real GET /v1/runtime/status envelope through the shared interpreter.
 *
 * What these prove, not what text disappeared:
 *   * a notice appears beside an action ONLY for a capability that action
 *     depends on, and only when that capability is confirmed impaired;
 *   * the header chip is silent while healthy, says "Service issue" with the
 *     user-impact sentence when a capability is impaired, and "Status
 *     unavailable" — never an all-clear — when status cannot be read;
 *   * web and native read one response identically.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let P;
let S;
let answer;

const caps = (over = {}) => ({
  uploads: "HEALTHY",
  artifactGeneration: "HEALTHY",
  downloads: "HEALTHY",
  search: "HEALTHY",
  reviewAutomation: "HEALTHY",
  ...over,
});

before(async () => {
  M = await loadModule("src/ui/runtime-status-banner.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  P = await loadModule("src/product/service-status.ts");
  S = await import("@proovra/shared");
});
beforeEach(() => {
  M.resetServiceStatusForTests();
  answer = () => ({ status: 200, body: { status: "HEALTHY", capabilities: caps(), checkedAt: "2026-09-26T00:00:00.000Z" } });
  globalThis.fetch = async () => {
    const a = answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
});
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const renderNotice = async (requires) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.RuntimeStatusBanner, { requires })));
  await settle();
  return r;
};
const renderChip = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.ServiceStatusIndicator, null)));
  await settle();
  return r;
};
const degraded = (over) => () => ({ status: 200, body: { status: "DEGRADED", capabilities: caps(over), checkedAt: "2026-09-26T00:00:00.000Z" } });

/* --------------------------------------------------------------- contextual */

test("healthy: no notice beside any action", async () => {
  const r = await renderNotice(["artifactGeneration", "downloads"]);
  assert.equal(r.texts().length, 0);
  r.unmount();
});

test("a generation incident is said beside generation — and not beside downloads", async () => {
  answer = degraded({ artifactGeneration: "DEGRADED" });
  const gen = await renderNotice(["artifactGeneration"]);
  assert.ok(gen.hasText("Report and package generation is delayed. Requests are queued and will complete automatically."));
  assert.ok(!gen.texts().some((t) => /partial or stale|corrupt|subsystem/i.test(t)));
  gen.unmount();
  const dl = await renderNotice(["downloads"]);
  assert.equal(dl.texts().length, 0, "downloads are unaffected, so the download controls carry no warning");
  dl.unmount();
});

test("unmeasured status and a failed read put nothing beside an action", async () => {
  answer = () => ({ status: 200, body: { status: "UNAVAILABLE", capabilities: caps({ artifactGeneration: "UNKNOWN" }) } });
  const unknown = await renderNotice(["artifactGeneration"]);
  assert.equal(unknown.texts().length, 0);
  unknown.unmount();
  M.resetServiceStatusForTests();
  answer = () => ({ status: 500, body: {} });
  const failed = await renderNotice(["artifactGeneration"]);
  assert.equal(failed.texts().length, 0);
  failed.unmount();
});

/* ------------------------------------------------------------- header chip */

test("header chip: silent while healthy", async () => {
  const r = await renderChip();
  assert.equal(r.byTestId("header-service-status").length, 0);
  r.unmount();
});

test("header chip: 'Service issue' with the user-impact sentence, no subsystem names", async () => {
  answer = degraded({ downloads: "UNAVAILABLE" });
  const r = await renderChip();
  assert.equal(r.byLabel("Service status: Service issue").length, 1);
  await r.press("Service status: Service issue");
  assert.ok(r.hasText("Downloads are temporarily unavailable. Try again later."));
  assert.ok(!r.texts().some((t) => /redis|s3|worker|queue|runbook/i.test(t)));
  r.unmount();
});

test("header chip: an unreadable status is 'Status unavailable', never an all-clear", async () => {
  answer = () => ({ status: 500, body: {} });
  const r = await renderChip();
  assert.equal(r.byLabel("Service status: Status unavailable").length, 1);
  r.unmount();
});

test("reviewer automation alone never raises the global chip", async () => {
  answer = () => ({ status: 200, body: { status: "HEALTHY", capabilities: caps({ reviewAutomation: "DEGRADED" }) } });
  const r = await renderChip();
  assert.equal(r.byTestId("header-service-status").length, 0);
  r.unmount();
});

/* ------------------------------------------------------------------ parity */

test("native parses one response exactly as the shared (web) interpreter does", () => {
  const bodies = [
    { status: "DEGRADED", capabilities: caps({ artifactGeneration: "DEGRADED", search: "UNKNOWN" }), checkedAt: "2026-09-26T00:00:00.000Z" },
    { status: "DEGRADED" },
    { status: "HEALTHY" },
    { status: "WHATEVER", capabilities: { uploads: "BROKEN" } },
    null,
  ];
  for (const b of bodies) assert.deepEqual(P.parseServiceStatus(b), S.parseTenantServiceStatus(b));
  // An older server's bare DEGRADED is not attributed to any capability.
  assert.equal(P.parseServiceStatus({ status: "DEGRADED" }).capabilities.artifactGeneration, "UNKNOWN");
  assert.equal(P.parseServiceStatus({ status: "WHATEVER" }).status, "UNAVAILABLE");
});
