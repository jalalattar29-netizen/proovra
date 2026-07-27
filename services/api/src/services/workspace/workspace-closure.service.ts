/**
 * Lifecycle Phase 7 (2026-07-17) — workspace closure execution.
 *
 * ONE canonical processor for the WorkspaceClosureRequest state machine.
 * Routes only create/cancel request rows (workspace-OWNER-only, typed
 * confirmation + step-up); execution runs on the existing digest cron via
 * `processWorkspaceClosures` (the same piggyback pattern as account and
 * organization closure — no parallel job infrastructure).
 *
 * Execution model (ARCHIVE access, never destroy evidence):
 *   1. Re-run the canonical preflight — a blocker acquired during the
 *      cooling-off window (a new legal hold, a re-activated subscription,
 *      a fresh destruction review) moves the request to BLOCKED.
 *   2. Atomically claim the row (guarded updateMany → PROCESSING).
 *   3. Collaboration consequence: EVERY ACTIVE membership (including the
 *      owner's) flips to REVOKED — deactivated, never erased, so actor
 *      attribution on evidence/custody stays intact. Workspace access
 *      authorization runs on ACTIVE TeamMember rows per-request, so the
 *      workspace goes dark immediately.
 *   4. Machine access never outlives the workspace: ACTIVE ApiCredentials
 *      → REVOKED, ACTIVE WebhookEndpoints → DISABLED.
 *   5. currentWorkspaceId pointers into this workspace are cleared; the
 *      personal-workspace bootstrap recovers those users on next load.
 *
 * The Team row, evidence, anchors, TSA/OTS certifications, custody
 * events, and audit history all remain intact — retention/legal
 * governance owns evidence destruction, not workspace lifecycle.
 */

import { prisma } from "../../db.js";
// PHASE 3 (2026-07-22) — canonical membership orchestrator.
import { massRevokeWorkspaceMemberships } from "../identity/membership-provisioning.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { evaluateWorkspaceClosurePreflight } from "../identity/account-lifecycle-preflight.service.js";

export const WORKSPACE_CLOSURE_COOLING_OFF_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PROCESS_BATCH = 3;

/** Statuses that count as "an open closure request exists". */
export const ACTIVE_WORKSPACE_CLOSURE_STATUSES = [
  "REQUESTED",
  "COOLING_OFF",
  "SCHEDULED",
  "PROCESSING",
] as const;

/** Statuses the owner may still cancel from. */
export const CANCELLABLE_WORKSPACE_CLOSURE_STATUSES = [
  "REQUESTED",
  "BLOCKED",
  "COOLING_OFF",
  "SCHEDULED",
] as const;

export async function executeWorkspaceClosure(input: {
  teamId: string;
  requestedByUserId: string;
}): Promise<void> {
  const { teamId, requestedByUserId } = input;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    // Collaboration consequence — every membership goes dark at once.
    // PHASE 3 — canonical orchestrator (provenance closed per member).
    const revoked = await massRevokeWorkspaceMemberships(tx, {
      where: { teamId },
      actorUserId: requestedByUserId,
      reason: "workspace closure",
    });

    await tx.apiCredential.updateMany({
      where: { teamId, status: "ACTIVE" },
      data: {
        status: "REVOKED",
        revokedAtUtc: now,
        revokedReason: "workspace_closed",
      },
    });
    await tx.webhookEndpoint.updateMany({
      where: { teamId, status: "ACTIVE" },
      data: { status: "DISABLED" },
    });

    await tx.user.updateMany({
      where: { currentWorkspaceId: teamId },
      data: { currentWorkspaceId: null },
    });

    await tx.teamActivity.create({
      data: {
        teamId,
        actorUserId: requestedByUserId,
        eventType: "workspace_closed",
        targetType: "team",
        targetId: teamId,
        metadata: { membersRevoked: revoked.count },
      },
    });
  });
}

/**
 * Cron entrypoint — executes due workspace closures. Called from the
 * digest scheduler tick; failures are isolated per request row.
 */
export async function processWorkspaceClosures(now: Date): Promise<void> {
  const due = await prisma.workspaceClosureRequest.findMany({
    where: {
      status: { in: ["COOLING_OFF", "SCHEDULED"] },
      coolingOffEndsAtUtc: { lte: now },
    },
    orderBy: { coolingOffEndsAtUtc: "asc" },
    take: PROCESS_BATCH,
    select: { id: true, teamId: true, requestedByUserId: true, status: true },
  });

  for (const req of due) {
    const { blockers } = await evaluateWorkspaceClosurePreflight(req.teamId);
    if (blockers.length > 0) {
      await prisma.workspaceClosureRequest.updateMany({
        where: { id: req.id, status: req.status },
        data: { status: "BLOCKED", blockersJson: JSON.stringify(blockers) },
      });
      await emitTenantAudit({
        action: "identity.workspace_closure_blocked",
        outcome: "denied",
        denialReason: "closure_blocked",
        sourceApp: "API",
        actorUserId: req.requestedByUserId,
        serviceActor: "workspace_closure_worker",
        workspaceId: req.teamId,
        resourceType: "workspace_closure_request",
        resourceId: req.id,
        metadata: { blockers: blockers.map((b) => b.code) },
      }).catch(() => null);
      continue;
    }

    const claimed = await prisma.workspaceClosureRequest.updateMany({
      where: { id: req.id, status: req.status },
      data: { status: "PROCESSING", startedAtUtc: now },
    });
    if (claimed.count === 0) continue;

    try {
      await executeWorkspaceClosure({
        teamId: req.teamId,
        requestedByUserId: req.requestedByUserId,
      });
      await prisma.workspaceClosureRequest.update({
        where: { id: req.id },
        data: { status: "COMPLETED", completedAtUtc: new Date() },
      });
      await emitTenantAudit({
        action: "identity.workspace_closure_completed",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.requestedByUserId,
        serviceActor: "workspace_closure_worker",
        workspaceId: req.teamId,
        resourceType: "workspace_closure_request",
        resourceId: req.id,
        metadata: {},
      }).catch(() => null);
    } catch {
      await prisma.workspaceClosureRequest
        .update({
          where: { id: req.id },
          data: { status: "FAILED", failureCode: "closure_failed" },
        })
        .catch(() => null);
      await emitTenantAudit({
        action: "identity.workspace_closure_failed",
        outcome: "error",
        sourceApp: "API",
        actorUserId: req.requestedByUserId,
        serviceActor: "workspace_closure_worker",
        workspaceId: req.teamId,
        resourceType: "workspace_closure_request",
        resourceId: req.id,
        metadata: { failureCode: "closure_failed" },
      }).catch(() => null);
    }
  }
}
