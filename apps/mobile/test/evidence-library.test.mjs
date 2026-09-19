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

test("library metrics project real counts with honest tones", () => {
  const m = mod.projectLibraryMetrics({ totalActiveRecords: 20, reportsReadyCount: 12, needsActionCount: 3, verificationIssuesCount: 0 });
  const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
  assert.equal(byKey.total.value, 20);
  assert.equal(byKey.needs.value, 3);
  assert.equal(byKey.needs.tone, "risk"); // >0 → risk
  assert.equal(byKey.issues.tone, "neutral"); // 0 → neutral
  for (const x of m) assert.ok(TONES.has(x.tone));
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
  assert.deepEqual(views[0], {
    id: "view-1",
    name: "Trash photos",
    scope: "trash",
    type: "PHOTO",
    status: "SIGNED",
    search: " receipt ",
    sort: "priority",
    isDefault: true,
  });
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
  assert.equal(views[0].type, "ALL");
  assert.equal(views[0].status, "ALL");
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
  assert.deepEqual(
    mod.buildSavedViewBody({
      name: "  My view  ",
      scope: "trash",
      type: "ALL",
      status: "ALL",
      search: "  invoice  ",
      sort: "priority",
    }),
    {
      name: "My view",
      scope: "deleted",
      sortKey: "priority",
      filters: {
        scope: "deleted",
        search: "invoice",
        type: "all",
        status: "all",
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
