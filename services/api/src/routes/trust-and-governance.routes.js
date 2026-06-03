/**
 * PROOVRA Phase 4A — Trust + Governance HTTP routes.
 *
 * Bounded routes for:
 *   * Trust Center articles (read + versioned writes).
 *   * Subprocessor registry.
 *   * Status page (read with optional Better Stack augmentation).
 *   * Departments.
 *   * Delegated admin grants.
 *   * Governance policies + assignments + audit.
 *   * Access review campaigns + items.
 *   * Cross-org review grants.
 *   * Governance dashboard.
 */
import { z } from "zod";
import { ACCESS_REVIEW_CAMPAIGN_KINDS, ACCESS_REVIEW_ITEM_DECISIONS, AI_DISCLOSURE_SECTIONS, CROSS_ORG_REVIEW_STATES, DELEGATED_ADMIN_TIERS, DEPARTMENT_MEMBERSHIP_ROLES, GOVERNANCE_POLICY_ENFORCEMENT_MODES, GOVERNANCE_POLICY_KINDS, GOVERNANCE_POLICY_SCOPES, GOVERNANCE_POLICY_STATES, METHODOLOGY_SECTIONS, SECURITY_SECTIONS, STATUS_INCIDENT_SEVERITIES, STATUS_INCIDENT_STATES, SUBPROCESSOR_DATA_CATEGORIES, SUBPROCESSOR_STATES, TRUST_ARTICLE_KINDS, TRUST_ARTICLE_STATES, TRUST_CENTER_SECTIONS, } from "@proovra/shared";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireDelegatedTier, requireDelegatedTierAny, } from "../middleware/require-delegated-tier.js";
import { assertFeatureEntitlement } from "../services/packaging/entitlement.service.js";
// Phase 4B Closure — single canonical GET /v1/governance/dashboard. The
// lifecycle-shape branch lives in governance-lifecycle.routes.ts as a
// pure handler helper; the canonical registration here dispatches to it
// when `?teamId=` is present. Two prior registrations of the same
// method/path produced FST_ERR_DUPLICATED_ROUTE at boot.
import { handleLifecycleDashboardForTeam } from "./governance-lifecycle.routes.js";
import { ensureTrustCenterSeed, getTrustArticleBySlug, listTrustArticleVersions, listTrustArticles, upsertTrustArticle, } from "../services/trust/trust-center.service.js";
import { ensureSubprocessorSeed, listSubprocessorVersions, listSubprocessors, upsertSubprocessor, } from "../services/trust/subprocessor.service.js";
import { appendIncidentUpdate, createIncident, createMaintenanceWindow, projectStatusPage, } from "../services/trust/status-page.service.js";
import { archiveDepartment, createDepartment, listDepartments, } from "../services/governance/department.service.js";
import { grantDelegatedAdmin, hasDelegatedTier, listDelegatedGrants, revokeDelegatedAdmin, } from "../services/governance/delegated-admin.service.js";
import { activatePolicy, assignPolicy, createPolicy, deprecatePolicy, listPolicies, listPolicyAssignments, listPolicyAudit, resolveEffectivePolicies, } from "../services/governance/governance-policy.service.js";
import { closeCampaign, createCampaign, listCampaigns, listItems, openCampaign, recordItemDecision, } from "../services/governance/access-review.service.js";
import { acceptCrossOrgReview, declineCrossOrgReview, inviteCrossOrgReview, listCrossOrgGrants, revokeCrossOrgReview, } from "../services/governance/cross-org-review.service.js";
import { projectGovernanceDashboard } from "../services/governance/governance-dashboard.service.js";
import { grantDepartmentMembership, listDepartmentMemberships, revokeDepartmentMembership, } from "../services/governance/department-membership.service.js";
import { resolveUserDepartmentScope } from "../services/governance/department-scope.service.js";
import { listEscalatedItems } from "../services/governance/access-review-escalation.service.js";
import { listStaleTrustArticles, markArticleNeedsReview, runTrustArticleDriftScan, } from "../services/trust/trust-drift.service.js";
import { listSecurityClaimChecks, runSecurityClaimChecks, } from "../services/trust/security-claim-check.service.js";
import { VERIFICATION_PACKAGE_PREVIEW_KINDS, buildVerificationPackagePreview, } from "../services/trust/trust-verification-manifest.service.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function resolveWorkspace(req, reply) {
    const userId = getAuthUserId(req);
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { currentWorkspaceId: true },
    });
    if (!user?.currentWorkspaceId) {
        reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
        return null;
    }
    return { teamId: user.currentWorkspaceId, userId };
}
const SECTION_ENUM_PER_KIND = {
    TRUST_CENTER: TRUST_CENTER_SECTIONS,
    METHODOLOGY: METHODOLOGY_SECTIONS,
    AI_DISCLOSURE: AI_DISCLOSURE_SECTIONS,
    SECURITY: SECURITY_SECTIONS,
};
// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export async function trustAndGovernanceRoutes(app) {
    // ===== Trust Center =====
    app.get("/v1/trust/articles", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({
            kind: z.enum(TRUST_ARTICLE_KINDS).optional(),
            state: z.enum(TRUST_ARTICLE_STATES).optional(),
        })
            .parse(req.query ?? {});
        let articles = await listTrustArticles({
            teamId: ctx.teamId,
            kind: q.kind,
            state: q.state,
        });
        // Production fix — Trust Center auto-seed on empty workspace.
        //
        // The canonical 15+9+12+18 platform-trust articles are
        // workspace-scoped seed data, not customer content. When a
        // workspace has none, the Trust Center renders an empty state
        // and instructs the user to click "Re-seed defaults" — but
        // that button POSTs to a route gated by delegated tier, which
        // PERSONAL workspaces (no delegated tiers exist) can never
        // satisfy, and which most ORG members lack. The result: an
        // enterprise Trust Center that is always empty for everyone.
        //
        // The fix is to make GET self-healing: any authenticated
        // workspace member visiting the page triggers the idempotent
        // canonical seed, so the docs that DESCRIBE the platform are
        // always present. Custom authoring (POST /v1/trust/articles)
        // still requires the delegated tier — that is the right gate.
        //
        // Guarded with try/catch so a seed failure never turns a read
        // into a 500: the user simply sees the original empty state.
        if (articles.length === 0) {
            try {
                await ensureTrustCenterSeed({
                    teamId: ctx.teamId,
                    systemUserId: ctx.userId,
                    publish: true,
                });
                articles = await listTrustArticles({
                    teamId: ctx.teamId,
                    kind: q.kind,
                    state: q.state,
                });
            }
            catch {
                /* swallow — empty render is acceptable; do not 500 a GET */
            }
        }
        return reply.code(200).send({ articles });
    });
    app.get("/v1/trust/articles/:kind/:slug", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const params = z
            .object({
            kind: z.enum(TRUST_ARTICLE_KINDS),
            slug: z.string().min(1).max(120),
        })
            .parse(req.params);
        const article = await getTrustArticleBySlug({
            teamId: ctx.teamId,
            kind: params.kind,
            slug: params.slug,
        });
        if (!article)
            return reply.code(404).send({ denial: "NOT_FOUND" });
        return reply.code(200).send({ article });
    });
    app.get("/v1/trust/articles/:id/versions", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const versions = await listTrustArticleVersions({
            teamId: ctx.teamId,
            articleId: id,
        });
        return reply.code(200).send({ versions });
    });
    app.post("/v1/trust/articles", { preHandler: [requireAuth, requireDelegatedTierAny(["ORG_ADMIN", "SECURITY_OFFICER", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        // I6 — FEATURE_TRUST_CENTER gate (minimal coverage, one rep mutation).
        try {
            const feOk = await assertFeatureEntitlement({ prisma, teamId: ctx.teamId, key: "FEATURE_TRUST_CENTER", actorUserId: ctx.userId });
            if (!feOk.ok)
                return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_TRUST_CENTER" });
        }
        catch { /* engine failure must not break route */ }
        const body = z
            .object({
            kind: z.enum(TRUST_ARTICLE_KINDS),
            section: z.string().min(1).max(60),
            slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
            title: z.string().min(1).max(200),
            summary: z.string().min(1).max(600),
            body: z.string().min(1).max(40000),
            publish: z.boolean().optional(),
            implementationReferences: z.array(z.string().max(400)).optional(),
            policyTags: z.array(z.string().max(60)).optional(),
        })
            .parse(req.body);
        const sections = SECTION_ENUM_PER_KIND[body.kind];
        if (!sections.includes(body.section)) {
            return reply.code(409).send({ denial: "POLICY_REJECTED" });
        }
        // Kind-aware secondary tier check.
        if (body.kind === "SECURITY") {
            const ok = await hasDelegatedTier({ teamId: ctx.teamId, userId: ctx.userId, requiredTier: "SECURITY_OFFICER" });
            if (!ok)
                return reply.code(403).send({ denial: "DELEGATED_ADMIN_REQUIRED", requiredTier: "SECURITY_OFFICER" });
        }
        else if (body.kind === "AI_DISCLOSURE") {
            const okC = await hasDelegatedTier({ teamId: ctx.teamId, userId: ctx.userId, requiredTier: "COMPLIANCE_OFFICER" });
            const okS = await hasDelegatedTier({ teamId: ctx.teamId, userId: ctx.userId, requiredTier: "SECURITY_OFFICER" });
            if (!okC && !okS)
                return reply.code(403).send({ denial: "DELEGATED_ADMIN_REQUIRED", requiredTier: "COMPLIANCE_OFFICER" });
        }
        const res = await upsertTrustArticle({
            teamId: ctx.teamId,
            kind: body.kind,
            section: body.section,
            slug: body.slug,
            title: body.title,
            summary: body.summary,
            body: body.body,
            publish: body.publish,
            authoredByUserId: ctx.userId,
            implementationReferences: body.implementationReferences,
            policyTags: body.policyTags,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply
            .code(201)
            .send({ articleId: res.articleId, version: res.version, state: res.state });
    });
    app.post("/v1/trust/articles/seed", 
    // Production fix — opened from delegated-tier-only to any
    // authenticated workspace member. The canonical 15+9+12+18 seed
    // articles describe the PROOVRA platform itself; they are not
    // customer content. Any workspace member should be able to
    // request the idempotent canonical seed. AUTHORING custom
    // articles (POST /v1/trust/articles) remains gated by the
    // delegated tier — that is the correct authorization boundary.
    //
    // The prior gate locked PERSONAL workspaces out entirely (no
    // delegated tier exists for PERSONAL) and locked most ORG
    // members out, leaving the Trust Center permanently empty in
    // production.
    { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const summary = await ensureTrustCenterSeed({
            teamId: ctx.teamId,
            systemUserId: ctx.userId,
            publish: true,
        });
        return reply.code(200).send({ ...summary });
    });
    // ===== Subprocessors =====
    app.get("/v1/trust/subprocessors", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({ state: z.enum(SUBPROCESSOR_STATES).optional() })
            .parse(req.query ?? {});
        let subprocessors = await listSubprocessors({
            teamId: ctx.teamId,
            state: q.state,
        });
        // Production fix — Subprocessor registry auto-seed on empty
        // workspace. Same rationale as the articles GET above: the
        // canonical subprocessor list is platform documentation, not
        // customer content. The POST seed endpoint was gated by
        // delegated tier; the canonical seed is now self-healing on
        // read so every workspace member can see the registry.
        if (subprocessors.length === 0) {
            try {
                await ensureSubprocessorSeed({
                    teamId: ctx.teamId,
                    systemUserId: ctx.userId,
                });
                subprocessors = await listSubprocessors({
                    teamId: ctx.teamId,
                    state: q.state,
                });
            }
            catch {
                /* swallow — empty render is acceptable; do not 500 a GET */
            }
        }
        return reply.code(200).send({ subprocessors });
    });
    app.get("/v1/trust/subprocessors/:id/versions", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const versions = await listSubprocessorVersions({
            teamId: ctx.teamId,
            subprocessorId: id,
        });
        return reply.code(200).send({ versions });
    });
    app.post("/v1/trust/subprocessors", { preHandler: [requireAuth, requireDelegatedTierAny(["ORG_ADMIN", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const body = z
            .object({
            slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
            name: z.string().min(1).max(120),
            vendor: z.string().min(1).max(120),
            purpose: z.string().min(1).max(600),
            region: z.string().min(1).max(80),
            state: z.enum(SUBPROCESSOR_STATES).optional(),
            dataCategories: z.array(z.enum(SUBPROCESSOR_DATA_CATEGORIES)).min(1),
            documentationUrl: z.string().url().nullable().optional(),
            contractRef: z.string().max(200).nullable().optional(),
            changeSummary: z.string().min(1).max(600),
        })
            .parse(req.body);
        const res = await upsertSubprocessor({
            teamId: ctx.teamId,
            slug: body.slug,
            name: body.name,
            vendor: body.vendor,
            purpose: body.purpose,
            region: body.region,
            state: body.state,
            dataCategories: body.dataCategories,
            documentationUrl: body.documentationUrl ?? null,
            contractRef: body.contractRef ?? null,
            changeSummary: body.changeSummary,
            authoredByUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply
            .code(201)
            .send({ subprocessorId: res.subprocessorId, version: res.version });
    });
    app.post("/v1/trust/subprocessors/seed", 
    // Production fix — same rationale as /v1/trust/articles/seed
    // above. The canonical subprocessor list is platform
    // documentation, not customer content. Any authenticated
    // workspace member can request the idempotent canonical seed.
    // Authoring custom subprocessor rows (POST
    // /v1/trust/subprocessors) remains gated by the delegated tier.
    { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const summary = await ensureSubprocessorSeed({
            teamId: ctx.teamId,
            systemUserId: ctx.userId,
        });
        return reply.code(200).send({ ...summary });
    });
    // ===== Status Page =====
    app.get("/v1/trust/status", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const apiKey = process.env.BETTER_STACK_STATUS_PAGE_API_KEY ?? null;
        // Phase O — Sentry NODE-1E safety net. `projectStatusPage`
        // calls `ensureStatusComponentsSeed` which runs
        // `statusComponent.upsert({ ... update: { lastUpdatedAtUtc, ... } })`.
        // With `status_components.updated_at` (Prisma @updatedAt @map)
        // missing from the production DB, the upsert raised P2022 and
        // the route 500ed. The repair migration
        // 20270802000000_phase_sentry_batch_schema_drift_repair adds
        // the column idempotently. Until that migration is deployed
        // everywhere, the route degrades honestly: returns a bounded
        // empty projection with `degraded: true` so the frontend
        // load-state machine surfaces the right phase (no permanent
        // "Loading…").
        try {
            const status = await projectStatusPage({
                teamId: ctx.teamId,
                betterStackApiKey: apiKey,
            });
            return reply.code(200).send({ status });
        }
        catch (err) {
            const code = err && typeof err === "object" && "code" in err
                ? String(err.code ?? "")
                : "";
            if (code === "P2022" || code === "P2021") {
                return reply.code(200).send({
                    status: null,
                    degraded: true,
                    reason: "SCHEMA_NOT_READY",
                });
            }
            throw err;
        }
    });
    app.post("/v1/trust/status/incidents", { preHandler: [requireAuth, requireDelegatedTierAny(["ORG_ADMIN", "SECURITY_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const body = z
            .object({
            title: z.string().min(1).max(200),
            severity: z.enum(STATUS_INCIDENT_SEVERITIES),
            componentKeys: z.array(z.string().min(1).max(60)).min(1),
            externalRef: z.string().max(120).nullable().optional(),
            body: z.string().max(2000).nullable().optional(),
        })
            .parse(req.body);
        const incident = await createIncident({
            teamId: ctx.teamId,
            title: body.title,
            severity: body.severity,
            componentKeys: body.componentKeys,
            externalRef: body.externalRef ?? null,
            body: body.body ?? null,
            authoredByUserId: ctx.userId,
        });
        return reply.code(201).send({ incidentId: incident.id });
    });
    app.post("/v1/trust/status/incidents/:id/updates", { preHandler: [requireAuth, requireDelegatedTierAny(["ORG_ADMIN", "SECURITY_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({
            state: z.enum(STATUS_INCIDENT_STATES),
            body: z.string().min(1).max(2000),
            postmortemUrl: z.string().url().nullable().optional(),
        })
            .parse(req.body);
        await appendIncidentUpdate({
            teamId: ctx.teamId,
            incidentId: id,
            state: body.state,
            body: body.body,
            authoredByUserId: ctx.userId,
            postmortemUrl: body.postmortemUrl ?? null,
        });
        return reply.code(200).send({ ok: true });
    });
    app.post("/v1/trust/status/maintenance", { preHandler: [requireAuth, requireDelegatedTierAny(["ORG_ADMIN", "SECURITY_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const body = z
            .object({
            title: z.string().min(1).max(200),
            description: z.string().min(1).max(2000),
            componentKeys: z.array(z.string().min(1).max(60)).min(1),
            startsAtUtc: z.string().datetime(),
            endsAtUtc: z.string().datetime(),
        })
            .parse(req.body);
        const w = await createMaintenanceWindow({
            teamId: ctx.teamId,
            title: body.title,
            description: body.description,
            componentKeys: body.componentKeys,
            startsAtUtc: new Date(body.startsAtUtc),
            endsAtUtc: new Date(body.endsAtUtc),
        });
        return reply.code(201).send({ id: w.id });
    });
    // ===== Departments =====
    app.get("/v1/governance/departments", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({ organizationId: z.string().uuid().optional() })
            .parse(req.query ?? {});
        const departments = await listDepartments({
            teamId: ctx.teamId,
            organizationId: q.organizationId,
        });
        return reply.code(200).send({ departments });
    });
    app.post("/v1/governance/departments", { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        // I6 — FEATURE_DEPARTMENT_ISOLATION gate (minimal coverage).
        try {
            const feOk = await assertFeatureEntitlement({ prisma, teamId: ctx.teamId, key: "FEATURE_DEPARTMENT_ISOLATION", actorUserId: ctx.userId });
            if (!feOk.ok)
                return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_DEPARTMENT_ISOLATION" });
        }
        catch { /* engine failure must not break route */ }
        const body = z
            .object({
            organizationId: z.string().uuid(),
            name: z.string().min(1).max(200),
            slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        })
            .parse(req.body);
        const res = await createDepartment({
            teamId: ctx.teamId,
            organizationId: body.organizationId,
            name: body.name,
            slug: body.slug,
            createdByUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply.code(201).send({ departmentId: res.departmentId });
    });
    app.post("/v1/governance/departments/:id/archive", { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const res = await archiveDepartment({
            teamId: ctx.teamId,
            departmentId: id,
        });
        if (!res.ok)
            return reply.code(404).send({ denial: "NOT_FOUND" });
        return reply.code(200).send({ ok: true });
    });
    // ===== Delegated Admin =====
    app.get("/v1/governance/delegated-admin", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({
            organizationId: z.string().uuid().optional(),
            tier: z.enum(DELEGATED_ADMIN_TIERS).optional(),
        })
            .parse(req.query ?? {});
        const grants = await listDelegatedGrants({
            teamId: ctx.teamId,
            organizationId: q.organizationId,
            tier: q.tier,
        });
        return reply.code(200).send({ grants });
    });
    app.post("/v1/governance/delegated-admin", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        // I6 — FEATURE_DELEGATED_ADMIN gate (minimal coverage, one rep mutation).
        try {
            const feOk = await assertFeatureEntitlement({ prisma, teamId: ctx.teamId, key: "FEATURE_DELEGATED_ADMIN", actorUserId: ctx.userId });
            if (!feOk.ok)
                return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_DELEGATED_ADMIN" });
        }
        catch { /* engine failure must not break route */ }
        const body = z
            .object({
            organizationId: z.string().uuid(),
            departmentId: z.string().uuid().nullable().optional(),
            workspaceId: z.string().uuid().nullable().optional(),
            granteeUserId: z.string().uuid(),
            tier: z.enum(DELEGATED_ADMIN_TIERS),
            expiresAtUtc: z.string().datetime().nullable().optional(),
        })
            .parse(req.body);
        // Enforce: only ORG_ADMIN+ (in scope) may grant.
        const authorized = await hasDelegatedTier({
            teamId: ctx.teamId,
            userId: ctx.userId,
            requiredTier: "ORG_ADMIN",
            organizationId: body.organizationId,
        });
        if (!authorized) {
            return reply.code(403).send({ denial: "DELEGATED_ADMIN_REQUIRED" });
        }
        const res = await grantDelegatedAdmin({
            teamId: ctx.teamId,
            organizationId: body.organizationId,
            departmentId: body.departmentId ?? null,
            workspaceId: body.workspaceId ?? null,
            granteeUserId: body.granteeUserId,
            tier: body.tier,
            grantedByUserId: ctx.userId,
            expiresAtUtc: body.expiresAtUtc ? new Date(body.expiresAtUtc) : null,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply.code(201).send({ grantId: res.grantId });
    });
    app.post("/v1/governance/delegated-admin/:id/revoke", { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const res = await revokeDelegatedAdmin({
            teamId: ctx.teamId,
            grantId: id,
            actorUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(404).send({ denial: "NOT_FOUND" });
        return reply.code(200).send({ ok: true });
    });
    // ===== Governance Policies =====
    app.get("/v1/governance/policies", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({
            kind: z.enum(GOVERNANCE_POLICY_KINDS).optional(),
            state: z.enum(GOVERNANCE_POLICY_STATES).optional(),
        })
            .parse(req.query ?? {});
        const policies = await listPolicies({
            teamId: ctx.teamId,
            kind: q.kind,
            state: q.state,
        });
        return reply.code(200).send({ policies });
    });
    app.post("/v1/governance/policies", { preHandler: [requireAuth, requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const body = z
            .object({
            kind: z.enum(GOVERNANCE_POLICY_KINDS),
            slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
            name: z.string().min(1).max(200),
            summary: z.string().min(1).max(600),
            enforcementMode: z.enum(GOVERNANCE_POLICY_ENFORCEMENT_MODES),
            rule: z.record(z.string(), z.unknown()),
        })
            .parse(req.body);
        const res = await createPolicy({
            teamId: ctx.teamId,
            kind: body.kind,
            slug: body.slug,
            name: body.name,
            summary: body.summary,
            enforcementMode: body.enforcementMode,
            rule: body.rule,
            createdByUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply
            .code(201)
            .send({ policyId: res.policyId, version: res.version });
    });
    app.post("/v1/governance/policies/:id/activate", { preHandler: [requireAuth, requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const r = await activatePolicy({
            teamId: ctx.teamId,
            policyId: id,
            actorUserId: ctx.userId,
        });
        if (!r.ok)
            return reply.code(404).send({ denial: "NOT_FOUND" });
        return reply.code(200).send({ ok: true });
    });
    app.post("/v1/governance/policies/:id/deprecate", { preHandler: [requireAuth, requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const r = await deprecatePolicy({
            teamId: ctx.teamId,
            policyId: id,
            actorUserId: ctx.userId,
        });
        if (!r.ok)
            return reply.code(404).send({ denial: "NOT_FOUND" });
        return reply.code(200).send({ ok: true });
    });
    app.post("/v1/governance/policies/:id/assignments", { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({
            scope: z.enum(GOVERNANCE_POLICY_SCOPES),
            scopeTargetId: z.string().uuid(),
            inheritFromParent: z.boolean().optional(),
            isOverride: z.boolean().optional(),
        })
            .parse(req.body);
        const r = await assignPolicy({
            teamId: ctx.teamId,
            policyId: id,
            scope: body.scope,
            scopeTargetId: body.scopeTargetId,
            inheritFromParent: body.inheritFromParent,
            isOverride: body.isOverride,
            assignedByUserId: ctx.userId,
        });
        if (!r.ok)
            return reply.code(409).send({ denial: r.denial });
        return reply.code(201).send({ assignmentId: r.assignmentId });
    });
    app.get("/v1/governance/policies/:id/assignments", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const assignments = await listPolicyAssignments({
            teamId: ctx.teamId,
            policyId: id,
        });
        return reply.code(200).send({ assignments });
    });
    app.get("/v1/governance/policies/:id/audit", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const audit = await listPolicyAudit({
            teamId: ctx.teamId,
            policyId: id,
        });
        return reply.code(200).send({ audit });
    });
    app.get("/v1/governance/policies/effective", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({
            organizationId: z.string().uuid().optional(),
            departmentId: z.string().uuid().optional(),
            workspaceId: z.string().uuid().optional(),
            kind: z.enum(GOVERNANCE_POLICY_KINDS).optional(),
        })
            .parse(req.query ?? {});
        const effective = await resolveEffectivePolicies({
            teamId: ctx.teamId,
            organizationId: q.organizationId ?? null,
            departmentId: q.departmentId ?? null,
            workspaceId: q.workspaceId ?? null,
            kind: q.kind,
        });
        return reply.code(200).send({ effective });
    });
    // ===== Access Reviews =====
    app.get("/v1/governance/access-reviews/campaigns", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const campaigns = await listCampaigns({ teamId: ctx.teamId });
        return reply.code(200).send({ campaigns });
    });
    app.post("/v1/governance/access-reviews/campaigns", { preHandler: [requireAuth, requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const body = z
            .object({
            kind: z.enum(ACCESS_REVIEW_CAMPAIGN_KINDS),
            name: z.string().min(1).max(200),
            organizationId: z.string().uuid().nullable().optional(),
            departmentId: z.string().uuid().nullable().optional(),
            workspaceId: z.string().uuid().nullable().optional(),
            scheduledStartUtc: z.string().datetime(),
            scheduledEndUtc: z.string().datetime(),
            items: z
                .array(z.object({
                subjectUserId: z.string().uuid(),
                grantRef: z.string().min(1).max(200),
            }))
                .max(500),
        })
            .parse(req.body);
        const res = await createCampaign({
            teamId: ctx.teamId,
            kind: body.kind,
            name: body.name,
            organizationId: body.organizationId ?? null,
            departmentId: body.departmentId ?? null,
            workspaceId: body.workspaceId ?? null,
            scheduledStartUtc: new Date(body.scheduledStartUtc),
            scheduledEndUtc: new Date(body.scheduledEndUtc),
            createdByUserId: ctx.userId,
            items: body.items,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply
            .code(201)
            .send({ campaignId: res.campaignId, itemCount: res.itemCount });
    });
    app.post("/v1/governance/access-reviews/campaigns/:id/open", { preHandler: [requireAuth, requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const r = await openCampaign({ teamId: ctx.teamId, campaignId: id });
        if (!r.ok)
            return reply.code(409).send({ denial: "POLICY_REJECTED" });
        return reply.code(200).send({ ok: true });
    });
    app.post("/v1/governance/access-reviews/campaigns/:id/close", { preHandler: [requireAuth, requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const r = await closeCampaign({ teamId: ctx.teamId, campaignId: id });
        if (!r.ok)
            return reply.code(409).send({ denial: "POLICY_REJECTED" });
        return reply.code(200).send({ ok: true });
    });
    app.get("/v1/governance/access-reviews/campaigns/:id/items", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const items = await listItems({ teamId: ctx.teamId, campaignId: id });
        return reply.code(200).send({ items });
    });
    app.post("/v1/governance/access-reviews/items/:id/decision", { preHandler: [requireAuth, requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER", "ORG_ADMIN"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({
            decision: z.enum(ACCESS_REVIEW_ITEM_DECISIONS),
            notes: z.string().max(2000).nullable().optional(),
        })
            .parse(req.body);
        const r = await recordItemDecision({
            teamId: ctx.teamId,
            itemId: id,
            decision: body.decision,
            reviewerUserId: ctx.userId,
            notes: body.notes ?? null,
        });
        if (!r.ok)
            return reply.code(409).send({ denial: "POLICY_REJECTED" });
        return reply.code(200).send({ ok: true });
    });
    // ===== Cross-Org Review =====
    app.get("/v1/governance/cross-org-review", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({
            invitingOrganizationId: z.string().uuid().optional(),
            state: z.enum(CROSS_ORG_REVIEW_STATES).optional(),
        })
            .parse(req.query ?? {});
        const grants = await listCrossOrgGrants({
            teamId: ctx.teamId,
            invitingOrganizationId: q.invitingOrganizationId,
            state: q.state,
        });
        return reply.code(200).send({ grants });
    });
    app.post("/v1/governance/cross-org-review", { preHandler: [requireAuth, requireDelegatedTierAny(["ORG_ADMIN", "REVIEWER_LEAD"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        // I6 — FEATURE_CROSS_ORG_REVIEW + FEATURE_GOVERNANCE_PLATFORM gates (minimal coverage).
        try {
            const feOk1 = await assertFeatureEntitlement({ prisma, teamId: ctx.teamId, key: "FEATURE_CROSS_ORG_REVIEW", actorUserId: ctx.userId });
            if (!feOk1.ok)
                return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_CROSS_ORG_REVIEW" });
            const feOk2 = await assertFeatureEntitlement({ prisma, teamId: ctx.teamId, key: "FEATURE_GOVERNANCE_PLATFORM", actorUserId: ctx.userId });
            if (!feOk2.ok)
                return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_GOVERNANCE_PLATFORM" });
        }
        catch { /* engine failure must not break route */ }
        const body = z
            .object({
            invitingOrganizationId: z.string().uuid(),
            invitedOrgSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/),
            scope: z.string().min(1).max(600),
            expiresAtUtc: z.string().datetime().nullable().optional(),
        })
            .parse(req.body);
        const r = await inviteCrossOrgReview({
            teamId: ctx.teamId,
            invitingOrganizationId: body.invitingOrganizationId,
            invitedOrgSlug: body.invitedOrgSlug,
            scope: body.scope,
            expiresAtUtc: body.expiresAtUtc ? new Date(body.expiresAtUtc) : null,
            createdByUserId: ctx.userId,
        });
        if (!r.ok)
            return reply.code(409).send({ denial: r.denial });
        return reply.code(201).send({ grantId: r.grantId });
    });
    app.post("/v1/governance/cross-org-review/:id/accept", { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({
            acceptingOrganizationId: z.string().uuid(),
            externalReviewGrantId: z.string().uuid().nullable().optional(),
        })
            .parse(req.body);
        const r = await acceptCrossOrgReview({
            teamId: ctx.teamId,
            grantId: id,
            acceptingOrganizationId: body.acceptingOrganizationId,
            externalReviewGrantId: body.externalReviewGrantId ?? null,
            actorUserId: ctx.userId,
        });
        if (!r.ok)
            return reply.code(409).send({ denial: "POLICY_REJECTED" });
        return reply.code(200).send({ ok: true });
    });
    app.post("/v1/governance/cross-org-review/:id/decline", { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const r = await declineCrossOrgReview({
            teamId: ctx.teamId,
            grantId: id,
            actorUserId: ctx.userId,
        });
        if (!r.ok)
            return reply.code(409).send({ denial: "POLICY_REJECTED" });
        return reply.code(200).send({ ok: true });
    });
    app.post("/v1/governance/cross-org-review/:id/revoke", { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const r = await revokeCrossOrgReview({
            teamId: ctx.teamId,
            grantId: id,
            actorUserId: ctx.userId,
        });
        if (!r.ok)
            return reply.code(409).send({ denial: "POLICY_REJECTED" });
        return reply.code(200).send({ ok: true });
    });
    // ===== Governance Dashboard =====
    //
    // Single canonical registration for GET /v1/governance/dashboard.
    //
    // Two consumer shapes hit this path and BOTH must keep working:
    //   * Phase B governance lifecycle UI
    //     (apps/web/app/(app)/governance/lifecycle/page.tsx +
    //      apps/web/components/governance/RetentionConflictAlert.tsx)
    //     — calls with `?teamId=<uuid>` and parses
    //       `{ lifecycle, destruction, retention, holds }`.
    //   * Phase 4A governance platform UI
    //     (apps/web/app/(app)/governance-platform/page.tsx)
    //     — calls with NO query param and parses `{ dashboard }`.
    //
    // Dispatching on `?teamId=` presence preserves both contracts under a
    // single Fastify registration. Each branch keeps its original auth +
    // gate stack:
    //   * lifecycle branch  → requireAuth (preHandler) + requireMember +
    //                          requirePermission("governance.policy.read")
    //                          inside handleLifecycleDashboardForTeam.
    //   * Phase 4A branch  → requireAuth (preHandler) + resolveWorkspace.
    app.get("/v1/governance/dashboard", { preHandler: requireAuth }, async (req, reply) => {
        const q = (req.query ?? {});
        if (typeof q.teamId === "string" && q.teamId.length > 0) {
            // Lifecycle-shape dispatch: the helper validates the teamId as a
            // UUID, enforces workspace membership, and the
            // governance.policy.read permission gate before responding with
            // the lifecycle aggregate shape.
            await handleLifecycleDashboardForTeam(req, reply);
            return;
        }
        // Phase 4A canonical dashboard projection (workspace-context).
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const dashboard = await projectGovernanceDashboard({ teamId: ctx.teamId });
        return reply.code(200).send({ dashboard });
    });
    // ===== Phase 4A Closure new routes =====
    app.post("/v1/trust/drift/scan", { preHandler: [requireAuth, requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const result = await runTrustArticleDriftScan({ teamId: ctx.teamId });
        return reply.code(200).send({ result });
    });
    app.get("/v1/trust/drift/stale", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const articles = await listStaleTrustArticles({ teamId: ctx.teamId });
        return reply.code(200).send({ articles });
    });
    app.post("/v1/trust/security-claims/scan", { preHandler: [requireAuth, requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"])] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const result = await runSecurityClaimChecks({ teamId: ctx.teamId });
        return reply.code(200).send({ result });
    });
    app.get("/v1/trust/security-claims", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const checks = await listSecurityClaimChecks({ teamId: ctx.teamId });
        return reply.code(200).send({ checks });
    });
    app.get("/v1/governance/access-reviews/escalated", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const items = await listEscalatedItems({ teamId: ctx.teamId });
        return reply.code(200).send({ items });
    });
    app.get("/v1/governance/departments/:id/memberships", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const memberships = await listDepartmentMemberships({
            teamId: ctx.teamId,
            departmentId: id,
        });
        return reply.code(200).send({ memberships });
    });
    app.post("/v1/governance/departments/:id/memberships", { preHandler: [requireAuth, requireDelegatedTier("DEPARTMENT_ADMIN")] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({
            userId: z.string().uuid(),
            role: z.enum(DEPARTMENT_MEMBERSHIP_ROLES).optional(),
        })
            .parse(req.body);
        const res = await grantDepartmentMembership({
            teamId: ctx.teamId,
            departmentId: id,
            userId: body.userId,
            role: body.role,
            grantedByUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply.code(201).send({ membershipId: res.membershipId });
    });
    app.post("/v1/governance/departments/memberships/:id/revoke", { preHandler: [requireAuth, requireDelegatedTier("DEPARTMENT_ADMIN")] }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const res = await revokeDepartmentMembership({
            teamId: ctx.teamId,
            membershipId: id,
            actorUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(404).send({ denial: res.denial });
        return reply.code(200).send({ ok: true });
    });
    app.get("/v1/governance/me/department-scope", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const envelope = await resolveUserDepartmentScope({
            teamId: ctx.teamId,
            userId: ctx.userId,
        });
        return reply.code(200).send({ scope: envelope });
    });
    // ===== Verify-page references (workspace-anchored, bounded) =====
    //
    // Phase 4A — surfaces the published Trust Center / Methodology /
    // AI Disclosure / Security article titles + slugs + versions, and
    // active subprocessor slugs, for in-platform verify-page consumers.
    // NEVER returns article bodies or implementation references —
    // those are operator-internal.
    app.get("/v1/trust/verify-references", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const [trust, methodology, aiDisclosure, security, subprocessors] = await Promise.all([
            listTrustArticles({ teamId: ctx.teamId, kind: "TRUST_CENTER", state: "PUBLISHED" }),
            listTrustArticles({ teamId: ctx.teamId, kind: "METHODOLOGY", state: "PUBLISHED" }),
            listTrustArticles({ teamId: ctx.teamId, kind: "AI_DISCLOSURE", state: "PUBLISHED" }),
            listTrustArticles({ teamId: ctx.teamId, kind: "SECURITY", state: "PUBLISHED" }),
            listSubprocessors({ teamId: ctx.teamId, state: "ACTIVE" }),
        ]);
        return reply.code(200).send({
            references: {
                trustCenter: trust.map((a) => ({ title: a.title, slug: a.slug, version: a.version })),
                methodology: methodology.map((a) => ({ title: a.title, slug: a.slug, version: a.version })),
                aiDisclosure: aiDisclosure.map((a) => ({ title: a.title, slug: a.slug, version: a.version })),
                security: security.map((a) => ({ title: a.title, slug: a.slug, version: a.version })),
                subprocessors: subprocessors.map((s) => ({ name: s.name, slug: s.slug, vendor: s.vendor })),
            },
        });
    });
    // ===== Verification package preview =====
    //
    // Returns the exact JSON shape that the worker emits inside the offline
    // verification ZIP for the requested manifest kind. Lets operators
    // inspect manifest contents without generating a full package.
    // Workspace-anchored; bodies are never included.
    // ===== Trust Article — Mark Needs Review =====
    //
    // Phase 4A Final Closure — POST /v1/trust/articles/:id/review
    // Invokes `markArticleNeedsReview` from trust-drift.service.ts.
    // The closure introduced the function but no route consumed it.
    // Restricted to SECURITY_OFFICER / COMPLIANCE_OFFICER delegated tiers.
    app.post("/v1/trust/articles/:id/review", {
        preHandler: [
            requireAuth,
            requireDelegatedTierAny(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"]),
        ],
    }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const body = z
            .object({ reason: z.string().min(1).max(400).optional() })
            .parse(req.body ?? {});
        const result = await markArticleNeedsReview({
            teamId: ctx.teamId,
            articleId: id,
            actorUserId: ctx.userId,
            reason: body.reason ?? "manual_review_requested",
        });
        if (!result.ok)
            return reply.code(404).send({ denial: "ARTICLE_NOT_FOUND" });
        return reply.code(200).send({ ok: true });
    });
    app.get("/v1/trust/verification-package/preview", {
        preHandler: [
            requireAuth,
            requireDelegatedTierAny([
                "ORG_ADMIN",
                "SECURITY_OFFICER",
                "COMPLIANCE_OFFICER",
            ]),
        ],
    }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({
            kind: z.enum(VERIFICATION_PACKAGE_PREVIEW_KINDS),
        })
            .parse(req.query ?? {});
        const manifest = await buildVerificationPackagePreview({
            teamId: ctx.teamId,
            kind: q.kind,
        });
        return reply.code(200).send({ kind: q.kind, manifest });
    });
}
