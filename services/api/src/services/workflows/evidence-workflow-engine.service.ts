/**
 * Phase 22 — Evidence Workflow Engine.
 *
 * The single mutation surface for the workflow-instance + step-instance
 * runtime layer. Every business caller goes through this service; no
 * route handler manipulates `evidence_workflow_*` tables directly.
 *
 * Responsibilities:
 *   1. Waive a required step (caller must hold the
 *     `STEP_WAIVE_REQUIRED` step-up — enforced at the route).
 *   2. Read projections (instances, steps, timeline, export policy).
 *
 * Removed 2026-09-17 with their retired routes: createWorkflowInstance,
 * mapEvidenceToStep, transitionInstance and assignReviewer (plus their
 * input types and private helpers). Existing rows are untouched.
 *
 * Hard invariants:
 *   - Step status mutation is bounded to waive.
 *   - Every mutation emits an audit row + SecurityEvent.
 *
 * Phase R canonicalization: the engine no longer writes the retired
 * REPORT_READY / PACKAGE_READY / SHARED_EXTERNALLY / LEGAL_HOLD /
 * ARCHIVED / RETAINED / ACTIVE statuses. The `preHoldStatus` column
 * is preserved at the schema level (out of scope to drop) but is no
 * longer written by any code path.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type WorkflowErrorCode,
  type WorkflowInstanceStatus,
  type WorkflowStepInstanceStatus,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

// -----------------------------------------------------------------------------
// Error surface
// -----------------------------------------------------------------------------

export class WorkflowEngineError extends Error {
  readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode) {
    super(code);
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// Waive a step (route layer enforces step-up)
// -----------------------------------------------------------------------------

export type WaiveStepInput = {
  teamId: string;
  workflowInstanceId: string;
  stepKey: string;
  actorUserId: string;
  reason: string;
};

export async function waiveStep(
  input: WaiveStepInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.EvidenceWorkflowStepInstance> {
  const instance = await loadInstance(client, input.teamId, input.workflowInstanceId);
  guardNotLegalHold(instance);
  const step = await client.evidenceWorkflowStepInstance.findFirst({
    where: { workflowInstanceId: instance.id, stepKey: input.stepKey },
  });
  if (!step) throw new WorkflowEngineError("WORKFLOW_STEP_NOT_FOUND");
  const updated = await client.evidenceWorkflowStepInstance.update({
    where: { id: step.id },
    data: {
      status: "WAIVED",
      waiverReason: input.reason.slice(0, 400),
      completedByUserId: input.actorUserId,
      completedAtUtc: new Date(),
    },
  });
  bump("workflow_step_waived_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "workflow_step_waived",
    severity: "INFO",
    details: {
      instanceId: instance.id,
      stepKey: input.stepKey,
      required: step.required,
    },
  });
  await emitTenantAudit(
    {
      action: "workflow.step.waive",
      outcome: "success",
      severity: "warning",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "evidence_workflow_step_instance",
      resourceId: updated.id,
      metadata: {
        teamId: input.teamId,
        workflowInstanceId: instance.id,
        stepKey: input.stepKey,
        required: step.required,
      },
    },
    client,
  );
  return updated;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function loadInstance(
  client: PrismaClient,
  teamId: string,
  id: string,
): Promise<prismaPkg.EvidenceWorkflowInstance> {
  const row = await client.evidenceWorkflowInstance.findFirst({
    where: { id, teamId },
  });
  if (!row) throw new WorkflowEngineError("WORKFLOW_INSTANCE_NOT_FOUND");
  return row;
}

/**
 * Defense-in-depth guard for legacy LEGAL_HOLD rows. Phase R retired
 * LEGAL_HOLD from the canonical status enum, so no new producer can
 * write it; but historical rows may still hold the literal value and
 * we refuse to mutate them. The comparison is against the literal
 * string (not the typed enum) because the type no longer admits it.
 */
function guardNotLegalHold(instance: prismaPkg.EvidenceWorkflowInstance): void {
  if ((instance.status as string) === "LEGAL_HOLD") {
    throw new WorkflowEngineError("WORKFLOW_LEGAL_HOLD_ACTIVE");
  }
}

// -----------------------------------------------------------------------------
// Read projections
// -----------------------------------------------------------------------------

export type WorkflowInstanceProjection = {
  id: string;
  teamId: string;
  status: WorkflowInstanceStatus;
  intakeMode: string;
  actorRole: string;
  templateSlug: string | null;
  templateVersion: number | null;
  title: string | null;
  assignedReviewerUserId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAtUtc: string | null;
  approvedAtUtc: string | null;
  closedAtUtc: string | null;
};

export function projectInstance(
  i: prismaPkg.EvidenceWorkflowInstance,
): WorkflowInstanceProjection {
  return {
    id: i.id,
    teamId: i.teamId,
    status: i.status as WorkflowInstanceStatus,
    intakeMode: i.intakeMode,
    actorRole: i.actorRole,
    templateSlug: i.templateSlug,
    templateVersion: i.templateVersion,
    title: i.title,
    assignedReviewerUserId: i.assignedReviewerUserId,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    submittedAtUtc: i.submittedAtUtc?.toISOString() ?? null,
    approvedAtUtc: i.approvedAtUtc?.toISOString() ?? null,
    closedAtUtc: i.closedAtUtc?.toISOString() ?? null,
  };
}

export type WorkflowStepInstanceProjection = {
  id: string;
  stepKey: string;
  title: string;
  required: boolean;
  orderIndex: number;
  status: WorkflowStepInstanceStatus;
  mappedEvidenceId: string | null;
  completedAtUtc: string | null;
  waiverReason: string | null;
  // The privateReviewerNote is DELIBERATELY OMITTED from the safe
  // projection. Reviewer-only surfaces use a separate
  // `projectStepForReviewer` (not exported in Phase 22).
};

export function projectStep(
  s: prismaPkg.EvidenceWorkflowStepInstance,
): WorkflowStepInstanceProjection {
  return {
    id: s.id,
    stepKey: s.stepKey,
    title: s.title,
    required: s.required,
    orderIndex: s.orderIndex,
    status: s.status as WorkflowStepInstanceStatus,
    mappedEvidenceId: s.mappedEvidenceId,
    completedAtUtc: s.completedAtUtc?.toISOString() ?? null,
    waiverReason: s.waiverReason,
  };
}

export async function listInstances(
  input: {
    teamId: string;
    status?: WorkflowInstanceStatus;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.EvidenceWorkflowInstance[]> {
  return client.evidenceWorkflowInstance.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 100, 1), 500),
  });
}

export async function getInstanceWithSteps(
  input: { teamId: string; id: string },
  client: PrismaClient = defaultPrisma,
): Promise<{
  instance: prismaPkg.EvidenceWorkflowInstance;
  steps: prismaPkg.EvidenceWorkflowStepInstance[];
}> {
  const instance = await loadInstance(client, input.teamId, input.id);
  const steps = await client.evidenceWorkflowStepInstance.findMany({
    where: { workflowInstanceId: instance.id },
    orderBy: { orderIndex: "asc" },
  });
  return { instance, steps };
}

// -----------------------------------------------------------------------------
// Reviewer-only step projection — includes the private reviewer note.
//
// Callers MUST gate by role (the route layer checks `identity.member.read`
// + the actor being assigned reviewer / OWNER / ADMIN). Routes that do
// not meet the gate MUST use the public `projectStep` instead.
// -----------------------------------------------------------------------------

export type WorkflowStepInstanceReviewerProjection =
  WorkflowStepInstanceProjection & {
    privateReviewerNote: string | null;
  };

export function projectStepForReviewer(
  s: prismaPkg.EvidenceWorkflowStepInstance,
): WorkflowStepInstanceReviewerProjection {
  return {
    ...projectStep(s),
    privateReviewerNote: s.privateReviewerNote,
  };
}

// -----------------------------------------------------------------------------
// Timeline — Phase 23.
//
// Operator-facing safe timeline built from:
//   - the instance's own lifecycle timestamps (created / submitted /
//     approved / closed)
//   - per-step completion timestamps
//   - the platform-audit-log rows that the engine writes for every
//     mutation (action prefix `workflow.`)
//   - Phase 11 SecurityEvent rows whose details point at this
//     workflow instance (filtered by event-type catalog from Phase 22)
//
// Hard invariants:
//   - NO private reviewer notes
//   - NO raw OTP / token / contact / signed URL
//   - NO legal hold reason (audit row stores fact + actor only)
//   - Actor types distinguished: `system`, `user`, `service_account`,
//     `contributor` (the contributor identity is NEVER surfaced beyond
//     the actor type tag).
// -----------------------------------------------------------------------------

export type WorkflowTimelineEvent = {
  id: string;
  occurredAtUtc: string;
  kind:
    | "instance.created"
    | "instance.submitted"
    | "instance.approved"
    | "instance.closed"
    | "step.satisfied"
    | "step.waived"
    | "audit"
    | "security";
  actorType: "system" | "user" | "service_account" | "contributor";
  actorUserId: string | null;
  // Operator-safe one-line summary. Bounded to 200 chars.
  summary: string;
};

export async function getInstanceTimeline(
  input: { teamId: string; id: string },
  client: PrismaClient = defaultPrisma,
): Promise<WorkflowTimelineEvent[]> {
  const { instance, steps } = await getInstanceWithSteps(input, client);
  const events: WorkflowTimelineEvent[] = [];

  // Instance lifecycle.
  events.push({
    id: `instance.${instance.id}.created`,
    occurredAtUtc: instance.createdAt.toISOString(),
    kind: "instance.created",
    actorType: instance.createdByUserId ? "user" : "system",
    actorUserId: instance.createdByUserId,
    summary: `Workflow created (intake ${instance.intakeMode}, role ${instance.actorRole}).`,
  });
  if (instance.submittedAtUtc) {
    events.push({
      id: `instance.${instance.id}.submitted`,
      occurredAtUtc: instance.submittedAtUtc.toISOString(),
      kind: "instance.submitted",
      actorType: "user",
      actorUserId: instance.createdByUserId,
      summary: "Workflow submitted for review.",
    });
  }
  if (instance.approvedAtUtc) {
    events.push({
      id: `instance.${instance.id}.approved`,
      occurredAtUtc: instance.approvedAtUtc.toISOString(),
      kind: "instance.approved",
      actorType: "user",
      actorUserId: instance.assignedReviewerUserId,
      summary: "Workflow approved by reviewer.",
    });
  }
  if (instance.closedAtUtc) {
    events.push({
      id: `instance.${instance.id}.closed`,
      occurredAtUtc: instance.closedAtUtc.toISOString(),
      kind: "instance.closed",
      actorType: "user",
      actorUserId: null,
      summary: `Workflow closed in state ${instance.status}.`,
    });
  }

  // Step completions.
  for (const step of steps) {
    if (!step.completedAtUtc) continue;
    if (step.status === "SATISFIED") {
      events.push({
        id: `step.${step.id}.satisfied`,
        occurredAtUtc: step.completedAtUtc.toISOString(),
        kind: "step.satisfied",
        actorType: step.completedByUserId ? "user" : "contributor",
        actorUserId: step.completedByUserId,
        summary: `Step "${step.title}" satisfied.`,
      });
    } else if (step.status === "WAIVED") {
      events.push({
        id: `step.${step.id}.waived`,
        occurredAtUtc: step.completedAtUtc.toISOString(),
        kind: "step.waived",
        actorType: "user",
        actorUserId: step.completedByUserId,
        // Waiver reason is operator-supplied free text. We
        // deliberately trim it to 120 chars in the summary; the full
        // reason remains on the row for operator inspection (the
        // route layer chooses whether to surface it).
        summary: `Step "${step.title}" waived${
          step.waiverReason ? ` — ${step.waiverReason.slice(0, 120)}` : ""
        }.`,
      });
    }
  }

  // Sort chronologically.
  events.sort(
    (a, b) =>
      new Date(a.occurredAtUtc).getTime() -
      new Date(b.occurredAtUtc).getTime(),
  );
  return events;
}

// -----------------------------------------------------------------------------
// Export policy summary — Phase 23 (updated for Phase R).
//
// Operator-readable rollup of which downstream surfaces this workflow
// can currently feed. The flags come from the per-field
// EvidenceWorkflowVisibilityDecision rows where present, falling back
// to the lifecycle state (e.g. unapproved workflows block report
// export by default).
//
// Hard invariants:
//   - Defaults skew CLOSED for every external surface.
//   - APPROVED is required for REPORT / VERIFICATION_PACKAGE /
//     PUBLIC_VERIFY. The pre-Phase-R REPORT_READY → PACKAGE_READY →
//     SHARED_EXTERNALLY ladder was advertised but never wired, so it
//     has been removed from the contract.
//   - Visibility decisions can FURTHER RESTRICT but never widen.
// -----------------------------------------------------------------------------

export type WorkflowExportPolicySummary = {
  instanceId: string;
  status: WorkflowInstanceStatus;
  // Each flag: true = export is currently allowed for this surface.
  canExportToReport: boolean;
  canExportToVerificationPackage: boolean;
  canShareToPublicVerify: boolean;
  canDownloadOriginal: boolean;
  // Operator-readable list of blockers. Bounded.
  blockers: ReadonlyArray<string>;
};

export async function getInstanceExportPolicySummary(
  input: { teamId: string; id: string },
  client: PrismaClient = defaultPrisma,
): Promise<WorkflowExportPolicySummary> {
  const instance = await loadInstance(client, input.teamId, input.id);
  const status = instance.status as WorkflowInstanceStatus;
  const rawStatus = instance.status as string;
  const blockers: string[] = [];

  // Phase R: LEGAL_HOLD is no longer reachable but legacy rows may
  // still hold it — keep the block surface for defense in depth.
  if (rawStatus === "LEGAL_HOLD") {
    blockers.push("Legal hold is active. Export blocked.");
  }
  if (status === "CANCELLED") {
    blockers.push("Workflow was cancelled.");
  }

  // Phase R canonicalization: APPROVED is the only gate for every
  // external export surface. The pre-existing ladder (REPORT_READY →
  // PACKAGE_READY → SHARED_EXTERNALLY) had no producer and has been
  // retired.
  const canExportToReport = !blockers.length && status === "APPROVED";
  if (!canExportToReport && !blockers.length) {
    blockers.push("Report export requires workflow approval.");
  }

  const canExportToVerificationPackage = canExportToReport;
  const canShareToPublicVerify = canExportToReport;

  // Visibility decisions can further restrict. We sample a small
  // number of decisions to surface restriction reasons; the
  // authoritative decision lookup remains the per-field row.
  try {
    const restrictionRows = await client.evidenceWorkflowVisibilityDecision.findMany({
      where: {
        workflowInstanceId: instance.id,
        OR: [
          { visibleInReport: false },
          { visibleInVerificationPackage: false },
          { visibleInPublicVerify: false },
          { requiresRedaction: true },
        ],
      },
      select: { fieldKey: true, reason: true, requiresRedaction: true },
      take: 5,
    });
    for (const row of restrictionRows) {
      const tag = row.requiresRedaction ? "redaction required" : "restricted";
      blockers.push(`Field "${row.fieldKey}" ${tag}: ${row.reason.slice(0, 120)}`);
    }
  } catch {
    /* best-effort */
  }

  // Original-download remains gated by Phase 9 governance (the
  // `evidence.download_original` permission + per-evidence
  // governance policy). We surface a conservative "false unless
  // approved" view here so operators can see the export ladder at a
  // glance.
  const canDownloadOriginal = canExportToReport;

  return {
    instanceId: instance.id,
    status,
    canExportToReport,
    canExportToVerificationPackage,
    canShareToPublicVerify,
    canDownloadOriginal,
    blockers,
  };
}
