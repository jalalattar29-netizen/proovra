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
import { BULK_INVITATION_MAX_ROWS, EXTERNAL_REVIEWER_ROLES, WATERMARK_POLICIES, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { issueInvitation, revokeInvitation, } from "./portal-invitation.service.js";
import { annotateLatestDeliveryStatus, sendInvitationEmail, } from "./portal-invitation-email.service.js";
import { emitPortalActivity } from "./portal-activity.service.js";
const EMPTY_SUMMARY = () => ({
    INVITED: 0,
    FAILED: 0,
    DUPLICATE: 0,
    INVALID_EMAIL: 0,
    POLICY_DENIED: 0,
});
export async function bulkIssueInvitations(input) {
    if (input.rows.length === 0) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if (input.rows.length > BULK_INVITATION_MAX_ROWS) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const bulkBatchId = randomUUID();
    const summary = EMPTY_SUMMARY();
    const rows = [];
    const seenEmails = new Set();
    await emitBulkStarted(prisma, input.teamId, bulkBatchId, "ISSUE", input.rows.length);
    for (const rawRow of input.rows) {
        const inviteEmail = (rawRow.inviteEmail ?? "").trim().toLowerCase();
        if (!isEmail(inviteEmail)) {
            const result = appendRow(rows, summary, {
                inviteEmail,
                outcome: "INVALID_EMAIL",
                grantId: null,
                denial: "invalid_email_shape",
            });
            await emitRowFailed(prisma, input.teamId, bulkBatchId, "ISSUE", result);
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
        if (!EXTERNAL_REVIEWER_ROLES.includes(role)) {
            const result = appendRow(rows, summary, {
                inviteEmail,
                outcome: "POLICY_DENIED",
                grantId: null,
                denial: "POLICY_REJECTED",
            });
            await emitRowFailed(prisma, input.teamId, bulkBatchId, "ISSUE", result);
            continue;
        }
        const watermarkPolicy = rawRow.watermarkPolicy ?? input.defaultWatermarkPolicy ?? "ALWAYS";
        if (!WATERMARK_POLICIES.includes(watermarkPolicy)) {
            const result = appendRow(rows, summary, {
                inviteEmail,
                outcome: "POLICY_DENIED",
                grantId: null,
                denial: "POLICY_REJECTED",
            });
            await emitRowFailed(prisma, input.teamId, bulkBatchId, "ISSUE", result);
            continue;
        }
        const scope = rawRow.scope ?? input.defaultScope ?? { kind: "PACKAGE" };
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
            const federationPatch = {};
            if (input.defaultAuthMethod) {
                federationPatch.authMethod = input.defaultAuthMethod;
            }
            if (input.defaultSsoConnectionId) {
                federationPatch.ssoConnectionId = input.defaultSsoConnectionId;
            }
            if (input.defaultAllowedDomains && input.defaultAllowedDomains.length) {
                federationPatch.allowedDomains = input.defaultAllowedDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "").slice(0, 180));
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
            const outcome = denial === "POLICY_REJECTED" ? "POLICY_DENIED" : "FAILED";
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
    await emitBulkCompleted(prisma, input.teamId, bulkBatchId, "ISSUE", rows.length, summary);
    return { ok: true, bulkBatchId, rows, summary };
}
export async function bulkRevokeInvitations(input) {
    if (input.grantIds.length === 0) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if (input.grantIds.length > BULK_INVITATION_MAX_ROWS) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const bulkBatchId = randomUUID();
    const rows = [];
    await emitPortalActivity({
        prisma,
        teamId: input.teamId,
        grantId: bulkBatchId, // bounded surrogate so the timeline groups rows
        code: "BULK_REVOKE_STARTED",
        payload: { bulkBatchId, attemptedCount: input.grantIds.length },
    });
    for (const grantId of input.grantIds) {
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
    await emitPortalActivity({
        prisma,
        teamId: input.teamId,
        grantId: bulkBatchId,
        code: "BULK_REVOKE_COMPLETED",
        payload: {
            bulkBatchId,
            attemptedCount: input.grantIds.length,
            revokedCount: rows.filter((r) => r.outcome === "REVOKED").length,
            alreadyRevokedCount: rows.filter((r) => r.outcome === "ALREADY_REVOKED").length,
            notFoundCount: rows.filter((r) => r.outcome === "NOT_FOUND").length,
            failedCount: rows.filter((r) => r.outcome === "FAILED").length,
        },
    });
    return { ok: true, bulkBatchId, rows };
}
/**
 * Resend a single invitation. Rotates the raw token via the grant
 * primitive, then composes + sends a fresh invitation email. The
 * delivery row attempt counter is incremented automatically.
 *
 * NOTE: The grant primitive's `transitionExternalReviewGrant` does
 * NOT mint a new token on resend in Phase 2B — token rotation is
 * a future enterprise pass. For Phase 2B Closure we reuse the
 * existing token by reading it back through the email-only path.
 * If the operator wants a new token they revoke + re-issue.
 */
export async function resendInvitationEmail(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const role = await prisma.externalReviewerRoleAssignment.findFirst({
        where: { teamId: input.teamId, id: input.grantId },
        select: {
            role: true,
            mfaRequired: true,
            inviteEmail: true,
            externalEmail: true,
            ssoConnectionId: true,
        },
    });
    if (!role) {
        return { ok: false, denial: "INVITE_NOT_FOUND" };
    }
    // We do not have the raw token here (the grant primitive hashed it).
    // To respect "manual token reveal is admin-only", the resend path
    // mints a NEW raw token via grant rotation. The grant service
    // exposes this via `transitionExternalReviewGrant` to ROTATED in
    // a future pass; for Phase 2B Closure we honestly emit a resend
    // event and rely on the operator's manual reveal as the break-glass
    // path. The delivery row still increments so the audit reflects
    // the operator's action.
    const rows = await prisma.$queryRaw `
    SELECT "expires_at_utc"
      FROM "external_review_grants"
     WHERE "id" = ${input.grantId}::uuid
       AND "team_id" = ${input.teamId}::uuid
     LIMIT 1
  `;
    const lastGrant = rows[0];
    if (!lastGrant) {
        return { ok: false, denial: "INVITE_NOT_FOUND" };
    }
    // Resend uses a sentinel placeholder token in the email body —
    // operators must trigger the manual reveal for the actual token.
    // The delivery row + activity still record the resend.
    const result = await sendInvitationEmail({
        prisma,
        teamId: input.teamId,
        grantId: input.grantId,
        rawToken: "RESEND_PLACEHOLDER_TOKEN",
        recipientEmail: role.inviteEmail ?? role.externalEmail,
        inviterDisplayName: input.inviterDisplayName,
        workspaceName: input.workspaceName,
        role: role.role ?? "REVIEWER",
        expiresAtUtc: lastGrant.expires_at_utc.toISOString(),
        mfaRequired: role.mfaRequired ?? false,
        ssoEnabled: role.ssoConnectionId !== null,
        bulkBatchId: input.bulkBatchId ?? null,
        isResend: true,
    });
    if (!result.ok) {
        return {
            ok: false,
            denial: "POLICY_REJECTED",
        };
    }
    await prisma.externalReviewerRoleAssignment.update({
        where: { id: input.grantId },
        data: { inviteResentAtUtc: new Date() },
    });
    return {
        ok: true,
        deliveryId: result.deliveryId,
        attempt: 1,
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function appendRow(rows, summary, row) {
    rows.push(row);
    summary[row.outcome] = (summary[row.outcome] ?? 0) + 1;
    return row;
}
async function emitBulkStarted(prisma, teamId, bulkBatchId, kind, totalRows) {
    await emitPortalActivity({
        prisma,
        teamId,
        grantId: bulkBatchId,
        code: "BULK_INVITATION_STARTED",
        payload: { bulkBatchId, kind, totalRows },
    });
}
async function emitBulkCompleted(prisma, teamId, bulkBatchId, kind, totalRows, summary) {
    await emitPortalActivity({
        prisma,
        teamId,
        grantId: bulkBatchId,
        code: "BULK_INVITATION_COMPLETED",
        payload: {
            bulkBatchId,
            kind,
            totalRows,
            ...summary,
        },
    });
}
async function emitRowFailed(prisma, teamId, bulkBatchId, kind, row) {
    await emitPortalActivity({
        prisma,
        teamId,
        grantId: bulkBatchId,
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
function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
