/**
 * Phase 17 — Access Review service.
 *
 * Periodic + triggered review queue. Operators see "who has access that
 * looks suspicious or stale" and decide KEEP / REVOKE / SUSPEND /
 * NO_ACTION. Every decision routes through the RBAC service so the
 * underlying mutation (suspend / revoke) shares the same audit path.
 *
 * The queue generator is a pure async pass that scans:
 *   - TeamMembers whose lastSeenAtUtc is older than N days (STALE_ACCESS)
 *   - TeamMembers whose accessExpiresAtUtc is within N days
 *     (EXPIRING_TEMPORARY_ACCESS)
 *   - ApiCredentials whose lastUsedAtUtc is older than N days
 *     (UNUSED_SERVICE_ACCOUNT)
 *
 * Idempotency: the generator deduplicates against any existing PENDING
 * or IN_PROGRESS review for the same (kind + subject).
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type AccessReviewKind,
  type AccessReviewStatus,
  STALE_ACCESS_DAYS_DEFAULT,
  UNUSED_SERVICE_ACCOUNT_DAYS_DEFAULT,
  EXPIRING_ACCESS_WINDOW_DAYS_DEFAULT,
  isAllowedAccessReviewTransition,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
// WAVE A FINAL CLOSURE (2026-07-22) — transitions via the Membership
// Orchestrator public command surface; the rbac engine is internal.
import {
  revokeMember,
  suspendMember,
  RbacError,
} from "./membership-provisioning.service.js";

export type AccessReviewErrorCode =
  | "review_not_found"
  | "invalid_status_transition"
  | "subject_missing";

export class AccessReviewError extends Error {
  readonly code: AccessReviewErrorCode;
  constructor(code: AccessReviewErrorCode) {
    super(code);
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// Queue generator — idempotent.
// -----------------------------------------------------------------------------

export async function regenerateAccessReviewQueue(
  input: {
    teamId: string;
    actorUserId?: string | null;
    staleAccessDays?: number;
    unusedServiceAccountDays?: number;
    expiringWindowDays?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ created: number }> {
  const staleDays = Math.max(
    7,
    Math.min(input.staleAccessDays ?? STALE_ACCESS_DAYS_DEFAULT, 365),
  );
  const unusedDays = Math.max(
    7,
    Math.min(
      input.unusedServiceAccountDays ?? UNUSED_SERVICE_ACCOUNT_DAYS_DEFAULT,
      365,
    ),
  );
  const expiringDays = Math.max(
    1,
    Math.min(
      input.expiringWindowDays ?? EXPIRING_ACCESS_WINDOW_DAYS_DEFAULT,
      90,
    ),
  );

  const now = Date.now();
  const staleThreshold = new Date(now - staleDays * 24 * 3600 * 1000);
  const unusedThreshold = new Date(now - unusedDays * 24 * 3600 * 1000);
  const expiringHorizon = new Date(now + expiringDays * 24 * 3600 * 1000);

  let created = 0;

  // 1. Stale member access.
  const staleMembers = await client.teamMember.findMany({
    where: {
      teamId: input.teamId,
      status: prismaPkg.TeamMemberStatus.ACTIVE,
      OR: [
        { lastSeenAtUtc: null, createdAt: { lt: staleThreshold } },
        { lastSeenAtUtc: { lt: staleThreshold } },
      ],
      // OWNER is excluded — owner staleness is a different conversation.
      NOT: { role: prismaPkg.TeamRole.OWNER },
    },
    select: { id: true, userId: true, lastSeenAtUtc: true, createdAt: true },
  });
  for (const m of staleMembers) {
    created += await enqueueIfNotExists(client, {
      teamId: input.teamId,
      kind: "STALE_ACCESS",
      subjectKind: "TEAM_MEMBER",
      subjectUserId: m.userId,
      initiatedByUserId: input.actorUserId ?? null,
      contextSnapshotJson: {
        teamMemberId: m.id,
        lastSeenAtUtc: m.lastSeenAtUtc?.toISOString() ?? null,
        createdAt: m.createdAt.toISOString(),
        staleSinceDays: staleDays,
      },
    });
  }

  // 2. Expiring temporary access.
  const expiringMembers = await client.teamMember.findMany({
    where: {
      teamId: input.teamId,
      status: prismaPkg.TeamMemberStatus.ACTIVE,
      accessExpiresAtUtc: { gte: new Date(now), lte: expiringHorizon },
    },
    select: { id: true, userId: true, accessExpiresAtUtc: true },
  });
  for (const m of expiringMembers) {
    created += await enqueueIfNotExists(client, {
      teamId: input.teamId,
      kind: "EXPIRING_TEMPORARY_ACCESS",
      subjectKind: "TEAM_MEMBER",
      subjectUserId: m.userId,
      initiatedByUserId: input.actorUserId ?? null,
      contextSnapshotJson: {
        teamMemberId: m.id,
        accessExpiresAtUtc: m.accessExpiresAtUtc?.toISOString() ?? null,
        windowDays: expiringDays,
      },
    });
  }

  // 3. Unused service accounts.
  const unusedCreds = await client.apiCredential.findMany({
    where: {
      teamId: input.teamId,
      status: "ACTIVE",
      disabledAtUtc: null,
      OR: [
        { lastUsedAtUtc: null, createdAt: { lt: unusedThreshold } },
        { lastUsedAtUtc: { lt: unusedThreshold } },
      ],
    },
    select: {
      id: true,
      lastUsedAtUtc: true,
      createdAt: true,
      environment: true,
    },
  });
  for (const c of unusedCreds) {
    created += await enqueueIfNotExists(client, {
      teamId: input.teamId,
      kind: "UNUSED_SERVICE_ACCOUNT",
      subjectKind: "SERVICE_ACCOUNT",
      subjectApiCredentialId: c.id,
      initiatedByUserId: input.actorUserId ?? null,
      contextSnapshotJson: {
        lastUsedAtUtc: c.lastUsedAtUtc?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        unusedSinceDays: unusedDays,
        environment: c.environment,
      },
    });
  }

  if (created > 0 && input.actorUserId) {
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "access_review_initiated",
        severity: "INFO",
        details: {
          actorUserId: input.actorUserId,
          created,
          mode: "queue_regeneration",
        },
      },
      client,
    );
  }
  return { created };
}

async function enqueueIfNotExists(
  client: PrismaClient,
  input: {
    teamId: string;
    kind: AccessReviewKind;
    subjectKind: "TEAM_MEMBER" | "SERVICE_ACCOUNT" | "CONTRIBUTOR_SESSION";
    subjectUserId?: string | null;
    subjectApiCredentialId?: string | null;
    subjectIntakeSessionId?: string | null;
    initiatedByUserId: string | null;
    dueAtUtc?: Date | null;
    contextSnapshotJson?: Record<string, unknown>;
  },
): Promise<number> {
  const existing = await client.accessReview.findFirst({
    where: {
      teamId: input.teamId,
      kind: input.kind,
      subjectKind: input.subjectKind,
      subjectUserId: input.subjectUserId ?? null,
      subjectApiCredentialId: input.subjectApiCredentialId ?? null,
      subjectIntakeSessionId: input.subjectIntakeSessionId ?? null,
      status: {
        in: [
          prismaPkg.AccessReviewStatus.PENDING,
          prismaPkg.AccessReviewStatus.IN_PROGRESS,
        ],
      },
    },
    select: { id: true },
  });
  if (existing) return 0;
  await client.accessReview.create({
    data: {
      teamId: input.teamId,
      kind: input.kind,
      status: prismaPkg.AccessReviewStatus.PENDING,
      subjectKind: input.subjectKind,
      subjectUserId: input.subjectUserId ?? null,
      subjectApiCredentialId: input.subjectApiCredentialId ?? null,
      subjectIntakeSessionId: input.subjectIntakeSessionId ?? null,
      initiatedByUserId: input.initiatedByUserId,
      dueAtUtc: input.dueAtUtc ?? null,
      contextSnapshotJson: input.contextSnapshotJson
        ? (input.contextSnapshotJson as prismaPkg.Prisma.InputJsonValue)
        : prismaPkg.Prisma.JsonNull,
    },
  });
  return 1;
}

// -----------------------------------------------------------------------------
// Decision API
// -----------------------------------------------------------------------------

export type AccessReviewDecision =
  | "KEEP"
  | "REVOKE_MEMBER"
  | "SUSPEND_MEMBER"
  | "NO_ACTION"
  | "CANCEL";

const DECISION_TO_STATUS: Record<AccessReviewDecision, AccessReviewStatus> = {
  KEEP: "COMPLETED_KEEP",
  REVOKE_MEMBER: "COMPLETED_REVOKED",
  SUSPEND_MEMBER: "COMPLETED_SUSPENDED",
  NO_ACTION: "COMPLETED_NO_ACTION",
  CANCEL: "CANCELLED",
};

export type CompleteAccessReviewInput = {
  teamId: string;
  reviewId: string;
  actorUserId: string;
  decision: AccessReviewDecision;
  decisionNote?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function completeAccessReview(
  input: CompleteAccessReviewInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.AccessReview> {
  const review = await client.accessReview.findFirst({
    where: { id: input.reviewId, teamId: input.teamId },
  });
  if (!review) throw new AccessReviewError("review_not_found");
  const nextStatus = DECISION_TO_STATUS[input.decision];
  if (
    !isAllowedAccessReviewTransition(
      review.status as AccessReviewStatus,
      nextStatus,
    )
  ) {
    throw new AccessReviewError("invalid_status_transition");
  }

  // Apply the underlying mutation FIRST (fail-closed): if the rbac call
  // fails we never mark the review complete.
  if (
    (input.decision === "REVOKE_MEMBER" || input.decision === "SUSPEND_MEMBER") &&
    review.subjectKind === prismaPkg.AccessReviewSubjectKind.TEAM_MEMBER
  ) {
    if (!review.subjectUserId) {
      throw new AccessReviewError("subject_missing");
    }
    const teamMember = await client.teamMember.findFirst({
      where: { teamId: input.teamId, userId: review.subjectUserId },
      select: { id: true },
    });
    if (!teamMember) throw new AccessReviewError("subject_missing");
    try {
      if (input.decision === "REVOKE_MEMBER") {
        await revokeMember(
          {
            teamId: input.teamId,
            teamMemberId: teamMember.id,
            actorUserId: input.actorUserId,
            reason: input.decisionNote ?? `access_review:${review.id}`,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
          },
          client,
        );
      } else {
        await suspendMember(
          {
            teamId: input.teamId,
            teamMemberId: teamMember.id,
            actorUserId: input.actorUserId,
            reason: input.decisionNote ?? `access_review:${review.id}`,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
          },
          client,
        );
      }
    } catch (err) {
      if (err instanceof RbacError) {
        // Translate RBAC failures into our error surface so the route
        // returns a meaningful code without leaking internals.
        throw new AccessReviewError("invalid_status_transition");
      }
      throw err;
    }
  }

  const updated = await client.accessReview.update({
    where: { id: review.id },
    data: {
      status: nextStatus,
      completedAtUtc: new Date(),
      completedByUserId: input.actorUserId,
      decisionNote: input.decisionNote?.slice(0, 2000) ?? null,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "access_review_completed",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        reviewId: review.id,
        kind: review.kind,
        decision: input.decision,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity.access_review.complete",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "access_review",
    resourceId: review.id,
    metadata: {
      kind: review.kind,
      subjectKind: review.subjectKind,
      decision: input.decision,
      decisionNote: input.decisionNote ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, client);
  return updated;
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

export async function listAccessReviews(
  input: {
    teamId: string;
    status?: AccessReviewStatus;
    kind?: AccessReviewKind;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.AccessReview[]> {
  return client.accessReview.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
    },
    orderBy: [{ status: "asc" }, { initiatedAtUtc: "desc" }],
    take: Math.min(Math.max(input.limit ?? 50, 1), 500),
  });
}
