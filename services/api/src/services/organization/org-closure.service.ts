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
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { evaluateOrganizationClosurePreflight } from "../identity/account-lifecycle-preflight.service.js";
import { emitOrgAuditEvent } from "./org-audit.service.js";

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

export async function executeOrganizationClosure(input: {
  organizationId: string;
  requestedByUserId: string;
}): Promise<void> {
  const { organizationId, requestedByUserId } = input;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const orgTeams = await tx.team.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const teamIds = orgTeams.map((t) => t.id);

    // Archive — checkOrgAccess denies ARCHIVED orgs, so this single
    // status flip is the access cutover for every org surface.
    await tx.organization.update({
      where: { id: organizationId },
      data: { status: "ARCHIVED" },
    });

    if (teamIds.length > 0) {
      // Workspace memberships: deactivate, never erase.
      await tx.teamMember.updateMany({
        where: { teamId: { in: teamIds }, status: "ACTIVE" },
        data: { status: "REVOKED" },
      });

      // Machine access never outlives the organization.
      await tx.apiCredential.updateMany({
        where: { teamId: { in: teamIds }, status: "ACTIVE" },
        data: {
          status: "REVOKED",
          revokedAtUtc: now,
          revokedReason: "organization_closed",
        },
      });
      await tx.webhookEndpoint.updateMany({
        where: { teamId: { in: teamIds }, status: "ACTIVE" },
        data: { status: "DISABLED" },
      });

      // Users pointed at an org workspace fall back to their personal
      // workspace on next platform-context load.
      await tx.user.updateMany({
        where: { currentWorkspaceId: { in: teamIds } },
        data: { currentWorkspaceId: null },
      });
    }

    await emitOrgAuditEvent(tx, {
      organizationId,
      actorUserId: requestedByUserId,
      eventType: "ORG_CLOSURE_COMPLETED",
      targetType: "organization",
      targetId: organizationId,
      metadata: { workspacesArchived: teamIds.length },
    });
  });
}

/**
 * Cron entrypoint — executes due organization closures. Called from the
 * digest scheduler tick; failures are isolated per request row.
 */
export async function processOrganizationClosures(now: Date): Promise<void> {
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
    },
  });

  for (const req of due) {
    const { blockers } = await evaluateOrganizationClosurePreflight(
      req.organizationId,
      req.requestedByUserId,
    );
    if (blockers.length > 0) {
      await prisma.organizationClosureRequest.updateMany({
        where: { id: req.id, status: req.status },
        data: { status: "BLOCKED", blockersJson: JSON.stringify(blockers) },
      });
      await appendPlatformAuditLog({
        userId: req.requestedByUserId,
        action: "identity.organization_closure_blocked",
        category: "identity.lifecycle",
        severity: "warning",
        source: "org_closure_worker",
        outcome: "denied",
        resourceType: "organization_closure_request",
        resourceId: req.id,
        metadata: { blockers: blockers.map((b) => b.code) },
      }).catch(() => null);
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
      });
      await prisma.organizationClosureRequest.update({
        where: { id: req.id },
        data: { status: "COMPLETED", completedAtUtc: new Date() },
      });
      await appendPlatformAuditLog({
        userId: req.requestedByUserId,
        action: "identity.organization_closure_completed",
        category: "identity.lifecycle",
        severity: "warning",
        source: "org_closure_worker",
        outcome: "success",
        resourceType: "organization_closure_request",
        resourceId: req.id,
        metadata: { organizationId: req.organizationId },
      }).catch(() => null);
    } catch {
      await prisma.organizationClosureRequest
        .update({
          where: { id: req.id },
          data: { status: "FAILED", failureCode: "closure_failed" },
        })
        .catch(() => null);
      await appendPlatformAuditLog({
        userId: req.requestedByUserId,
        action: "identity.organization_closure_failed",
        category: "identity.lifecycle",
        severity: "error",
        source: "org_closure_worker",
        outcome: "failure",
        resourceType: "organization_closure_request",
        resourceId: req.id,
        metadata: { failureCode: "closure_failed" },
      }).catch(() => null);
    }
  }
}
