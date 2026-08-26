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

import {
  decideObservationTransition,
  decisionIsReopen,
  OCCURRENCE_WHILE_SUPPRESSED_EVENT,
  REOPENED_EVENT,
  reopenReasonFor,
  resolveConditionSource,
  RESOLUTION_EVENT_ORIGINS,
  type IncidentTransitionStatus,
  type ResolutionOrigin,
} from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { logger } from "../logger.js";

/**
 * THE RESOLUTION-PROVENANCE TABLE IS NO LONGER COPIED HERE.
 *
 * It used to be a frozen literal in this file AND a frozen literal in the
 * API's incident service — two copies describing the same rows of the same
 * table, the second one annotated "duplicated as data rather than imported".
 * The DECISION that reads it was already shared; the data now is too, and both
 * hosts import `RESOLUTION_EVENT_ORIGINS` from `@proovra/shared-runtime`
 * alongside `decideObservationTransition`.
 *
 * The same move applies to the event-type names below: `reopened` and
 * `occurrence_while_suppressed` were string literals in both writers, so a
 * rename in one would have silently stopped the other's history from being
 * readable by `readResolutionOrigin`.
 */

/**
 * Where the most recent resolution of this condition came from.
 *
 * Never inferred from `resolvedAtUtc` or the note — both paths write those.
 * An unreadable or silent history is LEGACY_UNKNOWN, which reopens with the
 * conservative reason rather than claiming a recurrence.
 */
async function readWorkerResolutionOrigin(
  incidentId: string,
): Promise<ResolutionOrigin> {
  try {
    const latest = await prisma.operationalIncidentEvent.findFirst({
      where: {
        incidentId,
        eventType: { in: Object.keys(RESOLUTION_EVENT_ORIGINS) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { eventType: true },
    });
    if (!latest) return "LEGACY_UNKNOWN";
    return RESOLUTION_EVENT_ORIGINS[latest.eventType] ?? "LEGACY_UNKNOWN";
  } catch {
    return "LEGACY_UNKNOWN";
  }
}

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

// Phase WORKER-INCIDENT-SAFESUMMARY-FIX — operational_incidents.safe_summary
// is `String NOT NULL @db.VarChar(400)` (schema.prisma:5692). A caller
// passing an empty / whitespace-only / undefined `safeSummary` would
// either trip the DB constraint (Postgres rejects NULL even when the
// TS type says `string`, because Prisma silently coerces `undefined` to
// SQL NULL) or write a useless empty row that operators can't read.
//
// The user reported this in prod: when the worker hit
// REPORT_NOT_INCLUDED_IN_PLAN, the bridge tried to record the incident
// and the insert blew up with "null value in column safeSummary",
// hiding the REAL failure from the operator inbox.
//
// Coerce here so EVERY caller gets a deterministic, operator-readable
// fallback even if the input was malformed.
function coerceSafeSummary(raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "(no detail provided)";
}

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
  // Coerce BEFORE clip — if a caller passed empty/undefined, we use a
  // deterministic fallback rather than INSERT NULL into a NOT NULL
  // column and lose the operator-facing record entirely.
  const safeSummary = clipString(coerceSafeSummary(input.safeSummary), SUMMARY_MAX);
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
    // ---------------------------------------------------------------
    // THE LOOKUP IS NARROW, AND THE NULL-TEAM BRANCH IS SEPARATE.
    //
    // Both of those used to be wrong here, in the same two ways the API's
    // canonical writer was:
    //
    //   * NO EXPLICIT SELECT, so Prisma named every scalar column the model
    //     declares. That makes this statement a full-width compatibility
    //     check between the worker image and the database, and one column
    //     the model declares and the database lacks fails EVERY worker
    //     incident identically — the same mechanism that left a production
    //     workspace reporting zero conditions over a real backlog.
    //
    //   * AN `as never` CAST on a compound unique whose `teamId` may be
    //     null. Prisma rejects a null there at runtime, so every
    //     account-tier worker incident threw instead of recording. The cast
    //     made a runtime crash look like a type accommodation, and the
    //     catch below turned the crash into silence.
    //
    // PostgreSQL treats NULLs as DISTINCT in a unique index, so a
    // (NULL, fingerprint) pair never collides with itself and the constraint
    // provides no exclusion for those rows at all. Their dedup is therefore
    // explicitly at this layer, which is where it was always happening.
    // ---------------------------------------------------------------
    const DEDUPE_SELECT = {
      id: true,
      status: true,
      severity: true,
      relatedEvidenceId: true,
    } as const;
    const existing = teamId
      ? await prisma.operationalIncident.findUnique({
          where: { teamId_fingerprint: { teamId, fingerprint } },
          select: DEDUPE_SELECT,
        })
      : await prisma.operationalIncident.findFirst({
          where: { teamId: null, fingerprint },
          orderBy: { firstSeenAtUtc: "asc" },
          select: DEDUPE_SELECT,
        });
    if (!existing) {
      const row = await prisma.operationalIncident.create({
        data: {
          teamId,
          // DERIVED, never defaulted. The column's default is WORKSPACE, so
          // omitting it — which this writer did — stamps WORKSPACE onto a
          // NULL-team row: precisely the contradiction the discriminator was
          // added to make impossible, and it would have made every
          // account-tier worker incident indistinguishable from a deleted
          // workspace's orphan.
          scope: teamId
            ? prismaPkg.IncidentScope.WORKSPACE
            : prismaPkg.IncidentScope.LEGACY_UNSCOPED,
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
    // Re-fire — escalate severity but never de-escalate. WHAT THE
    // OBSERVATION MAY DO TO THE STATUS IS NOT DECIDED HERE.
    //
    // This writer carried its own copy of the reopen rule, and it was the
    // same wrong copy the API carried: RESOLVED and SUPPRESSED both went
    // straight back to OPEN, recorded as an increment. Two copies of a rule
    // are how a fix in one keeps failing in the other, so the decision now
    // comes from `@proovra/shared-runtime` — the same function, the same
    // facts, the same answer as the API.
    const existingSeverity = existing.severity as RecordWorkerIncidentInput["severity"];
    const nextSeverity =
      SEVERITY_RANK[input.severity] > SEVERITY_RANK[existingSeverity]
        ? input.severity
        : existingSeverity;
    const previousResolutionOrigin =
      existing.status === prismaPkg.IncidentStatus.RESOLVED
        ? await readWorkerResolutionOrigin(existing.id)
        : null;
    // THE SAME CONTRACT THE API RESOLVES.
    //
    // Fingerprint first, exactly as the resolve path does, so both processes
    // agree about which source owns this row and therefore about what may be
    // done to it. The worker never resolves a condition, so it consults the
    // contract for its SUPPRESSION and RECURRENCE semantics only — and both of
    // those already flow through `decideObservationTransition` below. Reading
    // it here is what makes that agreement checkable rather than asserted.
    const { lifecycle } = resolveConditionSource({
      category: input.category,
      fingerprint,
    });
    const decision = decideObservationTransition({
      currentStatus: existing.status as IncidentTransitionStatus,
      observation: "SOURCE_ACTIVE",
      previousResolutionOrigin,
    });
    const willReopen = decisionIsReopen(decision);
    const reopenReason = reopenReasonFor(decision);
    const row = await prisma.operationalIncident.update({
      where: { id: existing.id },
      data: {
        lastSeenAtUtc: new Date(),
        occurrenceCount: { increment: 1 },
        severity: severityToPrismaEnum(nextSeverity),
        ...(willReopen
          ? {
              status: prismaPkg.IncidentStatus.OPEN,
              resolvedAtUtc: null,
              resolvedByUserId: null,
              resolutionNote: null,
              // Current cycle only; the history keeps every `acknowledged`
              // event from the cycle that just ended.
              acknowledgedAtUtc: null,
              acknowledgedByUserId: null,
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
          eventType: willReopen
            ? REOPENED_EVENT
            : decision === "PRESERVE_SUPPRESSED"
              ? OCCURRENCE_WHILE_SUPPRESSED_EVENT
              : "increment",
          safeMessage: safeSummary,
          metadataJson: (reopenReason
            ? {
                ...(sanitisedMetadata &&
                typeof sanitisedMetadata === "object" &&
                !Array.isArray(sanitisedMetadata)
                  ? sanitisedMetadata
                  : {}),
                reopenReason,
                decision,
                // Which source's contract governed this transition. Recorded
                // so a reopen written by the Worker and one written by the API
                // are comparable in the history rather than only in prose.
                sourceId: lifecycle.sourceId,
              }
            : sanitisedMetadata) as typeof sanitisedMetadata,
        },
      });
    } catch {
      // best-effort
    }
    return row;
  } catch (err) {
    // ERROR, not warn. This path returns null and every caller treats null as
    // "nothing to do", so a failure here means a condition the worker OBSERVED
    // is not recorded anywhere — the same disappearance the API sweep's bare
    // `catch {}` produced. It may not be logged at a level production filters
    // out, and the code is carried so a schema disagreement is separable from
    // a transient at a glance rather than by re-deriving it from a message.
    logger.error(
      {
        err,
        fingerprint,
        correlationId: input.correlationId ?? null,
        prismaCode:
          typeof (err as { code?: unknown })?.code === "string"
            ? (err as { code: string }).code
            : null,
        teamScoped: teamId != null,
      },
      "worker.incident.record_failed",
    );
    return null;
  }
}
