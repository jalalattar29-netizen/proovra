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

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

export type ContributorGovernanceErrorCode =
  | "session_not_found"
  | "session_already_revoked"
  | "session_already_terminal";

export class ContributorGovernanceError extends Error {
  readonly code: ContributorGovernanceErrorCode;
  constructor(code: ContributorGovernanceErrorCode) {
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
export async function revokeContributorSession(
  input: {
    teamId: string;
    intakeSessionId: string;
    actorUserId: string;
    reason?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.WorkflowIntakeSession> {
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
  if (
    existing.status === prismaPkg.WorkflowIntakeSessionStatus.SUBMITTED ||
    existing.status === prismaPkg.WorkflowIntakeSessionStatus.ABANDONED ||
    existing.status === prismaPkg.WorkflowIntakeSessionStatus.REVOKED
  ) {
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
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "contributor_session_revoked",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        intakeSessionId: existing.id,
        intakeLinkId: existing.intakeLinkId,
        reason: input.reason ?? null,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity.contributor_session.revoke",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "workflow_intake_session",
    resourceId: existing.id,
    metadata: {
      intakeLinkId: existing.intakeLinkId,
      reason: input.reason ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, client);
  return updated;
}

/**
 * Best-effort: touch the lastSeenAtUtc on a contributor session. Called
 * from the intake-session middleware on every successful contributor
 * request. Failures NEVER break the request path.
 */
export async function touchContributorSessionLastSeen(
  intakeSessionId: string,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await client.workflowIntakeSession.updateMany({
      where: { id: intakeSessionId, revokedAtUtc: null },
      data: { lastSeenAtUtc: new Date() },
    });
  } catch {
    // best-effort
  }
}

/**
 * Verify an already-resolved contributor session is still usable.
 * Returns the row on success or a structured failure reason. Caller
 * MUST treat any non-ok result as a hard deny.
 */
export type ContributorSessionVerifyResult =
  | { ok: true; session: prismaPkg.WorkflowIntakeSession; teamId: string }
  | { ok: false; reason: "not_found" | "revoked" | "expired" | "terminal" };

export async function verifyContributorSessionUsable(
  intakeSessionId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ContributorSessionVerifyResult> {
  const row = await client.workflowIntakeSession.findFirst({
    where: { id: intakeSessionId },
    include: { intakeLink: { select: { teamId: true } } },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.revokedAtUtc !== null) {
    // Phase 19 — record a CONTRIBUTOR_REVOKED_ATTEMPT risk signal.
    // Best-effort; never breaks the deny path.
    void (async () => {
      try {
        const { recordRiskSignal } = await import(
          "../identity-security/risk.service.js"
        );
        await recordRiskSignal(
          {
            teamId: row.intakeLink.teamId,
            subjectKind: "CONTRIBUTOR_SESSION",
            subjectIntakeSessionId: row.id,
            signalKind: "CONTRIBUTOR_REVOKED_ATTEMPT",
            reason: "Contributor session reused after revocation.",
          },
          client,
        );
      } catch {
        /* best-effort */
      }
    })();
    return { ok: false, reason: "revoked" };
  }
  if (row.expiresAtUtc.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (
    row.status === prismaPkg.WorkflowIntakeSessionStatus.ABANDONED ||
    row.status === prismaPkg.WorkflowIntakeSessionStatus.REVOKED ||
    row.status === prismaPkg.WorkflowIntakeSessionStatus.SUBMITTED
  ) {
    return { ok: false, reason: "terminal" };
  }
  return { ok: true, session: row, teamId: row.intakeLink.teamId };
}
