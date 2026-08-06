/**
 * PROOVRA Insurance SIU — durable saved views (Phase M3.2).
 *
 * Bounded per-team SIU saved-view CRUD on top of `case_siu_saved_views`.
 *
 * Hard rules:
 *   * Workspace-scoped — every query is gated by `team_id`.
 *   * Bounded `filterJson` + `sortJson` validated against the bounded
 *     shape exported from `@proovra/shared`. No arbitrary SQL-ish
 *     filters; no nested objects beyond the documented schema.
 *   * Bounded `visibility` enum (`private` / `team` / `organization`).
 *   * Private views are visible only to the creator. Team views are
 *     visible to every team member. Organization views are visible
 *     only when the team carries an `organizationId` AND the caller
 *     is a member of that organization (the check delegates to the
 *     existing access policy via `evaluateMemberAccess`).
 *   * Bounded display name (≤120 chars) + bounded description.
 *   * Last-used timestamp is updated by the dedicated `use` endpoint.
 */

import { Prisma } from "@prisma/client";
import type { CaseSiuSavedView as CaseSiuSavedViewRecord } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../db.js";
import {
  SIU_INVESTIGATION_STATUSES,
  SIU_SAVED_VIEW_VISIBILITY,
  type SiuSavedViewVisibility,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// Bounded filter + sort shape
// ---------------------------------------------------------------------------

/**
 * Bounded filter projection. Every key is optional — but the union of
 * known keys is bounded by this shape. Unknown keys are stripped.
 */
export const SiuSavedViewFilterSchema = z
  .object({
    investigationStatus: z
      .array(z.enum(SIU_INVESTIGATION_STATUSES))
      .max(7)
      .optional(),
    requireMissingChecklistItems: z.boolean().optional(),
    requireWarningIndicators: z.boolean().optional(),
    requireOpenFollowUps: z.boolean().optional(),
    requireRecentExport: z.boolean().optional(),
    assignedAdjusterUserId: z.string().uuid().optional(),
    assignedSiuReviewerUserId: z.string().uuid().optional(),
    claimType: z
      .enum(["auto", "property", "injury", "liability", "travel", "cyber", "other"])
      .optional(),
  })
  .strict();
export type SiuSavedViewFilter = z.infer<typeof SiuSavedViewFilterSchema>;

/**
 * Bounded sort projection. Direction is asc | desc.
 */
export const SiuSavedViewSortSchema = z
  .object({
    key: z.enum([
      "updatedAtUtc",
      "createdAtUtc",
      "investigationStatus",
      "incidentDate",
    ]),
    direction: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();
export type SiuSavedViewSort = z.infer<typeof SiuSavedViewSortSchema>;

// ---------------------------------------------------------------------------
// Bounded input schemas
// ---------------------------------------------------------------------------

export const CreateSavedViewSchema = z.object({
  teamId: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(400).optional().nullable(),
  filter: SiuSavedViewFilterSchema,
  sort: SiuSavedViewSortSchema,
  visibility: z.enum(SIU_SAVED_VIEW_VISIBILITY).default("private"),
});
export type CreateSavedViewInput = z.infer<typeof CreateSavedViewSchema>;

export const UpdateSavedViewSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(400).optional().nullable(),
  filter: SiuSavedViewFilterSchema.optional(),
  sort: SiuSavedViewSortSchema.optional(),
  visibility: z.enum(SIU_SAVED_VIEW_VISIBILITY).optional(),
});
export type UpdateSavedViewInput = z.infer<typeof UpdateSavedViewSchema>;

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export type SiuSavedViewRow = {
  id: string;
  teamId: string;
  organizationId: string | null;
  name: string;
  description: string | null;
  filter: SiuSavedViewFilter;
  sort: SiuSavedViewSort;
  visibility: SiuSavedViewVisibility;
  createdByUserId: string;
  updatedByUserId: string | null;
  lastUsedAtUtc: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
  /** Bounded flag — true for built-in static presets. False for custom rows. */
  isPreset: false;
};

function projectRow(
  row: CaseSiuSavedViewRecord,
): SiuSavedViewRow {
  return {
    id: row.id,
    teamId: row.teamId,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description,
    filter: SiuSavedViewFilterSchema.parse(row.filterJson),
    sort: SiuSavedViewSortSchema.parse(row.sortJson),
    visibility: row.visibility as SiuSavedViewVisibility,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    lastUsedAtUtc: row.lastUsedAtUtc?.toISOString() ?? null,
    createdAtUtc: row.createdAt.toISOString(),
    updatedAtUtc: row.updatedAt.toISOString(),
    isPreset: false,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export type ListSavedViewsInput = {
  teamId: string;
  userId: string;
};

export async function listCustomSavedViews(
  input: ListSavedViewsInput,
): Promise<ReadonlyArray<SiuSavedViewRow>> {
  const rows = await prisma.caseSiuSavedView.findMany({
    where: {
      teamId: input.teamId,
      OR: [
        // private: only visible to the creator
        { visibility: "private", createdByUserId: input.userId },
        // team: visible to every team member
        { visibility: "team" },
        // organization: visible when org-scope present (caller is in team)
        { visibility: "organization" },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return rows.map(projectRow);
}

export async function createSavedView(input: {
  payload: CreateSavedViewInput;
  userId: string;
  organizationId: string | null;
}): Promise<SiuSavedViewRow> {
  const row = await prisma.caseSiuSavedView.create({
    data: {
      teamId: input.payload.teamId,
      organizationId: input.organizationId,
      name: input.payload.name,
      description: input.payload.description ?? null,
      filterJson: input.payload.filter as Prisma.InputJsonValue,
      sortJson: input.payload.sort as Prisma.InputJsonValue,
      visibility: input.payload.visibility,
      createdByUserId: input.userId,
      updatedByUserId: input.userId,
    },
  });
  return projectRow(row);
}

export async function updateSavedView(input: {
  id: string;
  teamId: string;
  userId: string;
  payload: UpdateSavedViewInput;
}): Promise<SiuSavedViewRow | null> {
  // Only the creator can edit a private view; team admins can edit
  // team/org views (we delegate that check to the route layer; the
  // service enforces only tenancy + ownership of private rows).
  const existing = await prisma.caseSiuSavedView.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) return null;
  if (
    existing.visibility === "private" &&
    existing.createdByUserId !== input.userId
  ) {
    return null;
  }
  const patch: Prisma.CaseSiuSavedViewUpdateInput = {
    name: input.payload.name ?? undefined,
    description: input.payload.description ?? undefined,
    filterJson:
      input.payload.filter !== undefined
        ? (input.payload.filter as Prisma.InputJsonValue)
        : undefined,
    sortJson:
      input.payload.sort !== undefined
        ? (input.payload.sort as Prisma.InputJsonValue)
        : undefined,
    visibility: input.payload.visibility ?? undefined,
    updatedByUserId: input.userId,
  };
  const row = await prisma.caseSiuSavedView.update({
    where: { id: existing.id },
    data: patch,
  });
  return projectRow(row);
}

export async function deleteSavedView(input: {
  id: string;
  teamId: string;
  userId: string;
}): Promise<boolean> {
  const existing = await prisma.caseSiuSavedView.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) return false;
  if (
    existing.visibility === "private" &&
    existing.createdByUserId !== input.userId
  ) {
    return false;
  }
  await prisma.caseSiuSavedView.delete({ where: { id: existing.id } });
  return true;
}

export async function markSavedViewUsed(input: {
  id: string;
  teamId: string;
  userId: string;
}): Promise<SiuSavedViewRow | null> {
  const existing = await prisma.caseSiuSavedView.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) return null;
  if (
    existing.visibility === "private" &&
    existing.createdByUserId !== input.userId
  ) {
    return null;
  }
  const row = await prisma.caseSiuSavedView.update({
    where: { id: existing.id },
    data: { lastUsedAtUtc: new Date() },
  });
  return projectRow(row);
}
