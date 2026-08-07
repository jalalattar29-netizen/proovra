/**
 * P2 DOMAIN REMEDIATION (2026-07-21) — canonical membership provisioning.
 *
 * ONE orchestration surface for every flow that grants organization and/or
 * workspace membership: invitation acceptance, enterprise provisioning,
 * SSO JIT, and SCIM. The two membership layers stay DISTINCT —
 *
 *   OrganizationMembership  = governance (org roles, admin surfaces)
 *   TeamMember              = operational (workspace access, switcher)
 *
 * — but are provisioned coherently through explicit intent, never inferred:
 * organization membership NEVER implies all-workspace access, and a
 * workspace grant is always an explicit `{ teamId, role }` assignment
 * validated against the organization that owns the team.
 *
 * Every function takes the ACTIVE transaction/client so callers control
 * atomicity, and every grant is idempotent (upsert semantics).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  setManagedIdentity,
  type ManagedIdentityEvidence,
} from "./identity-mode.service.js";
import { organizationIdForPolicy } from "./org-security-policy.service.js";
// ARCH-004 — the ONE lifecycle authority for governance membership. This
// module composes it; it does not reimplement any transition.
import {
  revokeOrganizationMembership,
  type OrgMembershipStatusSource,
} from "./org-membership-lifecycle.service.js";
// PHASE 12 REMEDIATION §4.4 (2026-08-06) — ONE pointer-hygiene authority,
// invoked at every leg of this module that withdraws ACTIVE workspace
// membership (individual, SCIM/group deprovision, and workspace-wide mass
// suspension / revocation). HYGIENE ONLY — the pointer authorizes nothing.
import { repairStaleCurrentWorkspacePointers } from "../access/current-workspace-pointer.js";
import { resolveCommercialContext } from "../billing/commercial-context.service.js";

export type TxClient = Prisma.TransactionClient | PrismaClient;

// ─────────────────────────────────────────────────────────────────────────────
// WAVE A FINAL CLOSURE (2026-07-22) — rbac SUBORDINATION.
//
// The rbac member-transition engine (suspend/revoke/restore/role-change +
// capability/delegated-admin grants) is INTERNAL to the Membership
// Orchestrator: production callers reach it ONLY through this module's public
// command surface. These are pure re-exports — ZERO duplicated transition
// policy (single implementation, OWNER-safety + hash-chained audit preserved
// in the engine). The program architecture registry locks the
// `identity/rbac.service` import path to THIS module, so a new direct
// production importer fails the suite.
// ─────────────────────────────────────────────────────────────────────────────
export {
  RbacError,
  suspendMember,
  revokeMember,
  restoreMember,
  changeMemberRole,
  grantCapability,
  revokeCapability,
  grantDelegatedAdminScope,
  revokeDelegatedAdminScope,
  listTeamMembersWithAccess,
} from "./rbac.service.js";

// =============================================================================
// PHASE 3 (2026-07-21) — canonical provisioning intents + grant sources.
// =============================================================================

/**
 * Every membership mutation in the system flows through one of these
 * intents. Each intent defines WHICH membership layers it writes (see
 * `provisionMembership`) — an intent never writes a layer it does not own.
 */
export const MEMBERSHIP_INTENTS = [
  "PERSONAL_BOOTSTRAP",
  "OWNED_WORKSPACE_OWNER",
  "OWNED_WORKSPACE_INVITE",
  "ENTERPRISE_FIRST_OWNER",
  "ORGANIZATION_GOVERNANCE_ONLY",
  "ORGANIZATION_WITH_WORKSPACE_ASSIGNMENTS",
  "WORKSPACE_DIRECT_INVITE",
  "SSO_JIT",
  "SCIM_PROVISIONING",
  "GROUP_MAPPING",
  "ADMIN_ASSIGNMENT",
  "MEMBER_REACTIVATION",
  "MEMBER_SUSPENSION",
  "MEMBER_REVOCATION",
] as const;
export type MembershipIntent = (typeof MEMBERSHIP_INTENTS)[number];

export const MEMBERSHIP_GRANT_SOURCES = [
  "MANUAL",
  "INVITATION",
  "SSO_JIT",
  "SCIM",
  "IDP_GROUP",
  "ENTERPRISE_BOOTSTRAP",
  "SELF_SERVICE_OWNER",
  "SYSTEM_REPAIR",
  // Backfilled marker for pre-provenance memberships — historical source
  // unprovable; only explicit manual revocation removes it (§1 policy).
  "LEGACY_UNKNOWN",
] as const;
export type MembershipGrantSourceValue =
  (typeof MEMBERSHIP_GRANT_SOURCES)[number];

/**
 * Deterministic role precedence (§6.3). Protected roles are never
 * overwritten by automated sources:
 *   * ORG_OWNER / workspace OWNER can only be changed by MANUAL /
 *     ENTERPRISE_BOOTSTRAP / SYSTEM_REPAIR;
 *   * an INVITATION / SCIM / IDP_GROUP / SSO_JIT source NEVER demotes an
 *     existing role and NEVER escalates to OWNER-tier;
 *   * reactivation restores the HELD role (the membership row keeps its
 *     role across suspension — nothing here rewrites it).
 * Returns the role that must remain on the membership row.
 */
export function resolveRolePrecedence(input: {
  existingRole: string | null;
  incomingRole: string;
  source: MembershipGrantSourceValue;
  ownerRoleName: string; // "OWNER" (workspace) or "ORG_OWNER" (org)
}): string {
  const { existingRole, incomingRole, source, ownerRoleName } = input;
  if (existingRole === null) {
    // New membership: automated sources cannot mint owner-tier.
    const automated =
      source === "INVITATION" ||
      source === "SCIM" ||
      source === "IDP_GROUP" ||
      source === "SSO_JIT";
    if (automated && incomingRole === ownerRoleName) {
      return ownerRoleName === "ORG_OWNER" ? "ORG_MEMBER" : "MEMBER";
    }
    return incomingRole;
  }
  // Existing membership: protected owner role only changes via trusted
  // sources; automated sources never change a held role at all.
  if (source === "MANUAL" || source === "ENTERPRISE_BOOTSTRAP" || source === "SYSTEM_REPAIR") {
    return incomingRole;
  }
  return existingRole;
}

/**
 * Record grant provenance. MIGRATION-WINDOW SAFE: if the
 * `membership_grants` table has not been applied on this environment yet
 * (Prisma P2021), the write is skipped — provenance begins accruing once
 * the migration lands. Never throws into the caller's transaction for the
 * missing-table case; every other failure propagates (a provenance write
 * that fails for a real reason must fail the transaction).
 */
export async function recordMembershipGrant(
  tx: TxClient,
  input: {
    teamMemberId?: string | null;
    organizationMembershipId?: string | null;
    source: MembershipGrantSourceValue;
    intent: MembershipIntent;
    grantedByUserId?: string | null;
    externalRef?: string | null;
    grantedRole?: string | null;
  },
): Promise<void> {
  // Legacy injected fakes (tests, tools) may not model membershipGrant at
  // all — provenance is additive, so an absent delegate is a no-op.
  const grantDelegate = (tx as { membershipGrant?: unknown }).membershipGrant;
  if (!grantDelegate) return;
  try {
    await tx.membershipGrant.create({
      data: {
        teamMemberId: input.teamMemberId ?? null,
        organizationMembershipId: input.organizationMembershipId ?? null,
        source: input.source,
        intent: input.intent,
        grantedByUserId: input.grantedByUserId ?? null,
        externalRef: input.externalRef ?? null,
        grantedRole: input.grantedRole ?? null,
      },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2021" || code === "P2022") return; // migration not applied yet
    throw err;
  }
}

/**
 * Source-aware revocation (§6.2). Revokes the grant rows for `source` on
 * the given workspace membership; the membership itself is REVOKED only
 * when no other active grant remains.
 *
 * LEGACY / MIGRATION-WINDOW POLICY (explicit — never guess provenance):
 *   * Memberships with ZERO grant rows (pre-provenance, backfill not yet
 *     applied) have UNKNOWN historical sources. Source-scoped revocation
 *     must NOT permanently delete access whose provenance is unprovable —
 *     the membership is SUSPENDED instead (access stops immediately, the
 *     row is reversible, and an operator can review), and
 *     `legacyProvenanceUnknown: true` is returned.
 *   * After the 20270920250000_membership_grant_legacy_backfill backfill every such row carries one
 *     LEGACY_UNKNOWN grant, which this function treats as "another source
 *     remains" — removable only by explicit manual revocation
 *     (`revokeAllMembershipGrants` via the rbac revoke path).
 */
export async function revokeWorkspaceMembershipSource(
  tx: TxClient,
  input: {
    teamMemberId: string;
    source: MembershipGrantSourceValue;
    actorUserId?: string | null;
    reason: string;
  },
): Promise<{
  membershipRevoked: boolean;
  otherSourcesRemain: boolean;
  legacyProvenanceUnknown?: boolean;
}> {
  let hadGrantRows = false;
  let othersRemain = false;
  const grantDelegateR = (tx as { membershipGrant?: unknown }).membershipGrant;
  try {
    if (!grantDelegateR) throw Object.assign(new Error("no delegate"), { code: "P2021" });
    const grants = await tx.membershipGrant.findMany({
      where: { teamMemberId: input.teamMemberId, revokedAtUtc: null },
      select: { id: true, source: true },
    });
    hadGrantRows = grants.length > 0;
    // A LEGACY_UNKNOWN grant can never be source-revoked.
    const toRevoke = grants.filter(
      (g) => g.source === input.source && g.source !== "LEGACY_UNKNOWN",
    );
    othersRemain = grants.some((g) => g.source !== input.source);
    if (toRevoke.length > 0) {
      await tx.membershipGrant.updateMany({
        where: { id: { in: toRevoke.map((g) => g.id) } },
        data: {
          revokedAtUtc: new Date(),
          revokedByUserId: input.actorUserId ?? null,
        },
      });
    }
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "P2021" && code !== "P2022") throw err;
    // Provenance table not applied yet — fall through to the zero-grant
    // (unknown-provenance) branch below.
  }
  if (hadGrantRows && othersRemain) {
    // Another valid source still grants this access — membership stays.
    return { membershipRevoked: false, otherSourcesRemain: true };
  }
  if (!hadGrantRows) {
    // UNKNOWN historical provenance: suspend (reversible), never revoke.
    const suspendedRow = await tx.teamMember.update({
      where: { id: input.teamMemberId },
      data: {
        status: "SUSPENDED",
        suspendedAtUtc: new Date(),
        suspendedByUserId: input.actorUserId ?? null,
        suspensionReason:
          `${input.reason} (legacy provenance unknown — suspended, not revoked)`.slice(0, 400),
      },
    });
    // §4.4 — a SUSPENDED membership is an inaccessible context; clear a
    // pointer that names it (same transaction, NULL only).
    await repairStaleCurrentWorkspacePointers(
      {
        memberships: [
          {
            userId: suspendedRow.userId,
            workspaceId: suspendedRow.teamId,
          },
        ],
      },
      tx as never,
    );
    return {
      membershipRevoked: false,
      otherSourcesRemain: false,
      legacyProvenanceUnknown: true,
    };
  }
  const revokedRow = await tx.teamMember.update({
    where: { id: input.teamMemberId },
    data: {
      status: "REVOKED",
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId ?? null,
      revocationReason: input.reason.slice(0, 400),
    },
  });
  // §4.4 — same hygiene on the revocation leg. The updated row already
  // carries the pair, so no extra read is issued.
  await repairStaleCurrentWorkspacePointers(
    {
      memberships: [
        { userId: revokedRow.userId, workspaceId: revokedRow.teamId },
      ],
    },
    tx as never,
  );
  return { membershipRevoked: true, otherSourcesRemain: false };
}

export const WORKSPACE_ASSIGNMENT_ROLES = [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "VIEWER",
] as const;
export type WorkspaceAssignmentRole =
  (typeof WORKSPACE_ASSIGNMENT_ROLES)[number];

export type WorkspaceAssignment = {
  teamId: string;
  role: WorkspaceAssignmentRole;
};

/**
 * Parse + bound an untrusted `workspaceAssignments` JSON payload (from an
 * invite row or request body). Fail-closed: anything malformed yields an
 * error rather than a silently-narrowed grant. Max 20 assignments.
 */
export function parseWorkspaceAssignments(
  raw: unknown,
): { ok: true; assignments: WorkspaceAssignment[] } | { ok: false } {
  if (raw == null) return { ok: true, assignments: [] };
  if (!Array.isArray(raw) || raw.length > 20) return { ok: false };
  const out: WorkspaceAssignment[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false };
    const teamId = (entry as { teamId?: unknown }).teamId;
    const role = (entry as { role?: unknown }).role;
    if (typeof teamId !== "string" || !/^[0-9a-f-]{36}$/i.test(teamId)) {
      return { ok: false };
    }
    if (
      typeof role !== "string" ||
      !(WORKSPACE_ASSIGNMENT_ROLES as readonly string[]).includes(role)
    ) {
      return { ok: false };
    }
    if (seen.has(teamId)) continue; // dedupe, first wins
    seen.add(teamId);
    out.push({ teamId, role: role as WorkspaceAssignmentRole });
  }
  return { ok: true, assignments: out };
}

/**
 * Idempotently grant governance membership. Returns whether a row was
 * created (false = already a member; the existing role is preserved —
 * invitations never silently demote/promote an existing member).
 */
export async function grantOrganizationMembership(
  tx: TxClient,
  input: {
    organizationId: string;
    userId: string;
    role: string;
    // PHASE 3 — provenance (defaults preserve pre-Phase-3 call sites).
    source?: MembershipGrantSourceValue;
    intent?: MembershipIntent;
    actorUserId?: string | null;
    externalRef?: string | null;
  },
): Promise<{ created: boolean }> {
  const existing = await tx.organizationMembership.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId },
    select: { id: true },
  });
  if (existing) {
    // Existing member: record the additional grant source (source-aware
    // revocation needs it) but never touch the held role here.
    await recordMembershipGrant(tx, {
      organizationMembershipId: existing.id,
      source: input.source ?? "INVITATION",
      intent: input.intent ?? "ORGANIZATION_GOVERNANCE_ONLY",
      grantedByUserId: input.actorUserId ?? null,
      externalRef: input.externalRef ?? null,
      grantedRole: null,
    });
    return { created: false };
  }
  const created = await tx.organizationMembership.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role as never,
    },
    select: { id: true },
  });
  await recordMembershipGrant(tx, {
    organizationMembershipId: created.id,
    source: input.source ?? "INVITATION",
    intent: input.intent ?? "ORGANIZATION_GOVERNANCE_ONLY",
    grantedByUserId: input.actorUserId ?? null,
    externalRef: input.externalRef ?? null,
    grantedRole: input.role,
  });
  return { created: true };
}

/**
 * Idempotently grant OPERATIONAL workspace membership for an explicit
 * assignment. The team MUST belong to `organizationId` (validated here —
 * fail-closed) and must not be a personal space. Re-granting an existing
 * membership re-activates it at the already-held role (never demotes an
 * OWNER/ADMIN via an invite assignment).
 */
export async function grantWorkspaceMembership(
  tx: TxClient,
  input: {
    organizationId: string;
    userId: string;
    assignment: WorkspaceAssignment;
    accessReason: string;
    grantedByUserId?: string | null;
    // PHASE 3 — provenance (defaults preserve pre-Phase-3 call sites).
    source?: MembershipGrantSourceValue;
    intent?: MembershipIntent;
    externalRef?: string | null;
  },
): Promise<
  | { ok: true }
  | { ok: false; reason: "team_not_in_organization" | "team_is_personal" }
> {
  const team = await tx.team.findUnique({
    where: { id: input.assignment.teamId },
    select: { organizationId: true, isPersonal: true },
  });
  if (!team || team.organizationId !== input.organizationId) {
    return { ok: false, reason: "team_not_in_organization" };
  }
  if (team.isPersonal) {
    return { ok: false, reason: "team_is_personal" };
  }
  const row = await tx.teamMember.upsert({
    where: {
      teamId_userId: {
        teamId: input.assignment.teamId,
        userId: input.userId,
      },
    },
    // Existing row: re-activate, keep the held role (no invite-driven
    // demotion), clear suspension bookkeeping.
    update: {
      status: "ACTIVE",
      suspendedAtUtc: null,
      suspensionReason: null,
    },
    create: {
      teamId: input.assignment.teamId,
      userId: input.userId,
      role: input.assignment.role as never,
      status: "ACTIVE",
      accessReason: input.accessReason,
      ...(input.grantedByUserId
        ? { accessGrantedByUserId: input.grantedByUserId }
        : {}),
    },
    select: { id: true },
  });
  // PHASE 3 — provenance for the assignment source.
  await recordMembershipGrant(tx, {
    teamMemberId: row.id,
    source: input.source ?? "INVITATION",
    intent: input.intent ?? "ORGANIZATION_WITH_WORKSPACE_ASSIGNMENTS",
    grantedByUserId: input.grantedByUserId ?? null,
    externalRef: input.externalRef ?? null,
    grantedRole: input.assignment.role,
  });
  return { ok: true };
}

// =============================================================================
// PHASE 3 — lifecycle transitions (suspension / reactivation) + the
// canonical `provisionMembership` entry point.
// =============================================================================

/**
 * Revoke ALL active grant rows for a membership (manual admin revocation
 * overrides every source — an admin's explicit revoke is authoritative).
 * MIGRATION-WINDOW SAFE (P2021/P2022 skip).
 */
export async function revokeAllMembershipGrants(
  tx: TxClient,
  input: { teamMemberId: string; actorUserId?: string | null },
): Promise<void> {
  const grantDelegateA = (tx as { membershipGrant?: unknown }).membershipGrant;
  if (!grantDelegateA) return;
  try {
    await tx.membershipGrant.updateMany({
      where: { teamMemberId: input.teamMemberId, revokedAtUtc: null },
      data: {
        revokedAtUtc: new Date(),
        revokedByUserId: input.actorUserId ?? null,
      },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "P2021" && code !== "P2022") throw err;
  }
}

/** Suspend an operational membership (held role preserved for reactivation). */
export async function suspendWorkspaceMembership(
  tx: TxClient,
  input: {
    teamMemberId: string;
    actorUserId?: string | null;
    reason: string;
  },
): Promise<void> {
  const suspended = await tx.teamMember.update({
    where: { id: input.teamMemberId },
    data: {
      status: "SUSPENDED",
      suspendedAtUtc: new Date(),
      suspendedByUserId: input.actorUserId ?? null,
      suspensionReason: input.reason.slice(0, 400),
    },
  });
  // §4.4 — pointer hygiene at the suspension boundary, from the row the
  // update already returned.
  await repairStaleCurrentWorkspacePointers(
    {
      memberships: [
        { userId: suspended.userId, workspaceId: suspended.teamId },
      ],
    },
    tx as never,
  );
}

/**
 * Reactivate a suspended membership. The HELD role is restored implicitly —
 * suspension never rewrote it — and revocation bookkeeping is cleared only
 * for a SUSPENDED row (a REVOKED row requires an explicit re-grant through
 * a provisioning intent, never a silent reactivation).
 */
export async function reactivateWorkspaceMembership(
  tx: TxClient,
  input: { teamMemberId: string; actorUserId?: string | null },
): Promise<{ ok: boolean; reason?: "not_suspended" }> {
  const row = await tx.teamMember.findUnique({
    where: { id: input.teamMemberId },
    select: { status: true },
  });
  if (!row || row.status !== "SUSPENDED") {
    return { ok: false, reason: "not_suspended" };
  }
  await tx.teamMember.update({
    where: { id: input.teamMemberId },
    data: {
      status: "ACTIVE",
      suspendedAtUtc: null,
      suspendedByUserId: null,
      suspensionReason: null,
    },
  });
  await recordMembershipGrant(tx, {
    teamMemberId: input.teamMemberId,
    source: "MANUAL",
    intent: "MEMBER_REACTIVATION",
    grantedByUserId: input.actorUserId ?? null,
  });
  return { ok: true };
}

/**
 * PHASE 3 — the canonical provisioning entry point. Dispatches per intent;
 * an intent writes ONLY the membership layer(s) it owns:
 *
 *   PERSONAL_BOOTSTRAP / OWNED_WORKSPACE_OWNER / OWNED_WORKSPACE_INVITE /
 *   WORKSPACE_DIRECT_INVITE / SSO_JIT-workspace  → workspace layer only
 *   ORGANIZATION_GOVERNANCE_ONLY                 → org layer only
 *   ENTERPRISE_FIRST_OWNER /
 *   ORGANIZATION_WITH_WORKSPACE_ASSIGNMENTS /
 *   SCIM_PROVISIONING / GROUP_MAPPING            → org layer + explicit
 *                                                  workspace assignments
 *
 * Callers own the transaction. Personal/owned direct workspace grants skip
 * the org-binding validation (their SYSTEM container is implicit); every
 * ORGANIZATION-workspace assignment is validated against the owning org.
 */
export async function provisionMembership(
  tx: TxClient,
  input: {
    intent: MembershipIntent;
    source: MembershipGrantSourceValue;
    userId: string;
    organizationId?: string | null;
    organizationRole?: string | null;
    /** Direct workspace grant (personal/owned/direct-invite intents). */
    workspace?: { teamId: string; role: WorkspaceAssignmentRole } | null;
    /** Org-validated workspace assignments (org-scoped intents). */
    workspaceAssignments?: ReadonlyArray<WorkspaceAssignment>;
    actorUserId?: string | null;
    externalRef?: string | null;
    accessReason?: string;
    /**
     * When true the direct-workspace grant does NOT change the status of an
     * existing membership row (provenance only). REQUIRED for SSO_JIT: a
     * login must never silently reactivate a SUSPENDED/REVOKED member —
     * only an authoritative provisioning source (SCIM/manual) may.
     */
    preserveExistingStatus?: boolean;
  },
): Promise<{
  organizationMembershipCreated: boolean;
  workspaceGrants: number;
  failedAssignments: Array<{ teamId: string; reason: string }>;
}> {
  const result = {
    organizationMembershipCreated: false,
    workspaceGrants: 0,
    failedAssignments: [] as Array<{ teamId: string; reason: string }>,
  };

  // Intents that ALWAYS write the governance layer (organizationId required).
  const strictOrgIntents: ReadonlyArray<MembershipIntent> = [
    "ENTERPRISE_FIRST_OWNER",
    "ORGANIZATION_GOVERNANCE_ONLY",
    "ORGANIZATION_WITH_WORKSPACE_ASSIGNMENTS",
  ];
  // Intents that write the governance layer ONLY when an organization scope
  // is provided — SCIM/group-mapping deployments may be workspace-scoped
  // (ScimProvisioningToken.teamId) with no organization dimension.
  const optionalOrgIntents: ReadonlyArray<MembershipIntent> = [
    "SCIM_PROVISIONING",
    "GROUP_MAPPING",
  ];
  const writesOrgLayer =
    strictOrgIntents.includes(input.intent) ||
    (optionalOrgIntents.includes(input.intent) && Boolean(input.organizationId));

  // ---- Governance layer -----------------------------------------------
  if (writesOrgLayer) {
    if (!input.organizationId) {
      throw new Error(`intent ${input.intent} requires organizationId`);
    }
    const existing = await tx.organizationMembership.findFirst({
      where: { organizationId: input.organizationId, userId: input.userId },
      select: { id: true, role: true },
    });
    const desiredRole = resolveRolePrecedence({
      existingRole: existing?.role ?? null,
      incomingRole: input.organizationRole ?? "ORG_MEMBER",
      source: input.source,
      ownerRoleName: "ORG_OWNER",
    });
    let orgMembershipId: string;
    if (existing) {
      orgMembershipId = existing.id;
      if (existing.role !== desiredRole) {
        await tx.organizationMembership.update({
          where: { id: existing.id },
          data: { role: desiredRole as never },
        });
      }
    } else {
      const created = await tx.organizationMembership.create({
        data: {
          organizationId: input.organizationId,
          userId: input.userId,
          role: desiredRole as never,
        },
        select: { id: true },
      });
      orgMembershipId = created.id;
      result.organizationMembershipCreated = true;
    }
    await recordMembershipGrant(tx, {
      organizationMembershipId: orgMembershipId,
      source: input.source,
      intent: input.intent,
      grantedByUserId: input.actorUserId ?? null,
      externalRef: input.externalRef ?? null,
      grantedRole: desiredRole,
    });
  }

  // ---- Operational layer: org-validated assignments -------------------
  for (const assignment of input.workspaceAssignments ?? []) {
    if (!input.organizationId) {
      result.failedAssignments.push({
        teamId: assignment.teamId,
        reason: "missing_organization",
      });
      continue;
    }
    const granted = await grantWorkspaceMembership(tx, {
      organizationId: input.organizationId,
      userId: input.userId,
      assignment,
      accessReason: input.accessReason ?? `intent:${input.intent}`,
      grantedByUserId: input.actorUserId ?? null,
      source: input.source,
      intent: input.intent,
      externalRef: input.externalRef ?? null,
    });
    if (granted.ok) result.workspaceGrants += 1;
    else
      result.failedAssignments.push({
        teamId: assignment.teamId,
        reason: granted.reason,
      });
  }

  // ---- Operational layer: direct workspace grant ----------------------
  if (input.workspace) {
    const existing = await tx.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: input.workspace.teamId,
          userId: input.userId,
        },
      },
      select: { id: true, role: true },
    });
    const desiredRole = resolveRolePrecedence({
      existingRole: existing?.role ?? null,
      incomingRole: input.workspace.role,
      source: input.source,
      ownerRoleName: "OWNER",
    });
    const row = await tx.teamMember.upsert({
      where: {
        teamId_userId: {
          teamId: input.workspace.teamId,
          userId: input.userId,
        },
      },
      update: input.preserveExistingStatus
        ? {}
        : {
            status: "ACTIVE",
            suspendedAtUtc: null,
            suspensionReason: null,
          },
      create: {
        teamId: input.workspace.teamId,
        userId: input.userId,
        role: desiredRole as never,
        status: "ACTIVE",
        accessReason: (input.accessReason ?? `intent:${input.intent}`).slice(0, 400),
        ...(input.actorUserId
          ? { accessGrantedByUserId: input.actorUserId }
          : {}),
      },
      select: { id: true },
    });
    await recordMembershipGrant(tx, {
      teamMemberId: row.id,
      source: input.source,
      intent: input.intent,
      grantedByUserId: input.actorUserId ?? null,
      externalRef: input.externalRef ?? null,
      grantedRole: desiredRole,
    });
    result.workspaceGrants += 1;
  }

  return result;
}

// =============================================================================
// PHASE 3 completion (2026-07-22) — canonical system/mass mutation surface.
// Every residual direct writer migrates onto these; no production membership
// mutation exists outside this module + the documented rbac MANUAL surface.
// =============================================================================

/** Close every active grant row for a set of workspace memberships. */
async function closeGrantsForTeamMembers(
  tx: TxClient,
  teamMemberIds: string[],
  actorUserId: string | null,
): Promise<void> {
  if (teamMemberIds.length === 0) return;
  const grantDelegate = (tx as { membershipGrant?: unknown }).membershipGrant;
  if (!grantDelegate) return;
  try {
    await tx.membershipGrant.updateMany({
      where: { teamMemberId: { in: teamMemberIds }, revokedAtUtc: null },
      data: { revokedAtUtc: new Date(), revokedByUserId: actorUserId },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "P2021" && code !== "P2022") throw err;
  }
}

/** Close every active grant row for a set of governance memberships. */
async function closeGrantsForOrgMemberships(
  tx: TxClient,
  organizationMembershipIds: string[],
  actorUserId: string | null,
): Promise<void> {
  if (organizationMembershipIds.length === 0) return;
  const grantDelegate = (tx as { membershipGrant?: unknown }).membershipGrant;
  if (!grantDelegate) return;
  try {
    await tx.membershipGrant.updateMany({
      where: {
        organizationMembershipId: { in: organizationMembershipIds },
        revokedAtUtc: null,
      },
      data: { revokedAtUtc: new Date(), revokedByUserId: actorUserId },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "P2021" && code !== "P2022") throw err;
  }
}

/**
 * Directory-driven role change (SCIM PATCH / IdP group add-remove / SCIM
 * reconciliation). Guards: never assigns OWNER-tier, and never changes an
 * OWNER/ADMIN-held row unless `allowPrivilegedChange` (used only by flows
 * whose inline guards already excluded privileged rows). Records SCIM /
 * IDP_GROUP provenance. Returns whether the role changed.
 */
export async function applyDirectoryRoleChange(
  tx: TxClient,
  input: {
    teamMemberId: string;
    currentRole: string;
    desiredRole: string;
    source: Extract<MembershipGrantSourceValue, "SCIM" | "IDP_GROUP">;
    externalRef?: string | null;
    allowPrivilegedChange?: boolean;
  },
): Promise<{ changed: boolean }> {
  if (input.desiredRole === "OWNER") return { changed: false };
  if (
    !input.allowPrivilegedChange &&
    (input.currentRole === "OWNER" || input.currentRole === "ADMIN")
  ) {
    return { changed: false };
  }
  if (input.currentRole === input.desiredRole) return { changed: false };
  await tx.teamMember.update({
    where: { id: input.teamMemberId },
    data: { role: input.desiredRole as never },
  });
  await recordMembershipGrant(tx, {
    teamMemberId: input.teamMemberId,
    source: input.source,
    intent: input.source === "SCIM" ? "SCIM_PROVISIONING" : "GROUP_MAPPING",
    externalRef: input.externalRef ?? null,
    grantedRole: input.desiredRole,
  });
  return { changed: true };
}

/**
 * Bulk demotion when an IdP group mapping is archived: every ACTIVE member
 * currently holding the mapped role is demoted to MEMBER (conservative
 * default — preserves access, sheds the mapped privilege). Provenance per
 * affected member.
 */
export async function demoteGroupMappedRoleOnArchive(
  tx: TxClient,
  input: { teamId: string; mappedRole: string; externalRef?: string | null },
): Promise<{ count: number }> {
  const affected = await tx.teamMember.findMany({
    where: {
      teamId: input.teamId,
      role: input.mappedRole as never,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (affected.length === 0) return { count: 0 };
  await tx.teamMember.updateMany({
    where: { id: { in: affected.map((m) => m.id) } },
    data: { role: "MEMBER" },
  });
  for (const m of affected) {
    await recordMembershipGrant(tx, {
      teamMemberId: m.id,
      source: "IDP_GROUP",
      intent: "GROUP_MAPPING",
      externalRef: input.externalRef ?? null,
      grantedRole: "MEMBER",
    });
  }
  return { count: affected.length };
}

/** Manual (workspace-admin) role change with provenance. */
export async function updateWorkspaceMembershipRole(
  tx: TxClient,
  input: { teamMemberId: string; role: string; actorUserId?: string | null },
): Promise<void> {
  await tx.teamMember.update({
    where: { id: input.teamMemberId },
    data: { role: input.role as never },
  });
  await recordMembershipGrant(tx, {
    teamMemberId: input.teamMemberId,
    source: "MANUAL",
    intent: "ADMIN_ASSIGNMENT",
    grantedByUserId: input.actorUserId ?? null,
    grantedRole: input.role,
  });
}

/** Manual (org-admin) governance role change with provenance. */
export async function updateOrganizationMembershipRole(
  tx: TxClient,
  input: {
    organizationMembershipId: string;
    role: string;
    actorUserId?: string | null;
    source?: MembershipGrantSourceValue;
  },
): Promise<void> {
  await tx.organizationMembership.update({
    where: { id: input.organizationMembershipId },
    data: { role: input.role as never },
  });
  await recordMembershipGrant(tx, {
    organizationMembershipId: input.organizationMembershipId,
    source: input.source ?? "MANUAL",
    intent: "ADMIN_ASSIGNMENT",
    grantedByUserId: input.actorUserId ?? null,
    grantedRole: input.role,
  });
}

/**
 * Governance-membership removal (admin removal / self-leave).
 *
 * PHASE 12 CORRECTIVE PASS §2 (ARCH-004, 2026-08-07) — REVOKE, DO NOT DELETE.
 *
 * This used to close the provenance grants and then DELETE the membership row,
 * on the reasoning that "closed grant rows preserve the historical provenance
 * trail". They preserve the GRANT trail — but not the membership, so the
 * system could not answer "was this person a member, who removed them, when,
 * and why?" from the membership itself, and there was no reversible pause at
 * all.
 *
 * The grants are still closed, in the same order and for the same reason. What
 * changed is the second step: the row now transitions to REVOKED through the
 * canonical orchestrator, which stamps the actor, the time, the reason and the
 * provenance, emits the audit event, and fences the transition against a
 * concurrent one. A REVOKED membership grants nothing —
 * `organizationMembershipGrantsAccess` is the one predicate that decides that
 * — but it can be read.
 *
 * Physical deletion survives in exactly one place, `removeAllOrganization
 * MembershipsForUser`, which serves account closure/erasure. That is a
 * different obligation and is not this function.
 */
export async function removeOrganizationMembership(
  tx: TxClient,
  input: {
    organizationMembershipId: string;
    actorUserId?: string | null;
    /** Bounded provenance. Defaults to a manual administrative action. */
    source?: OrgMembershipStatusSource;
    reason?: string | null;
  },
): Promise<void> {
  await closeGrantsForOrgMemberships(
    tx,
    [input.organizationMembershipId],
    input.actorUserId ?? null,
  );
  // The orchestrator needs the Organization id to scope its guarded UPDATE —
  // a transition must never be addressable by membership id alone, or a
  // caller holding an id from another tenant could move it.
  const row = await tx.organizationMembership.findUnique({
    where: { id: input.organizationMembershipId },
    select: { organizationId: true },
  });
  if (!row) return;
  await revokeOrganizationMembership({
    prisma: tx as unknown as Parameters<typeof revokeOrganizationMembership>[0]["prisma"],
    organizationId: row.organizationId,
    membershipId: input.organizationMembershipId,
    actorUserId: input.actorUserId ?? null,
    source: input.source ?? "MANUAL",
    reason: input.reason ?? null,
  });
}

/**
 * Workspace-membership physical removal (legacy-compat admin removal).
 * Closes provenance first, then deletes.
 */
export async function removeWorkspaceMembershipPhysical(
  tx: TxClient,
  input: { teamMemberId: string; actorUserId?: string | null },
): Promise<void> {
  await closeGrantsForTeamMembers(
    tx,
    [input.teamMemberId],
    input.actorUserId ?? null,
  );
  await tx.teamMember.delete({ where: { id: input.teamMemberId } });
}

/**
 * Mass revocation for lifecycle closures (workspace close, organization
 * close, account close, admin off-board across an organization's teams).
 * REVOKES (never erases) every matching ACTIVE membership, closes their
 * provenance, and records the closure reason. Idempotent: already-revoked
 * rows are untouched.
 */
export async function massRevokeWorkspaceMemberships(
  tx: TxClient,
  input: {
    where: { userId?: string; teamId?: string; teamIds?: string[] };
    actorUserId?: string | null;
    reason: string;
  },
): Promise<{ count: number }> {
  const memberWhere = {
    status: "ACTIVE" as const,
    ...(input.where.userId ? { userId: input.where.userId } : {}),
    ...(input.where.teamId ? { teamId: input.where.teamId } : {}),
    ...(input.where.teamIds ? { teamId: { in: input.where.teamIds } } : {}),
  };
  // §4.4 — `userId`/`teamId` are selected alongside `id` so pointer
  // hygiene below issues NO additional read.
  const affected = await tx.teamMember.findMany({
    where: memberWhere,
    select: { id: true, userId: true, teamId: true },
  });
  if (affected.length === 0) return { count: 0 };
  await tx.teamMember.updateMany({
    where: { id: { in: affected.map((m) => m.id) } },
    data: {
      status: "REVOKED",
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId ?? null,
      revocationReason: input.reason.slice(0, 400),
    },
  });
  await closeGrantsForTeamMembers(
    tx,
    affected.map((m) => m.id),
    input.actorUserId ?? null,
  );
  // §4.4 — SCIM deprovision / administrative mass revocation. Every affected
  // member loses this workspace, so every pointer naming it is cleared in
  // the same transaction.
  await repairStaleCurrentWorkspacePointers(
    {
      memberships: affected.map((m) => ({
        userId: m.userId,
        workspaceId: m.teamId,
      })),
    },
    tx as never,
  );
  return { count: affected.length };
}

/**
 * Account closure: remove every governance membership for the user
 * (provenance closed first).
 */
export async function removeAllOrganizationMembershipsForUser(
  tx: TxClient,
  input: { userId: string; actorUserId?: string | null },
): Promise<void> {
  const memberships = await tx.organizationMembership.findMany({
    where: { userId: input.userId },
    select: { id: true },
  });
  await closeGrantsForOrgMemberships(
    tx,
    memberships.map((m) => m.id),
    input.actorUserId ?? null,
  );
  await tx.organizationMembership.deleteMany({
    where: { userId: input.userId },
  });
}

// =============================================================================
// PHASE 4 §7.4 (2026-07-22) — owned-workspace lifecycle membership legs.
// These are the ONLY sanctioned mutation paths for ownership transfer and
// workspace reopen; rbac.changeMemberRole intentionally refuses OWNER
// transitions (`role_transition_to_owner_forbidden`) so this primitive is
// the single place an OWNER role can move between users.
// =============================================================================

/**
 * Ownership transfer, membership legs only (the caller owns the Team-row
 * `ownerUserId`/`billingOwnerUserId` swap in the SAME transaction):
 * promote the target's ACTIVE membership to OWNER and demote the prior
 * owner's membership to ADMIN, both with MANUAL provenance. Fails closed
 * when the target is not an ACTIVE member — ownership never lands on a
 * suspended/revoked/absent membership.
 */
export async function transferWorkspaceOwnerRoles(
  tx: TxClient,
  input: {
    teamId: string;
    fromUserId: string;
    toUserId: string;
    actorUserId?: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: "target_not_active_member" }> {
  const target = await tx.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.teamId, userId: input.toUserId } },
    select: { id: true, status: true },
  });
  if (!target || target.status !== "ACTIVE") {
    return { ok: false, reason: "target_not_active_member" };
  }
  await tx.teamMember.update({
    where: { id: target.id },
    data: { role: "OWNER" },
  });
  await recordMembershipGrant(tx, {
    teamMemberId: target.id,
    source: "MANUAL",
    intent: "OWNED_WORKSPACE_OWNER",
    grantedByUserId: input.actorUserId ?? null,
    grantedRole: "OWNER",
  });
  const prior = await tx.teamMember.findUnique({
    where: {
      teamId_userId: { teamId: input.teamId, userId: input.fromUserId },
    },
    select: { id: true },
  });
  if (prior) {
    await tx.teamMember.update({
      where: { id: prior.id },
      data: { role: "ADMIN" },
    });
    await recordMembershipGrant(tx, {
      teamMemberId: prior.id,
      source: "MANUAL",
      intent: "ADMIN_ASSIGNMENT",
      grantedByUserId: input.actorUserId ?? null,
      grantedRole: "ADMIN",
    });
  }
  return { ok: true };
}

/**
 * Workspace reopen (§7.4 policy): ONLY the owner's membership returns to
 * ACTIVE — every other member stays REVOKED and must be re-invited, and
 * machine access (API credentials / webhooks) stays revoked and must be
 * re-issued. Clears BOTH suspension and revocation bookkeeping (closure
 * writes revocation fields; a reopened ACTIVE row must not carry them).
 */
export async function reopenWorkspaceOwnerMembership(
  tx: TxClient,
  input: { teamId: string; ownerUserId: string; actorUserId?: string | null },
): Promise<void> {
  const row = await tx.teamMember.findUnique({
    where: {
      teamId_userId: { teamId: input.teamId, userId: input.ownerUserId },
    },
    select: { id: true },
  });
  if (row) {
    await tx.teamMember.update({
      where: { id: row.id },
      data: {
        status: "ACTIVE",
        role: "OWNER",
        suspendedAtUtc: null,
        suspendedByUserId: null,
        suspensionReason: null,
        revokedAtUtc: null,
        revokedByUserId: null,
        revocationReason: null,
      },
    });
    await recordMembershipGrant(tx, {
      teamMemberId: row.id,
      source: "MANUAL",
      intent: "MEMBER_REACTIVATION",
      grantedByUserId: input.actorUserId ?? null,
      grantedRole: "OWNER",
    });
    return;
  }
  const created = await tx.teamMember.create({
    data: {
      teamId: input.teamId,
      userId: input.ownerUserId,
      role: "OWNER",
      status: "ACTIVE",
      accessReason: "workspace reopen",
    },
    select: { id: true },
  });
  await recordMembershipGrant(tx, {
    teamMemberId: created.id,
    source: "MANUAL",
    intent: "OWNED_WORKSPACE_OWNER",
    grantedByUserId: input.actorUserId ?? null,
    grantedRole: "OWNER",
  });
}

/**
 * PHASE 4 §7.5 — reversible mass suspension for workspace-level lifecycle
 * (organization-workspace suspend). Held roles are preserved; the marker
 * reason lets resume revert EXACTLY the rows this action wrote.
 */
export async function massSuspendWorkspaceMemberships(
  tx: TxClient,
  input: { teamId: string; actorUserId?: string | null; reason: string },
): Promise<{ count: number }> {
  // §4.4 — `userId`/`teamId` selected alongside `id` so pointer hygiene
  // below issues NO additional read.
  const affected = await tx.teamMember.findMany({
    where: { teamId: input.teamId, status: "ACTIVE" },
    select: { id: true, userId: true, teamId: true },
  });
  if (affected.length === 0) return { count: 0 };
  await tx.teamMember.updateMany({
    where: { id: { in: affected.map((m) => m.id) } },
    data: {
      status: "SUSPENDED",
      suspendedAtUtc: new Date(),
      suspendedByUserId: input.actorUserId ?? null,
      suspensionReason: input.reason.slice(0, 400),
    },
  });
  for (const m of affected) {
    await recordMembershipGrant(tx, {
      teamMemberId: m.id,
      source: "MANUAL",
      intent: "MEMBER_SUSPENSION",
      grantedByUserId: input.actorUserId ?? null,
    });
  }
  // §4.4 — workspace-wide suspension makes the context unusable for every
  // member at once; clear every pointer naming it.
  await repairStaleCurrentWorkspacePointers(
    {
      memberships: affected.map((m) => ({
        userId: m.userId,
        workspaceId: m.teamId,
      })),
    },
    tx as never,
  );
  return { count: affected.length };
}

/**
 * PHASE 4 §7.5 — reactivate ONLY memberships suspended with the given
 * marker reason. Individually-suspended members (different reason) and
 * REVOKED members are never silently restored by a workspace resume.
 */
export async function massReactivateSuspendedWorkspaceMemberships(
  tx: TxClient,
  input: { teamId: string; actorUserId?: string | null; matchReason: string },
): Promise<{ count: number }> {
  const affected = await tx.teamMember.findMany({
    where: {
      teamId: input.teamId,
      status: "SUSPENDED",
      suspensionReason: input.matchReason,
    },
    select: { id: true },
  });
  if (affected.length === 0) return { count: 0 };
  await tx.teamMember.updateMany({
    where: { id: { in: affected.map((m) => m.id) } },
    data: {
      status: "ACTIVE",
      suspendedAtUtc: null,
      suspendedByUserId: null,
      suspensionReason: null,
    },
  });
  for (const m of affected) {
    await recordMembershipGrant(tx, {
      teamMemberId: m.id,
      source: "MANUAL",
      intent: "MEMBER_REACTIVATION",
      grantedByUserId: input.actorUserId ?? null,
    });
  }
  return { count: affected.length };
}

/**
 * Team deletion: physically purge every membership of the team after
 * closing provenance (the team row itself is being deleted).
 */
export async function purgeWorkspaceMembershipsForTeamDeletion(
  tx: TxClient,
  input: { teamId: string; actorUserId?: string | null },
): Promise<void> {
  const members = await tx.teamMember.findMany({
    where: { teamId: input.teamId },
    select: { id: true },
  });
  await closeGrantsForTeamMembers(
    tx,
    members.map((m) => m.id),
    input.actorUserId ?? null,
  );
  await tx.teamMember.deleteMany({ where: { teamId: input.teamId } });
}

// =============================================================================
// PHASE 10 §1.1 — THE ONE ATOMIC MANAGED-PROVISIONING INTENT
//
// A single transaction-aware composer for every managed-identity provisioning
// path (SCIM create/update/group/reactivate, SSO/OIDC first login, verified
// existing-user linking, managed invitation). It is NOT a second orchestrator:
// it WRITES nothing itself. It composes the three canonical authorities —
//   1. identity-mode `setManagedIdentity` (managed ownership; DB-verified
//      evidence; cross-org conflict fails closed),
//   2. the Phase-9 commercial authority `resolveCommercialContext` (the ONE
//      seat figure), enforced fail-closed here,
//   3. the Membership Orchestrator `provisionMembership` (membership + workspace
//      grants + MembershipGrant provenance — the atomic audit-of-record).
//
// Every caller runs it INSIDE its own `$transaction`. Any failure (managed
// conflict, seat exhaustion, assignment failure) throws → the whole tx rolls
// back → ZERO partial: no identity ownership change, no OrganizationMembership,
// no TeamMember, no MembershipGrant, no claimed seat, no success side effect.
// Idempotent: an already-active member re-provisioned consumes no new seat and
// re-binding the SAME managing org is a no-op in setManagedIdentity.
// =============================================================================

/** Fail-closed seat-exhaustion error for managed provisioning (§1). */
export class ManagedSeatLimitError extends Error {
  readonly code = "MANAGED_SEAT_LIMIT_REACHED";
  readonly statusCode = 409;
  constructor(message = "Organization seat limit reached") {
    super(message);
    this.name = "ManagedSeatLimitError";
  }
}

/**
 * Fail-closed seat gate. Composes the Phase-9 seat FIGURE (never re-derives a
 * seat model). A re-provision of a user who already holds an ACTIVE seat in the
 * target workspace consumes NO new seat (idempotent). A genuinely NEW active
 * member is denied when the org seat pool has zero remaining. Plans with no
 * seat concept (`limit == null`) impose no constraint.
 */
async function assertManagedSeatAvailable(
  tx: TxClient,
  input: { seatTeamId: string; userId: string; requesterUserId: string },
): Promise<{ seatEnforced: boolean; alreadyHeld: boolean }> {
  const existing = await tx.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.seatTeamId, userId: input.userId } },
    select: { status: true },
  });
  const alreadyHeld = existing?.status === "ACTIVE";
  if (alreadyHeld) return { seatEnforced: true, alreadyHeld: true };

  const ctx = await resolveCommercialContext({
    type: "ORGANIZATION_WORKSPACE",
    teamId: input.seatTeamId,
    requesterUserId: input.requesterUserId,
  });
  if (ctx.seats.limit == null) return { seatEnforced: false, alreadyHeld: false };
  if (ctx.seats.remaining <= 0) throw new ManagedSeatLimitError();
  return { seatEnforced: true, alreadyHeld: false };
}

export type ManagedProvisioningInput = {
  userId: string;
  /**
   * The workspace (Team) whose owning CUSTOMER Organization manages the
   * identity. The intent resolves the managing organizationId from it via the
   * canonical `organizationIdForPolicy` — callers (routes included) never name
   * or interpret `managingOrganizationId` themselves.
   */
  managingTeamId: string;
  /** DB-verified evidence union (persisted source, never caller-asserted org). */
  evidence: ManagedIdentityEvidence;
  membershipIntent: MembershipIntent;
  source: MembershipGrantSourceValue;
  organizationRole?: string | null;
  /** Direct workspace grant (the seat consumer for SCIM/SSO/reactivation). */
  workspace?: { teamId: string; role: WorkspaceAssignmentRole } | null;
  /** Org-validated multi-workspace assignments (managed invitation path). */
  workspaceAssignments?: ReadonlyArray<WorkspaceAssignment>;
  actorUserId?: string | null;
  externalRef?: string | null;
  accessReason?: string;
  preserveExistingStatus?: boolean;
  /** ENFORCE = fail-closed on org seat exhaustion for a NEW active member. */
  seatPolicy: "ENFORCE" | "SKIP";
  /** Workspace whose owning-org seat pool governs (required when seatPolicy=ENFORCE and a workspace grant is made). */
  seatTeamId?: string | null;
};

export type ManagedProvisioningResult = {
  managedBound: boolean;
  organizationMembershipCreated: boolean;
  workspaceGrants: number;
  failedAssignments: Array<{ teamId: string; reason: string }>;
  seatEnforced: boolean;
  seatAlreadyHeld: boolean;
};

export async function provisionManagedMembership(
  tx: TxClient,
  input: ManagedProvisioningInput,
): Promise<ManagedProvisioningResult> {
  // Resolve the managing CUSTOMER Organization from the workspace via the ONE
  // canonical adapter — the intent owns this, not the caller. A non-CUSTOMER /
  // unresolvable workspace fails closed (managed provisioning is undefined there).
  const managingOrganizationId = await organizationIdForPolicy(
    input.managingTeamId,
    tx as unknown as PrismaClient,
  );
  if (!managingOrganizationId) {
    throw new Error("managed_provisioning_org_unresolved");
  }

  // 1) Managed identity binding FIRST — DB-verified evidence; a cross-org
  //    conflict or schema absence THROWS and rolls back the whole tx.
  await setManagedIdentity(
    {
      userId: input.userId,
      managingOrganizationId,
      evidence: input.evidence,
    },
    tx as unknown as PrismaClient,
  );

  // 2) Seat enforcement (fail-closed) — only when this provisioning ADDS a
  //    direct workspace seat consumer and the caller asked to ENFORCE.
  let seatEnforced = false;
  let seatAlreadyHeld = false;
  const seatTeamId = input.seatTeamId ?? input.workspace?.teamId ?? input.managingTeamId;
  if (input.seatPolicy === "ENFORCE" && seatTeamId) {
    const seat = await assertManagedSeatAvailable(tx, {
      seatTeamId,
      userId: input.userId,
      requesterUserId: input.actorUserId ?? input.userId,
    });
    seatEnforced = seat.seatEnforced;
    seatAlreadyHeld = seat.alreadyHeld;
  }

  // 3) Membership + workspace grants + provenance (the atomic audit-of-record).
  const r = await provisionMembership(tx, {
    intent: input.membershipIntent,
    source: input.source,
    userId: input.userId,
    organizationId: managingOrganizationId,
    organizationRole: input.organizationRole ?? null,
    workspace: input.workspace ?? null,
    workspaceAssignments: input.workspaceAssignments,
    actorUserId: input.actorUserId ?? null,
    externalRef: input.externalRef ?? null,
    accessReason: input.accessReason,
    preserveExistingStatus: input.preserveExistingStatus,
  });

  return {
    managedBound: true,
    organizationMembershipCreated: r.organizationMembershipCreated,
    workspaceGrants: r.workspaceGrants,
    failedAssignments: r.failedAssignments,
    seatEnforced,
    seatAlreadyHeld,
  };
}
