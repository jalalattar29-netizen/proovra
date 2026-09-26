/**
 * T-14 — Reports rows (ReportsIndex.tsx:859 Integrity, :884 Customer, :1219
 * "Needs a workspace association"). Native parsed the integrity verdict but
 * never showed it, never showed the org-supplied Customer ID, and had no
 * generation verb on the list — so its withheld reason could not be said.
 * The verbs are the SERVER's, per output (outputs.*.action); the list derives
 * none. A missing package is "Recover package"; a new version is optional,
 * behind "⋯" and a confirmation that reads the record's current offer.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let posts = [];
let regen = null;
const out = (reportAction, reason = null, pkg = { action: "NONE", reason }) => ({
  report: { state: "READY", action: reportAction, actionUnavailableReason: reason, terminalReasonClass: null, downloadable: true },
  verificationPackage: { state: "READY", action: pkg.action, actionUnavailableReason: pkg.reason, terminalReasonClass: null, downloadable: true },
  newVersion: { action: "NONE", reason: "PAIR_INCOMPLETE" },
  pollIntervalMs: null,
});
const complete = { ...out("NONE", "NOT_REQUIRED"), newVersion: { action: "CREATE_NEW_VERSION", reason: null } };
const ITEMS = [
  { evidenceId: "e1", title: "Roof photo", type: "PHOTO", status: "REPORTED", verificationStatus: "RECORDED_INTEGRITY_VERIFIED", caseId: "c1", caseTitle: "Leaking roof", intakeCustomerId: "CUST-0042", report: { state: "ready" }, package: { state: "ready" }, outputs: complete },
  { evidenceId: "e2", title: "Orphan clip", type: "VIDEO", status: "SIGNED", verificationStatus: null, caseId: null, caseTitle: null, intakeCustomerId: null, report: { state: "not_requested" }, package: { state: "not_requested" }, outputs: out("NONE", "WORKSPACE_UNRESOLVED") },
  { evidenceId: "e3", title: "Gate video", type: "VIDEO", status: "REPORTED", verificationStatus: null, caseId: null, caseTitle: null, intakeCustomerId: null, report: { state: "ready" }, package: { state: "not_requested" }, outputs: out("NONE", "NOT_REQUIRED", { action: "RECOVER", reason: null }) },
  { evidenceId: "e4", title: "Dock photo", type: "PHOTO", status: "SIGNED", verificationStatus: null, caseId: null, caseTitle: null, intakeCustomerId: null, report: { state: "failed" }, package: { state: "failed" }, outputs: { ...out("NONE", "ESCALATED_TO_OPERATOR", { action: "NONE", reason: "FOLLOWS_REPORT" }) } },
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
    "/v1/reports/artifacts": () => ({ sections: { summary: { status: "ok", data: { reportsReady: 1 } }, artifacts: { status: "ok", items: ITEMS, nextCursor: null, total: ITEMS.length } } }),
    // The confirmation reads the record's CURRENT offer: versions and estimate.
    "/v1/evidence/e1/artifacts/status": () => ({
      outputs: {
        newVersion: {
          action: "CREATE_NEW_VERSION",
          reason: null,
          currentVersion: 2,
          nextVersion: 3,
          estimate: { estimatedBytes: String(3 * 1024 * 1024), basis: "PREVIOUS_PAIR", storageBytesUsed: null, storageBytesLimit: null },
        },
      },
    }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") {
      posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
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

test("each output shows the server's own verb: a missing package is Recover package, posted as RECOVER", async () => {
  const r = await render();
  assert.equal(r.texts().some((t) => /Regenerate/.test(t)), false);
  await r.press("Recover package: Gate video");
  await settle();
  assert.deepEqual(posts, [{ path: "/v1/evidence/e3/reports/regenerate", body: { intent: "RECOVER" } }]);
  r.unmount();
});

test("a complete record offers no verb; Create new version is behind ⋯ and confirmed with versions and the estimate", async () => {
  const r = await render();
  // No per-output verb on a complete record.
  assert.equal(r.byLabel("Generate report & package: Roof photo").length, 0);
  await r.press("More actions: Roof photo");
  await settle();
  await r.press("Create new version: Roof photo");
  await settle();
  const t = r.texts().join(" | ");
  assert.ok(r.hasText("Create version 3?"), t);
  assert.ok(r.hasText("Creates report version 3 and its verification package, alongside version 2."), t);
  assert.ok(r.hasText("Earlier versions are kept unchanged and stay downloadable."), t);
  assert.ok(r.hasText("Estimated additional storage: about 3.0 MB"), t);
  // Nothing is sent until the new version is confirmed.
  assert.deepEqual(posts, []);
  await r.press("Create new version");
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/v1/evidence/e1/reports/regenerate");
  assert.equal(posts[0].body.intent, "NEW_VERSION");
  assert.match(posts[0].body.clientRequestKey, /^nv-/);
  r.unmount();
});

test("a withheld verb is said, and no button is offered", async () => {
  const r = await render();
  assert.ok(r.byLabel("Needs a workspace association").length >= 1);
  assert.ok(r.byLabel("Escalated to operators").length >= 1);
  assert.equal(r.texts().some((t) => t.startsWith("Generate report & package") || t.startsWith("Retry")), false);
  r.unmount();
});

test("a permission refusal is said in the web's words", async () => {
  regen = () => ({ __status: 403, message: "forbidden" });
  const r = await render();
  await r.press("Recover package: Gate video");
  await settle();
  assert.ok(r.hasText("You do not have permission to generate reports in this workspace."));
  r.unmount();
});

test("a declined request shows the server's reason", async () => {
  regen = () => ({
    __status: 409,
    code: "OUTPUT_ACTION_UNAVAILABLE",
    outcome: "NOT_RECOVERABLE",
    reason: "REPORT_INTEGRITY_REVIEW",
    message: "The stored report could not be verified, so it will not be reused.",
  });
  const r = await render();
  await r.press("Recover package: Gate video");
  await settle();
  assert.ok(r.hasText("The stored report could not be verified, so it will not be reused."), r.texts().join(" | "));
  r.unmount();
});
