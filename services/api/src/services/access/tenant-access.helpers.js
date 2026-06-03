/**
 * PHASE TENANT-ISOLATION + SCALE — Canonical tenant access helpers.
 *
 * One module. One pattern. Every mutation route that touches a tenant-scoped
 * resource (evidence, case, report, package, access review, ...) MUST call
 * the matching helper to:
 *
 *   1. Resolve the resource's tenant ownership from the DB (never trust the
 *      frontend's claimed teamId).
 *   2. Verify the actor's membership + capability via the canonical
 *      `evaluateAuthorize` policy engine.
 *   3. Return a bounded `TenantAccessGrant` carrying the resolved teamId
 *      and actor for downstream use.
 *
 * Hard rules:
 *
 *   - Helpers never write audit events directly — `evaluateMemberAccess`
 *     already records permission decisions. Audit emission for the
 *     mutation itself remains the caller's responsibility.
 *   - Helpers send the canonical 401/403/404 response on deny and return
 *     `null` so the caller can `if (!grant) return;`.
 *   - Anti-enumeration: if the resource exists but the actor is not a
 *     member of its team, we return 404 — not 403. Non-members must not
 *     be able to probe resource existence.
 *   - Personal vs Organization: PERSONAL teams (isPersonal=true) are
 *     accepted by these helpers — the active-space concept is enforced
 *     at the *capability* layer, not at access resolution. The helpers
 *     just verify "is the actor an ACTIVE member of this team?".
 */
import { prisma } from "../../db.js";
import { authorizeOrFail } from "../../middleware/authorize.js";
// =============================================================================
// Helper: resolve resource → teamId via DB, then authorize
// =============================================================================
/**
 * Generic "fetch resource, resolve teamId, authorize" helper. Used by the
 * resource-typed helpers below. Returns null on deny (response already
 * sent) or the grant on allow.
 */
async function requireResourceAccess(req, reply, args) {
    const teamId = await args.resolveTeamId(args.resourceId);
    if (!teamId) {
        // Resource missing — return 404 not_found, do not leak existence.
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    const outcome = await authorizeOrFail(req, reply, {
        teamId,
        permission: args.permission,
        resourceKind: args.resourceKind,
        resourceId: args.resourceId,
        // Anti-enumeration: convert "not a member" into 404.
        antiEnumeration: true,
    });
    if (!outcome)
        return null;
    return {
        actorUserId: outcome.actorUserId,
        teamId: outcome.teamId,
        resourceId: args.resourceId,
    };
}
// =============================================================================
// ActiveSpace — the lightest helper, used by routes that need "is the actor
// a member of this team?" without a resource-id resolution step.
// =============================================================================
export async function requireActiveSpaceAccess(req, reply, args) {
    const outcome = await authorizeOrFail(req, reply, {
        teamId: args.teamId,
        permission: args.permission,
        antiEnumeration: true,
    });
    if (!outcome)
        return null;
    return {
        actorUserId: outcome.actorUserId,
        teamId: outcome.teamId,
        resourceId: args.teamId,
    };
}
export const requireOrganizationAccess = requireActiveSpaceAccess;
export const requirePersonalSpaceAccess = requireActiveSpaceAccess;
// =============================================================================
// Evidence
// =============================================================================
export async function requireEvidenceAccess(req, reply, args) {
    return requireResourceAccess(req, reply, {
        resourceId: args.evidenceId,
        permission: args.permission,
        resourceKind: "evidence",
        resolveTeamId: async (id) => {
            const row = await prisma.evidence.findUnique({
                where: { id },
                select: { teamId: true },
            });
            return row?.teamId ?? null;
        },
    });
}
// =============================================================================
// Case
// =============================================================================
export async function requireCaseAccess(req, reply, args) {
    return requireResourceAccess(req, reply, {
        resourceId: args.caseId,
        permission: args.permission,
        resourceKind: "case",
        resolveTeamId: async (id) => {
            const row = await prisma.case.findUnique({
                where: { id },
                select: { teamId: true },
            });
            return row?.teamId ?? null;
        },
    });
}
// =============================================================================
// Evidence Report (snapshot artifact)
// =============================================================================
export async function requireReportAccess(req, reply, args) {
    return requireResourceAccess(req, reply, {
        resourceId: args.reportId,
        permission: args.permission,
        resourceKind: "report",
        resolveTeamId: async (id) => {
            // Reports do not carry a direct teamId — they carry an evidenceId.
            // We resolve via the evidence's teamId, which is the source of
            // truth for tenant ownership.
            const report = await prisma.report.findUnique({
                where: { id },
                select: { evidence: { select: { teamId: true } } },
            });
            return report?.evidence?.teamId ?? null;
        },
    });
}
// =============================================================================
// Verification Package
// =============================================================================
export async function requirePackageAccess(req, reply, args) {
    return requireResourceAccess(req, reply, {
        resourceId: args.packageId,
        permission: args.permission,
        resourceKind: "verificationPackage",
        resolveTeamId: async (id) => {
            const pkg = await prisma.verificationPackage.findUnique({
                where: { id },
                select: { evidence: { select: { teamId: true } } },
            });
            return pkg?.evidence?.teamId ?? null;
        },
    });
}
// =============================================================================
// Governance / Audit — these helpers verify membership against the team
// that owns the audit/governance row, then return the grant.
// =============================================================================
export async function requireGovernanceAccess(req, reply, args) {
    return requireActiveSpaceAccess(req, reply, args);
}
export async function requireAuditAccess(req, reply, args) {
    return requireActiveSpaceAccess(req, reply, args);
}
