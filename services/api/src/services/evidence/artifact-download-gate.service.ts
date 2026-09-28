/**
 * THE ARTIFACT DOWNLOAD GATE — one decision for every byte boundary
 * (2026-09-29).
 *
 * Extracted, unchanged in its rules, from `assertArtifactDownloadAllowed` in
 * evidence.routes.ts so that the per-record report/package downloads AND the
 * case export (which streamed every linked record's report PDF with only a
 * case-membership check — no sensitive-action gate, no export eligibility, no
 * custody record) answer the same question the same way:
 *
 *   1. READ ACCESS            (the caller's own read-access resolver)
 *   2. SENSITIVE ACTION       workspace governance (role, retention, template)
 *   3. PACKAGE PUBLISH GATE   packages only
 *   4. EXPORT ELIGIBILITY     legal hold, lifecycle states that forbid export
 *
 * Commercial state is deliberately absent: downloading an artifact that EXISTS
 * is not a commercial question (see the route-level notes). Every denial writes
 * the EXPORT_BLOCKED_BY_POLICY custody event.
 */
import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { appendCustodyEvent } from "../custody-events.service.js";
import { noteCustodyFailure } from "../custody-events-observability.js";

export type ArtifactDownloadDecision =
  | { allowed: true; teamId: string | null }
  | {
      allowed: false;
      teamId: string | null;
      statusCode: number;
      body: Record<string, unknown>;
    };

export async function evaluateArtifactDownload(input: {
  evidenceId: string;
  actorUserId: string;
  kind: "report" | "package";
  ip?: string | null;
  userAgent?: string | null;
  /** The host's read-access resolver; throws with `statusCode` when denied. */
  readAccess: (userId: string, evidenceId: string) => Promise<unknown>;
}): Promise<ArtifactDownloadDecision> {
  const { evidenceId, actorUserId, kind } = input;
  const action = kind === "report" ? "report_download" : "verification_package_download";
  const ip = input.ip ?? undefined;
  const userAgent = input.userAgent ?? undefined;

  try {
    await input.readAccess(actorUserId, evidenceId);
  } catch (err) {
    const statusCode =
      err instanceof Error && "statusCode" in err
        ? ((err as Error & { statusCode?: number }).statusCode ?? 500)
        : 500;
    const message = err instanceof Error ? err.message : "Unexpected error";
    return { allowed: false, teamId: null, statusCode, body: { message } };
  }

  const evidenceForGate = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { id: true, teamId: true, retentionUntilUtc: true },
  });
  const teamId = evidenceForGate?.teamId ?? null;

  // Legacy rows with no workspace: read access above established ownership,
  // and the governance gates below have nothing to evaluate against.
  if (!teamId || !evidenceForGate) return { allowed: true, teamId };

  const { enforceSensitiveAction } = await import("../governance.service.js");
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: actorUserId } },
    select: { role: true, status: true },
  });
  const decision = await enforceSensitiveAction(
    kind === "report" ? "download_report" : "download_package",
    {
      teamId,
      role: membership?.status === "ACTIVE" ? membership.role : undefined,
      evidence: {
        id: evidenceForGate.id,
        teamId,
        retentionUntilUtc: evidenceForGate.retentionUntilUtc ?? null,
      },
      consultTemplatePolicy: true,
    },
  );
  if (!decision.allowed) {
    await appendCustodyEvent({
      evidenceId,
      eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
      payload: { action, reason: decision.reason, actorUserId },
      ip,
      userAgent,
    }).catch(noteCustodyFailure);
    return {
      allowed: false,
      teamId,
      statusCode: decision.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 403,
      body: {
        code: decision.code,
        reason: decision.reason,
        message:
          kind === "report"
            ? "Report download is blocked by workspace governance policy."
            : "Verification package download is blocked by workspace governance policy.",
      },
    };
  }

  if (kind === "package") {
    const { gateVerificationAction } = await import(
      "../governance/policy-runtime-gates.service.js"
    );
    const verifyGate = await gateVerificationAction({
      teamId,
      evidenceId,
      action: "PUBLISH_PACKAGE",
    });
    if (!verifyGate.ok) {
      await appendCustodyEvent({
        evidenceId,
        eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
        payload: {
          action: "verification_package_publish_gate",
          denial: verifyGate.denial,
          reason: verifyGate.reason,
          actorUserId,
        },
        ip,
        userAgent,
      }).catch(noteCustodyFailure);
      return {
        allowed: false,
        teamId,
        statusCode: 403,
        body: {
          code: "VERIFICATION_POLICY_BLOCKED",
          denial: verifyGate.denial,
          reason: verifyGate.reason,
          message: "Verification package download is blocked by a verification policy.",
        },
      };
    }
  }

  const { checkExportEligibility } = await import(
    "../governance-lifecycle/export-governance.service.js"
  );
  const eligibility = await checkExportEligibility({ teamId, evidenceId, actorUserId });
  if (eligibility.outcome !== "ALLOWED") {
    await appendCustodyEvent({
      evidenceId,
      eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
      payload: { action, reason: eligibility.outcome, actorUserId },
      ip,
      userAgent,
    }).catch(noteCustodyFailure);
    return {
      allowed: false,
      teamId,
      statusCode: 403,
      body: {
        code: eligibility.outcome,
        reason: eligibility.reason,
        message:
          kind === "report"
            ? "Report download is blocked by evidence export eligibility."
            : "Verification package download is blocked by evidence export eligibility.",
      },
    };
  }

  return { allowed: true, teamId };
}
