/**
 * Phase 26.5 — SCIM Groups service.
 *
 * Implements RFC 7644 Group resources on top of the Phase 17 TeamMember
 * role system. A Group is a stable resource the IdP can PUT/PATCH;
 * membership = `TeamMember.role = group.mappedRole`.
 *
 * Hard rules:
 *   - Role mutations on TeamMember go through `client.teamMember.update`
 *     directly here (no parallel RBAC service), and we audit each
 *     change via `scim_group_membership_changed` so the Phase 17
 *     audit chain remains intact.
 *   - DELETE is SOFT: status becomes ARCHIVED. Membership is
 *     reconciled (everyone with the mapped role gets demoted to
 *     MEMBER, the conservative default; the brief says NEVER hard-
 *     delete users and NEVER silently revoke privileged access).
 *   - Operator-safe payloads only. Group display name + externalId +
 *     mappedRole. Members surface as userId only; the resource
 *     resolver includes display name from the user row.
 *   - Idempotent POST: existing (organization, externalId) returns 200.
 *
 * MEMBERS AUDIT DOM-13 (owner decision 2026-10-25) — a SCIM group is the
 * ORGANIZATION's. Its reach is its ACTIVE projections
 * (`scim_group_workspace_projections`): each names one Workspace of the
 * Organization and the role the group grants there. Adding a member applies
 * the group in EVERY projected Workspace through the canonical provisioning
 * authority (an existing membership changes role; a missing one is
 * provisioned, seat-enforced); removing demotes in every projected Workspace;
 * archiving the group archives its projections and demotes there. A group is
 * created with one projection, into the token's default provisioning
 * Workspace; more are added by an Organization identity administrator.
 * Membership stays a Workspace fact — the projection only says where the
 * directory's group applies.
 */

import type {
  PrismaClient,
  ScimGroup as DbGroup,
  TeamRole,
} from "@prisma/client";
import {
  SCIM_GROUP_MAPPED_ROLES,
  SCIM_GROUP_SCHEMA_URI,
  SCIM_LIST_RESPONSE_SCHEMA_URI,
  ScimGroupPatchOpSchema,
  ScimGroupSchema,
  type ScimGroupInput,
  type ScimGroupMappedRole,
  type ScimGroupMember,
  type ScimGroupPatchOpInput,
  type ScimGroupResource,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
// PHASE 3 (2026-07-22) — canonical membership orchestrator.
import {
  applyDirectoryRoleChange,
  demoteGroupMappedRoleOnArchive,
  provisionManagedMembership,
  provisionMembership,
} from "../identity/membership-provisioning.service.js";
import { organizationIdForPolicy } from "../identity/org-security-policy.service.js";
import {
  enforceScimManagedOwnership,
  ScimManagedOwnershipError,
} from "./scim-managed-ownership.service.js";

// -----------------------------------------------------------------------------
// PHASE 12B — explicit member-reference failure.
//
// A member reference the workspace cannot resolve (unknown user, or a user
// belonging to ANOTHER Organization — the lookup is teamId-scoped, so a
// cross-Organization `value` is simply unresolvable here) used to be SILENTLY
// SKIPPED: the IdP received 200 OK for a group it believed had been applied.
// It now throws, which rolls the ENTIRE Operation set back and returns a
// SCIM-shaped error — zero partial mutation, no dishonest success.
// -----------------------------------------------------------------------------

export class ScimGroupMemberError extends Error {
  readonly statusCode = 409;
  constructor(
    readonly code:
      | "SCIM_GROUP_MEMBER_UNRESOLVED"
      | "SCIM_GROUP_MEMBER_INACTIVE",
    readonly memberValue: string,
  ) {
    super(code);
    this.name = "ScimGroupMemberError";
  }
}

// -----------------------------------------------------------------------------
// Group resource construction
// -----------------------------------------------------------------------------

type GroupCtx = {
  /** The token's default provisioning Workspace. */
  teamId: string;
  /** The Organization the token and its groups belong to (DOM-13). */
  organizationId: string;
  tokenId: string;
  baseUrl: string;
};

type LiveProjection = { id: string; workspaceId: string; mappedRole: ScimGroupMappedRole };

/** The Workspaces a group reaches now: ACTIVE projections into open Workspaces. */
export async function liveGroupProjections(
  groupId: string,
  client: PrismaClient,
): Promise<LiveProjection[]> {
  const rows = await client.scimGroupWorkspaceProjection.findMany({
    where: { scimGroupId: groupId, status: "ACTIVE", workspace: { closedAtUtc: null } },
    select: { id: true, workspaceId: true, mappedRole: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ ...r, mappedRole: r.mappedRole as ScimGroupMappedRole }));
}

async function loadGroupMembers(
  group: DbGroup,
  client: PrismaClient,
): Promise<ScimGroupMember[]> {
  // A member of the group holds the projected role in a projected Workspace.
  const projections = await liveGroupProjections(group.id, client);
  if (projections.length === 0) return [];
  const members = await client.teamMember.findMany({
    where: {
      status: "ACTIVE",
      OR: projections.map((pr) => ({ teamId: pr.workspaceId, role: pr.mappedRole as TeamRole })),
    },
    select: {
      userId: true,
      user: { select: { email: true } },
    },
    take: 2000,
  });
  const seen = new Map<string, ScimGroupMember>();
  for (const m of members) {
    if (!seen.has(m.userId)) seen.set(m.userId, { value: m.userId, display: m.user?.email ?? null });
  }
  return [...seen.values()];
}

async function buildResource(
  ctx: GroupCtx,
  row: DbGroup,
  client: PrismaClient,
): Promise<ScimGroupResource> {
  void ctx;
  const members = await loadGroupMembers(row, client);
  return {
    schemas: [SCIM_GROUP_SCHEMA_URI],
    id: row.id,
    displayName: row.displayName,
    externalId: row.externalId,
    mappedRole: row.mappedRole as ScimGroupMappedRole,
    members,
    meta: {
      resourceType: "Group",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: `${ctx.baseUrl}/Groups/${row.id}`,
    },
  };
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

export type ScimCreateGroupResult =
  | { ok: true; alreadyExisted: boolean; group: ScimGroupResource }
  | { ok: false; status: number; detail: string };

export async function scimCreateGroup(
  ctx: GroupCtx,
  input: ScimGroupInput,
  client: PrismaClient = defaultPrisma,
): Promise<ScimCreateGroupResult> {
  const parsed = ScimGroupSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 400, detail: "invalid_group_payload" };
  }

  // Idempotent: existing externalId returns the resource.
  if (parsed.data.externalId) {
    const existing = await client.scimGroup.findFirst({
      where: {
        organizationId: ctx.organizationId,
        externalId: parsed.data.externalId,
        status: "ACTIVE",
      },
    });
    if (existing) {
      return {
        ok: true,
        alreadyExisted: true,
        group: await buildResource(ctx, existing, client),
      };
    }
  }

  // PHASE 12B — ATOMIC group create: the ScimGroup row AND the initial member
  // role changes the IdP supplied on create are ONE outcome. Previously the
  // group row was committed first and membership applied afterwards, so an
  // unresolved/cross-Organization member left a committed group with partially
  // applied membership. Now any member failure rolls the group row back too.
  let row: DbGroup;
  try {
    row = await client.$transaction(async (tx) => {
      const txc = tx as unknown as PrismaClient;
      const created = await txc.scimGroup.create({
        data: {
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
          displayName: parsed.data.displayName.slice(0, 180),
          externalId: parsed.data.externalId ?? null,
          mappedRole: parsed.data.mappedRole,
          status: "ACTIVE",
        },
      });
      // The group's first reach: the token's default provisioning Workspace.
      await txc.scimGroupWorkspaceProjection.create({
        data: {
          scimGroupId: created.id,
          organizationId: ctx.organizationId,
          workspaceId: ctx.teamId,
          mappedRole: parsed.data.mappedRole,
        },
      });
      if (parsed.data.members && parsed.data.members.length > 0) {
        await applyGroupMembership(
          ctx,
          created,
          parsed.data.members.map((m) => m.value),
          "add",
          txc,
        );
      }
      return created;
    });
  } catch (err) {
    if (err instanceof ScimGroupMemberError) {
      return {
        ok: false,
        status: 409,
        detail:
          err.code === "SCIM_GROUP_MEMBER_UNRESOLVED"
            ? "group_member_unresolved"
            : "group_member_inactive",
      };
    }
    if (err instanceof ScimManagedOwnershipError) {
      return {
        ok: false,
        status: 409,
        detail:
          err.code === "SCIM_MANAGED_CROSS_ORG_CONFLICT"
            ? "managed_cross_org_conflict"
            : "managed_identity_unresolved",
      };
    }
    return {
      ok: false,
      status: 409,
      detail: "group_already_exists",
    };
  }

  bump("scim_group_created_total");
  bump("scim_group_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_group_created",
    severity: "INFO",
    details: {
      tokenId: ctx.tokenId,
      groupId: row.id,
      mappedRole: parsed.data.mappedRole,
    },
  });
  await emitTenantAudit({
    action: "scim.group.create",
    outcome: "success",
    sourceApp: "SCIM",
    actorUserId: null,
    serviceActor: "scim_service",
    workspaceId: ctx.teamId,
    resourceType: "scim_group",
    resourceId: row.id,
    metadata: {
      mappedRole: parsed.data.mappedRole,
    },
  }, client);

  return {
    ok: true,
    alreadyExisted: false,
    group: await buildResource(ctx, row, client),
  };
}

// -----------------------------------------------------------------------------
// Read / list
// -----------------------------------------------------------------------------

export async function scimReadGroup(
  ctx: GroupCtx,
  groupId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ScimGroupResource | null> {
  const row = await client.scimGroup.findFirst({
    where: { id: groupId, organizationId: ctx.organizationId },
  });
  if (!row) return null;
  return buildResource(ctx, row, client);
}

export async function scimListGroups(
  ctx: GroupCtx,
  input: { filter?: string; startIndex?: number; count?: number },
  client: PrismaClient = defaultPrisma,
): Promise<{
  schemas: [typeof SCIM_LIST_RESPONSE_SCHEMA_URI];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: ReadonlyArray<ScimGroupResource>;
}> {
  const startIndex = Math.max(1, Math.floor(input.startIndex ?? 1));
  const count = Math.min(Math.max(Math.floor(input.count ?? 50), 1), 200);
  let displayEq: string | undefined;
  let externalIdEq: string | undefined;
  if (input.filter) {
    const m = /^(displayName|externalId)\s+eq\s+"([^"]+)"$/i.exec(
      input.filter.trim(),
    );
    if (m) {
      if (m[1].toLowerCase() === "displayname") displayEq = m[2];
      else externalIdEq = m[2];
    }
  }
  const where = {
    organizationId: ctx.organizationId,
    status: "ACTIVE",
    ...(displayEq ? { displayName: displayEq } : {}),
    ...(externalIdEq ? { externalId: externalIdEq } : {}),
  };
  const totalResults = await client.scimGroup.count({ where });
  const rows = await client.scimGroup.findMany({
    where,
    skip: startIndex - 1,
    take: count,
    orderBy: { createdAt: "desc" },
  });
  const resources = await Promise.all(rows.map((r) => buildResource(ctx, r, client)));
  return {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA_URI],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

// -----------------------------------------------------------------------------
// PATCH (replace displayName / add / remove members)
// -----------------------------------------------------------------------------

export type ScimPatchGroupResult =
  | { ok: true; group: ScimGroupResource }
  | { ok: false; status: number; detail: string };

export async function scimPatchGroup(
  ctx: GroupCtx,
  groupId: string,
  input: ScimGroupPatchOpInput,
  client: PrismaClient = defaultPrisma,
): Promise<ScimPatchGroupResult> {
  const parsed = ScimGroupPatchOpSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 400, detail: "invalid_patch" };
  }
  const row = await client.scimGroup.findFirst({
    where: { id: groupId, organizationId: ctx.organizationId },
  });
  if (!row || row.status !== "ACTIVE") {
    return { ok: false, status: 404, detail: "group_not_found" };
  }

  // ATOMIC group PATCH: the whole Operation set runs in ONE transaction. If any
  // affected member fails managed-ownership validation (cross-org / unresolved /
  // schema-unavailable / seat exhaustion), the ENTIRE PATCH rolls back and
  // returns an explicit SCIM error — never a silent skipped-member / partial
  // group state. Concurrent retries are idempotent (role no-ops short-circuit).
  try {
    await client.$transaction(async (tx) => {
      const txc = tx as unknown as PrismaClient;
      for (const op of parsed.data.Operations) {
        const path = op.path.toLowerCase();
        if (op.op === "replace" && path === "displayname") {
          if (typeof op.value !== "string") continue;
          await txc.scimGroup.update({ where: { id: row.id }, data: { displayName: op.value.slice(0, 180) } });
          continue;
        }
        if (
          op.op === "replace" &&
          path === "mappedrole" &&
          typeof op.value === "string" &&
          (SCIM_GROUP_MAPPED_ROLES as ReadonlyArray<string>).includes(op.value)
        ) {
          await txc.scimGroup.update({ where: { id: row.id }, data: { mappedRole: op.value } });
          // The group's default role follows; projections that carried the
          // old default carry the new one (a projection given its own role by
          // an administrator keeps it).
          await txc.scimGroupWorkspaceProjection.updateMany({
            where: { scimGroupId: row.id, status: "ACTIVE", mappedRole: row.mappedRole },
            data: { mappedRole: op.value },
          });
          continue;
        }
        if (op.op === "add" && path.startsWith("members")) {
          const valueUserIds = extractMemberUserIds(op.value);
          if (valueUserIds.length > 0) await applyGroupMembership(ctx, row, valueUserIds, "add", txc);
          continue;
        }
        if (op.op === "remove" && path.startsWith("members")) {
          const valueUserIds = extractMemberUserIds(op.value);
          if (valueUserIds.length > 0) await applyGroupMembership(ctx, row, valueUserIds, "remove", txc);
          continue;
        }
      }
    });
  } catch (err) {
    if (err instanceof ScimGroupMemberError) {
      return {
        ok: false,
        status: 409,
        detail:
          err.code === "SCIM_GROUP_MEMBER_UNRESOLVED"
            ? "group_member_unresolved"
            : "group_member_inactive",
      };
    }
    if (err instanceof ScimManagedOwnershipError) {
      return {
        ok: false,
        status: 409,
        detail:
          err.code === "SCIM_MANAGED_CROSS_ORG_CONFLICT"
            ? "managed_cross_org_conflict"
            : "managed_identity_unresolved",
      };
    }
    throw err; // schema-unavailability / seat exhaustion — fail closed
  }

  bump("scim_group_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_group_updated",
    severity: "INFO",
    details: {
      tokenId: ctx.tokenId,
      groupId: row.id,
    },
  });

  const refreshed = await client.scimGroup.findUnique({ where: { id: row.id } });
  if (!refreshed) {
    return { ok: false, status: 500, detail: "group_lookup_failed" };
  }
  return { ok: true, group: await buildResource(ctx, refreshed, client) };
}

// -----------------------------------------------------------------------------
// DELETE — SOFT (status = ARCHIVED + demote members to MEMBER)
// -----------------------------------------------------------------------------

export async function scimDeleteGroup(
  ctx: GroupCtx,
  groupId: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ ok: boolean }> {
  const row = await client.scimGroup.findFirst({
    where: { id: groupId, organizationId: ctx.organizationId },
  });
  if (!row) return { ok: false };
  // PHASE 12B — ATOMIC soft delete: archiving the group AND demoting every
  // member the group's mapped role granted are ONE outcome. Previously the
  // archive committed first, so a demotion failure left an ARCHIVED group whose
  // members kept the elevated role it had granted.
  //
  // Demotion targets MEMBER (the conservative default) so we never silently
  // revoke privileged access (OWNER/ADMIN rows) or hard-delete users.
  const demoted = await client.$transaction(async (tx) => {
    const txc = tx as unknown as PrismaClient;
    const projections = await liveGroupProjections(row.id, txc);
    await txc.scimGroup.update({
      where: { id: row.id },
      data: { status: "ARCHIVED" },
    });
    await txc.scimGroupWorkspaceProjection.updateMany({
      where: { scimGroupId: row.id, status: "ACTIVE" },
      data: { status: "ARCHIVED" },
    });
    // PHASE 3 — canonical orchestrator: bulk group-archive demotion
    // (IDP_GROUP provenance per affected member), in every projected Workspace.
    let count = 0;
    for (const pr of projections) {
      if (pr.mappedRole === "MEMBER") continue;
      const affected = await demoteGroupMappedRoleOnArchive(txc, {
        teamId: pr.workspaceId,
        mappedRole: pr.mappedRole,
        externalRef: `scim-group:${row.id}`,
      });
      count += affected.count;
    }
    return count;
  });
  if (demoted > 0) {
    safeEmitSecurityEvent({
      teamId: ctx.teamId,
      eventType: "scim_group_membership_changed",
      severity: "WARNING",
      details: {
        tokenId: ctx.tokenId,
        groupId: row.id,
        demotedCount: demoted,
        fromRole: row.mappedRole,
        toRole: "MEMBER",
      },
    });
  }
  bump("scim_group_deleted_total");
  bump("scim_group_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_group_deleted",
    severity: "WARNING",
    details: { tokenId: ctx.tokenId, groupId: row.id },
  });
  await emitTenantAudit({
    action: "scim.group.delete",
    outcome: "success",
    sourceApp: "SCIM",
    actorUserId: null,
    serviceActor: "scim_service",
    workspaceId: ctx.teamId,
    resourceType: "scim_group",
    resourceId: row.id,
    metadata: {},
  }, client);
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Membership reconciliation helper
// -----------------------------------------------------------------------------

function extractMemberUserIds(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        typeof v === "object" && v !== null && "value" in v
          ? String((v as { value: unknown }).value)
          : typeof v === "string"
            ? v
            : "",
      )
      .filter((s) => s.length > 0);
  }
  if (typeof value === "object" && value !== null && "value" in value) {
    return [String((value as { value: unknown }).value)];
  }
  return [];
}

/**
 * Is this user an identity of the group's Organization? A directory may only
 * name users it provisioned (a live SCIM link in the Organization) or users
 * who already belong to one of the Organization's Workspaces. Anyone else —
 * including a user of ANOTHER Organization — is unresolvable (DOM-13 isolation).
 */
async function isOrganizationIdentity(
  organizationId: string,
  userId: string,
  client: PrismaClient,
): Promise<boolean> {
  const [link, member] = await Promise.all([
    client.externalIdentityMapping.findFirst({
      where: { organizationId, userId, unlinkedAtUtc: null },
      select: { id: true },
    }),
    client.teamMember.findFirst({
      where: { userId, team: { organizationId } },
      select: { id: true },
    }),
  ]);
  return Boolean(link || member);
}

/**
 * Apply group membership for `userIds` in every Workspace the group reaches,
 * or only in `only` (a projection being added).
 */
export async function applyGroupMembership(
  ctx: GroupCtx,
  group: DbGroup,
  userIds: string[],
  op: "add" | "remove",
  client: PrismaClient,
  only?: LiveProjection,
): Promise<void> {
  let changed = 0;
  const projections = only ? [only] : await liveGroupProjections(group.id, client);
  for (const userId of userIds) {
    // PHASE 12B — EXPLICIT failure for an unresolved / cross-Organization
    // member reference (never a silent skip): the whole Operation set rolls back.
    if (!(await isOrganizationIdentity(ctx.organizationId, userId, client))) {
      throw new ScimGroupMemberError("SCIM_GROUP_MEMBER_UNRESOLVED", userId);
    }
    for (const pr of projections) {
      const member = await client.teamMember.findFirst({
        where: { teamId: pr.workspaceId, userId },
        select: { id: true, role: true, status: true },
      });
      if (!member) {
        // Not in this projected Workspace yet. A REMOVE has nothing to undo; an
        // ADD provisions the membership through the canonical authority, with
        // the projection's role, seat-enforced, IDP_GROUP provenance.
        if (op === "remove") continue;
        await provisionIntoProjection(ctx, group, pr, userId, client);
        changed += 1;
        continue;
      }
      if (member.status !== "ACTIVE") {
        // A group REMOVE against an already-inactive member is idempotently
        // satisfied; a group ADD onto an inactive member is not something the
        // model can honour, so it fails explicitly rather than reporting success.
        if (op === "remove") continue;
        throw new ScimGroupMemberError("SCIM_GROUP_MEMBER_INACTIVE", userId);
      }

      // PATH 3/9 — enforce the managed-ownership invariant BEFORE the group role
      // change (never assume "already managed"). A cross-org / unresolved member
      // THROWS so the ENTIRE operation rolls back. Schema/seat failures propagate.
      await enforceScimManagedOwnership(
        { teamId: pr.workspaceId, tokenId: ctx.tokenId },
        { userId, workspaceRole: member.role === "VIEWER" ? "VIEWER" : "MEMBER" },
        client,
      );

      // A REMOVE undoes only what THIS group granted here (provenance on the
      // membership grant): an ADMIN the group granted falls back to MEMBER; a
      // VIEWER or MEMBER grant leaves the role as it is (a removal must never
      // ELEVATE a VIEWER), and an ADMIN granted by anyone else is untouched.
      if (op === "remove") {
        if (pr.mappedRole !== "ADMIN" || member.role !== "ADMIN") continue;
        const grant = await client.membershipGrant.findFirst({
          where: { teamMemberId: member.id, externalRef: `scim-group:${group.id}`, revokedAtUtc: null },
          orderBy: { createdAt: "desc" },
          select: { grantedRole: true },
        });
        if (grant?.grantedRole !== "ADMIN") continue;
      }
      const desiredRole =
        op === "add" ? (pr.mappedRole as TeamRole) : ("MEMBER" as TeamRole);
      if (member.role === desiredRole) continue;
      // Never silently revoke OWNER/ADMIN via group remove — those need
      // explicit operator action. An OWNER row is never changed by a group.
      if (member.role === "OWNER") continue;
      // PHASE 3 — canonical orchestrator: directory role change.
      const applied = await applyDirectoryRoleChange(client, {
        teamMemberId: member.id,
        currentRole: member.role,
        desiredRole,
        source: "IDP_GROUP",
        externalRef: `scim-group:${group.id}`,
        allowPrivilegedChange: true,
      });
      if (applied.changed) changed += 1;
    }
  }
  if (changed > 0) {
    bump("scim_group_membership_total", changed);
    safeEmitSecurityEvent({
      teamId: ctx.teamId,
      eventType: "scim_group_membership_changed",
      severity: "INFO",
      details: {
        tokenId: ctx.tokenId,
        groupId: group.id,
        op,
        count: changed,
      },
    });
  }
}

async function provisionIntoProjection(
  ctx: GroupCtx,
  group: DbGroup,
  pr: LiveProjection,
  userId: string,
  client: PrismaClient,
): Promise<void> {
  const role = pr.mappedRole as "ADMIN" | "MEMBER" | "VIEWER";
  const customerOrg = await organizationIdForPolicy(pr.workspaceId, client);
  if (customerOrg) {
    await provisionManagedMembership(client as never, {
      userId,
      managingTeamId: ctx.teamId,
      evidence: { source: "SCIM", scimTokenId: ctx.tokenId },
      membershipIntent: "SCIM_PROVISIONING",
      source: "IDP_GROUP",
      workspace: { teamId: pr.workspaceId, role: role as never },
      actorUserId: null,
      externalRef: `scim-group:${group.id}`,
      accessReason: "SCIM group projection",
      seatPolicy: "ENFORCE",
      seatTeamId: pr.workspaceId,
    });
    return;
  }
  await provisionMembership(client, {
    intent: "SCIM_PROVISIONING",
    source: "IDP_GROUP",
    userId,
    workspace: { teamId: pr.workspaceId, role: role as never },
    actorUserId: null,
    externalRef: `scim-group:${group.id}`,
    accessReason: "SCIM group projection",
  });
}

// -----------------------------------------------------------------------------
// Members audit DOM-13 — projection administration (Organization identity
// admins, through scim-admin.routes). A projection is where an Organization
// group applies; adding one applies the group's current members there through
// the same provisioning path a directory push uses, so it needs a live
// directory credential of the Organization (the provisioning evidence).
// -----------------------------------------------------------------------------

export type ScimGroupProjectionView = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  mappedRole: string;
  status: string;
};

export type ScimOrganizationGroupView = {
  id: string;
  displayName: string;
  externalId: string | null;
  mappedRole: string;
  status: string;
  projections: ScimGroupProjectionView[];
};

export async function listOrganizationScimGroups(
  input: { organizationId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ScimOrganizationGroupView[]> {
  const rows = await client.scimGroup.findMany({
    where: { organizationId: input.organizationId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      projections: {
        orderBy: { createdAt: "asc" },
        include: { workspace: { select: { name: true } } },
      },
    },
  });
  return rows.map((g) => ({
    id: g.id,
    displayName: g.displayName,
    externalId: g.externalId,
    mappedRole: g.mappedRole,
    status: g.status,
    projections: g.projections.map((p) => ({
      id: p.id,
      workspaceId: p.workspaceId,
      workspaceName: p.workspace.name,
      mappedRole: p.mappedRole,
      status: p.status,
    })),
  }));
}

export type ScimProjectionRefusal =
  | "group_not_found"
  | "workspace_not_in_organization"
  | "workspace_not_eligible"
  | "projection_exists"
  | "no_live_directory_credential"
  | "projection_not_found";

export class ScimProjectionError extends Error {
  constructor(readonly reason: ScimProjectionRefusal) {
    super(reason);
    this.name = "ScimProjectionError";
  }
}

export async function addScimGroupProjection(
  input: {
    organizationId: string;
    groupId: string;
    workspaceId: string;
    mappedRole: ScimGroupMappedRole;
    actorUserId: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ projectionId: string; applied: number }> {
  return client.$transaction(async (tx) => {
    const txc = tx as unknown as PrismaClient;
    const group = await txc.scimGroup.findFirst({
      where: { id: input.groupId, organizationId: input.organizationId, status: "ACTIVE" },
    });
    if (!group) throw new ScimProjectionError("group_not_found");
    const workspace = await txc.team.findUnique({
      where: { id: input.workspaceId },
      select: { organizationId: true, closedAtUtc: true, isPersonal: true },
    });
    if (!workspace || workspace.organizationId !== input.organizationId) {
      throw new ScimProjectionError("workspace_not_in_organization");
    }
    if (workspace.closedAtUtc !== null || workspace.isPersonal) {
      throw new ScimProjectionError("workspace_not_eligible");
    }
    const credential = await txc.scimProvisioningToken.findFirst({
      where: { organizationId: input.organizationId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      select: { id: true, teamId: true },
    });
    if (!credential) throw new ScimProjectionError("no_live_directory_credential");

    const members = await loadGroupMembers(group, txc);
    let projection;
    try {
      projection = await txc.scimGroupWorkspaceProjection.create({
        data: {
          scimGroupId: group.id,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          mappedRole: input.mappedRole,
          createdByUserId: input.actorUserId,
        },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "P2002") throw new ScimProjectionError("projection_exists");
      throw err;
    }
    if (members.length > 0) {
      await applyGroupMembership(
        { teamId: credential.teamId, organizationId: input.organizationId, tokenId: credential.id, baseUrl: "" },
        group,
        members.map((m) => m.value),
        "add",
        txc,
        { id: projection.id, workspaceId: input.workspaceId, mappedRole: input.mappedRole },
      );
    }
    await emitTenantAudit({
      action: "scim.group.projection_added",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      resourceType: "scim_group_workspace_projection",
      resourceId: projection.id,
      previousState: null,
      resultingState: "ACTIVE",
      metadata: { groupId: group.id, mappedRole: input.mappedRole, membersApplied: members.length },
    }, txc);
    return { projectionId: projection.id, applied: members.length };
  });
}

export async function archiveScimGroupProjection(
  input: { organizationId: string; projectionId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ demoted: number }> {
  return client.$transaction(async (tx) => {
    const txc = tx as unknown as PrismaClient;
    const projection = await txc.scimGroupWorkspaceProjection.findFirst({
      where: { id: input.projectionId, organizationId: input.organizationId, status: "ACTIVE" },
    });
    if (!projection) throw new ScimProjectionError("projection_not_found");
    const ended = await txc.scimGroupWorkspaceProjection.updateMany({
      where: { id: projection.id, status: "ACTIVE" },
      data: { status: "ARCHIVED" },
    });
    if (ended.count !== 1) throw new ScimProjectionError("projection_not_found");
    let demoted = 0;
    if (projection.mappedRole !== "MEMBER") {
      const affected = await demoteGroupMappedRoleOnArchive(txc, {
        teamId: projection.workspaceId,
        mappedRole: projection.mappedRole,
        externalRef: `scim-group:${projection.scimGroupId}`,
      });
      demoted = affected.count;
    }
    await emitTenantAudit({
      action: "scim.group.projection_archived",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: projection.workspaceId,
      organizationId: input.organizationId,
      resourceType: "scim_group_workspace_projection",
      resourceId: projection.id,
      previousState: "ACTIVE",
      resultingState: "ARCHIVED",
      metadata: { groupId: projection.scimGroupId, demoted },
    }, txc);
    return { demoted };
  });
}
