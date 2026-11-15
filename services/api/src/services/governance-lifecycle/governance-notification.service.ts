/**
 * Phase 27.5 — Governance notification read surface.
 *
 * GovernanceNotification rows are WRITTEN by the worker emitter
 * (services/worker/src/governance/notification-emitter.ts); this module
 * READS/projects/acknowledges them.
 *
 * The dedupe/throttle emission contract lives in @proovra/shared
 * (governance-notification-contract.ts). Rows are deduped per
 * `(teamId, kind, dedupeKey)` by the writer; a re-emission increments
 * `occurrenceCount` rather than creating a duplicate. This module only
 * projects those rows for the operator dashboard and records
 * acknowledgements.
 */

import type {
  PrismaClient,
  GovernanceNotification as DbNotification,
} from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import type {
  GovernanceNotificationDeliveryStatus,
  GovernanceNotificationKind,
  GovernanceNotificationSeverity,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import type { ViewerReach } from "../access/record-reach.js";

/**
 * A2-12 — a governance notification that names a record closed to the reader
 * (or a legal hold on a closed record or case) is that record's row: not
 * listed, not counted, and acknowledged like a missing one. Every writer
 * (services/worker/src/governance/*) sets `relatedEvidenceId`; a hold
 * reference is resolved through the hold row. Null references stay visible.
 */
export async function governanceNotificationReachWhere(
  teamId: string,
  reach: ViewerReach | null | undefined,
  client: Pick<PrismaClient, "evidenceLegalHold"> = defaultPrisma,
): Promise<prismaPkg.Prisma.GovernanceNotificationWhereInput[]> {
  if (!reach) return [];
  const { evidenceIds, caseIds } = reach.hidden;
  if (evidenceIds.length === 0 && caseIds.length === 0) return [];
  const closedHolds = await client.evidenceLegalHold.findMany({
    where: { teamId, OR: [{ evidenceId: { in: evidenceIds } }, { caseId: { in: caseIds } }] },
    select: { id: true },
  });
  const out: prismaPkg.Prisma.GovernanceNotificationWhereInput[] = [];
  if (evidenceIds.length > 0) {
    out.push({ OR: [{ relatedEvidenceId: null }, { relatedEvidenceId: { notIn: evidenceIds } }] });
  }
  if (closedHolds.length > 0) {
    out.push({ OR: [{ relatedHoldId: null }, { relatedHoldId: { notIn: closedHolds.map((h) => h.id) } }] });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export type GovernanceNotificationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_DEDUPE_KEY";

export class GovernanceNotificationError extends Error {
  constructor(
    public readonly code: GovernanceNotificationErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "GovernanceNotificationError";
  }
}

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export type GovernanceNotificationProjection = {
  id: string;
  teamId: string;
  kind: GovernanceNotificationKind;
  severity: GovernanceNotificationSeverity;
  dedupeKey: string;
  title: string;
  summary: string;
  relatedEvidenceId: string | null;
  relatedReviewId: string | null;
  relatedHoldId: string | null;
  relatedPolicyId: string | null;
  relatedIncidentId: string | null;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  occurrenceCount: number;
  deliveryStatus: GovernanceNotificationDeliveryStatus;
  deliveryAttempts: number;
  lastDeliveryAtUtc: string | null;
  channels: ReadonlyArray<string>;
  recipientUserIds: ReadonlyArray<string>;
  acknowledgedAtUtc: string | null;
  acknowledgedByUserId: string | null;
  metadata: unknown;
};

export function projectNotification(
  row: DbNotification,
): GovernanceNotificationProjection {
  return {
    id: row.id,
    teamId: row.teamId,
    kind: row.kind as GovernanceNotificationKind,
    severity: row.severity as GovernanceNotificationSeverity,
    dedupeKey: row.dedupeKey,
    title: row.title,
    summary: row.summary,
    relatedEvidenceId: row.relatedEvidenceId,
    relatedReviewId: row.relatedReviewId,
    relatedHoldId: row.relatedHoldId,
    relatedPolicyId: row.relatedPolicyId,
    relatedIncidentId: row.relatedIncidentId,
    firstSeenAtUtc: row.firstSeenAtUtc.toISOString(),
    lastSeenAtUtc: row.lastSeenAtUtc.toISOString(),
    occurrenceCount: row.occurrenceCount,
    deliveryStatus: row.deliveryStatus as GovernanceNotificationDeliveryStatus,
    deliveryAttempts: row.deliveryAttempts,
    lastDeliveryAtUtc: row.lastDeliveryAtUtc?.toISOString() ?? null,
    channels: row.channels,
    recipientUserIds: row.recipientUserIds,
    acknowledgedAtUtc: row.acknowledgedAtUtc?.toISOString() ?? null,
    acknowledgedByUserId: row.acknowledgedByUserId,
    metadata: row.metadata,
  };
}

// -----------------------------------------------------------------------------
// Acknowledge — operator dismissed the alert
// -----------------------------------------------------------------------------

export async function acknowledgeGovernanceNotification(
  input: {
    id: string;
    teamId: string;
    actorUserId: string;
    /** A2-12 — `governanceNotificationReachWhere` for the actor. */
    reachWhere?: prismaPkg.Prisma.GovernanceNotificationWhereInput[];
  },
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceNotificationProjection> {
  const existing = await client.governanceNotification.findFirst({
    where: { id: input.id, teamId: input.teamId, AND: input.reachWhere ?? [] },
    select: { id: true, acknowledgedAtUtc: true },
  });
  if (!existing) {
    throw new GovernanceNotificationError("INVALID_INPUT", {
      field: "id",
    });
  }
  if (existing.acknowledgedAtUtc) {
    const row = await client.governanceNotification.findUnique({
      where: { id: existing.id },
    });
    return projectNotification(row!);
  }
  const row = await client.governanceNotification.update({
    where: { id: existing.id },
    data: {
      acknowledgedAtUtc: new Date(),
      acknowledgedByUserId: input.actorUserId,
    },
  });
  return projectNotification(row);
}

// -----------------------------------------------------------------------------
// Listing — operator queue surface
// -----------------------------------------------------------------------------

export type ListGovernanceNotificationsInput = {
  teamId: string;
  kind?: GovernanceNotificationKind;
  severity?: GovernanceNotificationSeverity;
  deliveryStatus?: GovernanceNotificationDeliveryStatus;
  unacknowledged?: boolean;
  limit?: number;
  /** A2-12 — `governanceNotificationReachWhere` for the reader. */
  reachWhere?: prismaPkg.Prisma.GovernanceNotificationWhereInput[];
};

export async function listGovernanceNotifications(
  input: ListGovernanceNotificationsInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<GovernanceNotificationProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const where: prismaPkg.Prisma.GovernanceNotificationWhereInput = {
    teamId: input.teamId,
    ...(input.kind
      ? { kind: input.kind as prismaPkg.GovernanceNotificationKind }
      : {}),
    ...(input.severity
      ? {
          severity: input.severity as prismaPkg.GovernanceNotificationSeverity,
        }
      : {}),
    ...(input.deliveryStatus
      ? {
          deliveryStatus:
            input.deliveryStatus as prismaPkg.GovernanceNotificationDeliveryStatus,
        }
      : {}),
    ...(input.unacknowledged ? { acknowledgedAtUtc: null } : {}),
    AND: input.reachWhere ?? [],
  };
  const rows = await client.governanceNotification.findMany({
    where,
    orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }],
    take: limit,
  });
  return rows.map(projectNotification);
}

// -----------------------------------------------------------------------------
// Dashboard counts
// -----------------------------------------------------------------------------

export async function countPendingGovernanceNotifications(
  teamId: string,
  client: PrismaClient = defaultPrisma,
  reachWhere: prismaPkg.Prisma.GovernanceNotificationWhereInput[] = [],
): Promise<number> {
  return client.governanceNotification.count({
    where: {
      teamId,
      deliveryStatus: prismaPkg.GovernanceNotificationDeliveryStatus.PENDING,
      AND: reachWhere,
    },
  });
}

export async function countFailedGovernanceNotifications(
  teamId: string,
  client: PrismaClient = defaultPrisma,
  reachWhere: prismaPkg.Prisma.GovernanceNotificationWhereInput[] = [],
): Promise<number> {
  return client.governanceNotification.count({
    where: {
      teamId,
      deliveryStatus: prismaPkg.GovernanceNotificationDeliveryStatus.FAILED,
      AND: reachWhere,
    },
  });
}
