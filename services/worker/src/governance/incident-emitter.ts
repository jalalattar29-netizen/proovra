/**
 * Phase X.1 — Worker-side canonical operational-incident emitter.
 *
 * Mirrors the contract enforced by Phase 21's
 * `services/api/src/services/observability/incident.service.ts`
 * (`recordIncident`). The two implementations share the same shape
 * because both processes hit the same `operational_incidents` table.
 *
 * Hard rules:
 *   - Upsert by `(teamId, fingerprint)` — never duplicate rows.
 *   - Re-fire of an already-OPEN incident increments
 *     `occurrenceCount` and refreshes `lastSeenAtUtc`.
 *   - RESOLVED or SUPPRESSED rows reopen on re-fire (matches the api
 *     contract).
 *   - Severity escalates on re-fire but never de-escalates.
 *   - This module REPLACES the inline `operationalIncident.upsert`
 *     logic that previously lived in `immutable-storage-reconciliation.worker.ts`.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../db.js";
import { logger } from "../logger.js";

// Phase IA-reliability — accept every IncidentCategory enum value so
// the worker-side bridge can land report / package / OTS / intake /
// integration / reconciliation failures that previously vanished into
// BullMQ DLQs without ever surfacing in /v1/me/inbox.
export type RecordWorkerIncidentInput = {
  teamId?: string | null;
  category:
    | "UPLOAD"
    | "REPORT"
    | "PACKAGE"
    | "WEBHOOK"
    | "COMMUNICATIONS"
    | "IDENTITY_SECURITY"
    | "GOVERNANCE"
    | "STORAGE"
    | "AI"
    | "INTEGRATION"
    | "DATABASE"
    | "WORKER"
    | "RECONCILIATION";
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  fingerprint: string;
  title: string;
  safeSummary: string;
  relatedEvidenceId?: string | null;
  relatedJobId?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown> | null;
};

const SEVERITY_RANK: Record<RecordWorkerIncidentInput["severity"], number> = {
  INFO: 0,
  WARNING: 1,
  HIGH: 2,
  CRITICAL: 3,
};

function severityToPrismaEnum(
  severity: RecordWorkerIncidentInput["severity"],
): prismaPkg.IncidentSeverity {
  switch (severity) {
    case "INFO":
      return prismaPkg.IncidentSeverity.INFO;
    case "WARNING":
      return prismaPkg.IncidentSeverity.WARNING;
    case "HIGH":
      return prismaPkg.IncidentSeverity.HIGH;
    case "CRITICAL":
      return prismaPkg.IncidentSeverity.CRITICAL;
  }
}

function categoryToPrismaEnum(
  category: RecordWorkerIncidentInput["category"],
): prismaPkg.IncidentCategory {
  switch (category) {
    case "UPLOAD":
      return prismaPkg.IncidentCategory.UPLOAD;
    case "REPORT":
      return prismaPkg.IncidentCategory.REPORT;
    case "PACKAGE":
      return prismaPkg.IncidentCategory.PACKAGE;
    case "WEBHOOK":
      return prismaPkg.IncidentCategory.WEBHOOK;
    case "COMMUNICATIONS":
      return prismaPkg.IncidentCategory.COMMUNICATIONS;
    case "IDENTITY_SECURITY":
      return prismaPkg.IncidentCategory.IDENTITY_SECURITY;
    case "GOVERNANCE":
      return prismaPkg.IncidentCategory.GOVERNANCE;
    case "STORAGE":
      return prismaPkg.IncidentCategory.STORAGE;
    case "AI":
      return prismaPkg.IncidentCategory.AI;
    case "INTEGRATION":
      return prismaPkg.IncidentCategory.INTEGRATION;
    case "DATABASE":
      return prismaPkg.IncidentCategory.DATABASE;
    case "WORKER":
      return prismaPkg.IncidentCategory.WORKER;
    case "RECONCILIATION":
      return prismaPkg.IncidentCategory.RECONCILIATION;
  }
}

function clipString(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

const FINGERPRINT_MAX = 120;
const TITLE_MAX = 180;
const SUMMARY_MAX = 400;

function safeJsonSnapshot(
  v: Record<string, unknown>,
): prismaPkg.Prisma.InputJsonValue {
  try {
    const s = JSON.stringify(v);
    if (s.length > 4_000) {
      return { truncated: true } as prismaPkg.Prisma.InputJsonValue;
    }
    return v as unknown as prismaPkg.Prisma.InputJsonValue;
  } catch {
    return { truncated: true } as prismaPkg.Prisma.InputJsonValue;
  }
}

/**
 * Canonical worker incident recording. Replace direct
 * `prisma.operationalIncident.upsert(...)` / `findUnique` + `create`
 * logic with this helper.
 */
export async function recordWorkerIncident(
  input: RecordWorkerIncidentInput,
): Promise<prismaPkg.OperationalIncident | null> {
  if (!input.fingerprint || input.fingerprint.length === 0) {
    logger.warn(
      { correlationId: input.correlationId ?? null },
      "worker.incident.skipped_empty_fingerprint",
    );
    return null;
  }
  const fingerprint = clipString(input.fingerprint, FINGERPRINT_MAX);
  const title = clipString(input.title, TITLE_MAX);
  const safeSummary = clipString(input.safeSummary, SUMMARY_MAX);
  const teamId = input.teamId ?? null;
  const sanitisedMetadata =
    input.metadata != null
      ? safeJsonSnapshot({
          ...(input.correlationId
            ? { correlationId: input.correlationId }
            : {}),
          ...input.metadata,
        })
      : undefined;

  try {
    const existing = await prisma.operationalIncident.findUnique({
      where: {
        teamId_fingerprint: {
          teamId,
          fingerprint,
        } as never,
      },
    });
    if (!existing) {
      const row = await prisma.operationalIncident.create({
        data: {
          teamId,
          category: categoryToPrismaEnum(input.category),
          severity: severityToPrismaEnum(input.severity),
          status: prismaPkg.IncidentStatus.OPEN,
          fingerprint,
          title,
          safeSummary,
          relatedEvidenceId: input.relatedEvidenceId ?? null,
          relatedJobId: input.relatedJobId?.slice(0, 128) ?? null,
          openedBySystem: true,
        },
      });
      try {
        await prisma.operationalIncidentEvent.create({
          data: {
            incidentId: row.id,
            eventType: "opened",
            safeMessage: safeSummary,
            metadataJson: sanitisedMetadata,
          },
        });
      } catch {
        // event history is best-effort
      }
      return row;
    }
    // Re-fire — escalate severity but never de-escalate; reopen if
    // RESOLVED / SUPPRESSED.
    const existingSeverity = existing.severity as RecordWorkerIncidentInput["severity"];
    const nextSeverity =
      SEVERITY_RANK[input.severity] > SEVERITY_RANK[existingSeverity]
        ? input.severity
        : existingSeverity;
    const willReopen =
      existing.status === prismaPkg.IncidentStatus.RESOLVED ||
      existing.status === prismaPkg.IncidentStatus.SUPPRESSED;
    const row = await prisma.operationalIncident.update({
      where: { id: existing.id },
      data: {
        lastSeenAtUtc: new Date(),
        occurrenceCount: { increment: 1 },
        severity: severityToPrismaEnum(nextSeverity),
        status: willReopen
          ? prismaPkg.IncidentStatus.OPEN
          : existing.status,
        ...(willReopen
          ? {
              resolvedAtUtc: null,
              resolvedByUserId: null,
              resolutionNote: null,
            }
          : {}),
        relatedEvidenceId:
          input.relatedEvidenceId ?? existing.relatedEvidenceId,
      },
    });
    try {
      await prisma.operationalIncidentEvent.create({
        data: {
          incidentId: row.id,
          eventType: willReopen ? "reopened" : "increment",
          safeMessage: safeSummary,
          metadataJson: sanitisedMetadata,
        },
      });
    } catch {
      // best-effort
    }
    return row;
  } catch (err) {
    logger.warn(
      { err, fingerprint, correlationId: input.correlationId ?? null },
      "worker.incident.record_failed",
    );
    return null;
  }
}
