/**
 * PUBLIC DISCLOSURE GOVERNANCE — the workspace's word on what may leave through
 * a reviewer link or the verification page (REPORT-001).
 *
 * A reviewer link and a widened disclosure policy are decided here, on top of
 * the existing authorities rather than beside them:
 *
 *   enforceSensitiveAction   role, allowPublicVerify, requireReviewBeforePublicVerify,
 *                            the workflow template overlay
 *   gateVerificationAction   verification policies aimed at PUBLIC_VERIFY_EXPOSE
 *   evaluateArtifactDownload the actor's own right to the original bytes: the
 *                            capability, allowOriginalDownload, export eligibility
 *
 * ISSUANCE. Creating, rotating or renewing a link, or widening the record's
 * disclosure, each hands an outsider a capability, so each asks the same
 * question. A member cannot grant what they could not take themselves.
 *
 * READ. A grant is not a standing permission: the anonymous answer asks the
 * workspace again, so turning a policy off takes effect on links already sent.
 * The link's row is left alone and answers again if the policy is restored.
 *
 * WHAT STAYS (owner decision 2026-10-14). A `pvr_` reference is the record's
 * permanent verification identity and always opens, verification only. Policy
 * therefore narrows an answer; it never removes the page. The UI's promise for
 * allowPublicVerify is the same: "does not unpublish existing pages".
 */
import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import type { PublicVerifyDisclosureFacts } from "@proovra/shared";
import { evaluateArtifactDownload } from "../evidence/artifact-download-gate.service.js";
import { appendCustodyEvent } from "../custody-events.service.js";
import { noteCustodyFailure } from "../custody-events-observability.js";
import { enforceSensitiveAction, evidenceIsReviewed, loadWorkspaceGovernancePolicy } from "../governance.service.js";
import { gateVerificationAction } from "./policy-runtime-gates.service.js";

export type PublicDisclosureGrantAction = "share_link_create" | "share_link_rotate" | "share_link_renew" | "disclosure_widen";

export type PublicDisclosureGrantDecision =
  | { allowed: true }
  | { allowed: false; statusCode: 403 | 503; code: string; reason: string };

type RecordRef = { id: string; teamId: string | null; ownerUserId?: string | null };

/**
 * May this actor hand this disclosure to an outsider now? A refusal is a
 * custody fact, recorded once per attempt, and is decided before a step-up is
 * asked for so a refused request never spends a challenge.
 */
export async function evaluatePublicDisclosureGrant(input: {
  record: RecordRef;
  actorUserId: string;
  action: PublicDisclosureGrantAction;
  /** The grant includes original files (a STANDARD link that allows them). */
  grantsOriginal: boolean;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<PublicDisclosureGrantDecision> {
  const { record, actorUserId, action } = input;
  const refuse = async (
    statusCode: 403 | 503,
    code: string,
    reason: string,
  ): Promise<PublicDisclosureGrantDecision> => {
    await appendCustodyEvent({
      evidenceId: record.id,
      eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
      payload: { action, reason, actorUserId },
      ip: input.ip ?? undefined,
      userAgent: input.userAgent ?? undefined,
    }).catch(noteCustodyFailure);
    return { allowed: false, statusCode, code, reason };
  };

  const teamId = record.teamId ?? null;
  const evidence = await prisma.evidence.findUnique({
    where: { id: record.id },
    select: { id: true, teamId: true, ownerUserId: true, retentionUntilUtc: true },
  });
  if (!evidence) return { allowed: false, statusCode: 403, code: "ACCESS_DENIED", reason: "record_not_found" };

  const membership = teamId
    ? await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: actorUserId } },
        select: { role: true, status: true },
      })
    : null;
  const isReviewed = await evidenceIsReviewed(evidence.id);

  const publish = await enforceSensitiveAction("publish_public_verify", {
    teamId,
    role: membership?.status === "ACTIVE" ? membership.role : undefined,
    evidence: { id: evidence.id, teamId, retentionUntilUtc: evidence.retentionUntilUtc ?? null },
    reviewState: { isReviewed },
    consultTemplatePolicy: true,
    personalOwnerVerified: !teamId && evidence.ownerUserId === actorUserId,
  });
  if (!publish.allowed) {
    return refuse(publish.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 403, publish.code, publish.reason);
  }

  if (teamId) {
    /*
     * "Publishing a record for outside verification needs a recorded approval
     * first" (the workspace policy's own promise). The recorded approval this
     * product keeps is the review decision. It is read here and not inside
     * canPublishPublicVerify because finalization asks that function too, and
     * a record cannot be approved before it exists.
     */
    let requiresApproval: boolean;
    try {
      requiresApproval = (await loadWorkspaceGovernancePolicy(teamId)).requirePublicationApproval;
    } catch {
      return refuse(503, "GOVERNANCE_CHECK_FAILED", "policy_lookup_failed");
    }
    if (requiresApproval && !isReviewed) {
      return refuse(403, "PUBLIC_VERIFY_BLOCKED_BY_POLICY", "publication_approval_required");
    }

    let verification: Awaited<ReturnType<typeof gateVerificationAction>>;
    try {
      verification = await gateVerificationAction({ teamId, evidenceId: evidence.id, action: "PUBLIC_VERIFY_EXPOSE" });
    } catch {
      return refuse(503, "GOVERNANCE_CHECK_FAILED", "verification_policy_unavailable");
    }
    if (!verification.ok) return refuse(403, "VERIFICATION_POLICY_BLOCKED", verification.reason);
  }

  if (input.grantsOriginal) {
    // The gate that decides the actor's own download also decides what they may
    // grant. It writes nothing here; the refusal above records the attempt once.
    const original = await evaluateArtifactDownload({
      evidenceId: evidence.id,
      actorUserId,
      kind: "original",
      readAccess: async () => undefined,
      recordDenial: false,
    });
    if (!original.allowed) {
      const body = original.body as { code?: unknown; reason?: unknown };
      return refuse(
        original.statusCode === 503 ? 503 : 403,
        typeof body.code === "string" ? body.code : "ORIGINAL_DOWNLOAD_BLOCKED_BY_POLICY",
        typeof body.reason === "string" ? body.reason : "original_release_refused",
      );
    }
  }
  return { allowed: true };
}

/**
 * May an EXISTING reviewer link release originals right now? Asked on every
 * anonymous read. Export eligibility and the workspace's allowOriginalDownload
 * always apply; a link still held in a person's name also needs that person to
 * hold the right they granted. A link with no creator (minted by a system path)
 * answers to the policy alone. Any failure to decide withholds the bytes.
 */
export async function evaluatePublicOriginalRelease(input: {
  evidenceId: string;
  shareCreatedByUserId: string | null;
}): Promise<boolean> {
  try {
    if (input.shareCreatedByUserId) {
      const decision = await evaluateArtifactDownload({
        evidenceId: input.evidenceId,
        actorUserId: input.shareCreatedByUserId,
        kind: "original",
        readAccess: async () => undefined,
        recordDenial: false,
      });
      return decision.allowed;
    }
    const row = await prisma.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { teamId: true },
    });
    if (!row) return false;
    if (row.teamId) {
      const policy = await loadWorkspaceGovernancePolicy(row.teamId);
      if (!policy.allowOriginalDownload) return false;
    }
    const { checkExportEligibility } = await import("../governance-lifecycle/export-governance.service.js");
    const eligibility = await checkExportEligibility({ teamId: row.teamId ?? null, evidenceId: input.evidenceId, audience: "public" });
    return eligibility.outcome === "ALLOWED";
  } catch {
    return false;
  }
}

/**
 * The disclosure an anonymous answer may actually make right now. Only narrows.
 * A verification-only answer costs nothing: it discloses what a `pvr_` always
 * may, so it is returned without a lookup.
 */
export async function narrowPublicDisclosureAtRead(input: {
  disclosure: PublicVerifyDisclosureFacts;
  evidenceId: string;
  teamId: string | null;
  shareCreatedByUserId: string | null;
}): Promise<PublicVerifyDisclosureFacts> {
  const { disclosure } = input;
  if (disclosure.mode === "VERIFICATION_ONLY" && !disclosure.originalDownload) return disclosure;
  if (input.teamId) {
    let exposed = false;
    try {
      const gate = await gateVerificationAction({
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        action: "PUBLIC_VERIFY_EXPOSE",
        recordCleanEvaluation: false,
      });
      // A WARN needs someone to acknowledge it, and an anonymous reader cannot.
      // It stays a warning; only a BLOCK narrows a page that already exists.
      exposed = gate.ok || gate.denial !== "POLICY_BLOCK";
    } catch {
      exposed = false;
    }
    if (!exposed) {
      return { ...disclosure, mode: "VERIFICATION_ONLY", recordedLocation: false, originalDownload: false };
    }
  }
  if (!disclosure.originalDownload) return disclosure;
  const released = await evaluatePublicOriginalRelease({
    evidenceId: input.evidenceId,
    shareCreatedByUserId: input.shareCreatedByUserId,
  });
  return released ? disclosure : { ...disclosure, originalDownload: false };
}
