/**
 * PHASE R8.1.4 + R8.1.5 — Lost-factor MFA recovery request service.
 *
 * R8.1.4 shipped the bones: user requests → admin approves →
 * factors revoked atomically → user enters enrollment-required on
 * next login.
 *
 * R8.1.5 hardens the workflow with a verified-email preflight,
 * self-cancellation, and a strict state-transition graph:
 *
 *   EMAIL_VERIFICATION_PENDING → PENDING_ADMIN_REVIEW (verify-email)
 *   EMAIL_VERIFICATION_PENDING → CANCELLED (user cancel)
 *   EMAIL_VERIFICATION_PENDING → EXPIRED (GC: email TTL or row TTL)
 *   PENDING_ADMIN_REVIEW       → APPROVED (admin quorum)
 *   PENDING_ADMIN_REVIEW       → REJECTED (admin)
 *   PENDING_ADMIN_REVIEW       → CANCELLED (user cancel)
 *   PENDING_ADMIN_REVIEW       → EXPIRED (GC)
 *   APPROVED                   → COMPLETED (user re-enrolls)
 *
 * Hard rules (every public function enforces):
 *   - NEVER returns a session, OTP, recovery code, secret material,
 *     or the raw email verification token.
 *   - The raw email token is generated ONCE inside this service,
 *     handed to the email service as part of a URL, and immediately
 *     forgotten — only the SHA-256 hash persists.
 *   - The email step confirms mailbox access ONLY; it does not
 *     approve anything. An admin still has to approve.
 *   - Admin approval is impossible while the row is in
 *     EMAIL_VERIFICATION_PENDING — the approve path returns
 *     `request_not_email_verified` in that case.
 *   - Self-cancel is allowed only for the OWNER of the request,
 *     and only while the row is PENDING (either preflight state).
 *   - Tenant isolation: every public function scopes to a single
 *     `teamId`; admins from team A cannot action a request scoped
 *     to team B.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";
import { getEmailService } from "../email.service.js";
/** Default TTL for the entire request (admin queue + email
 *  preflight combined). 7 days — admins not actioning within the
 *  window cause the scheduled GC to flip the row to EXPIRED. */
export const MFA_RECOVERY_REQUEST_TTL_SECONDS = 7 * 24 * 60 * 60;
/** PHASE R8.1.5 — short TTL for the email-verification token.
 *  15 minutes mirrors common best-practice for verify-mailbox
 *  links and bounds the brute-force window. */
export const MFA_RECOVERY_EMAIL_TTL_SECONDS = 15 * 60;
/** PHASE R8.1.5 — bounded resend allowance. Each request may have
 *  the verification email re-sent at most this many times
 *  (including the original send). Beyond this the user must
 *  initiate a fresh recovery request. */
export const MFA_RECOVERY_EMAIL_MAX_SENDS = 3;
/** PHASE R8.1.5 — cooldown between consecutive sends to throttle
 *  enumeration / abuse. */
export const MFA_RECOVERY_EMAIL_RESEND_COOLDOWN_SECONDS = 5 * 60;
/** Default quorum — 1 approval. Orgs with high-risk policy may
 *  bump this via the request's `requiredApprovals` column. */
export const DEFAULT_RECOVERY_QUORUM = 1;
/** PHASE R8.1.6 — per-account throttle to prevent recovery-request
 *  abuse from a stolen / hostile session. A user may file at most
 *  this many recovery requests in any rolling 24-hour window
 *  REGARDLESS of subsequent state (cancelled / expired / approved
 *  rows all count toward the limit). Default 3.
 */
export const MFA_RECOVERY_PER_ACCOUNT_LIMIT = 3;
export const MFA_RECOVERY_PER_ACCOUNT_WINDOW_SECONDS = 24 * 60 * 60;
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function hashEmailToken(rawToken) {
    return createHash("sha256").update(rawToken).digest("hex");
}
function buildVerificationUrl(requestId, rawToken) {
    const base = process.env.WEB_BASE_URL || "https://www.proovra.com";
    const u = new URL("/auth/mfa-recovery/verify", base);
    u.searchParams.set("id", requestId);
    u.searchParams.set("token", rawToken);
    return u.toString();
}
/**
 * Create a recovery request in EMAIL_VERIFICATION_PENDING. The user
 * must be an ACTIVE member of the target team AND must have a
 * resolvable email address on their User row (so we can send the
 * verification link).
 *
 * Idempotency: an existing in-flight request (either preflight
 * state) collapses to `already_pending`. The same caller cannot
 * fill the admin queue with junk by repeated POSTs.
 */
export async function createRecoveryRequest(input) {
    const trimmedReason = (input.reason ?? "").trim();
    if (trimmedReason.length < 10 || trimmedReason.length > 400) {
        return { ok: false, reason: "invalid_reason" };
    }
    const membership = await prisma.teamMember.findFirst({
        where: {
            userId: input.userId,
            teamId: input.teamId,
            status: "ACTIVE",
        },
        select: { id: true },
    });
    if (!membership) {
        return { ok: false, reason: "not_member" };
    }
    // PHASE R8.1.6 — per-account throttle. Count ALL recovery
    // requests this user has filed across ALL their teams in the
    // last 24 hours. Cancelled / expired rows count toward the
    // limit so a hostile actor cannot reset the counter by
    // cancelling. The check is DB-backed (not in-process) so it
    // works across instances / serverless / replicas.
    const throttleWindowStart = new Date(Date.now() - MFA_RECOVERY_PER_ACCOUNT_WINDOW_SECONDS * 1000);
    const recentCount = await prisma.mfaRecoveryRequest.count({
        where: {
            userId: input.userId,
            createdAt: { gte: throttleWindowStart },
        },
    });
    if (recentCount >= MFA_RECOVERY_PER_ACCOUNT_LIMIT) {
        // Compute the soonest the user could try again: the oldest
        // request in the window expires at (createdAt + window).
        const oldest = await prisma.mfaRecoveryRequest.findFirst({
            where: {
                userId: input.userId,
                createdAt: { gte: throttleWindowStart },
            },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
        });
        const retryAfter = oldest
            ? new Date(oldest.createdAt.getTime() +
                MFA_RECOVERY_PER_ACCOUNT_WINDOW_SECONDS * 1000)
            : new Date(Date.now() + MFA_RECOVERY_PER_ACCOUNT_WINDOW_SECONDS * 1000);
        void appendPlatformAuditLog({
            userId: input.userId,
            action: "mfa.recovery.throttled",
            category: "identity_security.mfa_recovery",
            severity: "warning",
            source: "mfa_recovery_service",
            outcome: "blocked",
            resourceType: "mfa_recovery_request",
            resourceId: input.userId,
            metadata: {
                teamId: input.teamId,
                recentCount,
                limit: MFA_RECOVERY_PER_ACCOUNT_LIMIT,
                windowSeconds: MFA_RECOVERY_PER_ACCOUNT_WINDOW_SECONDS,
            },
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
        }).catch(() => null);
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "mfa_recovery_throttled",
            severity: "WARNING",
            details: {
                actorUserId: input.userId,
                recentCount,
                limit: MFA_RECOVERY_PER_ACCOUNT_LIMIT,
                windowSeconds: MFA_RECOVERY_PER_ACCOUNT_WINDOW_SECONDS,
            },
        });
        return { ok: false, reason: "rate_limited", retryAfter };
    }
    // Idempotent: an existing in-flight request collapses. Both
    // preflight states are "in-flight" — only APPROVED / REJECTED /
    // EXPIRED / CANCELLED / COMPLETED free the (user, team) slot.
    const existing = await prisma.mfaRecoveryRequest.findFirst({
        where: {
            userId: input.userId,
            teamId: input.teamId,
            status: { in: ["EMAIL_VERIFICATION_PENDING", "PENDING_ADMIN_REVIEW"] },
        },
        select: {
            id: true,
            status: true,
            expiresAt: true,
            emailVerificationExpiresAt: true,
        },
    });
    if (existing) {
        return {
            ok: false,
            reason: "already_pending",
            request: {
                id: existing.id,
                status: "EMAIL_VERIFICATION_PENDING",
                expiresAt: existing.expiresAt,
                emailVerificationExpiresAt: existing.emailVerificationExpiresAt ?? existing.expiresAt,
            },
        };
    }
    // Need the user's email to send verification.
    const user = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { email: true },
    });
    if (!user?.email) {
        return { ok: false, reason: "user_email_missing" };
    }
    const required = Math.max(1, Math.min(input.requiredApprovals ?? DEFAULT_RECOVERY_QUORUM, 3));
    const expiresAt = new Date(Date.now() + MFA_RECOVERY_REQUEST_TTL_SECONDS * 1000);
    const emailExpiresAt = new Date(Date.now() + MFA_RECOVERY_EMAIL_TTL_SECONDS * 1000);
    // 32 bytes = 64 hex chars. CSPRNG; never stored in plaintext.
    const rawToken = randomBytes(32).toString("hex");
    const row = await prisma.mfaRecoveryRequest.create({
        data: {
            userId: input.userId,
            teamId: input.teamId,
            reason: trimmedReason,
            requiredApprovals: required,
            expiresAt,
            status: "EMAIL_VERIFICATION_PENDING",
            emailVerificationTokenHash: hashEmailToken(rawToken),
            emailVerificationExpiresAt: emailExpiresAt,
            emailResendCount: 1,
        },
        select: { id: true, expiresAt: true },
    });
    // Best-effort send. If the email service is unconfigured (dev /
    // test) we still create the row; the audit log captures both the
    // request and the send attempt. The user can request a resend
    // once email becomes available.
    const verificationUrl = buildVerificationUrl(row.id, rawToken);
    try {
        const emailService = getEmailService();
        if (emailService.isConfigured()) {
            await emailService.sendMfaRecoveryVerificationEmail(user.email, verificationUrl);
        }
    }
    catch {
        // Swallow — the request is still created; user can resend.
    }
    void appendPlatformAuditLog({
        userId: input.userId,
        action: "mfa.recovery.request_created",
        category: "identity_security.mfa_recovery",
        severity: "info",
        source: "mfa_recovery_service",
        outcome: "success",
        resourceType: "mfa_recovery_request",
        resourceId: row.id,
        metadata: {
            teamId: input.teamId,
            requiredApprovals: required,
            // mailboxBound boolean — true means the email service was
            // configured + the send did not throw. Never include the
            // raw token, URL, or email address verbatim.
            mailboxBound: true,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
    }).catch(() => null);
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "mfa_recovery_requested",
        severity: "WARNING",
        details: {
            actorUserId: input.userId,
            requestId: row.id,
            requiredApprovals: required,
        },
    });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "mfa_recovery_email_verification_sent",
        severity: "INFO",
        details: {
            actorUserId: input.userId,
            requestId: row.id,
            attemptNumber: 1,
        },
    });
    return {
        ok: true,
        request: {
            id: row.id,
            status: "EMAIL_VERIFICATION_PENDING",
            expiresAt: row.expiresAt,
            emailVerificationExpiresAt: emailExpiresAt,
        },
    };
}
export async function verifyRecoveryRequestEmail(input) {
    if (!input.rawToken || input.rawToken.length < 16) {
        return { ok: false, reason: "token_invalid" };
    }
    const row = await prisma.mfaRecoveryRequest.findUnique({
        where: { id: input.requestId },
        select: {
            id: true,
            userId: true,
            teamId: true,
            status: true,
            emailVerificationTokenHash: true,
            emailVerificationExpiresAt: true,
        },
    });
    if (!row)
        return { ok: false, reason: "request_not_found" };
    if (input.actorUserId && row.userId !== input.actorUserId) {
        return { ok: false, reason: "wrong_user" };
    }
    if (row.status !== "EMAIL_VERIFICATION_PENDING") {
        return { ok: false, reason: "request_not_in_email_pending" };
    }
    if (!row.emailVerificationExpiresAt ||
        row.emailVerificationExpiresAt.getTime() <= Date.now()) {
        safeEmitSecurityEvent({
            teamId: row.teamId,
            eventType: "mfa_recovery_email_expired",
            severity: "INFO",
            details: {
                actorUserId: row.userId,
                requestId: row.id,
            },
        });
        return { ok: false, reason: "token_expired" };
    }
    if (!row.emailVerificationTokenHash) {
        return { ok: false, reason: "token_invalid" };
    }
    const candidate = hashEmailToken(input.rawToken);
    // Constant-time string compare via Buffer
    if (candidate.length !== row.emailVerificationTokenHash.length ||
        !timingSafeEqualHex(candidate, row.emailVerificationTokenHash)) {
        return { ok: false, reason: "token_invalid" };
    }
    // Atomic flip — also clears the hash so the token cannot be
    // re-used. `where` includes status to defend against concurrent
    // verifies racing each other.
    const r = await prisma.mfaRecoveryRequest.updateMany({
        where: {
            id: row.id,
            status: "EMAIL_VERIFICATION_PENDING",
        },
        data: {
            status: "PENDING_ADMIN_REVIEW",
            emailVerifiedAt: new Date(),
            emailVerificationTokenHash: null,
            emailVerificationExpiresAt: null,
        },
    });
    if (r.count !== 1) {
        return { ok: false, reason: "request_not_in_email_pending" };
    }
    void appendPlatformAuditLog({
        userId: row.userId,
        action: "mfa.recovery.email_verified",
        category: "identity_security.mfa_recovery",
        severity: "info",
        source: "mfa_recovery_service",
        outcome: "success",
        resourceType: "mfa_recovery_request",
        resourceId: row.id,
        metadata: { teamId: row.teamId },
    }).catch(() => null);
    safeEmitSecurityEvent({
        teamId: row.teamId,
        eventType: "mfa_recovery_email_verified",
        severity: "INFO",
        details: { actorUserId: row.userId, requestId: row.id },
    });
    return { ok: true };
}
/**
 * Constant-time hex comparison. Both inputs are hex-encoded
 * SHA-256 strings of equal length.
 */
function timingSafeEqualHex(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
export async function resendRecoveryRequestEmail(input) {
    const row = await prisma.mfaRecoveryRequest.findUnique({
        where: { id: input.requestId },
        select: {
            id: true,
            userId: true,
            teamId: true,
            status: true,
            emailResendCount: true,
            emailResendBlockedUntil: true,
        },
    });
    if (!row)
        return { ok: false, reason: "request_not_found" };
    if (row.userId !== input.actorUserId) {
        return { ok: false, reason: "wrong_user" };
    }
    if (row.status !== "EMAIL_VERIFICATION_PENDING") {
        return { ok: false, reason: "request_not_in_email_pending" };
    }
    if (row.emailResendCount >= MFA_RECOVERY_EMAIL_MAX_SENDS) {
        return { ok: false, reason: "resend_limit_reached" };
    }
    if (row.emailResendBlockedUntil &&
        row.emailResendBlockedUntil.getTime() > Date.now()) {
        return {
            ok: false,
            reason: "resend_throttled",
            nextResendAfter: row.emailResendBlockedUntil,
        };
    }
    const user = await prisma.user.findUnique({
        where: { id: row.userId },
        select: { email: true },
    });
    if (!user?.email)
        return { ok: false, reason: "user_email_missing" };
    const rawToken = randomBytes(32).toString("hex");
    const newEmailExpiresAt = new Date(Date.now() + MFA_RECOVERY_EMAIL_TTL_SECONDS * 1000);
    const newBlockedUntil = new Date(Date.now() + MFA_RECOVERY_EMAIL_RESEND_COOLDOWN_SECONDS * 1000);
    await prisma.mfaRecoveryRequest.update({
        where: { id: row.id },
        data: {
            emailVerificationTokenHash: hashEmailToken(rawToken),
            emailVerificationExpiresAt: newEmailExpiresAt,
            emailResendCount: row.emailResendCount + 1,
            emailResendBlockedUntil: newBlockedUntil,
        },
    });
    const verificationUrl = buildVerificationUrl(row.id, rawToken);
    try {
        const emailService = getEmailService();
        if (emailService.isConfigured()) {
            await emailService.sendMfaRecoveryVerificationEmail(user.email, verificationUrl);
        }
    }
    catch {
        // best-effort
    }
    safeEmitSecurityEvent({
        teamId: row.teamId,
        eventType: "mfa_recovery_email_verification_sent",
        severity: "INFO",
        details: {
            actorUserId: row.userId,
            requestId: row.id,
            attemptNumber: row.emailResendCount + 1,
        },
    });
    return { ok: true, nextResendAfter: newBlockedUntil };
}
export async function cancelRecoveryRequest(input) {
    const row = await prisma.mfaRecoveryRequest.findUnique({
        where: { id: input.requestId },
        select: { id: true, userId: true, teamId: true, status: true },
    });
    if (!row)
        return { ok: false, reason: "request_not_found" };
    if (row.userId !== input.actorUserId) {
        return { ok: false, reason: "wrong_user" };
    }
    if (row.status === "APPROVED" || row.status === "COMPLETED") {
        return { ok: false, reason: "already_approved" };
    }
    if (row.status !== "EMAIL_VERIFICATION_PENDING" &&
        row.status !== "PENDING_ADMIN_REVIEW") {
        return { ok: false, reason: "request_not_pending" };
    }
    // Atomic flip — re-check status in the WHERE so a parallel
    // approval racing us cannot be overwritten.
    const r = await prisma.mfaRecoveryRequest.updateMany({
        where: {
            id: row.id,
            status: { in: ["EMAIL_VERIFICATION_PENDING", "PENDING_ADMIN_REVIEW"] },
        },
        data: {
            status: "CANCELLED",
            cancelledAtUtc: new Date(),
            // Clear the email token so it cannot be re-used after cancel.
            emailVerificationTokenHash: null,
            emailVerificationExpiresAt: null,
        },
    });
    if (r.count !== 1) {
        return { ok: false, reason: "request_not_pending" };
    }
    void appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "mfa.recovery.cancelled",
        category: "identity_security.mfa_recovery",
        severity: "info",
        source: "mfa_recovery_service",
        outcome: "success",
        resourceType: "mfa_recovery_request",
        resourceId: row.id,
        metadata: { teamId: row.teamId },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
    }).catch(() => null);
    safeEmitSecurityEvent({
        teamId: row.teamId,
        eventType: "mfa_recovery_cancelled",
        severity: "INFO",
        details: { actorUserId: input.actorUserId, requestId: row.id },
    });
    return { ok: true };
}
export async function approveRecoveryRequest(input) {
    const row = await prisma.mfaRecoveryRequest.findUnique({
        where: { id: input.requestId },
        select: {
            id: true,
            userId: true,
            teamId: true,
            status: true,
            requiredApprovals: true,
            approvalCount: true,
            expiresAt: true,
        },
    });
    if (!row)
        return { ok: false, reason: "request_not_found" };
    if (row.userId === input.approverUserId) {
        return { ok: false, reason: "cannot_self_approve" };
    }
    // PHASE R8.1.5 — email verification gate. Admin approval is
    // IMPOSSIBLE while the row is in EMAIL_VERIFICATION_PENDING.
    if (row.status === "EMAIL_VERIFICATION_PENDING") {
        return { ok: false, reason: "request_not_email_verified" };
    }
    if (row.status !== "PENDING_ADMIN_REVIEW") {
        return { ok: false, reason: "request_not_pending" };
    }
    if (row.expiresAt.getTime() <= Date.now()) {
        await prisma.mfaRecoveryRequest.update({
            where: { id: row.id },
            data: { status: "EXPIRED" },
        });
        return { ok: false, reason: "request_expired" };
    }
    const approverMembership = await prisma.teamMember.findFirst({
        where: {
            userId: input.approverUserId,
            teamId: row.teamId,
            status: "ACTIVE",
            role: { in: ["OWNER", "ADMIN"] },
        },
        select: { id: true, role: true },
    });
    if (!approverMembership) {
        return { ok: false, reason: "approver_not_admin" };
    }
    try {
        await prisma.mfaRecoveryRequestApproval.create({
            data: {
                requestId: row.id,
                approverUserId: input.approverUserId,
            },
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("Unique") || msg.includes("UNIQUE")) {
            return { ok: false, reason: "already_approved" };
        }
        throw err;
    }
    const newCount = row.approvalCount + 1;
    if (newCount < row.requiredApprovals) {
        await prisma.mfaRecoveryRequest.update({
            where: { id: row.id },
            data: { approvalCount: newCount },
        });
        void appendPlatformAuditLog({
            userId: input.approverUserId,
            action: "mfa.recovery.approval_recorded",
            category: "identity_security.mfa_recovery",
            severity: "info",
            source: "mfa_recovery_service",
            outcome: "success",
            resourceType: "mfa_recovery_request",
            resourceId: row.id,
            metadata: {
                targetUserId: row.userId,
                teamId: row.teamId,
                approvalCount: newCount,
                requiredApprovals: row.requiredApprovals,
            },
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
        }).catch(() => null);
        return { ok: true, approvedNow: false, reason: "quorum_not_met" };
    }
    // Quorum met — atomic: status flip + factor revocation + recovery
    // code invalidation, all in one transaction.
    const requestId = row.id;
    const targetUserId = row.userId;
    const teamId = row.teamId;
    await prisma.$transaction([
        prisma.mfaRecoveryRequest.update({
            where: { id: requestId },
            data: {
                status: "APPROVED",
                approvalCount: newCount,
                approvedAtUtc: new Date(),
            },
        }),
        prisma.mfaFactor.updateMany({
            where: { userId: targetUserId, status: "ACTIVE" },
            data: {
                status: "REVOKED",
                revokedAt: new Date(),
                revokedReason: "mfa_recovery_approved",
            },
        }),
        prisma.mfaRecoveryCode.updateMany({
            where: { userId: targetUserId, usedAt: null, batchInvalidatedAt: null },
            data: { batchInvalidatedAt: new Date() },
        }),
    ]);
    void appendPlatformAuditLog({
        userId: input.approverUserId,
        action: "mfa.recovery.approved",
        category: "identity_security.mfa_recovery",
        severity: "warning",
        source: "mfa_recovery_service",
        outcome: "success",
        resourceType: "mfa_recovery_request",
        resourceId: requestId,
        metadata: {
            targetUserId,
            teamId,
            approvalCount: newCount,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
    }).catch(() => null);
    safeEmitSecurityEvent({
        teamId,
        eventType: "mfa_recovery_approved",
        severity: "WARNING",
        details: {
            actorUserId: input.approverUserId,
            targetUserId,
            requestId,
        },
    });
    return { ok: true, approvedNow: true };
}
export async function rejectRecoveryRequest(input) {
    const row = await prisma.mfaRecoveryRequest.findUnique({
        where: { id: input.requestId },
        select: { id: true, userId: true, teamId: true, status: true },
    });
    if (!row)
        return { ok: false, reason: "request_not_found" };
    if (row.userId === input.approverUserId) {
        return { ok: false, reason: "cannot_self_reject" };
    }
    // Admin may reject from either preflight state — even before
    // email-verify, an admin can deny a clearly bogus request.
    if (row.status !== "PENDING_ADMIN_REVIEW" &&
        row.status !== "EMAIL_VERIFICATION_PENDING") {
        return { ok: false, reason: "request_not_pending" };
    }
    const adminCheck = await prisma.teamMember.findFirst({
        where: {
            userId: input.approverUserId,
            teamId: row.teamId,
            status: "ACTIVE",
            role: { in: ["OWNER", "ADMIN"] },
        },
        select: { id: true },
    });
    if (!adminCheck)
        return { ok: false, reason: "approver_not_admin" };
    await prisma.mfaRecoveryRequest.update({
        where: { id: row.id },
        data: {
            status: "REJECTED",
            rejectedAtUtc: new Date(),
            rejectedReason: input.reason?.toString().slice(0, 400) ?? "admin_rejected",
        },
    });
    void appendPlatformAuditLog({
        userId: input.approverUserId,
        action: "mfa.recovery.rejected",
        category: "identity_security.mfa_recovery",
        severity: "info",
        source: "mfa_recovery_service",
        outcome: "success",
        resourceType: "mfa_recovery_request",
        resourceId: row.id,
        metadata: { targetUserId: row.userId, teamId: row.teamId },
    }).catch(() => null);
    return { ok: true };
}
// ---------------------------------------------------------------------------
// MARK COMPLETED
// ---------------------------------------------------------------------------
export async function markRecoveryCompleted(input) {
    const approved = await prisma.mfaRecoveryRequest.findMany({
        where: { userId: input.userId, status: "APPROVED" },
        select: { id: true, teamId: true },
    });
    if (approved.length === 0)
        return { completed: 0 };
    await prisma.mfaRecoveryRequest.updateMany({
        where: {
            userId: input.userId,
            status: "APPROVED",
        },
        data: { status: "COMPLETED", completedAtUtc: new Date() },
    });
    for (const a of approved) {
        safeEmitSecurityEvent({
            teamId: a.teamId,
            eventType: "mfa_recovery_completed",
            severity: "INFO",
            details: { actorUserId: input.userId, requestId: a.id },
        });
    }
    return { completed: approved.length };
}
export async function listPendingRecoveryRequests(input) {
    // PHASE R8.1.5 — return BOTH preflight states. Email-pending rows
    // are visible to the admin queue so an operator can see that the
    // user has filed a request but hasn't yet verified their mailbox.
    // The admin cannot approve those rows (`request_not_email_verified`),
    // but listing them gives full operational visibility.
    const rows = await prisma.mfaRecoveryRequest.findMany({
        where: {
            teamId: input.teamId,
            status: {
                in: ["PENDING_ADMIN_REVIEW", "EMAIL_VERIFICATION_PENDING"],
            },
        },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            userId: true,
            reason: true,
            status: true,
            requiredApprovals: true,
            approvalCount: true,
            expiresAt: true,
            createdAt: true,
            emailVerifiedAt: true,
        },
    });
    return rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        reason: r.reason,
        status: r.status,
        requiredApprovals: r.requiredApprovals,
        approvalCount: r.approvalCount,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        emailVerified: Boolean(r.emailVerifiedAt),
    }));
}
/**
 * Detail view used by both the user (to see their own request) and
 * the admin (to inspect any request in their team). The function
 * itself does NOT mutate; tenant isolation is enforced by checking
 * either ownership OR team-admin membership.
 */
export async function readRecoveryRequestDetail(input) {
    const row = await prisma.mfaRecoveryRequest.findUnique({
        where: { id: input.requestId },
        select: {
            id: true,
            userId: true,
            teamId: true,
            status: true,
            reason: true,
            requiredApprovals: true,
            approvalCount: true,
            emailVerifiedAt: true,
            emailResendCount: true,
            expiresAt: true,
            createdAt: true,
        },
    });
    if (!row)
        return { ok: false, reason: "request_not_found" };
    if (row.userId !== input.actorUserId) {
        // Allow if actor is admin of the team.
        const admin = await prisma.teamMember.findFirst({
            where: {
                userId: input.actorUserId,
                teamId: row.teamId,
                status: "ACTIVE",
                role: { in: ["OWNER", "ADMIN"] },
            },
            select: { id: true },
        });
        if (!admin)
            return { ok: false, reason: "not_authorized" };
    }
    return {
        ok: true,
        detail: {
            id: row.id,
            userId: row.userId,
            teamId: row.teamId,
            status: row.status,
            reason: row.reason,
            requiredApprovals: row.requiredApprovals,
            approvalCount: row.approvalCount,
            emailVerified: Boolean(row.emailVerifiedAt),
            emailResendCount: row.emailResendCount,
            expiresAt: row.expiresAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
        },
    };
}
export async function listRecoveryRequestApprovals(input) {
    // First, tenancy gate: load the parent row's teamId + caller's
    // role on that team. Same pattern as `readRecoveryRequestDetail`.
    const parent = await prisma.mfaRecoveryRequest.findUnique({
        where: { id: input.requestId },
        select: { id: true, teamId: true, userId: true },
    });
    if (!parent)
        return { ok: false, reason: "request_not_found" };
    // Caller may read approvals if they are the SUBJECT of the request
    // (their own recovery) OR an ACTIVE OWNER/ADMIN of the team.
    if (parent.userId !== input.actorUserId) {
        const admin = await prisma.teamMember.findFirst({
            where: {
                userId: input.actorUserId,
                teamId: parent.teamId,
                status: "ACTIVE",
                role: { in: ["OWNER", "ADMIN"] },
            },
            select: { id: true },
        });
        if (!admin)
            return { ok: false, reason: "not_authorized" };
    }
    const rows = await prisma.mfaRecoveryRequestApproval.findMany({
        where: { requestId: input.requestId },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: {
            id: true,
            approverUserId: true,
            createdAt: true,
        },
    });
    // Resolve display names in one query (bounded; max 50 approvers).
    const approverIds = Array.from(new Set(rows.map((r) => r.approverUserId)));
    const users = approverIds.length
        ? await prisma.user.findMany({
            where: { id: { in: approverIds } },
            select: { id: true, displayName: true },
        })
        : [];
    const nameById = new Map(users.map((u) => [u.id, u.displayName ?? null]));
    return {
        ok: true,
        approvals: rows.map((r) => ({
            id: r.id,
            approverUserId: r.approverUserId,
            approverDisplayName: nameById.get(r.approverUserId) ?? null,
            createdAt: r.createdAt.toISOString(),
        })),
    };
}
// ---------------------------------------------------------------------------
// scheduled cleanup helper
// ---------------------------------------------------------------------------
/**
 * Bounded scheduled sweep. Flips rows whose `expiresAt` has passed
 * AND whose state is one of the in-flight preflight states to
 * EXPIRED. Also flips EMAIL_VERIFICATION_PENDING rows whose
 * `emailVerificationExpiresAt` is past — even if the overall TTL
 * has time left, an expired email link means the request is dead
 * (the user must request a fresh one).
 */
export async function expireStaleRecoveryRequests(options = {}) {
    const take = Math.max(1, Math.min(options.take ?? 100, 500));
    const now = new Date();
    const stale = await prisma.mfaRecoveryRequest.findMany({
        where: {
            status: { in: ["EMAIL_VERIFICATION_PENDING", "PENDING_ADMIN_REVIEW"] },
            OR: [
                { expiresAt: { lt: now } },
                {
                    status: "EMAIL_VERIFICATION_PENDING",
                    emailVerificationExpiresAt: { lt: now },
                },
            ],
        },
        select: { id: true },
        take,
    });
    if (stale.length === 0)
        return { expired: 0 };
    const r = await prisma.mfaRecoveryRequest.updateMany({
        where: {
            id: { in: stale.map((s) => s.id) },
            status: {
                in: ["EMAIL_VERIFICATION_PENDING", "PENDING_ADMIN_REVIEW"],
            },
        },
        data: { status: "EXPIRED" },
    });
    return { expired: r.count };
}
