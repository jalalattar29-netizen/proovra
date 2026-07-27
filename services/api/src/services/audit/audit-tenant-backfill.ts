/**
 * PHASE 11 §1 — HISTORICAL TENANT-SCOPE BACKFILL READINESS (dry-run planner).
 *
 * V3 rows bind organizationId/workspaceId INTO the tamper-evident hash. Historical
 * V1/V2 rows predate that binding and may carry NULL tenant columns. This planner
 * decides — WITHOUT MUTATING ANYTHING and WITHOUT GUESSING — whether each legacy
 * row's authoritative Workspace can be PROVEN from a HASH-PROTECTED, immutable
 * binding on that same row:
 *
 *   - V3 rows already carry hash-bound scope           → ALREADY_BOUND (nothing to do)
 *   - a row whose hash does NOT verify                 → LEGACY_SCOPE_UNRESOLVED
 *     (its bindings are not trustworthy; never derive scope from a tampered row)
 *   - a hash-VALID row with a hash-PROTECTED resource
 *     binding that still resolves to a persisted teamId → RESOLVABLE (derived scope)
 *   - anything else (no hash-protected binding, or the
 *     resource no longer resolves)                      → LEGACY_SCOPE_UNRESOLVED
 *
 * A binding is "hash-protected" ONLY when it is part of THAT row's version hash
 * input: V2/V3 bind resourceType+resourceId; V1 binds only metadata (so a V1
 * resource id is usable solely when it lives inside the hash-protected metadata).
 * The tenant columns themselves are NEVER a source of truth for legacy rows —
 * V1/V2 did not hash them, so they are exactly what this process would set.
 *
 * The planner is PURE and NON-DESTRUCTIVE: it returns a plan, never writes. The
 * historical rows and their hashes are immutable — a real backfill (out of scope
 * here) would only fill NULL tenant COLUMNS for RESOLVABLE rows and would NEVER
 * rewrite a historical hash or delete a historical row.
 */

export type BackfillAuditRow = {
  id: string;
  chainVersion: number | null;
  /** Whether this row's chain hash verified against its stored value. */
  hashVerified: boolean;
  /** Authoritative tenant columns as they stand today (may be NULL for legacy). */
  organizationId: string | null;
  workspaceId: string | null;
  /** Hash-protected on V2/V3 (part of the hash input); ignored for V1. */
  resourceType: string | null;
  resourceId: string | null;
  /** Hash-protected on ALL versions (metadata is inside every version hash). */
  metadata: unknown;
};

export type BackfillPlanEntry =
  | { id: string; status: "ALREADY_BOUND" }
  | { id: string; status: "RESOLVABLE"; source: "resource_binding"; derivedWorkspaceId: string }
  | { id: string; status: "LEGACY_SCOPE_UNRESOLVED"; reason: BackfillUnresolvedReason };

export type BackfillUnresolvedReason =
  | "hash_unverified"
  | "no_hash_protected_binding"
  | "resource_not_resolvable";

export type BackfillPlanSummary = {
  total: number;
  alreadyBound: number;
  resolvable: number;
  unresolved: number;
  /** Zero-fabrication guarantee surfaced as a metric. */
  guessedScope: 0;
  entries: BackfillPlanEntry[];
};

/**
 * The ONLY binding a legacy row may be trusted on: one that lives inside that
 * row's version-specific hash input. Returns null when no such binding exists.
 */
export function hashProtectedResourceBinding(
  row: BackfillAuditRow,
): { resourceType: string; resourceId: string } | null {
  const version = row.chainVersion ?? 1;

  // V2/V3 fold resourceType + resourceId into the hash → trustworthy.
  if (version >= 2 && row.resourceType && row.resourceId) {
    return { resourceType: row.resourceType, resourceId: row.resourceId };
  }

  // V1 hashes only (userId, action, metadata, createdAt, prev). A resource id is
  // usable solely when it is inside the hash-protected metadata, never from the
  // un-hashed resource_* columns.
  if (version === 1 && row.metadata && typeof row.metadata === "object") {
    const m = row.metadata as Record<string, unknown>;
    if (typeof m.resourceType === "string" && typeof m.resourceId === "string") {
      return { resourceType: m.resourceType, resourceId: m.resourceId };
    }
  }

  return null;
}

/**
 * Dry-run: classify each row. `resolveResourceTeamId` is the persistence lookup
 * (the SAME authority the deep-link resolver uses); it returns the resource's
 * authoritative teamId or null when the resource no longer exists / is unbound.
 * This function performs NO writes.
 */
export async function planAuditTenantScopeBackfill(
  rows: BackfillAuditRow[],
  resolveResourceTeamId: (resourceType: string, resourceId: string) => Promise<string | null>,
): Promise<BackfillPlanSummary> {
  const entries: BackfillPlanEntry[] = [];

  for (const row of rows) {
    // Already hash-bound (V3, or any row that already carries a workspace column
    // that WAS hashed) — nothing to backfill.
    if ((row.chainVersion ?? 1) >= 3 || row.workspaceId !== null) {
      entries.push({ id: row.id, status: "ALREADY_BOUND" });
      continue;
    }

    // Never derive scope from a row whose hash does not verify — its bindings are
    // untrustworthy. Fail closed, do not guess.
    if (!row.hashVerified) {
      entries.push({ id: row.id, status: "LEGACY_SCOPE_UNRESOLVED", reason: "hash_unverified" });
      continue;
    }

    const binding = hashProtectedResourceBinding(row);
    if (!binding) {
      entries.push({ id: row.id, status: "LEGACY_SCOPE_UNRESOLVED", reason: "no_hash_protected_binding" });
      continue;
    }

    const teamId = await resolveResourceTeamId(binding.resourceType, binding.resourceId);
    if (!teamId) {
      entries.push({ id: row.id, status: "LEGACY_SCOPE_UNRESOLVED", reason: "resource_not_resolvable" });
      continue;
    }

    // PROVEN from a hash-protected, immutable binding — the only derivation allowed.
    entries.push({ id: row.id, status: "RESOLVABLE", source: "resource_binding", derivedWorkspaceId: teamId });
  }

  return {
    total: entries.length,
    alreadyBound: entries.filter((e) => e.status === "ALREADY_BOUND").length,
    resolvable: entries.filter((e) => e.status === "RESOLVABLE").length,
    unresolved: entries.filter((e) => e.status === "LEGACY_SCOPE_UNRESOLVED").length,
    guessedScope: 0,
    entries,
  };
}
