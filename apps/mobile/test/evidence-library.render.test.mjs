/**
 * RENDER — the native Evidence Library against the web /evidence page.
 *
 * Every stub is the server's REAL reply shape:
 *   GET  /v1/evidence                      { scope, items, pageInfo }            evidence.routes.ts:6908
 *   GET  /v1/evidence/library-summary      { scope, source, totalActiveRecords… } evidence.routes.ts:7080
 *   GET  /v1/evidence/saved-views          { items: [mapEvidenceSavedView] }      evidence.saved-views.routes.ts:239
 *   POST /v1/evidence/saved-views          { savedView }                          evidence.saved-views.routes.ts:289
 *   POST /v1/evidence/bulk                 { successCount, failedCount, results, items } evidence.routes.ts:7338
 *   GET  /v1/cases                         { items }                              cases.routes.ts:654
 *   GET  /v1/evidence/:id                  { evidence: { …, anchor, contentAccessPolicy, contentItems } } evidence.routes.ts:10040
 *   GET  /v1/evidence/:id/artifacts/status EvidenceArtifactStatus                 evidence.routes.ts:10683
 *   GET  /v1/evidence/:id/review-workspace { workspaceCapabilitySnapshot, … }     evidence.routes.ts:8794
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
const E1 = "0adf0000-0000-4000-8000-0000000000c1";
const E2 = "0adf0000-0000-4000-8000-0000000000c2";
const CASE = "5c000000-0000-4000-8000-000000000001";

let M;
let routes;
let requests;
let rendered;

function row(id, over = {}) {
  return {
    id,
    title: null,
    type: "PHOTO",
    status: "SIGNED",
    statusLabel: "Signed",
    verificationStatus: "MATERIALS_AVAILABLE",
    displayTitle: `Record ${id.slice(-2)}`,
    itemCount: 1,
    caseId: null,
    reportReady: true,
    reviewReadyAtUtc: null,
    acquisition: { mode: "UPLOAD_WEB", category: "UPLOAD", label: "Uploaded", recorded: true },
    lifecycle: { productState: "ACTIVE", canArchive: true, canUnarchive: false, canTrash: true, canRestoreFromTrash: false },
    storage: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

function summary() {
  return {
    scope: "active",
    source: "workspace_total",
    totalActiveRecords: 42,
    reportsReadyCount: 30,
    packagesReadyCount: 28,
    packagesMissingCount: 2,
    storageProtectedCount: 11,
    storageNeedsReviewCount: 31,
    multipartCount: 4,
    verificationIssuesCount: 1,
    unassignedCount: 9,
    needsActionCount: 10,
  };
}

before(async () => {
  M = await loadModule("app/(tabs)/evidence.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  globalThis.__EXPO_PARAMS__ = {};
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "GET /v1/evidence/library-summary": () => summary(),
    "GET /v1/evidence/saved-views": () => ({ items: [] }),
    "GET /v1/cases": () => ({ items: [{ id: CASE, name: "Harbour claim", status: "OPEN" }] }),
    "GET /v1/evidence": () => ({
      scope: "active",
      items: [row(E1, { caseId: CASE, itemCount: 3, acquisition: { mode: "MOBILE_APP", category: "MOBILE_APP", label: "Mobile app", recorded: true } }), row(E2)],
      pageInfo: { limit: 50, nextCursor: null, hasMore: false },
    }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
    const keys = Object.keys(routes).filter((k) => {
      const [m, p] = k.includes(" ") ? k.split(" ") : ["GET", k];
      return m === method && path.startsWith(p);
    });
    const key = keys.sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response(JSON.stringify({ message: "not stubbed" }), { status: 500, headers: { "content-type": "application/json" } });
    const out = routes[key]({ path, body: init.body ? JSON.parse(init.body) : null });
    const status = out && out.__status ? out.__status : 200;
    return new Response(JSON.stringify(out && out.__body ? out.__body : out), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
  M.calls.push.length = 0;
});

afterEach(() => {
  if (rendered) rendered.unmount();
  rendered = null;
});

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
async function mount() {
  rendered = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  // The search is debounced by 300ms before it joins the server query.
  await act(async () => { await new Promise((x) => setTimeout(x, 320)); });
  await settle();
  return rendered;
}

test("the page header, legal boundary and the eight workspace KPI cards match the web", async () => {
  const r = await mount();
  for (const t of [
    "Evidence Library",
    "Operational workspace for managing, reviewing, and exporting preserved evidence records.",
    "Legal boundary",
    "Active records",
    "Verification packages missing",
    "Review-ready records",
    "Workspace total",
    "Evidence queue",
    "Results are loaded from the server using the selected filters.",
  ]) assert.ok(r.hasText(t), `missing "${t}"`);
  assert.ok(r.byLabel("Active records: 42").length > 0);
  assert.ok(r.byLabel("Unassigned records: 9").length > 0);
  await r.press("Upload / Capture Evidence");
  await r.press("New Case");
  assert.deepEqual(M.calls.push, ["/capture", "/cases"]);
});

test("the summary is asked with the SAME filters as the list, not the scope alone", async () => {
  const r = await mount();
  await r.press("More filters");
  await r.press("Case: Unassigned");
  await settle();
  const sums = requests.filter((q) => q.path.startsWith("/v1/evidence/library-summary"));
  const last = sums[sums.length - 1].path;
  assert.match(last, /caseAssignment=unassigned/);
  const lists = requests.filter((q) => q.method === "GET" && q.path.startsWith("/v1/evidence?"));
  assert.match(lists[lists.length - 1].path, /caseAssignment=unassigned/);
});

test("rows carry the short id, the case name and the activity line", async () => {
  const r = await mount();
  assert.ok(r.hasText("0adf0000…0000c1   Case: Harbour claim"));
  assert.ok(r.hasText("3 items • Signed • Mobile app"));
  assert.ok(r.hasText("1 item • Signed"));
});

test("an empty scope offers the web's two ways forward", async () => {
  routes["GET /v1/evidence"] = () => ({ scope: "active", items: [], pageInfo: { limit: 50, nextCursor: null, hasMore: false } });
  const r = await mount();
  assert.ok(r.hasText("No evidence records in this scope"));
  assert.ok(r.hasText("Adjust the scope or filters, or capture new evidence to populate the reviewer queue."));
  await r.press("Review Cases");
  assert.deepEqual(M.calls.push, ["/cases"]);
});

test("a failed list says the list is unavailable and retries", async () => {
  routes["GET /v1/evidence"] = () => ({ __status: 500, __body: { message: "boom" } });
  const r = await mount();
  assert.ok(r.hasText("Evidence list unavailable"));
  routes["GET /v1/evidence"] = () => ({ scope: "active", items: [row(E2)], pageInfo: { limit: 50, nextCursor: null, hasMore: false } });
  await r.press("Try again");
  await settle();
  assert.ok(r.hasText("Record c2"));
});

test("the Inspector is the web's queue selection, read from status — no URL is minted on open", async () => {
  routes[`GET /v1/evidence/${E1}/artifacts/status`] = () => ({
    evidenceId: E1,
    status: "SIGNED",
    finalized: true,
    outputs: { report: { state: "READY" }, verificationPackage: { state: "NOT_INCLUDED" } },
    report: { available: true, version: 1, generatedAtUtc: "2026-09-02T10:00:00.000Z", pdfSignature: { status: "SIGNED", warning: null } },
    verificationPackage: { available: false, version: null, generatedAtUtc: null, pending: false, unavailable: true, blocked: false },
  });
  routes[`GET /v1/evidence/${E1}/review-workspace`] = () => ({
    workspaceCapabilitySnapshot: { reportsIncluded: true, verificationPackageIncluded: false, publicVerifyIncluded: true },
  });
  routes[`GET /v1/evidence/${E1}`] = () => ({
    evidence: {
      id: E1,
      type: "PHOTO",
      status: "SIGNED",
      verificationStatus: "MATERIALS_AVAILABLE",
      anchor: { mode: "ready", provider: "ots", configured: true, anchorHash: null, transactionId: null, anchoredAtUtc: null },
      contentAccessPolicy: { mode: "metadata_only", allowContentView: false },
      contentItems: [],
      lifecycle: { productState: "ACTIVE" },
    },
  });
  const r = await mount();
  await r.press("Record c1");
  await settle();
  for (const t of [
    "Queue selection",
    "An operational preview of the selected record. The full review workspace opens from the Evidence record.",
    "Harbour claim",
    "Technical materials available",
    "Preview restricted",
    "Report available",
    "Verification packages are not included for this evidence record.",
    "The anchor is configured. No anchored timestamp is recorded yet.",
    "No verification package is recorded for this record.",
  ]) assert.ok(r.hasText(t), `missing "${t}"`);
  assert.equal(requests.some((q) => /report\/latest|verification-package/.test(q.path)), false, "a download URL was minted on open");
  // Report is READY → the download is live; the package reason is stated as text.
  const dl = r.byLabel("Download Report").find((n) => n.props.onPress);
  assert.equal(dl.props.accessibilityState.disabled, false);
  const pkg = r.byLabel("Download Verification Package").find((n) => n.props.onPress);
  assert.equal(pkg.props.accessibilityState.disabled, true);
  // Public verification is included and configured → the link is the public /verify page.
  const copy = r.byLabel("Copy Verification Link").find((n) => n.props.onPress);
  assert.equal(copy.props.accessibilityState.disabled, false);
  await r.press("Copy Verification Link");
  assert.equal(globalThis.__CLIPBOARD__, `https://www.proovra.com/verify/${E1}`);
  await r.press("Open Evidence");
  assert.deepEqual(M.calls.push, [`/evidence/${E1}`]);
});

test("the Inspector says why the preview cannot load when the record read fails", async () => {
  routes[`GET /v1/evidence/${E2}`] = () => ({ __status: 500, __body: { message: "boom" } });
  const r = await mount();
  await r.press("Record c2");
  await settle();
  assert.ok(r.hasText("Queue preview unavailable"));
});

test("bulk: Run Bulk Action confirms in words, and a partial result keeps the refused rows selected", async () => {
  routes["POST /v1/evidence/bulk"] = ({ body }) => ({
    successCount: 1,
    failedCount: 1,
    results: [
      { evidenceId: body.evidenceIds[0], ok: true },
      { evidenceId: body.evidenceIds[1], ok: false, reason: "LEGAL_HOLD_ACTIVE" },
    ],
    items: [],
  });
  const r = await mount();
  await r.press("Select all loaded pages");
  assert.ok(r.hasText("2 selected"));
  await r.press("Run Bulk Action");
  assert.ok(r.hasText("Confirm Bulk Action"));
  assert.ok(r.hasText("Archive will run for 2 currently selected records."));
  assert.ok(r.hasText("Bulk selection applies only to the records you selected in the currently loaded pages."));
  await r.press("Confirm Archive");
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/evidence/bulk");
  assert.deepEqual(post.body, { action: "ARCHIVE", evidenceIds: [E1, E2] });
  assert.ok(r.hasText("Bulk Action Results"));
  assert.ok(r.hasText("1 record archived"));
  assert.ok(r.hasText("1 record could not be archived"));
  assert.ok(r.hasText("Legal hold"));
  assert.ok(r.hasText("The records that could not be archived are still selected."));
  assert.ok(r.hasText("1 selected"));
});

test("bulk: Move to Trash names the records the lifecycle projection protects before submitting", async () => {
  routes["GET /v1/evidence"] = () => ({
    scope: "active",
    items: [row(E1, { lifecycle: { productState: "ACTIVE", canTrash: false, canArchive: true } }), row(E2)],
    pageInfo: { limit: 50, nextCursor: null, hasMore: false },
  });
  const r = await mount();
  await r.press("Select all loaded pages");
  await r.press("Bulk action: Move to Trash");
  assert.ok(r.hasText("1 of 2 selected records cannot be moved to trash"));
  assert.ok(r.hasText("1 eligible record will be moved to trash; 1 protected record will be skipped."));
});

test("bulk: a refused request leaves the selection and says it was not applied", async () => {
  routes["POST /v1/evidence/bulk"] = () => ({ __status: 400, __body: { message: "Invalid input", code: "INVALID_INPUT" } });
  const r = await mount();
  await r.press("Select evidence record Record c1");
  await r.press("Run Bulk Action");
  await r.press("Confirm Archive");
  await settle();
  assert.ok(r.hasText("The Archive request was invalid and was not applied. Please retry, or refresh the selected records."));
  assert.ok(r.hasText("1 selected"));
});

test("saved views: the list shows scope/sort/ownership and Load View restores every dimension", async () => {
  routes["GET /v1/evidence/saved-views"] = () => ({
    items: [
      {
        id: "v1", ownerUserId: "user-1", teamId: null, name: "Unassigned", description: null, sortKey: "oldest", scope: "active", isDefault: false,
        filters: { search: "", scope: "active", status: "all", type: "all", review: "all", exportReadiness: "report-missing", caseAssignment: "unassigned", retention: "all", sort: "oldest" },
        createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
      },
    ],
  });
  const r = await mount();
  await r.press("Saved Views");
  assert.ok(r.hasText("Saved evidence library filter set."));
  assert.ok(r.hasText("Scope: active • Sort: oldest • Personal view"));
  await r.press("Load View Unassigned");
  await settle();
  const lists = requests.filter((q) => q.method === "GET" && q.path.startsWith("/v1/evidence?"));
  const last = lists[lists.length - 1].path;
  assert.match(last, /caseAssignment=unassigned/);
  assert.match(last, /reportReady=missing/);
  assert.match(last, /sort=oldest/);
});

test("saved views: Save Current View sends the full filter set, description and default", async () => {
  routes["POST /v1/evidence/saved-views"] = ({ body }) => ({
    savedView: { id: "v9", ownerUserId: "user-1", teamId: null, name: body.name, description: body.description, filters: body.filters, sortKey: body.sortKey, scope: body.scope, isDefault: body.isDefault, createdAt: "x", updatedAt: "x" },
  });
  const r = await mount();
  await r.press("More filters");
  await r.press("Review: Review required");
  await r.press("Save Current View");
  assert.ok(r.hasText("This view will restore search, scope, status, type, review, export, case, retention, and sort."));
  await r.type("View name", "Needs review");
  await r.type("Description", "Morning triage");
  await r.press("Make this my default view");
  await r.press("Save View");
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/evidence/saved-views");
  assert.equal(post.body.name, "Needs review");
  assert.equal(post.body.description, "Morning triage");
  assert.equal(post.body.isDefault, true);
  assert.equal(post.body.teamId, null);
  assert.equal(post.body.filters.review, "review-required");
  assert.ok(r.hasText("Saved view created"));
});

test("Reviewer priority re-orders the loaded rows by review level", async () => {
  routes["GET /v1/evidence"] = () => ({
    scope: "active",
    items: [row(E1, { caseId: CASE }), row(E2, { verificationStatus: "FAILED", caseId: CASE })],
    pageInfo: { limit: 50, nextCursor: null, hasMore: false },
  });
  const r = await mount();
  const order = () => r.byRole("button").map((n) => n.props.accessibilityLabel).filter((l) => /^Record c[12]$/.test(l));
  assert.deepEqual(order(), ["Record c1", "Record c2"]);
  await r.press("Sort: Reviewer priority");
  await settle();
  assert.deepEqual(order(), ["Record c2", "Record c1"]);
});

test("pagination is the web's Previous / Next over the server cursor", async () => {
  routes["GET /v1/evidence"] = ({ path }) =>
    path.includes("cursor=")
      ? { scope: "active", items: [row(E2)], pageInfo: { limit: 50, nextCursor: null, hasMore: false } }
      : { scope: "active", items: [row(E1)], pageInfo: { limit: 50, nextCursor: "CUR2", hasMore: true } };
  const r = await mount();
  assert.ok(r.hasText("Page 1"));
  await r.press("Next");
  await settle();
  assert.ok(r.hasText("Page 2"));
  assert.ok(r.hasText("Record c2"));
  assert.ok(requests.some((q) => q.path.includes("cursor=CUR2")));
  await r.press("Previous");
  await settle();
  assert.ok(r.hasText("Page 1"));
});

test("a deep link lands pre-filtered, and the chip clears it", async () => {
  globalThis.__EXPO_PARAMS__ = { tsaStatus: "FAILED" };
  const r = await mount();
  assert.ok(r.hasText("Trust timestamp: Failed"));
  assert.ok(requests.some((q) => q.path.startsWith("/v1/evidence?") && q.path.includes("tsaStatus=FAILED")));
  await r.press("Clear Trust timestamp: Failed");
  await settle();
  assert.equal(r.hasText("Trust timestamp: Failed"), false);
});
