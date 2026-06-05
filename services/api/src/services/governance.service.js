/**
 * Phase 9 — Workspace governance service.
 *
 * Central policy resolver + enforcement helpers. Every sensitive action
 * answers its allow/deny question via one of these functions so policy
 * logic lives in exactly ONE place.
 *
 * Default behavior: a workspace with no `WorkspaceGovernancePolicy` row
 * gets `DEFAULT_POLICY` (permissive — preserves pre-Phase-9 behavior).
 * Existing teams require no migration.
 *
 * Privacy: governance policy + legal hold reasons are workspace-internal.
 * The route layer NEVER returns them to public verify, external intake,
 * or any unauthenticated surface.
 */
import * as prismaPkg from "@prisma/client";
import { roleHasPermission, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../db.js";
import { appendCustodyEvent } from "./custody-events.service.js";
import { emitWebhookEvent } from "./integrations/webhook-dispatcher.js";
// -----------------------------------------------------------------------------
// Default policy
// -----------------------------------------------------------------------------
export const DEFAULT_POLICY = {
    defaultRetentionDays: null,
    evidenceDeletionMode: prismaPkg.EvidenceDeletionMode.ALLOWED,
    requireLegalHoldApprovalForDeletion: false,
    requireReviewBeforeReport: false,
    requireReviewBeforePackage: false,
    requireReviewBeforePublicVerify: false,
    allowExternalIntake: true,
    allowAnonymousIntake: true,
    allowPublicVerify: true,
    allowPackageDownload: true,
    allowReportDownload: true,
    // Phase 10 — original-file download gate. Default permissive.
    allowOriginalDownload: true,
    // Phase 13.5 — review SLA default foundation. Null means no auto-SLA.
    defaultReviewDueHours: null,
    defaultFirstResponseDueHours: null,
    defaultEscalationDueHours: null,
    // Phase 14 — governance approval flags. False preserves pre-14 behavior.
    requirePublicationApproval: false,
    requireLegalHoldReleaseApproval: false,
    // Phase 25.5 — reviewer-ops SLA + step-up overrides. All optional /
    // false by default so existing workspaces continue to work unchanged.
    defaultAssignmentDueHours: null,
    defaultCompletionDueHours: null,
    defaultDueSoonHours: null,
    requireStepUpForApprove: false,
    requireStepUpForReject: false,
    requireStepUpForEscalationResolve: false,
    requireStepUpForBulk: false,
    reviewerInactivityHours: null,
};
export async function loadWorkspaceGovernancePolicy(teamId, client = defaultPrisma) {
    const row = await client.workspaceGovernancePolicy.findUnique({
        where: { teamId },
    });
    if (!row) {
        return { ...DEFAULT_POLICY, source: "default" };
    }
    return {
        defaultRetentionDays: row.defaultRetentionDays,
        evidenceDeletionMode: row.evidenceDeletionMode,
        requireLegalHoldApprovalForDeletion: row.requireLegalHoldApprovalForDeletion,
        requireReviewBeforeReport: row.requireReviewBeforeReport,
        requireReviewBeforePackage: row.requireReviewBeforePackage,
        requireReviewBeforePublicVerify: row.requireReviewBeforePublicVerify,
        allowExternalIntake: row.allowExternalIntake,
        allowAnonymousIntake: row.allowAnonymousIntake,
        allowPublicVerify: row.allowPublicVerify,
        allowPackageDownload: row.allowPackageDownload,
        allowReportDownload: row.allowReportDownload,
        allowOriginalDownload: row.allowOriginalDownload,
        defaultReviewDueHours: row.defaultReviewDueHours,
        defaultFirstResponseDueHours: row.defaultFirstResponseDueHours,
        defaultEscalationDueHours: row.defaultEscalationDueHours,
        requirePublicationApproval: row.requirePublicationApproval,
        requireLegalHoldReleaseApproval: row.requireLegalHoldReleaseApproval,
        // Phase 25.5 — reviewer-ops SLA + step-up flags.
        defaultAssignmentDueHours: row.defaultAssignmentDueHours,
        defaultCompletionDueHours: row.defaultCompletionDueHours,
        defaultDueSoonHours: row.defaultDueSoonHours,
        requireStepUpForApprove: row.requireStepUpForApprove,
        requireStepUpForReject: row.requireStepUpForReject,
        requireStepUpForEscalationResolve: row.requireStepUpForEscalationResolve,
        requireStepUpForBulk: row.requireStepUpForBulk,
        reviewerInactivityHours: row.reviewerInactivityHours,
        source: "workspace_row",
    };
}
export async function upsertWorkspaceGovernancePolicy(input, client = defaultPrisma) {
    return client.workspaceGovernancePolicy.upsert({
        where: { teamId: input.teamId },
        create: {
            teamId: input.teamId,
            updatedByUserId: input.actorUserId,
            ...input.patch,
        },
        update: {
            ...input.patch,
            updatedByUserId: input.actorUserId,
        },
    });
}
export function requirePermission(role, permission) {
    if (!role) {
        return { allowed: false, reason: "no_workspace_membership" };
    }
    if (roleHasPermission(role, permission)) {
        return { allowed: true };
    }
    return { allowed: false, reason: `role_${role}_lacks_${permission}` };
}
// -----------------------------------------------------------------------------
// Legal hold helpers
// -----------------------------------------------------------------------------
export async function isUnderActiveLegalHold(evidenceId, client = defaultPrisma) {
    const row = await client.evidenceLegalHold.findFirst({
        where: { evidenceId, status: prismaPkg.LegalHoldStatus.ACTIVE },
        select: { id: true },
    });
    return Boolean(row);
}
export async function listLegalHoldsForEvidence(evidenceId, client = defaultPrisma) {
    return client.evidenceLegalHold.findMany({
        where: { evidenceId },
        orderBy: { placedAtUtc: "desc" },
    });
}
// Phase 32.7.3 — explicit `select` clause to bound the query
// surface to columns the projection actually uses. Without this,
// Prisma's default-select pulls every declared field of
// `EvidenceLegalHold`, and the entire query P2022s if ANY column is
// missing in production (even columns the route doesn't return).
//
// Production reality (per Phase 32.7.3 brief): the runtime schema
// validator only confirms TABLE existence, not COLUMN existence.
// `evidence_legal_holds` exists in production with the bounded set
// of columns confirmed by operator inspection. The columns
// projected here are a strict subset of that confirmed set — they
// are the same columns `projectLegalHold` consumes.
const LEGAL_HOLD_SELECT = {
    id: true,
    teamId: true,
    evidenceId: true,
    caseId: true,
    title: true,
    reason: true,
    status: true,
    placedByUserId: true,
    placedAtUtc: true,
    releasedByUserId: true,
    releasedAtUtc: true,
    releaseNote: true,
};
export async function listLegalHoldsForTeam(input, client = defaultPrisma) {
    return client.evidenceLegalHold.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { placedAtUtc: "desc" },
        take: Math.min(Math.max(input.limit ?? 100, 1), 500),
        select: LEGAL_HOLD_SELECT,
    });
}
export async function placeLegalHold(input, client = defaultPrisma) {
    // Verify the evidence belongs to the workspace before placing the hold.
    const evidence = await client.evidence.findUnique({
        where: { id: input.evidenceId },
        select: { id: true, teamId: true },
    });
    if (!evidence || evidence.teamId !== input.teamId) {
        throw Object.assign(new Error("evidence_not_in_workspace"), {
            statusCode: 404,
            code: "evidence_not_found",
        });
    }
    const hold = await client.evidenceLegalHold.create({
        data: {
            teamId: input.teamId,
            evidenceId: input.evidenceId,
            caseId: input.caseId ?? null,
            title: input.title.slice(0, 180),
            reason: input.reason?.slice(0, 4000) ?? null,
            status: prismaPkg.LegalHoldStatus.ACTIVE,
            placedByUserId: input.actorUserId,
        },
    });
    // Emit a custody event into the existing forensic chain so the legal
    // hold is visible in the same audit timeline as integrity events.
    // Failures don't block — the hold is durable; chain emission is
    // observability.
    await appendCustodyEvent({
        evidenceId: input.evidenceId,
        eventType: prismaPkg.CustodyEventType.LEGAL_HOLD_PLACED,
        payload: {
            legalHoldId: hold.id,
            title: hold.title,
            placedByUserId: input.actorUserId,
        },
    }).catch(() => null);
    // Phase 10 — fire `governance.legal_hold_placed`. Reason is NEVER
    // emitted to the outbound payload (workspace-internal context).
    await emitWebhookEvent({
        teamId: input.teamId,
        eventType: "governance.legal_hold_placed",
        payload: {
            legalHoldId: hold.id,
            evidenceId: input.evidenceId,
            title: hold.title,
            caseId: hold.caseId,
            placedAtUtc: hold.placedAtUtc.toISOString(),
            // Deliberately NOT projected: reason.
        },
        attemptInline: false,
    }).catch(() => null);
    return hold;
}
export async function releaseLegalHold(input, client = defaultPrisma) {
    const note = input.releaseNote.trim();
    if (note.length === 0) {
        throw Object.assign(new Error("release_note_required"), {
            statusCode: 422,
            code: "release_note_required",
        });
    }
    const hold = await client.evidenceLegalHold.findUnique({
        where: { id: input.id },
    });
    if (!hold || hold.teamId !== input.teamId) {
        throw Object.assign(new Error("legal_hold_not_found"), {
            statusCode: 404,
            code: "legal_hold_not_found",
        });
    }
    if (hold.status === prismaPkg.LegalHoldStatus.RELEASED) {
        return hold;
    }
    const released = await client.evidenceLegalHold.update({
        where: { id: input.id },
        data: {
            status: prismaPkg.LegalHoldStatus.RELEASED,
            releasedAtUtc: new Date(),
            releasedByUserId: input.actorUserId,
            releaseNote: note.slice(0, 4000),
        },
    });
    await appendCustodyEvent({
        evidenceId: hold.evidenceId,
        eventType: prismaPkg.CustodyEventType.LEGAL_HOLD_RELEASED,
        payload: {
            legalHoldId: hold.id,
            releasedByUserId: input.actorUserId,
        },
    }).catch(() => null);
    return released;
}
export async function canDeleteEvidence(input) {
    const perm = requirePermission(input.role, "evidence.delete");
    if (!perm.allowed)
        return perm;
    if (input.policy.evidenceDeletionMode === "DISABLED") {
        return { allowed: false, reason: "deletion_disabled_by_policy" };
    }
    if (input.policy.evidenceDeletionMode === "ADMIN_ONLY" &&
        input.role !== "OWNER" &&
        input.role !== "ADMIN") {
        return { allowed: false, reason: "deletion_restricted_to_admin" };
    }
    // Retention check — never delete before retentionUntilUtc.
    if (input.evidence.retentionUntilUtc &&
        input.evidence.retentionUntilUtc.getTime() > Date.now()) {
        return { allowed: false, reason: "blocked_by_retention" };
    }
    // Legal hold check — pull holds via the client.
    const client = input.client ?? defaultPrisma;
    if (await isUnderActiveLegalHold(input.evidence.id, client)) {
        return { allowed: false, reason: "blocked_by_legal_hold" };
    }
    return { allowed: true };
}
export async function canArchiveEvidence(input) {
    const perm = requirePermission(input.role, "evidence.archive");
    if (!perm.allowed)
        return perm;
    const client = input.client ?? defaultPrisma;
    if (await isUnderActiveLegalHold(input.evidence.id, client)) {
        return { allowed: false, reason: "blocked_by_legal_hold" };
    }
    return { allowed: true };
}
export function canGenerateReport(input) {
    const perm = requirePermission(input.role, "evidence.generate_report");
    if (!perm.allowed)
        return perm;
    if (input.policy.requireReviewBeforeReport &&
        !input.reviewState?.isReviewed) {
        return { allowed: false, reason: "review_required_before_report" };
    }
    if (!input.policy.allowReportDownload) {
        return { allowed: false, reason: "report_disabled_by_policy" };
    }
    return { allowed: true };
}
export function canGeneratePackage(input) {
    const perm = requirePermission(input.role, "evidence.generate_package");
    if (!perm.allowed)
        return perm;
    if (input.policy.requireReviewBeforePackage &&
        !input.reviewState?.isReviewed) {
        return { allowed: false, reason: "review_required_before_package" };
    }
    if (!input.policy.allowPackageDownload) {
        return { allowed: false, reason: "package_disabled_by_policy" };
    }
    return { allowed: true };
}
export function canPublishPublicVerify(input) {
    const perm = requirePermission(input.role, "evidence.publish_verify");
    if (!perm.allowed)
        return perm;
    if (input.policy.requireReviewBeforePublicVerify &&
        !input.reviewState?.isReviewed) {
        return { allowed: false, reason: "review_required_before_public_verify" };
    }
    if (!input.policy.allowPublicVerify) {
        return { allowed: false, reason: "public_verify_disabled_by_policy" };
    }
    return { allowed: true };
}
export function canCreateIntakeLink(input) {
    const perm = requirePermission(input.role, "workflow.intake_link.create");
    if (!perm.allowed)
        return perm;
    if (!input.policy.allowExternalIntake) {
        return { allowed: false, reason: "external_intake_disabled_by_policy" };
    }
    const isAnonymous = input.intakeMode === "EXTERNAL_ANONYMOUS" ||
        input.intakeMode === "EXTERNAL_PSEUDONYMOUS";
    if (isAnonymous && !input.policy.allowAnonymousIntake) {
        return { allowed: false, reason: "anonymous_intake_disabled_by_policy" };
    }
    return { allowed: true };
}
export function canDownloadPackage(input) {
    const perm = requirePermission(input.role, "evidence.download_package");
    if (!perm.allowed)
        return perm;
    if (!input.policy.allowPackageDownload) {
        return { allowed: false, reason: "package_disabled_by_policy" };
    }
    return { allowed: true };
}
// -----------------------------------------------------------------------------
// Review-state resolver — answers "is this evidence reviewed enough to
// satisfy a `requireReviewBefore*` policy gate?"
//
// `IN_REVIEW`, `APPROVED_INTERNAL`, `READY_FOR_EXTERNAL_REVIEW` all
// count as "reviewed". `NOT_STARTED` and `NEEDS_INFO` do not.
// -----------------------------------------------------------------------------
/**
 * Phase 13.5 — pure predicate used by both `evidenceIsReviewed` (DB
 * lookup) and the governance regression tests. Returns true ONLY for
 * the two statuses that count as "approved for export":
 *   - APPROVED_INTERNAL (explicit operator decision)
 *   - READY_FOR_EXTERNAL_REVIEW (legacy: internal review concluded;
 *     handed off to external review)
 *
 * Everything else — including IN_REVIEW (mid-review),
 * NEEDS_INFO/NEEDS_MORE_INFO, RESPONSE_RECEIVED, ESCALATED, REOPENED,
 * QUEUED, ASSIGNED, REJECTED_INSUFFICIENT, CLOSED, NOT_STARTED — does
 * NOT satisfy the gate.
 */
export function reviewStatusSatisfiesGovernanceGate(status) {
    if (!status)
        return false;
    return (status ===
        prismaPkg.EvidenceReviewWorkflowStatus.APPROVED_INTERNAL ||
        status ===
            prismaPkg.EvidenceReviewWorkflowStatus.READY_FOR_EXTERNAL_REVIEW);
}
/**
 * Phase 14 — read + resolve the workspace metadata redaction policy.
 * The policy is stored as JSON on `WorkspaceGovernancePolicy.metadataRedactionDefault`
 * and merged with `DEFAULT_REDACTION_POLICY` (with public-verify floor
 * enforcement) by `resolveRedactionPolicy`. Returns the canonical
 * default policy when no override exists.
 */
export async function loadRedactionPolicy(teamId, client = defaultPrisma) {
    const { DEFAULT_REDACTION_POLICY, resolveRedactionPolicy } = await import("@proovra/shared");
    try {
        const row = await client.workspaceGovernancePolicy.findUnique({
            where: { teamId },
            select: { metadataRedactionDefault: true },
        });
        if (!row || !row.metadataRedactionDefault) {
            return DEFAULT_REDACTION_POLICY;
        }
        const override = row.metadataRedactionDefault;
        return resolveRedactionPolicy(override);
    }
    catch {
        return DEFAULT_REDACTION_POLICY;
    }
}
export async function evidenceIsReviewed(evidenceId, client = defaultPrisma) {
    const wf = await client.evidenceReviewWorkflow.findUnique({
        where: { evidenceId },
        select: { status: true },
    });
    if (!wf)
        return false;
    return reviewStatusSatisfiesGovernanceGate(wf.status);
}
export async function enforceSensitiveAction(action, ctx, client = defaultPrisma) {
    if (!ctx.teamId) {
        // Personal-scope evidence — Phase 9.5 governance applies only at the
        // workspace level. Allow.
        return { allowed: true };
    }
    let policy;
    try {
        policy = await loadWorkspaceGovernancePolicy(ctx.teamId, client);
    }
    catch (err) {
        // Fail closed on export / destructive actions. Read-only actions are
        // not routed through this function.
        return {
            allowed: false,
            code: "GOVERNANCE_CHECK_FAILED",
            reason: err instanceof Error
                ? `policy_lookup_failed:${err.message.slice(0, 120)}`
                : "policy_lookup_failed",
        };
    }
    let workspaceDecision;
    try {
        workspaceDecision = await evaluateWorkspaceSensitiveAction(action, ctx, policy, client);
    }
    catch (err) {
        return {
            allowed: false,
            code: "GOVERNANCE_CHECK_FAILED",
            reason: err instanceof Error
                ? `decision_failed:${err.message.slice(0, 120)}`
                : "decision_failed",
        };
    }
    if (!workspaceDecision.allowed)
        return workspaceDecision;
    // Phase 5 — workflow template `exportPolicyJson` overlay. Can ONLY
    // flip an already-ALLOWED workspace decision to a denial; it can
    // never enable an action workspace policy disallowed. Opt-in via
    // `ctx.consultTemplatePolicy`. Wrapped in try/catch so a template-
    // resolution failure can never break the primary export lifecycle.
    if (ctx.consultTemplatePolicy && isTemplateExportAction(action)) {
        try {
            const { resolveTemplateIdForEvidence } = await import("./reviewer-ops/reviewer-operations-engine.service.js");
            const { loadTemplateExportPolicy, evaluateTemplateExportOverlay } = await import("./governance/template-export-policy.service.js");
            const resolved = await resolveTemplateIdForEvidence(ctx.evidence.id, client);
            if (resolved.templateId) {
                const templatePolicy = await loadTemplateExportPolicy(resolved.templateId, client);
                const overlay = evaluateTemplateExportOverlay({
                    action,
                    role: ctx.role ?? null,
                    policy: templatePolicy,
                });
                if (!overlay.allowed) {
                    return overlay;
                }
            }
        }
        catch {
            // Fail-safe: any failure in the overlay path falls through to
            // the workspace decision (which already returned allowed).
        }
    }
    return workspaceDecision;
}
async function evaluateWorkspaceSensitiveAction(action, ctx, policy, client) {
    switch (action) {
        case "delete_evidence": {
            const decision = await canDeleteEvidence({
                role: ctx.role,
                evidence: ctx.evidence,
                policy,
                client,
            });
            return decision.allowed
                ? { allowed: true }
                : {
                    allowed: false,
                    code: deletionDecisionToCode(decision.reason),
                    reason: decision.reason,
                };
        }
        case "archive_evidence": {
            const decision = await canArchiveEvidence({
                role: ctx.role,
                evidence: ctx.evidence,
                policy,
                client,
            });
            return decision.allowed
                ? { allowed: true }
                : {
                    allowed: false,
                    code: "ARCHIVE_BLOCKED_BY_LEGAL_HOLD",
                    reason: decision.reason,
                };
        }
        case "generate_report": {
            const decision = canGenerateReport({
                role: ctx.role,
                policy,
                reviewState: ctx.reviewState,
            });
            return decision.allowed
                ? { allowed: true }
                : {
                    allowed: false,
                    code: "REPORT_BLOCKED_BY_POLICY",
                    reason: decision.reason,
                };
        }
        case "download_report": {
            if (!policy.allowReportDownload) {
                return {
                    allowed: false,
                    code: "REPORT_BLOCKED_BY_POLICY",
                    reason: "report_disabled_by_policy",
                };
            }
            const perm = requirePermission(ctx.role, "evidence.download_report");
            if (!perm.allowed) {
                return {
                    allowed: false,
                    code: "REPORT_BLOCKED_BY_POLICY",
                    reason: perm.reason,
                };
            }
            return { allowed: true };
        }
        case "generate_package": {
            const decision = canGeneratePackage({
                role: ctx.role,
                policy,
                reviewState: ctx.reviewState,
            });
            return decision.allowed
                ? { allowed: true }
                : {
                    allowed: false,
                    code: "PACKAGE_BLOCKED_BY_POLICY",
                    reason: decision.reason,
                };
        }
        case "download_package": {
            const decision = canDownloadPackage({ role: ctx.role, policy });
            return decision.allowed
                ? { allowed: true }
                : {
                    allowed: false,
                    code: "PACKAGE_BLOCKED_BY_POLICY",
                    reason: decision.reason,
                };
        }
        case "download_original": {
            if (!policy.allowOriginalDownload) {
                return {
                    allowed: false,
                    code: "ORIGINAL_DOWNLOAD_BLOCKED_BY_POLICY",
                    reason: "original_download_disabled_by_policy",
                };
            }
            const perm = requirePermission(ctx.role, "evidence.download_original");
            if (!perm.allowed) {
                return {
                    allowed: false,
                    code: "ORIGINAL_DOWNLOAD_BLOCKED_BY_POLICY",
                    reason: perm.reason,
                };
            }
            return { allowed: true };
        }
        case "publish_public_verify": {
            const decision = canPublishPublicVerify({
                role: ctx.role,
                policy,
                reviewState: ctx.reviewState,
            });
            return decision.allowed
                ? { allowed: true }
                : {
                    allowed: false,
                    code: "PUBLIC_VERIFY_BLOCKED_BY_POLICY",
                    reason: decision.reason,
                };
        }
    }
}
function isTemplateExportAction(action) {
    return (action === "generate_report" ||
        action === "download_report" ||
        action === "generate_package" ||
        action === "download_package" ||
        action === "publish_public_verify");
}
function deletionDecisionToCode(reason) {
    if (reason === "blocked_by_legal_hold")
        return "DELETE_BLOCKED_BY_LEGAL_HOLD";
    if (reason === "blocked_by_retention")
        return "DELETE_BLOCKED_BY_RETENTION";
    if (reason === "deletion_disabled_by_policy")
        return "DELETE_BLOCKED_BY_POLICY";
    if (reason === "deletion_restricted_to_admin")
        return "DELETE_RESTRICTED_TO_ADMIN";
    return "DELETE_BLOCKED";
}
// -----------------------------------------------------------------------------
// Retention application — called at evidence-create time.
//
// If the workspace policy specifies `defaultRetentionDays`, compute the
// resulting `retentionUntilUtc` and return it. Existing explicit retention
// (passed by the caller or pre-set on the evidence) is never SHORTENED;
// the longer of (explicit, policy-derived) wins.
//
// Returns null when no policy retention applies. Caller writes the value
// onto the Evidence row.
// -----------------------------------------------------------------------------
export async function resolveRetentionOnCreate(input) {
    if (!input.teamId)
        return null;
    const client = input.client ?? defaultPrisma;
    let policy;
    try {
        policy = await loadWorkspaceGovernancePolicy(input.teamId, client);
    }
    catch {
        return null; // create path is not destructive; degrade safely
    }
    if (!policy.defaultRetentionDays || policy.defaultRetentionDays <= 0) {
        return null;
    }
    const now = input.now ?? new Date();
    const policyRetention = new Date(now.getTime() + policy.defaultRetentionDays * 24 * 3600 * 1000);
    if (input.existingRetentionUntilUtc &&
        input.existingRetentionUntilUtc.getTime() >= policyRetention.getTime()) {
        // Existing explicit retention is at least as long — keep it.
        return null;
    }
    return { retentionUntilUtc: policyRetention, source: "workspace_policy" };
}
export async function applyRetentionPolicyOnCreate(input) {
    const client = input.client ?? defaultPrisma;
    const resolved = await resolveRetentionOnCreate({
        teamId: input.teamId,
        existingRetentionUntilUtc: input.existingRetentionUntilUtc,
        client,
    });
    if (!resolved)
        return { applied: false, retentionUntilUtc: null };
    await client.evidence.update({
        where: { id: input.evidenceId },
        data: { retentionUntilUtc: resolved.retentionUntilUtc },
    });
    // Phase 6 — Resolve template-identity trio for audit traceability.
    // Identity-only; never drives the retention decision.
    let templateProvenance = {
        templateSlug: null,
        templateVersion: null,
        templateDbId: null,
    };
    try {
        const ev = await client.evidence.findUnique({
            where: { id: input.evidenceId },
            select: {
                templateSlug: true,
                templateVersion: true,
                templateDbId: true,
            },
        });
        if (ev) {
            templateProvenance = {
                templateSlug: ev.templateSlug ?? null,
                templateVersion: ev.templateVersion ?? null,
                templateDbId: ev.templateDbId ?? null,
            };
        }
    }
    catch {
        /* identity propagation must never break retention application */
    }
    // No new custody event type for retention application — we reuse
    // the existing chain via a dedicated payload tag. The chain hashes
    // the payload, so reviewers can still inspect "retention applied by
    // policy" in the timeline.
    try {
        await appendCustodyEvent({
            evidenceId: input.evidenceId,
            eventType: prismaPkg.CustodyEventType.EVIDENCE_CREATED,
            payload: {
                retentionPolicyApplied: true,
                retentionUntilUtc: resolved.retentionUntilUtc.toISOString(),
                source: resolved.source,
                // Phase 6 — template provenance trio for downstream
                // traceability. Identity-only; never drives policy.
                templateSlug: templateProvenance.templateSlug,
                templateVersion: templateProvenance.templateVersion,
                templateDbId: templateProvenance.templateDbId,
            },
        });
    }
    catch {
        /* observability-only */
    }
    return { applied: true, retentionUntilUtc: resolved.retentionUntilUtc };
}
// -----------------------------------------------------------------------------
// emitPolicyBlockedEvent — helper for routes that need to record a
// blocked attempt into the custody chain.
// -----------------------------------------------------------------------------
export async function emitPolicyBlockedEvent(input) {
    try {
        await appendCustodyEvent({
            evidenceId: input.evidenceId,
            eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
            payload: {
                action: input.action,
                reason: input.reason,
                actorUserId: input.actorUserId ?? null,
            },
        });
    }
    catch {
        /* observability-only — never block the operator's response */
    }
    // Phase 10 — surface the blocked attempt to integration subscribers.
    // Look up the evidence's workspace; never emit when unknown.
    try {
        const ev = await defaultPrisma.evidence.findUnique({
            where: { id: input.evidenceId },
            select: { id: true, teamId: true },
        });
        if (ev && ev.teamId) {
            await emitWebhookEvent({
                teamId: ev.teamId,
                eventType: "governance.export_blocked",
                payload: {
                    evidenceId: ev.id,
                    action: input.action,
                    reason: input.reason,
                    // Deliberately NOT projected: actorUserId.
                },
                attemptInline: false,
            });
        }
    }
    catch {
        /* never break the caller on webhook emission */
    }
}
// -----------------------------------------------------------------------------
// Public projection — internal-only fields only.
// -----------------------------------------------------------------------------
export function projectEffectivePolicy(policy) {
    // Currently the same shape; placeholder for future redaction.
    return policy;
}
// Phase 32.7.3 — accept the bounded projection type so callers
// using the explicit `select` clause in `listLegalHoldsForTeam`
// type-check correctly. Existing callers that pass a full
// `DbLegalHold` continue to work (it's a superset).
export function projectLegalHold(hold) {
    return {
        id: hold.id,
        teamId: hold.teamId,
        evidenceId: hold.evidenceId,
        caseId: hold.caseId,
        title: hold.title,
        reason: hold.reason,
        status: hold.status,
        placedByUserId: hold.placedByUserId,
        placedAtUtc: hold.placedAtUtc.toISOString(),
        releasedByUserId: hold.releasedByUserId,
        releasedAtUtc: hold.releasedAtUtc?.toISOString() ?? null,
        releaseNote: hold.releaseNote,
    };
}
