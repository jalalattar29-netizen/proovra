/**
 * T-14 — case Overview (SimpleCaseDetail.tsx:704, :840, :964): the case facts
 * (reference, priority, created, last updated) that GET /v1/cases/:id sends,
 * and the "What needs attention" panel computed with the web's rules from the
 * matter-workspace evidence outputs. Native showed neither.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let items = [];
const CASE = "c0ffee00-0000-4000-8000-000000000002";
const out = (report, pkg) => ({ report: { state: report }, verificationPackage: { state: pkg } });

before(async () => {
  M = await loadModule("app/(stack)/case/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { id: CASE };
  items = [];
  routes = {
    ...authenticatedRoutes(),
    [`/v1/cases/${CASE}/matter-workspace`]: () => ({ case: { id: CASE }, viewer: {}, sections: { evidence: { status: "ok", items } } }),
    // GET /v1/cases/:id sends the Prisma row (include:) under `case`.
    [`/v1/cases/${CASE}`]: () => ({
      case: {
        id: CASE, name: "Leaking roof", status: "OPEN", teamId: "team-1", access: [],
        referenceNumber: "CLM-2291", priority: "P1", createdAt: "2026-09-02T10:00:00.000Z", updatedAt: "2026-09-20T08:30:00.000Z",
      },
    }),
    "/v1/evidence": () => ({ items: [] }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](init.method ?? "GET") : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
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

test("the header meta line is the web one: status, Ref, evidence count, created, last updated; priority is in the summary", async () => {
  items = [{ id: "a", outputs: out("READY", "READY"), verificationStatus: "VERIFIED" }];
  const r = await render();
  assert.ok(r.hasText("Open"), "the status was not stated");
  assert.ok(
    r.texts().some((t) => t === "Ref CLM-2291 · 1 evidence record · Created Sep 2, 2026 · Last updated Sep 20, 2026"),
    "the case facts were not shown",
  );
  // SimpleCaseDetail.tsx:822 — the Overview summary carries priority and reference.
  assert.ok(r.hasText("P1") && r.hasText("Priority") && r.hasText("CLM-2291"));
});

test("needs attention counts only actionable output states, plus integrity issues", async () => {
  items = [
    { id: "a", outputs: out("ELIGIBLE_NOT_GENERATED", "READY"), verificationStatus: "VERIFIED" },
    { id: "b", outputs: out("RETRYABLE_FAILURE", "BLOCKED"), verificationStatus: "FAILED" },
    // In flight and commercially excluded are not problems.
    { id: "c", outputs: out("GENERATING", "NOT_INCLUDED"), verificationStatus: "VERIFIED" },
  ];
  const r = await render();
  assert.equal(r.byTestId("case-needs-attention").length, 1, "the attention panel is missing");
  assert.ok(r.hasText("• 2 evidence records still need their reports generated."));
  assert.ok(r.hasText("• 1 evidence record still needs its verification package generated."));
  assert.ok(r.hasText("• 1 evidence record has an integrity issue that needs review."));
});

test("empty and all-clear states use the web's sentences", async () => {
  let r = await render();
  assert.ok(r.hasText("No evidence linked yet. Add evidence to begin building this case workspace."));
  r.unmount();
  items = [{ id: "a", outputs: out("READY", "QUEUED"), verificationStatus: "VERIFIED" }];
  r = await render();
  assert.ok(r.hasText("No open issues. Reports and packages are up to date."));
});

test("the per-record report / package list (web Reports tab) opens each record", async () => {
  items = [
    { id: "a", title: null, displayFileName: "roof.jpg", outputs: out("ELIGIBLE_NOT_GENERATED", "NOT_INCLUDED"), verificationStatus: "VERIFIED" },
    { id: "b", title: "Gutter video", reportReady: true, packageReady: false, verificationStatus: "VERIFIED" },
  ];
  M.calls.reset();
  const r = await render();
  await r.press("Reports & Packages");
  await settle();
  assert.ok(r.hasText("1 of 2 evidence records have a report. 0 have a verification package."));
  assert.ok(r.hasText("Open the evidence record to generate missing deliverables."));
  assert.ok(r.hasText("Report not generated · Package not included"), "the output states were not labelled");
  assert.ok(r.hasText("Report ready · Package not available"), "the readiness fallback was not applied");
  await act(async () => { r.byTestId("case-deliverable-a")[0].props.onPress(); });
  assert.deepEqual(M.calls.push.at(-1), "/(stack)/evidence/a");
});
