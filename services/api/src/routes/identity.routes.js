/**
 * Phase 17 — Identity & Access Platform routes.
 *
 *   GET    /v1/identity/members                          — list members + access state
 *   POST   /v1/identity/members/:id/suspend              — suspend a member
 *   POST   /v1/identity/members/:id/restore              — restore a suspended member
 *   POST   /v1/identity/members/:id/revoke               — revoke a member
 *   POST   /v1/identity/members/:id/role                 — change a member's role
 *   POST   /v1/identity/members/:id/capabilities         — grant a capability
 *   DELETE /v1/identity/capabilities/:grantId            — revoke a capability grant
 *   POST   /v1/identity/members/:id/delegated-admin      — grant a delegated admin scope
 *   DELETE /v1/identity/delegated-admin/:scopeId         — revoke a delegated admin scope
 *   GET    /v1/identity/service-accounts                 — list service accounts (+hardening)
 *   POST   /v1/identity/service-accounts/:id/disable     — disable a credential
 *   POST   /v1/identity/service-accounts/:id/enable      — re-enable a credential
 *   PATCH  /v1/identity/service-accounts/:id/hardening   — update expiry/IP/env/rotation
 *   POST   /v1/identity/contributor-sessions/:id/revoke  — immediate contributor revoke
 *   GET    /v1/identity/policy                           — read org security policy
 *   PUT    /v1/identity/policy                           — upsert org security policy
 *   GET    /v1/identity/access-reviews                   — list access-review queue
 *   POST   /v1/identity/access-reviews/regenerate        — trigger queue regeneration
 *   POST   /v1/identity/access-reviews/:id/decision      — record a review decision
 *   GET    /v1/identity/external-mappings                — list SSO/SCIM mappings
 *   POST   /v1/identity/external-mappings                — link an external identity
 *   DELETE /v1/identity/external-mappings/:id            — unlink an external identity
 *
 * Authentication: session auth (requireAuth). NEVER service-account.
 * Authorization: every route runs `evaluateMemberAccess` against a
 * canonical identity.* permission; non-members get 404 (anti-enumeration),
 * non-permitted members get 403 with a structured deny reason.
 *
 * Hard invariants:
 *   - 404-on-non-member (no oracle for "this team exists").
 *   - All mutations fail closed if the access policy engine denies.
 *   - All mutations write an AdminAuditLog chain entry (via the service
 *     layer) AND a SecurityEvent (operator surface).
 */
import { z } from "zod";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { PermissionSchema, DELEGATED_ADMIN_SCOPE_KINDS, EXTERNAL_IDENTITY_PROVIDERS, } from "@proovra/shared";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { RbacError, changeMemberRole, grantCapability, grantDelegatedAdminScope, listTeamMembersWithAccess, restoreMember, revokeCapability, revokeDelegatedAdminScope, revokeMember, suspendMember, } from "../services/identity/rbac.service.js";
import { disableApiCredential, enableApiCredential, listApiCredentials, projectApiCredential, ApiCredentialError, updateApiCredentialHardening, } from "../services/integrations/api-keys.service.js";
import { ContributorGovernanceError, revokeContributorSession, } from "../services/identity/contributor-governance.service.js";
import { getOrgSecurityPolicy, upsertOrgSecurityPolicy, } from "../services/identity/org-security-policy.service.js";
import { AccessReviewError, completeAccessReview, listAccessReviews, regenerateAccessReviewQueue, } from "../services/identity/access-review.service.js";
import { ExternalIdentityError, linkExternalIdentity, listExternalIdentityMappings, unlinkExternalIdentity, } from "../services/identity/external-identity.service.js";
// Phase 19 — sensitive routes consume step-up challenges before mutating.
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ParamsId = z.object({ id: z.string().uuid() });
function requestIp(req) {
    const raw = (req.ip ?? "").trim();
    return raw.length > 0 ? raw : null;
}
function requestUa(req) {
    const raw = req.headers["user-agent"];
    if (typeof raw !== "string")
        return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 512) : null;
}
/**
 * Anti-enumeration helper. If the caller is not a member, respond 404
 * (NOT 403). Then evaluate the named permission via the access-policy
 * engine; if denied, respond 403 with a structured reason. Returns the
 * member context on success.
 */
async function requireIdentityActor(req, reply, teamId, permission) {
    const userId = getAuthUserId(req);
    const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
        select: { id: true },
    });
    if (!member) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    const decision = await evaluateMemberAccess({
        teamId,
        userId,
        permission,
    });
    if (!decision.allowed) {
        reply.code(403).send({
            error: {
                code: "permission_denied",
                reason: decision.reason,
                detail: decision.detail ?? null,
            },
        });
        return null;
    }
    return { userId, teamMemberId: member.id };
}
function handleRbacError(reply, err) {
    if (err instanceof RbacError) {
        const status = err.code === "member_not_found"
            ? 404
            : err.code === "self_action_forbidden"
                ? 403
                : err.code === "member_owner_immutable" ||
                    err.code === "role_transition_to_owner_forbidden"
                    ? 400
                    : err.code === "invalid_status_transition"
                        ? 409
                        : err.code === "capability_unknown"
                            ? 400
                            : err.code === "capability_already_active" ||
                                err.code === "delegated_scope_already_active"
                                ? 409
                                : err.code === "capability_not_found" ||
                                    err.code === "delegated_scope_not_found"
                                    ? 404
                                    : 400;
        reply.code(status).send({ error: { code: err.code } });
        return true;
    }
    return false;
}
function handleAccessReviewError(reply, err) {
    if (err instanceof AccessReviewError) {
        const status = err.code === "review_not_found" || err.code === "subject_missing"
            ? 404
            : 409;
        reply.code(status).send({ error: { code: err.code } });
        return true;
    }
    return false;
}
function handleContributorError(reply, err) {
    if (err instanceof ContributorGovernanceError) {
        const status = err.code === "session_not_found"
            ? 404
            : 409;
        reply.code(status).send({ error: { code: err.code } });
        return true;
    }
    return false;
}
function handleExternalError(reply, err) {
    if (err instanceof ExternalIdentityError) {
        const status = err.code === "mapping_not_found" ? 404 : 409;
        reply.code(status).send({ error: { code: err.code } });
        return true;
    }
    return false;
}
function handleApiCredentialError(reply, err) {
    if (err instanceof ApiCredentialError) {
        const status = err.code === "credential_not_found"
            ? 404
            : err.code === "credential_already_revoked"
                ? 409
                : 400;
        reply.code(status).send({ error: { code: err.code } });
        return true;
    }
    return false;
}
const DelegatedAdminScopeSchema = z.enum(DELEGATED_ADMIN_SCOPE_KINDS);
const ExternalProviderSchema = z.enum(EXTERNAL_IDENTITY_PROVIDERS);
export async function identityRoutes(app) {
    // -------------------------------------------------------------------------
    // Members
    // -------------------------------------------------------------------------
    app.get("/v1/identity/members", { preHandler: requireAuth }, async (req, reply) => {
        const q = TeamIdQuery.parse(req.query ?? {});
        const actor = await requireIdentityActor(req, reply, q.teamId, "identity.member.read");
        if (!actor)
            return;
        const rows = await listTeamMembersWithAccess(q.teamId);
        return reply.code(200).send({ members: rows });
    });
    const LifecycleBody = z.object({
        teamId: z.string().uuid(),
        reason: z.string().min(1).max(400).optional(),
    });
    app.post("/v1/identity/members/:id/suspend", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = LifecycleBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.member.suspend");
        if (!actor)
            return;
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: actor.userId,
            purpose: "MEMBER_SUSPEND",
            resourceKind: "team_member",
            resourceId: id,
        });
        if (gate.sent)
            return;
        try {
            const updated = await suspendMember({
                teamId: body.teamId,
                teamMemberId: id,
                actorUserId: actor.userId,
                reason: body.reason ?? null,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ member: updated });
        }
        catch (err) {
            if (handleRbacError(reply, err))
                return;
            throw err;
        }
    });
    app.post("/v1/identity/members/:id/restore", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = LifecycleBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.member.restore");
        if (!actor)
            return;
        try {
            const updated = await restoreMember({
                teamId: body.teamId,
                teamMemberId: id,
                actorUserId: actor.userId,
                reason: body.reason ?? null,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ member: updated });
        }
        catch (err) {
            if (handleRbacError(reply, err))
                return;
            throw err;
        }
    });
    app.post("/v1/identity/members/:id/revoke", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = LifecycleBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.member.revoke");
        if (!actor)
            return;
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: actor.userId,
            purpose: "MEMBER_REVOKE",
            resourceKind: "team_member",
            resourceId: id,
        });
        if (gate.sent)
            return;
        try {
            const updated = await revokeMember({
                teamId: body.teamId,
                teamMemberId: id,
                actorUserId: actor.userId,
                reason: body.reason ?? null,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ member: updated });
        }
        catch (err) {
            if (handleRbacError(reply, err))
                return;
            throw err;
        }
    });
    const RoleChangeBody = LifecycleBody.extend({
        role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
    });
    app.post("/v1/identity/members/:id/role", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = RoleChangeBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.member.role.change");
        if (!actor)
            return;
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: actor.userId,
            purpose: "MEMBER_ROLE_CHANGE",
            resourceKind: "team_member",
            resourceId: id,
        });
        if (gate.sent)
            return;
        try {
            const updated = await changeMemberRole({
                teamId: body.teamId,
                teamMemberId: id,
                actorUserId: actor.userId,
                reason: body.reason ?? null,
                newRole: body.role,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ member: updated });
        }
        catch (err) {
            if (handleRbacError(reply, err))
                return;
            throw err;
        }
    });
    // -------------------------------------------------------------------------
    // Capabilities
    // -------------------------------------------------------------------------
    const GrantCapabilityBody = z.object({
        teamId: z.string().uuid(),
        permission: PermissionSchema,
        reason: z.string().min(1).max(400).optional(),
        expiresAtUtc: z.string().datetime().optional(),
    });
    app.post("/v1/identity/members/:id/capabilities", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = GrantCapabilityBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.capability.grant");
        if (!actor)
            return;
        try {
            const grant = await grantCapability({
                teamId: body.teamId,
                teamMemberId: id,
                permission: body.permission,
                reason: body.reason ?? null,
                expiresAtUtc: body.expiresAtUtc ? new Date(body.expiresAtUtc) : null,
                actorUserId: actor.userId,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ grant });
        }
        catch (err) {
            if (handleRbacError(reply, err))
                return;
            throw err;
        }
    });
    app.delete("/v1/identity/capabilities/:id", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = LifecycleBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.capability.revoke");
        if (!actor)
            return;
        try {
            const grant = await revokeCapability({
                teamId: body.teamId,
                grantId: id,
                actorUserId: actor.userId,
                reason: body.reason ?? null,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ grant });
        }
        catch (err) {
            if (handleRbacError(reply, err))
                return;
            throw err;
        }
    });
    // -------------------------------------------------------------------------
    // Delegated admin scopes
    // -------------------------------------------------------------------------
    const GrantDelegatedAdminBody = z.object({
        teamId: z.string().uuid(),
        scopeKind: DelegatedAdminScopeSchema,
        reason: z.string().min(1).max(400).optional(),
        expiresAtUtc: z.string().datetime().optional(),
    });
    app.post("/v1/identity/members/:id/delegated-admin", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = GrantDelegatedAdminBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.delegated_admin.grant");
        if (!actor)
            return;
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: actor.userId,
            purpose: "DELEGATED_ADMIN_GRANT",
            resourceKind: "team_member",
            resourceId: id,
        });
        if (gate.sent)
            return;
        try {
            const scope = await grantDelegatedAdminScope({
                teamId: body.teamId,
                teamMemberId: id,
                scopeKind: body.scopeKind,
                reason: body.reason ?? null,
                expiresAtUtc: body.expiresAtUtc ? new Date(body.expiresAtUtc) : null,
                actorUserId: actor.userId,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ scope });
        }
        catch (err) {
            if (handleRbacError(reply, err))
                return;
            throw err;
        }
    });
    app.delete("/v1/identity/delegated-admin/:id", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = LifecycleBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.delegated_admin.revoke");
        if (!actor)
            return;
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: actor.userId,
            purpose: "DELEGATED_ADMIN_REVOKE",
            resourceKind: "delegated_admin_scope",
            resourceId: id,
        });
        if (gate.sent)
            return;
        try {
            const scope = await revokeDelegatedAdminScope({
                teamId: body.teamId,
                scopeId: id,
                actorUserId: actor.userId,
                reason: body.reason ?? null,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ scope });
        }
        catch (err) {
            if (handleRbacError(reply, err))
                return;
            throw err;
        }
    });
    // -------------------------------------------------------------------------
    // Service accounts
    // -------------------------------------------------------------------------
    app.get("/v1/identity/service-accounts", { preHandler: requireAuth }, async (req, reply) => {
        const q = TeamIdQuery.parse(req.query ?? {});
        const actor = await requireIdentityActor(req, reply, q.teamId, "identity.service_account.manage");
        if (!actor)
            return;
        const rows = await listApiCredentials({ teamId: q.teamId });
        return reply
            .code(200)
            .send({ serviceAccounts: rows.map(projectApiCredential) });
    });
    app.post("/v1/identity/service-accounts/:id/disable", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.service_account.disable");
        if (!actor)
            return;
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: actor.userId,
            purpose: "SERVICE_ACCOUNT_DISABLE",
            resourceKind: "api_credential",
            resourceId: id,
        });
        if (gate.sent)
            return;
        try {
            const updated = await disableApiCredential({
                id,
                teamId: body.teamId,
                actorUserId: actor.userId,
            });
            return reply.code(200).send({ serviceAccount: projectApiCredential(updated) });
        }
        catch (err) {
            if (handleApiCredentialError(reply, err))
                return;
            throw err;
        }
    });
    app.post("/v1/identity/service-accounts/:id/enable", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.service_account.manage");
        if (!actor)
            return;
        try {
            const updated = await enableApiCredential({ id, teamId: body.teamId });
            return reply.code(200).send({ serviceAccount: projectApiCredential(updated) });
        }
        catch (err) {
            if (handleApiCredentialError(reply, err))
                return;
            throw err;
        }
    });
    const HardeningPatchBody = z.object({
        teamId: z.string().uuid(),
        expiresAtUtc: z.string().datetime().nullable().optional(),
        ipAllowlist: z.array(z.string().min(1).max(64)).optional(),
        environment: z.string().max(32).nullable().optional(),
        rotationRequired: z.boolean().optional(),
    });
    app.patch("/v1/identity/service-accounts/:id/hardening", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = HardeningPatchBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.service_account.manage");
        if (!actor)
            return;
        try {
            const updated = await updateApiCredentialHardening({
                id,
                teamId: body.teamId,
                expiresAtUtc: body.expiresAtUtc === undefined
                    ? undefined
                    : body.expiresAtUtc === null
                        ? null
                        : new Date(body.expiresAtUtc),
                ipAllowlist: body.ipAllowlist,
                environment: body.environment,
                rotationRequired: body.rotationRequired,
            });
            return reply.code(200).send({ serviceAccount: projectApiCredential(updated) });
        }
        catch (err) {
            if (handleApiCredentialError(reply, err))
                return;
            throw err;
        }
    });
    // -------------------------------------------------------------------------
    // Contributor sessions
    // -------------------------------------------------------------------------
    app.post("/v1/identity/contributor-sessions/:id/revoke", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = LifecycleBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.contributor_session.revoke");
        if (!actor)
            return;
        try {
            const updated = await revokeContributorSession({
                teamId: body.teamId,
                intakeSessionId: id,
                actorUserId: actor.userId,
                reason: body.reason ?? null,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ session: updated });
        }
        catch (err) {
            if (handleContributorError(reply, err))
                return;
            throw err;
        }
    });
    // -------------------------------------------------------------------------
    // Org security policy
    // -------------------------------------------------------------------------
    app.get("/v1/identity/policy", { preHandler: requireAuth }, async (req, reply) => {
        const q = TeamIdQuery.parse(req.query ?? {});
        const actor = await requireIdentityActor(req, reply, q.teamId, "identity.org_policy.read");
        if (!actor)
            return;
        const policy = await getOrgSecurityPolicy(q.teamId);
        return reply.code(200).send({ policy });
    });
    const PolicyUpsertBody = z.object({
        teamId: z.string().uuid(),
        mfaRequiredFlag: z.boolean().optional(),
        allowedEmailDomains: z.array(z.string().min(1).max(253)).optional(),
        restrictedIpRanges: z.array(z.string().min(1).max(64)).optional(),
        reviewerSessionTimeoutSeconds: z
            .number()
            .int()
            .positive()
            .max(86_400)
            .nullable()
            .optional(),
        contributorSessionTimeoutSeconds: z
            .number()
            .int()
            .positive()
            .max(86_400)
            .nullable()
            .optional(),
        ssoReadyFlag: z.boolean().optional(),
        scimReadyFlag: z.boolean().optional(),
        notes: z.string().max(2000).nullable().optional(),
    });
    app.put("/v1/identity/policy", { preHandler: requireAuth }, async (req, reply) => {
        const body = PolicyUpsertBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.org_policy.manage");
        if (!actor)
            return;
        const { teamId, ...patch } = body;
        const policy = await upsertOrgSecurityPolicy({
            teamId,
            actorUserId: actor.userId,
            ...patch,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
        });
        return reply.code(200).send({ policy });
    });
    // -------------------------------------------------------------------------
    // Access reviews
    // -------------------------------------------------------------------------
    app.get("/v1/identity/access-reviews", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            status: z
                .enum([
                "PENDING",
                "IN_PROGRESS",
                "COMPLETED_KEEP",
                "COMPLETED_REVOKED",
                "COMPLETED_SUSPENDED",
                "COMPLETED_NO_ACTION",
                "CANCELLED",
            ])
                .optional(),
            kind: z
                .enum([
                "PERIODIC_MEMBER_REVIEW",
                "STALE_ACCESS",
                "UNUSED_SERVICE_ACCOUNT",
                "EXPIRING_TEMPORARY_ACCESS",
                "SUSPICIOUS_ACCESS_PATTERN",
                "EMERGENCY_REVOCATION_FOLLOWUP",
            ])
                .optional(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
        })
            .parse(req.query ?? {});
        const actor = await requireIdentityActor(req, reply, q.teamId, "identity.access_review.read");
        if (!actor)
            return;
        const rows = await listAccessReviews(q);
        return reply.code(200).send({ accessReviews: rows });
    });
    app.post("/v1/identity/access-reviews/regenerate", { preHandler: requireAuth }, async (req, reply) => {
        const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.access_review.action");
        if (!actor)
            return;
        const { created } = await regenerateAccessReviewQueue({
            teamId: body.teamId,
            actorUserId: actor.userId,
        });
        return reply.code(200).send({ created });
    });
    const DecisionBody = z.object({
        teamId: z.string().uuid(),
        decision: z.enum([
            "KEEP",
            "REVOKE_MEMBER",
            "SUSPEND_MEMBER",
            "NO_ACTION",
            "CANCEL",
        ]),
        decisionNote: z.string().min(1).max(2000).optional(),
    });
    app.post("/v1/identity/access-reviews/:id/decision", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = DecisionBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.access_review.action");
        if (!actor)
            return;
        try {
            const updated = await completeAccessReview({
                teamId: body.teamId,
                reviewId: id,
                actorUserId: actor.userId,
                decision: body.decision,
                decisionNote: body.decisionNote ?? null,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ accessReview: updated });
        }
        catch (err) {
            if (handleAccessReviewError(reply, err))
                return;
            throw err;
        }
    });
    // -------------------------------------------------------------------------
    // External identity mappings (SSO/SCIM readiness)
    // -------------------------------------------------------------------------
    app.get("/v1/identity/external-mappings", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            activeOnly: z.coerce.boolean().optional(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
        })
            .parse(req.query ?? {});
        const actor = await requireIdentityActor(req, reply, q.teamId, "identity.external_mapping.read");
        if (!actor)
            return;
        const rows = await listExternalIdentityMappings(q);
        return reply.code(200).send({ externalMappings: rows });
    });
    const LinkExternalBody = z.object({
        teamId: z.string().uuid(),
        userId: z.string().uuid(),
        provider: ExternalProviderSchema,
        externalSubjectId: z.string().min(1).max(320),
        displayName: z.string().max(180).nullable().optional(),
        externalEmail: z.string().email().max(320).nullable().optional(),
    });
    app.post("/v1/identity/external-mappings", { preHandler: requireAuth }, async (req, reply) => {
        const body = LinkExternalBody.parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.external_mapping.manage");
        if (!actor)
            return;
        try {
            const mapping = await linkExternalIdentity({
                teamId: body.teamId,
                userId: body.userId,
                provider: body.provider,
                externalSubjectId: body.externalSubjectId,
                displayName: body.displayName ?? null,
                externalEmail: body.externalEmail ?? null,
                actorUserId: actor.userId,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ mapping });
        }
        catch (err) {
            if (handleExternalError(reply, err))
                return;
            throw err;
        }
    });
    app.delete("/v1/identity/external-mappings/:id", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
        const actor = await requireIdentityActor(req, reply, body.teamId, "identity.external_mapping.manage");
        if (!actor)
            return;
        try {
            const mapping = await unlinkExternalIdentity({
                teamId: body.teamId,
                mappingId: id,
                actorUserId: actor.userId,
                ipAddress: requestIp(req),
                userAgent: requestUa(req),
            });
            return reply.code(200).send({ mapping });
        }
        catch (err) {
            if (handleExternalError(reply, err))
                return;
            throw err;
        }
    });
}
