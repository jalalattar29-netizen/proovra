/**
 * PROOVRA Phase 2B Closure — Bulk invitation orchestrator.
 *
 * Three bounded workflows for the External Review Management Console:
 *
 *   * `bulkIssueInvitations` — issue ≤ BULK_INVITATION_MAX_ROWS
 *     invitations in a single operator action, with per-row outcome
 *     reporting (INVITED / FAILED / DUPLICATE / INVALID_EMAIL /
 *     POLICY_DENIED). A failing row NEVER fails the batch.
 *
 *   * `bulkRevokeInvitations` — revoke a list of grants and stamp
 *     the latest delivery row REVOKED. Per-row outcomes (OK / NOT_FOUND
 *     / ALREADY_REVOKED).
 *
 *   * `bulkResendInvitations` — resend the invitation email for each
 *     row, incrementing the delivery attempt counter. Per-row outcomes
 *     mirror `bulkIssueInvitations`.
 *
 * Hard rules:
 *   * Workspace-anchored at every entry point.
 *   * Bounded ≤ BULK_INVITATION_MAX_ROWS (100). Larger batches
 *     return a bounded denial without partial work.
 *   * NEVER fail the batch on a single row failure.
 *   * Every bulk run emits BULK_INVITATION_STARTED + COMPLETED with
 *     a shared `bulkBatchId` so the operator console can group rows.
 *   * Resend / issue NEVER expose the raw token in the result — it
 *     flows out via the email body, never the API response.
 */

import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  BULK_INVITATION_MAX_ROWS,
  EXTERNAL_REVIEWER_ROLES,
  WATERMARK_POLICIES,
  type BulkInvitationResultRow,
  type BulkInvitationRowOutcome,
  type ExternalPortalDenialReason,
  type ExternalReviewerRole,
  type WatermarkPolicy,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  issueInvitation,
  revokeInvitation,
} from "./portal-invitation.service.js";
import {
  annotateLatestDeliveryStatus,
  sendInvitationEmail,
  deliverInvitationEmail,
} from "./portal-invitation-email.service.js";
import { emitPortalActivity } from "./portal-activity.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export type BulkIssueRowInput = {
  inviteEmail: string;
  displayName?: string;
  organization?: string;
  role?: ExternalReviewerRole;
  watermarkPolicy?: WatermarkPolicy;
  mfaRequired?: boolean;
  scope?: {
    kind: "EVIDENCE" | "CASE" | "PACKAGE";
    evidenceId?: string;
    caseId?: string;
    packageId?: string;
  };
};

export type BulkIssueInvitationsInput = {
  prisma?: PrismaClient;
  teamId: string;
  invitedByUserId: string;
  inviterDisplayName: string;
  workspaceName: string;
  expiresAtUtc: string;
  defaultRole?: ExternalReviewerRole;
  defaultWatermarkPolicy?: WatermarkPolicy;
  defaultMfaRequired?: boolean;
  defaultScope?: {
    kind: "EVIDENCE" | "CASE" | "PACKAGE";
    evidenceId?: string;
    caseId?: string;
    packageId?: string;
  };
  /**
   * Federation defaults applied to every issued grant in this batch:
   *   * `defaultAuthMethod === "SSO"` flips the role assignment so the
   *     portal accept landing offers SSO sign-in by default.
   *   * `defaultSsoConnectionId` binds every grant to that SsoConnection.
   *   * `defaultAllowedDomains` populates the role assignment's bounded
   *     allow-list — empty means "exact email match".
   * These are honest defaults; the SAML callback still does the real
   * identity validation at sign-in time.
   */
  defaultAuthMethod?: "TOKEN" | "SSO";
  defaultSsoConnectionId?: string;
  defaultAllowedDomains?: ReadonlyArray<string>;
  rows: ReadonlyArray<BulkIssueRowInput>;
};

export type BulkIssueInvitationsResult =
  | {
      ok: true;
      bulkBatchId: string;
      rows: BulkInvitationResultRow[];
      summary: BulkOutcomeSummary;
    }
  | { ok: false; denial: ExternalPortalDenialReason };

export type BulkOutcomeSummary = Record<BulkInvitationRowOutcome, number>;

const EMPTY_SUMMARY: () => BulkOutcomeSummary = () => ({
  INVITED: 0,
  FAILED: 0,
  DUPLICATE: 0,
  INVALID_EMAIL: 0,
  POLICY_DENIED: 0,
});

export async function bulkIssueInvitations(
  input: BulkIssueInvitationsInput,
): Promise<BulkIssueInvitationsResult> {
  if (input.rows.length === 0) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.rows.length > BULK_INVITATION_MAX_ROWS) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const bulkBatchId = randomUUID();
  const summary = EMPTY_SUMMARY();
  const rows: BulkInvitationResultRow[] = [];
  const seenEmails = new Set<string>();

  for (const rawRow of input.rows) {
    const inviteEmail = (rawRow.inviteEmail ?? "").trim().toLowerCase();
    if (!isEmail(inviteEmail)) {
      const result = appendRow(rows, summary, {
        inviteEmail,
        outcome: "INVALID_EMAIL",
        grantId: null,
        denial: "invalid_email_shape",
      });
      await emitRowFailed(
        prisma,
        input.teamId,
        bulkBatchId,
        "ISSUE",
        result,
      );
      continue;
    }
    if (seenEmails.has(inviteEmail)) {
      appendRow(rows, summary, {
        inviteEmail,
        outcome: "DUPLICATE",
        grantId: null,
        denial: "duplicate_in_batch",
      });
      continue;
    }
    seenEmails.add(inviteEmail);

    const role = rawRow.role ?? input.defaultRole ?? "EXTERNAL_REVIEWER";
    if (!(EXTERNAL_REVIEWER_ROLES as ReadonlyArray<string>).includes(role)) {
      const result = appendRow(rows, summary, {
        inviteEmail,
        outcome: "POLICY_DENIED",
        grantId: null,
        denial: "POLICY_REJECTED",
      });
      await emitRowFailed(prisma, input.teamId, bulkBatchId, "ISSUE", result);
      continue;
    }
    const watermarkPolicy =
      rawRow.watermarkPolicy ?? input.defaultWatermarkPolicy ?? "ALWAYS";
    if (
      !(WATERMARK_POLICIES as ReadonlyArray<string>).includes(watermarkPolicy)
    ) {
      const result = appendRow(rows, summary, {
        inviteEmail,
        outcome: "POLICY_DENIED",
        grantId: null,
        denial: "POLICY_REJECTED",
      });
      await emitRowFailed(prisma, input.teamId, bulkBatchId, "ISSUE", result);
      continue;
    }

    const scope =
      rawRow.scope ?? input.defaultScope ?? { kind: "PACKAGE" as const };

    const issued = await issueInvitation({
      prisma,
      teamId: input.teamId,
      invitedByUserId: input.invitedByUserId,
      reviewerEmail: inviteEmail,
      reviewerDisplayName: rawRow.displayName,
      organization: rawRow.organization,
      role,
      watermarkPolicy,
      mfaRequired: rawRow.mfaRequired ?? input.defaultMfaRequired ?? false,
      scope,
      expiresAtUtc: input.expiresAtUtc,
    });
    // Apply federation defaults onto the role assignment sidecar so
    // the operator-chosen authMethod / SSO connection / allowed
    // domains are honored from the very first portal hit.
    if (issued.ok) {
      const federationPatch: Record<string, unknown> = {};
      if (input.defaultAuthMethod) {
        federationPatch.authMethod = input.defaultAuthMethod;
      }
      if (input.defaultSsoConnectionId) {
        federationPatch.ssoConnectionId = input.defaultSsoConnectionId;
      }
      if (input.defaultAllowedDomains && input.defaultAllowedDomains.length) {
        federationPatch.allowedDomains = input.defaultAllowedDomains.map((d) =>
          d.trim().toLowerCase().replace(/^@/, "").slice(0, 180),
        );
      }
      if (Object.keys(federationPatch).length > 0) {
        await prisma.externalReviewerRoleAssignment.updateMany({
          where: { teamId: input.teamId, id: issued.grantId },
          data: federationPatch,
        });
      }
    }
    if (!issued.ok) {
      const denial = issued.denial;
      const outcome: BulkInvitationRowOutcome =
        denial === "POLICY_REJECTED" ? "POLICY_DENIED" : "FAILED";
      const result = appendRow(rows, summary, {
        inviteEmail,
        outcome,
        grantId: null,
        denial,
      });
      await emitRowFailed(prisma, input.teamId, bulkBatchId, "ISSUE", result);
      continue;
    }

    // Hand the raw token off to the email service immediately so it
    // never travels back through this function's return value.
    const emailResult = await sendInvitationEmail({
      prisma,
      teamId: input.teamId,
      grantId: issued.grantId,
      rawToken: issued.rawToken,
      recipientEmail: inviteEmail,
      recipientDisplayName: rawRow.displayName ?? null,
      inviterDisplayName: input.inviterDisplayName,
      workspaceName: input.workspaceName,
      role,
      expiresAtUtc: input.expiresAtUtc,
      mfaRequired: rawRow.mfaRequired ?? input.defaultMfaRequired ?? false,
      ssoEnabled: false,
      bulkBatchId,
    });

    if (!emailResult.ok) {
      // Grant exists but delivery failed — record FAILED outcome and
      // expose the bounded denial so the operator can resend manually.
      const result = appendRow(rows, summary, {
        inviteEmail,
        outcome: "FAILED",
        grantId: issued.grantId,
        denial: emailResult.failureReason,
      });
      await emitRowFailed(prisma, input.teamId, bulkBatchId, "ISSUE", result);
      continue;
    }
    appendRow(rows, summary, {
      inviteEmail,
      outcome: "INVITED",
      grantId: issued.grantId,
      denial: null,
    });
  }

  await recordBulkBatchAudit({
    prisma,
    teamId: input.teamId,
    actorUserId: input.invitedByUserId,
    bulkBatchId,
    kind: "ISSUE",
    counts: { totalRows: rows.length, ...summary },
  });

  return { ok: true, bulkBatchId, rows, summary };
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export type BulkRevokeInvitationsInput = {
  prisma?: PrismaClient;
  teamId: string;
  revokedByUserId: string;
  grantIds: ReadonlyArray<string>;
  reason?: string;
};

export type BulkRevokeRowResult = {
  grantId: string;
  outcome: "REVOKED" | "NOT_FOUND" | "ALREADY_REVOKED" | "FAILED";
  denial: string | null;
};

export type BulkRevokeInvitationsResult =
  | {
      ok: true;
      bulkBatchId: string;
      rows: BulkRevokeRowResult[];
    }
  | { ok: false; denial: ExternalPortalDenialReason };

export async function bulkRevokeInvitations(
  input: BulkRevokeInvitationsInput,
): Promise<BulkRevokeInvitationsResult> {
  if (input.grantIds.length === 0) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.grantIds.length > BULK_INVITATION_MAX_ROWS) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const bulkBatchId = randomUUID();
  const rows: BulkRevokeRowResult[] = [];

  /*
   * PV-DEFECT-002 — RESOLVE EVERY ID BEFORE ANY WRITE.
   *
   * This used to write a BULK_REVOKE_STARTED activity row first, keyed by a
   * freshly generated batch id. `external_review_activities.grant_id` is a
   * foreign key to the invitation table, so that id could never resolve: the
   * very first write of EVERY bulk revoke failed with P2003 and the request
   * answered 500 DATABASE_ERROR. An unknown id never even reached its own
   * refusal.
   *
   * Now each id is resolved inside this workspace first. One that does not
   * resolve — nonexistent, or another workspace's; the two are
   * indistinguishable by design — is NOT_FOUND, and one already revoked is
   * ALREADY_REVOKED, both decided before anything is written. The batch
   * itself is recorded once, in the tenant audit, with its true counts.
   * Per-row outcomes are this endpoint's contract, so the batch is not
   * atomic: every row reports what happened to it.
   */
  const uniqueIds = [...new Set(input.grantIds)];
  const known = await prisma.externalReviewGrant.findMany({
    where: { teamId: input.teamId, id: { in: uniqueIds } },
    select: { id: true, state: true },
  });
  const stateOf = new Map(known.map((g) => [g.id, g.state]));

  for (const grantId of uniqueIds) {
    const state = stateOf.get(grantId);
    if (state === undefined) {
      rows.push({ grantId, outcome: "NOT_FOUND", denial: "INVITE_NOT_FOUND" });
      continue;
    }
    if (state === "REVOKED") {
      rows.push({ grantId, outcome: "ALREADY_REVOKED", denial: "INVITE_ALREADY_REVOKED" });
      continue;
    }
    const res = await revokeInvitation({
      prisma,
      teamId: input.teamId,
      grantId,
      revokedByUserId: input.revokedByUserId,
      reason: input.reason,
    });
    if (res.ok) {
      await annotateLatestDeliveryStatus({
        prisma,
        teamId: input.teamId,
        grantId,
        toStatus: "REVOKED",
      });
      rows.push({ grantId, outcome: "REVOKED", denial: null });
      continue;
    }
    if (res.denial === "INVITE_NOT_FOUND") {
      rows.push({ grantId, outcome: "NOT_FOUND", denial: res.denial });
      continue;
    }
    if (res.denial === "INVITE_ALREADY_REVOKED") {
      rows.push({ grantId, outcome: "ALREADY_REVOKED", denial: res.denial });
      continue;
    }
    rows.push({ grantId, outcome: "FAILED", denial: res.denial });
  }

  await recordBulkBatchAudit({
    prisma,
    teamId: input.teamId,
    actorUserId: input.revokedByUserId,
    bulkBatchId,
    kind: "REVOKE",
    counts: {
      attemptedCount: uniqueIds.length,
      revokedCount: rows.filter((r) => r.outcome === "REVOKED").length,
      alreadyRevokedCount: rows.filter((r) => r.outcome === "ALREADY_REVOKED").length,
      notFoundCount: rows.filter((r) => r.outcome === "NOT_FOUND").length,
      failedCount: rows.filter((r) => r.outcome === "FAILED").length,
    },
  });

  return { ok: true, bulkBatchId, rows };
}

/**
 * The batch, recorded once and truthfully, in the tenant audit — the record a
 * batch belongs in. The portal activity log is keyed to ONE invitation; a
 * batch is not an invitation and has no row to key it to.
 *
 * Written after the rows, with the counts that actually happened. Best-effort
 * like the other operator audits: the rows already committed, and failing the
 * request now would report a failure for work that was done.
 */
async function recordBulkBatchAudit(input: {
  prisma: PrismaClient;
  teamId: string;
  actorUserId: string;
  bulkBatchId: string;
  kind: "ISSUE" | "REVOKE";
  counts: Record<string, number>;
}): Promise<void> {
  try {
    await emitTenantAudit(
      {
        action:
          input.kind === "ISSUE"
            ? "external_review.invitations.bulk_issued"
            : "external_review.invitations.bulk_revoked",
        outcome: "success",
        sourceApp: "API",
        actorUserId: input.actorUserId,
        workspaceId: input.teamId,
        resourceType: "external_review_bulk_batch",
        resourceId: input.bulkBatchId,
        metadata: { bulkBatchId: input.bulkBatchId, ...input.counts },
      },
      input.prisma,
    );
  } catch {
    /* append-only audit, best-effort here; the rows already committed */
  }
}

// ---------------------------------------------------------------------------
// Resend (single + bulk)
// ---------------------------------------------------------------------------

export type ResendInvitationInput = {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  /**
   * PHASE 12 REMEDIATION §4.3 — the AUTHORIZED operator. Recorded on the
   * token-rotation security event so the trail names who caused the
   * predecessor token to be superseded. Required: a resend is a credential
   * mutation, never an anonymous one.
   */
  actorUserId: string;
  inviterDisplayName: string;
  workspaceName: string;
  bulkBatchId?: string;
};

/**
 * Resend a single invitation.
 *
 * PHASE 12 REMEDIATION §4.3 (2026-08-06) — this used to mail the literal
 * string `"RESEND_PLACEHOLDER_TOKEN"`. The reviewer received a link that
 * could never authenticate, the delivery row recorded SENT, and the operator
 * was told the resend succeeded. The stated reason — "we do not have the raw
 * token here (the grant primitive hashed it)" — is exactly right, and is
 * exactly why the canonical answer is to MINT A SUCCESSOR rather than to
 * mail a sentinel.
 *
 * It now delegates in full to `deliverInvitationEmail`, the ONE server-owned
 * delivery authority: load -> verify workspace + live state -> mint successor
 * server-side -> persist hash only -> build the URL server-side -> durable
 * delivery intent -> canonical transport -> bounded outcome. Invitation
 * history is preserved; the predecessor token stops working the instant the
 * rotation commits.
 */
export async function resendInvitationEmail(
  input: ResendInvitationInput,
): Promise<
  | {
      ok: true;
      deliveryId: string;
      attempt: number;
    }
  | {
      ok: false;
      denial: ExternalPortalDenialReason;
    }
> {
  const prisma = input.prisma ?? defaultPrisma;

  const result = await deliverInvitationEmail({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    actorUserId: input.actorUserId,
    inviterDisplayName: input.inviterDisplayName,
    workspaceName: input.workspaceName,
    reason: "Operator resent the external-reviewer invitation email.",
    bulkBatchId: input.bulkBatchId ?? null,
    isResend: true,
  });
  if (!result.ok) {
    return { ok: false, denial: result.denial };
  }
  return {
    ok: true,
    deliveryId: result.deliveryId,
    attempt: 1,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendRow(
  rows: BulkInvitationResultRow[],
  summary: BulkOutcomeSummary,
  row: BulkInvitationResultRow,
): BulkInvitationResultRow {
  rows.push(row);
  summary[row.outcome] = (summary[row.outcome] ?? 0) + 1;
  return row;
}

/**
 * A failed row's own timeline entry — only when the row produced a grant.
 *
 * `external_review_activities.grant_id` references the invitation. A row that
 * failed before an invitation existed (a malformed email, a refused policy)
 * has nothing to key an activity row to; writing one under the batch id was a
 * foreign-key violation that failed the whole request. Its outcome is in the
 * batch's audit counts and in the response row. A row whose invitation was
 * created but whose email could not be delivered keeps its entry.
 */
async function emitRowFailed(
  prisma: PrismaClient,
  teamId: string,
  bulkBatchId: string,
  kind: "ISSUE",
  row: BulkInvitationResultRow,
): Promise<void> {
  if (!row.grantId) return;
  await emitPortalActivity({
    prisma,
    teamId,
    grantId: row.grantId,
    code: "BULK_INVITATION_ROW_FAILED",
    payload: {
      bulkBatchId,
      kind,
      inviteEmail: row.inviteEmail,
      outcome: row.outcome,
      denial: row.denial,
    },
  });
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
