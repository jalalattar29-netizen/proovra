/**
 * REPORTS PARITY — the canonical ReportsIndex (apps/web/components/
 * reports-experience/ReportsIndex.tsx) on the device, against the server's
 * REAL shapes:
 *   GET /v1/reports/artifacts  → reports-aggregator.service.ts envelope
 *                                { generatedAt, workspace, sections: { summary, artifacts } };
 *                                rows carry report{state,version,generatedAtUtc} and
 *                                package{state,version,generatedAtUtc,blockedReason} (:760-780);
 *                                query per case-workspace.routes.ts ArtifactsQuery :201 (summary=0|1).
 *   GET /v1/reports            → reports.routes.ts UserReportsEnvelope { items, nextCursor }.
 *   GET /v1/governance/export-eligibility → { outcome, reason, lifecycleState }.
 *   GET /v1/evidence/:id/report/latest | /verification-package → { url } (or { code }).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes;

const output = (action = "NONE") => ({
  report: { state: "READY", action, actionUnavailableReason: null, terminalReasonClass: null, downloadable: true },
  verificationPackage: { state: "READY", action: "NONE", actionUnavailableReason: null, terminalReasonClass: null, downloadable: true },
});
const ROW = {
  evidenceId: "e1", title: "Roof photo", displayFileName: null, originalFileName: null, mimeType: "image/jpeg", type: "PHOTO", status: "REPORTED",
  verificationStatus: "RECORDED_INTEGRITY_VERIFIED", caseId: "c1", caseTitle: "Leaking roof", intakeCustomerId: null,
  createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  report: { state: "ready", version: 2, generatedAtUtc: "2026-09-20T00:00:00.000Z" },
  package: { state: "ready", version: 1, generatedAtUtc: "2026-09-20T00:00:00.000Z", blockedReason: null },
  outputs: output(),
};
const BLOCKED = {
  ...ROW, evidenceId: "e2", title: "Held clip", caseId: null, caseTitle: null, verificationStatus: null,
  report: { state: "pending", version: null, generatedAtUtc: null },
  package: { state: "blocked", version: null, generatedAtUtc: null, blockedReason: "Legal hold" },
};
const aggregator = (items, extra = {}) => ({
  generatedAt: new Date(Date.now() - 5 * 60000).toISOString(),
  workspace: { id: "team-1", role: "OWNER" },
  sections: {
    summary: { status: "skipped", data: null },
    artifacts: { status: "ok", items, nextCursor: null, total: items.length },
  },
  ...extra,
});
const SUMMARY = { status: "ok", data: { reportsReady: 4, reportsPending: 1, packagesReady: 3, packagesPending: 0, packagesBlocked: 1, totalEvidenceWithArtifacts: 5 } };

before(async () => {
  M = await loadModule("app/(stack)/reports.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/reports.ts"]);
});
beforeEach(async () => {
  requests = [];
  M.calls.reset();
  globalThis.__LINKING_OPENED__ = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/reports/artifacts": (path) =>
      path.includes("limit=1") && !path.includes("summary=0")
        ? { ...aggregator([ROW]), sections: { summary: SUMMARY, artifacts: { status: "ok", items: [ROW], nextCursor: null, total: 2 } } }
        : aggregator([ROW, BLOCKED]),
    "/v1/governance/export-eligibility": () => ({ outcome: "ALLOWED", reason: "", lifecycleState: "ACTIVE" }),
    "/v1/evidence/e1/report/latest": () => ({ url: "https://files.example/report.pdf" }),
    "/v1/evidence/e1/verification-package": () => ({ url: "https://files.example/package.zip" }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    const status = res?.__status ?? (res ? 200 : 500);
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
const gets = () => requests.filter((q) => q.method === "GET").map((q) => q.path);

test("the page says what it is, in the web's words, and when it was refreshed", async () => {
  const r = await render();
  assert.ok(r.hasText("Reports & Artifacts"));
  assert.ok(r.hasText("DELIVERABLES") || r.hasText("Deliverables"));
  assert.ok(r.hasText("Generated report snapshots and verification packages. These are workspace deliverables"));
  assert.ok(r.hasText("Refreshed 5m ago"));
  assert.ok(r.hasText("Browsing this page never triggers report or package generation and never marks any artifact as viewed."));
  r.unmount();
});

test("the counters are read once on their own; the list asks with summary=0", async () => {
  const r = await render();
  assert.ok(gets().includes("/v1/reports/artifacts?teamId=team-1&limit=1"), gets().join("\n"));
  assert.ok(gets().some((p) => p.startsWith("/v1/reports/artifacts?teamId=team-1&limit=25&summary=0")));
  assert.equal(r.byLabel("Packages blocked: 1").length, 1);
  assert.ok(r.hasText("Artifacts · 2"));
  r.unmount();
});

test("a summary the server skipped or failed is said, and the list stays usable", async () => {
  routes["/v1/reports/artifacts"] = (path) => (path.includes("summary=0") ? aggregator([ROW]) : { __status: 500, message: "x" });
  const r = await render();
  assert.ok(r.hasText("Summary is temporarily unavailable. The artifact list below remains usable."));
  assert.ok(r.hasText("Roof photo"));
  r.unmount();
});

test("a list section the aggregator marked unavailable is said as such", async () => {
  routes["/v1/reports/artifacts"] = () => ({ ...aggregator([]), sections: { summary: SUMMARY, artifacts: { status: "unavailable", items: [], nextCursor: null, total: null } } });
  const r = await render();
  assert.ok(r.hasText("Artifact list is temporarily unavailable. Retry shortly."));
  r.unmount();
});

test("each row says its report and package lifecycle, version, capture time and governance block", async () => {
  const r = await render();
  assert.ok(r.hasText("Report ready · v2"));
  assert.ok(r.hasText("Package ready · v1"));
  assert.ok(r.hasText("Captured 3d ago"));
  assert.ok(r.hasText("Report pending"));
  assert.ok(r.hasText("Package blocked by governance"));
  assert.ok(r.hasText("Export blocked by governance: Legal hold"));
  assert.equal(r.byLabel("Package blocked — Legal hold").length, 1);
  assert.equal(r.byLabel("Report generating — refresh shortly").length, 1);
  r.unmount();
});

test("Download Report PDF runs the governance preflight, then mints one URL on tap", async () => {
  const r = await render();
  assert.equal(gets().filter((p) => p.includes("/report/latest")).length, 0, "browsing minted a URL");
  await r.press("Download Report PDF: Roof photo");
  await settle();
  const seq = gets().filter((p) => p.includes("export-eligibility") || p.includes("/report/latest"));
  assert.deepEqual(seq, ["/v1/governance/export-eligibility?teamId=team-1&evidenceId=e1", "/v1/evidence/e1/report/latest"]);
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://files.example/report.pdf"]);
  r.unmount();
});

test("Download Verification Package ZIP is offered for a ready package and opens its URL", async () => {
  const r = await render();
  await r.press("Download Verification Package ZIP: Roof photo");
  await settle();
  assert.ok(gets().includes("/v1/evidence/e1/verification-package"));
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://files.example/package.zip"]);
  r.unmount();
});

test("a blocked governance verdict is said inline and nothing is minted", async () => {
  routes["/v1/governance/export-eligibility"] = () => ({ outcome: "BLOCKED_BY_HOLD", reason: "hold", lifecycleState: "ACTIVE" });
  const r = await render();
  await r.press("Download Report PDF: Roof photo");
  await settle();
  assert.ok(r.hasText("Blocked by legal hold"));
  assert.equal(gets().filter((p) => p.includes("/report/latest")).length, 0);
  r.unmount();
});

test("a refused download is said in the web's words", async () => {
  routes["/v1/evidence/e1/verification-package"] = () => ({ __status: 403, message: "forbidden" });
  const r = await render();
  await r.press("Download Verification Package ZIP: Roof photo");
  await settle();
  assert.ok(r.hasText("You don't have permission to download this package."));
  r.unmount();
});

test("the case and the evidence are reachable from the row", async () => {
  const r = await render();
  await r.press("Case: Leaking roof");
  await r.press("Open evidence: Roof photo");
  assert.deepEqual(M.calls.push, ["/case/c1", "/evidence/e1"]);
  r.unmount();
});

test("the empty state knows what was asked", async () => {
  routes["/v1/reports/artifacts"] = (path) => (path.includes("summary=0") ? aggregator([]) : { ...aggregator([]), sections: { summary: SUMMARY, artifacts: { status: "ok", items: [], nextCursor: null, total: 0 } } });
  routes["/v1/reports"] = () => ({ items: [], nextCursor: null });
  const r = await render();
  assert.ok(r.hasText("No reports yet"));
  assert.ok(r.hasText("Reports are generated from signed evidence. Capture or upload evidence to create your first report."));
  await r.press("Open evidence");
  assert.deepEqual(M.calls.push, ["/evidence"]);
  await r.press("Lifecycle: Package blocked");
  await settle();
  assert.ok(r.hasText("No reports match this filter."));
  assert.ok(r.hasText("Adjust the filter or the search to widen the query."));
  r.unmount();
});

test("a workspace the caller is not a member of falls back to the user-scoped list", async () => {
  routes["/v1/reports/artifacts"] = () => ({ __status: 404, message: "not_found" });
  routes["/v1/reports"] = () => ({
    items: [{
      evidenceId: "e9", title: null, displayFileName: "scan.pdf", originalFileName: null, mimeType: "application/pdf", type: "DOCUMENT", status: "REPORTED",
      caseId: null, createdAt: "2026-09-01T00:00:00.000Z", reportLifecycle: "READY", packageLifecycle: "GENERATING",
      outputs: output(), report: { available: true, version: 1, generatedAtUtc: null }, package: { available: false, version: null, generatedAtUtc: null },
    }],
    nextCursor: null,
  });
  const r = await render();
  assert.ok(gets().includes("/v1/reports"));
  assert.ok(r.hasText("scan.pdf"));
  assert.ok(r.hasText("Report ready · v1"));
  assert.ok(r.hasText("Package pending"));
  r.unmount();
});

test("a filtered empty result never triggers the unfiltered fallback", async () => {
  routes["/v1/reports/artifacts"] = (path) => (path.includes("lifecycle=") ? aggregator([]) : aggregator([ROW]));
  routes["/v1/reports"] = () => ({ items: [], nextCursor: null });
  const r = await render();
  await r.press("Lifecycle: Report failed");
  await settle();
  assert.equal(gets().filter((p) => p === "/v1/reports").length, 0);
  r.unmount();
});

test("a role without report access gets the access explanation, not a generic failure", async () => {
  routes["/v1/reports/artifacts"] = (path) => (path.includes("summary=0") ? { __status: 403, message: "forbidden" } : aggregator([]));
  const r = await render();
  assert.ok(r.hasText("You don't have access to this workspace's reports"));
  r.unmount();
});

test("the parser reads only keys the aggregator sends (report.state / package.state)", () => {
  const page = M.parseArtifacts({
    sections: { artifacts: { status: "ok", items: [{ evidenceId: "e1", reportState: "READY", packageState: "READY", verificationPackage: { state: "READY" }, report: { state: "failed" }, package: { state: "not_requested" } }] } },
  });
  // Top-level reportState / packageState and verificationPackage.state are not in the envelope.
  assert.equal(page.items[0].reportState, "failed");
  assert.equal(page.items[0].packageState, "not_requested");
});
