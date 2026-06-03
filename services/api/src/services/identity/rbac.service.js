/**
 * Phase 17 — RBAC Service.
 *
 * The single mutation surface for:
 *   - TeamMember lifecycle (suspend / revoke / restore / role change)
 *   - Member capability grants (grant / revoke)
 *   - Delegated admin scopes (grant / revoke)
 *
 * Every mutation emits BOTH:
 *   - a workspace-internal SecurityEvent (operator-visible signal)
 *   - a platform-audit-log entry (hash-chained immutable audit)
 *
 * Hard invariants:
 *   - OWNER cannot be suspended, revoked, demoted, or have capability
 *     grants stacked onto them (they already have everything).
 *   - Status transitions follow the allow-list in @proovra/shared
 *     (ACTIVE ↔ SUSPENDED, ACTIVE → REVOKED, SUSPENDED → REVOKED).
 *   - Capability grants on a SUSPENDED / REVOKED member are valid rows
 *     but have no effect at evaluation time (access-policy enforces).
 *   - All actions accept an actorUserId (the operator) and write it to
 *     the chain. Service-account-initiated mutations write actorUserId
 *     = null and source = "service_account".
 */
import * as prismaPkg from "@prisma/client";
import { PERMISSIONS, isAllowedTeamMemberStatusTransition, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
export class RbacError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const PERMISSION_SET = new Set(PERMISSIONS);
async function loadTargetMember(client, teamId, teamMemberId) {
    const row = await client.teamMember.findFirst({
        where: { id: teamMemberId, teamId },
        select: {
            id: true,
            teamId: true,
            userId: true,
            role: true,
            status: true,
        },
    });
    if (!row)
        throw new RbacError("member_not_found");
    return row;
}
function assertNotOwner(role) {
    if (role === prismaPkg.TeamRole.OWNER) {
        throw new RbacError("member_owner_immutable");
    }
}
async function emitMemberAudit(client, input) {
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: input.eventType,
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId,
            subjectMemberId: input.subjectMemberId,
            subjectUserId: input.subjectUserId,
            reason: input.reason ?? null,
            ...input.metadata,
        },
    }, client);
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: input.action,
        category: "identity.rbac",
        severity: "info",
        source: "identity_service",
        outcome: "success",
        resourceType: "team_member",
        resourceId: input.subjectMemberId,
        metadata: {
            teamId: input.teamId,
            subjectUserId: input.subjectUserId,
            reason: input.reason ?? null,
            ...input.metadata,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
}
export async function suspendMember(input, client = defaultPrisma) {
    const target = await loadTargetMember(client, input.teamId, input.teamMemberId);
    if (target.userId === input.actorUserId) {
        throw new RbacError("self_action_forbidden");
    }
    assertNotOwner(target.role);
    if (!isAllowedTeamMemberStatusTransition(target.status, "SUSPENDED")) {
        throw new RbacError("invalid_status_transition");
    }
    const updated = await client.teamMember.update({
        where: { id: target.id },
        data: {
            status: prismaPkg.TeamMemberStatus.SUSPENDED,
            suspendedAtUtc: new Date(),
            suspendedByUserId: input.actorUserId,
            suspensionReason: input.reason ?? null,
        },
    });
    await emitMemberAudit(client, {
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        action: "identity.member.suspend",
        subjectMemberId: target.id,
        subjectUserId: target.userId,
        eventType: "member_suspended",
        reason: input.reason,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
    });
    // Phase 19 — suspended members lose every active session.
    await autoRevokeAllSessions(client, {
        teamId: input.teamId,
        userId: target.userId,
        reason: "MEMBER_SUSPENDED",
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
    });
    return updated;
}
export async function revokeMember(input, client = defaultPrisma) {
    const target = await loadTargetMember(client, input.teamId, input.teamMemberId);
    if (target.userId === input.actorUserId) {
        throw new RbacError("self_action_forbidden");
    }
    assertNotOwner(target.role);
    if (!isAllowedTeamMemberStatusTransition(target.status, "REVOKED")) {
        throw new RbacError("invalid_status_transition");
    }
    const updated = await client.teamMember.update({
        where: { id: target.id },
        data: {
            status: prismaPkg.TeamMemberStatus.REVOKED,
            revokedAtUtc: new Date(),
            revokedByUserId: input.actorUserId,
            revocationReason: input.reason ?? null,
        },
    });
    await emitMemberAudit(client, {
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        action: "identity.member.revoke",
        subjectMemberId: target.id,
        subjectUserId: target.userId,
        eventType: "member_revoked",
        reason: input.reason,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
    });
    // Phase 19 — revoked members lose every active session.
    await autoRevokeAllSessions(client, {
        teamId: input.teamId,
        userId: target.userId,
        reason: "MEMBER_REVOKED",
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
    });
    return updated;
}
export async function restoreMember(input, client = defaultPrisma) {
    const target = await loadTargetMember(client, input.teamId, input.teamMemberId);
    assertNotOwner(target.role);
    if (!isAllowedTeamMemberStatusTransition(target.status, "ACTIVE")) {
        throw new RbacError("invalid_status_transition");
    }
    const updated = await client.teamMember.update({
        where: { id: target.id },
        data: {
            status: prismaPkg.TeamMemberStatus.ACTIVE,
            suspendedAtUtc: null,
            suspendedByUserId: null,
            suspensionReason: null,
        },
    });
    await emitMemberAudit(client, {
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        action: "identity.member.restore",
        subjectMemberId: target.id,
        subjectUserId: target.userId,
        eventType: "member_restored",
        reason: input.reason,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
    });
    return updated;
}
export async function changeMemberRole(input, client = defaultPrisma) {
    const target = await loadTargetMember(client, input.teamId, input.teamMemberId);
    if (target.userId === input.actorUserId) {
        throw new RbacError("self_action_forbidden");
    }
    assertNotOwner(target.role);
    if (input.newRole === prismaPkg.TeamRole.OWNER) {
        // OWNERSHIP TRANSFER is intentionally NOT part of Phase 17.
        throw new RbacError("role_transition_to_owner_forbidden");
    }
    const updated = await client.teamMember.update({
        where: { id: target.id },
        data: { role: input.newRole },
    });
    await emitMemberAudit(client, {
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        action: "identity.member.role.change",
        subjectMemberId: target.id,
        subjectUserId: target.userId,
        eventType: "member_role_changed",
        reason: input.reason,
        metadata: { fromRole: target.role, toRole: input.newRole },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
    });
    return updated;
}
export async function grantCapability(input, client = defaultPrisma) {
    if (!PERMISSION_SET.has(input.permission)) {
        throw new RbacError("capability_unknown");
    }
    const target = await loadTargetMember(client, input.teamId, input.teamMemberId);
    // Re-issue path: if a grant already exists, refuse so callers must
    // explicitly revoke first. This keeps the audit trail honest about
    // when a grant was last issued.
    const existing = await client.memberCapabilityGrant.findUnique({
        where: {
            teamMemberId_permission: {
                teamMemberId: target.id,
                permission: input.permission,
            },
        },
        select: { id: true, revokedAtUtc: true },
    });
    if (existing && existing.revokedAtUtc === null) {
        throw new RbacError("capability_already_active");
    }
    const data = {
        teamMemberId: target.id,
        teamId: input.teamId,
        permission: input.permission,
        reason: input.reason ?? null,
        grantedByUserId: input.actorUserId,
        expiresAtUtc: input.expiresAtUtc ?? null,
        revokedAtUtc: null,
        revokedByUserId: null,
        revokedReason: null,
    };
    const grant = existing
        ? await client.memberCapabilityGrant.update({
            where: { id: existing.id },
            data: { ...data, grantedAtUtc: new Date() },
        })
        : await client.memberCapabilityGrant.create({ data });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "capability_granted",
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId,
            subjectMemberId: target.id,
            subjectUserId: target.userId,
            permission: input.permission,
            expiresAtUtc: input.expiresAtUtc?.toISOString() ?? null,
            reason: input.reason ?? null,
        },
    }, client);
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "identity.capability.grant",
        category: "identity.rbac",
        severity: "info",
        source: "identity_service",
        outcome: "success",
        resourceType: "member_capability_grant",
        resourceId: grant.id,
        metadata: {
            teamId: input.teamId,
            subjectMemberId: target.id,
            subjectUserId: target.userId,
            permission: input.permission,
            expiresAtUtc: input.expiresAtUtc?.toISOString() ?? null,
            reason: input.reason ?? null,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return grant;
}
export async function revokeCapability(input, client = defaultPrisma) {
    const grant = await client.memberCapabilityGrant.findFirst({
        where: { id: input.grantId, teamId: input.teamId, revokedAtUtc: null },
        select: { id: true, teamMemberId: true, permission: true },
    });
    if (!grant)
        throw new RbacError("capability_not_found");
    const updated = await client.memberCapabilityGrant.update({
        where: { id: grant.id },
        data: {
            revokedAtUtc: new Date(),
            revokedByUserId: input.actorUserId,
            revokedReason: input.reason ?? null,
        },
    });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "capability_revoked",
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId,
            grantId: grant.id,
            permission: grant.permission,
            reason: input.reason ?? null,
        },
    }, client);
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "identity.capability.revoke",
        category: "identity.rbac",
        severity: "info",
        source: "identity_service",
        outcome: "success",
        resourceType: "member_capability_grant",
        resourceId: grant.id,
        metadata: {
            teamId: input.teamId,
            permission: grant.permission,
            reason: input.reason ?? null,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return updated;
}
export async function grantDelegatedAdminScope(input, client = defaultPrisma) {
    const target = await loadTargetMember(client, input.teamId, input.teamMemberId);
    const existing = await client.memberDelegatedAdminScope.findUnique({
        where: {
            teamMemberId_scopeKind: {
                teamMemberId: target.id,
                scopeKind: input.scopeKind,
            },
        },
        select: { id: true, revokedAtUtc: true },
    });
    if (existing && existing.revokedAtUtc === null) {
        throw new RbacError("delegated_scope_already_active");
    }
    const data = {
        teamMemberId: target.id,
        teamId: input.teamId,
        scopeKind: input.scopeKind,
        reason: input.reason ?? null,
        grantedByUserId: input.actorUserId,
        expiresAtUtc: input.expiresAtUtc ?? null,
        revokedAtUtc: null,
        revokedByUserId: null,
        revokedReason: null,
    };
    const scope = existing
        ? await client.memberDelegatedAdminScope.update({
            where: { id: existing.id },
            data: { ...data, grantedAtUtc: new Date() },
        })
        : await client.memberDelegatedAdminScope.create({ data });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "delegated_admin_granted",
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId,
            subjectMemberId: target.id,
            subjectUserId: target.userId,
            scopeKind: input.scopeKind,
            expiresAtUtc: input.expiresAtUtc?.toISOString() ?? null,
            reason: input.reason ?? null,
        },
    }, client);
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "identity.delegated_admin.grant",
        category: "identity.rbac",
        severity: "info",
        source: "identity_service",
        outcome: "success",
        resourceType: "member_delegated_admin_scope",
        resourceId: scope.id,
        metadata: {
            teamId: input.teamId,
            subjectMemberId: target.id,
            subjectUserId: target.userId,
            scopeKind: input.scopeKind,
            expiresAtUtc: input.expiresAtUtc?.toISOString() ?? null,
            reason: input.reason ?? null,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return scope;
}
export async function revokeDelegatedAdminScope(input, client = defaultPrisma) {
    const scope = await client.memberDelegatedAdminScope.findFirst({
        where: { id: input.scopeId, teamId: input.teamId, revokedAtUtc: null },
        select: { id: true, scopeKind: true, teamMemberId: true },
    });
    if (!scope)
        throw new RbacError("delegated_scope_not_found");
    const updated = await client.memberDelegatedAdminScope.update({
        where: { id: scope.id },
        data: {
            revokedAtUtc: new Date(),
            revokedByUserId: input.actorUserId,
            revokedReason: input.reason ?? null,
        },
    });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "delegated_admin_revoked",
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId,
            scopeId: scope.id,
            scopeKind: scope.scopeKind,
            reason: input.reason ?? null,
        },
    }, client);
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "identity.delegated_admin.revoke",
        category: "identity.rbac",
        severity: "info",
        source: "identity_service",
        outcome: "success",
        resourceType: "member_delegated_admin_scope",
        resourceId: scope.id,
        metadata: {
            teamId: input.teamId,
            scopeKind: scope.scopeKind,
            reason: input.reason ?? null,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return updated;
}
export async function listTeamMembersWithAccess(teamId, client = defaultPrisma) {
    const rows = await client.teamMember.findMany({
        where: { teamId },
        include: {
            capabilityGrants: {
                select: {
                    id: true,
                    permission: true,
                    expiresAtUtc: true,
                    revokedAtUtc: true,
                    grantedAtUtc: true,
                },
            },
            delegatedAdminScopes: {
                select: {
                    id: true,
                    scopeKind: true,
                    expiresAtUtc: true,
                    revokedAtUtc: true,
                    grantedAtUtc: true,
                },
            },
        },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((r) => ({
        teamMemberId: r.id,
        userId: r.userId,
        role: r.role,
        status: r.status,
        accessGrantedAtUtc: r.accessGrantedAtUtc,
        accessExpiresAtUtc: r.accessExpiresAtUtc,
        suspendedAtUtc: r.suspendedAtUtc,
        revokedAtUtc: r.revokedAtUtc,
        lastSeenAtUtc: r.lastSeenAtUtc,
        capabilityGrants: r.capabilityGrants,
        delegatedAdminScopes: r.delegatedAdminScopes,
    }));
}
// -----------------------------------------------------------------------------
// Last-seen touch — best-effort, called from request middleware.
// -----------------------------------------------------------------------------
export async function touchMemberLastSeen(input, client = defaultPrisma) {
    try {
        await client.teamMember.updateMany({
            where: {
                teamId: input.teamId,
                userId: input.userId,
                status: prismaPkg.TeamMemberStatus.ACTIVE,
            },
            data: { lastSeenAtUtc: new Date() },
        });
    }
    catch {
        // best-effort; never break the request path
    }
}
// -----------------------------------------------------------------------------
// Phase 19 hook — auto session revocation on suspend / revoke.
//
// Dynamic import keeps the dependency graph linear: the identity-
// security session-revocation service must NOT import RBAC (it
// already imports platform-audit-log + security-event, which are
// pure logs). Best-effort — failures never break the lifecycle path.
// -----------------------------------------------------------------------------
async function autoRevokeAllSessions(client, input) {
    try {
        const mod = await import("../identity-security/session-revocation.service.js");
        await mod.revokeAllSessionsForUser({
            teamId: input.teamId,
            userId: input.userId,
            reason: input.reason,
            actorUserId: input.actorUserId,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
        }, client);
    }
    catch {
        // best-effort; never break the lifecycle mutation
    }
}
