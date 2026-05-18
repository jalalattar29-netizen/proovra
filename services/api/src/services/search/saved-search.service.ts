/**
 * Phase 24 — Saved search view service.
 *
 * Per-user (PRIVATE) or per-team (TEAM) named search filters. The
 * route layer validates the filter shape against
 * `@proovra/shared SearchFilterSchema` BEFORE calling the service —
 * the service stores whatever it's given, on the assumption that the
 * caller has already validated.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type SavedViewVisibility,
  type SearchFilterInput,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export type SavedViewProjection = {
  id: string;
  name: string;
  description: string | null;
  visibility: SavedViewVisibility;
  pinned: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAtUtc: string | null;
  // Raw filter is included for the operator UI to re-apply.
  query: SearchFilterInput;
};

function projectView(row: prismaPkg.SavedSearchView): SavedViewProjection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility as SavedViewVisibility,
    pinned: row.pinned,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAtUtc: row.lastUsedAtUtc?.toISOString() ?? null,
    query: row.queryJson as unknown as SearchFilterInput,
  };
}

// -----------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------

export async function listSavedViewsForUser(
  input: { teamId: string; userId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<SavedViewProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await client.savedSearchView.findMany({
    where: {
      teamId: input.teamId,
      OR: [
        // The user's own private + team views.
        { createdByUserId: input.userId },
        // Everyone else's TEAM-scope views.
        { visibility: "TEAM" },
      ],
    },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    take: limit,
  });
  return rows.map(projectView);
}

// -----------------------------------------------------------------------------
// Create + update + delete
// -----------------------------------------------------------------------------

export type CreateSavedViewInput = {
  teamId: string;
  actorUserId: string;
  name: string;
  description?: string | null;
  visibility: SavedViewVisibility;
  pinned?: boolean;
  query: SearchFilterInput;
};

export async function createSavedView(
  input: CreateSavedViewInput,
  client: PrismaClient = defaultPrisma,
): Promise<SavedViewProjection | null> {
  try {
    const row = await client.savedSearchView.create({
      data: {
        teamId: input.teamId,
        createdByUserId: input.actorUserId,
        name: input.name.slice(0, 120),
        description: input.description?.slice(0, 400) ?? null,
        visibility: input.visibility,
        pinned: input.pinned ?? false,
        queryJson: input.query as unknown as prismaPkg.Prisma.InputJsonValue,
      },
    });
    bump("search_saved_view_created_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "search_saved_view_created",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        visibility: input.visibility,
        pinned: input.pinned ?? false,
      },
    });
    await appendPlatformAuditLog({
      userId: input.actorUserId,
      action: "search.saved_view.create",
      category: "search",
      severity: "info",
      source: "search_service",
      outcome: "success",
      resourceType: "saved_search_view",
      resourceId: row.id,
      metadata: {
        teamId: input.teamId,
        visibility: input.visibility,
        pinned: input.pinned ?? false,
      },
      db: client,
    });
    return projectView(row);
  } catch {
    // Likely a duplicate (uk on (team, user, name)). Return null so
    // the route layer can surface 409.
    return null;
  }
}

export type DeleteSavedViewInput = {
  teamId: string;
  actorUserId: string;
  id: string;
};

export async function deleteSavedView(
  input: DeleteSavedViewInput,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const row = await client.savedSearchView.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!row) return false;
  // Only the creator can delete a PRIVATE view; a TEAM view can be
  // deleted by the creator or by an admin (the route layer enforces
  // the admin check).
  if (row.visibility === "PRIVATE" && row.createdByUserId !== input.actorUserId) {
    return false;
  }
  await client.savedSearchView.delete({ where: { id: row.id } });
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "search_saved_view_deleted",
    severity: "INFO",
    details: {
      actorUserId: input.actorUserId,
      visibility: row.visibility,
    },
  });
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "search.saved_view.delete",
    category: "search",
    severity: "info",
    source: "search_service",
    outcome: "success",
    resourceType: "saved_search_view",
    resourceId: row.id,
    metadata: { teamId: input.teamId, visibility: row.visibility },
    db: client,
  });
  return true;
}

/**
 * Best-effort: touch `lastUsedAtUtc` so operators can prune stale
 * views via reconcile. Never throws to the caller.
 */
export async function touchSavedView(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await client.savedSearchView.update({
      where: { id },
      data: { lastUsedAtUtc: new Date() },
    });
  } catch {
    /* best-effort */
  }
}
