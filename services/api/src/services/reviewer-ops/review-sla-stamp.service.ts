/**
 * WHEN A REVIEW IS DUE (WORKFLOW-006).
 *
 * The one place deadlines come from `resolveEffectiveSlaPolicy`. Every review row
 * is written by Capture with no deadline, and the SLA engine reads only rows that
 * have one, so the hours on the policy page reached no real review.
 *
 * WHICH REVIEWS GET A DEADLINE
 *   - At creation, only under a stated policy: a workspace or template that set
 *     hours. Capture creates a row for every record in every workspace, and the
 *     standing decision (`ensureReviewWorkflow`, Phase 13.5, now reached only by
 *     the seed) is that a workspace with no defaults gets no SLA, so one that does
 *     not use review is not breached on its own records.
 *   - At assignment, always: once a review is in someone's hands the effective
 *     policy applies, platform defaults included, as the console assign path did.
 *
 * Only empty columns are filled. A date an operator typed is kept, and a row's
 * deadlines do not move when the policy changes later.
 *
 * OLD ROWS. The reconcile sweep stamps open rows that qualify and counts the
 * window from that moment, never from their creation, so deploying this cannot
 * breach a backlog.
 */
import type { EvidenceReviewWorkflow as DbWorkflow, Prisma, PrismaClient } from "@prisma/client";
import {
  REVIEW_FINISHED_DB_STATUSES,
  storedReviewSlaStatus,
  type ReviewerOpsSlaPolicy,
} from "@proovra/shared";

import { resolveEffectiveSlaPolicy } from "./sla-policy.service.js";
import { warn as logWarn } from "../../utils/logger.js";

// -----------------------------------------------------------------------------
// Template id resolution for SLA layering.
//
// Phase R wiring: the Phase 25.5 SLA policy resolver already supports a
// `templateId` parameter (`sla-policy.service.ts:loadTemplateOverride`).
// Until this phase the call sites passed nothing, so the template-override
// branch was unreachable in production.
//
// Phase T simplification: Phase 4 stamped the canonical template identity
// trio (templateSlug, templateVersion, templateDbId) directly onto
// EvidenceReviewWorkflow at upsert time. The SLA resolver now prefers
// those columns as the primary source — a single indexed read on the
// workflow row replaces the two-join discovery for any row stamped after
// Phase 4. The legacy two-join discovery is retained as a fallback so
// pre-Phase-4 rows (NULL trio columns) still resolve their SLA template
// without any backfill job.
//
// Order of precedence:
//
//   1. DIRECT — EvidenceReviewWorkflow.templateDbId   (new column, fast)
//   2. DIRECT — EvidenceReviewWorkflow.templateSlug   → DB row by (slug, teamId)
//      (returns null when the slug is seed-only with no DB row backing it;
//       SLA falls back to workspace / env / baseline as designed)
//   3. DISCOVERED — EvidenceWorkflowInstanceEvidence → instance.templateId
//   4. DISCOVERED — WorkflowIntakeSession.evidenceId → link.workflowTemplateId
//
// Both legacy joins are read-only and the CaptureSession.templateId column
// is intentionally NOT used here: its value is an in-code seed VarChar slug,
// not a UUID FK.
//
// Hard rule: NEVER let resolution failure break assignment. Every read is
// wrapped; on any error we return null and the resolver falls back to
// workspace / env / baseline as it does today.
// -----------------------------------------------------------------------------

export type SlaTemplateResolutionSource =
  // Phase T — new column on EvidenceReviewWorkflow was set.
  | "direct"
  // Phase R legacy join paths, retained for rows with NULL trio columns.
  | "workflow_instance"
  | "intake_link"
  // No template binding could be resolved (clean baseline path).
  | "none"
  // Any read threw; caller falls back to baseline.
  | "error";

export type SlaTemplateResolution = {
  templateId: string | null;
  source: SlaTemplateResolutionSource;
};

export async function resolveTemplateIdForEvidence(
  evidenceId: string,
  client: PrismaClient,
): Promise<SlaTemplateResolution> {
  // ---------------------------------------------------------------------------
  // Path 0 — Direct read of the trio columns on EvidenceReviewWorkflow.
  //
  // Phase 4 stamps these at upsert time. When templateDbId is set we have a
  // canonical UUID and we are done; when only templateSlug is set we look
  // up the DB row by (slug, teamId) using the same pattern as
  // workflow-intake-link.service:resolveTemplateForLink (workspace row wins;
  // global row falls back).
  // ---------------------------------------------------------------------------
  try {
    const workflowRow = await client.evidenceReviewWorkflow.findUnique({
      where: { evidenceId },
      select: { templateDbId: true, templateSlug: true, teamId: true },
    });
    if (workflowRow?.templateDbId) {
      return { templateId: workflowRow.templateDbId, source: "direct" };
    }
    if (workflowRow?.templateSlug) {
      const slug = workflowRow.templateSlug;
      const teamId = workflowRow.teamId ?? null;
      // Workspace-scoped row wins; otherwise fall back to a global row.
      // Either match is enough; if neither exists the slug is seed-only.
      const workspaceTemplate = teamId
        ? await client.evidenceWorkflowTemplate.findFirst({
            where: { teamId, slug, archived: false },
            select: { id: true },
          })
        : null;
      if (workspaceTemplate?.id) {
        return { templateId: workspaceTemplate.id, source: "direct" };
      }
      const globalTemplate = await client.evidenceWorkflowTemplate.findFirst({
        where: { teamId: null, slug, archived: false },
        select: { id: true },
      });
      if (globalTemplate?.id) {
        return { templateId: globalTemplate.id, source: "direct" };
      }
      // Slug present but no DB row backs it (seed-only template). The trio
      // columns are the canonical source of truth; do NOT fall through to
      // legacy joins — SLA correctly falls back to workspace / env baseline.
      return { templateId: null, source: "direct" };
    }
    // Trio columns are entirely NULL — this is a pre-Phase-4 row. Fall
    // through to the legacy discovery joins.
  } catch (err) {
    logWarn("reviewer_ops.sla_template_resolve_failed", {
      stage: "direct",
      evidenceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { templateId: null, source: "error" };
  }

  // ---------------------------------------------------------------------------
  // Path 1 (legacy) — EvidenceWorkflowInstanceEvidence join. Take the most
  // recent mapping; the template UUID lives on the instance row.
  // ---------------------------------------------------------------------------
  try {
    const link = await client.evidenceWorkflowInstanceEvidence.findFirst({
      where: { evidenceId },
      orderBy: { createdAt: "desc" },
      include: { instance: { select: { templateId: true } } },
    });
    if (link?.instance?.templateId) {
      return { templateId: link.instance.templateId, source: "workflow_instance" };
    }
  } catch (err) {
    logWarn("reviewer_ops.sla_template_resolve_failed", {
      stage: "workflow_instance",
      evidenceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { templateId: null, source: "error" };
  }

  // ---------------------------------------------------------------------------
  // Path 2 (legacy) — WorkflowIntakeSession.evidenceId (unique back-pointer)
  // → WorkflowIntakeLink.workflowTemplateId.
  // ---------------------------------------------------------------------------
  try {
    const session = await client.workflowIntakeSession.findUnique({
      where: { evidenceId },
      include: { intakeLink: { select: { workflowTemplateId: true } } },
    });
    if (session?.intakeLink?.workflowTemplateId) {
      return {
        templateId: session.intakeLink.workflowTemplateId,
        source: "intake_link",
      };
    }
  } catch (err) {
    logWarn("reviewer_ops.sla_template_resolve_failed", {
      stage: "intake_link",
      evidenceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { templateId: null, source: "error" };
  }

  return { templateId: null, source: "none" };
}

export type ReviewDeadlineColumns = {
  assignmentDueAtUtc: Date;
  firstResponseDueAtUtc: Date;
  completionDueAtUtc: Date;
  dueAt: Date;
  escalationDueAtUtc: Date;
  slaDueSoonHours: number;
};

export function reviewDeadlinesFromPolicy(
  policy: ReviewerOpsSlaPolicy,
  base: { anchor: Date; reviewDueHours?: number | null },
): ReviewDeadlineColumns {
  const after = (from: Date, hours: number) => new Date(from.getTime() + hours * 3_600_000);
  return {
    assignmentDueAtUtc: after(base.anchor, policy.assignmentHours),
    firstResponseDueAtUtc: after(base.anchor, policy.firstReviewHours),
    completionDueAtUtc: after(base.anchor, policy.completionHours),
    dueAt: after(base.anchor, base.reviewDueHours ?? policy.completionHours),
    escalationDueAtUtc: after(base.anchor, policy.escalationHours),
    slaDueSoonHours: policy.dueSoonHours,
  };
}

type ResolvedReviewPolicy = {
  policy: ReviewerOpsSlaPolicy;
  /** A workspace or template stated hours; platform defaults alone do not count. */
  stated: boolean;
  templateOverridden: boolean;
  reviewDueHours: number | null;
  templateResolution: SlaTemplateResolution;
};

/** Never throws: a policy read must not break an assignment or a capture. */
export async function resolveReviewPolicyForEvidence(
  input: { teamId: string; evidenceId: string },
  client: PrismaClient,
): Promise<ResolvedReviewPolicy | null> {
  try {
    const templateResolution = await resolveTemplateIdForEvidence(input.evidenceId, client);
    const { policy, sources } = await resolveEffectiveSlaPolicy(
      { teamId: input.teamId, templateId: templateResolution.templateId },
      client,
    );
    const governance = await client.workspaceGovernancePolicy.findUnique({
      where: { teamId: input.teamId },
      select: { defaultReviewDueHours: true },
    });
    const reviewDueHours = governance?.defaultReviewDueHours ?? null;
    const templateOverridden = Object.keys(sources.template).length > 0;
    return {
      policy,
      stated: templateOverridden || Object.keys(sources.workspace).length > 0 || reviewDueHours !== null,
      templateOverridden,
      reviewDueHours,
      templateResolution,
    };
  } catch (err) {
    logWarn("reviewer_ops.sla_policy_resolve_failed", {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fills the row's empty deadline columns. Takes the caller's client, so it joins
 * the assignment's or the creation's transaction when given one.
 */
export async function stampReviewDeadlines(
  row: DbWorkflow,
  input: {
    /** Stamp only under a stated policy (a row nobody has been handed yet). */
    requireStatedPolicy: boolean;
    source: "capture_policy" | "assignment" | "open_review_sweep";
    actorUserId?: string | null;
    now?: Date;
  },
  client: PrismaClient,
): Promise<DbWorkflow> {
  if (!row.teamId) return row;
  if (row.completedAtUtc || row.closedAt) return row;
  if ((REVIEW_FINISHED_DB_STATUSES as ReadonlyArray<string>).includes(String(row.status))) return row;
  const resolved = await resolveReviewPolicyForEvidence(
    { teamId: row.teamId, evidenceId: row.evidenceId },
    client,
  );
  if (!resolved) return row;
  if (input.requireStatedPolicy && !resolved.stated) return row;

  const now = input.now ?? new Date();
  // At creation the clock starts with the row. For a row stamped later it starts
  // now, so an old row is given the whole window.
  const anchor = input.source === "capture_policy" ? row.createdAt : now;
  const next = reviewDeadlinesFromPolicy(resolved.policy, {
    anchor,
    reviewDueHours: resolved.reviewDueHours,
  });
  const data: Prisma.EvidenceReviewWorkflowUncheckedUpdateInput = {};
  if (!row.assignmentDueAtUtc) data.assignmentDueAtUtc = next.assignmentDueAtUtc;
  if (!row.firstResponseDueAtUtc) data.firstResponseDueAtUtc = next.firstResponseDueAtUtc;
  if (!row.completionDueAtUtc) data.completionDueAtUtc = next.completionDueAtUtc;
  if (!row.dueAt) data.dueAt = next.dueAt;
  if (!row.escalationDueAtUtc) data.escalationDueAtUtc = next.escalationDueAtUtc;
  if (row.slaDueSoonHours == null) data.slaDueSoonHours = next.slaDueSoonHours;
  if (Object.keys(data).length === 0) return row;
  const merged = { ...row, ...data } as DbWorkflow;
  const status = storedReviewSlaStatus(merged, { nowUtc: now });
  // A breach is left for the sweep, which owns its event and email.
  if (status && status !== "BREACHED") data.slaStatus = status;

  const updated = await client.evidenceReviewWorkflow.update({ where: { id: row.id }, data });
  await client.evidenceReviewWorkflowEvent.create({
    data: {
      workflowId: row.id,
      evidenceId: row.evidenceId,
      actorUserId: input.actorUserId ?? null,
      eventType: "SLA_UPDATED",
      previousValue: {
        dueAt: row.dueAt?.toISOString() ?? null,
        firstResponseDueAtUtc: row.firstResponseDueAtUtc?.toISOString() ?? null,
      } as Prisma.InputJsonValue,
      nextValue: {
        source: input.source,
        dueAt: updated.dueAt?.toISOString() ?? null,
        firstResponseDueAtUtc: updated.firstResponseDueAtUtc?.toISOString() ?? null,
        escalationDueAtUtc: updated.escalationDueAtUtc?.toISOString() ?? null,
        dueSoonHours: updated.slaDueSoonHours,
      } as Prisma.InputJsonValue,
    },
  });
  return updated;
}
