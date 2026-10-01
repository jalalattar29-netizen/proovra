/**
 * UC-DER-013 / UC-DER-010 — may a DERIVED producer still write for this record,
 * and which records belong to the workspace a derived row is keyed by?
 *
 * ONE answer for every derived producer (the Phase-31 derived-asset processor,
 * the UC-4 screen-intelligence orchestrator, the stranded-run reconciler), so a
 * trashed / destruction-bound / destroyed record never gains new derived bytes
 * or text after it left service — the reconciler's derived-asset scan already
 * applied this rule, the producers and the stranded-run scan did not.
 *
 * Only a SEALED record (SIGNED / REPORTED) is a source: a derivative of bytes
 * that were never sealed (a capture still UPLOADING, a refused seal, a
 * FAILED_HASH_MISMATCH record) is bound to nothing the record certifies.
 *
 * A legal HOLD does not stop production: a hold preserves, it does not forbid
 * deriving review material. It only forbids removing anything (every producer
 * keeps superseded objects, see derived-assets.service.ts).
 */

import type { PrismaClient } from "@prisma/client";

import { getRegisteredPrisma } from "../prisma-registry.js";

/** Evidence statuses whose bytes are sealed and may be derived from. */
export const DERIVED_PRODUCTION_SEALED_STATUSES = ["SIGNED", "REPORTED"] as const;

/** Lifecycle states in which no derived artifact may be produced or re-produced. */
export const DERIVED_PRODUCTION_INELIGIBLE_LIFECYCLE_STATES = [
  "TRASHED",
  "PENDING_DESTRUCTION",
  "DESTROYED",
] as const;

export type DerivedProductionEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "evidence_not_found"
        | "evidence_not_sealed"
        | "evidence_trashed"
        | "evidence_pending_destruction"
        | "evidence_destroyed";
    };

/**
 * Re-read the record's lifecycle NOW. Producers call this at the start of a run
 * AND immediately before each persist, so a record trashed or destroyed while
 * the run was in flight stops receiving writes at the next step.
 */
export async function evaluateDerivedProductionEligibility(
  evidenceId: string,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<DerivedProductionEligibility> {
  const rows = (await client.$queryRawUnsafe(
    `SELECT "deleted_at", "status"::text AS "status", COALESCE("lifecycle_state"::text, 'ACTIVE') AS "lifecycle_state"
       FROM "evidence" WHERE "id" = $1::uuid LIMIT 1`,
    evidenceId,
  )) as Array<{ deleted_at: Date | null; status: string; lifecycle_state: string }>;
  const row = rows[0];
  if (!row) return { eligible: false, reason: "evidence_not_found" };
  if ((DERIVED_PRODUCTION_INELIGIBLE_LIFECYCLE_STATES as readonly string[]).includes(row.lifecycle_state)) {
    return {
      eligible: false,
      reason:
        row.lifecycle_state === "DESTROYED"
          ? "evidence_destroyed"
          : row.lifecycle_state === "PENDING_DESTRUCTION"
            ? "evidence_pending_destruction"
            : "evidence_trashed",
    };
  }
  if (row.deleted_at) return { eligible: false, reason: "evidence_trashed" };
  if (!(DERIVED_PRODUCTION_SEALED_STATUSES as readonly string[]).includes(row.status)) {
    return { eligible: false, reason: "evidence_not_sealed" };
  }
  return { eligible: true };
}

/**
 * SQL predicate: evidence alias `e` belongs to the workspace bound as `$param`
 * — its own team, or, for a Personal record stored with team_id NULL, its
 * owner's personal workspace (the same rule as `resolveEvidenceWorkspaceId`).
 * Derived rows and runs are keyed by that workspace, so the producers read
 * sources through the same scope the API authorised.
 */
export function evidenceInWorkspaceSql(alias: string, param: string): string {
  return `(${alias}."team_id" = ${param}::uuid OR (
      ${alias}."team_id" IS NULL AND ${alias}."owner_user_id" = (
        SELECT t."owner_user_id"::text FROM "teams" t
         WHERE t."id" = ${param}::uuid AND t."is_personal" = true
      )
    ))`;
}
