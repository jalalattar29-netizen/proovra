/**
 * Search-inclusion-audit (trash decision) — soft-deleted evidence
 * is searchable.
 *
 * Pins the audit-mandated semantics:
 *
 *   Indexed:
 *     - active evidence
 *     - archived evidence (tagged "archived")
 *     - locked evidence (tagged "locked")
 *     - SOFT-DELETED evidence (tagged "in_trash") — NEW
 *     - signed evidence (reviewReadyAtUtc set)
 *
 *   NOT indexed (deleteFromIndex:true):
 *     - lifecycle DESTROYED
 *     - lifecycle PENDING_DESTRUCTION
 *     - (hard-deleted rows are physically absent — not testable
 *       from this layer; the indexer's findFirst returns null
 *       and the caller treats that as evidence_not_found)
 *
 *   Diagnostics breakdown:
 *     evidenceIndexable = active + archived + locked + trashed
 *     destroyedExcluded + pendingDestructionExcluded are the
 *     only excluded buckets; hardDeletedAbsent is reported as
 *     null because it's structurally unknowable.
 *
 *   Reconcile / backfill:
 *     The orphan query now uses the lifecycle filter, NOT
 *     `deleted_at IS NULL`, so existing trash records flow into
 *     `evidence_search_documents` on the next backfill.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildEvidenceProjection,
  SEARCH_RESULT_ALLOWED_BADGES,
  isAllowedSearchBadge,
} from "@proovra/shared";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const ROUTE_PATH = resolve(API_ROOT, "src/routes/search.routes.ts");
// The breakdown QUERY moved to the extracted search-health authority, so the
// operations probe and the diagnostics endpoint measure one workspace's index
// the same way. The predicate it pins is unchanged.
const HEALTH_PATH = resolve(
  API_ROOT,
  "src/services/search/search-health.service.ts",
);
const REINDEX_PATH = resolve(
  API_ROOT,
  "src/services/search/reindex.service.ts",
);
const SERVICE_PATH = resolve(
  API_ROOT,
  "src/services/search/evidence-search.service.ts",
);
const PROJECTION_PATH = resolve(
  REPO_ROOT,
  "packages/shared/src/search-projection.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

function baseEvidence() {
  return {
    id: "ev-1",
    teamId: "team-1",
    title: "hero-bg.webp.png",
    displayFileName: "hero-bg.webp.png",
    originalFileName: "hero-bg.webp.png",
    type: "DOCUMENT" as const,
    mimeType: "image/png",
    captureMethod: "UPLOAD",
    caseId: null,
    deletedAt: null as Date | null,
    lifecycleState: "ACTIVE" as string | null,
    archivedAt: null as Date | null,
    lockedAt: null as Date | null,
    publicVerifyState: null as string | null,
    storageObjectLockLegalHoldStatus: null as string | null,
    retentionPolicySource: null as string | null,
    retentionUntilUtc: null as Date | null,
    reviewReadyAtUtc: null as Date | null,
    updatedAt: new Date("2026-06-16T00:00:00Z"),
  };
}

// ============================================================================
// PROJECTION — trash now INCLUDED
// ============================================================================

describe("Search-inclusion (trash decision) — projection INCLUDES soft-deleted with in_trash tag", () => {
  it("soft-deleted evidence — projection succeeds and emits 'in_trash' tag", () => {
    const r = buildEvidenceProjection({
      teamId: "team-1",
      evidenceId: "ev-1",
      evidence: { ...baseEvidence(), deletedAt: new Date() },
      workflowState: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tags = (r.projection.searchableTags ?? []) as string[];
    expect(tags).toContain("in_trash");
  });

  it("active evidence — projection succeeds and emits NO 'in_trash' tag", () => {
    const r = buildEvidenceProjection({
      teamId: "team-1",
      evidenceId: "ev-1",
      evidence: baseEvidence(),
      workflowState: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tags = (r.projection.searchableTags ?? []) as string[];
    expect(tags).not.toContain("in_trash");
  });

  it("lifecycle DESTROYED — projection still EXCLUDES (deleteFromIndex:true)", () => {
    const r = buildEvidenceProjection({
      teamId: "team-1",
      evidenceId: "ev-1",
      evidence: { ...baseEvidence(), lifecycleState: "DESTROYED" },
      workflowState: null,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.reason).toBe("lifecycle_destroyed");
    expect(r.ok ? null : r.deleteFromIndex).toBe(true);
  });

  it("lifecycle PENDING_DESTRUCTION — projection still EXCLUDES", () => {
    const r = buildEvidenceProjection({
      teamId: "team-1",
      evidenceId: "ev-1",
      evidence: {
        ...baseEvidence(),
        lifecycleState: "PENDING_DESTRUCTION",
      },
      workflowState: null,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.reason).toBe("lifecycle_pending_destruction");
    expect(r.ok ? null : r.deleteFromIndex).toBe(true);
  });

  it("DESTROYED wins over deletedAt — terminal lifecycle takes priority", () => {
    // Defence-in-depth: a row that's both soft-deleted AND
    // lifecycle DESTROYED must STILL exit via the destroyed
    // branch (not surface in search as "in trash").
    const r = buildEvidenceProjection({
      teamId: "team-1",
      evidenceId: "ev-1",
      evidence: {
        ...baseEvidence(),
        deletedAt: new Date(),
        lifecycleState: "DESTROYED",
      },
      workflowState: null,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.reason).toBe("lifecycle_destroyed");
  });
});

describe("Source files — trash decision propagation", () => {
  it("search-projection emits 'in_trash' when deletedAt is set", () => {
    const src = read(PROJECTION_PATH);
    expect(src).toMatch(/evidence\.deletedAt \? "in_trash" : null/);
  });

  it("'in_trash' is in the allowed-badge catalog so toResultRow can forward it", () => {
    expect(SEARCH_RESULT_ALLOWED_BADGES).toContain("in_trash");
    expect(isAllowedSearchBadge("in_trash")).toBe(true);
  });

  it("toResultRow forwards 'in_trash' from searchableTagsJson onto the badge array", () => {
    const src = read(SERVICE_PATH);
    expect(src).toMatch(/tagsRaw\.includes\("in_trash"\)/);
    expect(src).toMatch(/badges\.push\("in_trash"\)/);
  });
});

// ============================================================================
// RECONCILE / BACKFILL — orphan query now matches the projection
// ============================================================================

describe("Reconcile / backfill — orphan query includes trash", () => {
  it("reindex.service evidence orphan query uses lifecycle filter, NOT 'deleted_at IS NULL'", () => {
    const src = read(REINDEX_PATH);
    // The new predicate keys on lifecycle state (the only true
    // exclusion). The legacy `WHERE e.deleted_at IS NULL` would
    // skip trash records on the next backfill — pin its
    // absence.
    expect(src).toMatch(
      /searchIndexableLifecycleSql\("e\.lifecycle_state"\)/,
    );
    // The evidence orphan block must not still gate on
    // deleted_at IS NULL. Grab a 40-line slice around the
    // evidence orphan query to be specific.
    const evIdx = src.indexOf("Search-inclusion-audit (trash decision)");
    const slice = src.slice(evIdx, evIdx + 1500);
    expect(slice).not.toMatch(/WHERE e\.deleted_at IS NULL/);
  });

  it("/v1/search/reconcile evidence orphan query uses lifecycle filter (NOT deleted_at)", () => {
    const src = read(ROUTE_PATH);
    // The route's reconcile handler has its own copy of the
    // evidence orphan query (legacy — pre-extraction). It must
    // also be updated.
    const idx = src.indexOf("Find orphaned evidence");
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 1500);
    expect(slice).toMatch(
      /searchIndexableLifecycleSql\("e\.lifecycle_state"\)/,
    );
    expect(slice).not.toMatch(/WHERE e\.deleted_at IS NULL/);
  });
});

// ============================================================================
// DIAGNOSTICS — new breakdown shape
// ============================================================================

describe("Diagnostics breakdown — activeIncluded / archivedIncluded / lockedIncluded / trashedIncluded", () => {
  const src = read(ROUTE_PATH);

  it("response carries the new field names (active/archived/locked/trashed/destroyed/pendingDestr)", () => {
    expect(src).toMatch(/activeIncluded,/);
    expect(src).toMatch(/archivedIncluded,/);
    expect(src).toMatch(/lockedIncluded,/);
    expect(src).toMatch(/trashedIncluded,/);
    expect(src).toMatch(/destroyedExcluded,/);
    expect(src).toMatch(/pendingDestructionExcluded,/);
  });

  it("hardDeletedAbsent is reported as null (count structurally unknowable)", () => {
    expect(src).toMatch(/hardDeletedAbsent: null/);
  });

  it("evidenceIndexable = active + archived + locked + trashed (matches projection)", () => {
    // The four INCLUDED buckets, summed in the module that counts them.
    expect(read(HEALTH_PATH)).toMatch(
      /eligibleCount\s*=\s*\n?\s*breakdown\.activeIncluded \+\s*\n?\s*breakdown\.archivedIncluded \+\s*\n?\s*breakdown\.lockedIncluded \+\s*\n?\s*breakdown\.trashedIncluded/,
    );
    // …and the route still reports it under the name the response uses.
    expect(src).toMatch(/evidenceIndexable = healthFacts\.eligibleCount/);
  });

  it("breakdown SQL keys trash on `deleted_at IS NOT NULL`, not lifecycle", () => {
    // The trashed bucket is the soft-deleted population — pin
    // the predicate so a future refactor can't accidentally
    // re-route it.
    const facts = read(HEALTH_PATH);
    expect(facts).toMatch(/trashed_included/);
    expect(facts).toMatch(
      /\$\{ELIGIBLE_SQL\}\s*\n?\s*AND deleted_at IS NOT NULL/,
    );
  });

  it("the old `deletedExcluded` field name is GONE from the response", () => {
    // Defence-in-depth — the rename was deliberate; a future
    // refactor that re-introduces "deletedExcluded" under the
    // new semantics would silently break clients.
    expect(src).not.toMatch(/deletedExcluded,/);
  });
});
