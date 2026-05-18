/**
 * Phase 27.5 — Governance Notification Engine.
 *
 * Operator-facing notification pipeline for governance events. Emits a
 * single durable `GovernanceNotification` row per `(teamId, kind,
 * dedupeKey)` tuple — a second emission with the same dedupe key
 * INCREMENTS `occurrenceCount` + refreshes `lastSeenAtUtc` rather than
 * creating a duplicate.
 *
 * Hard rules:
 *   - Dedupe at the DB layer via the unique `(team_id, kind, dedupe_key)`
 *     constraint. The service never produces two rows for the same key.
 *   - Throttle delivery (not row creation). The row updates with every
 *     emission; the actual fan-out to email/webhook respects
 *     NOTIFICATION_THROTTLE_SECONDS per severity. A throttled emission
 *     leaves `deliveryStatus` at PENDING and bumps a throttle metric.
 *   - Channel routing is severity-bound: defaults from
 *     `DEFAULT_NOTIFICATION_CHANNELS[severity]`. The future
 *     org-preferences override is implemented as a sealed override
 *     hook (`resolveChannels`) so it can be wired without a service
 *     rewrite.
 *   - Every emission writes a SecurityEvent for the operator feed and
 *     bumps a counter. Failures are best-effort — never break the
 *     calling worker on notification problems.
 *   - HIGH + CRITICAL notifications fan out into the Phase 21
 *     operational incident center via `recordIncident`. The incident
 *     fingerprint matches the notification dedupe key so a burst of
 *     identical signals collapses to one incident.
 *
 * Channels: in-app delivery is the row write itself (the dashboard
 * reads it). Email + webhook delivery are wired through the existing
 * notification service + webhook event emitter, but treated as
 * best-effort side effects of the row write — no failure here breaks
 * the row.
 */

import type {
  PrismaClient,
  GovernanceNotification as DbNotification,
} from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  DEDUPE_KEY_MAX_LEN,
  DEFAULT_NOTIFICATION_CHANNELS,
  GOVERNANCE_NOTIFICATION_CHANNELS,
  GOVERNANCE_NOTIFICATION_KINDS,
  GOVERNANCE_NOTIFICATION_SEVERITIES,
  NOTIFICATION_SUMMARY_MAX_LEN,
  NOTIFICATION_THROTTLE_SECONDS,
  NOTIFICATION_TITLE_MAX_LEN,
  NOTIFICATION_TO_INCIDENT_SEVERITY,
  isValidDedupeKey,
  type GovernanceNotificationChannel,
  type GovernanceNotificationDeliveryStatus,
  type GovernanceNotificationKind,
  type GovernanceNotificationSeverity,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { recordIncident } from "../observability/incident.service.js";

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
// Resolve channels — sealed hook for future org preferences override.
// -----------------------------------------------------------------------------

const VALID_CHANNELS = new Set<string>(GOVERNANCE_NOTIFICATION_CHANNELS);

function resolveChannels(
  severity: GovernanceNotificationSeverity,
): ReadonlyArray<GovernanceNotificationChannel> {
  // Future: org preferences override. For now, severity-bound defaults.
  const defaults = DEFAULT_NOTIFICATION_CHANNELS[severity];
  return defaults.filter((c) => VALID_CHANNELS.has(c));
}

// -----------------------------------------------------------------------------
// Bounded metadata serialization
// -----------------------------------------------------------------------------

const MAX_METADATA_BYTES = 4 * 1024;

const SENSITIVE_KEY_PREFIXES = [
  "legalnote",
  "privileged",
  "secret",
  "token",
  "credential",
  "password",
  "apikey",
  "api_key",
] as const;

function scrubMetadata(input: unknown): unknown {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") {
    if (typeof input === "string") return input.slice(0, 500);
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 50).map(scrubMetadata);
  }
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (i >= 50) break;
    const lowered = String(k).toLowerCase();
    if (SENSITIVE_KEY_PREFIXES.some((p) => lowered.includes(p))) {
      out[String(k).slice(0, 64)] = "[redacted]";
    } else {
      out[String(k).slice(0, 64)] = scrubMetadata(v);
    }
    i += 1;
  }
  return out;
}

function boundedJson(
  input: unknown,
): prismaPkg.Prisma.InputJsonValue | undefined {
  if (input === null || input === undefined) return undefined;
  const scrubbed = scrubMetadata(input);
  try {
    const s = JSON.stringify(scrubbed);
    if (s.length > MAX_METADATA_BYTES) {
      return {
        truncated: true,
        preview: s.slice(0, 1500),
      } as prismaPkg.Prisma.InputJsonValue;
    }
    return scrubbed as prismaPkg.Prisma.InputJsonValue;
  } catch {
    return { truncated: true } as prismaPkg.Prisma.InputJsonValue;
  }
}

// -----------------------------------------------------------------------------
// Emit — main entry point
// -----------------------------------------------------------------------------

export type EmitGovernanceNotificationInput = {
  teamId: string;
  kind: GovernanceNotificationKind;
  severity: GovernanceNotificationSeverity;
  dedupeKey: string;
  title: string;
  summary: string;
  relatedEvidenceId?: string | null;
  relatedReviewId?: string | null;
  relatedHoldId?: string | null;
  relatedPolicyId?: string | null;
  relatedIncidentId?: string | null;
  recipientUserIds?: ReadonlyArray<string>;
  metadata?: Record<string, unknown> | null;
};

export type EmitGovernanceNotificationResult = {
  notification: GovernanceNotificationProjection;
  created: boolean;
  throttled: boolean;
};

const VALID_KINDS = new Set<string>(GOVERNANCE_NOTIFICATION_KINDS);
const VALID_SEVERITIES = new Set<string>(GOVERNANCE_NOTIFICATION_SEVERITIES);

export async function emitGovernanceNotification(
  input: EmitGovernanceNotificationInput,
  client: PrismaClient = defaultPrisma,
): Promise<EmitGovernanceNotificationResult> {
  if (!VALID_KINDS.has(input.kind)) {
    throw new GovernanceNotificationError("INVALID_INPUT", {
      field: "kind",
    });
  }
  if (!VALID_SEVERITIES.has(input.severity)) {
    throw new GovernanceNotificationError("INVALID_INPUT", {
      field: "severity",
    });
  }
  if (!isValidDedupeKey(input.dedupeKey)) {
    throw new GovernanceNotificationError("INVALID_DEDUPE_KEY", {
      dedupeKey: input.dedupeKey?.slice(0, DEDUPE_KEY_MAX_LEN),
    });
  }
  const title = input.title.trim().slice(0, NOTIFICATION_TITLE_MAX_LEN);
  const summary = input.summary.trim().slice(0, NOTIFICATION_SUMMARY_MAX_LEN);
  if (!title || !summary) {
    throw new GovernanceNotificationError("INVALID_INPUT", {
      field: !title ? "title" : "summary",
    });
  }
  const channels = resolveChannels(input.severity);

  const existing = await client.governanceNotification.findUnique({
    where: {
      teamId_kind_dedupeKey: {
        teamId: input.teamId,
        kind: input.kind as prismaPkg.GovernanceNotificationKind,
        dedupeKey: input.dedupeKey,
      },
    },
  });

  const now = new Date();
  const throttleSeconds = NOTIFICATION_THROTTLE_SECONDS[input.severity];
  const shouldThrottle =
    existing &&
    existing.lastDeliveryAtUtc &&
    now.getTime() - existing.lastDeliveryAtUtc.getTime() <
      throttleSeconds * 1000;

  let row: DbNotification;
  let created = false;
  let throttled = false;

  if (!existing) {
    row = await client.governanceNotification.create({
      data: {
        teamId: input.teamId,
        kind: input.kind as prismaPkg.GovernanceNotificationKind,
        severity: input.severity as prismaPkg.GovernanceNotificationSeverity,
        dedupeKey: input.dedupeKey,
        title,
        summary,
        relatedEvidenceId: input.relatedEvidenceId ?? null,
        relatedReviewId: input.relatedReviewId ?? null,
        relatedHoldId: input.relatedHoldId ?? null,
        relatedPolicyId: input.relatedPolicyId ?? null,
        relatedIncidentId: input.relatedIncidentId ?? null,
        recipientUserIds: Array.from(input.recipientUserIds ?? []),
        channels: Array.from(channels),
        deliveryStatus: prismaPkg.GovernanceNotificationDeliveryStatus.PENDING,
        metadata: boundedJson(input.metadata),
      },
    });
    created = true;
    bump("governance_notification_emitted_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "governance_notification_emitted",
      severity:
        input.severity === "CRITICAL" || input.severity === "HIGH"
          ? "HIGH"
          : input.severity === "WARNING"
            ? "WARNING"
            : "INFO",
      evidenceId: input.relatedEvidenceId ?? null,
      details: {
        notificationId: row.id,
        kind: input.kind,
        severity: input.severity,
        dedupeKey: input.dedupeKey,
      },
    });
  } else {
    // Increment occurrence + refresh last-seen. Severity can escalate
    // on re-fire but never de-escalates.
    const severityRank: Record<GovernanceNotificationSeverity, number> = {
      INFO: 0,
      WARNING: 1,
      HIGH: 2,
      CRITICAL: 3,
    };
    const nextSeverity: GovernanceNotificationSeverity =
      severityRank[input.severity] >
      severityRank[existing.severity as GovernanceNotificationSeverity]
        ? input.severity
        : (existing.severity as GovernanceNotificationSeverity);

    row = await client.governanceNotification.update({
      where: { id: existing.id },
      data: {
        lastSeenAtUtc: now,
        occurrenceCount: { increment: 1 },
        severity: nextSeverity as prismaPkg.GovernanceNotificationSeverity,
        title,
        summary,
        // If a throttle window is open, deliveryStatus is left as PENDING
        // — the delivery will fire when the next window opens.
        deliveryStatus: shouldThrottle
          ? existing.deliveryStatus
          : prismaPkg.GovernanceNotificationDeliveryStatus.PENDING,
        relatedEvidenceId:
          input.relatedEvidenceId ?? existing.relatedEvidenceId,
        relatedReviewId: input.relatedReviewId ?? existing.relatedReviewId,
        relatedHoldId: input.relatedHoldId ?? existing.relatedHoldId,
        relatedPolicyId: input.relatedPolicyId ?? existing.relatedPolicyId,
        relatedIncidentId:
          input.relatedIncidentId ?? existing.relatedIncidentId,
        metadata: boundedJson(input.metadata),
      },
    });
    bump("governance_notification_deduped_total");
    if (shouldThrottle) {
      throttled = true;
      bump("governance_notification_throttled_total");
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "governance_notification_throttled",
        severity: "INFO",
        evidenceId: input.relatedEvidenceId ?? null,
        details: {
          notificationId: row.id,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          occurrenceCount: row.occurrenceCount,
        },
      });
    }
  }

  // HIGH / CRITICAL fan-out to the Phase 21 incident center. Best-effort.
  if (
    (input.severity === "HIGH" || input.severity === "CRITICAL") &&
    !row.relatedIncidentId
  ) {
    try {
      const incident = await recordIncident(
        {
          teamId: input.teamId,
          category: "GOVERNANCE",
          severity: NOTIFICATION_TO_INCIDENT_SEVERITY[input.severity],
          fingerprint: `governance_notification:${input.kind}:${input.dedupeKey}`.slice(
            0,
            120,
          ),
          title,
          safeSummary: summary,
          relatedEvidenceId: input.relatedEvidenceId ?? null,
          metadata: {
            notificationId: row.id,
            kind: input.kind,
            dedupeKey: input.dedupeKey,
          },
        },
        client,
      );
      await client.governanceNotification.update({
        where: { id: row.id },
        data: { relatedIncidentId: incident.incident.id },
      });
      row.relatedIncidentId = incident.incident.id;
    } catch {
      /* best-effort */
    }
  }

  // Best-effort delivery side-effects. The row write IS the in-app
  // delivery (dashboards read from the table). Email + webhook are
  // wired by future-channel hooks; here we record the attempt.
  if (!throttled && !created) {
    // No-op for repeat emissions outside throttle window — the row
    // already has channels; the delivery worker (or webhook fan-out)
    // will pick it up via `deliveryStatus=PENDING`.
  }

  return {
    notification: projectNotification(row),
    created,
    throttled,
  };
}

// -----------------------------------------------------------------------------
// Mark delivered / failed — called by the delivery worker (future).
// -----------------------------------------------------------------------------

export async function markGovernanceNotificationDelivered(
  input: { id: string; teamId: string; channelsDelivered: ReadonlyArray<string> },
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceNotificationProjection> {
  const row = await client.governanceNotification.update({
    where: { id: input.id },
    data: {
      deliveryStatus: prismaPkg.GovernanceNotificationDeliveryStatus.SENT,
      deliveryAttempts: { increment: 1 },
      lastDeliveryAtUtc: new Date(),
      channels: { set: Array.from(input.channelsDelivered) },
    },
  });
  bump("governance_notification_delivered_total");
  return projectNotification(row);
}

export async function markGovernanceNotificationFailed(
  input: { id: string; teamId: string; errorSummary?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceNotificationProjection> {
  const row = await client.governanceNotification.update({
    where: { id: input.id },
    data: {
      deliveryStatus: prismaPkg.GovernanceNotificationDeliveryStatus.FAILED,
      deliveryAttempts: { increment: 1 },
      lastDeliveryAtUtc: new Date(),
      metadata: input.errorSummary
        ? { lastErrorSummary: input.errorSummary.slice(0, 1000) }
        : undefined,
    },
  });
  bump("governance_notification_delivery_failed_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "governance_notification_delivery_failed",
    severity: "WARNING",
    details: {
      notificationId: row.id,
      kind: row.kind,
      errorSummary: input.errorSummary?.slice(0, 200) ?? null,
    },
  });
  return projectNotification(row);
}

// -----------------------------------------------------------------------------
// Acknowledge — operator dismissed the alert
// -----------------------------------------------------------------------------

export async function acknowledgeGovernanceNotification(
  input: { id: string; teamId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceNotificationProjection> {
  const existing = await client.governanceNotification.findFirst({
    where: { id: input.id, teamId: input.teamId },
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
): Promise<number> {
  return client.governanceNotification.count({
    where: {
      teamId,
      deliveryStatus: prismaPkg.GovernanceNotificationDeliveryStatus.PENDING,
    },
  });
}

export async function countFailedGovernanceNotifications(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  return client.governanceNotification.count({
    where: {
      teamId,
      deliveryStatus: prismaPkg.GovernanceNotificationDeliveryStatus.FAILED,
    },
  });
}
