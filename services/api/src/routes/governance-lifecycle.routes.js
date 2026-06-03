/**
 * Phase 27 — Governance Lifecycle routes.
 *
 *   Retention policies:
 *     GET    /v1/governance/retention-policies?teamId&status&scope
 *     POST   /v1/governance/retention-policies                 (ADMIN+)
 *     PATCH  /v1/governance/retention-policies/:id             (ADMIN+)
 *     POST   /v1/governance/retention-policies/:id/transition  (ADMIN+)
 *     GET    /v1/governance/retention-policies/:id/versions
 *     GET    /v1/governance/retention-policies/effective       (resolver)
 *
 *   Destruction queue:
 *     GET    /v1/governance/destruction-reviews?teamId&status
 *     POST   /v1/governance/destruction-reviews                (ADMIN+ create)
 *     GET    /v1/governance/destruction-reviews/:id
 *     POST   /v1/governance/destruction-reviews/:id/transition (ADMIN+ + step-up on APPROVED/EXECUTED)
 *
 *   Lifecycle:
 *     GET    /v1/governance/lifecycle/evidence/:id/events?teamId
 *     POST   /v1/governance/lifecycle/evidence/:id/transition  (ADMIN+ + step-up on PENDING_DESTRUCTION/DESTROYED)
 *
 *   Export gate:
 *     GET    /v1/governance/export-eligibility?teamId&evidenceId
 *
 *   Dashboard aggregate:
 *     GET    /v1/governance/dashboard?teamId
 *
 * Every mutating route checks workspace membership + the canonical
 * permission. Hold-affecting and destruction routes additionally
 * require step-up. NEVER returns privileged legal text — the routes
 * project the data via the service `project*` helpers, which strip
 * fields the dashboards must not see.
 */
import { z } from "zod";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../services/governance.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { RetentionEngineError, countActivePolicyConflicts, createRetentionPolicy, listPolicyVersions, listRetentionPolicies, resolveEffectiveRetentionPolicy, transitionRetentionPolicy, updateRetentionPolicy, } from "../services/governance-lifecycle/retention-engine.service.js";
import { DestructionReviewError, countActiveDestructionReviews, countPendingDestructionByEvidence, createDestructionReview, getDestructionReview, listDestructionReviews, transitionDestructionReview, } from "../services/governance-lifecycle/destruction-review.service.js";
import { LifecycleOrchestratorError, countByLifecycleState, listLifecycleEvents, transitionLifecycle, } from "../services/governance-lifecycle/lifecycle-orchestrator.service.js";
import { checkExportEligibility } from "../services/governance-lifecycle/export-governance.service.js";
import { resolveTeamRetentionPolicy } from "../services/organization/retention-inheritance.service.js";
import { DESTRUCTION_REVIEW_REASONS, DESTRUCTION_REVIEW_STATUSES, EVIDENCE_LIFECYCLE_STATES, RETENTION_POLICY_SCOPES, RETENTION_POLICY_STATUSES, } from "@proovra/shared";
const ParamsId = z.object({ id: z.string().uuid() });
async function requireMember(req, reply, teamId) {
    const userId = getAuthUserId(req);
    const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
    });
    if (!membership) {
        reply.code(403).send({ message: "Not a member of the workspace" });
        return null;
    }
    return { userId, role: membership.role };
}
function denyByPermission(reply, reason) {
    reply.code(403).send({
        error: { code: "permission_denied", reason },
    });
}
function mapRetentionError(reply, err) {
    const code = err.code;
    if (code === "RETENTION_POLICY_NOT_FOUND") {
        return reply.code(404).send({ error: { code } });
    }
    if (code === "RETENTION_POLICY_DUPLICATE") {
        return reply.code(409).send({ error: { code } });
    }
    if (code === "RETENTION_POLICY_TERMINAL") {
        return reply.code(409).send({ error: { code, details: err.details } });
    }
    return reply.code(400).send({ error: { code, details: err.details } });
}
function mapDestructionError(reply, err) {
    const code = err.code;
    if (code === "DESTRUCTION_REVIEW_NOT_FOUND") {
        return reply.code(404).send({ error: { code } });
    }
    if (code === "DESTRUCTION_REVIEW_ACTIVE") {
        return reply.code(409).send({ error: { code, details: err.details } });
    }
    if (code === "DESTRUCTION_REVIEW_TERMINAL") {
        return reply.code(409).send({ error: { code, details: err.details } });
    }
    if (code === "DESTRUCTION_REVIEW_BLOCKED_BY_HOLD" ||
        code === "DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE" ||
        code === "DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE") {
        return reply.code(409).send({ error: { code, details: err.details } });
    }
    return reply.code(400).send({ error: { code, details: err.details } });
}
function mapLifecycleError(reply, err) {
    const code = err.code;
    if (code === "LIFECYCLE_EVIDENCE_NOT_FOUND") {
        return reply.code(404).send({ error: { code } });
    }
    if (code === "LIFECYCLE_BLOCKED_BY_HOLD" ||
        code === "LIFECYCLE_BLOCKED_BY_IMMUTABLE" ||
        code === "LIFECYCLE_TERMINAL_STATE") {
        return reply.code(409).send({ error: { code, details: err.details } });
    }
    return reply.code(400).send({ error: { code, details: err.details } });
}
export async function governanceLifecycleRoutes(app) {
    // ===========================================================================
    // Retention policies
    // ===========================================================================
    app.get("/v1/governance/retention-policies", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            status: z.enum([...RETENTION_POLICY_STATUSES, "ALL"]).optional(),
            scope: z.enum(RETENTION_POLICY_SCOPES).optional(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const policies = await listRetentionPolicies({
            teamId: query.teamId,
            status: query.status,
            scope: query.scope,
            limit: query.limit,
        });
        return reply.code(200).send({ policies });
    });
    app.post("/v1/governance/retention-policies", { preHandler: requireAuth }, async (req, reply) => {
        const body = z
            .object({
            teamId: z.string().uuid(),
            displayName: z.string().min(1).max(180),
            description: z.string().max(2000).nullable().optional(),
            scope: z.enum(RETENTION_POLICY_SCOPES),
            scopeQualifier: z.string().min(1).max(40).nullable().optional(),
            caseId: z.string().uuid().nullable().optional(),
            retentionDays: z.number().int().min(0).max(36500).nullable().optional(),
            immutable: z.boolean().optional(),
            autoExtensionEnabled: z.boolean().optional(),
            autoExtensionDays: z.number().int().min(1).max(36500).nullable().optional(),
            changeNote: z.string().min(1).max(2000).optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.manage");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: ok.userId,
            purpose: "RETENTION_POLICY_UPDATE",
            resourceKind: "evidence_retention_policy",
            resourceId: body.teamId,
        });
        if (gate.sent)
            return;
        try {
            const policy = await createRetentionPolicy({
                ...body,
                actorUserId: ok.userId,
            });
            return reply.code(201).send({ policy });
        }
        catch (err) {
            if (err instanceof RetentionEngineError)
                return mapRetentionError(reply, err);
            throw err;
        }
    });
    app.patch("/v1/governance/retention-policies/:id", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            displayName: z.string().min(1).max(180).optional(),
            description: z.string().max(2000).nullable().optional(),
            retentionDays: z.number().int().min(0).max(36500).nullable().optional(),
            immutable: z.boolean().optional(),
            autoExtensionEnabled: z.boolean().optional(),
            autoExtensionDays: z.number().int().min(1).max(36500).nullable().optional(),
            changeNote: z.string().min(1).max(2000),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.manage");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: ok.userId,
            purpose: "RETENTION_POLICY_UPDATE",
            resourceKind: "evidence_retention_policy",
            resourceId: id,
        });
        if (gate.sent)
            return;
        try {
            const policy = await updateRetentionPolicy({
                ...body,
                id,
                actorUserId: ok.userId,
            });
            return reply.code(200).send({ policy });
        }
        catch (err) {
            if (err instanceof RetentionEngineError)
                return mapRetentionError(reply, err);
            throw err;
        }
    });
    app.post("/v1/governance/retention-policies/:id/transition", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            nextStatus: z.enum(RETENTION_POLICY_STATUSES),
            supersededByPolicyId: z.string().uuid().nullable().optional(),
            changeNote: z.string().min(1).max(2000),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.manage");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: ok.userId,
            purpose: "RETENTION_POLICY_UPDATE",
            resourceKind: "evidence_retention_policy",
            resourceId: id,
        });
        if (gate.sent)
            return;
        try {
            const policy = await transitionRetentionPolicy({
                ...body,
                id,
                actorUserId: ok.userId,
            });
            return reply.code(200).send({ policy });
        }
        catch (err) {
            if (err instanceof RetentionEngineError)
                return mapRetentionError(reply, err);
            throw err;
        }
    });
    app.get("/v1/governance/retention-policies/:id/versions", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const query = z
            .object({
            teamId: z.string().uuid(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        try {
            const versions = await listPolicyVersions({
                teamId: query.teamId,
                id,
                limit: query.limit,
            });
            return reply.code(200).send({ versions });
        }
        catch (err) {
            if (err instanceof RetentionEngineError)
                return mapRetentionError(reply, err);
            throw err;
        }
    });
    app.get("/v1/governance/retention-policies/effective", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            evidenceType: z.string().min(1).max(40).optional(),
            caseId: z.string().uuid().optional(),
            jurisdiction: z.string().min(1).max(40).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const decision = await resolveEffectiveRetentionPolicy({
            teamId: query.teamId,
            evidenceType: query.evidenceType ?? null,
            caseId: query.caseId ?? null,
            jurisdiction: query.jurisdiction ?? null,
        });
        return reply.code(200).send(decision);
    });
    // ===========================================================================
    // Destruction reviews
    // ===========================================================================
    app.get("/v1/governance/destruction-reviews", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            status: z
                .enum([...DESTRUCTION_REVIEW_STATUSES, "ACTIVE", "ALL"])
                .optional(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const reviews = await listDestructionReviews({
            teamId: query.teamId,
            status: query.status,
            limit: query.limit,
        });
        return reply.code(200).send({ reviews });
    });
    app.post("/v1/governance/destruction-reviews", { preHandler: requireAuth }, async (req, reply) => {
        const body = z
            .object({
            teamId: z.string().uuid(),
            evidenceId: z.string().uuid(),
            reason: z.enum(DESTRUCTION_REVIEW_REASONS),
            retentionPolicyId: z.string().uuid().nullable().optional(),
            retentionPolicyVersion: z.number().int().min(1).nullable().optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "evidence.delete");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        try {
            const review = await createDestructionReview({
                ...body,
                actorUserId: ok.userId,
                requestId: req.id,
            });
            return reply.code(201).send({ review });
        }
        catch (err) {
            if (err instanceof DestructionReviewError)
                return mapDestructionError(reply, err);
            throw err;
        }
    });
    app.get("/v1/governance/destruction-reviews/:id", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const query = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        try {
            const review = await getDestructionReview({ teamId: query.teamId, id });
            return reply.code(200).send({ review });
        }
        catch (err) {
            if (err instanceof DestructionReviewError)
                return mapDestructionError(reply, err);
            throw err;
        }
    });
    // ---------------------------------------------------------------------
    // Phase F — Governance impact preview for a destruction review.
    //
    // GET /v1/governance/destruction-reviews/:id/preview?teamId=...
    //
    // Returns a deterministic projection of the operational consequences
    // of executing this review. Read-only — no audit emission, no state
    // mutation, no certificate generation. Operators see exactly what
    // will happen BEFORE they click "Approve" or "Execute".
    //
    // The preview NEVER claims legal admissibility. It is an operational
    // impact summary: what evidence is in scope, what blocks the
    // destruction, what audit references will persist, what is
    // irreversible.
    //
    // Workspace isolation: same `requireMember(teamId)` + permission
    // gate as the rest of the destruction-review surface.
    // ---------------------------------------------------------------------
    app.get("/v1/governance/destruction-reviews/:id/preview", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const review = await prisma.destructionReview.findFirst({
            where: { id, teamId: query.teamId },
            select: {
                id: true,
                teamId: true,
                evidenceId: true,
                retentionPolicyId: true,
                retentionPolicyVersion: true,
                status: true,
                reason: true,
                decisionNote: true,
                deferredUntilUtc: true,
                executedAtUtc: true,
                certificateHash: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        if (!review) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        const evidence = await prisma.evidence.findFirst({
            where: { id: review.evidenceId, teamId: query.teamId },
            select: {
                id: true,
                title: true,
                lifecycleState: true,
                retentionPolicyVersionId: true,
                activeDestructionReviewId: true,
                createdAt: true,
            },
        });
        const linkedCaseIds = evidence
            ? (await prisma.caseEvidenceLink.findMany({
                where: { teamId: query.teamId, evidenceId: evidence.id },
                select: { caseId: true },
            })).map((l) => l.caseId)
            : [];
        const [evidenceHolds, caseHolds] = await Promise.all([
            prisma.evidenceLegalHold.findMany({
                where: {
                    teamId: query.teamId,
                    evidenceId: review.evidenceId,
                    status: "ACTIVE",
                },
                select: {
                    id: true,
                    title: true,
                    placedAtUtc: true,
                    caseId: true,
                },
            }),
            // Case-level holds are inherited via the evidence's case
            // links. We resolve via `CaseEvidenceLink` because there is
            // no `Case.evidenceLinks` back-relation declared in the
            // schema.
            linkedCaseIds.length > 0
                ? prisma.caseLegalHold.findMany({
                    where: {
                        teamId: query.teamId,
                        status: "ACTIVE",
                        caseId: { in: linkedCaseIds },
                    },
                    select: { id: true, title: true, placedAtUtc: true, caseId: true },
                })
                : Promise.resolve([]),
        ]);
        let policy = null;
        if (review.retentionPolicyId) {
            const p = await prisma.evidenceRetentionPolicy.findFirst({
                where: { id: review.retentionPolicyId, teamId: query.teamId },
                select: {
                    id: true,
                    displayName: true,
                    retentionDays: true,
                    immutable: true,
                    status: true,
                },
            });
            if (p)
                policy = p;
        }
        const lifecycleEventCount = await prisma.evidenceLifecycleEvent.count({
            where: { teamId: query.teamId, evidenceId: review.evidenceId },
        });
        const blockedBy = [];
        if (evidenceHolds.length > 0)
            blockedBy.push("evidence_legal_hold");
        if (caseHolds.length > 0)
            blockedBy.push("case_legal_hold");
        if (policy?.immutable)
            blockedBy.push("retention_policy_immutable");
        if (evidence?.lifecycleState === "DESTROYED" ||
            review.status === "EXECUTED") {
            blockedBy.push("already_destroyed");
        }
        return reply.code(200).send({
            review: {
                id: review.id,
                status: review.status,
                reason: review.reason,
                decisionNote: review.decisionNote,
                deferredUntilUtc: review.deferredUntilUtc?.toISOString() ?? null,
                executedAtUtc: review.executedAtUtc?.toISOString() ?? null,
                certificateHash: review.certificateHash,
                createdAt: review.createdAt.toISOString(),
                updatedAt: review.updatedAt.toISOString(),
            },
            evidence: evidence
                ? {
                    id: evidence.id,
                    title: evidence.title,
                    lifecycleState: evidence.lifecycleState,
                    createdAt: evidence.createdAt.toISOString(),
                }
                : null,
            policy,
            holds: {
                evidence: evidenceHolds.map((h) => ({
                    id: h.id,
                    title: h.title,
                    placedAtUtc: h.placedAtUtc.toISOString(),
                    source: "evidence",
                    caseId: h.caseId,
                })),
                case: caseHolds.map((h) => ({
                    id: h.id,
                    title: h.title,
                    placedAtUtc: h.placedAtUtc.toISOString(),
                    source: "case",
                    caseId: h.caseId,
                })),
            },
            impact: {
                // What will be removed when EXECUTED.
                willDelete: [
                    "evidence_storage_object",
                    "evidence_part_references",
                ],
                // What will PERSIST as operational traceability. The
                // operator must understand that destruction is NOT total
                // erasure — the audit trail, lifecycle ledger, and
                // certificate stay.
                willPersist: [
                    "evidence_record_tombstone",
                    "lifecycle_event_ledger",
                    "destruction_certificate",
                    "audit_log_references",
                ],
                irreversible: review.status !== "EXECUTED",
                lifecycleEventCount,
            },
            blockedBy,
            guidance: blockedBy.length === 0
                ? "No blockers detected. Destruction will proceed when an authorised reviewer transitions this review to EXECUTED with a step-up token."
                : "One or more blockers prevent destruction. Release holds and / or supersede immutable policy before retrying.",
        });
    });
    // ---------------------------------------------------------------------
    // Phase F — Destruction certificate retrieval.
    //
    // GET /v1/governance/destruction-reviews/:id/certificate?teamId=...
    //
    // Returns the operational destruction certificate for an EXECUTED
    // review. The certificate is composed from:
    //   * the EXECUTED review row (decision metadata + cert hash),
    //   * the lifecycle event with eventType = "destruction_executed"
    //     (which carries the canonical certificate body + lineage hash
    //     in `metadata`).
    //
    // The certificate is OPERATIONAL TRACEABILITY — never a legal
    // admissibility statement, never a cryptographic proof of total
    // erasure, never a guarantee of downstream deletion in caches,
    // backups, or third-party systems. Those caveats are surfaced as
    // structured `caveats` so the frontend renders them verbatim.
    //
    // Workspace isolation: same `requireMember(teamId)` + permission
    // gate as the rest of the destruction-review surface.
    // ---------------------------------------------------------------------
    app.get("/v1/governance/destruction-reviews/:id/certificate", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const review = await prisma.destructionReview.findFirst({
            where: { id, teamId: query.teamId },
            select: {
                id: true,
                teamId: true,
                evidenceId: true,
                status: true,
                reason: true,
                decisionNote: true,
                decidedByUserId: true,
                decidedAtUtc: true,
                executedAtUtc: true,
                certificateHash: true,
                retentionPolicyId: true,
                retentionPolicyVersion: true,
                createdAt: true,
            },
        });
        if (!review) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        if (review.status !== "EXECUTED") {
            return reply.code(409).send({
                error: {
                    code: "certificate_unavailable",
                    message: "Destruction certificates are only generated for EXECUTED reviews.",
                },
            });
        }
        // The canonical certificate body + lineage hash live on the
        // destruction_executed lifecycle event's metadata. Fall back to
        // a minimal projection if the event is unexpectedly absent
        // (defensive — shouldn't happen, but the certificate must still
        // be retrievable for audit).
        const executedEvent = await prisma.evidenceLifecycleEvent.findFirst({
            where: {
                teamId: query.teamId,
                evidenceId: review.evidenceId,
                eventType: "destruction_executed",
            },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                createdAt: true,
                summary: true,
                metadata: true,
                actorUserId: true,
            },
        });
        const certificate = {
            // === IDENTIFIERS ===
            reviewId: review.id,
            evidenceId: review.evidenceId,
            teamId: review.teamId,
            // === EXECUTION FACTS ===
            executedAtUtc: review.executedAtUtc?.toISOString() ?? null,
            decidedAtUtc: review.decidedAtUtc?.toISOString() ?? null,
            decidedByUserId: review.decidedByUserId,
            reason: review.reason,
            decisionNote: review.decisionNote,
            // === GOVERNING POLICY ===
            retentionPolicyId: review.retentionPolicyId,
            retentionPolicyVersion: review.retentionPolicyVersion,
            // === LINEAGE / INTEGRITY ===
            certificateHash: review.certificateHash,
            lifecycleEventId: executedEvent?.id ?? null,
            lineageHash: executedEvent?.metadata && typeof executedEvent.metadata === "object"
                ? executedEvent.metadata["lineageHash"]
                    ?? null
                : null,
            // === REVIEW PROVENANCE ===
            reviewCreatedAt: review.createdAt.toISOString(),
            eventSummary: executedEvent?.summary ?? null,
        };
        return reply.code(200).send({
            certificate,
            caveats: [
                // The frontend renders these verbatim — DO NOT alter the
                // wording without coordinating with the governance UX
                // copy review.
                "This certificate is an operational traceability record. It is not a legal admissibility statement.",
                "Destruction removes the original storage object. Evidence record tombstones, lifecycle event ledger entries, and destruction audit logs PERSIST and are intentionally not erased.",
                "This certificate does not assert cryptographic proof of total erasure across replicas, backups, or downstream third-party systems. Coordinate with platform operations for compliance attestations.",
            ],
        });
    });
    // ---------------------------------------------------------------------
    // Phase F — Retention inheritance resolver projection.
    //
    // GET /v1/governance/retention/inheritance?teamId=...
    //
    // Surfaces the Phase B0 `resolveTeamRetentionPolicy` resolver so the
    // retention UI can render the inheritance source ("team_policy" /
    // "org_policy_inherited" / "none") with provenance instead of
    // operators inferring it from the policy list.
    // ---------------------------------------------------------------------
    app.get("/v1/governance/retention/inheritance", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const resolution = await resolveTeamRetentionPolicy(query.teamId);
        return reply.code(200).send({ resolution });
    });
    app.post("/v1/governance/destruction-reviews/:id/transition", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            nextStatus: z.enum(DESTRUCTION_REVIEW_STATUSES),
            decisionNote: z.string().min(1).max(2000).nullable().optional(),
            deferredUntilUtc: z.string().datetime().nullable().optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "evidence.delete");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        // Step-up required for APPROVED + EXECUTED (the destructive
        // branches). The other transitions are operator-recoverable.
        if (body.nextStatus === "APPROVED" || body.nextStatus === "EXECUTED") {
            const gate = await requireStepUpForSensitiveAction({
                req, reply,
                teamId: body.teamId,
                userId: ok.userId,
                purpose: body.nextStatus === "APPROVED"
                    ? "EVIDENCE_DESTRUCTION_APPROVE"
                    : "EVIDENCE_DESTRUCTION_EXECUTE",
                resourceKind: "destruction_review",
                resourceId: id,
            });
            if (gate.sent)
                return;
        }
        try {
            const review = await transitionDestructionReview({
                teamId: body.teamId,
                id,
                actorUserId: ok.userId,
                nextStatus: body.nextStatus,
                decisionNote: body.decisionNote ?? null,
                deferredUntilUtc: body.deferredUntilUtc
                    ? new Date(body.deferredUntilUtc)
                    : null,
                requestId: req.id,
            });
            return reply.code(200).send({ review });
        }
        catch (err) {
            if (err instanceof DestructionReviewError)
                return mapDestructionError(reply, err);
            if (err instanceof LifecycleOrchestratorError)
                return mapLifecycleError(reply, err);
            throw err;
        }
    });
    // ===========================================================================
    // Lifecycle events
    // ===========================================================================
    app.get("/v1/governance/lifecycle/evidence/:id/events", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const query = z
            .object({
            teamId: z.string().uuid(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const events = await listLifecycleEvents({
            teamId: query.teamId,
            evidenceId: id,
            limit: query.limit,
        });
        return reply.code(200).send({ events });
    });
    app.post("/v1/governance/lifecycle/evidence/:id/transition", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            toState: z.enum(EVIDENCE_LIFECYCLE_STATES),
            summary: z.string().min(1).max(400),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        // Manual lifecycle transition is an ADMIN action — direct manipulation
        // of state machine pointers must be permission-gated and audited.
        const perm = requirePermission(ok.role, "governance.policy.manage");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        // Step-up required when entering destruction or terminal states.
        if (body.toState === "PENDING_DESTRUCTION" || body.toState === "DESTROYED") {
            const gate = await requireStepUpForSensitiveAction({
                req, reply,
                teamId: body.teamId,
                userId: ok.userId,
                purpose: "EVIDENCE_LIFECYCLE_FORCE",
                resourceKind: "evidence",
                resourceId: id,
            });
            if (gate.sent)
                return;
        }
        try {
            const result = await transitionLifecycle({
                teamId: body.teamId,
                evidenceId: id,
                toState: body.toState,
                actorUserId: ok.userId,
                summary: body.summary,
                requestId: req.id,
            });
            return reply.code(200).send(result);
        }
        catch (err) {
            if (err instanceof LifecycleOrchestratorError)
                return mapLifecycleError(reply, err);
            throw err;
        }
    });
    // ===========================================================================
    // Export eligibility
    // ===========================================================================
    app.get("/v1/governance/export-eligibility", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            evidenceId: z.string().uuid(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        // Reading the eligibility decision is an authenticated, member-only
        // signal — same permission level as governance.policy.read.
        const perm = requirePermission(ok.role, "governance.policy.read");
        if (!perm.allowed)
            return denyByPermission(reply, perm.reason);
        const result = await checkExportEligibility({
            teamId: query.teamId,
            evidenceId: query.evidenceId,
            actorUserId: ok.userId,
        });
        return reply.code(200).send(result);
    });
    // ===========================================================================
    // Dashboard aggregate — lifecycle-shape, dispatched from the canonical
    // GET /v1/governance/dashboard route in trust-and-governance.routes.ts.
    //
    // The route registration USED to live here too, but that produced a
    // Fastify FST_ERR_DUPLICATED_ROUTE crash at boot because
    // trust-and-governance.routes.ts also registered the same method/path
    // for the Phase 4A `{ dashboard }` projection. The handler body is now
    // exported as `handleLifecycleDashboardForTeam` (see below) and the
    // single canonical registration dispatches to it when the request
    // carries `?teamId=<uuid>` (the lifecycle-page + RetentionConflictAlert
    // call shape). Every other governance-lifecycle route in this file
    // (retention policy CRUD, holds, destruction queue, conflicts, ...)
    // is unchanged.
    // ===========================================================================
}
/**
 * Lifecycle-shape governance dashboard handler. Extracted from the
 * previous in-file `app.get("/v1/governance/dashboard", ...)` block so
 * that the canonical registration in trust-and-governance.routes.ts
 * can delegate to it WITHOUT registering a second method/path.
 *
 * Auth + permission gate are preserved byte-for-byte:
 *   1. `requireAuth` runs upstream as the canonical route's preHandler.
 *   2. `requireMember(req, reply, teamId)` — workspace membership check.
 *   3. `requirePermission(role, "governance.policy.read")` — RBAC gate.
 *
 * Response shape is preserved verbatim:
 *   {
 *     lifecycle:   { byState, pendingDestructionCount },
 *     destruction: { activeReviewCount },
 *     retention:   { activePoliciesCount, conflictCount },
 *     holds:       { activeHoldsCount },
 *   }
 *
 * Consumers (apps/web/app/(app)/governance/lifecycle/page.tsx +
 * apps/web/components/governance/RetentionConflictAlert.tsx) continue
 * to see the same JSON they parsed before.
 */
export async function handleLifecycleDashboardForTeam(req, reply) {
    const query = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
    const ok = await requireMember(req, reply, query.teamId);
    if (!ok)
        return;
    const perm = requirePermission(ok.role, "governance.policy.read");
    if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
    }
    const [byLifecycleState, activeReviewCount, pendingDestructionCount, conflictCount, activePoliciesCount, activeHoldsCount,] = await Promise.all([
        countByLifecycleState(query.teamId),
        countActiveDestructionReviews(query.teamId),
        countPendingDestructionByEvidence(query.teamId),
        countActivePolicyConflicts(query.teamId),
        prisma.evidenceRetentionPolicy.count({
            where: { teamId: query.teamId, status: "ACTIVE" },
        }),
        prisma.evidenceLegalHold.count({
            where: { teamId: query.teamId, status: "ACTIVE" },
        }),
    ]);
    reply.code(200).send({
        lifecycle: {
            byState: byLifecycleState,
            pendingDestructionCount,
        },
        destruction: {
            activeReviewCount,
        },
        retention: {
            activePoliciesCount,
            conflictCount,
        },
        holds: {
            activeHoldsCount,
        },
    });
}
