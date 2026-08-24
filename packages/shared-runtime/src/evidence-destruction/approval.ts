/**
 * THE ONE ANSWER to "does this record need an approved destruction, and does it
 * have one?".
 *
 * The executor refuses to guess this — it takes the verdict as input — and
 * before this module every caller would have resolved it differently, which is
 * how you end up with an automatic sweep destroying records a governance
 * workspace believed were gated. One function, both hosts.
 *
 * THE RULE
 * ---------------------------------------------------------------------------
 * WORKSPACE-scoped evidence always requires an approved destruction record.
 * PERSONAL-scope evidence never does.
 *
 * That is a deliberate choice of the conservative reading over a configurable
 * one. There is no "destruction requires approval" column on
 * `WorkspaceGovernancePolicy`, and inventing one would mean every existing
 * workspace defaults to SOME value on the day the migration lands — and the
 * only safe default is "required", which is what this rule already says without
 * a schema change. A workspace that wants a record destroyed goes through the
 * destruction-review pipeline it already has; there is no configuration under
 * which an unreviewed automatic sweep may destroy another organisation's
 * evidence.
 *
 * Personal-scope evidence is excluded because there is no second party to
 * approve to: the owner asked for it, the owner is the workspace, and every
 * other boundary (trash grace, retention, Object Lock, legal hold) still
 * applies to it in full.
 */

import type { PrismaClient } from "@prisma/client";

export interface DestructionApprovalVerdict {
  required: boolean;
  approved: boolean;
  /** The approving record, when there is one. Recorded in the certificate. */
  destructionReviewId: string | null;
}

/**
 * Approval is satisfied by a DestructionReview for THIS evidence in this team
 * that has reached APPROVED and has not been withdrawn into a terminal
 * non-approving status.
 *
 * FAIL-CLOSED: a lookup failure reports "required and not approved". This
 * function's output gates an irreversible operation, so the failure mode has to
 * be a refused destruction, never an unreviewed one.
 */
export async function resolveDestructionApproval(
  prisma: PrismaClient,
  input: { evidenceId: string; teamId: string | null },
): Promise<DestructionApprovalVerdict> {
  if (!input.teamId) {
    return { required: false, approved: false, destructionReviewId: null };
  }
  try {
    const review = await prisma.destructionReview.findFirst({
      where: {
        evidenceId: input.evidenceId,
        teamId: input.teamId,
        status: "APPROVED",
      },
      orderBy: { decidedAtUtc: "desc" },
      select: { id: true },
    });
    return {
      required: true,
      approved: review !== null,
      destructionReviewId: review?.id ?? null,
    };
  } catch {
    return { required: true, approved: false, destructionReviewId: null };
  }
}
