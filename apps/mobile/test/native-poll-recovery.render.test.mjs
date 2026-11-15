/**
 * F-P1-15 — native status polls recover after a failed read.
 *
 * Real screens over a scripted API (the real apiFetch, fetch replaced):
 *   - Evidence detail: failed /artifacts/status reads back off (each failure
 *     doubles the wait, capped) instead of hammering at the server's interval,
 *     and the first good read returns to normal (work done → record re-read).
 *   - Reports list: a failed QUIET reload (the list unchanged) used to end the
 *     poll until a manual refresh; it now re-arms with backoff, keeps the list
 *     on screen, and the next good read shows the finished row.
 *
 * RED on the pre-remediation tree: the detail poll re-read at the fixed
 * interval after every failure; the reports poll made no read after a failed one.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let D;
let R;
let reads = [];
let mounted = [];

before(async () => {
  D = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/poll-backoff.ts"]);
  R = await loadModule("app/(stack)/reports.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  reads = [];
});
afterEach(() => {
  for (const r of mounted) r.unmount();
  mounted = [];
  delete globalThis.__EXPO_PARAMS__;
});

// Small act() steps: React flushes state set inside an act() only when it
// ends, so one long act() would hold every poll update until the very end.
const wait = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) await act(async () => { await new Promise((x) => setTimeout(x, 5)); });
};
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
function serve(routes) {
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    reads.push({ path, at: Date.now() });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    if (res && res.__status) {
      return new Response(JSON.stringify(res.body ?? {}), { status: res.__status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
}

test("F-P1-15: evidence detail — failed status reads back off, then the poll recovers", async () => {
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  let phase = "live"; // live work; then failures; then done.
  serve({
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/artifacts/status": () => {
      if (phase === "live") return { outputs: { report: { state: "PROCESSING" }, pollIntervalMs: 10 } };
      if (phase === "failing") return { __status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "busy" } } };
      return { outputs: { report: { state: "READY" }, pollIntervalMs: null } };
    },
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
  });
  await signIn(D);
  const r = await renderComponent(h(D.TestProviders, null, h(D.default, {})));
  mounted.push(r);
  await settle();
  const statusReads = () => reads.filter((q) => q.path === "/v1/evidence/ev-1/artifacts/status").length;
  assert.ok(statusReads() >= 1);
  phase = "failing";
  const before = statusReads();
  await wait(450);
  const failedReads = statusReads() - before;
  // At a fixed 10 ms (old behaviour) this window holds dozens of reads; with
  // backoff 10, 20, 40, 80, 160 … it holds at most a handful.
  assert.ok(failedReads >= 2, `the poll stopped after a failed read (${failedReads} reads)`);
  assert.ok(failedReads <= 8, `failed reads did not back off: ${failedReads} reads in 450 ms at a 10 ms interval`);
  // The server recovers: the next read is good and the work is over.
  phase = "done";
  const recordReadsBefore = reads.filter((q) => q.path === "/v1/evidence/ev-1").length;
  for (let i = 0; i < 40 && reads.filter((q) => q.path === "/v1/evidence/ev-1").length === recordReadsBefore; i += 1) await wait(25);
  assert.ok(
    reads.filter((q) => q.path === "/v1/evidence/ev-1").length > recordReadsBefore,
    "after recovery the finished work was never picked up (record not re-read)",
  );
});

test("F-P1-15: reports list — a failed quiet reload keeps polling (backoff), keeps the list, and shows the finished row", async () => {
  let n = 0;
  const row = (live) => ({
    evidenceId: "e1",
    title: "Roof photo",
    type: "PHOTO",
    status: live ? "SIGNED" : "REPORTED",
    verificationStatus: null,
    caseId: null,
    caseTitle: null,
    intakeCustomerId: null,
    report: { state: live ? "pending" : "ready" },
    package: { state: live ? "pending" : "ready" },
    outputs: {
      report: { state: live ? "PROCESSING" : "READY", action: "NONE", actionUnavailableReason: live ? "IN_PROGRESS" : "NOT_REQUIRED", terminalReasonClass: null, downloadable: !live },
      verificationPackage: { state: live ? "PROCESSING" : "READY", action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT", terminalReasonClass: null, downloadable: !live },
      newVersion: { action: "NONE", reason: "PAIR_INCOMPLETE" },
      pollIntervalMs: live ? 10 : null,
    },
  });
  serve({
    ...authenticatedRoutes(),
    "/v1/reports/artifacts": (p) => {
      if (p.includes("summary=0")) {
        n += 1;
        // 1: first load (live) · 2-3: failed quiet reloads · 4+: work finished.
        if (n === 2 || n === 3) return { __status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "busy" } } };
        return { sections: { artifacts: { status: "ok", items: [row(n === 1)], nextCursor: null, total: 1 } } };
      }
      return { sections: { summary: { status: "ok", data: { reportsReady: 0 } } } };
    },
  });
  await signIn(R);
  const r = await renderComponent(h(R.TestProviders, null, h(R.default, {})));
  mounted.push(r);
  await settle();
  assert.ok(r.hasText("Roof photo"), r.texts().join(" | "));
  for (let i = 0; i < 40 && n < 4; i += 1) await wait(25);
  assert.ok(n >= 4, `the poll stopped after a failed quiet reload (list reads: ${n})`);
  await settle();
  assert.ok(r.hasText("Roof photo"), "a failed quiet poll replaced the list with an error");
  assert.ok(!r.hasText("Unable to load artifacts."), "a transient quiet failure was shown as a load error");
});

test("F-P1-15: the backoff rule (pure)", () => {
  const { pollDelayMs } = D;
  assert.equal(pollDelayMs(3_000, 0), 3_000, "a healthy poll keeps the server pace");
  assert.equal(pollDelayMs(3_000, 1), 6_000);
  assert.equal(pollDelayMs(3_000, 3), 24_000);
  assert.equal(pollDelayMs(3_000, 10), 60_000, "capped");
  assert.equal(pollDelayMs(120_000, 4), 120_000, "never faster than the server asked");
});
