/**
 * Phase 17 — Access Policy Engine.
 *
 * The ONE place that answers "can this actor perform this permission in
 * this workspace, right now". Every service-layer permission check in
 * Phase 17+ MUST route through `evaluateAccess`. Route-level
 * `requirePermission` (governance.service.ts) is preserved for legacy
 * callers; new code should call `evaluateAccess` directly.
 *
 * Inputs:
 *   - actor    — workspace member (resolved from session) OR service
 *                account credential (resolved by integrations-auth)
 *   - permission — canonical Permission identifier
 *   - context   — optional resource scope (evidence id, team id,
 *                 governance flags) for deny-by-governance gates
 *
 * Output: a deterministic { allowed, reason } decision. ALL denials
 * carry a structured reason and are emitted to the SecurityEvent table
 * as `permission_denied` so operators can see who tried what.
 *
 * Hard invariants:
 *   - Elevated access NEVER bypasses governance. A delegated admin or
 *     capability grant can WIDEN permissions; it cannot turn off the
 *     governance gates that already deny.
 *   - Fail closed. Any unexpected branch returns deny.
 *   - Pure within a given inputs snapshot — no DB writes in the
 *     evaluation path. The audit emission happens on the caller side
 *     via `recordPermissionDecision`.
 */
import * as prismaPkg from "@prisma/client";
import { listPermissionsForDelegatedAdminScope, mapTeamRoleToCanonical, roleHasPermission, teamMemberStatusGrantsAccess, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
// -----------------------------------------------------------------------------
// Pure evaluator
// -----------------------------------------------------------------------------
const NOW = () => new Date();
function isActiveGrant(grant, now) {
    if (grant.revokedAtUtc !== null)
        return false;
    if (grant.expiresAtUtc !== null && grant.expiresAtUtc.getTime() <= now.getTime()) {
        return false;
    }
    return true;
}
function evaluateMember(actor, permission, now) {
    if (!teamMemberStatusGrantsAccess(actor.status)) {
        return { allowed: false, reason: "member_not_active", detail: actor.status };
    }
    if (actor.accessExpiresAtUtc !== null &&
        actor.accessExpiresAtUtc.getTime() <= now.getTime()) {
        return { allowed: false, reason: "member_access_expired" };
    }
    // 1) Canonical role floor.
    const canonical = mapTeamRoleToCanonical(actor.role);
    if (roleHasPermission(canonical, permission)) {
        return { allowed: true, via: { kind: "role", role: canonical } };
    }
    // 2) Active capability grants.
    for (const grant of actor.capabilityGrants) {
        if (!isActiveGrant(grant, now))
            continue;
        if (grant.permission === permission) {
            return {
                allowed: true,
                via: { kind: "capability_grant", grantId: grant.id },
            };
        }
    }
    // 3) Active delegated admin scopes.
    for (const scope of actor.delegatedAdminScopes) {
        if (!isActiveGrant(scope, now))
            continue;
        const granted = listPermissionsForDelegatedAdminScope(scope.scopeKind);
        if (granted.includes(permission)) {
            return {
                allowed: true,
                via: {
                    kind: "delegated_admin",
                    scope: scope.scopeKind,
                    scopeId: scope.id,
                },
            };
        }
    }
    return { allowed: false, reason: "permission_not_granted" };
}
function evaluateServiceAccount(actor, permission, now) {
    if (actor.status === "REVOKED") {
        return { allowed: false, reason: "service_account_revoked" };
    }
    if (actor.disabledAtUtc !== null) {
        return { allowed: false, reason: "service_account_disabled" };
    }
    if (actor.expiresAtUtc !== null &&
        actor.expiresAtUtc.getTime() <= now.getTime()) {
        return { allowed: false, reason: "service_account_expired" };
    }
    if (!actor.scopes.includes(permission)) {
        return { allowed: false, reason: "service_account_scope_missing" };
    }
    return {
        allowed: true,
        via: { kind: "service_account_scope", permission },
    };
}
const CONTRIBUTOR_ALLOWED = new Set([
    "workflow.external_submission.read",
    "evidence.create",
    "evidence.update_metadata",
    "evidence.read",
    "collaboration.thread.read",
    "collaboration.message.post",
]);
function evaluateContributor(actor, permission, now) {
    if (actor.revokedAtUtc !== null) {
        return { allowed: false, reason: "contributor_session_revoked" };
    }
    if (actor.expiresAtUtc.getTime() <= now.getTime()) {
        return { allowed: false, reason: "contributor_session_expired" };
    }
    if (!CONTRIBUTOR_ALLOWED.has(permission)) {
        return { allowed: false, reason: "contributor_unsupported_permission" };
    }
    return { allowed: true, via: { kind: "contributor_session" } };
}
export function evaluateAccess(actor, context) {
    if (!actor)
        return { allowed: false, reason: "no_actor" };
    const now = NOW();
    switch (actor.kind) {
        case "MEMBER":
            return evaluateMember(actor.member, context.permission, now);
        case "SERVICE_ACCOUNT":
            return evaluateServiceAccount(actor.serviceAccount, context.permission, now);
        case "CONTRIBUTOR":
            return evaluateContributor(actor.contributor, context.permission, now);
    }
}
// -----------------------------------------------------------------------------
// Snapshot loader — DB-bound, used by route handlers + services.
// -----------------------------------------------------------------------------
export async function loadMemberAccessSnapshot(input, client = defaultPrisma) {
    const row = await client.teamMember.findUnique({
        where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
        include: {
            capabilityGrants: {
                select: {
                    id: true,
                    permission: true,
                    expiresAtUtc: true,
                    revokedAtUtc: true,
                },
            },
            delegatedAdminScopes: {
                select: {
                    id: true,
                    scopeKind: true,
                    expiresAtUtc: true,
                    revokedAtUtc: true,
                },
            },
        },
    });
    if (!row)
        return null;
    return {
        teamMemberId: row.id,
        teamId: row.teamId,
        userId: row.userId,
        role: row.role,
        status: row.status,
        accessExpiresAtUtc: row.accessExpiresAtUtc,
        capabilityGrants: row.capabilityGrants.map((g) => ({
            id: g.id,
            permission: g.permission,
            expiresAtUtc: g.expiresAtUtc,
            revokedAtUtc: g.revokedAtUtc,
        })),
        delegatedAdminScopes: row.delegatedAdminScopes.map((s) => ({
            id: s.id,
            scopeKind: s.scopeKind,
            expiresAtUtc: s.expiresAtUtc,
            revokedAtUtc: s.revokedAtUtc,
        })),
    };
}
export async function loadServiceAccountSnapshot(apiCredentialId, client = defaultPrisma) {
    const row = await client.apiCredential.findUnique({
        where: { id: apiCredentialId },
        select: {
            id: true,
            teamId: true,
            status: true,
            scopes: true,
            expiresAtUtc: true,
            disabledAtUtc: true,
            rotationRequired: true,
        },
    });
    if (!row)
        return null;
    return {
        apiCredentialId: row.id,
        teamId: row.teamId,
        status: row.status,
        scopes: row.scopes,
        expiresAtUtc: row.expiresAtUtc,
        disabledAtUtc: row.disabledAtUtc,
        rotationRequired: row.rotationRequired,
    };
}
export async function loadContributorSessionSnapshot(intakeSessionId, client = defaultPrisma) {
    const row = await client.workflowIntakeSession.findUnique({
        where: { id: intakeSessionId },
        select: {
            id: true,
            intakeLinkId: true,
            revokedAtUtc: true,
            expiresAtUtc: true,
            intakeLink: { select: { teamId: true } },
        },
    });
    if (!row)
        return null;
    return {
        intakeSessionId: row.id,
        intakeLinkId: row.intakeLinkId,
        teamId: row.intakeLink.teamId,
        revokedAtUtc: row.revokedAtUtc,
        expiresAtUtc: row.expiresAtUtc,
    };
}
// -----------------------------------------------------------------------------
// Decision audit — every deny is emitted as `permission_denied`.
// -----------------------------------------------------------------------------
export function recordPermissionDecision(input, client = defaultPrisma) {
    if (input.decision.allowed)
        return;
    const teamId = input.actor?.kind === "MEMBER"
        ? input.actor.member.teamId
        : input.actor?.kind === "SERVICE_ACCOUNT"
            ? input.actor.serviceAccount.teamId
            : input.actor?.kind === "CONTRIBUTOR"
                ? input.actor.contributor.teamId
                : null;
    safeEmitSecurityEvent({
        teamId,
        eventType: "permission_denied",
        severity: "WARNING",
        apiCredentialId: input.actor?.kind === "SERVICE_ACCOUNT"
            ? input.actor.serviceAccount.apiCredentialId
            : null,
        details: {
            permission: input.permission,
            reason: input.decision.reason,
            detail: input.decision.detail ?? null,
            actorKind: input.actor?.kind ?? "NONE",
            resourceKind: input.resourceKind ?? null,
            resourceId: input.resourceId ?? null,
        },
    }, client);
}
// -----------------------------------------------------------------------------
// One-shot convenience — load + evaluate + audit on deny.
// -----------------------------------------------------------------------------
export async function evaluateMemberAccess(input, client = defaultPrisma) {
    const snapshot = await loadMemberAccessSnapshot({ teamId: input.teamId, userId: input.userId }, client);
    const actor = snapshot
        ? { kind: "MEMBER", member: snapshot }
        : null;
    const decision = evaluateAccess(actor, {
        permission: input.permission,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
    });
    recordPermissionDecision({
        actor,
        permission: input.permission,
        decision,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
    }, client);
    return decision;
}
// Mirror of the prismaPkg.TeamMemberStatus enum so other modules can
// reference it without importing the entire Prisma namespace.
export const TEAM_MEMBER_STATUS = prismaPkg.TeamMemberStatus;
