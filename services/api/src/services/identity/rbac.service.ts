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

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type DelegatedAdminScopeKind,
  type Permission,
  type SecurityEventType,
  type TeamMemberStatus,
  PERMISSIONS,
  isAllowedTeamMemberStatusTransition,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
// PHASE 12 REMEDIATION §4.4 (2026-08-06) — pointer hygiene at the membership
// mutation boundary. HYGIENE ONLY: authorization never depends on it having
// run (see middleware/authorize.ts `authorizeCurrentWorkspaceOrFail`).
import { repairStaleCurrentWorkspacePointers } from "../access/current-workspace-pointer.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
// PHASE 3 (2026-07-21) — grant provenance (rbac IS the MANUAL-intent
// lifecycle surface of the canonical membership orchestrator family).
import {
  recordMembershipGrant,
  revokeAllMembershipGrants,
} from "./membership-provisioning.service.js";

// -----------------------------------------------------------------------------
// Error surface
// -----------------------------------------------------------------------------

export type RbacErrorCode =
  | "member_not_found"
  | "member_owner_immutable"
  | "invalid_status_transition"
  | "self_action_forbidden"
  | "capability_unknown"
  | "capability_already_active"
  | "capability_not_found"
  | "delegated_scope_already_active"
  | "delegated_scope_not_found"
  | "role_transition_to_owner_forbidden"
  // PHASE 12B (2026-07-30) — the workspace must never be left without a
  // single ACTIVE administrator. Raised by `assertNotLastAdministrator`,
  // which re-counts the remaining administrators INSIDE the mutating
  // transaction (see `runAtomically`).
  | "last_administrator_protected";

export class RbacError extends Error {
  readonly code: RbacErrorCode;
  constructor(code: RbacErrorCode) {
    super(code);
    this.code = code;
  }
}

const PERMISSION_SET = new Set<string>(PERMISSIONS);

// -----------------------------------------------------------------------------
// PHASE 12B (2026-07-30) — atomicity primitives.
//
// Every transition below is a READ-COMPARE-WRITE: it loads the target, decides
// legality against what it read, then writes. Performed on the bare client the
// decision could be made against a state another operator has already
// replaced (two concurrent demotions each observing "one other admin remains"
// would BOTH commit, leaving the workspace with zero administrators).
// `runAtomically` puts the read, the guard and the write in ONE interactive
// transaction so the guard re-counts under the same snapshot as the write.
//
// The `$transaction`-absent fallback exists for the injected in-memory
// transports used by the service-level suites; production always takes the
// real transaction path.
// -----------------------------------------------------------------------------

async function runAtomically<T>(
  client: PrismaClient,
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  const runner = (client as unknown as { $transaction?: unknown }).$transaction;
  if (typeof runner !== "function") return fn(client);
  return client.$transaction(async (tx) => fn(tx as unknown as PrismaClient));
}

/**
 * LAST-ADMINISTRATOR PROTECTION (atomic).
 *
 * Called INSIDE the mutating transaction, immediately before the write, for
 * every transition that removes administrative capability from `target`
 * (suspend / revoke / demotion out of the OWNER+ADMIN tier). It re-counts the
 * OTHER ACTIVE administrators under the transaction's snapshot; when none
 * remain the transition is refused and the transaction rolls back, so no
 * partial state is ever observable.
 */
async function assertNotLastAdministrator(
  tx: PrismaClient,
  input: { teamId: string; teamMemberId: string; role: prismaPkg.TeamRole },
): Promise<void> {
  if (
    input.role !== prismaPkg.TeamRole.OWNER &&
    input.role !== prismaPkg.TeamRole.ADMIN
  ) {
    return;
  }
  const remaining = await tx.teamMember.count({
    where: {
      teamId: input.teamId,
      id: { not: input.teamMemberId },
      status: prismaPkg.TeamMemberStatus.ACTIVE,
      role: { in: [prismaPkg.TeamRole.OWNER, prismaPkg.TeamRole.ADMIN] },
    },
  });
  if (remaining === 0) throw new RbacError("last_administrator_protected");
}

// -----------------------------------------------------------------------------
// Lifecycle: suspend / revoke / restore / role change
// -----------------------------------------------------------------------------

type LifecycleInput = {
  teamId: string;
  teamMemberId: string;
  actorUserId: string;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

async function loadTargetMember(
  client: PrismaClient,
  teamId: string,
  teamMemberId: string,
) {
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
  if (!row) throw new RbacError("member_not_found");
  return row;
}

function assertNotOwner(role: prismaPkg.TeamRole): void {
  if (role === prismaPkg.TeamRole.OWNER) {
    throw new RbacError("member_owner_immutable");
  }
}

async function emitMemberAudit(
  client: PrismaClient,
  input: {
    teamId: string;
    actorUserId: string;
    action: string;
    subjectMemberId: string;
    subjectUserId: string;
    eventType: SecurityEventType;
    reason?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  safeEmitSecurityEvent(
    {
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
    },
    client,
  );
  await emitTenantAudit({
    action: input.action,
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "team_member",
    resourceId: input.subjectMemberId,
    metadata: {
      subjectUserId: input.subjectUserId,
      reason: input.reason ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      ...input.metadata,
    },
  }, client);
}

export async function suspendMember(
  input: LifecycleInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.TeamMember> {
  const { updated, subjectUserId } = await runAtomically(client, async (tx) => {
    const target = await loadTargetMember(tx, input.teamId, input.teamMemberId);
    if (target.userId === input.actorUserId) {
      throw new RbacError("self_action_forbidden");
    }
    assertNotOwner(target.role);
    if (
      !isAllowedTeamMemberStatusTransition(
        target.status as TeamMemberStatus,
        "SUSPENDED",
      )
    ) {
      throw new RbacError("invalid_status_transition");
    }
    await assertNotLastAdministrator(tx, {
      teamId: input.teamId,
      teamMemberId: target.id,
      role: target.role,
    });
    const row = await tx.teamMember.update({
      where: { id: target.id },
      data: {
        status: prismaPkg.TeamMemberStatus.SUSPENDED,
        suspendedAtUtc: new Date(),
        suspendedByUserId: input.actorUserId,
        suspensionReason: input.reason ?? null,
      },
    });
    // §4.4 — the operator can no longer enter this workspace, so a pointer
    // naming it must not survive the transaction that withdrew the access.
    // Cleared to NULL only: choosing a replacement context belongs to
    // context RESTORATION, which revalidates DB authority when it runs.
    await repairStaleCurrentWorkspacePointers(
      {
        memberships: [
          { userId: target.userId, workspaceId: input.teamId },
        ],
      },
      tx as never,
    );
    await emitMemberAudit(tx, {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      action: "identity.member.suspend",
      subjectMemberId: target.id,
      subjectUserId: target.userId,
      eventType: "member_suspended" as SecurityEventType,
      reason: input.reason,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
    return { updated: row, subjectUserId: target.userId };
  });
  // Phase 19 — suspended members lose every active session. Best-effort and
  // deliberately AFTER the commit: it is a downstream effect, never part of
  // the membership transition's atomic unit.
  await autoRevokeAllSessions(client, {
    teamId: input.teamId,
    userId: subjectUserId,
    reason: "MEMBER_SUSPENDED",
    actorUserId: input.actorUserId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
  return updated;
}

export async function revokeMember(
  input: LifecycleInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.TeamMember> {
  const { updated, subjectUserId } = await runAtomically(client, async (tx) => {
    const target = await loadTargetMember(tx, input.teamId, input.teamMemberId);
    if (target.userId === input.actorUserId) {
      throw new RbacError("self_action_forbidden");
    }
    assertNotOwner(target.role);
    if (
      !isAllowedTeamMemberStatusTransition(
        target.status as TeamMemberStatus,
        "REVOKED",
      )
    ) {
      throw new RbacError("invalid_status_transition");
    }
    await assertNotLastAdministrator(tx, {
      teamId: input.teamId,
      teamMemberId: target.id,
      role: target.role,
    });
    const row = await tx.teamMember.update({
      where: { id: target.id },
      data: {
        status: prismaPkg.TeamMemberStatus.REVOKED,
        revokedAtUtc: new Date(),
        revokedByUserId: input.actorUserId,
        revocationReason: input.reason ?? null,
      },
    });
    // PHASE 3 (2026-07-21) — a manual admin revocation is authoritative over
    // EVERY grant source (SCIM/SSO/group/invite); mark all provenance rows
    // revoked so no automated source silently "still grants" this access.
    await revokeAllMembershipGrants(tx, {
      teamMemberId: target.id,
      actorUserId: input.actorUserId,
    });
    // §4.4 — same hygiene on the revocation leg.
    await repairStaleCurrentWorkspacePointers(
      {
        memberships: [
          { userId: target.userId, workspaceId: input.teamId },
        ],
      },
      tx as never,
    );
    await emitMemberAudit(tx, {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      action: "identity.member.revoke",
      subjectMemberId: target.id,
      subjectUserId: target.userId,
      eventType: "member_revoked" as SecurityEventType,
      reason: input.reason,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
    return { updated: row, subjectUserId: target.userId };
  });
  // Phase 19 — revoked members lose every active session (post-commit).
  await autoRevokeAllSessions(client, {
    teamId: input.teamId,
    userId: subjectUserId,
    reason: "MEMBER_REVOKED",
    actorUserId: input.actorUserId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
  return updated;
}

export async function restoreMember(
  input: LifecycleInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.TeamMember> {
  return runAtomically(client, async (tx) => {
    const target = await loadTargetMember(tx, input.teamId, input.teamMemberId);
    assertNotOwner(target.role);
    if (
      !isAllowedTeamMemberStatusTransition(
        target.status as TeamMemberStatus,
        "ACTIVE",
      )
    ) {
      throw new RbacError("invalid_status_transition");
    }
    const updated = await tx.teamMember.update({
      where: { id: target.id },
      data: {
        status: prismaPkg.TeamMemberStatus.ACTIVE,
        suspendedAtUtc: null,
        suspendedByUserId: null,
        suspensionReason: null,
      },
    });
    // PHASE 3 — provenance: manual reactivation restores the HELD role.
    await recordMembershipGrant(tx, {
      teamMemberId: target.id,
      source: "MANUAL",
      intent: "MEMBER_REACTIVATION",
      grantedByUserId: input.actorUserId,
      grantedRole: target.role,
    });
    await emitMemberAudit(tx, {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      action: "identity.member.restore",
      subjectMemberId: target.id,
      subjectUserId: target.userId,
      eventType: "member_restored" as SecurityEventType,
      reason: input.reason,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
    return updated;
  });
}

export type RoleChangeInput = LifecycleInput & {
  newRole: prismaPkg.TeamRole;
};

export async function changeMemberRole(
  input: RoleChangeInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.TeamMember> {
  return runAtomically(client, async (tx) => {
  const target = await loadTargetMember(tx, input.teamId, input.teamMemberId);
  if (target.userId === input.actorUserId) {
    throw new RbacError("self_action_forbidden");
  }
  assertNotOwner(target.role);
  if (input.newRole === prismaPkg.TeamRole.OWNER) {
    // OWNERSHIP TRANSFER is intentionally NOT part of Phase 17.
    throw new RbacError("role_transition_to_owner_forbidden");
  }
  // A demotion out of the administrative tier is guarded atomically: the
  // count runs under the same transaction snapshot as the write below.
  if (input.newRole !== prismaPkg.TeamRole.ADMIN) {
    await assertNotLastAdministrator(tx, {
      teamId: input.teamId,
      teamMemberId: target.id,
      role: target.role,
    });
  }
  const updated = await tx.teamMember.update({
    where: { id: target.id },
    data: { role: input.newRole },
  });
  // PHASE 3 — provenance: manual admin role assignment.
  await recordMembershipGrant(tx, {
    teamMemberId: target.id,
    source: "MANUAL",
    intent: "ADMIN_ASSIGNMENT",
    grantedByUserId: input.actorUserId,
    grantedRole: input.newRole,
  });
  await emitMemberAudit(tx, {
    teamId: input.teamId,
    actorUserId: input.actorUserId,
    action: "identity.member.role.change",
    subjectMemberId: target.id,
    subjectUserId: target.userId,
    eventType: "member_role_changed" as SecurityEventType,
    reason: input.reason,
    metadata: { fromRole: target.role, toRole: input.newRole },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
  return updated;
  });
}

// -----------------------------------------------------------------------------
// Capability grants
// -----------------------------------------------------------------------------

export type GrantCapabilityInput = {
  teamId: string;
  teamMemberId: string;
  permission: Permission;
  actorUserId: string;
  reason?: string | null;
  expiresAtUtc?: Date | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function grantCapability(
  input: GrantCapabilityInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.MemberCapabilityGrant> {
  if (!PERMISSION_SET.has(input.permission)) {
    throw new RbacError("capability_unknown");
  }
  return runAtomically(client, async (tx) => {
  const target = await loadTargetMember(tx, input.teamId, input.teamMemberId);
  // Re-issue path: if a grant already exists, refuse so callers must
  // explicitly revoke first. This keeps the audit trail honest about
  // when a grant was last issued.
  const existing = await tx.memberCapabilityGrant.findUnique({
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
    ? await tx.memberCapabilityGrant.update({
        where: { id: existing.id },
        data: { ...data, grantedAtUtc: new Date() },
      })
    : await tx.memberCapabilityGrant.create({ data });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "capability_granted" as SecurityEventType,
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        subjectMemberId: target.id,
        subjectUserId: target.userId,
        permission: input.permission,
        expiresAtUtc: input.expiresAtUtc?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    },
    tx,
  );
  await emitTenantAudit({
    action: "identity.capability.grant",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "member_capability_grant",
    resourceId: grant.id,
    metadata: {
      subjectMemberId: target.id,
      subjectUserId: target.userId,
      permission: input.permission,
      expiresAtUtc: input.expiresAtUtc?.toISOString() ?? null,
      reason: input.reason ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, tx);
  return grant;
  });
}

export type RevokeCapabilityInput = {
  teamId: string;
  grantId: string;
  actorUserId: string;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function revokeCapability(
  input: RevokeCapabilityInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.MemberCapabilityGrant> {
  return runAtomically(client, async (tx) => {
  const grant = await tx.memberCapabilityGrant.findFirst({
    where: { id: input.grantId, teamId: input.teamId, revokedAtUtc: null },
    select: { id: true, teamMemberId: true, permission: true },
  });
  if (!grant) throw new RbacError("capability_not_found");
  const updated = await tx.memberCapabilityGrant.update({
    where: { id: grant.id },
    data: {
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId,
      revokedReason: input.reason ?? null,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "capability_revoked" as SecurityEventType,
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        grantId: grant.id,
        permission: grant.permission,
        reason: input.reason ?? null,
      },
    },
    tx,
  );
  await emitTenantAudit({
    action: "identity.capability.revoke",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "member_capability_grant",
    resourceId: grant.id,
    metadata: {
      permission: grant.permission,
      reason: input.reason ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, tx);
  return updated;
  });
}

// -----------------------------------------------------------------------------
// Delegated admin scopes
// -----------------------------------------------------------------------------

export type GrantDelegatedAdminInput = {
  teamId: string;
  teamMemberId: string;
  scopeKind: DelegatedAdminScopeKind;
  actorUserId: string;
  reason?: string | null;
  expiresAtUtc?: Date | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function grantDelegatedAdminScope(
  input: GrantDelegatedAdminInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.MemberDelegatedAdminScope> {
  return runAtomically(client, async (tx) => {
  const target = await loadTargetMember(tx, input.teamId, input.teamMemberId);
  const existing = await tx.memberDelegatedAdminScope.findUnique({
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
    ? await tx.memberDelegatedAdminScope.update({
        where: { id: existing.id },
        data: { ...data, grantedAtUtc: new Date() },
      })
    : await tx.memberDelegatedAdminScope.create({ data });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "delegated_admin_granted" as SecurityEventType,
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        subjectMemberId: target.id,
        subjectUserId: target.userId,
        scopeKind: input.scopeKind,
        expiresAtUtc: input.expiresAtUtc?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    },
    tx,
  );
  await emitTenantAudit({
    action: "identity.delegated_admin.grant",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "member_delegated_admin_scope",
    resourceId: scope.id,
    metadata: {
      subjectMemberId: target.id,
      subjectUserId: target.userId,
      scopeKind: input.scopeKind,
      expiresAtUtc: input.expiresAtUtc?.toISOString() ?? null,
      reason: input.reason ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, tx);
  return scope;
  });
}

export type RevokeDelegatedAdminInput = {
  teamId: string;
  scopeId: string;
  actorUserId: string;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function revokeDelegatedAdminScope(
  input: RevokeDelegatedAdminInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.MemberDelegatedAdminScope> {
  return runAtomically(client, async (tx) => {
  const scope = await tx.memberDelegatedAdminScope.findFirst({
    where: { id: input.scopeId, teamId: input.teamId, revokedAtUtc: null },
    select: { id: true, scopeKind: true, teamMemberId: true },
  });
  if (!scope) throw new RbacError("delegated_scope_not_found");
  const updated = await tx.memberDelegatedAdminScope.update({
    where: { id: scope.id },
    data: {
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId,
      revokedReason: input.reason ?? null,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "delegated_admin_revoked" as SecurityEventType,
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        scopeId: scope.id,
        scopeKind: scope.scopeKind,
        reason: input.reason ?? null,
      },
    },
    tx,
  );
  await emitTenantAudit({
    action: "identity.delegated_admin.revoke",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "member_delegated_admin_scope",
    resourceId: scope.id,
    metadata: {
      scopeKind: scope.scopeKind,
      reason: input.reason ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, tx);
  return updated;
  });
}

// -----------------------------------------------------------------------------
// Read projections — safe for /identity UI.
// -----------------------------------------------------------------------------

export type MemberAccessSummary = {
  teamMemberId: string;
  userId: string;
  role: prismaPkg.TeamRole;
  status: prismaPkg.TeamMemberStatus;
  accessGrantedAtUtc: Date | null;
  accessExpiresAtUtc: Date | null;
  suspendedAtUtc: Date | null;
  revokedAtUtc: Date | null;
  lastSeenAtUtc: Date | null;
  capabilityGrants: ReadonlyArray<{
    id: string;
    permission: string;
    expiresAtUtc: Date | null;
    revokedAtUtc: Date | null;
    grantedAtUtc: Date;
  }>;
  delegatedAdminScopes: ReadonlyArray<{
    id: string;
    scopeKind: prismaPkg.DelegatedAdminScopeKind;
    expiresAtUtc: Date | null;
    revokedAtUtc: Date | null;
    grantedAtUtc: Date;
  }>;
};

export async function listTeamMembersWithAccess(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<MemberAccessSummary[]> {
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
// Last-seen touch — the membership heartbeat behind the members roster.
//
// PHASE 13 §4 (2026-08-17). `TeamMember.lastSeenAtUtc` is not decorative: the
// workspace administration console renders it as a "Last seen" column
// (`apps/web/app/(app)/admin/identity/_sections/MembersSection.tsx`, fed by
// `GET /v1/identity/members` through `listTeamMembersWithAccess`, which selects
// the column). Nothing wrote it, so every row in that column was blank — an
// administrator deciding whether an account is dormant was reading an empty
// space and could not tell "never seen" from "never recorded".
//
// It is now called from the authenticated-request path in
// `middleware/auth.ts`, which is the only place that knows all three facts it
// needs at once: that authentication SUCCEEDED, which user, and which workspace
// the session is anchored to.
//
// THROTTLED IN THE PREDICATE, NOT ONLY IN THE CALLER.
// A membership row is as hot as the user is active, and a naive write turns
// every request into an UPDATE on it. The caller applies a sample window before
// calling at all, and this WHERE clause applies the same bound again, so two
// concurrent requests inside one window produce at most one write regardless of
// what either caller believed: a row whose `lastSeenAtUtc` is already newer than
// the cutoff matches nothing.
// -----------------------------------------------------------------------------

/** Sample window for the membership heartbeat. Mirrors the session heartbeat. */
export const MEMBER_LAST_SEEN_SAMPLE_SECONDS = 60;

export async function touchMemberLastSeen(
  input: { teamId: string; userId: string; sampleWindowSeconds?: number },
  client: PrismaClient = defaultPrisma,
): Promise<{ written: boolean }> {
  try {
    const now = new Date();
    const cutoff = new Date(
      now.getTime() -
        (input.sampleWindowSeconds ?? MEMBER_LAST_SEEN_SAMPLE_SECONDS) * 1000,
    );
    const res = await client.teamMember.updateMany({
      where: {
        teamId: input.teamId,
        userId: input.userId,
        status: prismaPkg.TeamMemberStatus.ACTIVE,
        // Advance only when the stored value is older than the window, or has
        // never been written at all. A suspended or revoked membership is
        // excluded above: "last seen" describes live access, and a revoked row
        // must not look like it was used after revocation.
        OR: [{ lastSeenAtUtc: null }, { lastSeenAtUtc: { lt: cutoff } }],
      },
      data: { lastSeenAtUtc: now },
    });
    return { written: res.count > 0 };
  } catch {
    // best-effort; never break the request path
    return { written: false };
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

async function autoRevokeAllSessions(
  client: PrismaClient,
  input: {
    teamId: string;
    userId: string;
    reason: "MEMBER_SUSPENDED" | "MEMBER_REVOKED";
    actorUserId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  try {
    const mod = await import(
      "../identity-security/session-revocation.service.js"
    );
    await mod.revokeAllSessionsForUser(
      {
        teamId: input.teamId,
        userId: input.userId,
        reason: input.reason,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      client,
    );
  } catch {
    // best-effort; never break the lifecycle mutation
  }
}
