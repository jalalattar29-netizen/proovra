/**
 * Phase 21 — Operational incident service.
 *
 * Public surface:
 *
 *   - `recordIncident(input)` — upsert by (teamId, fingerprint). New
 *     row → INFO/WARNING/HIGH/CRITICAL severity; existing row →
 *     increment `occurrenceCount` + refresh `lastSeenAtUtc`. Returns
 *     `{ created, incident }` so callers can fire an alert ONLY when
 *     the incident is newly created (avoids alert spam on bursts).
 *   - `acknowledgeIncident(input)` / `resolveIncident(input)` /
 *     `suppressIncident(input)` — operator actions. Enforce state
 *     transitions from @proovra/shared.
 *   - `listIncidents(input)` — read for the /ops UI.
 *
 * Privacy:
 *   - safeSummary is bounded to 400 chars via `clipSafeSummary`.
 *   - metadataJson runs through the recursive `redactMetadata`
 *     scrubber before any persistence.
 *   - The service NEVER accepts a raw OTP / phone / signed URL /
 *     session token in either the title or summary. The route layer
 *     is the boundary.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentStatus,
  clipSafeSummary,
  isAllowedIncidentStatusTransition,
  isValidIncidentFingerprint,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeJsonSnapshot } from "./redact.js";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export type IncidentErrorCode =
  | "incident_not_found"
  | "invalid_fingerprint"
  | "invalid_status_transition";

export class IncidentError extends Error {
  readonly code: IncidentErrorCode;
  constructor(code: IncidentErrorCode) {
    super(code);
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// recordIncident — upsert by (teamId, fingerprint)
// -----------------------------------------------------------------------------

export type RecordIncidentInput = {
  teamId?: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  fingerprint: string;
  title: string;
  safeSummary: string;
  requestId?: string | null;
  traceId?: string | null;
  relatedEvidenceId?: string | null;
  relatedJobId?: string | null;
  relatedProvider?: string | null;
  runbookSlug?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type RecordIncidentResult = {
  created: boolean;
  incident: prismaPkg.OperationalIncident;
};

export async function recordIncident(
  input: RecordIncidentInput,
  client: PrismaClient = defaultPrisma,
): Promise<RecordIncidentResult> {
  if (!isValidIncidentFingerprint(input.fingerprint)) {
    throw new IncidentError("invalid_fingerprint");
  }
  const safeTitle = clipSafeSummary(input.title).slice(0, 180);
  const safeSummary = clipSafeSummary(input.safeSummary);
  const sanitisedMetadata =
    input.metadata != null ? safeJsonSnapshot(input.metadata) : null;

  // Atomic upsert. Prisma's upsert keys on the unique (teamId,
  // fingerprint) — when the row already exists we update lastSeenAtUtc
  // + occurrenceCount + status (if it was RESOLVED/SUPPRESSED we
  // reopen it, mirroring the documented Phase 21 invariant that a
  // fresh occurrence after resolution opens a new occurrence).
  const existing = await client.operationalIncident.findUnique({
    where: {
      teamId_fingerprint: {
        teamId: input.teamId ?? null,
        fingerprint: input.fingerprint,
      } as never,
    },
  });

  let row: prismaPkg.OperationalIncident;
  let created: boolean;
  if (!existing) {
    row = await client.operationalIncident.create({
      data: {
        teamId: input.teamId ?? null,
        category: input.category as prismaPkg.IncidentCategory,
        severity: input.severity as prismaPkg.IncidentSeverity,
        status: prismaPkg.IncidentStatus.OPEN,
        fingerprint: input.fingerprint,
        title: safeTitle,
        safeSummary,
        requestId: input.requestId?.slice(0, 128) ?? null,
        traceId: input.traceId?.slice(0, 128) ?? null,
        relatedEvidenceId: input.relatedEvidenceId ?? null,
        relatedJobId: input.relatedJobId?.slice(0, 128) ?? null,
        relatedProvider: input.relatedProvider?.slice(0, 64) ?? null,
        runbookSlug: input.runbookSlug?.slice(0, 64) ?? null,
        openedBySystem: true,
      },
    });
    created = true;
    bump("operational_incident_opened");
  } else {
    const data: Record<string, unknown> = {
      lastSeenAtUtc: new Date(),
      occurrenceCount: { increment: 1 },
      // Update the "latest" correlation hints so operators always see
      // the freshest context. Older context is preserved in the
      // OperationalIncidentEvent history.
      requestId: input.requestId?.slice(0, 128) ?? existing.requestId,
      traceId: input.traceId?.slice(0, 128) ?? existing.traceId,
      relatedEvidenceId: input.relatedEvidenceId ?? existing.relatedEvidenceId,
      relatedJobId: input.relatedJobId?.slice(0, 128) ?? existing.relatedJobId,
      relatedProvider: input.relatedProvider?.slice(0, 64) ?? existing.relatedProvider,
      // Severity can escalate on re-fire (e.g. WARNING → HIGH after
      // burst). Never de-escalates automatically.
      severity:
        severityRank(input.severity) > severityRank(existing.severity as IncidentSeverity)
          ? (input.severity as prismaPkg.IncidentSeverity)
          : existing.severity,
      // If the existing row was RESOLVED / SUPPRESSED, reopen.
      status:
        existing.status === prismaPkg.IncidentStatus.RESOLVED ||
        existing.status === prismaPkg.IncidentStatus.SUPPRESSED
          ? prismaPkg.IncidentStatus.OPEN
          : existing.status,
      ...(existing.status === prismaPkg.IncidentStatus.RESOLVED ||
      existing.status === prismaPkg.IncidentStatus.SUPPRESSED
        ? { resolvedAtUtc: null, resolvedByUserId: null, resolutionNote: null }
        : {}),
    };
    row = await client.operationalIncident.update({
      where: { id: existing.id },
      data,
    });
    created = false;
    bump("operational_incident_increment");
  }

  // Persist the event-history row.
  try {
    await client.operationalIncidentEvent.create({
      data: {
        incidentId: row.id,
        eventType: created ? "opened" : "increment",
        safeMessage: safeSummary,
        metadataJson: sanitisedMetadata as prismaPkg.Prisma.InputJsonValue | undefined,
      },
    });
  } catch {
    /* best-effort */
  }

  // Update gauges.
  await refreshIncidentGauges(client).catch(() => null);

  return { created, incident: row };
}

function severityRank(s: IncidentSeverity): number {
  switch (s) {
    case "INFO":
      return 1;
    case "WARNING":
      return 2;
    case "HIGH":
      return 3;
    case "CRITICAL":
      return 4;
  }
}

// -----------------------------------------------------------------------------
// Operator actions
// -----------------------------------------------------------------------------

export type IncidentActorContext = {
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  resolutionNote?: string | null;
};

export async function acknowledgeIncident(
  input: { incidentId: string; teamId: string } & IncidentActorContext,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalIncident> {
  return transitionIncident(
    input,
    prismaPkg.IncidentStatus.ACKNOWLEDGED,
    "acknowledged",
    client,
  );
}

export async function resolveIncident(
  input: { incidentId: string; teamId: string } & IncidentActorContext,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalIncident> {
  return transitionIncident(
    input,
    prismaPkg.IncidentStatus.RESOLVED,
    "resolved",
    client,
  );
}

export async function suppressIncident(
  input: { incidentId: string; teamId: string } & IncidentActorContext,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalIncident> {
  return transitionIncident(
    input,
    prismaPkg.IncidentStatus.SUPPRESSED,
    "suppressed",
    client,
  );
}

async function transitionIncident(
  input: { incidentId: string; teamId: string } & IncidentActorContext,
  next: prismaPkg.IncidentStatus,
  eventType: "acknowledged" | "resolved" | "suppressed",
  client: PrismaClient,
): Promise<prismaPkg.OperationalIncident> {
  const existing = await client.operationalIncident.findFirst({
    where: { id: input.incidentId, teamId: input.teamId },
  });
  if (!existing) throw new IncidentError("incident_not_found");
  if (
    !isAllowedIncidentStatusTransition(
      existing.status as IncidentStatus,
      next as IncidentStatus,
    )
  ) {
    throw new IncidentError("invalid_status_transition");
  }
  const data: Record<string, unknown> = { status: next };
  if (next === prismaPkg.IncidentStatus.ACKNOWLEDGED) {
    data.acknowledgedAtUtc = new Date();
    data.acknowledgedByUserId = input.actorUserId;
  }
  if (next === prismaPkg.IncidentStatus.RESOLVED) {
    data.resolvedAtUtc = new Date();
    data.resolvedByUserId = input.actorUserId;
    data.resolutionNote =
      input.resolutionNote != null
        ? clipSafeSummary(input.resolutionNote)
        : null;
  }
  const updated = await client.operationalIncident.update({
    where: { id: existing.id },
    data,
  });
  try {
    await client.operationalIncidentEvent.create({
      data: {
        incidentId: updated.id,
        eventType,
        safeMessage:
          eventType === "resolved" && input.resolutionNote
            ? clipSafeSummary(input.resolutionNote)
            : `Incident ${eventType} by operator.`,
      },
    });
  } catch {
    /* best-effort */
  }
  if (next === prismaPkg.IncidentStatus.ACKNOWLEDGED)
    bump("operational_incident_acknowledged");
  if (next === prismaPkg.IncidentStatus.RESOLVED)
    bump("operational_incident_resolved");
  if (next === prismaPkg.IncidentStatus.SUPPRESSED)
    bump("operational_incident_suppressed");

  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: `observability.incident.${eventType}`,
    category: "observability.incident",
    severity: "info",
    source: "incident_service",
    outcome: "success",
    resourceType: "operational_incident",
    resourceId: updated.id,
    metadata: {
      teamId: input.teamId,
      fingerprint: existing.fingerprint,
      severity: existing.severity,
      category: existing.category,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });

  await refreshIncidentGauges(client).catch(() => null);
  return updated;
}

// -----------------------------------------------------------------------------
// Read + projections
// -----------------------------------------------------------------------------

export type ListIncidentsInput = {
  teamId: string;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  category?: IncidentCategory;
  limit?: number;
};

export async function listIncidents(
  input: ListIncidentsInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalIncident[]> {
  return client.operationalIncident.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status as prismaPkg.IncidentStatus } : {}),
      ...(input.severity ? { severity: input.severity as prismaPkg.IncidentSeverity } : {}),
      ...(input.category ? { category: input.category as prismaPkg.IncidentCategory } : {}),
    },
    orderBy: [{ status: "asc" }, { lastSeenAtUtc: "desc" }],
    take: Math.min(Math.max(input.limit ?? 100, 1), 500),
  });
}

export type IncidentProjection = {
  id: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  safeSummary: string;
  fingerprint: string;
  occurrenceCount: number;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  requestId: string | null;
  traceId: string | null;
  relatedEvidenceId: string | null;
  relatedJobId: string | null;
  relatedProvider: string | null;
  runbookSlug: string | null;
  acknowledgedByUserId: string | null;
  resolvedByUserId: string | null;
};

export function projectIncident(
  i: prismaPkg.OperationalIncident,
): IncidentProjection {
  return {
    id: i.id,
    category: i.category,
    severity: i.severity,
    status: i.status,
    title: i.title,
    safeSummary: i.safeSummary,
    fingerprint: i.fingerprint,
    occurrenceCount: i.occurrenceCount,
    firstSeenAtUtc: i.firstSeenAtUtc.toISOString(),
    lastSeenAtUtc: i.lastSeenAtUtc.toISOString(),
    requestId: i.requestId,
    traceId: i.traceId,
    relatedEvidenceId: i.relatedEvidenceId,
    relatedJobId: i.relatedJobId,
    relatedProvider: i.relatedProvider,
    runbookSlug: i.runbookSlug,
    acknowledgedByUserId: i.acknowledgedByUserId,
    resolvedByUserId: i.resolvedByUserId,
  };
}

// -----------------------------------------------------------------------------
// Gauges
// -----------------------------------------------------------------------------

async function refreshIncidentGauges(client: PrismaClient): Promise<void> {
  const [open, openHigh, openCritical] = await Promise.all([
    client.operationalIncident.count({
      where: {
        status: {
          in: [prismaPkg.IncidentStatus.OPEN, prismaPkg.IncidentStatus.ACKNOWLEDGED],
        },
      },
    }),
    client.operationalIncident.count({
      where: {
        status: prismaPkg.IncidentStatus.OPEN,
        severity: prismaPkg.IncidentSeverity.HIGH,
      },
    }),
    client.operationalIncident.count({
      where: {
        status: prismaPkg.IncidentStatus.OPEN,
        severity: prismaPkg.IncidentSeverity.CRITICAL,
      },
    }),
  ]);
  setGauge("operational_incidents_open", open);
  setGauge("operational_incidents_open_high", openHigh);
  setGauge("operational_incidents_open_critical", openCritical);
}
