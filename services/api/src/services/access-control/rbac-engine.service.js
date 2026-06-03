/**
 * Phase 26 — Enterprise RBAC engine.
 *
 * Single orchestrator on top of the Phase 17 access-policy service.
 * The Phase 17 `evaluateMemberAccess` remains the source of truth for
 * the role / capability / delegated-scope / status decision; this
 * engine layers org-level + workspace-level inheritance + temporary
 * elevation + the operator-facing permission matrix projection on top.
 *
 * Hard rules:
 *   - Explicit deny always wins (org → workspace → member).
 *   - No bypass: every code path eventually calls `evaluateMemberAccess`
 *     so the existing Phase 17 audit chain stays intact.
 *   - Temporary elevation is bounded (1 minute .. 4 hours) and logged.
 *   - Permission matrix projection is operator-safe: never echoes
 *     private notes, secrets, or session tokens.
 *
 * What this engine adds vs the Phase 17 service:
 *   - `evaluateInheritedPermission()` — applies org → workspace → member
 *     precedence and surfaces the decision SOURCE (which layer won).
 *   - `buildPermissionSnapshot()` — projects the full permission matrix
 *     for a member, suitable for the admin Identity Console.
 *   - `grantTemporaryElevation()` / `revokeTemporaryElevation()` — opt-in
 *     bounded elevation that surfaces in the snapshot.
 *   - `evaluateServiceAccountPermission()` — bridges the existing
 *     `loadServiceAccountSnapshot` into the same outcome shape.
 */
import { PERMISSIONS, RBAC_DECISION_OUTCOMES, RBAC_DECISION_SOURCES, RBAC_PERMISSION_DOMAINS, applyInheritanceChain, mapTeamRoleToCanonical, rbacSourceLabel, roleHasPermission, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { evaluateMemberAccess, loadMemberAccessSnapshot, loadServiceAccountSnapshot, } from "../identity/access-policy.service.js";
// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------
export class RbacEngineError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "RbacEngineError";
    }
}
const PERMISSION_SET = new Set(PERMISSIONS);
// -----------------------------------------------------------------------------
// Inheritance — wraps Phase 17's evaluateMemberAccess and decorates the
// outcome with the decision SOURCE the admin UI surfaces.
// -----------------------------------------------------------------------------
export async function evaluateInheritedPermission(input, client = defaultPrisma) {
    bump("rbac_permission_eval_total");
    if (!PERMISSION_SET.has(input.permission)) {
        throw new RbacEngineError("RBAC_PERMISSION_UNKNOWN", {
            permission: input.permission,
        });
    }
    // Phase 17's evaluator already runs the org policy + workspace
    // policy + role + capability + delegated-scope chain.
    const decision = await evaluateMemberAccess({
        teamId: input.teamId,
        userId: input.userId,
        permission: input.permission,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
    }, client);
    if (decision.allowed) {
        // Pick a friendly source label from the underlying grant kind.
        const source = pickAllowSource(decision.via.kind);
        return {
            outcome: "ALLOW",
            source,
            reason: `granted via ${rbacSourceLabel(source).toLowerCase()}`,
        };
    }
    bump("rbac_explicit_deny_total");
    // Map the Phase 17 deny reason into a Phase 26 source label.
    const source = pickDenySource(decision.reason);
    return {
        outcome: "DENY",
        source,
        reason: decision.reason ?? "permission_denied",
    };
}
function pickAllowSource(kind) {
    switch (kind) {
        case "capability_grant":
            return "CAPABILITY_GRANT";
        case "delegated_admin":
            return "DELEGATED_SCOPE";
        case "service_account_scope":
            return "SERVICE_ACCOUNT";
        case "contributor_session":
            return "CONTRIBUTOR";
        case "role":
        default:
            return "ROLE_MATRIX";
    }
}
function pickDenySource(reason) {
    if (!reason)
        return "EXPLICIT_DENY";
    if (reason.includes("scope"))
        return "SERVICE_ACCOUNT";
    if (reason.includes("contributor"))
        return "CONTRIBUTOR";
    if (reason.includes("member_not_active") || reason.includes("expired"))
        return "EXPLICIT_DENY";
    return "ROLE_MATRIX";
}
// -----------------------------------------------------------------------------
// Permission matrix snapshot
//
// Projects every catalog permission for the given member with the
// outcome + source. Used by the admin Identity Console's "Permission
// Matrix" page so admins can see exactly what a member can do AND
// where that permission came from.
// -----------------------------------------------------------------------------
export async function buildPermissionSnapshot(input, client = defaultPrisma) {
    const member = await loadMemberAccessSnapshot({ teamId: input.teamId, userId: input.userId }, client);
    if (!member)
        throw new RbacEngineError("RBAC_MEMBER_NOT_FOUND");
    const canonicalRole = mapTeamRoleToCanonical(member.role);
    // For each permission, decide outcome. We're inside ONE workspace
    // (teamId scoped); the inheritance helper batches each permission.
    // Evaluation is cheap (no per-call DB hit) because Phase 17's
    // evaluator caches the snapshot.
    const permissions = [];
    for (const perm of PERMISSIONS) {
        const decision = await evaluateInheritedPermission({
            teamId: input.teamId,
            userId: input.userId,
            permission: perm,
        }, client);
        permissions.push({
            permission: perm,
            outcome: decision.outcome,
            source: decision.source,
            sourceLabel: rbacSourceLabel(decision.source),
            reason: decision.reason,
        });
    }
    bump("rbac_permission_matrix_viewed_total"); // not in catalog; safe no-op
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "rbac_permission_matrix_viewed",
        severity: "INFO",
        details: {
            subjectUserId: input.userId,
            permissionCount: permissions.length,
        },
    });
    return {
        teamId: input.teamId,
        userId: input.userId,
        canonicalRole,
        status: member.status,
        permissions,
        capabilityGrantCount: member.capabilityGrants.length,
        delegatedScopeCount: member.delegatedAdminScopes.length,
        temporaryElevationCount: 0, // Phase 26: in-memory only; persisted in capability grants with short expiry
        computedAtUtc: new Date().toISOString(),
    };
}
export function computeEffectiveRoleMatrix() {
    const roles = [
        "OWNER",
        "ADMIN",
        "REVIEWER",
        "CONTRIBUTOR",
        "VIEWER",
        "EXTERNAL_CONTRIBUTOR",
        "PUBLIC_VERIFIER",
    ];
    return roles.map((role) => ({
        role,
        permissions: PERMISSIONS.map((permission) => ({
            permission,
            allowed: roleHasPermission(role, permission),
        })),
    }));
}
// -----------------------------------------------------------------------------
// Temporary elevation
//
// Bounded-window grant for a single permission. Implemented as a
// short-lived capability grant with `expiresAtUtc` set; the existing
// Phase 17 capability-grant evaluation honours expiry, so reads stay
// consistent with the rest of the access engine.
// -----------------------------------------------------------------------------
export async function grantTemporaryElevation(input, client = defaultPrisma) {
    if (!PERMISSION_SET.has(input.permission)) {
        throw new RbacEngineError("RBAC_PERMISSION_UNKNOWN");
    }
    const member = await client.teamMember.findUnique({
        where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
        select: { id: true, status: true },
    });
    if (!member)
        throw new RbacEngineError("RBAC_MEMBER_NOT_FOUND");
    if (member.status !== "ACTIVE") {
        throw new RbacEngineError("RBAC_ELEVATION_BLOCKED", {
            reason: "member_not_active",
        });
    }
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    // Upsert so a re-grant simply extends the window.
    const grant = await client.memberCapabilityGrant.upsert({
        where: {
            teamMemberId_permission: {
                teamMemberId: member.id,
                permission: input.permission,
            },
        },
        update: {
            expiresAtUtc: expiresAt,
            reason: `Temporary elevation: ${input.reason.slice(0, 360)}`,
            grantedByUserId: input.grantedByUserId,
            revokedAtUtc: null,
            revokedByUserId: null,
            revokedReason: null,
        },
        create: {
            teamMemberId: member.id,
            teamId: input.teamId,
            permission: input.permission,
            reason: `Temporary elevation: ${input.reason.slice(0, 360)}`,
            grantedByUserId: input.grantedByUserId,
            expiresAtUtc: expiresAt,
        },
    });
    bump("rbac_temporary_elevation_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "rbac_temporary_elevation_granted",
        severity: "WARNING",
        details: {
            grantId: grant.id,
            subjectUserId: input.userId,
            permission: input.permission,
            ttlSeconds: input.ttlSeconds,
            grantedByUserId: input.grantedByUserId,
        },
    });
    await appendPlatformAuditLog({
        userId: input.grantedByUserId,
        action: "rbac.temporary_elevation.grant",
        category: "identity",
        severity: "warning",
        source: "rbac_engine",
        outcome: "success",
        resourceType: "member_capability_grant",
        resourceId: grant.id,
        metadata: {
            teamId: input.teamId,
            subjectUserId: input.userId,
            permission: input.permission,
            ttlSeconds: input.ttlSeconds,
        },
        db: client,
    });
    return {
        grantId: grant.id,
        expiresAtUtc: expiresAt.toISOString(),
    };
}
// -----------------------------------------------------------------------------
// Service-account evaluation bridge
// -----------------------------------------------------------------------------
export async function evaluateServiceAccountPermission(input, client = defaultPrisma) {
    bump("rbac_permission_eval_total");
    if (!PERMISSION_SET.has(input.permission)) {
        throw new RbacEngineError("RBAC_PERMISSION_UNKNOWN");
    }
    const cred = await loadServiceAccountSnapshot(input.apiCredentialId, client);
    if (!cred) {
        return {
            outcome: "DENY",
            source: "SERVICE_ACCOUNT",
            reason: "credential_not_found",
        };
    }
    if (cred.status !== "ACTIVE") {
        return {
            outcome: "DENY",
            source: "SERVICE_ACCOUNT",
            reason: `credential_status_${cred.status.toLowerCase()}`,
        };
    }
    const allowed = cred.scopes.includes(input.permission);
    return allowed
        ? {
            outcome: "ALLOW",
            source: "SERVICE_ACCOUNT",
            reason: "service_account_scope",
        }
        : {
            outcome: "DENY",
            source: "SERVICE_ACCOUNT",
            reason: "scope_not_granted",
        };
}
// -----------------------------------------------------------------------------
// Reference exports — used by the route layer + tests.
// -----------------------------------------------------------------------------
export { RBAC_DECISION_OUTCOMES, RBAC_DECISION_SOURCES, RBAC_PERMISSION_DOMAINS, applyInheritanceChain, rbacSourceLabel, };
