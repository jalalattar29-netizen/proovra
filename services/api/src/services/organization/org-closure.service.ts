/**
 * Lifecycle Phase 6 (2026-07-17) — organization closure execution.
 *
 * ONE canonical processor for the OrganizationClosureRequest state
 * machine. Routes only create/cancel request rows (ORG_OWNER-only, typed
 * confirmation + step-up); execution runs on the existing digest cron via
 * `processOrganizationClosures` (the same piggyback pattern as account
 * closure — no parallel job infrastructure).
 *
 * Execution model (ARCHIVE, never destroy evidence):
 *   1. Re-run the canonical preflight — a blocker acquired during the
 *      cooling-off window (a new member, a new legal hold, a re-activated
 *      contract) moves the request to BLOCKED, never to PROCESSING.
 *   2. Atomically claim the row (guarded updateMany → PROCESSING).
 *   3. Archive the organization: status ARCHIVED. `checkOrgAccess`
 *      refuses archived orgs, so every org surface goes dark at once.
 *   4. Revoke workspace memberships on the org's teams (REVOKED, never
 *      erased — actor attribution on evidence/custody stays intact).
 *   5. Revoke machine access on the org's teams: ACTIVE ApiCredentials →
 *      REVOKED, ACTIVE WebhookEndpoints → DISABLED. Credentials never
 *      outlive the organization.
 *   6. Clear currentWorkspaceId pointers into the org's teams (personal
 *      workspace bootstrap recovers those users on next load).
 *
 * Evidence, teams, audit history, and governance records remain intact
 * under the archived organization — retention/legal governance owns
 * evidence destruction, not organization lifecycle.
 */

import { prisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { evaluateOrganizationClosurePreflight } from "../identity/account-lifecycle-preflight.service.js";
import { emitOrgAuditEvent } from "./org-audit.service.js";
// PHASE 3 (2026-07-22) — canonical membership orchestrator.
import { CLOSURE_STALE_MS, closeWorkspacesTx } from "../workspace/workspace-closure.service.js";
import { dispatchEnqueuedEmailNotifications } from "../notifications/index.js";
import { isContractTerminationClosure } from "./enterprise-termination.service.js";
import { transitionEnterpriseContractStatusTx } from "./enterprise-contract.service.js";

export const ORG_CLOSURE_COOLING_OFF_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PROCESS_BATCH = 3;

/** Statuses that count as "an open closure request exists" for the org. */
export const ACTIVE_ORG_CLOSURE_STATUSES = [
  "REQUESTED",
  "COOLING_OFF",
  "SCHEDULED",
  "PROCESSING",
] as const;

/** Statuses the owner may still cancel from. */
export const CANCELLABLE_ORG_CLOSURE_STATUSES = [
  "REQUESTED",
  "BLOCKED",
  "COOLING_OFF",
  "SCHEDULED",
] as const;

/**
 * PROGRAM CONVERGENCE (2026-07-22) — the ONE tx-scoped Organization→ARCHIVED
 * status transition. Both closure engines (org closure below, account closure
 * for solo implicit personal orgs) compose this instead of writing
 * `organization.update({ status: "ARCHIVED" })` themselves, so the archive
 * write has exactly one implementation (enforced by the program architecture
 * registry).
 */
export async function archiveOrganizationStatusTx(
  tx: { organization: { update: (args: { where: { id: string }; data: { status: "ARCHIVED" } }) => Promise<unknown> } },
  input: { organizationId: string },
): Promise<void> {
  await tx.organization.update({
    where: { id: input.organizationId },
    data: { status: "ARCHIVED" },
  });
}

export async function executeOrganizationClosure(input: {
  organizationId: string;
  requestedByUserId: string;
  /** Members audit LIFE-16 — this closure executes a contract termination. */
  terminateContract?: boolean;
  /**
   * Members audit AUD-01 — the request's COMPLETED state and its audit row
   * commit in the SAME transaction as the closure.
   */
  closureRequestId?: string;
}): Promise<void> {
  const { organizationId, requestedByUserId } = input;

  const noticeIds = await prisma.$transaction(async (tx) => {
    const orgTeams = await tx.team.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const teamIds = orgTeams.map((t) => t.id);

    // Archive — checkOrgAccess denies ARCHIVED orgs, so this single
    // status flip is the access cutover for every org surface.
    await archiveOrganizationStatusTx(tx, { organizationId });

    // Members audit LIFE-10 / LIFE-12 — the ONE closure leg set: memberships
    // (and their reach), invitations, machine access, external grants and
    // pointers, and the durable `closedAtUtc` on every org workspace.
    const closed = await closeWorkspacesTx(tx, {
      teamIds,
      actorUserId: requestedByUserId,
      reason: "organization closure",
    });

    // Members audit DOM-13 — identity belongs to the Organization, so its
    // closure (or contract termination) ends identity access across every
    // workspace at once, in this transaction: connections and directory
    // credentials are REVOKED (terminal; an ARCHIVED Organization is never
    // resumed), groups and their projections ARCHIVED, live external links
    // unlinked. Rows stay as history.
    const identityReason = input.terminateContract ? "ORGANIZATION_TERMINATED" : "ORGANIZATION_CLOSED";
    const identityEndedAt = new Date();
    const ssoRevoked = await tx.ssoConnection.updateMany({
      where: { organizationId, status: { not: "REVOKED" } },
      data: {
        status: "REVOKED",
        revokedAtUtc: identityEndedAt,
        revokedByUserId: requestedByUserId,
        revokedReason: identityReason,
        outageDetectedAtUtc: null,
        consecutiveFailureCount: 0,
      },
    });
    const scimRevoked = await tx.scimProvisioningToken.updateMany({
      where: { organizationId, status: { not: "REVOKED" } },
      data: {
        status: "REVOKED",
        revokedAtUtc: identityEndedAt,
        revokedByUserId: requestedByUserId,
        revokedReason: identityReason,
      },
    });
    await tx.scimGroupWorkspaceProjection.updateMany({
      where: { organizationId, status: "ACTIVE" },
      data: { status: "ARCHIVED" },
    });
    await tx.scimGroup.updateMany({
      where: { organizationId, status: "ACTIVE" },
      data: { status: "ARCHIVED" },
    });
    const identitiesUnlinked = await tx.externalIdentityMapping.updateMany({
      where: { organizationId, unlinkedAtUtc: null },
      data: { unlinkedAtUtc: identityEndedAt },
    });
    await emitOrgAuditEvent(tx, {
      organizationId,
      actorUserId: requestedByUserId,
      eventType: "ORG_IDENTITY_ENDED",
      targetType: "organization",
      targetId: organizationId,
      metadata: {
        reason: identityReason,
        ssoConnectionsRevoked: ssoRevoked.count,
        scimTokensRevoked: scimRevoked.count,
        externalIdentitiesUnlinked: identitiesUnlinked.count,
      },
    });

    // TERMINATED — in the same transaction as the closure it completes, so a
    // contract is never TERMINATED while its workspaces still operate.
    if (input.terminateContract) {
      await transitionEnterpriseContractStatusTx(tx, { organizationId, to: "TERMINATED" });
    }

    await emitOrgAuditEvent(tx, {
      organizationId,
      actorUserId: requestedByUserId,
      eventType: "ORG_CLOSURE_COMPLETED",
      targetType: "organization",
      targetId: organizationId,
      metadata: { workspacesArchived: teamIds.length },
    });
    if (input.closureRequestId) {
      await tx.organizationClosureRequest.update({
        where: { id: input.closureRequestId },
        data: { status: "COMPLETED", completedAtUtc: new Date() },
      });
      await emitTenantAudit(
        {
          action: "identity.organization_closure_completed",
          outcome: "success",
          sourceApp: "API",
          actorUserId: requestedByUserId,
          serviceActor: "org_closure_worker",
          organizationId,
          resourceType: "organization_closure_request",
          resourceId: input.closureRequestId,
          causationId: input.closureRequestId,
          previousState: "PROCESSING",
          resultingState: "COMPLETED",
          metadata: { workspacesArchived: teamIds.length, terminateContract: input.terminateContract === true },
        },
        tx as never,
      );
    }
    return closed.noticeIds;
  });
  await dispatchEnqueuedEmailNotifications(noticeIds);
}

/** A closure request's terminal refusal or failure, and its audit, in one transaction. */
async function recordOrganizationClosureOutcome(input: {
  requestId: string;
  organizationId: string;
  requestedByUserId: string;
  fromStatus: string;
  outcome: "BLOCKED" | "FAILED";
  blockers?: Array<{ code: string }>;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const moved = await tx.organizationClosureRequest.updateMany({
      where: { id: input.requestId, status: input.fromStatus },
      data:
        input.outcome === "BLOCKED"
          ? { status: "BLOCKED", blockersJson: JSON.stringify(input.blockers ?? []) }
          : { status: "FAILED", failureCode: "closure_failed" },
    });
    if (moved.count === 0) return;
    await emitTenantAudit(
      {
        action:
          input.outcome === "BLOCKED"
            ? "identity.organization_closure_blocked"
            : "identity.organization_closure_failed",
        outcome: input.outcome === "BLOCKED" ? "denied" : "error",
        ...(input.outcome === "BLOCKED" ? { denialReason: "closure_blocked" } : {}),
        sourceApp: "API",
        actorUserId: input.requestedByUserId,
        serviceActor: "org_closure_worker",
        organizationId: input.organizationId,
        resourceType: "organization_closure_request",
        resourceId: input.requestId,
        causationId: input.requestId,
        previousState: input.fromStatus,
        resultingState: input.outcome,
        metadata:
          input.outcome === "BLOCKED"
            ? { blockers: (input.blockers ?? []).map((b) => b.code) }
            : { failureCode: "closure_failed" },
      },
      tx as never,
    );
  });
}

/**
 * Cron entrypoint — executes due organization closures. Called from the
 * digest scheduler tick; failures are isolated per request row.
 */
export async function processOrganizationClosures(now: Date): Promise<void> {
  // THE REAPER (members audit LIFE-11). A request an interrupted run left in
  // PROCESSING goes back to SCHEDULED and is executed again below — through the
  // same preflight and the same guarded claim. Execution is idempotent (every
  // closure leg selects only what is still live), so finishing it twice
  // settles nothing twice.
  await prisma.organizationClosureRequest.updateMany({
    where: {
      status: "PROCESSING",
      startedAtUtc: { lte: new Date(now.getTime() - CLOSURE_STALE_MS) },
    },
    data: { status: "SCHEDULED" },
  });

  const due = await prisma.organizationClosureRequest.findMany({
    where: {
      status: { in: ["COOLING_OFF", "SCHEDULED"] },
      coolingOffEndsAtUtc: { lte: now },
    },
    orderBy: { coolingOffEndsAtUtc: "asc" },
    take: PROCESS_BATCH,
    select: {
      id: true,
      organizationId: true,
      requestedByUserId: true,
      status: true,
      reason: true,
    },
  });

  for (const req of due) {
    const termination = isContractTerminationClosure(req.reason);
    const preflight = await evaluateOrganizationClosurePreflight(
      req.organizationId,
      req.requestedByUserId,
    );
    // Members audit LIFE-16 — a contract TERMINATION off-boards everyone and
    // ends the very contract a self-service closure would wait on, so those
    // two blockers do not apply to it. Nothing else is relaxed: an ACTIVE
    // legal hold blocks a termination exactly as it blocks any closure.
    const blockers = termination
      ? preflight.blockers.filter(
          (b) => b.code !== "ORG_MEMBERS_ACTIVE" && b.code !== "BILLING_CONTRACT_ACTIVE",
        )
      : preflight.blockers;
    if (blockers.length > 0) {
      await recordOrganizationClosureOutcome({
        requestId: req.id,
        organizationId: req.organizationId,
        requestedByUserId: req.requestedByUserId,
        fromStatus: req.status,
        outcome: "BLOCKED",
        blockers,
      });
      continue;
    }

    const claimed = await prisma.organizationClosureRequest.updateMany({
      where: { id: req.id, status: req.status },
      data: { status: "PROCESSING", startedAtUtc: now },
    });
    if (claimed.count === 0) continue;

    try {
      await executeOrganizationClosure({
        organizationId: req.organizationId,
        requestedByUserId: req.requestedByUserId,
        terminateContract: termination,
        closureRequestId: req.id,
      });
    } catch {
      // The closure rolled back as a unit. If recording the failure fails
      // too, the request stays PROCESSING and the reaper resumes it.
      await recordOrganizationClosureOutcome({
        requestId: req.id,
        organizationId: req.organizationId,
        requestedByUserId: req.requestedByUserId,
        fromStatus: "PROCESSING",
        outcome: "FAILED",
      }).catch(() => null);
    }
  }
}
