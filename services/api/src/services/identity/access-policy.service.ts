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

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type CanonicalRole,
  type DbTeamRole,
  type Permission,
  type DelegatedAdminScopeKind,
  type TeamMemberStatus,
  listPermissionsForDelegatedAdminScope,
  mapTeamRoleToCanonical,
  roleHasPermission,
  teamMemberStatusGrantsAccess,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import {
  organizationLifecycleApplies,
  resolveWorkspaceKind,
  type ResolvedWorkspaceKind,
} from "./workspace-kind.js";

// -----------------------------------------------------------------------------
// Snapshot types
// -----------------------------------------------------------------------------

export type MemberAccessSnapshot = {
  teamMemberId: string;
  teamId: string;
  userId: string;
  role: DbTeamRole;
  status: TeamMemberStatus;
  accessExpiresAtUtc: Date | null;
  // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21, corrected) — Workspace kind +
  // parent-Organization lifecycle. `workspaceKind` is the canonical persisted
  // kind (or the deterministic compatibility classification), never null:
  // UNKNOWN when the team row/fields could not be proven — which DENIES
  // (fail closed). `organizationStatus` is the parent Organization.status, or
  // null when the org row/status was NOT loaded. For an ORGANIZATION
  // workspace, a null / non-ACTIVE status DENIES (no silent skip). PERSONAL /
  // OWNED workspaces are backed by SYSTEM containers and are exempt from
  // CUSTOMER-org lifecycle. Team.organizationId is NOT NULL in the schema, so
  // production always loads the org.
  workspaceKind: ResolvedWorkspaceKind;
  organizationStatus: string | null;
  // Active (non-revoked, non-expired) per-member capability grants.
  capabilityGrants: ReadonlyArray<{
    id: string;
    permission: string;
    expiresAtUtc: Date | null;
    revokedAtUtc: Date | null;
  }>;
  // Active delegated admin scopes.
  delegatedAdminScopes: ReadonlyArray<{
    id: string;
    scopeKind: DelegatedAdminScopeKind;
    expiresAtUtc: Date | null;
    revokedAtUtc: Date | null;
  }>;
};

export type ServiceAccountAccessSnapshot = {
  apiCredentialId: string;
  teamId: string;
  status: "ACTIVE" | "REVOKED";
  scopes: ReadonlyArray<string>;
  expiresAtUtc: Date | null;
  disabledAtUtc: Date | null;
  rotationRequired: boolean;
};

export type ContributorAccessSnapshot = {
  intakeSessionId: string;
  intakeLinkId: string;
  teamId: string;
  revokedAtUtc: Date | null;
  expiresAtUtc: Date;
};

export type ActorSnapshot =
  | { kind: "MEMBER"; member: MemberAccessSnapshot }
  | { kind: "SERVICE_ACCOUNT"; serviceAccount: ServiceAccountAccessSnapshot }
  | { kind: "CONTRIBUTOR"; contributor: ContributorAccessSnapshot };

// -----------------------------------------------------------------------------
// Decision
// -----------------------------------------------------------------------------

export type AccessDecision =
  | { allowed: true; via: AccessGrantSource }
  | { allowed: false; reason: AccessDenyReason; detail?: string };

export type AccessGrantSource =
  | { kind: "role"; role: CanonicalRole }
  | { kind: "capability_grant"; grantId: string }
  | { kind: "delegated_admin"; scope: DelegatedAdminScopeKind; scopeId: string }
  | { kind: "service_account_scope"; permission: string }
  | { kind: "contributor_session" };

export type AccessDenyReason =
  | "no_actor"
  | "member_not_active"
  | "member_access_expired"
  // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — Organization-lifecycle
  // enforcement for ORGANIZATION workspaces. An ACTIVE membership in a
  // workspace whose parent CUSTOMER Organization is missing / SUSPENDED /
  // ARCHIVED is not a valid operating context. Enforced centrally here so
  // every route that composes the canonical primitive inherits it.
  | "organization_not_active"
  // The workspace kind could not be proven (team row/fields not loaded).
  // Fail closed — never silently skip Organization lifecycle.
  | "workspace_kind_unresolved"
  | "service_account_revoked"
  | "service_account_disabled"
  | "service_account_expired"
  | "service_account_scope_missing"
  | "contributor_session_revoked"
  | "contributor_session_expired"
  | "contributor_unsupported_permission"
  | "permission_not_granted";

// -----------------------------------------------------------------------------
// Evaluation context
// -----------------------------------------------------------------------------

export type AccessEvaluationContext = {
  permission: Permission;
  // Optional resource context — surfaced only in the decision detail
  // and in the audit emission. Not consulted in this phase for the deny
  // path; governance gates (legal hold, retention freeze, public verify
  // gate) remain enforced at their original call sites and continue to
  // fire CLOSED independently of this engine.
  resourceKind?: string;
  resourceId?: string;
};

// -----------------------------------------------------------------------------
// Pure evaluator
// -----------------------------------------------------------------------------

const NOW = (): Date => new Date();

function isActiveGrant(
  grant: { expiresAtUtc: Date | null; revokedAtUtc: Date | null },
  now: Date,
): boolean {
  if (grant.revokedAtUtc !== null) return false;
  if (grant.expiresAtUtc !== null && grant.expiresAtUtc.getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

function evaluateMember(
  actor: MemberAccessSnapshot,
  permission: Permission,
  now: Date,
): AccessDecision {
  if (!teamMemberStatusGrantsAccess(actor.status)) {
    return { allowed: false, reason: "member_not_active", detail: actor.status };
  }
  if (
    actor.accessExpiresAtUtc !== null &&
    actor.accessExpiresAtUtc.getTime() <= now.getTime()
  ) {
    return { allowed: false, reason: "member_access_expired" };
  }
  // PHASE 1 (2026-07-21, corrected) — Workspace-kind + Organization-lifecycle
  // gate. FAIL CLOSED throughout; there is no "null means skip" path.
  //
  //   * UNKNOWN kind (team row/fields unprovable) → DENY.
  //   * ORGANIZATION workspace → the parent CUSTOMER Organization must be
  //     loaded AND ACTIVE. Missing org, missing/null status, SUSPENDED, or
  //     ARCHIVED all DENY.
  //   * PERSONAL / OWNED workspace → backed by an internal SYSTEM container;
  //     CUSTOMER-org lifecycle is explicitly NOT applicable → continue.
  if (actor.workspaceKind === "UNKNOWN") {
    return { allowed: false, reason: "workspace_kind_unresolved" };
  }
  if (organizationLifecycleApplies(actor.workspaceKind)) {
    if (actor.organizationStatus !== "ACTIVE") {
      return {
        allowed: false,
        reason: "organization_not_active",
        detail: actor.organizationStatus ?? "missing",
      };
    }
  }
  // 1) Canonical role floor.
  const canonical = mapTeamRoleToCanonical(actor.role);
  if (roleHasPermission(canonical, permission)) {
    return { allowed: true, via: { kind: "role", role: canonical } };
  }
  // 2) Active capability grants.
  for (const grant of actor.capabilityGrants) {
    if (!isActiveGrant(grant, now)) continue;
    if (grant.permission === permission) {
      return {
        allowed: true,
        via: { kind: "capability_grant", grantId: grant.id },
      };
    }
  }
  // 3) Active delegated admin scopes.
  for (const scope of actor.delegatedAdminScopes) {
    if (!isActiveGrant(scope, now)) continue;
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

function evaluateServiceAccount(
  actor: ServiceAccountAccessSnapshot,
  permission: Permission,
  now: Date,
): AccessDecision {
  if (actor.status === "REVOKED") {
    return { allowed: false, reason: "service_account_revoked" };
  }
  if (actor.disabledAtUtc !== null) {
    return { allowed: false, reason: "service_account_disabled" };
  }
  if (
    actor.expiresAtUtc !== null &&
    actor.expiresAtUtc.getTime() <= now.getTime()
  ) {
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

const CONTRIBUTOR_ALLOWED: ReadonlySet<Permission> = new Set<Permission>([
  "workflow.external_submission.read",
  "evidence.create",
  "evidence.update_metadata",
  "evidence.read",
  "collaboration.thread.read",
  "collaboration.message.post",
]);

function evaluateContributor(
  actor: ContributorAccessSnapshot,
  permission: Permission,
  now: Date,
): AccessDecision {
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

export function evaluateAccess(
  actor: ActorSnapshot | null,
  context: AccessEvaluationContext,
): AccessDecision {
  if (!actor) return { allowed: false, reason: "no_actor" };
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

export async function loadMemberAccessSnapshot(
  input: { teamId: string; userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<MemberAccessSnapshot | null> {
  const row = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
    include: {
      // PHASE 1 (2026-07-21, corrected) — Workspace kind + parent-Organization
      // lifecycle. `workspaceKind`/`isPersonal`/`billingPlan` drive the
      // canonical kind classification; `organization.status` drives the
      // CUSTOMER-org lifecycle gate for ORGANIZATION workspaces.
      team: {
        select: {
          isPersonal: true,
          workspaceKind: true,
          billingPlan: true,
          organization: { select: { status: true } },
        },
      },
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
  if (!row) return null;
  const team = (row as {
    team?: {
      isPersonal?: boolean;
      workspaceKind?: string | null;
      billingPlan?: string | null;
      organization?: { status?: string | null } | null;
    } | null;
  }).team;
  return {
    teamMemberId: row.id,
    teamId: row.teamId,
    userId: row.userId,
    role: row.role,
    status: row.status,
    accessExpiresAtUtc: row.accessExpiresAtUtc,
    workspaceKind: resolveWorkspaceKind({
      workspaceKind: team?.workspaceKind ?? null,
      isPersonal: team?.isPersonal ?? null,
      billingPlan: team?.billingPlan ?? null,
      teamLoaded: team != null,
    }),
    organizationStatus: team?.organization?.status ?? null,
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

export async function loadServiceAccountSnapshot(
  apiCredentialId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ServiceAccountAccessSnapshot | null> {
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
  if (!row) return null;
  return {
    apiCredentialId: row.id,
    teamId: row.teamId,
    status: row.status as "ACTIVE" | "REVOKED",
    scopes: row.scopes,
    expiresAtUtc: row.expiresAtUtc,
    disabledAtUtc: row.disabledAtUtc,
    rotationRequired: row.rotationRequired,
  };
}

export async function loadContributorSessionSnapshot(
  intakeSessionId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ContributorAccessSnapshot | null> {
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
  if (!row) return null;
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

export function recordPermissionDecision(
  input: {
    actor: ActorSnapshot | null;
    permission: Permission;
    decision: AccessDecision;
    resourceKind?: string;
    resourceId?: string;
  },
  client: PrismaClient = defaultPrisma,
): void {
  if (input.decision.allowed) return;
  const teamId =
    input.actor?.kind === "MEMBER"
      ? input.actor.member.teamId
      : input.actor?.kind === "SERVICE_ACCOUNT"
        ? input.actor.serviceAccount.teamId
        : input.actor?.kind === "CONTRIBUTOR"
          ? input.actor.contributor.teamId
          : null;
  safeEmitSecurityEvent(
    {
      teamId,
      eventType: "permission_denied",
      severity: "WARNING",
      apiCredentialId:
        input.actor?.kind === "SERVICE_ACCOUNT"
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
    },
    client,
  );
}

// -----------------------------------------------------------------------------
// One-shot convenience — load + evaluate + audit on deny.
// -----------------------------------------------------------------------------

export async function evaluateMemberAccess(
  input: {
    teamId: string;
    userId: string;
    permission: Permission;
    resourceKind?: string;
    resourceId?: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<AccessDecision> {
  const snapshot = await loadMemberAccessSnapshot(
    { teamId: input.teamId, userId: input.userId },
    client,
  );
  const actor: ActorSnapshot | null = snapshot
    ? { kind: "MEMBER", member: snapshot }
    : null;
  const decision = evaluateAccess(actor, {
    permission: input.permission,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
  });
  recordPermissionDecision(
    {
      actor,
      permission: input.permission,
      decision,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
    },
    client,
  );
  return decision;
}

// Mirror of the prismaPkg.TeamMemberStatus enum so other modules can
// reference it without importing the entire Prisma namespace.
export const TEAM_MEMBER_STATUS = prismaPkg.TeamMemberStatus;
