/**
 * GUARD — the native Evidence Library against the web /evidence page
 * (apps/web/app/(app)/evidence/page.tsx and components/*). Pure module:
 * query + summary params, loaded-row rules, deep-link filters, bulk failure
 * grouping and lifecycle protection, Inspector artifact rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/evidence-library.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("the summary carries the same filters as the list, so workspace counts follow them", () => {
  const f = {
    ...mod.DEFAULT_LIBRARY_FILTERS,
    scope: "archived",
    search: " car ",
    status: "signed",
    type: "multipart",
    caseAssignment: "unassigned",
    exportReadiness: "report-missing",
    acquisition: "NOT_RECORDED",
    review: "review-required",
    retention: "protected",
  };
  const path = mod.buildLibrarySummaryPath(f);
  assert.match(path, /^\/v1\/evidence\/library-summary\?/);
  for (const re of [/scope=archived/, /search=car/, /status=signed/, /type=multipart/, /caseAssignment=unassigned/, /reportReady=missing/, /acquisition=NOT_RECORDED/]) {
    assert.match(path, re);
  }
  // Review and retention have no route parameter; sort/limit/cursor are not aggregation inputs.
  assert.doesNotMatch(path, /review|retention|sort=|limit=|cursor=/);
  const list = mod.buildLibraryQuery(mod.filtersToQuery(f, "c1"));
  assert.match(list, /caseAssignment=unassigned/);
  assert.match(list, /cursor=c1/);
});

test("Reviewer priority re-orders the loaded rows — the route orders priority by date", () => {
  const f = { ...mod.DEFAULT_LIBRARY_FILTERS, sort: "priority" };
  const rows = [
    { id: "stable", status: "REPORTED", reportReady: true, caseId: "c" },
    { id: "unassigned", status: "REPORTED", reportReady: true, caseId: null },
    { id: "failed", status: "SIGNED", verificationStatus: "FAILED", reportReady: true, caseId: "c" },
    { id: "no-report", status: "SIGNED", reportReady: false, caseId: "c" },
  ];
  assert.deepEqual(mod.applyLoadedRowFilters(rows, f).map((r) => r.id), ["failed", "no-report", "unassigned", "stable"]);
  // Newest keeps the server order.
  assert.deepEqual(
    mod.applyLoadedRowFilters(rows, mod.DEFAULT_LIBRARY_FILTERS).map((r) => r.id),
    ["stable", "unassigned", "failed", "no-report"],
  );
});

test("Review narrows the loaded rows as the web does", () => {
  const rows = [
    { id: "ready", reviewReadyAtUtc: "2026-09-01T00:00:00Z" },
    { id: "req", verificationStatus: "REVIEW_REQUIRED" },
    { id: "bad", verificationStatus: "FAILED" },
  ];
  const on = (review) => mod.applyLoadedRowFilters(rows, { ...mod.DEFAULT_LIBRARY_FILTERS, review }).map((r) => r.id);
  assert.deepEqual(on("review-ready"), ["ready"]);
  assert.deepEqual(on("review-required"), ["req"]);
  assert.deepEqual(on("verification-failed"), ["bad"]);
});

test("a deep link lands pre-filtered and the reason is shown as a dismissible chip", () => {
  const o = mod.readFilterOverrides({ tsaStatus: "failed,rejected", verificationStatus: ["REVIEW_REQUIRED,FAILED"], type: "IMAGE", nothing: "" });
  assert.deepEqual(o, { tsaStatus: "FAILED,REJECTED", verificationStatus: "REVIEW_REQUIRED,FAILED", type: "image" });
  const chips = mod.activeTrustChips({ ...mod.DEFAULT_LIBRARY_FILTERS, ...o });
  assert.deepEqual(chips.map((c) => c.label), ["Trust timestamp: Failed / Rejected", "Needs integrity review"]);
});

test("bulk failures are grouped by the server's own reason; unknown stays unknown", () => {
  const groups = mod.groupBulkFailures([
    { evidenceId: "a", ok: false, reason: "RETENTION_ACTIVE" },
    { evidenceId: "b", ok: false, reason: "Evidence not found" },
    { evidenceId: "c", ok: false, reason: "LEGAL_HOLD_ACTIVE" },
    { evidenceId: "d", ok: false, reason: "RETENTION_WINDOW" },
    { evidenceId: "e", ok: false, reason: "something new" },
    { evidenceId: "f", ok: true },
  ]);
  assert.deepEqual(groups, [
    { key: "retention", label: "Protected by retention", count: 2 },
    { key: "permission", label: "Insufficient permission", count: 1 },
    { key: "legal_hold", label: "Legal hold", count: 1 },
    { key: "unknown", label: "Unknown server failure", count: 1 },
  ]);
  assert.equal(mod.isBulkValidationFailure({ statusCode: 400 }), true);
  assert.equal(mod.isBulkValidationFailure({ statusCode: 500 }), false);
  assert.equal(mod.isBulkQueued({ accepted: true }), true);
  assert.equal(mod.isBulkQueued({ accepted: true, successCount: 1, failedCount: 0 }), false);
});

test("the row's lifecycle projection decides which records a lifecycle action cannot touch", () => {
  const items = [
    { id: "a", lifecycle: { productState: "ACTIVE", canTrash: false, canArchive: true } },
    { id: "b", lifecycle: { productState: "ACTIVE", canTrash: true, canArchive: true } },
    { id: "c" }, // no projection: counted neither as allowed nor as blocked
  ];
  assert.equal(mod.countBulkProtected(items, "TRASH"), 1);
  assert.equal(mod.countBulkProtected(items, "ARCHIVE"), 0);
  assert.equal(mod.countBulkProtected(items, "EXPORT_METADATA_CSV"), 0);
  assert.deepEqual(mod.bulkActionsForScope("trash").map((a) => a.label), ["Restore from Trash", "Export Metadata CSV"]);
});

test("the Inspector's artifact rows follow the web's precedence over the canonical output state", () => {
  const fmt = (iso) => `@${iso}`;
  const base = {
    rowReportReady: false,
    facts: null,
    capabilities: { reportsIncluded: true, verificationPackageIncluded: true, publicVerifyIncluded: true },
    anchor: { configured: true, mode: "active", anchoredAtUtc: "T3" },
    formatDate: fmt,
  };
  // Real artifacts/status blocks (EvidenceArtifactStatus, evidence-artifact-status.service.ts).
  const ready = mod.buildInspectorArtifactRows({
    ...base,
    outputs: { report: "READY", verificationPackage: "READY" },
    facts: mod.projectInspectorArtifactFacts({
      report: { available: true, version: 1, generatedAtUtc: "T1", pdfSignature: { status: "SIGNED", warning: null } },
      verificationPackage: { available: true, version: 2, generatedAtUtc: "T2" },
    }),
  });
  assert.deepEqual(ready.map((r) => [r.title, r.state, r.detail]), [
    ["Report available", "available", "Generated @T1"],
    ["Verification package ready", "available", "Generated @T2"],
    ["Public verification", "available", "Anchored @T3"],
  ]);

  const excluded = mod.buildInspectorArtifactRows({
    ...base,
    outputs: { report: "NOT_INCLUDED", verificationPackage: "NOT_INCLUDED" },
    capabilities: null,
    anchor: null,
  });
  assert.deepEqual(excluded.map((r) => r.state), ["disabled", "disabled", "disabled"]);
  // An artifact that EXISTS is never described as "not in plan".
  const owned = mod.buildInspectorArtifactRows({
    ...base,
    rowReportReady: true,
    outputs: { report: "NOT_INCLUDED", verificationPackage: null },
    capabilities: { reportsIncluded: false, verificationPackageIncluded: false, publicVerifyIncluded: false },
  });
  assert.equal(owned[0].state, "pending");

  const reasons = mod.inspectorActionReasons({
    rowReportReady: false,
    outputs: { report: "GENERATING", verificationPackage: null },
    facts: null,
    capabilities: { publicVerifyIncluded: true },
    anchor: { configured: false },
  });
  assert.deepEqual(reasons, {
    report: "No generated report is recorded for this record.",
    package: "No verification package is recorded for this record.",
    link: "No public verification anchor is configured for this record.",
  });
  assert.equal(
    mod.projectInspectorEvidence({ evidence: { id: "e", anchor: { mode: "ready", configured: true, anchoredAtUtc: null } } }).anchor.mode,
    "ready",
  );
  assert.deepEqual(
    mod.projectInspectorCapabilities({ workspaceCapabilitySnapshot: { reportsIncluded: true, verificationPackageIncluded: false, publicVerifyIncluded: true } }),
    { reportsIncluded: true, verificationPackageIncluded: false, publicVerifyIncluded: true },
  );
});

test("team saved-view options come from the envelope's owned workspaces", () => {
  assert.deepEqual(
    mod.savedViewTeamOptions({ contextOptions: { ownedWorkspaces: [{ workspaceId: "w1", name: "Legal" }, { workspaceId: "w2" }, { name: "no id" }] } }),
    [{ id: "w1", name: "Legal" }, { id: "w2", name: "Workspace" }],
  );
  assert.deepEqual(mod.savedViewTeamOptions(null), []);
});

test("row identity uses the web's short id and activity line", () => {
  assert.equal(mod.shortId("0adf0000-0000-4000-8000-0000000000c1"), "0adf0000…0000c1");
  assert.equal(mod.shortId("short"), "short");
  assert.equal(
    mod.rowActivityLine({ itemCount: 3, status: "SIGNED", acquisition: { category: "MOBILE_APP", label: "Mobile app" } }),
    "3 items • Signed • Mobile app",
  );
  assert.equal(mod.rowActivityLine({ itemCount: 1, status: "REPORTED", acquisition: { category: "UPLOAD", label: "Uploaded" } }), "1 item • Reported");
});
