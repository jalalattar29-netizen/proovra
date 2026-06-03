/**
 * Phase 25.5 — SLA policy resolver.
 *
 * Resolves the effective SLA policy for a given workspace + optional
 * workflow template. Precedence (most-specific wins):
 *
 *   templateOverride  >  workspaceOverride  >  envDefaults  >  shared defaults
 *
 * Workspace overrides come from `WorkspaceGovernancePolicy`:
 *   - default_assignment_due_hours
 *   - default_first_response_due_hours
 *   - default_completion_due_hours
 *   - default_escalation_due_hours
 *   - default_due_soon_hours
 *
 * Template overrides come from `EvidenceWorkflowTemplate.reviewPolicyJson`
 * under the `sla` key, validated by `ReviewerOpsSlaPolicySchema`. Invalid
 * shapes are ignored (fail-open to lower-precedence values).
 */
import { REVIEWER_OPS_DEFAULT_SLA_POLICY, REVIEWER_OPS_SLA_POLICY_HOURS_MAX, REVIEWER_OPS_SLA_POLICY_HOURS_MIN, ReviewerOpsSlaPolicySchema, resolveReviewerOpsSlaPolicy, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
// -----------------------------------------------------------------------------
// Env defaults — read at call time so test harnesses can override.
// -----------------------------------------------------------------------------
function envOverride() {
    const parse = (key) => {
        const raw = process.env[key];
        if (!raw)
            return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n))
            return undefined;
        if (n < REVIEWER_OPS_SLA_POLICY_HOURS_MIN)
            return undefined;
        if (n > REVIEWER_OPS_SLA_POLICY_HOURS_MAX)
            return undefined;
        return Math.floor(n);
    };
    const out = {};
    const a = parse("REVIEW_SLA_ASSIGNMENT_HOURS");
    if (a !== undefined)
        out.assignmentHours = a;
    const f = parse("REVIEW_SLA_FIRST_REVIEW_HOURS");
    if (f !== undefined)
        out.firstReviewHours = f;
    const c = parse("REVIEW_SLA_COMPLETION_HOURS");
    if (c !== undefined)
        out.completionHours = c;
    const e = parse("REVIEW_SLA_ESCALATION_HOURS");
    if (e !== undefined)
        out.escalationHours = e;
    const d = parse("REVIEW_SLA_DUE_SOON_HOURS");
    if (d !== undefined)
        out.dueSoonHours = d;
    return out;
}
// -----------------------------------------------------------------------------
// Workspace override loader
// -----------------------------------------------------------------------------
async function loadWorkspaceOverride(teamId, client) {
    const row = await client.workspaceGovernancePolicy.findUnique({
        where: { teamId },
    });
    if (!row)
        return {};
    const out = {};
    if (row.defaultAssignmentDueHours != null) {
        out.assignmentHours = row.defaultAssignmentDueHours;
    }
    // Phase 13.5's `defaultFirstResponseDueHours` is the first-review SLA.
    if (row.defaultFirstResponseDueHours != null) {
        out.firstReviewHours = row.defaultFirstResponseDueHours;
    }
    if (row.defaultCompletionDueHours != null) {
        out.completionHours = row.defaultCompletionDueHours;
    }
    if (row.defaultEscalationDueHours != null) {
        out.escalationHours = row.defaultEscalationDueHours;
    }
    if (row.defaultDueSoonHours != null) {
        out.dueSoonHours = row.defaultDueSoonHours;
    }
    return out;
}
// -----------------------------------------------------------------------------
// Template override loader
// -----------------------------------------------------------------------------
async function loadTemplateOverride(templateId, client) {
    if (!templateId)
        return {};
    const row = await client.evidenceWorkflowTemplate.findUnique({
        where: { id: templateId },
        select: { reviewPolicyJson: true },
    });
    if (!row?.reviewPolicyJson)
        return {};
    const candidate = row.reviewPolicyJson.sla;
    if (!candidate || typeof candidate !== "object")
        return {};
    const parsed = ReviewerOpsSlaPolicySchema.safeParse(candidate);
    if (!parsed.success)
        return {};
    return parsed.data;
}
export async function resolveEffectiveSlaPolicy(input, client = defaultPrisma) {
    const [workspace, template] = await Promise.all([
        loadWorkspaceOverride(input.teamId, client),
        loadTemplateOverride(input.templateId ?? null, client),
    ]);
    const env = envOverride();
    const policy = resolveReviewerOpsSlaPolicy({
        templateOverride: template,
        workspaceOverride: workspace,
        envDefaults: env,
    });
    return {
        policy,
        sources: { template, workspace, env },
    };
}
export async function upsertWorkspaceSlaPolicy(input, client = defaultPrisma) {
    // Re-validate via the shared schema; the route layer should have
    // validated already, but defence in depth.
    const parsed = ReviewerOpsSlaPolicySchema.safeParse(input.overrides);
    if (!parsed.success) {
        throw new Error("invalid_sla_policy_overrides");
    }
    const o = parsed.data;
    await client.workspaceGovernancePolicy.upsert({
        where: { teamId: input.teamId },
        update: {
            defaultAssignmentDueHours: o.assignmentHours ?? null,
            defaultFirstResponseDueHours: o.firstReviewHours ?? null,
            defaultCompletionDueHours: o.completionHours ?? null,
            defaultEscalationDueHours: o.escalationHours ?? null,
            defaultDueSoonHours: o.dueSoonHours ?? null,
            updatedByUserId: input.actorUserId,
        },
        create: {
            teamId: input.teamId,
            defaultAssignmentDueHours: o.assignmentHours ?? null,
            defaultFirstResponseDueHours: o.firstReviewHours ?? null,
            defaultCompletionDueHours: o.completionHours ?? null,
            defaultEscalationDueHours: o.escalationHours ?? null,
            defaultDueSoonHours: o.dueSoonHours ?? null,
            updatedByUserId: input.actorUserId,
        },
    });
    return o;
}
export async function loadWorkspaceReviewerOpsFlags(teamId, client = defaultPrisma) {
    const row = await client.workspaceGovernancePolicy.findUnique({
        where: { teamId },
        select: {
            requireStepUpForApprove: true,
            requireStepUpForReject: true,
            requireStepUpForEscalationResolve: true,
            requireStepUpForBulk: true,
            reviewerInactivityHours: true,
        },
    });
    return {
        requireStepUpForApprove: row?.requireStepUpForApprove ?? false,
        requireStepUpForReject: row?.requireStepUpForReject ?? false,
        requireStepUpForEscalationResolve: row?.requireStepUpForEscalationResolve ?? false,
        requireStepUpForBulk: row?.requireStepUpForBulk ?? false,
        reviewerInactivityHours: row?.reviewerInactivityHours ?? null,
    };
}
export async function upsertWorkspaceReviewerOpsFlags(input, client = defaultPrisma) {
    const f = input.flags;
    await client.workspaceGovernancePolicy.upsert({
        where: { teamId: input.teamId },
        update: {
            ...(f.requireStepUpForApprove !== undefined
                ? { requireStepUpForApprove: f.requireStepUpForApprove }
                : {}),
            ...(f.requireStepUpForReject !== undefined
                ? { requireStepUpForReject: f.requireStepUpForReject }
                : {}),
            ...(f.requireStepUpForEscalationResolve !== undefined
                ? {
                    requireStepUpForEscalationResolve: f.requireStepUpForEscalationResolve,
                }
                : {}),
            ...(f.requireStepUpForBulk !== undefined
                ? { requireStepUpForBulk: f.requireStepUpForBulk }
                : {}),
            ...(f.reviewerInactivityHours !== undefined
                ? { reviewerInactivityHours: f.reviewerInactivityHours }
                : {}),
            updatedByUserId: input.actorUserId,
        },
        create: {
            teamId: input.teamId,
            requireStepUpForApprove: f.requireStepUpForApprove ?? false,
            requireStepUpForReject: f.requireStepUpForReject ?? false,
            requireStepUpForEscalationResolve: f.requireStepUpForEscalationResolve ?? false,
            requireStepUpForBulk: f.requireStepUpForBulk ?? false,
            reviewerInactivityHours: f.reviewerInactivityHours ?? null,
            updatedByUserId: input.actorUserId,
        },
    });
    return loadWorkspaceReviewerOpsFlags(input.teamId, client);
}
export { REVIEWER_OPS_DEFAULT_SLA_POLICY };
