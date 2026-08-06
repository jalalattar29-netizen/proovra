/**
 * PHASE 12B CLUSTER 8 — SUPERSEDED COMMAND SURFACE.
 *
 * `createLegalHold` / `releaseLegalHold` / `listLegalHolds` in this module
 * have ZERO route consumers: /v1/lifecycle/legal-holds now delegates to the
 * ONE canonical authority in services/governance/legal-hold.service.ts.
 * `isUnderLegalHold` / `assertNoLegalHoldOrBlock` remain live, but they are
 * now thin wrappers over the ONE effective-hold evaluator.
 *
 * REMOVAL CONDITION (PHASE 12 POINT 3 — restated against what this module
 * actually does today). The two sentences that stood here were no longer
 * true and pointed an operator at the wrong conclusion: this module has NO
 * writers left (`createLegalHold` / `releaseLegalHold` / `listLegalHolds`
 * were deleted, so it no longer writes `legal_holds`), and the effective-hold
 * evaluator no longer reads either legacy store — the legacy union clauses
 * were removed from both the API and worker evaluators. Reading the old text,
 * an operator would have concluded `legal_holds` must be preserved to keep
 * unconverted holds blocking destruction. It must not.
 *
 * What remains here is READ-ONLY: `isUnderLegalHold` / `assertNoLegalHoldOrBlock`,
 * both thin wrappers over the ONE effective-hold evaluator, which resolves
 * exclusively against canonical `evidence_legal_holds`.
 *
 * This module may be deleted once 20271108000000_legal_hold_legacy_removal is
 * APPLIED and VERIFIED and its callers are repointed at the canonical service.
 * Deleting it is a pure call-site migration — it carries no data.
 *
 * ---------------------------------------------------------------------------
 * PROOVRA Phase 4B — Legal Hold service (canonical 4B implementation).
 *
 * Workspace-anchored preservation control over `legal_holds`. A legal
 * hold suspends destructive lifecycle transitions (DELETE / DESTROY /
 * ARCHIVE_RESTRICTED) on the scoped target until the hold is released.
 *
 * Supersedes the Phase 4A governance/case-legal-hold and
 * governance/legal-hold paths for the unified 4B model — the 4A
 * surface remains as a legacy case-only preservation primitive.
 *
 * Hard rules:
 *   * Workspace-anchored on every read + write path.
 *   * Bounded `LegalHoldKind` + `LegalHoldState` vocabularies.
 *   * Webhook fan-out is fire-and-forget — operational path is never
 *     blocked by an audit / fan-out failure.
 *   * `assertNoLegalHoldOrBlock` is the canonical destructive-action
 *     gate consumed by the destruction governance + retention sweeper
 *     services.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { evaluateEffectiveLegalHold } from "../governance/effective-legal-hold.js";
import { emitLifecycleEvent } from "../intelligence/intelligence-activity.service.js";

// ---------------------------------------------------------------------------
// isUnderLegalHold
//
// The createLegalHold / releaseLegalHold / listLegalHolds banners that used to
// sit above this one were left behind when those writers were deleted. Empty
// section headers read as "the function is somewhere below", so they are gone
// too — this module has no write surface left.
// ---------------------------------------------------------------------------

export type IsUnderLegalHoldInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  caseId?: string | null;
};

export type IsUnderLegalHoldResult = {
  underHold: boolean;
  holdIds: ReadonlyArray<string>;
  /** Origins of the matched holds — "4B" for LegalHold rows, "4A" for CaseLegalHold rows. */
  sources: ReadonlyArray<"4A" | "4B">;
};

/**
 * Canonical "is held" check for the Phase 4B destruction-governance
 * workflow.
 *
 * PHASE 12 POINT 3 — this used to say it consulted the `legal_holds` and
 * `case_legal_holds` tables directly. It does not: it delegates to the ONE
 * effective-hold evaluator, which resolves exclusively against canonical
 * `evidence_legal_holds`. The old wording named two tables the contract
 * migration drops, so it would have read as a reason to keep them.
 *
 * The guarantee it was describing still holds — a single call is a complete
 * preservation signal regardless of which era placed the hold — because the
 * historical rows were converted into canonical rows by the backfill, not
 * because two extra tables are still being read.
 *
 * CROSS-STACK NOTE (SCOPE-D vocabulary unification): the DIRECT evidence
 * delete/archive gate does NOT call this function — it lives on the
 * `POST /v1/evidence/:id` route via
 * `governance.service.ts#isUnderActiveLegalHold`. That function was
 * hardened (SCOPE-E) to consult the SAME union of hold models this one
 * does (EvidenceLegalHold + the 4B LegalHold model, incl. WORKSPACE /
 * ORGANIZATION / CASE scope). The two functions are intentionally
 * separate entry points (this one drives the 4B destruction workflow;
 * that one drives the direct trash/delete gate) but they now enforce the
 * SAME hold-model union, so a hold placed through EITHER lifecycle
 * surface blocks BOTH destruction paths. Keep them in lock-step: any new
 * hold model consulted here must also be consulted there.
 */
export async function isUnderLegalHold(
  input: IsUnderLegalHoldInput,
): Promise<IsUnderLegalHoldResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // PHASE 12B CLUSTER 8 — one evaluator, all stores. The hand-rolled union
  // that used to live here wrapped the ENTIRE 4A half in a bare try/catch, so
  // a transient failure reading `evidence_legal_holds` reported "not held" on
  // the destruction-governance gate. The evaluator only degrades on a
  // genuinely-absent relation and rethrows everything else.
  const resolvedCaseIds = new Set<string>(input.caseId ? [input.caseId] : []);
  const links = await prisma.caseEvidenceLink.findMany({
    where: { evidenceId: input.evidenceId },
    select: { caseId: true },
    take: 200,
  });
  for (const l of links) resolvedCaseIds.add(l.caseId);

  const result = await evaluateEffectiveLegalHold(prisma, {
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    caseIds: Array.from(resolvedCaseIds),
    collectAll: true,
  });

  // Legacy "4A"/"4B" source vocabulary is preserved on the wire: 4B = the
  // scope-generic `legal_holds` store, 4A = the canonical/case stores.
  const sources: Array<"4A" | "4B"> = [];
  if (result.sources.includes("LIFECYCLE_LEGAL_HOLD")) sources.push("4B");
  if (
    result.sources.includes("EVIDENCE_LEGAL_HOLD") ||
    result.sources.includes("CASE_LEGAL_HOLD")
  ) {
    sources.push("4A");
  }

  return {
    underHold: result.held,
    holdIds: result.holdIds,
    sources,
  };
}

// ---------------------------------------------------------------------------
// assertNoLegalHoldOrBlock
// ---------------------------------------------------------------------------

export type AssertNoLegalHoldOrBlockInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  caseId?: string | null;
  action: "DELETE" | "DESTROY" | "ARCHIVE_RESTRICTED";
};

export type AssertNoLegalHoldOrBlockResult =
  | { ok: true }
  | { ok: false; denial: "LEGAL_HOLD_BLOCKED"; holdIds: ReadonlyArray<string> };

export async function assertNoLegalHoldOrBlock(
  input: AssertNoLegalHoldOrBlockInput,
): Promise<AssertNoLegalHoldOrBlockResult> {
  const result = await isUnderLegalHold({
    prisma: input.prisma,
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    caseId: input.caseId ?? null,
  });

  if (!result.underHold) {
    return { ok: true };
  }

  // Fire-and-forget POLICY_VIOLATION_LEGAL_HOLD emit. Bounded payload —
  // hold reason text is never logged; only holdIds + action.
  void emitLifecycleEvent({
    prisma: input.prisma,
    teamId: input.teamId,
    code: "POLICY_VIOLATION_LEGAL_HOLD",
    evidenceId: input.evidenceId,
    caseId: input.caseId ?? null,
    reason: `hold_blocked:${input.action}:${result.holdIds.slice(0, 10).join(",")}`.slice(0, 200),
    targetType: "LEGAL_HOLD",
    targetId: result.holdIds[0] ?? null,
  });

  return {
    ok: false,
    denial: "LEGAL_HOLD_BLOCKED",
    holdIds: result.holdIds,
  };
}

// ---------------------------------------------------------------------------
// countActiveHolds
// ---------------------------------------------------------------------------
