/**
 * Search-inclusion + diagnostics-breakdown audit — locks the
 * audit-mandated semantics in code:
 *
 *   Inclusion (search-projection.ts):
 *     - deleted evidence:                NOT indexed
 *     - lifecycle DESTROYED:             NOT indexed
 *     - lifecycle PENDING_DESTRUCTION:   NOT indexed
 *     - active evidence:                 indexed
 *     - signed/REVIEW_READY evidence:    indexed (no exclusion)
 *     - archived evidence:               indexed, tagged "archived"
 *     - locked evidence:                 indexed, tagged "locked"
 *
 *   Diagnostics formula (search.routes.ts):
 *     - `evidenceIndexable` matches the projection's exclusion
 *       rules (deleted_at IS NULL AND lifecycle_state NOT IN
 *       ('DESTROYED','PENDING_DESTRUCTION')) — NOT raw
 *       evidence.count.
 *     - The response carries a per-state breakdown so an
 *       operator can see the delta between `evidenceIndexed`
 *       and `evidenceIndexable`.
 *
 *   Result-row badges (evidence-search.service.ts):
 *     - "archived" and "locked" badges are derived from the
 *       projection's tags and forwarded onto the response so the
 *       UI can mark the row.
 *     - Badge catalog includes "archived" and "locked".
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
// PROJECTION — inclusion semantics
// ============================================================================

describe("Search-inclusion audit — projection EXCLUDES non-indexable states", () => {
  // Search-inclusion-audit (trash decision): the historical
  // "deleted evidence is excluded" assertion FLIPPED. Soft-deleted
  // (deletedAt set, restorable) records are now INDEXED with an
  // "in_trash" tag. The dedicated trash-included test file
  // (`search-trash-included.test.ts`) holds the positive
  // assertion. Here we just keep the two TRUE exclusions:
  // DESTROYED and PENDING_DESTRUCTION.

  it("lifecycle DESTROYED — projection returns deleteFromIndex (NOT indexed)", () => {
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

  it("lifecycle PENDING_DESTRUCTION — projection returns deleteFromIndex (NOT indexed)", () => {
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
});

describe("Search-inclusion audit — projection INCLUDES indexable states", () => {
  it("active evidence — projection succeeds, no tags", () => {
    const r = buildEvidenceProjection({
      teamId: "team-1",
      evidenceId: "ev-1",
      evidence: baseEvidence(),
      workflowState: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tags = (r.projection.searchableTags ?? []) as string[];
    expect(tags).not.toContain("archived");
    expect(tags).not.toContain("locked");
  });

  it("signed evidence (reviewReadyAtUtc set) — INDEXED, marked review-ready", () => {
    const r = buildEvidenceProjection({
      teamId: "team-1",
      evidenceId: "ev-1",
      evidence: {
        ...baseEvidence(),
        reviewReadyAtUtc: new Date("2026-06-15T00:00:00Z"),
      },
      workflowState: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.reviewState).toBe("REVIEW_READY");
  });

  it("archived evidence — INDEXED with 'archived' tag", () => {
    const r = buildEvidenceProjection({
      teamId: "team-1",
      evidenceId: "ev-1",
      evidence: {
        ...baseEvidence(),
        archivedAt: new Date("2026-06-10T00:00:00Z"),
      },
      workflowState: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.searchableTags as string[]).toContain("archived");
  });

  it("locked evidence — INDEXED with 'locked' tag", () => {
    const r = buildEvidenceProjection({
      teamId: "team-1",
      evidenceId: "ev-1",
      evidence: {
        ...baseEvidence(),
        lockedAt: new Date("2026-06-10T00:00:00Z"),
      },
      workflowState: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.searchableTags as string[]).toContain("locked");
  });
});

// ============================================================================
// BADGE CATALOG — archived + locked are user-facing chips
// ============================================================================

describe("Badge catalog — search-inclusion-audit surfaces archived + locked", () => {
  it("'archived' is an allowed search-result badge", () => {
    expect(SEARCH_RESULT_ALLOWED_BADGES).toContain("archived");
    expect(isAllowedSearchBadge("archived")).toBe(true);
  });
  it("'locked' is an allowed search-result badge", () => {
    expect(SEARCH_RESULT_ALLOWED_BADGES).toContain("locked");
    expect(isAllowedSearchBadge("locked")).toBe(true);
  });
});

describe("toResultRow — promotes archived/locked tags from searchableTagsJson onto badges", () => {
  const src = read(SERVICE_PATH);
  it("reads searchableTagsJson and pushes 'archived' onto the badge array when present", () => {
    expect(src).toMatch(/doc\.searchableTagsJson/);
    expect(src).toMatch(/tagsRaw\.includes\("archived"\)/);
    expect(src).toMatch(/badges\.push\("archived"\)/);
  });
  it("reads searchableTagsJson and pushes 'locked' onto the badge array when present", () => {
    expect(src).toMatch(/tagsRaw\.includes\("locked"\)/);
    expect(src).toMatch(/badges\.push\("locked"\)/);
  });
});

describe("Projection emits 'locked' tag", () => {
  it("search-projection.ts tags array writes 'locked' when evidence.lockedAt is set", () => {
    const src = read(PROJECTION_PATH);
    expect(src).toMatch(/evidence\.lockedAt \? "locked" : null/);
  });
});

// ============================================================================
// DIAGNOSTICS — evidenceIndexable formula + per-state breakdown
// ============================================================================

describe("Diagnostics — evidenceIndexable matches the indexer's exclusions", () => {
  const src = read(ROUTE_PATH);

  it("denominator query produces the per-state breakdown buckets (active/archived/locked/trashed/destroyed/pendingDestr)", () => {
    // Search-inclusion-audit (trash decision) — the SQL now
    // produces six mutually-exclusive buckets and the handler
    // derives `evidenceIndexable` from the four included ones
    // (active + archived + locked + trashed). Pin every bucket
    // alias.
    expect(src).toMatch(/active_included/);
    expect(src).toMatch(/archived_included/);
    expect(src).toMatch(/locked_included/);
    expect(src).toMatch(/trashed_included/);
    expect(src).toMatch(/destroyed_excluded/);
    expect(src).toMatch(/pending_destruction_excluded/);
    // Lifecycle exclusion predicate appears once per bucket.
    expect(src).toMatch(
      /\$\{ELIGIBLE_SQL\}/,
    );
  });

  it("response carries per-state breakdown: activeIncluded, archived, locked, trashed, destroyed, pendingDestr.", () => {
    expect(src).toMatch(/breakdown:\s*\{/);
    expect(src).toMatch(/evidenceIndexable,/);
    expect(src).toMatch(/activeIncluded,/);
    expect(src).toMatch(/archivedIncluded,/);
    expect(src).toMatch(/lockedIncluded,/);
    // Search-inclusion-audit (trash decision) — replaced
    // `deletedExcluded` with `trashedIncluded` because soft-
    // deleted records are now INSIDE the indexable population.
    expect(src).toMatch(/trashedIncluded,/);
    expect(src).toMatch(/destroyedExcluded,/);
    expect(src).toMatch(/pendingDestructionExcluded,/);
    expect(src).toMatch(/hardDeletedAbsent: null/);
  });

  it("health classifier compares against evidenceIndexable, NOT raw evidence.count", () => {
    // The old code path used `evidenceTotal === 0` against a
    // raw evidence.count. The new code must compare against the
    // indexable population.
    expect(src).toMatch(/evidenceIndexable === 0\s*\n\s*\?\s*"empty_workspace"/);
    expect(src).toMatch(/indexedEvidence < evidenceIndexable/);
    // The raw `prisma.evidence.count({where: {teamId, deletedAt:
    // null}})` call must be gone — replaced by the breakdown
    // query.
    expect(src).not.toMatch(
      /prisma\.evidence\.count\(\{\s*where:\s*\{\s*teamId,\s*deletedAt:\s*null\s*\}\s*\}\),/,
    );
  });

  it("evidence.total field is computed from the breakdown (not a separate query)", () => {
    expect(src).toMatch(
      /evidenceTotal\s*=\s*evidenceIndexable\s*\+\s*destroyedExcluded\s*\+\s*pendingDestructionExcluded/,
    );
  });
});
