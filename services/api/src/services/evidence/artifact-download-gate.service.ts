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
 *   5. INTEGRITY RECHECK      originals only (ET-SM-07): a release of bytes
 *                             not rechecked inside the cadence requests one
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
import type { StoredBytesIntegrity } from "@proovra/shared";
import {
  STORED_BYTES_INTEGRITY_SELECT,
  readStoredBytesIntegrity,
  requestIntegrityRecheck,
} from "@proovra/shared-runtime";

import { prisma } from "../../db.js";
import { resolveEvidenceRecordAccess } from "./evidence-record-access.service.js";
import { assertRedactionCapability } from "../redaction/redaction-rbac.service.js";
import { appendCustodyEvent } from "../custody-events.service.js";
import { noteCustodyFailure } from "../custody-events-observability.js";

/**
 * ET-SEC-26 — "redaction": a released redacted derivative is a byte release
 * too, and was the one path outside this gate (no legal hold, lifecycle or
 * export-eligibility check). Here the record must be open to the caller, the
 * personal-owner rule applies, and export eligibility decides. No workspace
 * download POLICY names derivatives, so none is consulted.
 *
 * VIEWING IS NOT EXPORTING (release review, 2026-09-30). The gate asked only
 * `evidence.read` for a derivative and relied on the ROUTE to have checked the
 * explicit `redaction.derivative.download` capability first. That made the
 * byte-release authority itself answer "allowed" to any reader: a second
 * caller of the gate — or a route change — would have released redacted bytes
 * on read access alone. The authority now requires the explicit
 * derivative-download capability ITSELF, resolved from the caller's CURRENT
 * workspace membership (an ACTIVE member whose role grants it), after the
 * record-access decision (membership, access expiry, organization lifecycle)
 * and before export eligibility. The route's own check stays, as defence in
 * depth; neither is sufficient alone. A derivative is never a way to the
 * original: this kind presigns only the derivative's own object.
 */
/*
 * UC-DER-002 — "derived": machine-derived review material rendered FROM the
 * original content (thumbnails, video frames, UC-4 keyframes, the low-res
 * proxy, waveforms, and the screen-reconstruction JSON carrying every OCR'd
 * line). It is the original's content in another form, so it is released on
 * the SAME terms as the original: the download-original capability (a VIEWER,
 * who is refused original bytes even for in-app viewing, is refused these
 * too), the personal-owner rule, the original's governance action, and export
 * eligibility (legal hold, trashed / destruction-bound lifecycle, destruction
 * review). It was previously served on `evidence.read` alone, outside this
 * gate. The integrity recheck stays originals-only: a derivative carries its
 * own digest and is never the original.
 */
export type ArtifactKind = "report" | "package" | "original" | "redaction" | "derived";

const DOWNLOAD_PERMISSION = {
  report: "evidence.download_report",
  package: "evidence.download_package",
  original: "evidence.download_original",
  redaction: "evidence.read",
  derived: "evidence.download_original",
} as const;

const SENSITIVE_ACTION = {
  report: "download_report",
  package: "download_package",
  original: "download_original",
  redaction: null,
  derived: "download_original",
} as const;

const CUSTODY_ACTION = {
  report: "report_download",
  package: "verification_package_download",
  original: "download_original",
  redaction: "redaction_derivative_download",
  derived: "derived_asset_download",
} as const;

const SUBJECT = {
  report: "Report download",
  package: "Verification package download",
  original: "Original file download",
  redaction: "Redacted derivative download",
  derived: "Derived review material",
} as const;

export type ArtifactDownloadDecision =
  | {
      allowed: true;
      teamId: string | null;
      /** ET-SM-07 — originals only: the stored-bytes recheck state at release. */
      storedBytes?: StoredBytesIntegrity;
    }
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

  // ET-SEC-03 (Invariant D) — CURRENT authority before any byte leaves: the
  // canonical workspace decision for this exact download capability (ACTIVE
  // membership, role, access expiry, organization lifecycle). An expired
  // member or a member of a suspended organization is refused here even if a
  // TeamMember row still says ACTIVE.
  if (teamId) {
    const access = await resolveEvidenceRecordAccess({
      userId: actorUserId,
      evidenceId: evidenceForGate.id,
      permission: DOWNLOAD_PERMISSION[kind],
    });
    if (!access.allowed) {
      return denied(
        teamId,
        403,
        {
          code: "ACCESS_DENIED",
          reason: access.internalReason,
          message: SUBJECT[kind] + " is not available to you in this workspace.",
        },
        { action, reason: access.internalReason },
      );
    }
  }

  if (kind === "redaction") {
    const capability = teamId
      ? await assertRedactionCapability({
          userId: actorUserId,
          teamId,
          capability: "redaction.derivative.download",
        })
      : ({ ok: false } as const);
    if (!capability.ok) {
      return denied(
        teamId,
        403,
        {
          code: "DERIVATIVE_DOWNLOAD_NOT_PERMITTED",
          reason: "redaction_derivative_download_capability_required",
          message:
            "Redacted derivative download requires the derivative-download capability in this workspace; read access to the record does not include it.",
        },
        { action, reason: "redaction_derivative_download_capability_required" },
      );
    }
  }

  const sensitiveAction = SENSITIVE_ACTION[kind];
  const { enforceSensitiveAction } = await import("../governance.service.js");
  const membership = teamId
    ? await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: actorUserId } },
        select: { role: true, status: true },
      })
    : null;
  const decision = sensitiveAction === null ? ({ allowed: true } as const) : await enforceSensitiveAction(sensitiveAction, {
    teamId,
    role: membership?.status === "ACTIVE" ? membership.role : undefined,
    evidence: {
      id: evidenceForGate.id,
      teamId,
      retentionUntilUtc: evidenceForGate.retentionUntilUtc ?? null,
    },
    // The original route never opted into the template overlay; unchanged.
    // Derived material follows the original it was rendered from.
    consultTemplatePolicy: kind !== "original" && kind !== "derived",
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

  // ET-SM-07 — BEFORE ORIGINAL BYTES LEAVE. The release itself is decided
  // above. What this adds is the integrity commitment: bytes that were not
  // rechecked inside the cadence are about to be handed to someone, so the
  // recheck authority is asked to re-read them now (idempotent; the sweep
  // takes requested records first). The state travels on the decision so a
  // caller can say "last rechecked …" and never imply more. Best-effort: a
  // failed request does not withhold a release that governance allowed.
  if (kind === "original") {
    try {
      const row = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: STORED_BYTES_INTEGRITY_SELECT,
      });
      if (row) {
        const storedBytes = readStoredBytesIntegrity(row);
        if (storedBytes.state !== "verified_current" && storedBytes.state !== "failed") {
          await requestIntegrityRecheck(prisma, evidenceId);
        }
        return { allowed: true, teamId, storedBytes };
      }
    } catch {
      // The release decision stands; the scheduled recheck still reaches it.
    }
  }

  return { allowed: true, teamId };
}

/**
 * ORIGINAL BYTES RELEASED (ET-CUS-07, 2026-09-29).
 *
 * Every response that hands out a presigned URL to an ORIGINAL object is an
 * access fact and belongs on the record's custody chain. Only /original wrote
 * one — as EVIDENCE_VIEWED — so part listings, record views and Public Verify
 * released original bytes with no trace, and EVIDENCE_DOWNLOADED was never
 * emitted.
 *
 *   original, parts_listing          an explicit download request
 *                                    -> EVIDENCE_DOWNLOADED
 *   record_view, review_workspace,   a view that included original URLs
 *   completion                       -> EVIDENCE_VIEWED (accessMode original_url_issued)
 *   public_verify                    an anonymous public page that included them
 *                                    -> VERIFY_VIEWED (never retention activity, ET-CUS-10)
 *
 * The response is not blocked by a failed append (the URLs are already
 * minted), but the failure is observable.
 */
export type OriginalReleaseChannel =
  | "original"
  | "parts_listing"
  | "record_view"
  | "review_workspace"
  | "completion"
  | "public_verify";

export async function recordOriginalRelease(input: {
  evidenceId: string;
  actorUserId: string | null;
  channel: OriginalReleaseChannel;
  originalUrlsIssued: number;
  mimeType?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  if (input.originalUrlsIssued <= 0) return;
  const at = new Date();
  const eventType =
    input.channel === "original" || input.channel === "parts_listing"
      ? prismaPkg.CustodyEventType.EVIDENCE_DOWNLOADED
      : input.channel === "public_verify"
        ? prismaPkg.CustodyEventType.VERIFY_VIEWED
        : prismaPkg.CustodyEventType.EVIDENCE_VIEWED;
  await appendCustodyEvent({
    evidenceId: input.evidenceId,
    eventType,
    atUtc: at,
    payload: {
      artifact: "original",
      channel: input.channel,
      accessMode:
        input.channel === "public_verify"
          ? "public_original_url_issued"
          : input.channel === "original" || input.channel === "parts_listing"
            ? "authenticated_original_download"
            : "original_url_issued",
      originalUrlsIssued: input.originalUrlsIssued,
      accessedByUserId: input.actorUserId,
      mimeType: input.mimeType ?? null,
      accessedAtUtc: at.toISOString(),
    },
    ip: input.ip ?? undefined,
    userAgent: input.userAgent ?? undefined,
  }).catch(noteCustodyFailure);
}
