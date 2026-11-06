/**
 * THE FINALIZATION OUTPUT-POLICY BOUNDARY — ONE FOR EVERY CAPTURE PATH
 * (2026-09-29, audit D3; REPORT-004, 2026-11-04).
 *
 * Every finalizer (POST /v1/evidence/:id/complete, direct capture — mobile
 * camera and files, the browser extension, Android and iOS screen capture —
 * and external intake) asks this one function, with the same actions, the
 * same review state, the same template overlay and the same custody record.
 *
 * REPORT-004 — OUTPUT PREFERENCES HOLD OUTPUTS, NEVER SEALING. This boundary
 * used to REFUSE finalization when the output policy denied a report, a
 * package or public Verify publication, so a setting labelled as a download or
 * publication preference stopped integrity sealing for every new record: it
 * stayed UPLOADING and was never signed, timestamped or anchored. Sealing now
 * always proceeds. What the policy refuses is the record's first OUTPUTS:
 *
 *   HOLD     the record carries `outputsHeldAtUtc` (+ reason, + the actor whose
 *            role was decided), and the refusal is a custody fact
 *            (EXPORT_BLOCKED_BY_POLICY, once per unchanged refusal);
 *   ISSUE    no report or package request exists while it is held — the
 *            shared request writer refuses a held record for every producer,
 *            and the worker's first-issuance scan skips it;
 *   RELEASE  `output-hold.service` re-reads the same decision live (a policy
 *            change, an approving review, an explicit Generate) and, when it
 *            now allows them, clears the hold once and issues the first pair
 *            once.
 *
 * Publication stays governed where it happens: a reviewer link or a widened
 * disclosure asks `evaluatePublicDisclosureGrant`, and every download asks the
 * download gate. A `pvr_` reference opens verification only, as the owner
 * decision of 2026-10-14 says ("policy narrows an answer; it never removes the
 * page").
 */
import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { appendCustodyEventTx } from "@proovra/shared-runtime";
import { enforceSensitiveAction, evidenceIsReviewed } from "../governance.service.js";

/** The outputs a record's first issuance produces, decided at finalization. */
export const FINALIZATION_GOVERNED_ACTIONS = ["generate_report", "generate_package"] as const;

export type FinalizationGovernanceDecision =
  | { allowed: true; outputsHeld: false }
  | {
      /** Sealing always proceeds (REPORT-004); the first outputs are held. */
      allowed: true;
      outputsHeld: true;
      action: (typeof FINALIZATION_GOVERNED_ACTIONS)[number];
      code: string;
      reason: string;
    };

type GovernedOutputAction = "generate_report" | "generate_package" | "publish_public_verify";

/**
 * THE ONE OUTPUT-POLICY DECISION (ET-SEC-14, 2026-09-30).
 *
 * The workspace policy for a record's outputs — role, requireReviewBeforeReport,
 * allowReportDownload/allowPackageDownload and the workflow template overlay —
 * decided for `actions` in order; the first refusal wins. No side effects.
 *
 * A record with no workspace row has no workspace policy to evaluate.
 */
export async function decideGovernedOutputActions(input: {
  evidenceId: string;
  actorUserId: string;
  actions: readonly GovernedOutputAction[];
}): Promise<
  | { allowed: true; evidenceId: string | null }
  | { allowed: false; evidenceId: string; action: GovernedOutputAction; code: string; reason: string }
> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, teamId: true, retentionUntilUtc: true },
  });
  // No workspace: workspace governance has nothing to evaluate.
  if (!evidence?.teamId) return { allowed: true, evidenceId: evidence?.id ?? null };

  // ACTIVE-only membership authorizes (P0 remediation, 2026-07-21).
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: evidence.teamId, userId: input.actorUserId } },
    select: { role: true, status: true },
  });
  const role = membership?.status === "ACTIVE" ? membership.role : undefined;
  const reviewState = { isReviewed: await evidenceIsReviewed(evidence.id) };

  for (const action of input.actions) {
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
      return { allowed: false, evidenceId: evidence.id, action, code: decision.code, reason: decision.reason };
    }
  }
  return { allowed: true, evidenceId: evidence.id };
}

/** 503 when the policy could not be read (fail closed). */
function governanceUnavailable(code: string): boolean {
  return code === "GOVERNANCE_CHECK_FAILED";
}

/**
 * ET-SEC-14 — a report / package REGENERATION (recovery or an updated
 * version) runs the same output policy as first issuance. Regeneration used
 * to reach the worker on `evidence.generate_report` alone, so a workspace
 * requiring review before a report, or disabling reports, was bypassed by
 * asking for a new version. The refusal is 403 with the policy's reason
 * (503 when the policy cannot be read).
 */
export async function evaluateOutputRegenerationGovernance(input: {
  evidenceId: string;
  actorUserId: string;
}): Promise<
  | { allowed: true }
  | { allowed: false; action: GovernedOutputAction; code: string; reason: string; statusCode: 403 | 503 }
> {
  const decision = await decideGovernedOutputActions({
    ...input,
    actions: ["generate_report", "generate_package"],
  });
  if (decision.allowed) return { allowed: true };
  return {
    allowed: false,
    action: decision.action,
    code: decision.code,
    reason: decision.reason,
    statusCode: governanceUnavailable(decision.code) ? 503 : 403,
  };
}

/**
 * Decide the record's first outputs at finalization and record the answer on
 * the record. Never refuses: the caller seals in every case (REPORT-004).
 */
export async function evaluateFinalizationGovernance(input: {
  evidenceId: string;
  /** The person on whose authority the record is finalized. */
  actorUserId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<FinalizationGovernanceDecision> {
  const decision = await decideGovernedOutputActions({
    evidenceId: input.evidenceId,
    actorUserId: input.actorUserId,
    actions: FINALIZATION_GOVERNED_ACTIONS,
  }).catch(
    // An unreadable policy holds the outputs (the fail-closed direction for
    // outputs); it never blocks sealing.
    () => ({ allowed: false as const, evidenceId: input.evidenceId, action: "generate_report" as const, code: "GOVERNANCE_CHECK_FAILED", reason: "policy_lookup_failed" }),
  );
  if (decision.allowed) {
    // A retry after the policy was relaxed clears an earlier hold.
    if (decision.evidenceId) {
      await prisma.evidence.updateMany({
        where: { id: decision.evidenceId, outputsHeldAtUtc: { not: null }, status: { notIn: ["SIGNED", "REPORTED"] } },
        data: { outputsHeldAtUtc: null, outputsHeldReason: null, outputsHeldActorUserId: null },
      });
    }
    return { allowed: true, outputsHeld: false };
  }
  const evidenceId = decision.evidenceId;
  const action = decision.action === "publish_public_verify" ? "generate_report" : decision.action;
  // ET-CUS-11: the hold and its custody event commit together or the request
  // fails. ET-INT-13: ONE refusal event per unchanged refusal, decided under the
  // record lock, so concurrent retries append once.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${evidenceId}))`;
    await tx.evidence.updateMany({
      where: { id: evidenceId },
      data: {
        outputsHeldReason: decision.reason.slice(0, 64),
        outputsHeldActorUserId: input.actorUserId,
      },
    });
    await tx.evidence.updateMany({
      where: { id: evidenceId, outputsHeldAtUtc: null },
      data: { outputsHeldAtUtc: new Date() },
    });
    const latest = await tx.custodyEvent.findFirst({
      where: { evidenceId },
      orderBy: { sequence: "desc" },
      select: { eventType: true, payload: true },
    });
    const latestPayload = (latest?.payload ?? null) as { action?: unknown; reason?: unknown } | null;
    if (
      latest?.eventType === prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY &&
      latestPayload?.action === action &&
      latestPayload?.reason === decision.reason
    ) {
      return;
    }
    await appendCustodyEventTx(tx, {
      evidenceId,
      eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
      payload: { action, reason: decision.reason, actorUserId: input.actorUserId, outputsHeld: true },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  });
  return { allowed: true, outputsHeld: true, action, code: decision.code, reason: decision.reason };
}
