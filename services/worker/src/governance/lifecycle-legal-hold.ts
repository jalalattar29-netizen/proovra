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
    /**
     * PHASE 12B — CaseEvidenceLink is the relationship authority; evidence can
     * be linked to MULTIPLE cases and a hold on ANY of them blocks (fail closed).
     */
    caseIds?: readonly string[];
  },
): Promise<boolean> {
  // Phase-4B holds are workspace-anchored (every `LegalHold` row carries a
  // teamId). Personal-scope evidence (teamId null) has no 4B hold surface.
  if (!input.teamId) return false;

  // P12.3 canonical-only. A canonical WORKSPACE row carries no target
  // columns, so it is matched on scope alone (the query is already
  // teamId-anchored). Historical rows have NULL targets and are matched
  // explicitly so an unresolvable ACTIVE hold still blocks — failing closed.
  const orClauses: Array<Record<string, unknown>> = [
    { scope: "EVIDENCE", evidenceId: input.evidenceId },
    { scope: "WORKSPACE" },
    { historical: true },
  ];
  for (const caseId of input.caseIds ?? []) {
    orClauses.push({ scope: "CASE", caseId });
  }

  // PHASE 12 POINT 3 — FAIL CLOSED, WITHOUT EXCEPTION.
  //
  // WAVE 0.3 allowed a genuinely-absent `legal_holds` table to degrade to
  // "no 4B hold", because that store was OPTIONAL: it only existed on newer
  // environments, and the canonical checks in the caller still enforced.
  //
  // That allowance is now unsafe. `evidence_legal_holds` is the ONE hold
  // store, so "the table is missing" is no longer a benign older-environment
  // signal — it is a broken deployment, and answering `false` would report a
  // held record as free and let a destructive run delete it. Every read
  // failure, including P2021/P2022, must abort the run — which is exactly what
  // happens with NO try/catch here: the rejection propagates untouched. The
  // wrapper that used to sit here caught and immediately rethrew, which read
  // as if a decision were being made and hid that none is.
  const row = await prisma.evidenceLegalHold.findFirst({
    where: {
      teamId: input.teamId,
      status: "ACTIVE",
      OR: orClauses,
    },
    select: { id: true },
  });
  return Boolean(row);
}
