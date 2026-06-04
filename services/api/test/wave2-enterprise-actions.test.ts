/**
 * Wave 2 Phase 6 — Enterprise Actions regression tests (source-contract).
 *
 * Pins the wiring put in place by the Wave 2 Phase 6 implementation:
 *
 *   * POST /v1/graph/relationships/manual emits a bounded
 *     GRAPH_MANUAL_RELATIONSHIP_CREATED audit log on success.
 *   * DELETE /v1/graph/relationships/manual/:id emits a bounded
 *     GRAPH_MANUAL_RELATIONSHIP_RETRACTED audit log on success.
 *   * 4 new endpoints are registered in their canonical files:
 *       - POST /v1/graph/export (graph.routes.ts)
 *       - POST /v1/graph/timeline/export (graph.routes.ts)
 *       - POST /v1/graph/duplicates/export (graph.routes.ts)
 *       - POST /v1/investigation/media-intelligence/refresh
 *         (media-intelligence.routes.ts)
 *   * Each new endpoint:
 *       - Is gated by authorizeOrFail with antiEnumeration.
 *       - Emits a bounded appendPlatformAuditLog entry with an action
 *         from the closed Wave 2 set.
 *       - Uses appendPlatformAuditLog rather than writing
 *         AdminAuditLog directly (dedup register requirement).
 *   * 4 new metric counters are registered in the shared-runtime
 *     COUNTER_NAMES catalog so `bump()` calls typecheck.
 *   * UI surfaces:
 *       - investigation/page.tsx renders the data-action button hooks
 *         for run-media-intelligence-refresh / acknowledge-signal /
 *         dismiss-signal.
 *       - investigation/graph/page.tsx renders the data-action hooks
 *         for run-graph-refresh / export-graph.
 *       - investigation/timeline/page.tsx renders the data-action hook
 *         for export-timeline.
 *       - investigation/duplicates/page.tsx renders the data-action
 *         hook for export-duplicates.
 *   * The "DO NOT add a parallel namespace" rule from the brief is
 *     respected — none of the forbidden namespaces appear under
 *     services/api/src/routes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

function readSharedRuntime(rel: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../../packages/shared-runtime/${rel}`, import.meta.url),
    ),
    "utf8",
  );
}

const GRAPH_ROUTES = readApi("src/routes/graph.routes.ts");
const MI_ROUTES = readApi("src/routes/media-intelligence.routes.ts");
const METRICS = readSharedRuntime("src/ops/metrics.service.ts");

const OVERVIEW_PAGE = readWeb("app/(app)/investigation/page.tsx");
const GRAPH_PAGE = readWeb("app/(app)/investigation/graph/page.tsx");
const TIMELINE_PAGE = readWeb("app/(app)/investigation/timeline/page.tsx");
const DUPLICATES_PAGE = readWeb(
  "app/(app)/investigation/duplicates/page.tsx",
);

describe("Wave 2 Phase 6 — manual relationship audit hooks", () => {
  it("createManualRelationship route emits GRAPH_MANUAL_RELATIONSHIP_CREATED via appendPlatformAuditLog", () => {
    expect(GRAPH_ROUTES).toMatch(
      /"GRAPH_MANUAL_RELATIONSHIP_CREATED"/,
    );
    // The emit must live inside an awaited appendPlatformAuditLog call.
    expect(GRAPH_ROUTES).toMatch(
      /appendPlatformAuditLog\([\s\S]*?GRAPH_MANUAL_RELATIONSHIP_CREATED[\s\S]*?\}\)/,
    );
  });

  it("retractManualRelationship route emits GRAPH_MANUAL_RELATIONSHIP_RETRACTED via appendPlatformAuditLog", () => {
    expect(GRAPH_ROUTES).toMatch(
      /"GRAPH_MANUAL_RELATIONSHIP_RETRACTED"/,
    );
    expect(GRAPH_ROUTES).toMatch(
      /appendPlatformAuditLog\([\s\S]*?GRAPH_MANUAL_RELATIONSHIP_RETRACTED[\s\S]*?\}\)/,
    );
  });
});

describe("Wave 2 Phase 6 — new endpoints registered", () => {
  it("POST /v1/graph/export is registered with evidence.read + audit emit", () => {
    expect(GRAPH_ROUTES).toMatch(/"\/v1\/graph\/export"/);
    // Slice the route block to assert the gate + audit emit live inside it.
    const idx = GRAPH_ROUTES.indexOf('"/v1/graph/export"');
    expect(idx).toBeGreaterThan(-1);
    const block = GRAPH_ROUTES.slice(idx, idx + 4000);
    expect(block).toMatch(/permission:\s*"evidence\.read"/);
    expect(block).toMatch(/antiEnumeration:\s*true/);
    expect(block).toMatch(/INVESTIGATION_EXPORT_GENERATED/);
  });

  it("POST /v1/graph/timeline/export is registered with evidence.read + audit emit", () => {
    expect(GRAPH_ROUTES).toMatch(/"\/v1\/graph\/timeline\/export"/);
    const idx = GRAPH_ROUTES.indexOf('"/v1/graph/timeline/export"');
    expect(idx).toBeGreaterThan(-1);
    const block = GRAPH_ROUTES.slice(idx, idx + 3000);
    expect(block).toMatch(/permission:\s*"evidence\.read"/);
    expect(block).toMatch(/antiEnumeration:\s*true/);
    expect(block).toMatch(/INVESTIGATION_EXPORT_GENERATED/);
  });

  it("POST /v1/graph/duplicates/export is registered with evidence.read + audit emit", () => {
    expect(GRAPH_ROUTES).toMatch(/"\/v1\/graph\/duplicates\/export"/);
    const idx = GRAPH_ROUTES.indexOf('"/v1/graph/duplicates/export"');
    expect(idx).toBeGreaterThan(-1);
    const block = GRAPH_ROUTES.slice(idx, idx + 3000);
    expect(block).toMatch(/permission:\s*"evidence\.read"/);
    expect(block).toMatch(/antiEnumeration:\s*true/);
    expect(block).toMatch(/INVESTIGATION_EXPORT_GENERATED/);
  });

  it("POST /v1/investigation/media-intelligence/refresh is registered with evidence.update_metadata + bounded cap + audit emit", () => {
    expect(MI_ROUTES).toMatch(
      /"\/v1\/investigation\/media-intelligence\/refresh"/,
    );
    const idx = MI_ROUTES.indexOf(
      '"/v1/investigation/media-intelligence/refresh"',
    );
    expect(idx).toBeGreaterThan(-1);
    const block = MI_ROUTES.slice(idx, idx + 6000);
    expect(block).toMatch(/permission:\s*"evidence\.update_metadata"/);
    expect(block).toMatch(/antiEnumeration:\s*true/);
    expect(block).toMatch(/REFRESH_CAP\s*=\s*50/);
    expect(block).toMatch(/MEDIA_INTELLIGENCE_REFRESH_REQUESTED/);
  });
});

describe("Wave 2 Phase 6 — counters registered", () => {
  it("4 new Wave 2 Phase 6 counters appear in COUNTER_NAMES", () => {
    expect(METRICS).toMatch(/"graph_export_generated_total"/);
    expect(METRICS).toMatch(/"graph_timeline_export_generated_total"/);
    expect(METRICS).toMatch(/"graph_duplicates_export_generated_total"/);
    expect(METRICS).toMatch(/"media_intelligence_refresh_requested_total"/);
  });
});

describe("Wave 2 Phase 6 — UI action surfaces", () => {
  it("overview page renders data-action hooks for refresh + ack + dismiss", () => {
    expect(OVERVIEW_PAGE).toMatch(
      /data-action="run-media-intelligence-refresh"/,
    );
    expect(OVERVIEW_PAGE).toMatch(/data-action="acknowledge-signal"/);
    expect(OVERVIEW_PAGE).toMatch(/data-action="dismiss-signal"/);
    expect(OVERVIEW_PAGE).toMatch(
      /\/v1\/investigation\/media-intelligence\/refresh/,
    );
    expect(OVERVIEW_PAGE).toMatch(
      /\/v1\/media-intelligence\/signals\/.*\/action/,
    );
  });

  it("graph page renders data-action hooks for refresh + export", () => {
    expect(GRAPH_PAGE).toMatch(/data-action="run-graph-refresh"/);
    expect(GRAPH_PAGE).toMatch(/data-action="export-graph"/);
    expect(GRAPH_PAGE).toMatch(/\/v1\/graph\/reconcile/);
    expect(GRAPH_PAGE).toMatch(/\/v1\/graph\/export/);
  });

  it("timeline page renders data-action hook for export-timeline", () => {
    expect(TIMELINE_PAGE).toMatch(/data-action="export-timeline"/);
    expect(TIMELINE_PAGE).toMatch(/\/v1\/graph\/timeline\/export/);
  });

  it("duplicates page renders data-action hook for export-duplicates", () => {
    expect(DUPLICATES_PAGE).toMatch(/data-action="export-duplicates"/);
    expect(DUPLICATES_PAGE).toMatch(/\/v1\/graph\/duplicates\/export/);
  });
});

describe("Wave 2 Phase 6 — parallel namespace forbidden", () => {
  it("no /v1/investigation/escalations/* path appears in route files", () => {
    expect(GRAPH_ROUTES).not.toMatch(/\/v1\/investigation\/escalations\//);
    expect(MI_ROUTES).not.toMatch(/\/v1\/investigation\/escalations\//);
  });
  it("no /v1/investigation/signals/* (other than the existing media-intelligence path) parallel namespace appears", () => {
    expect(GRAPH_ROUTES).not.toMatch(/\/v1\/investigation\/signals\//);
    // The MI routes file may surface /v1/investigation/overview etc. but
    // never the disallowed signals namespace.
    expect(MI_ROUTES).not.toMatch(/\/v1\/investigation\/signals\//);
  });
  it("no /v1/investigation/indexing/* parallel namespace appears", () => {
    expect(GRAPH_ROUTES).not.toMatch(/\/v1\/investigation\/indexing\//);
    expect(MI_ROUTES).not.toMatch(/\/v1\/investigation\/indexing\//);
  });
  it("no /v1/investigation/external-reviewers/* parallel namespace appears", () => {
    expect(GRAPH_ROUTES).not.toMatch(
      /\/v1\/investigation\/external-reviewers\//,
    );
    expect(MI_ROUTES).not.toMatch(
      /\/v1\/investigation\/external-reviewers\//,
    );
  });
});

describe("Wave 2 Phase 6 — audit emit dedup register compliance", () => {
  it("graph.routes.ts never writes to AdminAuditLog directly — only via appendPlatformAuditLog", () => {
    // The route file is allowed to import appendPlatformAuditLog and
    // call it; it must NEVER call prisma.adminAuditLog.* directly.
    expect(GRAPH_ROUTES).not.toMatch(/prisma\.adminAuditLog\./);
    expect(GRAPH_ROUTES).toMatch(/appendPlatformAuditLog/);
  });
  it("media-intelligence.routes.ts never writes to AdminAuditLog directly — only via appendPlatformAuditLog", () => {
    expect(MI_ROUTES).not.toMatch(/prisma\.adminAuditLog\./);
    expect(MI_ROUTES).toMatch(/appendPlatformAuditLog/);
  });
});
