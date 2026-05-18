/**
 * Phase X.1 — Worker-side canonical governance-notification emitter.
 *
 * Mirrors the contract enforced by
 * `services/api/src/services/governance-lifecycle/governance-notification.service.ts`
 * using the SAME shared catalog (`@proovra/shared` —
 * NOTIFICATION_THROTTLE_SECONDS, DEFAULT_NOTIFICATION_CHANNELS,
 * NOTIFICATION_TO_INCIDENT_SEVERITY, isValidDedupeKey, severity
 * escalation rank). DB writes happen in this process because the
 * worker is a separate runtime — but the DECISION FORMULA is shared.
 *
 * Hard rules:
 *   - Dedupe at the DB layer via the unique `(team_id, kind,
 *     dedupe_key)` constraint. The emitter NEVER produces two rows
 *     for the same key.
 *   - Throttle delivery (not row creation) using
 *     `NOTIFICATION_THROTTLE_SECONDS[severity]`. A throttled emission
 *     still increments `occurrenceCount` and refreshes `lastSeenAtUtc`,
 *     but `deliveryStatus` stays at the existing value.
 *   - Severity escalates on re-fire but never de-escalates.
 *   - HIGH / CRITICAL emissions fan out into the Phase 21 incident
 *     center via the worker's local incident emitter — best-effort,
 *     never breaks the row write.
 *
 * This module REPLACES the inline `prisma.governanceNotification.upsert`
 * calls that previously lived in three Phase 27.5 workers.
 */

import * as prismaPkg from "@prisma/client";
import {
  DEDUPE_KEY_MAX_LEN,
  DEFAULT_NOTIFICATION_CHANNELS,
  GOVERNANCE_NOTIFICATION_KINDS,
  GOVERNANCE_NOTIFICATION_SEVERITIES,
  NOTIFICATION_SUMMARY_MAX_LEN,
  NOTIFICATION_THROTTLE_SECONDS,
  NOTIFICATION_TITLE_MAX_LEN,
  isValidDedupeKey,
  type GovernanceNotificationKind,
  type GovernanceNotificationSeverity,
} from "@proovra/shared";

import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { recordWorkerIncident } from "./incident-emitter.js";

// -----------------------------------------------------------------------------
// Input contract — matches the api service's EmitGovernanceNotificationInput
// exactly. Future drift triggers a test failure (see
// phase-x1-architecture-closure.test.ts).
// -----------------------------------------------------------------------------

export type EmitWorkerGovernanceNotificationInput = {
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
  /** Correlation id from the worker execution context. Threaded
   *  through the metadata so operators can stitch the flow end-to-end. */
  correlationId?: string;
};

export type EmitWorkerGovernanceNotificationResult = {
  id: string;
  created: boolean;
  throttled: boolean;
  severity: GovernanceNotificationSeverity;
};

const VALID_KINDS = new Set<string>(GOVERNANCE_NOTIFICATION_KINDS);
const VALID_SEVERITIES = new Set<string>(GOVERNANCE_NOTIFICATION_SEVERITIES);
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

const SEVERITY_RANK: Record<GovernanceNotificationSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  HIGH: 2,
  CRITICAL: 3,
};

function scrubMetadata(input: unknown): unknown {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") {
    if (typeof input === "string") return input.slice(0, 500);
    return input;
  }
  if (Array.isArray(input)) return input.slice(0, 50).map(scrubMetadata);
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

function resolveChannels(severity: GovernanceNotificationSeverity): string[] {
  return Array.from(DEFAULT_NOTIFICATION_CHANNELS[severity]);
}

export class WorkerGovernanceNotificationError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "INVALID_DEDUPE_KEY",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "WorkerGovernanceNotificationError";
  }
}

/**
 * Canonical worker notification emission. Replace direct
 * `prisma.governanceNotification.upsert(...)` calls with this helper.
 */
export async function emitWorkerGovernanceNotification(
  input: EmitWorkerGovernanceNotificationInput,
): Promise<EmitWorkerGovernanceNotificationResult> {
  if (!VALID_KINDS.has(input.kind)) {
    throw new WorkerGovernanceNotificationError("INVALID_INPUT", {
      field: "kind",
    });
  }
  if (!VALID_SEVERITIES.has(input.severity)) {
    throw new WorkerGovernanceNotificationError("INVALID_INPUT", {
      field: "severity",
    });
  }
  if (!isValidDedupeKey(input.dedupeKey)) {
    throw new WorkerGovernanceNotificationError("INVALID_DEDUPE_KEY", {
      dedupeKey: input.dedupeKey?.slice(0, DEDUPE_KEY_MAX_LEN),
    });
  }
  const title = input.title.trim().slice(0, NOTIFICATION_TITLE_MAX_LEN);
  const summary = input.summary.trim().slice(0, NOTIFICATION_SUMMARY_MAX_LEN);
  if (!title || !summary) {
    throw new WorkerGovernanceNotificationError("INVALID_INPUT", {
      field: !title ? "title" : "summary",
    });
  }
  const channels = resolveChannels(input.severity);

  // Encode correlation id into metadata for the audit chain. Operators
  // grep on `correlationId` to stitch the flow end-to-end.
  const metadataWithCorrelation =
    input.correlationId || input.metadata
      ? {
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          ...(input.metadata ?? {}),
        }
      : null;

  const existing = await prisma.governanceNotification.findUnique({
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

  let row: prismaPkg.GovernanceNotification;
  let created = false;
  let throttled = false;
  let finalSeverity: GovernanceNotificationSeverity = input.severity;

  if (!existing) {
    row = await prisma.governanceNotification.create({
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
        channels,
        deliveryStatus: prismaPkg.GovernanceNotificationDeliveryStatus.PENDING,
        metadata: boundedJson(metadataWithCorrelation),
      },
    });
    created = true;
  } else {
    // Severity escalates but never de-escalates.
    finalSeverity =
      SEVERITY_RANK[input.severity] >
      SEVERITY_RANK[existing.severity as GovernanceNotificationSeverity]
        ? input.severity
        : (existing.severity as GovernanceNotificationSeverity);
    row = await prisma.governanceNotification.update({
      where: { id: existing.id },
      data: {
        lastSeenAtUtc: now,
        occurrenceCount: { increment: 1 },
        severity: finalSeverity as prismaPkg.GovernanceNotificationSeverity,
        title,
        summary,
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
        metadata: boundedJson(metadataWithCorrelation),
      },
    });
    throttled = Boolean(shouldThrottle);
  }

  // HIGH / CRITICAL fan-out — best-effort, never breaks the row write.
  if (
    (finalSeverity === "HIGH" || finalSeverity === "CRITICAL") &&
    !row.relatedIncidentId
  ) {
    try {
      const incident = await recordWorkerIncident({
        teamId: input.teamId,
        category: "GOVERNANCE",
        severity: finalSeverity,
        fingerprint:
          `governance_notification:${input.kind}:${input.dedupeKey}`.slice(0, 120),
        title,
        safeSummary: summary,
        relatedEvidenceId: input.relatedEvidenceId ?? null,
        correlationId: input.correlationId,
        metadata: {
          notificationId: row.id,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
        },
      });
      if (incident) {
        await prisma.governanceNotification.update({
          where: { id: row.id },
          data: { relatedIncidentId: incident.id },
        });
      }
    } catch (err) {
      logger.warn(
        { err, notificationId: row.id, correlationId: input.correlationId },
        "worker.notification.incident_fanout_failed",
      );
    }
  }

  if (created) {
    logger.info(
      {
        notificationId: row.id,
        kind: input.kind,
        severity: finalSeverity,
        correlationId: input.correlationId,
      },
      "worker.notification.emitted",
    );
  } else if (throttled) {
    logger.info(
      {
        notificationId: row.id,
        kind: input.kind,
        occurrenceCount: row.occurrenceCount,
        correlationId: input.correlationId,
      },
      "worker.notification.throttled",
    );
  }

  return {
    id: row.id,
    created,
    throttled,
    severity: finalSeverity,
  };
}
