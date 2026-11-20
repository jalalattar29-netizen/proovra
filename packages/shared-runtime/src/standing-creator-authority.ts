/**
 * STANDING CREDENTIALS ANSWER TO THEIR CREATOR'S CURRENT AUTHORITY — the
 * decision and its facts, shared by the API and the Worker.
 *
 * The API's canonical access engine (services/api access-policy.service.ts
 * `evaluateAccess`) decides a MEMBER's permission with `decideMemberPermission`
 * below: one implementation of "status, access window, workspace lifecycle,
 * then role floor, live capability grants, live delegated scopes". The API's
 * `evaluateCreatorAuthority` (standing-credential-authority.ts) is
 * `evaluateStandingCreatorAuthority` with the API's client.
 *
 * WHY IT LIVES HERE (matrix review NEW-RG-07-1). An endpoint, key or link acts
 * in its creator's name; a capability grant or delegated scope that EXPIRES is
 * ended by no transition, only by a use-time check (PRO-LEAD-01 / PRO-G1Z-01,
 * DEC-09). The API asks at emit and at its own sends, but the Worker's
 * lifecycle-webhook dispatcher may not import the API and asked nothing, so a
 * queued or retrying delivery was still sent after the creator lost
 * integration.lifecycle_webhook.manage. Both hosts now ask this.
 *
 * What is deliberately NOT a loss of authority (unchanged):
 *   - EXPIRY of the creator's access window (policy A2-26): set aside.
 *   - the WORKSPACE's lifecycle (organization suspended, kind unprovable):
 *     WORKSPACE_BLOCKED, reversible, never a revocation.
 * A failure to read the facts is INDETERMINATE: refuse the use, revoke nothing.
 */
import type { PrismaClient } from "@prisma/client";
import {
  type CanonicalRole,
  type DbTeamRole,
  type DelegatedAdminScopeKind,
  type Permission,
  type TeamMemberStatus,
  listPermissionsForDelegatedAdminScope,
  mapTeamRoleToCanonical,
  normalizeWorkspaceKind,
  roleHasPermission,
  teamMemberStatusGrantsAccess,
} from "@proovra/shared";

export type MemberWorkspaceKind = ReturnType<typeof normalizeWorkspaceKind>;

/** The facts a member's permission is decided on (one read of one membership row). */
export type MemberPermissionFacts = {
  teamMemberId: string;
  teamId: string;
  userId: string;
  role: DbTeamRole;
  status: TeamMemberStatus;
  accessExpiresAtUtc: Date | null;
  workspaceKind: MemberWorkspaceKind;
  workspaceOwnerUserId: string | null;
  organizationStatus: string | null;
  organizationId: string | null;
  capabilityGrants: ReadonlyArray<{
    id: string;
    permission: string;
    expiresAtUtc: Date | null;
    revokedAtUtc: Date | null;
  }>;
  delegatedAdminScopes: ReadonlyArray<{
    id: string;
    scopeKind: DelegatedAdminScopeKind;
    expiresAtUtc: Date | null;
    revokedAtUtc: Date | null;
  }>;
};

export type MemberPermissionDecision =
  | {
      allowed: true;
      via:
        | { kind: "role"; role: CanonicalRole }
        | { kind: "capability_grant"; grantId: string }
        | { kind: "delegated_admin"; scope: DelegatedAdminScopeKind; scopeId: string };
    }
  | {
      allowed: false;
      reason:
        | "member_not_active"
        | "member_access_expired"
        | "workspace_kind_unresolved"
        | "organization_not_active"
        | "permission_not_granted";
      detail?: string;
    };

/** CUSTOMER-Organization lifecycle governs only an ORGANIZATION workspace. */
export function organizationLifecycleAppliesToKind(kind: MemberWorkspaceKind): boolean {
  return kind === "ORGANIZATION";
}

/**
 * The workspace-lifecycle gate (fail closed): an unprovable kind denies; an
 * ORGANIZATION workspace needs a loaded, ACTIVE organization. PERSONAL / OWNED
 * workspaces are backed by internal SYSTEM containers and are exempt.
 */
export function memberWorkspaceLifecycleDenial(state: {
  workspaceKind: MemberWorkspaceKind;
  organizationStatus: string | null;
}): { allowed: false; reason: "workspace_kind_unresolved" | "organization_not_active"; detail?: string } | null {
  if (state.workspaceKind === "UNKNOWN") {
    return { allowed: false, reason: "workspace_kind_unresolved" };
  }
  if (organizationLifecycleAppliesToKind(state.workspaceKind) && state.organizationStatus !== "ACTIVE") {
    return {
      allowed: false,
      reason: "organization_not_active",
      detail: state.organizationStatus ?? "missing",
    };
  }
  return null;
}

function isLiveGrant(grant: { expiresAtUtc: Date | null; revokedAtUtc: Date | null }, now: Date): boolean {
  if (grant.revokedAtUtc !== null) return false;
  if (grant.expiresAtUtc !== null && grant.expiresAtUtc.getTime() <= now.getTime()) return false;
  return true;
}

/** THE member permission decision (the API engine's MEMBER branch). */
export function decideMemberPermission(
  member: Pick<
    MemberPermissionFacts,
    "role" | "status" | "accessExpiresAtUtc" | "workspaceKind" | "organizationStatus" | "capabilityGrants" | "delegatedAdminScopes"
  >,
  permission: Permission,
  now: Date,
): MemberPermissionDecision {
  if (!teamMemberStatusGrantsAccess(member.status)) {
    return { allowed: false, reason: "member_not_active", detail: member.status };
  }
  if (member.accessExpiresAtUtc !== null && member.accessExpiresAtUtc.getTime() <= now.getTime()) {
    return { allowed: false, reason: "member_access_expired" };
  }
  const lifecycleDenial = memberWorkspaceLifecycleDenial(member);
  if (lifecycleDenial) return lifecycleDenial;
  // 1) Canonical role floor.
  const canonical = mapTeamRoleToCanonical(member.role);
  if (roleHasPermission(canonical, permission)) {
    return { allowed: true, via: { kind: "role", role: canonical } };
  }
  // 2) Live capability grants.
  for (const grant of member.capabilityGrants) {
    if (!isLiveGrant(grant, now)) continue;
    if (grant.permission === permission) {
      return { allowed: true, via: { kind: "capability_grant", grantId: grant.id } };
    }
  }
  // 3) Live delegated admin scopes.
  for (const scope of member.delegatedAdminScopes) {
    if (!isLiveGrant(scope, now)) continue;
    if (listPermissionsForDelegatedAdminScope(scope.scopeKind).includes(permission)) {
      return { allowed: true, via: { kind: "delegated_admin", scope: scope.scopeKind, scopeId: scope.id } };
    }
  }
  return { allowed: false, reason: "permission_not_granted" };
}

/** Structural client: either host's PrismaClient or a transaction client. */
export type MemberPermissionFactsClient = Pick<PrismaClient, "teamMember">;

/**
 * The membership row and the workspace facts it is decided on, in ONE read
 * (the API's `loadMemberAccessSnapshot` reads exactly this).
 */
export async function loadMemberPermissionFacts(
  client: MemberPermissionFactsClient,
  input: { teamId: string; userId: string },
): Promise<MemberPermissionFacts | null> {
  const row = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
    include: {
      team: {
        select: {
          isPersonal: true,
          workspaceKind: true,
          billingPlan: true,
          organizationId: true,
          ownerUserId: true,
          organization: { select: { status: true } },
        },
      },
      capabilityGrants: {
        select: { id: true, permission: true, expiresAtUtc: true, revokedAtUtc: true },
      },
      delegatedAdminScopes: {
        select: { id: true, scopeKind: true, expiresAtUtc: true, revokedAtUtc: true },
      },
    },
  });
  if (!row) return null;
  const team = (row as {
    team?: {
      isPersonal?: boolean;
      workspaceKind?: string | null;
      billingPlan?: string | null;
      organizationId?: string | null;
      ownerUserId?: string | null;
      organization?: { status?: string | null } | null;
    } | null;
  }).team;
  return {
    teamMemberId: row.id,
    teamId: row.teamId,
    userId: row.userId,
    role: row.role as DbTeamRole,
    status: row.status as TeamMemberStatus,
    accessExpiresAtUtc: row.accessExpiresAtUtc,
    workspaceKind: normalizeWorkspaceKind({
      workspaceKind: team?.workspaceKind ?? null,
      isPersonal: team?.isPersonal ?? null,
      billingPlan: team?.billingPlan ?? null,
      teamLoaded: team != null,
    }),
    workspaceOwnerUserId: team?.ownerUserId ?? null,
    organizationStatus: team?.organization?.status ?? null,
    organizationId: team?.organizationId ?? null,
    capabilityGrants: row.capabilityGrants.map((g) => ({
      id: g.id,
      permission: g.permission,
      expiresAtUtc: g.expiresAtUtc,
      revokedAtUtc: g.revokedAtUtc,
    })),
    delegatedAdminScopes: row.delegatedAdminScopes.map((s) => ({
      id: s.id,
      scopeKind: s.scopeKind as DelegatedAdminScopeKind,
      expiresAtUtc: s.expiresAtUtc,
      revokedAtUtc: s.revokedAtUtc,
    })),
  };
}

export type CreatorAuthorityVerdict =
  | { verdict: "HOLDS" }
  | { verdict: "LOST"; reason: string }
  | { verdict: "WORKSPACE_BLOCKED"; reason: string }
  | { verdict: "INDETERMINATE" };

/** The reason recorded on a credential ended because its creator lost the authority. */
export const CREATOR_LOST_AUTHORITY_REASON = "creator_lost_authority";

/**
 * Does the creator still hold `permission` in this workspace, by the canonical
 * member decision, with their access window set aside (A2-26)?
 */
export async function evaluateStandingCreatorAuthority(
  client: MemberPermissionFactsClient,
  input: { teamId: string; userId: string; permission: Permission },
  now: Date = new Date(),
): Promise<CreatorAuthorityVerdict> {
  let facts: MemberPermissionFacts | null;
  try {
    facts = await loadMemberPermissionFacts(client, { teamId: input.teamId, userId: input.userId });
  } catch {
    return { verdict: "INDETERMINATE" };
  }
  if (!facts) return { verdict: "LOST", reason: "no_membership" };
  const decision = decideMemberPermission({ ...facts, accessExpiresAtUtc: null }, input.permission, now);
  if (decision.allowed) return { verdict: "HOLDS" };
  if (decision.reason === "workspace_kind_unresolved" || decision.reason === "organization_not_active") {
    return { verdict: "WORKSPACE_BLOCKED", reason: decision.reason };
  }
  return { verdict: "LOST", reason: decision.reason };
}
