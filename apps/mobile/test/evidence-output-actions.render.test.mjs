/**
 * EVIDENCE DETAIL (native) — per-output actions from the server's projection
 * (2026-09-26), driven through the REAL screen:
 *
 *   * a missing package offers "Recover verification package" in its own panel
 *     and posts intent RECOVER;
 *   * when the status cannot be read, NO action is offered (the screen used
 *     to invent GENERATE);
 *   * escalated work states why there is no Retry;
 *   * a new version in flight is said while the current version stays;
 *   * the screen polls the status at the server's interval and stops.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let B;
let routes = {};
let posts = [];
let statusReads = 0;
const ELIG = `/v1/governance/export-eligibility?teamId=${TEST_TEAM_ID}&evidenceId=ev-1`;

const NOT_REQUIRED = { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", version: 3, latestAvailableVersion: 3 };
const status = (outputs) => () => ({
  outputs: {
    newVersion: { action: "NONE", reason: "PAIR_INCOMPLETE", currentVersion: 3, nextVersion: 4, estimate: null },
    pollIntervalMs: null,
    ...outputs,
  },
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
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/artifacts/status": status({ report: NOT_REQUIRED, verificationPackage: NOT_REQUIRED }),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "REPORTED", type: "PHOTO" } }),
    [ELIG]: () => ({ outcome: "ALLOWED", reason: "ok", lifecycleState: "ACTIVE" }),
    "/v1/runtime/status": () => ({ status: "HEALTHY" }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") {
      posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ outcome: "ENQUEUED", message: "Recovery requested." }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
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

test("a missing package is recovered from the stored report: its own panel, its own verb, intent RECOVER", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = status({
    report: NOT_REQUIRED,
    verificationPackage: {
      state: "ELIGIBLE_NOT_GENERATED",
      action: "RECOVER",
      actionUnavailableReason: null,
      operation: "PACKAGE_RECOVERY",
      latestAvailableVersion: 2,
    },
  });
  const r = await render();
  assert.equal(r.byTestId("package-recovery").length, 1);
  assert.ok(r.hasText("The verification package for report version 3 is missing"));
  assert.ok(r.hasText("The earlier package (version 2) stays downloadable from the version history."));
  assert.equal(r.texts().some((t) => /Regenerate/.test(t)), false);
  await r.press("Recover verification package");
  await settle();
  assert.deepEqual(posts, [{ path: "/v1/evidence/ev-1/reports/regenerate", body: { intent: "RECOVER" } }]);
  assert.ok(r.hasText("Recovery requested."));
  r.unmount();
});

test("when the status cannot be read, no action is offered — never a guessed Generate", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = () => undefined; // 500
  const r = await render();
  assert.equal(r.byTestId("artifact-status-unavailable").length, 1);
  assert.equal(r.byLabel("Generate report & verification package").length, 0);
  assert.equal(r.texts().some((t) => /^(Generate|Retry|Recover|Regenerate)/.test(t)), false);
  r.unmount();
});

test("escalated work states why there is no Retry", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = status({
    report: { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "ESCALATED_TO_OPERATOR", terminalReasonClass: "TECHNICAL" },
    verificationPackage: { state: "TERMINAL_FAILURE", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
  });
  const r = await render();
  assert.equal(r.byTestId("artifact-lifecycle-terminal_failure").length, 1);
  assert.ok(r.texts().some((t) => /Automatic retries were exhausted/.test(t)));
  assert.equal(r.texts().some((t) => /^Retry/.test(t)), false);
  r.unmount();
});

test("a trashed record's withdrawn verb is the server's reason, not a local rule", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = status({
    report: { state: "ELIGIBLE_NOT_GENERATED", action: "NONE", actionUnavailableReason: "EVIDENCE_TRASHED" },
    verificationPackage: { state: "ELIGIBLE_NOT_GENERATED", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" },
  });
  const r = await render();
  assert.ok(r.hasText("This record is in the trash. Restore it to generate or recover its outputs."));
  assert.equal(r.byLabel("Generate report & verification package").length, 0);
  r.unmount();
});

test("a new version in flight is said; the current version stays and nothing is offered", async () => {
  routes["/v1/evidence/ev-1/artifacts/status"] = status({
    report: NOT_REQUIRED,
    verificationPackage: NOT_REQUIRED,
    newVersion: { action: "NONE", reason: "IN_PROGRESS", currentVersion: 3, nextVersion: 4, estimate: null },
  });
  const r = await render();
  assert.equal(r.byTestId("new-version-in-flight").length, 1);
  assert.ok(r.hasText("Creating version 4…"));
  assert.equal(r.byTestId("new-version-action-ev-1").length, 0);
  r.unmount();
});

test("the screen polls the status at the server's interval, and stops when nothing is live", async () => {
  let live = true;
  routes["/v1/evidence/ev-1/artifacts/status"] = () =>
    status({
      report: NOT_REQUIRED,
      verificationPackage: live
        ? { state: "GENERATING", action: "NONE", actionUnavailableReason: "IN_PROGRESS" }
        : NOT_REQUIRED,
      pollIntervalMs: live ? 20 : null,
    })();
  const r = await render();
  assert.equal(r.byTestId("package-recovery-in-flight").length, 1);
  const before = statusReads;
  // Real time passes outside act: the poller's own timers drive it.
  for (let i = 0; i < 6; i += 1) {
    await new Promise((x) => setTimeout(x, 25));
    await settle();
  }
  assert.ok(statusReads > before + 1, `expected polling, saw ${statusReads - before} reads`);
  live = false;
  for (let i = 0; i < 6; i += 1) {
    await new Promise((x) => setTimeout(x, 25));
    await settle();
  }
  assert.equal(r.byTestId("package-recovery-in-flight").length, 0);
  const settled = statusReads;
  for (let i = 0; i < 6; i += 1) {
    await new Promise((x) => setTimeout(x, 25));
    await settle();
  }
  assert.equal(statusReads, settled, "still polling after the server said stop");
  r.unmount();
});
