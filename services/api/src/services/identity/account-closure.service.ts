/**
 * Lifecycle Phase 5 (2026-07-17) — personal account closure execution.
 *
 * ONE canonical processor for the AccountClosureRequest state machine.
 * Routes only create/cancel request rows; execution runs on the existing
 * digest cron via `processAccountClosures` (the same piggyback pattern as
 * data-export generation — no parallel job infrastructure).
 *
 * Execution model (ANONYMIZE + ARCHIVE, never destroy evidence):
 *   1. Re-run the canonical preflight. Any blocker acquired during the
 *      cooling-off window moves the request to BLOCKED — a request that
 *      passed preflight a week ago is NOT trusted at execution time.
 *   2. Atomically claim the row (guarded updateMany → PROCESSING) so two
 *      cron ticks can never double-execute.
 *   3. Revoke every session (RevokedSession ALL_FOR_USER — the JWT
 *      validation source of truth — plus the AuthenticatedSession
 *      inventory mirror).
 *   4. Revoke every login method: identity links → REVOKED, password
 *      hash nulled, provider subject scrambled to `closed:<userId>` so
 *      the OAuth pair can never resolve to this account again.
 *   5. Anonymize PII on the user row (email/name/avatar/bio/country).
 *   6. Cancel outstanding data-export requests and null their payloads.
 *   7. Archive solo implicit personal organizations (status ARCHIVED),
 *      then remove the user's org memberships and set their workspace
 *      memberships to REVOKED.
 *
 * Evidence is NEVER hard-deleted here — retention/legal governance owns
 * evidence destruction, not account lifecycle. Workspace rows, evidence
 * rows, and audit history remain intact under the archived organization.
 */

import { prisma } from "../../db.js";
import { revokeAllSessionsForUser } from "../identity-security/session-revocation.service.js";
import { emitPlatformAudit } from "../audit/tenant-audit.service.js";
import { evaluateAccountClosurePreflight } from "./account-lifecycle-preflight.service.js";
// PROGRAM CONVERGENCE (2026-07-22) — the ONE Organization→ARCHIVED transition.
import { archiveOrganizationStatusTx } from "../organization/org-closure.service.js";
// PHASE 3 (2026-07-22) — canonical membership orchestrator.
import {
  massRevokeWorkspaceMemberships,
  removeAllOrganizationMembershipsForUser,
} from "./membership-provisioning.service.js";

export const COOLING_OFF_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PROCESS_BATCH = 5;

/** Statuses that count as "an open closure request exists". */
export const ACTIVE_CLOSURE_STATUSES = [
  "REQUESTED",
  "COOLING_OFF",
  "SCHEDULED",
  "PROCESSING",
] as const;

/** Statuses the user may still cancel from. */
export const CANCELLABLE_CLOSURE_STATUSES = [
  "REQUESTED",
  "BLOCKED",
  "COOLING_OFF",
  "SCHEDULED",
] as const;

export async function executeAccountClosure(userId: string): Promise<void> {
  const now = new Date();

  // 1. Sessions first — the account must be unreachable before PII is
  // touched. RevokedSession is the JWT-validation source of truth.
  await revokeAllSessionsForUser({ userId, reason: "ACCOUNT_CLOSED" });
  await prisma.authenticatedSession.updateMany({
    where: { userId, revokedAtUtc: null },
    data: {
      revokedAtUtc: now,
      revokedByUserId: userId,
      revokedReason: "ACCOUNT_CLOSED",
    },
  });

  // 2. Login methods + PII + privacy artifacts in one transaction.
  await prisma.$transaction(async (tx) => {
    await tx.userIdentityLink.updateMany({
      where: { userId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAtUtc: now },
    });

    await tx.accountDataExportRequest.updateMany({
      where: { userId, status: { in: ["REQUESTED", "PROCESSING", "READY"] } },
      data: { status: "CANCELLED", packageJson: null, packageSha256: null },
    });

    // Anonymize the account. The scrambled provider subject keeps the
    // (provider, providerUserId) unique pair satisfied while making it
    // impossible for any future OAuth login to resolve to this row.
    await tx.user.update({
      where: { id: userId },
      data: {
        email: null,
        displayName: null,
        firstName: null,
        lastName: null,
        avatarUrl: null,
        bio: null,
        country: null,
        passwordHash: null,
        providerUserId: `closed:${userId}`,
        currentWorkspaceId: null,
      },
    });

    // Archive solo implicit personal organizations the user owns (no
    // other members — the multi-member case is a preflight blocker).
    const ownerMemberships = await tx.organizationMembership.findMany({
      where: { userId, role: "ORG_OWNER" },
      select: { organizationId: true },
    });
    for (const m of ownerMemberships) {
      const others = await tx.organizationMembership.count({
        where: { organizationId: m.organizationId, userId: { not: userId } },
      });
      if (others === 0) {
        // PROGRAM CONVERGENCE (2026-07-22) — compose the ONE canonical
        // Organization→ARCHIVED transition (org-closure engine) instead of a
        // second inline status write.
        await archiveOrganizationStatusTx(tx, {
          organizationId: m.organizationId,
        });
      }
    }

    // PHASE 3 — canonical orchestrator: account-closure off-board
    // (governance memberships removed with provenance closed; workspace
    // memberships mass-revoked, never erased).
    await removeAllOrganizationMembershipsForUser(tx, { userId });
    await massRevokeWorkspaceMemberships(tx, {
      where: { userId },
      reason: "account closure",
    });
  });
}

/**
 * Cron entrypoint — executes due closure requests. Called from the digest
 * scheduler tick; every failure is isolated to the single request row.
 */
export async function processAccountClosures(now: Date): Promise<void> {
  const due = await prisma.accountClosureRequest.findMany({
    where: {
      status: { in: ["COOLING_OFF", "SCHEDULED"] },
      coolingOffEndsAtUtc: { lte: now },
    },
    orderBy: { coolingOffEndsAtUtc: "asc" },
    take: PROCESS_BATCH,
    select: { id: true, userId: true, status: true },
  });

  for (const req of due) {
    // Execution-time preflight — a blocker acquired during cooling-off
    // stops execution cold.
    const { blockers } = await evaluateAccountClosurePreflight(req.userId);
    if (blockers.length > 0) {
      await prisma.accountClosureRequest.updateMany({
        where: { id: req.id, status: req.status },
        data: { status: "BLOCKED", blockersJson: JSON.stringify(blockers) },
      });
      await emitPlatformAudit({
        action: "identity.account_closure_blocked",
        outcome: "denied",
        denialReason: "closure_blocked",
        sourceApp: "API",
        actorUserId: req.userId,
        serviceActor: "account_closure_worker",
        resourceType: "account_closure_request",
        resourceId: req.id,
        metadata: { blockers: blockers.map((b) => b.code) },
      });
      continue;
    }

    const claimed = await prisma.accountClosureRequest.updateMany({
      where: { id: req.id, status: req.status },
      data: { status: "PROCESSING", startedAtUtc: now },
    });
    if (claimed.count === 0) continue;

    try {
      await executeAccountClosure(req.userId);
      await prisma.accountClosureRequest.update({
        where: { id: req.id },
        data: { status: "COMPLETED", completedAtUtc: new Date() },
      });
      await emitPlatformAudit({
        action: "identity.account_closure_completed",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.userId,
        serviceActor: "account_closure_worker",
        resourceType: "account_closure_request",
        resourceId: req.id,
        metadata: {},
      });
    } catch {
      await prisma.accountClosureRequest
        .update({
          where: { id: req.id },
          data: { status: "FAILED", failureCode: "closure_failed" },
        })
        .catch(() => null);
      await emitPlatformAudit({
        action: "identity.account_closure_failed",
        outcome: "error",
        sourceApp: "API",
        actorUserId: req.userId,
        serviceActor: "account_closure_worker",
        resourceType: "account_closure_request",
        resourceId: req.id,
        metadata: { failureCode: "closure_failed" },
      }).catch(() => null);
    }
  }
}
