/**
 * Phase 17 — Contributor session governance.
 *
 * External contributor (intake) sessions are authenticated by an opaque
 * token resolved into a WorkflowIntakeSession row. Phase 17 adds:
 *
 *   - immediate revocation by an operator (revokedReason captured)
 *   - lastSeenAtUtc touch on every authenticated contributor request
 *   - verification helper that BOTH checks expiry/revocation AND emits
 *     a permission_denied SecurityEvent + audit on failure
 *
 * The existing intake-token + intake-session services are NOT touched
 * for token issuance / consent flow — this module ONLY layers
 * governance on top of an already-resolved session id.
 *
 * Privacy: contributor identifiers are workspace-internal. Public
 * verify NEVER touches this module.
 */
import * as prismaPkg from "@prisma/client";
import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
export class ContributorGovernanceError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
/**
 * Operator-initiated immediate revocation. The session row is updated
 * atomically (where status != REVOKED) so concurrent revoke attempts
 * collapse to a single mutation. Both the SecurityEvent and the
 * platform-audit-log entry record who revoked and why.
 */
export async function revokeContributorSession(input, client = defaultPrisma) {
    const existing = await client.workflowIntakeSession.findFirst({
        where: { id: input.intakeSessionId },
        include: { intakeLink: { select: { teamId: true } } },
    });
    if (!existing || existing.intakeLink.teamId !== input.teamId) {
        throw new ContributorGovernanceError("session_not_found");
    }
    if (existing.revokedAtUtc !== null) {
        throw new ContributorGovernanceError("session_already_revoked");
    }
    if (existing.status === prismaPkg.WorkflowIntakeSessionStatus.SUBMITTED ||
        existing.status === prismaPkg.WorkflowIntakeSessionStatus.ABANDONED ||
        existing.status === prismaPkg.WorkflowIntakeSessionStatus.REVOKED) {
        throw new ContributorGovernanceError("session_already_terminal");
    }
    // Atomic flip — only succeeds if the session is still non-revoked.
    const result = await client.workflowIntakeSession.updateMany({
        where: { id: existing.id, revokedAtUtc: null },
        data: {
            status: prismaPkg.WorkflowIntakeSessionStatus.REVOKED,
            revokedAtUtc: new Date(),
            revokedByUserId: input.actorUserId,
            revokedReason: input.reason?.slice(0, 400) ?? null,
        },
    });
    if (result.count === 0) {
        throw new ContributorGovernanceError("session_already_revoked");
    }
    const updated = await client.workflowIntakeSession.findUniqueOrThrow({
        where: { id: existing.id },
    });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "contributor_session_revoked",
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId,
            intakeSessionId: existing.id,
            intakeLinkId: existing.intakeLinkId,
            reason: input.reason ?? null,
        },
    }, client);
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "identity.contributor_session.revoke",
        category: "identity.governance",
        severity: "info",
        source: "identity_service",
        outcome: "success",
        resourceType: "workflow_intake_session",
        resourceId: existing.id,
        metadata: {
            teamId: input.teamId,
            intakeLinkId: existing.intakeLinkId,
            reason: input.reason ?? null,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return updated;
}
/**
 * Best-effort: touch the lastSeenAtUtc on a contributor session. Called
 * from the intake-session middleware on every successful contributor
 * request. Failures NEVER break the request path.
 */
export async function touchContributorSessionLastSeen(intakeSessionId, client = defaultPrisma) {
    try {
        await client.workflowIntakeSession.updateMany({
            where: { id: intakeSessionId, revokedAtUtc: null },
            data: { lastSeenAtUtc: new Date() },
        });
    }
    catch {
        // best-effort
    }
}
export async function verifyContributorSessionUsable(intakeSessionId, client = defaultPrisma) {
    const row = await client.workflowIntakeSession.findFirst({
        where: { id: intakeSessionId },
        include: { intakeLink: { select: { teamId: true } } },
    });
    if (!row)
        return { ok: false, reason: "not_found" };
    if (row.revokedAtUtc !== null) {
        // Phase 19 — record a CONTRIBUTOR_REVOKED_ATTEMPT risk signal.
        // Best-effort; never breaks the deny path.
        void (async () => {
            try {
                const { recordRiskSignal } = await import("../identity-security/risk.service.js");
                await recordRiskSignal({
                    teamId: row.intakeLink.teamId,
                    subjectKind: "CONTRIBUTOR_SESSION",
                    subjectIntakeSessionId: row.id,
                    signalKind: "CONTRIBUTOR_REVOKED_ATTEMPT",
                    reason: "Contributor session reused after revocation.",
                }, client);
            }
            catch {
                /* best-effort */
            }
        })();
        return { ok: false, reason: "revoked" };
    }
    if (row.expiresAtUtc.getTime() <= Date.now()) {
        return { ok: false, reason: "expired" };
    }
    if (row.status === prismaPkg.WorkflowIntakeSessionStatus.ABANDONED ||
        row.status === prismaPkg.WorkflowIntakeSessionStatus.REVOKED ||
        row.status === prismaPkg.WorkflowIntakeSessionStatus.SUBMITTED) {
        return { ok: false, reason: "terminal" };
    }
    return { ok: true, session: row, teamId: row.intakeLink.teamId };
}
