/**
 * PHASE 11 §1 — EXECUTABLE, READ-ONLY historical tenant-scope backfill readiness.
 *
 * A unit-tested pure planner is NOT deployment readiness. This is the runnable
 * command that a operator executes against the real audit table to decide
 * whether a backfill is safe — it READS ONLY, WRITES NOTHING, and NEVER guesses:
 *
 *   1. verify each historical row's ORIGINAL chain hash first;
 *   2. for hash-valid rows, derive tenant scope ONLY from a hash-PROTECTED,
 *      immutable resource binding (the same rule as the planner);
 *   3. classify every row as PROVEN / ALREADY_BOUND / LEGACY_SCOPE_UNRESOLVED /
 *      CONFLICT / HASH_INVALID;
 *   4. exit NON-ZERO when any row is HASH_INVALID or CONFLICT (a chain-integrity
 *      or attribution-consistency failure must halt the operator, not proceed);
 *   5. report the unresolved count explicitly so deployment policy can gate on it;
 *   6. emit NO secrets or sensitive metadata — only ids, statuses, and counts.
 *
 * This module DECIDES readiness. It deliberately contains no write path, so it
 * cannot apply anything even if invoked with elevated credentials.
 */

import { hashProtectedResourceBinding, type BackfillAuditRow } from "../services/audit/audit-tenant-backfill.js";

export type ReadinessStatus =
  | "PROVEN" // derivable from a hash-protected binding; column currently empty
  | "ALREADY_BOUND" // V3 / already carries a consistent workspace column
  | "LEGACY_SCOPE_UNRESOLVED" // hash-valid but no provable binding
  | "CONFLICT" // derived scope disagrees with an existing column value
  | "HASH_INVALID"; // row hash did not verify — bindings are untrustworthy

export type ReadinessRowResult = {
  id: string;
  status: ReadinessStatus;
  /** Present only for PROVEN — the workspace a backfill WOULD set (never applied here). */
  derivedWorkspaceId?: string;
};

export type ReadinessReport = {
  total: number;
  proven: number;
  alreadyBound: number;
  unresolved: number;
  conflict: number;
  hashInvalid: number;
  /** Invariant surfaced as a metric: this process fabricates nothing. */
  guessedScope: 0;
  /** Non-zero when any HASH_INVALID or CONFLICT row exists (halt the operator). */
  exitCode: 0 | 1;
  results: ReadinessRowResult[];
};

/**
 * Pure readiness assessment. `resolveResourceTeamId` is the persistence lookup
 * (the SAME authority the deep-link resolver uses) — it returns the resource's
 * authoritative teamId or null. No writes occur.
 */
export async function assessAuditTenantScopeReadiness(
  rows: BackfillAuditRow[],
  resolveResourceTeamId: (resourceType: string, resourceId: string) => Promise<string | null>,
): Promise<ReadinessReport> {
  const results: ReadinessRowResult[] = [];

  for (const row of rows) {
    // (1) integrity FIRST — a row whose hash does not verify is never a scope source.
    if (!row.hashVerified) {
      results.push({ id: row.id, status: "HASH_INVALID" });
      continue;
    }

    // Derive the provable workspace (if any) from a hash-protected binding.
    const binding = hashProtectedResourceBinding(row);
    const derived = binding
      ? await resolveResourceTeamId(binding.resourceType, binding.resourceId)
      : null;

    // (3) An existing tenant column must AGREE with the derived truth; a
    // disagreement is a CONFLICT that must halt, never be silently overwritten.
    if (row.workspaceId !== null) {
      if (derived !== null && derived !== row.workspaceId) {
        results.push({ id: row.id, status: "CONFLICT" });
      } else {
        results.push({ id: row.id, status: "ALREADY_BOUND" });
      }
      continue;
    }

    // Column empty: PROVEN if derivable, otherwise unresolved — never guessed.
    if (derived !== null) {
      results.push({ id: row.id, status: "PROVEN", derivedWorkspaceId: derived });
    } else {
      results.push({ id: row.id, status: "LEGACY_SCOPE_UNRESOLVED" });
    }
  }

  const count = (s: ReadinessStatus) => results.filter((r) => r.status === s).length;
  const hashInvalid = count("HASH_INVALID");
  const conflict = count("CONFLICT");

  return {
    total: results.length,
    proven: count("PROVEN"),
    alreadyBound: count("ALREADY_BOUND"),
    unresolved: count("LEGACY_SCOPE_UNRESOLVED"),
    conflict,
    hashInvalid,
    guessedScope: 0,
    // (4) integrity/consistency failures force a non-zero exit.
    exitCode: hashInvalid > 0 || conflict > 0 ? 1 : 0,
    results,
  };
}

/**
 * Human-readable, SECRET-FREE summary line set. Only ids, statuses and counts —
 * never metadata, never resource content.
 */
export function formatReadinessReport(report: ReadinessReport): string[] {
  return [
    "AUDIT TENANT-SCOPE BACKFILL READINESS (read-only, no writes)",
    `  total=${report.total}`,
    `  ALREADY_BOUND=${report.alreadyBound}`,
    `  PROVEN=${report.proven}`,
    `  LEGACY_SCOPE_UNRESOLVED=${report.unresolved}`,
    `  CONFLICT=${report.conflict}`,
    `  HASH_INVALID=${report.hashInvalid}`,
    `  guessedScope=${report.guessedScope}`,
    `  exitCode=${report.exitCode}`,
  ];
}
