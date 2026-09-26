/**
 * T-14 — Reports rows (ReportsIndex.tsx:859 Integrity, :884 Customer, :1219
 * "Needs a workspace association"). Native parsed the integrity verdict but
 * never showed it, never showed the org-supplied Customer ID, and had no
 * generation verb on the list — so its withheld reason could not be said.
 * The verb is the SERVER's (outputs.*.action); the list derives none.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let posts = [];
let regen = null;
const out = (action, reason = null) => ({
  report: { state: "READY", action, actionUnavailableReason: reason, terminalReasonClass: null, downloadable: true },
  verificationPackage: { state: "READY", action: "NONE", actionUnavailableReason: reason, terminalReasonClass: null, downloadable: true },
});
const ITEMS = [
  { evidenceId: "e1", title: "Roof photo", type: "PHOTO", status: "REPORTED", verificationStatus: "RECORDED_INTEGRITY_VERIFIED", caseId: "c1", caseTitle: "Leaking roof", intakeCustomerId: "CUST-0042", report: { state: "ready" }, package: { state: "ready" }, outputs: out("REGENERATE") },
  { evidenceId: "e2", title: "Orphan clip", type: "VIDEO", status: "SIGNED", verificationStatus: null, caseId: null, caseTitle: null, intakeCustomerId: null, report: { state: "not_requested" }, package: { state: "not_requested" }, outputs: out("NONE", "WORKSPACE_UNRESOLVED") },
];

before(async () => {
  M = await loadModule("app/(stack)/reports.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  posts = [];
  regen = () => ({ outcome: "ENQUEUED", reportRequestId: "rr-1" });
  const routes = {
    ...authenticatedRoutes(),
    // GET /v1/reports/artifacts → { sections: { summary, artifacts } } (reports-aggregator.service.ts).
    "/v1/reports/artifacts": () => ({ sections: { summary: { status: "ok", data: { reportsReady: 1 } }, artifacts: { status: "ok", items: ITEMS, nextCursor: null, total: 2 } } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") {
      posts.push(path);
      const res = regen();
      return new Response(JSON.stringify(res), { status: res.__status ?? 200, headers: { "content-type": "application/json" } });
    }
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : { message: "unstubbed" }), { status: key ? 200 : 500, headers: { "content-type": "application/json" } });
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

test("each row says its integrity verdict once, its case, and the org's Customer ID", async () => {
  const r = await render();
  // Separate meta items, as the web row renders them (ReportsIndex.tsx:846-895).
  for (const s of ["Integrity: Verified", "Case: Leaking roof", "Customer: CUST-0042"]) {
    assert.ok(r.hasText(s), `${s} missing: ${r.texts().join(" | ")}`);
  }
  assert.equal(r.byLabel("Customer ID supplied by your organization: CUST-0042").length, 1);
  r.unmount();
});

test("REGENERATE asks first, states its cost, and posts once only when confirmed", async () => {
  const r = await render();
  await r.press("Regenerate report & package: Roof photo");
  await settle();
  // Nothing is sent until the new version is confirmed.
  assert.deepEqual(posts, []);
  assert.equal(r.byTestId("report-row-regenerate-confirm-e1").length, 1);
  assert.ok(r.texts().some((t) => /new immutable version/.test(t) && /additional workspace storage/.test(t)));
  await r.press("Create a new version: Roof photo");
  await settle();
  assert.deepEqual(posts, ["/v1/evidence/e1/reports/regenerate"]);
  assert.equal(r.byTestId("report-row-action-e1").length, 1);
});

test("a withheld verb is said, and no button is offered", async () => {
  const r = await render();
  assert.ok(r.byLabel("Needs a workspace association").length >= 1);
  assert.equal(r.texts().some((t) => t.startsWith("Generate report & package")), false);
});

test("a permission refusal is said in the web's words", async () => {
  regen = () => ({ __status: 403, message: "forbidden" });
  const r = await render();
  await r.press("Regenerate report & package: Roof photo");
  await settle();
  await r.press("Create a new version: Roof photo");
  await settle();
  assert.ok(r.hasText("You do not have permission to generate reports in this workspace."));
});
