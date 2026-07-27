/**
 * Phase 25 — Reviewer escalation engine.
 *
 * The single writer of `review_escalations`. Every escalation lifecycle
 * mutation goes through this service so the catalog enforcement +
 * fingerprint deduplication + audit + metrics + operational-incident
 * fan-out happen in exactly one place.
 *
 * Hard invariants:
 *   - Reason / status strings are validated against the shared catalogs
 *     before they hit the DB; the schema column is VARCHAR so the
 *     service is the validator.
 *   - Idempotency: the fingerprint `${workflowId}:${reason}:${dayBucket}`
 *     is unique per (teamId, fingerprint). A duplicate insert bumps
 *     `reviewer_escalation_duplicate_blocked_total` and returns the
 *     existing row — no exception thrown to the caller.
 *   - `safeSummary` is bounded (400 chars) and scrubbed against the
 *     forbidden-overclaim phrase catalog.
 *   - Status transitions follow the shared
 *     `isAllowedEscalationStatusTransition` matrix; invalid transitions
 *     surface a `REVIEW_INVALID_TRANSITION` error code.
 *   - HIGH / CRITICAL escalations open a Phase 21 operational incident
 *     via the existing `recordIncident` helper. WARNING / INFO do not.
 */

import { createHash } from "node:crypto";

import type {
  PrismaClient,
  ReviewEscalation as DbEscalation,
} from "@prisma/client";
import {
  REVIEW_ESCALATION_REASONS,
  REVIEW_ESCALATION_STATUSES,
  isAllowedEscalationStatusTransition,
  isTerminalReviewEscalationStatus,
  stringContainsForbiddenOverclaim,
  type ReviewEscalationReason,
  type ReviewEscalationStatus,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { recordIncident } from "../observability/incident.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export class EscalationEngineError extends Error {
  constructor(
    public readonly code:
      | "REVIEW_ESCALATION_NOT_FOUND"
      | "REVIEW_ESCALATION_TERMINAL"
      | "REVIEW_INVALID_TRANSITION"
      | "REVIEW_WORKFLOW_NOT_FOUND"
      | "REVIEW_NOTE_REQUIRED"
      | "REVIEW_PERMISSION_DENIED",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "EscalationEngineError";
  }
}

// -----------------------------------------------------------------------------
// Projection — operator-safe escalation row.
// -----------------------------------------------------------------------------

export type EscalationProjection = {
  id: string;
  teamId: string;
  workflowId: string;
  workflowInstanceId: string | null;
  evidenceId: string | null;
  reason: ReviewEscalationReason;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status: ReviewEscalationStatus;
  safeSummary: string;
  createdByUserId: string | null;
  assignedToUserId: string | null;
  acknowledgedAtUtc: string | null;
  acknowledgedByUserId: string | null;
  resolvedAtUtc: string | null;
  resolvedByUserId: string | null;
  resolutionNote: string | null;
  suppressedAtUtc: string | null;
  suppressionReason: string | null;
  incidentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function projectEscalation(row: DbEscalation): EscalationProjection {
  return {
    id: row.id,
    teamId: row.teamId,
    workflowId: row.workflowId,
    workflowInstanceId: row.workflowInstanceId,
    evidenceId: row.evidenceId,
    reason: row.reason as ReviewEscalationReason,
    severity: row.severity as EscalationProjection["severity"],
    status: row.status as ReviewEscalationStatus,
    safeSummary: row.safeSummary,
    createdByUserId: row.createdByUserId,
    assignedToUserId: row.assignedToUserId,
    acknowledgedAtUtc: row.acknowledgedAtUtc?.toISOString() ?? null,
    acknowledgedByUserId: row.acknowledgedByUserId,
    resolvedAtUtc: row.resolvedAtUtc?.toISOString() ?? null,
    resolvedByUserId: row.resolvedByUserId,
    resolutionNote: row.resolutionNote,
    suppressedAtUtc: row.suppressedAtUtc?.toISOString() ?? null,
    suppressionReason: row.suppressionReason,
    incidentId: row.incidentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const REASON_SET = new Set<string>(REVIEW_ESCALATION_REASONS);
const STATUS_SET = new Set<string>(REVIEW_ESCALATION_STATUSES);
const SEVERITY_SET = new Set<string>(["INFO", "WARNING", "HIGH", "CRITICAL"]);

function dayBucket(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildFingerprint(input: {
  workflowId: string;
  reason: ReviewEscalationReason;
  now: Date;
}): string {
  const raw = `${input.workflowId}:${input.reason}:${dayBucket(input.now)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 64);
}

function sanitiseSummary(summary: string): string {
  const trimmed = summary.trim().slice(0, 400);
  if (stringContainsForbiddenOverclaim(trimmed)) {
    // Strip the overclaim by replacing the string with a safe stub.
    // Operators see "[summary withheld — wording violation]" so the
    // escalation still surfaces but never carries the bad phrase.
    return "[summary withheld — wording violation]";
  }
  return trimmed.length > 0 ? trimmed : "Escalation raised by reviewer ops engine.";
}

function sanitiseNote(note: string): string {
  const trimmed = note.trim().slice(0, 400);
  if (stringContainsForbiddenOverclaim(trimmed)) {
    return "[note withheld — wording violation]";
  }
  return trimmed;
}

// -----------------------------------------------------------------------------
// Create / get-or-create
// -----------------------------------------------------------------------------

export type CreateEscalationInput = {
  teamId: string;
  workflowId: string;
  reason: ReviewEscalationReason;
  /** Bounded to 400 chars; wording is scrubbed by the service. */
  safeSummary: string;
  severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  workflowInstanceId?: string | null;
  evidenceId?: string | null;
  createdByUserId?: string | null;
  assignedToUserId?: string | null;
  /** Bypass fingerprint dedup. Routes pass `false`; the reconcile job
   *  passes `false` too. The only legitimate `true` case is the
   *  manual operator route. */
  bypassDedup?: boolean;
};

export type CreateEscalationResult =
  | { ok: true; created: boolean; escalation: EscalationProjection }
  | { ok: false; code: "REVIEW_WORKFLOW_NOT_FOUND" | "REVIEW_PERMISSION_DENIED" };

export async function createEscalation(
  input: CreateEscalationInput,
  client: PrismaClient = defaultPrisma,
): Promise<CreateEscalationResult> {
  // Catalog guards — the caller passed a typed value, but routes
  // ingest user JSON so we re-validate at the service boundary.
  if (!REASON_SET.has(input.reason)) {
    return { ok: false, code: "REVIEW_PERMISSION_DENIED" };
  }
  const severity = input.severity ?? "WARNING";
  if (!SEVERITY_SET.has(severity)) {
    return { ok: false, code: "REVIEW_PERMISSION_DENIED" };
  }

  // Confirm workflow belongs to the team.
  const workflow = await client.evidenceReviewWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
    select: {
      id: true,
      evidenceId: true,
      assignedToUserId: true,
      escalationLevel: true,
      // Phase 6 — workflow-row template trio (Phase 4 stamped). Read
      // here so escalation traceability does NOT need an extra join.
      templateSlug: true,
      templateVersion: true,
      templateDbId: true,
    },
  });
  if (!workflow) return { ok: false, code: "REVIEW_WORKFLOW_NOT_FOUND" };

  // Phase 6 — Resolve template provenance trio for escalation audit
  // traceability. Identity propagation ONLY: no policy decision is
  // taken from this. We read the trio first from the workflow row
  // (Phase 4 stamped); if all three are NULL we fall back to the
  // Evidence row (Phase T stamped). Wrapped in try/catch — a
  // propagation failure must never break the escalation lifecycle.
  let templateProvenance: {
    templateSlug: string | null;
    templateVersion: number | null;
    templateDbId: string | null;
  } = {
    templateSlug: workflow.templateSlug ?? null,
    templateVersion: workflow.templateVersion ?? null,
    templateDbId: workflow.templateDbId ?? null,
  };
  if (
    templateProvenance.templateSlug == null &&
    templateProvenance.templateVersion == null &&
    templateProvenance.templateDbId == null &&
    workflow.evidenceId
  ) {
    try {
      const evidenceTrio = await client.evidence.findUnique({
        where: { id: workflow.evidenceId },
        select: {
          templateSlug: true,
          templateVersion: true,
          templateDbId: true,
        },
      });
      if (evidenceTrio) {
        templateProvenance = {
          templateSlug: evidenceTrio.templateSlug ?? null,
          templateVersion: evidenceTrio.templateVersion ?? null,
          templateDbId: evidenceTrio.templateDbId ?? null,
        };
      }
    } catch {
      // Identity propagation failure must NEVER break escalation flow.
      // Leave trio NULL and continue.
    }
  }

  const now = new Date();
  const summary = sanitiseSummary(input.safeSummary);
  const fingerprint = buildFingerprint({
    workflowId: input.workflowId,
    reason: input.reason,
    now,
  });

  // Try the dedup'd insert first.
  if (!input.bypassDedup) {
    const existing = await client.reviewEscalation.findUnique({
      where: { teamId_fingerprint: { teamId: input.teamId, fingerprint } },
    });
    if (existing) {
      bump("reviewer_escalation_duplicate_blocked_total");
      return {
        ok: true,
        created: false,
        escalation: projectEscalation(existing),
      };
    }
  }

  const created = await client.reviewEscalation.create({
    data: {
      teamId: input.teamId,
      workflowId: input.workflowId,
      workflowInstanceId: input.workflowInstanceId ?? null,
      evidenceId: input.evidenceId ?? workflow.evidenceId,
      reason: input.reason,
      severity,
      status: "OPEN",
      safeSummary: summary,
      createdByUserId: input.createdByUserId ?? null,
      assignedToUserId:
        input.assignedToUserId ?? workflow.assignedToUserId ?? null,
      fingerprint,
    },
  });

  bump("reviewer_escalation_created_total");


  // Update the workflow's denormalised pointer + escalation counters.
  await client.evidenceReviewWorkflow.update({
    where: { id: input.workflowId },
    data: {
      activeEscalationId: created.id,
      escalationLevel: workflow.escalationLevel + 1,
      escalatedAtUtc: now,
      escalationReason: input.reason,
    },
  });

  // HIGH / CRITICAL escalations open a Phase 21 incident.
  let linkedIncidentId: string | null = null;
  if (severity === "HIGH" || severity === "CRITICAL") {
    try {
      const inc = await recordIncident({
        teamId: input.teamId,
        category: "GOVERNANCE",
        severity: severity === "CRITICAL" ? "CRITICAL" : "HIGH",
        fingerprint: `review-escalation:${input.reason}:${input.workflowId}`,
        title: `Reviewer escalation — ${input.reason}`,
        safeSummary: summary,
        relatedEvidenceId: workflow.evidenceId,
        runbookSlug:
          input.reason === "REVIEW_OVERDUE" ||
          input.reason === "FIRST_REVIEW_OVERDUE" ||
          input.reason === "COMPLETION_OVERDUE"
            ? "reviewer-sla-breach"
            : "reviewer-escalation-backlog",
        metadata: {
          workflowId: input.workflowId,
          escalationId: created.id,
          reason: input.reason,
          // Phase 6 — template provenance trio for downstream
          // traceability. Identity-only; never drives policy.
          templateSlug: templateProvenance.templateSlug,
          templateVersion: templateProvenance.templateVersion,
          templateDbId: templateProvenance.templateDbId,
        },
      });
      linkedIncidentId = inc.incident.id;
      await client.reviewEscalation.update({
        where: { id: created.id },
        data: { incidentId: linkedIncidentId },
      });
    } catch {
      /* incident creation is best-effort; never breaks escalation flow */
    }
  }

  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "reviewer_escalation_created",
    severity: severity === "CRITICAL" ? "HIGH" : severity === "HIGH" ? "HIGH" : severity === "WARNING" ? "WARNING" : "INFO",
    details: {
      escalationId: created.id,
      workflowId: input.workflowId,
      reason: input.reason,
      severity,
      actorUserId: input.createdByUserId ?? null,
      assignedToUserId: created.assignedToUserId,
      incidentId: linkedIncidentId,
      // Phase 6 — template provenance trio for downstream
      // traceability. Identity-only; never drives policy.
      templateSlug: templateProvenance.templateSlug,
      templateVersion: templateProvenance.templateVersion,
      templateDbId: templateProvenance.templateDbId,
    },
  });

  await emitTenantAudit(
    {
      action: "reviewer.escalation.create",
      outcome: "success",
      severity: severity === "CRITICAL" || severity === "HIGH" ? "warning" : "info",
      sourceApp: "API",
      actorUserId: input.createdByUserId ?? null,
      workspaceId: input.teamId,
      resourceType: "review_escalation",
      resourceId: created.id,
      metadata: {
        workflowId: input.workflowId,
        reason: input.reason,
        severity,
        incidentId: linkedIncidentId,
        // Phase 6 — template provenance trio for downstream
        // traceability. Identity-only; never drives policy.
        templateSlug: templateProvenance.templateSlug,
        templateVersion: templateProvenance.templateVersion,
        templateDbId: templateProvenance.templateDbId,
      },
    },
    client,
  );

  return {
    ok: true,
    created: true,
    escalation: projectEscalation({
      ...created,
      incidentId: linkedIncidentId,
    } as DbEscalation),
  };
}

// -----------------------------------------------------------------------------
// Status transitions
// -----------------------------------------------------------------------------

type TransitionContext = {
  teamId: string;
  escalationId: string;
  actorUserId: string;
};

async function loadAndAssertOpen(
  ctx: TransitionContext,
  client: PrismaClient,
): Promise<DbEscalation> {
  const row = await client.reviewEscalation.findFirst({
    where: { id: ctx.escalationId, teamId: ctx.teamId },
  });
  if (!row) throw new EscalationEngineError("REVIEW_ESCALATION_NOT_FOUND");
  if (isTerminalReviewEscalationStatus(row.status as ReviewEscalationStatus)) {
    throw new EscalationEngineError("REVIEW_ESCALATION_TERMINAL");
  }
  return row;
}

function assertTransition(
  from: ReviewEscalationStatus,
  to: ReviewEscalationStatus,
): void {
  if (!isAllowedEscalationStatusTransition(from, to)) {
    throw new EscalationEngineError("REVIEW_INVALID_TRANSITION", { from, to });
  }
}

export async function acknowledgeEscalation(
  input: TransitionContext,
  client: PrismaClient = defaultPrisma,
): Promise<EscalationProjection> {
  const row = await loadAndAssertOpen(input, client);
  assertTransition(row.status as ReviewEscalationStatus, "ACKNOWLEDGED");
  const now = new Date();
  const updated = await client.reviewEscalation.update({
    where: { id: row.id },
    data: {
      status: "ACKNOWLEDGED",
      acknowledgedAtUtc: now,
      acknowledgedByUserId: input.actorUserId,
    },
  });
  bump("reviewer_escalation_acknowledged_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "reviewer_escalation_acknowledged",
    severity: "INFO",
    details: { escalationId: row.id, actorUserId: input.actorUserId },
  });
  return projectEscalation(updated);
}

export async function reassignEscalation(
  input: TransitionContext & { newAssigneeUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<EscalationProjection> {
  const row = await loadAndAssertOpen(input, client);
  assertTransition(row.status as ReviewEscalationStatus, "REASSIGNED");
  const updated = await client.reviewEscalation.update({
    where: { id: row.id },
    data: {
      status: "REASSIGNED",
      assignedToUserId: input.newAssigneeUserId,
    },
  });
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "reviewer_escalation_reassigned",
    severity: "INFO",
    details: {
      escalationId: row.id,
      newAssigneeUserId: input.newAssigneeUserId,
      actorUserId: input.actorUserId,
    },
  });
  return projectEscalation(updated);
}

export async function resolveEscalation(
  input: TransitionContext & { resolutionNote: string },
  client: PrismaClient = defaultPrisma,
): Promise<EscalationProjection> {
  if (input.resolutionNote.trim().length === 0) {
    throw new EscalationEngineError("REVIEW_NOTE_REQUIRED");
  }
  const row = await loadAndAssertOpen(input, client);
  assertTransition(row.status as ReviewEscalationStatus, "RESOLVED");
  const now = new Date();
  const updated = await client.reviewEscalation.update({
    where: { id: row.id },
    data: {
      status: "RESOLVED",
      resolvedAtUtc: now,
      resolvedByUserId: input.actorUserId,
      resolutionNote: sanitiseNote(input.resolutionNote),
    },
  });
  // Clear the workflow's active-escalation pointer if it still points
  // at this escalation.
  await client.evidenceReviewWorkflow.updateMany({
    where: { id: row.workflowId, activeEscalationId: row.id },
    data: { activeEscalationId: null },
  });
  bump("reviewer_escalation_resolved_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "reviewer_escalation_resolved",
    severity: "INFO",
    details: {
      escalationId: row.id,
      actorUserId: input.actorUserId,
    },
  });
  await emitTenantAudit(
    {
      action: "reviewer.escalation.resolve",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "review_escalation",
      resourceId: row.id,
      metadata: { workflowId: row.workflowId },
    },
    client,
  );
  return projectEscalation(updated);
}

export async function suppressEscalation(
  input: TransitionContext & { suppressionReason: string },
  client: PrismaClient = defaultPrisma,
): Promise<EscalationProjection> {
  if (input.suppressionReason.trim().length === 0) {
    throw new EscalationEngineError("REVIEW_NOTE_REQUIRED");
  }
  const row = await loadAndAssertOpen(input, client);
  assertTransition(row.status as ReviewEscalationStatus, "SUPPRESSED");
  const now = new Date();
  const updated = await client.reviewEscalation.update({
    where: { id: row.id },
    data: {
      status: "SUPPRESSED",
      suppressedAtUtc: now,
      suppressionReason: sanitiseNote(input.suppressionReason),
    },
  });
  await client.evidenceReviewWorkflow.updateMany({
    where: { id: row.workflowId, activeEscalationId: row.id },
    data: { activeEscalationId: null },
  });
  bump("reviewer_escalation_suppressed_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "reviewer_escalation_suppressed",
    severity: "INFO",
    details: { escalationId: row.id, actorUserId: input.actorUserId },
  });
  return projectEscalation(updated);
}

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

export type ListEscalationsInput = {
  teamId: string;
  status?: ReviewEscalationStatus | "ALL";
  severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  reason?: ReviewEscalationReason;
  assignedToUserId?: string;
  limit?: number;
};

export async function listEscalations(
  input: ListEscalationsInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<EscalationProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await client.reviewEscalation.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status && input.status !== "ALL"
        ? { status: input.status }
        : {}),
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.assignedToUserId
        ? { assignedToUserId: input.assignedToUserId }
        : {}),
    },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
  return rows.map(projectEscalation);
}

// Convenience: pull the current OPEN escalation for a workflow (used
// by the engine + workspace UI). Returns null when none open.
export async function findOpenEscalationForWorkflow(
  input: { teamId: string; workflowId: string },
  client: PrismaClient = defaultPrisma,
): Promise<EscalationProjection | null> {
  const row = await client.reviewEscalation.findFirst({
    where: {
      teamId: input.teamId,
      workflowId: input.workflowId,
      status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
    },
    orderBy: { createdAt: "desc" },
  });
  return row ? projectEscalation(row) : null;
}
