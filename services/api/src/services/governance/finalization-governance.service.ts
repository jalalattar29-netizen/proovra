/**
 * THE FINALIZATION GOVERNANCE GATE — ONE BOUNDARY FOR EVERY CAPTURE PATH
 * (2026-09-29, audit D3).
 *
 * Finalization is what makes a record's report, verification package and
 * public Verify page possible. A workspace policy that denies generating a
 * report, generating a package or publishing public Verify for a record must
 * therefore refuse its finalization — on EVERY path that finalizes.
 *
 * This decision lived inline in the web route (POST /v1/evidence/:id/complete)
 * only. Direct capture (mobile camera and files, the browser extension,
 * Android and iOS screen capture) and external intake finalized through
 * `completeEvidence` without it, so a record in a workspace whose policy
 * forbids publication was signed and served on public Verify. Every finalizer
 * now asks this one function, with the same actions, the same review state,
 * the same template overlay and the same custody record of a refusal.
 */
import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { appendCustodyEvent } from "../custody-events.service.js";
import { enforceSensitiveAction, evidenceIsReviewed } from "../governance.service.js";

export const FINALIZATION_GOVERNED_ACTIONS = [
  "generate_report",
  "generate_package",
  "publish_public_verify",
] as const;

export type FinalizationGovernanceDecision =
  | { allowed: true }
  | {
      allowed: false;
      action: (typeof FINALIZATION_GOVERNED_ACTIONS)[number];
      code: string;
      reason: string;
      /** 503 when the policy could not be read (fail closed), else 409. */
      statusCode: 409 | 503;
    };

export async function evaluateFinalizationGovernance(input: {
  evidenceId: string;
  /** The person on whose authority the record is finalized. */
  actorUserId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<FinalizationGovernanceDecision> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, teamId: true, retentionUntilUtc: true },
  });
  // No workspace: workspace governance has nothing to evaluate.
  if (!evidence?.teamId) return { allowed: true };

  // ACTIVE-only membership authorizes (P0 remediation, 2026-07-21).
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: evidence.teamId, userId: input.actorUserId } },
    select: { role: true, status: true },
  });
  const role = membership?.status === "ACTIVE" ? membership.role : undefined;
  const reviewState = { isReviewed: await evidenceIsReviewed(evidence.id) };

  for (const action of FINALIZATION_GOVERNED_ACTIONS) {
    const decision = await enforceSensitiveAction(action, {
      teamId: evidence.teamId,
      role,
      evidence: {
        id: evidence.id,
        teamId: evidence.teamId,
        retentionUntilUtc: evidence.retentionUntilUtc ?? null,
      },
      reviewState,
      // The workflow template overlay can only tighten an allowed decision.
      consultTemplatePolicy: true,
    });
    if (!decision.allowed) {
      await appendCustodyEvent({
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
        payload: { action, reason: decision.reason, actorUserId: input.actorUserId },
        ip: input.ip ?? undefined,
        userAgent: input.userAgent ?? undefined,
      }).catch(() => undefined);
      return {
        allowed: false,
        action,
        code: decision.code,
        reason: decision.reason,
        statusCode: decision.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 409,
      };
    }
  }
  return { allowed: true };
}
