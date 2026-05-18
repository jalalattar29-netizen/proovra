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
 *   - Idempotent POST: existing (teamId, externalId) returns 200.
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
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";

// -----------------------------------------------------------------------------
// Group resource construction
// -----------------------------------------------------------------------------

type GroupCtx = {
  teamId: string;
  tokenId: string;
  baseUrl: string;
};

async function loadGroupMembers(
  teamId: string,
  mappedRole: ScimGroupMappedRole,
  client: PrismaClient,
): Promise<ScimGroupMember[]> {
  const members = await client.teamMember.findMany({
    where: {
      teamId,
      status: "ACTIVE",
      role: mappedRole as TeamRole,
    },
    select: {
      userId: true,
      user: { select: { email: true } },
    },
    take: 2000,
  });
  return members.map((m) => ({
    value: m.userId,
    display: m.user?.email ?? null,
  }));
}

async function buildResource(
  ctx: GroupCtx,
  row: DbGroup,
  client: PrismaClient,
): Promise<ScimGroupResource> {
  const members = await loadGroupMembers(
    ctx.teamId,
    row.mappedRole as ScimGroupMappedRole,
    client,
  );
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
        teamId: ctx.teamId,
        externalId: parsed.data.externalId,
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

  let row: DbGroup;
  try {
    row = await client.scimGroup.create({
      data: {
        teamId: ctx.teamId,
        displayName: parsed.data.displayName.slice(0, 180),
        externalId: parsed.data.externalId ?? null,
        mappedRole: parsed.data.mappedRole,
        status: "ACTIVE",
      },
    });
  } catch {
    return {
      ok: false,
      status: 409,
      detail: "group_already_exists",
    };
  }

  // If the IdP supplied members on create, apply them as role changes.
  if (parsed.data.members && parsed.data.members.length > 0) {
    await applyGroupMembership(
      ctx,
      row,
      parsed.data.members.map((m) => m.value),
      "add",
      client,
    );
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
  await appendPlatformAuditLog({
    userId: null,
    action: "scim.group.create",
    category: "identity",
    severity: "info",
    source: "scim_service",
    outcome: "success",
    resourceType: "scim_group",
    resourceId: row.id,
    metadata: {
      teamId: ctx.teamId,
      mappedRole: parsed.data.mappedRole,
    },
    db: client,
  });

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
    where: { id: groupId, teamId: ctx.teamId },
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
    teamId: ctx.teamId,
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
    where: { id: groupId, teamId: ctx.teamId },
  });
  if (!row || row.status !== "ACTIVE") {
    return { ok: false, status: 404, detail: "group_not_found" };
  }

  for (const op of parsed.data.Operations) {
    const path = op.path.toLowerCase();
    if (op.op === "replace" && path === "displayname") {
      if (typeof op.value !== "string") continue;
      await client.scimGroup.update({
        where: { id: row.id },
        data: { displayName: op.value.slice(0, 180) },
      });
      continue;
    }
    if (
      op.op === "replace" &&
      path === "mappedrole" &&
      typeof op.value === "string" &&
      (SCIM_GROUP_MAPPED_ROLES as ReadonlyArray<string>).includes(op.value)
    ) {
      await client.scimGroup.update({
        where: { id: row.id },
        data: { mappedRole: op.value },
      });
      continue;
    }
    if (op.op === "add" && path.startsWith("members")) {
      const valueUserIds = extractMemberUserIds(op.value);
      if (valueUserIds.length > 0) {
        await applyGroupMembership(ctx, row, valueUserIds, "add", client);
      }
      continue;
    }
    if (op.op === "remove" && path.startsWith("members")) {
      const valueUserIds = extractMemberUserIds(op.value);
      if (valueUserIds.length > 0) {
        await applyGroupMembership(ctx, row, valueUserIds, "remove", client);
      }
      continue;
    }
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
    where: { id: groupId, teamId: ctx.teamId },
  });
  if (!row) return { ok: false };
  // Demote every member to MEMBER (the conservative default) so we
  // never silently revoke privileged access (admin role members) or
  // hard-delete users.
  await client.scimGroup.update({
    where: { id: row.id },
    data: { status: "ARCHIVED" },
  });
  if (row.mappedRole !== "MEMBER") {
    const affected = await client.teamMember.updateMany({
      where: {
        teamId: ctx.teamId,
        role: row.mappedRole as TeamRole,
        status: "ACTIVE",
      },
      data: { role: "MEMBER" },
    });
    if (affected.count > 0) {
      safeEmitSecurityEvent({
        teamId: ctx.teamId,
        eventType: "scim_group_membership_changed",
        severity: "WARNING",
        details: {
          tokenId: ctx.tokenId,
          groupId: row.id,
          demotedCount: affected.count,
          fromRole: row.mappedRole,
          toRole: "MEMBER",
        },
      });
    }
  }
  bump("scim_group_deleted_total");
  bump("scim_group_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_group_deleted",
    severity: "WARNING",
    details: { tokenId: ctx.tokenId, groupId: row.id },
  });
  await appendPlatformAuditLog({
    userId: null,
    action: "scim.group.delete",
    category: "identity",
    severity: "warning",
    source: "scim_service",
    outcome: "success",
    resourceType: "scim_group",
    resourceId: row.id,
    metadata: { teamId: ctx.teamId },
    db: client,
  });
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

async function applyGroupMembership(
  ctx: GroupCtx,
  group: DbGroup,
  userIds: string[],
  op: "add" | "remove",
  client: PrismaClient,
): Promise<void> {
  let changed = 0;
  for (const userId of userIds) {
    const member = await client.teamMember.findFirst({
      where: { teamId: ctx.teamId, userId },
      select: { id: true, role: true, status: true },
    });
    if (!member || member.status !== "ACTIVE") continue;
    const desiredRole =
      op === "add" ? (group.mappedRole as TeamRole) : ("MEMBER" as TeamRole);
    if (member.role === desiredRole) continue;
    // Never silently revoke OWNER/ADMIN via group remove — those need
    // explicit operator action.
    if (op === "remove" && (member.role === "OWNER" || member.role === "ADMIN")) {
      continue;
    }
    await client.teamMember.update({
      where: { id: member.id },
      data: { role: desiredRole },
    });
    changed += 1;
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
