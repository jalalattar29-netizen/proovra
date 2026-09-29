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
 *
 * THE ORIGINAL TOO (2026-09-29, audit M2). /original, /parts and every content
 * view that presigns an original object ask this gate with kind "original";
 * the original used to skip export eligibility (legal hold, lifecycle,
 * destruction review) entirely.
 *
 * NO WORKSPACE GRANTS NOTHING (2026-09-29, audit M2). A record with no
 * workspace row used to be allowed as soon as read access passed — and read
 * access admits case collaborators, not only the owner. Such a record is now
 * released only to its Personal OWNER (the canonical Personal-owner rule),
 * and export eligibility still applies to it.
 */
import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { appendCustodyEvent } from "../custody-events.service.js";
import { noteCustodyFailure } from "../custody-events-observability.js";

export type ArtifactKind = "report" | "package" | "original";

const SENSITIVE_ACTION = {
  report: "download_report",
  package: "download_package",
  original: "download_original",
} as const;

const CUSTODY_ACTION = {
  report: "report_download",
  package: "verification_package_download",
  original: "download_original",
} as const;

const SUBJECT = {
  report: "Report download",
  package: "Verification package download",
  original: "Original file download",
} as const;

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
  kind: ArtifactKind;
  ip?: string | null;
  userAgent?: string | null;
  /** The host's read-access resolver; throws with `statusCode` when denied. */
  readAccess: (userId: string, evidenceId: string) => Promise<unknown>;
  /**
   * False for a VIEW that merely decides whether to include a URL (a record
   * page): a refusal there is not a download attempt and writes no custody
   * event. Default true.
   */
  recordDenial?: boolean;
}): Promise<ArtifactDownloadDecision> {
  const { evidenceId, actorUserId, kind } = input;
  const action = CUSTODY_ACTION[kind];
  const ip = input.ip ?? undefined;
  const userAgent = input.userAgent ?? undefined;
  const recordDenial = input.recordDenial !== false;
  const denied = async (
    teamId: string | null,
    statusCode: number,
    body: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<ArtifactDownloadDecision> => {
    if (recordDenial) {
      await appendCustodyEvent({
        evidenceId,
        eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
        payload: { ...payload, actorUserId },
        ip,
        userAgent,
      }).catch(noteCustodyFailure);
    }
    return { allowed: false, teamId, statusCode, body };
  };

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
    select: { id: true, teamId: true, ownerUserId: true, retentionUntilUtc: true },
  });
  if (!evidenceForGate) {
    return { allowed: false, teamId: null, statusCode: 404, body: { message: "Evidence not found" } };
  }
  const teamId = evidenceForGate.teamId ?? null;

  // THE PERSONAL-OWNER RULE, explicitly (2026-09-29, audit M2). With no
  // workspace row there is no membership or policy to consult; the bytes are
  // the owner's alone. A case collaborator may read the record, not take it.
  const personalOwner = !teamId && evidenceForGate.ownerUserId === actorUserId;
  if (!teamId && !personalOwner) {
    return denied(
      null,
      403,
      {
        code: "PERSONAL_OWNER_REQUIRED",
        reason: "personal_record_owner_only",
        message: SUBJECT[kind] + " is available only to the owner of this personal record.",
      },
      { action, reason: "personal_record_owner_only" },
    );
  }

  const { enforceSensitiveAction } = await import("../governance.service.js");
  const membership = teamId
    ? await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: actorUserId } },
        select: { role: true, status: true },
      })
    : null;
  const decision = await enforceSensitiveAction(SENSITIVE_ACTION[kind], {
    teamId,
    role: membership?.status === "ACTIVE" ? membership.role : undefined,
    evidence: {
      id: evidenceForGate.id,
      teamId,
      retentionUntilUtc: evidenceForGate.retentionUntilUtc ?? null,
    },
    // The original route never opted into the template overlay; unchanged.
    consultTemplatePolicy: kind !== "original",
    personalOwnerVerified: personalOwner,
  });
  if (!decision.allowed) {
    return denied(
      teamId,
      decision.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 403,
      {
        code: decision.code,
        reason: decision.reason,
        message: SUBJECT[kind] + " is blocked by workspace governance policy.",
      },
      { action, reason: decision.reason },
    );
  }

  if (kind === "package" && teamId) {
    const { gateVerificationAction } = await import(
      "../governance/policy-runtime-gates.service.js"
    );
    const verifyGate = await gateVerificationAction({
      teamId,
      evidenceId,
      action: "PUBLISH_PACKAGE",
    });
    if (!verifyGate.ok) {
      return denied(
        teamId,
        403,
        {
          code: "VERIFICATION_POLICY_BLOCKED",
          denial: verifyGate.denial,
          reason: verifyGate.reason,
          message: "Verification package download is blocked by a verification policy.",
        },
        {
          action: "verification_package_publish_gate",
          denial: verifyGate.denial,
          reason: verifyGate.reason,
        },
      );
    }
  }

  const { checkExportEligibility } = await import(
    "../governance-lifecycle/export-governance.service.js"
  );
  const eligibility = await checkExportEligibility({ teamId, evidenceId, actorUserId });
  if (eligibility.outcome !== "ALLOWED") {
    return denied(
      teamId,
      403,
      {
        code: eligibility.outcome,
        reason: eligibility.reason,
        message: SUBJECT[kind] + " is blocked by evidence export eligibility.",
      },
      { action, reason: eligibility.outcome },
    );
  }

  return { allowed: true, teamId };
}
