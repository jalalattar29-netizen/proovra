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

import {
  CONDITION_STILL_ACTIVE,
  decideManualResolution,
  decideObservationTransition,
  decisionIsReopen,
  reopenReasonFor,
  type IncidentTransitionDecision,
  type IncidentTransitionStatus,
  type ResolutionOrigin,
  type SourceObservation,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import {
  scopeForWorkspaceId,
  workspaceIncidentWhere,
} from "./incident-scope.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeJsonSnapshot } from "./redact.js";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export type IncidentErrorCode =
  | "incident_not_found"
  | "invalid_fingerprint"
  | "invalid_status_transition"
  /**
   * An operator tried to declare a condition resolved while its own source
   * still says it is failing. Refused rather than accepted-and-silently-undone:
   * the sweep would have reopened it minutes later, and a status that flips
   * back on its own teaches operators that the button does not mean anything.
   */
  | typeof CONDITION_STILL_ACTIVE;

export class IncidentError extends Error {
  readonly code: IncidentErrorCode;
  constructor(code: IncidentErrorCode) {
    super(code);
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// DURABLE RESOLUTION PROVENANCE
// -----------------------------------------------------------------------------

/**
 * The event types that record a resolution, and what each one means.
 *
 * Provenance is read from the EVENT HISTORY and from nothing else. Neither
 * `resolvedAtUtc`, nor `resolvedByUserId`, nor the note, nor elapsed time can
 * distinguish "the source recovered" from "a person said it was fine": the
 * first two are written by both paths and the last is written by neither.
 */
export const RESOLUTION_EVENT_ORIGINS: Readonly<Record<string, ResolutionOrigin>> =
  Object.freeze({
    /** Written by `resolveRecoveredConditions` from the record's own status. */
    resolved_by_domain_truth: "SOURCE_RECOVERY",
    /** Written by `transitionIncident` when an operator resolved it. */
    resolved: "OPERATOR",
  });

/** The canonical event type for a reopen. Never an `increment`. */
export const REOPENED_EVENT = "reopened";
/** The canonical event type for a still-failing suppressed condition. */
export const OCCURRENCE_WHILE_SUPPRESSED_EVENT = "occurrence_while_suppressed";

/**
 * Where the MOST RECENT resolution of this condition came from.
 *
 * Returns `LEGACY_UNKNOWN` when the history holds no resolution event — which
 * is the honest answer for every row resolved before this vocabulary existed,
 * and for any row whose event write was lost. It is never upgraded to
 * SOURCE_RECOVERY by guesswork: that would launder a premature operator close
 * into a recurrence and erase the distinction this function exists to make.
 */
export async function readResolutionOrigin(
  incidentId: string,
  client: PrismaClient,
): Promise<ResolutionOrigin> {
  try {
    const latest = await client.operationalIncidentEvent.findFirst({
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
    // The history is unreadable. That is ambiguity, not a recurrence.
    return "LEGACY_UNKNOWN";
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
  // WORKSPACE-SCOPE CONVERGENCE — the NULL-team branch is a separate lookup,
  // and it has to be.
  //
  // The compound unique `(teamId, fingerprint)` CANNOT be queried with a null
  // teamId: Prisma rejects `Argument \`teamId\` must not be null` at runtime.
  // The `as never` cast that used to sit here hid exactly that from the
  // compiler, so `security-event.service.ts` — whose `input.teamId ?? null`
  // records account-tier events — threw on every such write instead of
  // recording one. The cast made a runtime crash look like a type
  // accommodation.
  //
  // It could not have deduplicated them either. PostgreSQL treats NULLs as
  // DISTINCT in a unique index, so `(NULL, 'fingerprint')` never collides with
  // itself and the constraint provides no exclusion at all for these rows. The
  // dedup for them is therefore explicitly at the application layer, which is
  // where it was always actually happening.
  // ---------------------------------------------------------------------
  // THE LOOKUP IS EXPLICITLY NARROW, AND THAT IS NOT A MICRO-OPTIMISATION.
  //
  // Both branches used to carry no `select`, which makes Prisma request EVERY
  // scalar column the model declares. That turned this statement into a
  // full-width compatibility check between the image's data model and the
  // database, executed before any condition-specific logic ran — so ONE
  // column the model declared and the database lacked failed the FIRST
  // statement of every recordIncident call, identically for every category.
  //
  // The observed production signature was exactly that: six sources that
  // write all failed, five sources that only read all succeeded, and the
  // workspace showed zero conditions over a real backlog.
  //
  // What is selected here is precisely what the code below reads, and nothing
  // else. It is deliberately NOT a fix for a schema disagreement — the create
  // and update below still return full rows and would still fail against a
  // database missing a declared column, which is correct: masking a
  // deployment mismatch inside the writer would hide it until something
  // worse found it. `operations-writer-schema-contract.ts` is what refuses to
  // report Healthy in that state.
  // ---------------------------------------------------------------------
  const DEDUPE_SELECT = {
    id: true,
    status: true,
    severity: true,
    requestId: true,
    traceId: true,
    relatedEvidenceId: true,
    relatedJobId: true,
    relatedProvider: true,
  } as const;

  const existing = input.teamId
    ? await client.operationalIncident.findUnique({
        where: {
          teamId_fingerprint: {
            teamId: input.teamId,
            fingerprint: input.fingerprint,
          },
        },
        select: DEDUPE_SELECT,
      })
    : await client.operationalIncident.findFirst({
        where: { teamId: null, fingerprint: input.fingerprint },
        orderBy: { firstSeenAtUtc: "asc" },
        select: DEDUPE_SELECT,
      });

  let row: prismaPkg.OperationalIncident;
  let created: boolean;
  let existingStatusBeforeWrite: prismaPkg.IncidentStatus | null = null;
  /** What the shared authority decided. A create is not a decision it makes. */
  let decision: IncidentTransitionDecision = "OBSERVATION_ONLY";
  if (!existing) {
    row = await client.operationalIncident.create({
      data: {
        teamId: input.teamId ?? null,
        // WORKSPACE-SCOPE CONVERGENCE — the scope is DERIVED here, never
        // defaulted. Relying on the column default would write WORKSPACE onto
        // a NULL-team row, which is precisely the contradiction the
        // discriminator exists to make impossible.
        scope: scopeForWorkspaceId(input.teamId),
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
    // ---------------------------------------------------------------------
    // ONE AUTHORITY DECIDES WHAT AN OBSERVATION MAY DO.
    //
    // This branch used to reopen RESOLVED and SUPPRESSED rows unconditionally
    // and record the result as an `increment`. That destroyed the resolver
    // identity and the operator note, and left no event saying a reopen had
    // happened — so a genuine recurrence and a silently-erased decision were
    // indistinguishable afterwards.
    //
    // The rule now lives in `@proovra/shared-runtime`, which the Worker writer
    // consumes too. This service still owns every read and write; what it no
    // longer owns is a second copy of the rule.
    // ---------------------------------------------------------------------
    // Provenance is read ONLY when it can matter — a RESOLVED row facing an
    // active observation — so an ordinary re-fire costs no extra query.
    const previousResolutionOrigin =
      existing.status === prismaPkg.IncidentStatus.RESOLVED
        ? await readResolutionOrigin(existing.id, client)
        : null;
    decision = decideObservationTransition({
      currentStatus: existing.status as IncidentTransitionStatus,
      // Every call to `recordIncident` IS an active observation: it is called
      // because a source saw the condition. Recovery is observed elsewhere,
      // by `resolveRecoveredConditions`, from the domain own truth.
      observation: "SOURCE_ACTIVE" satisfies SourceObservation,
      previousResolutionOrigin,
    });
    const reopening = decisionIsReopen(decision);

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
      // STATUS IS WRITTEN ONLY BY A REOPEN. OBSERVATION_ONLY,
      // PRESERVE_ACKNOWLEDGED and PRESERVE_SUPPRESSED all leave it alone,
      // which is the whole correction: an observation records that the
      // condition is still true and says nothing about who owns it or who
      // silenced it.
      ...(reopening
        ? {
            status: prismaPkg.IncidentStatus.OPEN,
            resolvedAtUtc: null,
            resolvedByUserId: null,
            resolutionNote: null,
            // CURRENT-CYCLE acknowledgement only. The `acknowledged` events
            // from the previous cycle stay in the history untouched: the row
            // says nobody owns THIS occurrence, and the history still says
            // who owned the last one.
            acknowledgedAtUtc: null,
            acknowledgedByUserId: null,
          }
        : {}),
    };
    // Captured BEFORE the write, so anything downstream reads the state the
    // decision was made against rather than the state it produced.
    existingStatusBeforeWrite = existing.status;
    row = await client.operationalIncident.update({
      where: { id: existing.id },
      data,
    });
    created = false;
    bump(
      reopening
        ? "operational_incident_reopened"
        : "operational_incident_increment",
    );
  }

  // Persist the event-history row.
  //
  // THE EVENT NAMES THE TRANSITION. A reopen arriving in the history as an
  // `increment` is the defect this correction removes: an operator reading the
  // timeline could not tell that their resolution had been undone, or why.
  const eventType = created
    ? "opened"
    : decisionIsReopen(decision)
      ? REOPENED_EVENT
      : decision === "PRESERVE_SUPPRESSED"
        ? OCCURRENCE_WHILE_SUPPRESSED_EVENT
        : "increment";
  const reopenReason = reopenReasonFor(decision);
  try {
    await client.operationalIncidentEvent.create({
      data: {
        incidentId: row.id,
        eventType,
        safeMessage:
          decision === "PRESERVE_SUPPRESSED"
            ? "The condition is still true. It remains suppressed by operator decision."
            : reopenReason === "SOURCE_RECURRENCE"
              ? "The source reported this condition again after it had recovered. Reopened as a new operational cycle; the previous cycle history is unchanged."
              : reopenReason === "ACTIVE_SOURCE_AFTER_LEGACY_MANUAL_RESOLUTION"
                ? "The source still reports this condition, and the previous resolution was not a recorded source recovery. Reopened once, explicitly; the previous resolution and its note remain in the history."
                : safeSummary,
        metadataJson: (reopenReason
          ? { ...(sanitisedMetadata ?? {}), reopenReason, decision }
          : sanitisedMetadata) as prismaPkg.Prisma.InputJsonValue | undefined,
      },
    });
  } catch {
    /* best-effort */
  }

  /**
   * THE SLA PROMISE.
   *
   * Opened when a condition QUALIFIES: on first observation, and again when a
   * resolved or suppressed condition recurs. A re-fire of a condition that is
   * still open does NOT restart it — the cycle service refuses that, because
   * a promise about one occurrence cannot be reset by the same occurrence
   * happening again.
   *
   * Deliberately outside the event try/catch above and deliberately awaited:
   * a condition recorded WITHOUT its promise would read as UNTRACKED_LEGACY
   * forever, which is a permanent hole in the record rather than a transient
   * failure. Its own errors are swallowed for the same reason the event write
   * swallows its own — an SLA bookkeeping fault must not lose the observation
   * of the condition itself.
   */
  // A REOPEN is a new qualification; nothing else is.
  //
  // A suppressed condition re-firing is deliberately excluded: suppression
  // silences notification without stopping the clock, so its cycle is still
  // LIVE and `openSlaCycle` would decline anyway. Naming it here would suggest
  // a new promise begins when a silenced condition re-fires, and it does not —
  // the original promise was never discharged.
  const reopened = !created && decisionIsReopen(decision);
  // Read once so the captured pre-write status is not an unused binding; the
  // decision above is what the SLA follows.
  void existingStatusBeforeWrite;
  // A workspace-less condition gets no cycle: an SLA promise is a promise BY
  // a workspace, and one with no tenant has nobody to have made it.
  const cycleTeamId = row.teamId ?? input.teamId ?? null;
  if ((created || reopened) && cycleTeamId) {
    try {
      const { openSlaCycle, closeSlaCycle } = await import(
        "../operations/incident-sla-cycle.service.js"
      );
      // A reopen closes whatever cycle is still live before starting the new
      // one. `openSlaCycle` declines while a live cycle exists, so without this
      // a legacy row whose resolution never closed its cycle would reopen with
      // no new promise at all — the reopen would be recorded and the
      // commitment would silently still be the old one.
      if (reopened) {
        await closeSlaCycle({ incidentId: row.id, reason: "REOPENED" }, client);
      }
      await openSlaCycle(
        {
          teamId: cycleTeamId,
          incidentId: row.id,
          severity: row.severity,
          // Measured from the instant the occurrence was OBSERVED, not from
          // now: the two differ under retry and backlog, and the observation
          // is the one the workspace made a promise about.
          startedAtUtc: reopened ? row.lastSeenAtUtc : row.firstSeenAtUtc,
        },
        client,
      );
    } catch {
      /* best-effort; never loses the condition itself */
    }
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

/**
 * Phase 32.8C control plane — assignIncident.
 *
 * Sets `assignedOperatorUserId` + `assignedByUserId` + `assignedAtUtc`.
 * Does NOT change `status`. Audited via the platform audit log. Idempotent:
 * re-assigning to the same operator updates `assignedAtUtc` only.
 */
/**
 * Assign, REASSIGN or UNASSIGN a condition's operator.
 *
 * CLOSURE PASS (2026-08-22) — `assigneeUserId: null` is UNASSIGN.
 *
 * One column, one transition, one authorization path. A separate /unassign
 * endpoint would have given the same state change a second gate to keep in
 * step with this one, which is how the two drift.
 *
 * ATTRIBUTION SURVIVES. Unassigning clears the CURRENT owner and leaves the
 * history intact: the `assigned` / `unassigned` events stay on the incident,
 * so "who had this, and when did they give it up" is still answerable after
 * the person has left the workspace entirely.
 */
export async function assignIncident(
  input: {
    incidentId: string;
    teamId: string;
    /** NULL unassigns. */
    assigneeUserId: string | null;
  } & IncidentActorContext,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.OperationalIncident> {
  const existing = await client.operationalIncident.findFirst({
    where: { id: input.incidentId, ...workspaceIncidentWhere(input.teamId) },
  });
  if (!existing) throw new IncidentError("incident_not_found");
  // Captured BEFORE the write, so the audit event can record what the
  // assignment actually changed rather than only where it landed.
  const previousAssigneeUserId = existing.assignedOperatorUserId;
  const isUnassign = input.assigneeUserId === null;
  const updated = await client.operationalIncident.update({
    where: { id: existing.id },
    data: {
      assignedOperatorUserId: input.assigneeUserId,
      // On unassign the actor and timestamp are cleared too: leaving them
      // would render as "assigned by X at T" beside an empty owner.
      assignedByUserId: isUnassign ? null : input.actorUserId,
      assignedAtUtc: isUnassign ? null : new Date(),
    },
  });
  try {
    await client.operationalIncidentEvent.create({
      data: {
        incidentId: updated.id,
        eventType: isUnassign ? "unassigned" : "assigned",
        safeMessage: isUnassign
          ? "Condition returned to the unassigned queue."
          : `Condition assigned to operator ${input.assigneeUserId!.slice(0, 8)}.`,
      },
    });
  } catch {
    /* best-effort */
  }
  bump("operational_incident_assigned");

  await emitTenantAudit(
    {
      action: isUnassign
        ? "observability.incident.unassigned"
        : "observability.incident.assigned",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: existing.teamId,
      resourceType: "operational_incident",
      resourceId: updated.id,
      metadata: {
        // The full transition, so the audit answers "who moved this, from
        // whom, to whom" rather than only naming the destination.
        assigneeUserId: input.assigneeUserId,
        previousAssigneeUserId,
        fingerprint: existing.fingerprint,
        severity: existing.severity,
        category: existing.category,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    },
    client,
  );

  return updated;
}

/**
 * IS THIS CONDITION STILL TRUE, RIGHT NOW?
 *
 * Only for conditions the registry declares SOURCE_TRUTH — the ones with a
 * deterministic, per-incident probe. Everything else returns null, which the
 * shared authority reads as "no probe was made" and which only matters for
 * SOURCE_TRUTH conditions anyway.
 *
 * The probe is the SAME column `resolveRecoveredConditions` reads. That is the
 * point: if the sweep would reopen a condition seconds after an operator
 * closed it, the close is refused up front instead of being accepted and
 * silently undone.
 *
 * A record that cannot be read returns null and is therefore refused. "We
 * could not check" is not "it is fine".
 */
async function probeSourceActivity(
  incident: { category: string; fingerprint: string },
  client: PrismaClient,
): Promise<SourceObservation | null> {
  if (incident.category !== "EVIDENCE_INTEGRITY") return null;
  try {
    const integrity = await import(
      "../operations/evidence-integrity-conditions.service.js"
    );
    const parts = integrity.parseIntegrityFingerprint(incident.fingerprint);
    if (!parts) return null;
    const record = await client.evidence.findUnique({
      where: { id: parts.evidenceId },
      select: { tsaStatus: true, otsStatus: true },
    });
    if (!record) return null;
    return integrity.isCurrentlyFailing(record, parts.integrityClass)
      ? "SOURCE_ACTIVE"
      : "SOURCE_RECOVERED";
  } catch {
    return null;
  }
}

async function transitionIncident(
  input: { incidentId: string; teamId: string } & IncidentActorContext,
  next: prismaPkg.IncidentStatus,
  eventType: "acknowledged" | "resolved" | "suppressed",
  client: PrismaClient,
): Promise<prismaPkg.OperationalIncident> {
  const existing = await client.operationalIncident.findFirst({
    where: { id: input.incidentId, ...workspaceIncidentWhere(input.teamId) },
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

  // ---------------------------------------------------------------------
  // AN OPERATOR MAY NOT DECLARE AN ACTIVE DETERMINISTIC CONDITION RESOLVED.
  //
  // Accepting it was worse than refusing it: the row read RESOLVED until the
  // next sweep, which reopened it with no explanation, and the operator
  // learned that the button does not mean anything. The refusal happens
  // BEFORE any write, so a refused resolve leaves status, timestamps, note,
  // events and SLA cycles exactly as they were.
  //
  // Which conditions this applies to is declared in the canonical remediation
  // registry, never derived here from a category list, a severity or a plan.
  // ---------------------------------------------------------------------
  if (next === prismaPkg.IncidentStatus.RESOLVED) {
    const { operatorResolutionAuthorityFor } = await import(
      "../operations/remediation-registry.js"
    );
    const authority = operatorResolutionAuthorityFor({
      category: existing.category,
    });
    const verdict = decideManualResolution({
      currentStatus: existing.status as IncidentTransitionStatus,
      authority,
      observation:
        authority === "SOURCE_TRUTH"
          ? await probeSourceActivity(
              { category: existing.category, fingerprint: existing.fingerprint },
              client,
            )
          : null,
    });
    if (verdict === "REFUSE_MANUAL_RESOLUTION") {
      throw new IncidentError(CONDITION_STILL_ACTIVE);
    }
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

  /**
   * THE SLA CYCLE FOLLOWS THE LIFECYCLE.
   *
   * Each transition latches whatever deadlines have already passed BEFORE it
   * records the transition, so a breach is written at the moment it is
   * observed rather than inferred later from a clock that has moved on.
   *
   * Acknowledgement stops only the acknowledgement clock. Resolution closes
   * the cycle. Suppression closes it too, but keeps the latched breach flags —
   * silencing a condition is an instruction about notification, not a way to
   * un-miss a deadline.
   */
  try {
    const cycles = await import("../operations/incident-sla-cycle.service.js");
    if (next === prismaPkg.IncidentStatus.ACKNOWLEDGED) {
      await cycles.recordSlaAcknowledgement({ incidentId: updated.id }, client);
    } else if (next === prismaPkg.IncidentStatus.RESOLVED) {
      await cycles.closeSlaCycle(
        { incidentId: updated.id, reason: "RESOLVED" },
        client,
      );
    } else if (next === prismaPkg.IncidentStatus.SUPPRESSED) {
      await cycles.suppressSlaCycle({ incidentId: updated.id }, client);
    }
  } catch {
    /* best-effort; never blocks an authorized transition */
  }

  if (next === prismaPkg.IncidentStatus.ACKNOWLEDGED)
    bump("operational_incident_acknowledged");
  if (next === prismaPkg.IncidentStatus.RESOLVED)
    bump("operational_incident_resolved");
  if (next === prismaPkg.IncidentStatus.SUPPRESSED)
    bump("operational_incident_suppressed");

  await emitTenantAudit(
    {
      action: `observability.incident.${eventType}`,
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: existing.teamId,
      resourceType: "operational_incident",
      resourceId: updated.id,
      metadata: {
        fingerprint: existing.fingerprint,
        severity: existing.severity,
        category: existing.category,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    },
    client,
  );

  await refreshIncidentGauges(client).catch(() => null);
  return updated;
}

// -----------------------------------------------------------------------------
// Read + projections
// -----------------------------------------------------------------------------

/**
 * How the workbench asks for an ORDER.
 *
 * Every one of these resolves to an orderBy whose LAST key is `id`, so the
 * ordering is total. That is not tidiness: keyset pagination over a
 * non-deterministic order silently skips and repeats rows, and on a surface
 * whose job is "have we dealt with everything?" a skipped row is a condition
 * nobody ever sees.
 */
export type IncidentSort = "recent" | "severity" | "oldest" | "occurrences";

/**
 * Ownership filter.
 *
 * UNASSIGNED is a first-class value rather than `userId: null`, because
 * "nobody owns this" is the state a shared workspace triages from and it must
 * not be expressible only as the absence of a filter.
 */
export type IncidentOwnerFilter =
  | { kind: "ANY" }
  | { kind: "UNASSIGNED" }
  | { kind: "USER"; userId: string };

export type ListIncidentsInput = {
  /** One posture from the closed SLA vocabulary, or null for no SLA filter. */
  sla?: string | null;
  /** Injectable clock, so the predicate is testable against fixed instants. */
  now?: Date;
  teamId: string;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  category?: IncidentCategory;
  /**
   * Ownership. Resolved by the ROUTE — "assigned to me" becomes a concrete
   * user id before it reaches here, so this layer never has to know who is
   * asking and cannot accidentally scope a workspace read to a caller.
   */
  owner?: IncidentOwnerFilter;
  /**
   * Free-text over the operator-facing strings ONLY (title + safe summary).
   *
   * Deliberately not over `fingerprint`, `requestId` or `traceId`: those are
   * exact-match identifiers, and a substring search across them turns a typo
   * into a plausible-looking wrong row.
   */
  q?: string;
  sort?: IncidentSort;
  limit?: number;
  /**
   * PHASE 2.7 — keyset cursor. The `id` of the last row the caller received.
   * An opaque token to the client; a unique key to the database.
   */
  cursor?: string | null;
};

export type ListIncidentsPage = {
  incidents: prismaPkg.OperationalIncident[];
  /** Pass back verbatim for the next page. Null when the caller has seen all. */
  nextCursor: string | null;
  /**
   * PHASE 2.2 — did this read reach the end of the collection?
   *
   * `false` means MORE ROWS EXIST, and no caller may conclude anything from an
   * incident's absence in this page. Operations is a mutable collection; a
   * partial read of it is not evidence that anything was resolved.
   */
  complete: boolean;
};

/**
 * ONE PAGE of workspace incidents, ordered deterministically.
 *
 * PAGINATION (Phase 2.7). This used to be a bare `take` with no cursor: the
 * console asked for up to 500 rows and got the first 500 under a NON-UNIQUE
 * ordering, with no way to ask for the rest and no signal that a rest existed.
 * Two defects in one — a silent cap on a mutable operational collection, and
 * an unstable order (`status` + `lastSeenAtUtc` tie constantly; a fan-out
 * writes many incidents in the same millisecond), so even re-reading the same
 * page could return a different set.
 *
 * The ordering now ends in `id`, which makes it TOTAL, which is exactly the
 * precondition keyset pagination needs. `cursor` + `skip: 1` then walks the
 * collection without offsets, so rows inserted or resolved between pages
 * cannot cause a skip or a duplicate the way `OFFSET n` does.
 */
/**
 * Sort key to a TOTAL order.
 *
 * The default ("recent") keeps the ordering the console has always had: OPEN
 * before ACKNOWLEDGED before the closed states, then most-recently-seen. That
 * is the triage order, and it stays the default because the answer to "what
 * should I look at" should not depend on remembering to pick a sort.
 *
 * `severity: "desc"` relies on the enum being declared INFO, WARNING, HIGH,
 * CRITICAL in schema.prisma — Postgres orders an enum by declaration order, so
 * descending puts CRITICAL first. Reordering that enum would silently invert
 * this sort, which is why `incident-list-order.test.ts` asserts the resulting
 * sequence rather than the clause.
 */
function orderByFor(
  sort: IncidentSort | undefined,
): prismaPkg.Prisma.OperationalIncidentOrderByWithRelationInput[] {
  switch (sort) {
    case "severity":
      return [{ severity: "desc" }, { lastSeenAtUtc: "desc" }, { id: "desc" }];
    case "oldest":
      return [{ firstSeenAtUtc: "asc" }, { id: "asc" }];
    case "occurrences":
      return [{ occurrenceCount: "desc" }, { lastSeenAtUtc: "desc" }, { id: "desc" }];
    default:
      return [{ status: "asc" }, { lastSeenAtUtc: "desc" }, { id: "desc" }];
  }
}

/**
 * TRANSLATE AN SLA POSTURE INTO A DATABASE PREDICATE.
 *
 * The one place where the posture vocabulary becomes SQL. It must agree with
 * `projectIncidentSla` exactly — a filter that selected different rows from
 * the ones the badge marks would be the second SLA authority this closure
 * removed, just hidden in a WHERE clause. A conservation test drives both and
 * asserts they select the same set.
 *
 * BREACHED is deliberately `latched OR past due`, matching the projection:
 * once a promise is missed the condition stays in the breached set for the
 * rest of the cycle, so acknowledging it late does not quietly remove it from
 * the workspace's own report.
 */
function slaWhere(
  posture: string | null,
  now: Date,
): prismaPkg.Prisma.OperationalIncidentWhereInput {
  if (!posture) return {};

  // Only the LIVE cycle is considered. A SUPPRESSED condition still has one:
  // silencing a condition does not stop its clock, so it is still selectable
  // by a filter that asks about commitments — which is the point, because
  // otherwise the set an operator can see would be smaller than the set the
  // workspace is actually behind on.
  const live = { endedAtUtc: null } as const;

  if (posture === "BREACHED") {
    return {
      slaCycles: {
        some: {
          ...live,
          OR: [
            { acknowledgementBreached: true },
            { resolutionBreached: true },
            {
              acknowledgedAtUtc: null,
              acknowledgementDueAtUtc: { lt: now },
            },
            {
              acknowledgedAtUtc: { not: null },
              resolutionDueAtUtc: { lt: now },
            },
          ],
        },
      },
    };
  }

  if (posture === "AT_RISK") {
    // Inside the window and within the workspace's own warning lead time. The
    // lead time is a column on the cycle, so this cannot drift from the
    // promise that was actually recorded.
    return {
      slaCycles: {
        some: {
          ...live,
          acknowledgementBreached: false,
          resolutionBreached: false,
          acknowledgedAtUtc: null,
          acknowledgementDueAtUtc: { gte: now },
        },
      },
      // The lead-time comparison itself is not expressible in one Prisma
      // predicate, so the coarse set is narrowed by the projection in the
      // route. Deliberately a SUPERSET here: a filter that under-selected
      // would hide work.
    };
  }

  if (posture === "UNTRACKED_LEGACY") {
    return { slaCycles: { none: {} } };
  }

  return {};
}

export async function listIncidents(
  input: ListIncidentsInput,
  client: PrismaClient = defaultPrisma,
): Promise<ListIncidentsPage> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const owner = input.owner ?? { kind: "ANY" };
  // A blank or whitespace-only search is NO search. Treating it as a match on
  // the empty string would be harmless here and is exactly the kind of thing
  // that later becomes a filter nobody can clear.
  const q = input.q?.trim() ?? "";
  const rows = await client.operationalIncident.findMany({
    where: {
      // WORKSPACE-SCOPE CONVERGENCE — the canonical tenant predicate. It pins
      // `scope = WORKSPACE` as well as the workspace id, so a platform
      // incident and an unclassified orphan are both outside this list by
      // construction rather than by a filter somebody has to remember.
      ...workspaceIncidentWhere(input.teamId),
      ...slaWhere(input.sla ?? null, input.now ?? new Date()),
      ...(input.status ? { status: input.status as prismaPkg.IncidentStatus } : {}),
      ...(input.severity ? { severity: input.severity as prismaPkg.IncidentSeverity } : {}),
      ...(input.category ? { category: input.category as prismaPkg.IncidentCategory } : {}),
      ...(owner.kind === "UNASSIGNED"
        ? { assignedOperatorUserId: null }
        : owner.kind === "USER"
          ? { assignedOperatorUserId: owner.userId }
          : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" as const } },
              { safeSummary: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: orderByFor(input.sort),
    // One extra row is the honest way to answer "is there more?" — a count
    // query would be a second read of a collection that can change between
    // the two.
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const incidents = hasMore ? rows.slice(0, limit) : rows;
  return {
    incidents,
    nextCursor: hasMore ? (incidents[incidents.length - 1]?.id ?? null) : null,
    complete: !hasMore,
  };
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
  /**
   * WHEN each lifecycle duty was discharged.
   *
   * Persisted since the lifecycle existed and never projected, so a surface
   * could say a condition was acknowledged and not when — which is the half
   * that makes "has anyone dealt with this?" answerable, and the half an SLA
   * posture is measured from. Null means the duty is still open.
   */
  acknowledgedAtUtc: string | null;
  resolvedAtUtc: string | null;
  /**
   * CLOSURE PASS (2026-08-22) — the CURRENT owner, exposed so the console can
   * render it. It was persisted and never projected, which is why the
   * assignment feature was invisible: the capability existed, the write path
   * existed, and no surface could show who held anything.
   *
   * NULL means unassigned. A user who has since left the workspace still
   * appears here until somebody reassigns — the historical attribution in the
   * incident's event log is the record of what happened, and this column is
   * the record of what is true now.
   */
  assignedOperatorUserId: string | null;
  assignedAtUtc: string | null;
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
    acknowledgedAtUtc: i.acknowledgedAtUtc ? i.acknowledgedAtUtc.toISOString() : null,
    resolvedAtUtc: i.resolvedAtUtc ? i.resolvedAtUtc.toISOString() : null,
    assignedOperatorUserId: i.assignedOperatorUserId,
    assignedAtUtc: i.assignedAtUtc ? i.assignedAtUtc.toISOString() : null,
  };
}

// -----------------------------------------------------------------------------
// Incident detail — the bounded read behind the workbench inspector.
//
// `OperationalIncidentEvent` rows have been WRITTEN since Phase 21 by every
// path that opens, re-fires, acknowledges, resolves, suppresses or reassigns a
// condition, and until now nothing could READ them. The console could show
// that a condition existed and not what had happened to it, so "has anyone
// dealt with this?" — the question a shared operations surface exists to
// answer — was only answerable by asking a colleague.
//
// This is a PROJECTION of the existing authority, not a second one. It opens
// no lifecycle, writes nothing, and returns null rather than throwing so the
// route can answer a cross-workspace probe with the same 404 a genuinely
// absent id gets.
// -----------------------------------------------------------------------------

/** One entry in an incident's history. Bounded, operator-safe strings only. */
export type IncidentTimelineEntry = {
  id: string;
  eventType: string;
  safeMessage: string;
  occurredAtUtc: string;
};

export type IncidentDetail = IncidentProjection & {
  timeline: IncidentTimelineEntry[];
  /**
   * False when the incident has more history than this read returned.
   *
   * The inspector says so rather than letting a truncated list read as the
   * whole story — the same honesty contract the list and the summary carry,
   * for the same reason: an operator deciding whether a condition was already
   * handled must be able to tell "nothing happened" from "I was shown part".
   */
  timelineComplete: boolean;
};

/** A generous bound on one inspector read. Reaching it is reported. */
const TIMELINE_BOUND = 50;

export async function getIncidentDetail(
  input: { incidentId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<IncidentDetail | null> {
  // TENANT SCOPE IS THE WHERE CLAUSE, not a post-read comparison. A row that
  // belongs to another workspace is not found here at all, so there is no
  // branch that could be reordered into leaking its existence.
  const incident = await client.operationalIncident.findFirst({
    where: { id: input.incidentId, ...workspaceIncidentWhere(input.teamId) },
  });
  if (!incident) return null;

  const events = await client.operationalIncidentEvent.findMany({
    where: { incidentId: incident.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: TIMELINE_BOUND + 1,
    select: {
      id: true,
      eventType: true,
      safeMessage: true,
      createdAt: true,
    },
  });
  const timelineComplete = events.length <= TIMELINE_BOUND;
  const bounded = timelineComplete ? events : events.slice(0, TIMELINE_BOUND);

  return {
    ...projectIncident(incident),
    // `metadataJson` is deliberately NOT projected. It is sanitised at write
    // time, but "sanitised" is a property somebody has to keep true on every
    // future writer, and `safeMessage` is the bounded field that was designed
    // to be read by a person. Shipping the blob would make every new emitter a
    // potential provider-error leak into the browser.
    timeline: bounded.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      safeMessage: e.safeMessage,
      occurredAtUtc: e.createdAt.toISOString(),
    })),
    timelineComplete,
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
