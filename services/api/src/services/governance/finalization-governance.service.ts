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
import { appendCustodyEventTx } from "@proovra/shared-runtime";
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

type GovernedOutputAction = (typeof FINALIZATION_GOVERNED_ACTIONS)[number];

/**
 * THE ONE OUTPUT-POLICY DECISION (ET-SEC-14, 2026-09-30).
 *
 * The workspace policy for a record's outputs — role, requireReviewBeforeReport,
 * allowReportDownload/allowPackageDownload and the workflow template overlay —
 * decided for `actions` in order; the first refusal wins. No side effects:
 * finalization records its refusal itself, and an output regeneration is
 * refused with no trace on the record.
 *
 * A record with no workspace row has no workspace policy to evaluate.
 */
async function decideGovernedOutputActions(input: {
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
  });
  if (decision.allowed) return { allowed: true };
  const evidence = { id: decision.evidenceId };
  const action = decision.action;
  // A REFUSED FINALIZATION PUBLISHES NOTHING, AND SAYS SO (2026-09-29).
  // Every record is created with public_verify_state PUBLISHED (the
  // column default), so a refused, never-signed record read "Published"
  // in the library filter. It is marked NOT_PUBLISHED; a later
  // finalization under a changed policy then needs an explicit publish.
  // A signed record is never touched here.
  // ET-CUS-11: the NOT_PUBLISHED mark and the refusal's custody event
  // commit together, and a failure fails the request rather than leaving
  // a record marked with no trace (both used to be swallowed).
  await prisma.$transaction(async (tx) => {
    await tx.evidence.updateMany({
      where: { id: evidence.id, signedAtUtc: null },
      data: { publicVerifyState: "NOT_PUBLISHED" },
    });
    // ET-INT-13 — ONE refusal event per unchanged refusal. An anonymous
    // contributor retrying a governance-denied submit appended a new
    // EXPORT_BLOCKED_BY_POLICY per retry, growing the chain without bound.
    // Decided under the record lock, so concurrent retries append once.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${evidence.id}))`;
    const latest = await tx.custodyEvent.findFirst({
      where: { evidenceId: evidence.id },
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
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
      payload: { action, reason: decision.reason, actorUserId: input.actorUserId },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  });
  return {
    allowed: false,
    action,
    code: decision.code,
    reason: decision.reason,
    statusCode: governanceUnavailable(decision.code) ? 503 : 409,
  };
}
