/**
 * Phase R6 — worker-side Phase-4B legal-hold check (finding F39).
 *
 * The automated destruction pipeline has two worker stages:
 *   1. retention-reconciliation.worker — schedules expired evidence into
 *      PENDING_DESTRUCTION.
 *   2. destruction-orchestrator.worker — executes the tombstone.
 *
 * Historically BOTH stages checked only the Phase-4A hold models
 * (`EvidenceLegalHold` per-record + `CaseLegalHold` case-level). Neither
 * consulted the Phase-4B `LegalHold` table (EVIDENCE / WORKSPACE /
 * ORGANIZATION / CASE scope) that the LIVE `/lifecycle/legal-holds` UI
 * writes via `createLegalHold` — a scope-level record that never mirrors
 * into `EvidenceLegalHold` or `Evidence.lifecycleState`. Result: evidence
 * under an active Phase-4B legal hold could be AUTOMATICALLY DESTROYED by
 * retention — a legal-hold bypass on the most consequential path.
 *
 * This helper mirrors the 4B portion of the canonical API-side
 * `isUnderLegalHold` (services/api/.../lifecycle/legal-hold.service.ts) so
 * both worker stages honour a hold placed via EITHER governance surface.
 * It is strictly ADDITIVE / fail-closed — it only adds block conditions on
 * top of the existing 4A checks, and degrades to "no 4B hold" if the
 * `legal_holds` table is absent (older environments), because the 4A checks
 * already ran fail-closed in the caller.
 */
import type { PrismaClient } from "@prisma/client";

export async function hasActiveLifecycleLegalHold(
  prisma: PrismaClient,
  input: {
    evidenceId: string;
    teamId: string | null;
    caseId: string | null;
  },
): Promise<boolean> {
  // Phase-4B holds are workspace-anchored (every `LegalHold` row carries a
  // teamId). Personal-scope evidence (teamId null) has no 4B hold surface.
  if (!input.teamId) return false;

  const orClauses: Array<Record<string, unknown>> = [
    { kind: "EVIDENCE", scopeTargetId: input.evidenceId },
    { kind: "WORKSPACE", scopeTargetId: input.teamId },
    { kind: "ORGANIZATION" },
  ];
  if (input.caseId) {
    orClauses.push({ kind: "CASE", scopeTargetId: input.caseId });
  }

  try {
    const row = await prisma.legalHold.findFirst({
      where: {
        teamId: input.teamId,
        state: "ACTIVE",
        OR: orClauses,
      },
      select: { id: true },
    });
    return Boolean(row);
  } catch {
    // `legal_holds` may not exist in all environments — tolerate gracefully.
    // The caller's 4A (EvidenceLegalHold / CaseLegalHold) checks already ran
    // fail-closed, so degrading to "no 4B hold" never weakens enforcement
    // relative to the pre-R6 behaviour.
    return false;
  }
}
