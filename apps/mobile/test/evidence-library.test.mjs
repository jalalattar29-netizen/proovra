/**
 * GUARD — native evidence-library helpers (Master Program §4/A, M1). Query
 * building maps each filter to the REAL server param; the summary projects real
 * counts; bulk actions match the scope's lifecycle. Pure module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/evidence-library.ts"), "utf8").replace(/^import type .*$/m, "");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const TONES = new Set(["verified", "pending", "risk", "neutral", "governance", "info"]);

test("query maps each filter to its real server param", () => {
  const q = mod.buildLibraryQuery({ scope: "active", search: " car ", type: "PHOTO", status: "SIGNED", source: "MOBILE_APP", reportReady: "ready", sort: "priority" });
  assert.match(q, /^\/v1\/evidence\?/);
  assert.match(q, /scope=active/);
  assert.match(q, /search=car/); // trimmed
  assert.match(q, /type=PHOTO/);
  assert.match(q, /status=SIGNED/);
  assert.match(q, /acquisition=MOBILE_APP/); // source → acquisition param
  assert.match(q, /reportReady=ready/);
  assert.match(q, /sort=priority/);
});

test("ALL filters and blank search are omitted", () => {
  const q = mod.buildLibraryQuery({ scope: "trash", type: "ALL", status: "ALL", source: "ALL", reportReady: "ALL", sort: "newest", search: "" });
  assert.doesNotMatch(q, /type=|status=|acquisition=|reportReady=|search=/);
  assert.match(q, /scope=trash/);
});

test("sort cycles newest → oldest → priority → newest", () => {
  assert.equal(mod.nextSort("newest"), "oldest");
  assert.equal(mod.nextSort("oldest"), "priority");
  assert.equal(mod.nextSort("priority"), "newest");
});

test("hasActiveFilters detects any non-ALL refinement", () => {
  assert.equal(mod.hasActiveFilters({ type: "ALL", status: "ALL", source: "ALL", reportReady: "ALL" }), false);
  assert.equal(mod.hasActiveFilters({ type: "ALL", status: "SIGNED", source: "ALL", reportReady: "ALL" }), true);
});

test("the eight KPI cards read the workspace summary, and say so", () => {
  const summary = mod.parseLibrarySummary({ scope: "active", source: "workspace_total", totalActiveRecords: 20, reportsReadyCount: 12, packagesReadyCount: 9, packagesMissingCount: 3, storageProtectedCount: 7, storageNeedsReviewCount: 13, multipartCount: 2, verificationIssuesCount: 1, unassignedCount: 5, needsActionCount: 6 });
  const m = mod.buildLibraryMetrics(summary, [{ id: "a", reviewReadyAtUtc: "2026-09-01T00:00:00Z" }]);
  assert.deepEqual(m.map((x) => x.label), ["Active records", "Reports ready", "Verification packages ready", "Verification packages missing", "Storage protection", "Multipart packages", "Unassigned records", "Review-ready records"]);
  const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
  assert.equal(byKey.active.value, "20");
  assert.equal(byKey.active.caption, "Workspace total");
  assert.equal(byKey["packages-missing"].tone, "risk"); // >0 is the one attention state
  assert.equal(byKey["review-ready"].value, "1");
  assert.equal(byKey["review-ready"].caption, "On this page");
  for (const x of m) if (x.tone) assert.ok(TONES.has(x.tone));
});

test("without the summary, cards are labelled page-derived and package readiness is never proxied", () => {
  assert.equal(mod.parseLibrarySummary({ message: "boom" }), null);
  const m = mod.buildLibraryMetrics(null, [
    { id: "a", reportReady: true, caseId: null, itemCount: 3, storage: { verified: true } },
    { id: "b", reportReady: false, caseId: "c1", itemCount: 1 },
  ]);
  const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
  assert.equal(byKey.active.value, "2");
  assert.equal(byKey.active.caption, "On this page");
  assert.equal(byKey.reports.value, "1");
  assert.equal(byKey["packages-ready"].value, "—");
  assert.equal(byKey["packages-ready"].caption, "Package readiness unavailable");
  assert.equal(byKey["packages-missing"].value, "—");
  assert.equal(byKey.multipart.value, "1");
  assert.equal(byKey.unassigned.value, "1");
  assert.equal(byKey.storage.value, "1");
});

test("bulk actions match case + lifecycle semantics for each scope", () => {
  assert.deepEqual(
    mod.bulkActionsForScope("active").map((a) => a.action),
    ["ADD_TO_CASE", "REMOVE_FROM_CASE", "ARCHIVE", "TRASH", "EXPORT_METADATA_CSV"],
  );

  assert.deepEqual(
    mod.bulkActionsForScope("locked").map((a) => a.action),
    ["ADD_TO_CASE", "REMOVE_FROM_CASE", "ARCHIVE", "TRASH", "EXPORT_METADATA_CSV"],
  );

  assert.deepEqual(
    mod.bulkActionsForScope("archived").map((a) => a.action),
    ["ADD_TO_CASE", "REMOVE_FROM_CASE", "RESTORE_ARCHIVED", "TRASH", "EXPORT_METADATA_CSV"],
  );

  assert.deepEqual(
    mod.bulkActionsForScope("trash").map((a) => a.action),
    ["RESTORE_TRASH", "EXPORT_METADATA_CSV"],
  );
});


test("saved views parse the real { items } envelope and map deleted to trash", () => {
  const views = mod.parseSavedViews({
    items: [
      {
        id: "view-1",
        name: "Trash photos",
        scope: "deleted",
        filters: {
          search: " receipt ",
          type: "PHOTO",
          status: "SIGNED",
          sort: "oldest",
        },
        sortKey: "priority",
        isDefault: true,
      },
    ],
  });

  assert.equal(views.length, 1);
  // PHOTO / SIGNED are the enum spellings an older native build saved; the
  // filter values are the web's (EvidenceFilters.tsx), so they normalise.
  assert.deepEqual(views[0], {
    id: "view-1",
    name: "Trash photos",
    description: null,
    teamId: null,
    scope: "trash",
    type: "image",
    status: "signed",
    search: " receipt ",
    review: "all",
    exportReadiness: "all",
    caseAssignment: "all",
    retention: "all",
    sort: "priority",
    isDefault: true,
  });
});

test("a saved view restores every dimension the web saves (review, export, case, retention)", () => {
  const [view] = mod.parseSavedViews({
    items: [
      {
        id: "v", ownerUserId: "u", teamId: "t1", name: "Unassigned ready", description: "Triage", scope: "archived",
        filters: { search: "", scope: "archived", status: "reported", type: "video", review: "review-required", exportReadiness: "report-missing", caseAssignment: "unassigned", retention: "protected", sort: "oldest" },
        sortKey: "oldest", isDefault: false, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
      },
    ],
  });
  const f = mod.savedViewToFilters(view);
  assert.equal(f.scope, "archived");
  assert.equal(f.review, "review-required");
  assert.equal(f.exportReadiness, "report-missing");
  assert.equal(f.caseAssignment, "unassigned");
  assert.equal(f.retention, "protected");
  assert.equal(f.sort, "oldest");
  assert.equal(mod.savedViewMetaLine(view), "Scope: archived • Sort: oldest • Team view");
  assert.equal(mod.savedViewMetaLine({ ...view, teamId: null, isDefault: true }), "Scope: archived • Sort: oldest • Personal view • Default");
});

test("saved views drop malformed rows and normalize server all values", () => {
  const views = mod.parseSavedViews({
    items: [
      null,
      {},
      { id: "missing-name" },
      { name: "missing-id" },
      {
        id: "valid",
        name: "Everything",
        scope: "active",
        filters: {
          type: "all",
          status: "all",
          sort: "oldest",
        },
      },
    ],
  });

  assert.equal(views.length, 1);
  assert.equal(views[0].id, "valid");
  assert.equal(views[0].type, "all");
  assert.equal(views[0].status, "all");
  assert.equal(views[0].sort, "oldest");
  assert.equal(views[0].isDefault, false);
});

test("saved-view sortKey wins over filters.sort and invalid sort falls back to newest", () => {
  const views = mod.parseSavedViews({
    items: [
      {
        id: "one",
        name: "One",
        scope: "active",
        sortKey: "priority",
        filters: { sort: "oldest" },
      },
      {
        id: "two",
        name: "Two",
        scope: "active",
        sortKey: "not-real",
        filters: { sort: "oldest" },
      },
    ],
  });

  assert.equal(views[0].sort, "priority");
  assert.equal(views[1].sort, "newest");
});

test("saved-view body trims values and maps native trash to server deleted", () => {
  // CreateSavedViewBody (evidence.saved-views.routes.ts): name, description,
  // teamId, scope, filters (SavedViewFiltersSchema), sortKey, isDefault.
  assert.deepEqual(
    mod.buildSavedViewBody({
      name: "  My view  ",
      description: "  ",
      isDefault: true,
      teamId: "",
      filters: { ...mod.DEFAULT_LIBRARY_FILTERS, scope: "trash", search: "  invoice  ", sort: "priority", review: "verification-failed", acquisition: "MOBILE_APP" },
    }),
    {
      name: "My view",
      description: null,
      isDefault: true,
      teamId: null,
      scope: "deleted",
      sortKey: "priority",
      filters: {
        search: "invoice",
        scope: "deleted",
        status: "all",
        type: "all",
        review: "verification-failed",
        exportReadiness: "all",
        caseAssignment: "all",
        retention: "all",
        tsaStatus: "all",
        otsStatus: "all",
        publicVerifyState: "all",
        verificationStatus: "all",
        sort: "priority",
      },
    },
  );
});


test("bulk response projects canonical CSV metadata without inventing mutation state", () => {
  assert.deepEqual(
    mod.parseEvidenceBulkResponse({
      csv: "id,status\n1,SIGNED",
      fileName: " evidence-export ",
    }),
    {
      csv: "id,status\n1,SIGNED",
      fileName: "evidence-export",
    },
  );

  assert.deepEqual(mod.parseEvidenceBulkResponse(null), {});
  assert.deepEqual(mod.parseEvidenceBulkResponse("garbage"), {});
});

test("CSV filename is safe, deterministic, and always has a csv extension", () => {
  assert.equal(mod.safeCsvFilename(undefined), "proovra-evidence-metadata.csv");
  assert.equal(mod.safeCsvFilename("evidence-export"), "evidence-export.csv");
  assert.equal(mod.safeCsvFilename("report.csv"), "report.csv");
  assert.equal(mod.safeCsvFilename('bad:name?.csv'), "bad-name-.csv");
});


test("bulk selection clears after a terminal total success", () => {
  assert.deepEqual(
    mod.resolveBulkSelection(["a", "b"], {
      successCount: 2,
      failedCount: 0,
      results: [
        { evidenceId: "a", ok: true },
        { evidenceId: "b", ok: true },
      ],
    }),
    [],
  );
});

test("bulk selection retains only failed ids after a terminal partial result", () => {
  assert.deepEqual(
    mod.resolveBulkSelection(["a", "b", "c"], {
      successCount: 2,
      failedCount: 1,
      results: [
        { evidenceId: "a", ok: true },
        { evidenceId: "b", ok: false, reason: "RETENTION_ACTIVE" },
        { evidenceId: "c", ok: true },
      ],
    }),
    ["b"],
  );
});

test("bulk selection stays untouched for queued or incomplete responses", () => {
  assert.deepEqual(
    mod.resolveBulkSelection(["a", "b"], {
      accepted: true,
      queued: true,
      pendingCount: 2,
      results: [],
    }),
    ["a", "b"],
  );

  assert.deepEqual(
    mod.resolveBulkSelection(["a", "b"], {
      successCount: 1,
      failedCount: 0,
      results: [{ evidenceId: "a", ok: true }],
    }),
    ["a", "b"],
  );
});


test("inspector projects real content policy and resolves the canonical preview order", () => {
  const evidence = mod.projectInspectorEvidence({
    evidence: {
      id: "ev-1",
      type: "PHOTO",
      status: "SIGNED",
      statusLabel: "Signed",
      createdAt: "2026-09-19T10:00:00.000Z",
      defaultPreviewItemId: "content-2",
      contentAccessPolicy: {
        mode: "full",
        allowContentView: true,
      },
      contentItems: [
        {
          id: "content-1",
          kind: "image",
          mimeType: "image/jpeg",
          previewable: true,
          viewUrl: "https://example.test/one.jpg",
          isPrimary: true,
        },
        {
          id: "content-2",
          kind: "image",
          mimeType: "image/png",
          previewable: true,
          viewUrl: "https://example.test/two.png",
        },
      ],
    },
  });

  assert.equal(evidence.id, "ev-1");
  assert.equal(
    mod.resolveInspectorPreview(evidence).url,
    "https://example.test/two.png",
  );
});

test("inspector never exposes a preview when content policy denies viewing", () => {
  const evidence = mod.projectInspectorEvidence({
    evidence: {
      id: "ev-2",
      type: "DOCUMENT",
      status: "SIGNED",
      defaultPreviewItemId: "content-1",
      contentAccessPolicy: {
        mode: "metadata_only",
        allowContentView: false,
      },
      contentItems: [
        {
          id: "content-1",
          kind: "document",
          mimeType: "application/pdf",
          previewable: true,
          viewUrl: "https://example.test/secret.pdf",
        },
      ],
    },
  });

  assert.deepEqual(mod.resolveInspectorPreview(evidence), {
    kind: "restricted",
  });
});

test("inspector treats previewable content without a server view URL as restricted", () => {
  const evidence = mod.projectInspectorEvidence({
    evidence: {
      id: "ev-3",
      type: "VIDEO",
      status: "SIGNED",
      contentAccessPolicy: {
        mode: "full",
        allowContentView: true,
      },
      contentItems: [
        {
          id: "content-1",
          kind: "video",
          mimeType: "video/mp4",
          previewable: true,
          viewUrl: null,
          isPrimary: true,
        },
      ],
    },
  });

  assert.deepEqual(mod.resolveInspectorPreview(evidence), {
    kind: "restricted",
  });
});

test("inspector artifact projection reads status only and never invents URLs", () => {
  assert.deepEqual(
    mod.projectInspectorArtifactState({
      outputs: {
        report: { state: "READY" },
        verificationPackage: { state: "GENERATING" },
      },
    }),
    {
      report: "READY",
      verificationPackage: "GENERATING",
    },
  );

  assert.deepEqual(mod.projectInspectorArtifactState(null), {
    report: null,
    verificationPackage: null,
  });
});

/* ------------------------------------------- F-03 managing a saved view -- */

test("the saved-view routes are the canonical ones", () => {
  // Five handlers exist (evidence.saved-views.routes.ts); native called two.
  assert.equal(mod.buildSavedViewPath("v 1"), "/v1/evidence/saved-views/v%201");
  assert.equal(
    mod.buildSavedViewDefaultPath("v1"),
    "/v1/evidence/saved-views/v1/default",
  );
});

test("a rename is bounded by the route's own limit", () => {
  assert.equal(mod.SAVED_VIEW_NAME_MAX, 120);
  assert.match(mod.validateSavedViewName(""), /Name the view/);
  assert.match(mod.validateSavedViewName("   "), /Name the view/);
  assert.match(mod.validateSavedViewName("x".repeat(121)), /120/);
  assert.equal(mod.validateSavedViewName("Open claims"), null);
  assert.deepEqual(mod.buildSavedViewRenameBody("  Open claims "), { name: "Open claims" });
});

test("setting a default clears the previous one", () => {
  // The server clears it in the same workspace, so a client that only flipped
  // the new row would show two defaults until the next read.
  const views = [
    { id: "a", name: "A", isDefault: true },
    { id: "b", name: "B", isDefault: false },
    { id: "c", name: "C", isDefault: false },
  ];
  const next = mod.withDefaultSavedView(views, "b");
  assert.deepEqual(
    next.map((v) => [v.id, v.isDefault]),
    [["a", false], ["b", true], ["c", false]],
  );
});

test("the default view applies on a clean library, never over a live filter", () => {
  const views = [
    { id: "a", name: "A", isDefault: false },
    { id: "b", name: "B", isDefault: true },
  ];
  assert.equal(mod.defaultSavedViewToApply(views, true)?.id, "b");
  // A default that overrode a filter the operator just set would be the
  // surface arguing with them.
  assert.equal(mod.defaultSavedViewToApply(views, false), null);
  assert.equal(mod.defaultSavedViewToApply([{ id: "a", isDefault: false }], true), null);
  assert.equal(mod.defaultSavedViewToApply([], true), null);
});

test("the inspector's lifecycle comes from lifecycle.productState, the key GET /v1/evidence/:id sends", () => {
  const archived = mod.projectInspectorEvidence({ evidence: { id: "e1", status: "SIGNED", lifecycle: { productState: "ARCHIVED" } } });
  assert.equal(archived.lifecycleState, "ARCHIVED");
  const fiction = mod.projectInspectorEvidence({ evidence: { id: "e1", status: "SIGNED", lifecycleState: "ARCHIVED" } });
  assert.equal(fiction.lifecycleState, null, "a key the server never sends was still read");
});
