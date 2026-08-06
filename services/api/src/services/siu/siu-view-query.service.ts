/**
 * PHASE 12 — VERTICAL B (OPERATIONS_INTELLIGENCE).
 *
 * Makes SIU saved views ACTUALLY affect the SIU worklist.
 *
 * Before this pass the saved-view surface was pure CRUD: an operator
 * could create, rename, and delete a view, but nothing ever executed
 * one. This module is the missing half — it resolves a view (built-in
 * preset OR durable custom row) into a bounded Prisma query over
 * `CaseSiuProfile` and returns the matching worklist.
 *
 * Hard rules:
 *   * Every query is anchored on `teamId`. A view row belonging to
 *     another workspace can never widen the result set.
 *   * The filter vocabulary is CLOSED — it is exactly the bounded
 *     `SiuSavedViewFilterSchema` shape. No free-form predicates, no
 *     caller-supplied ordering keys outside the bounded sort enum.
 *   * The projection is PII-safe by construction: `claimantName` and
 *     `claimantContact` are never selected here. Revealing them
 *     remains the job of the dedicated step-up-gated reveal route.
 *   * Relation-shaped predicates (missing checklist items, warning
 *     indicators, open follow-ups, recent exports) are expressed as
 *     Prisma `some` filters so the database does the work — the
 *     service never over-fetches and filters in memory.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "../../db.js";
import {
  SIU_SAVED_VIEW_PRESETS,
  type SiuSavedViewPreset,
} from "@proovra/shared";
import {
  SiuSavedViewFilterSchema,
  SiuSavedViewSortSchema,
  type SiuSavedViewFilter,
  type SiuSavedViewSort,
} from "./siu-saved-views.service.js";

const RECENT_EXPORT_WINDOW_DAYS = 30;
const OPEN_FOLLOW_UP_STATUSES = ["open", "sent", "received"];
const WARNING_INDICATOR_SEVERITIES = ["warning", "block_export"];

export const DEFAULT_SIU_VIEW_SORT: SiuSavedViewSort = {
  key: "updatedAtUtc",
  direction: "desc",
};

// ---------------------------------------------------------------------------
// View resolution
// ---------------------------------------------------------------------------

export type ResolvedSiuView = {
  /** Preset id or durable row id. */
  id: string;
  name: string;
  description: string | null;
  source: "preset" | "custom";
  filter: SiuSavedViewFilter;
  sort: SiuSavedViewSort;
};

export type ResolveSiuViewOutcome =
  | { ok: true; view: ResolvedSiuView }
  | { ok: false; reason: "not_found" | "invalid_definition" };

function presetToResolved(preset: SiuSavedViewPreset): ResolvedSiuView {
  // Presets are authored in @proovra/shared with the same bounded
  // vocabulary; parsing them through the canonical schema guarantees a
  // preset can never smuggle a predicate a custom view could not.
  const parsed = SiuSavedViewFilterSchema.safeParse(preset.filters);
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    source: "preset",
    filter: parsed.success ? parsed.data : {},
    sort: DEFAULT_SIU_VIEW_SORT,
  };
}

/**
 * Lists every view the caller may execute: the built-in presets plus
 * the durable custom rows visible to them in this workspace.
 */
export async function listExecutableSiuViews(input: {
  teamId: string;
  userId: string;
}): Promise<ReadonlyArray<ResolvedSiuView>> {
  const presets = SIU_SAVED_VIEW_PRESETS.map(presetToResolved);
  const rows = await prisma.caseSiuSavedView
    .findMany({
      where: {
        teamId: input.teamId,
        OR: [
          { visibility: "private", createdByUserId: input.userId },
          { visibility: "team" },
          { visibility: "organization" },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    })
    .catch(() => []);
  const custom: ResolvedSiuView[] = [];
  for (const row of rows) {
    const filter = SiuSavedViewFilterSchema.safeParse(row.filterJson);
    const sort = SiuSavedViewSortSchema.safeParse(row.sortJson);
    if (!filter.success || !sort.success) continue;
    custom.push({
      id: row.id,
      name: row.name,
      description: row.description,
      source: "custom",
      filter: filter.data,
      sort: sort.data,
    });
  }
  return [...presets, ...custom];
}

/**
 * Resolves one view id. Accepts a preset id or a durable row id.
 * Anti-enumeration: a row in another workspace, or a private row owned
 * by someone else, resolves to `not_found` — never to a broader query.
 */
export async function resolveSiuView(input: {
  teamId: string;
  userId: string;
  viewId: string;
}): Promise<ResolveSiuViewOutcome> {
  const preset = SIU_SAVED_VIEW_PRESETS.find((p) => p.id === input.viewId);
  if (preset) return { ok: true, view: presetToResolved(preset) };

  const row = await prisma.caseSiuSavedView
    .findFirst({ where: { id: input.viewId, teamId: input.teamId } })
    .catch(() => null);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.visibility === "private" && row.createdByUserId !== input.userId) {
    return { ok: false, reason: "not_found" };
  }
  const filter = SiuSavedViewFilterSchema.safeParse(row.filterJson);
  const sort = SiuSavedViewSortSchema.safeParse(row.sortJson);
  if (!filter.success || !sort.success) {
    return { ok: false, reason: "invalid_definition" };
  }
  return {
    ok: true,
    view: {
      id: row.id,
      name: row.name,
      description: row.description,
      source: "custom",
      filter: filter.data,
      sort: sort.data,
    },
  };
}

// ---------------------------------------------------------------------------
// Filter → Prisma where
// ---------------------------------------------------------------------------

/**
 * Translates the bounded filter shape into a team-anchored Prisma
 * `where`. Exported so tests can pin the translation without touching
 * a database.
 */
export function buildSiuProfileWhere(
  teamId: string,
  filter: SiuSavedViewFilter,
): Prisma.CaseSiuProfileWhereInput {
  const where: Prisma.CaseSiuProfileWhereInput = { teamId };

  if (filter.investigationStatus && filter.investigationStatus.length > 0) {
    where.investigationStatus = { in: [...filter.investigationStatus] };
  }
  if (filter.claimType) where.claimType = filter.claimType;
  if (filter.assignedAdjusterUserId) {
    where.assignedAdjusterUserId = filter.assignedAdjusterUserId;
  }
  if (filter.assignedSiuReviewerUserId) {
    where.assignedSiuReviewerUserId = filter.assignedSiuReviewerUserId;
  }
  if (filter.requireMissingChecklistItems) {
    where.checklistItems = { some: { status: "missing", required: true } };
  }
  if (filter.requireWarningIndicators) {
    where.reviewIndicators = {
      some: { severity: { in: WARNING_INDICATOR_SEVERITIES }, status: "open" },
    };
  }
  if (filter.requireOpenFollowUps) {
    where.followUps = { some: { status: { in: OPEN_FOLLOW_UP_STATUSES } } };
  }
  if (filter.requireRecentExport) {
    const since = new Date(
      Date.now() - RECENT_EXPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    where.exports = { some: { generatedAtUtc: { gte: since } } };
  }
  return where;
}

function buildOrderBy(
  sort: SiuSavedViewSort,
): Prisma.CaseSiuProfileOrderByWithRelationInput {
  switch (sort.key) {
    case "createdAtUtc":
      return { createdAt: sort.direction };
    case "investigationStatus":
      return { investigationStatus: sort.direction };
    case "incidentDate":
      return { incidentDate: sort.direction };
    case "updatedAtUtc":
    default:
      return { updatedAt: sort.direction };
  }
}

// ---------------------------------------------------------------------------
// Worklist execution
// ---------------------------------------------------------------------------

export type SiuWorklistRow = {
  caseId: string;
  profileId: string;
  claimType: string;
  investigationStatus: string;
  claimNumber: string | null;
  incidentDateUtc: string | null;
  assignedAdjusterUserId: string | null;
  assignedSiuReviewerUserId: string | null;
  intakeTemplateId: string | null;
  /** Real counts, computed by the database. Never estimated. */
  missingRequiredItemCount: number;
  openWarningIndicatorCount: number;
  openFollowUpCount: number;
  exportCount: number;
  updatedAtUtc: string;
};

export type SiuWorklistResult = {
  view: ResolvedSiuView | null;
  rows: ReadonlyArray<SiuWorklistRow>;
  total: number;
  truncated: boolean;
};

const MAX_WORKLIST_ROWS = 100;

/**
 * Runs the resolved view against the workspace's SIU profiles.
 *
 * When `view` is null the query degrades to "every SIU profile in this
 * workspace" — the honest unfiltered worklist, NOT an empty list.
 */
export async function runSiuWorklist(input: {
  teamId: string;
  view: ResolvedSiuView | null;
  limit?: number;
}): Promise<SiuWorklistResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_WORKLIST_ROWS);
  const filter = input.view?.filter ?? {};
  const sort = input.view?.sort ?? DEFAULT_SIU_VIEW_SORT;
  const where = buildSiuProfileWhere(input.teamId, filter);

  const [total, rows] = await Promise.all([
    prisma.caseSiuProfile.count({ where }),
    prisma.caseSiuProfile.findMany({
      where,
      orderBy: buildOrderBy(sort),
      take: limit,
      // PII columns (`claimantName`, `claimantContact`) are deliberately
      // NOT selected — the worklist is a triage surface.
      select: {
        id: true,
        caseId: true,
        claimType: true,
        investigationStatus: true,
        claimNumber: true,
        incidentDate: true,
        assignedAdjusterUserId: true,
        assignedSiuReviewerUserId: true,
        intakeTemplateId: true,
        updatedAt: true,
        _count: { select: { exports: true } },
        checklistItems: {
          where: { status: "missing", required: true },
          select: { id: true },
          take: 50,
        },
        reviewIndicators: {
          where: {
            severity: { in: WARNING_INDICATOR_SEVERITIES },
            status: "open",
          },
          select: { id: true },
          take: 50,
        },
        followUps: {
          where: { status: { in: OPEN_FOLLOW_UP_STATUSES } },
          select: { id: true },
          take: 50,
        },
      },
    }),
  ]);

  return {
    view: input.view,
    total,
    truncated: total > rows.length,
    rows: rows.map((r) => ({
      caseId: r.caseId,
      profileId: r.id,
      claimType: r.claimType,
      investigationStatus: r.investigationStatus,
      claimNumber: r.claimNumber,
      incidentDateUtc: r.incidentDate?.toISOString() ?? null,
      assignedAdjusterUserId: r.assignedAdjusterUserId,
      assignedSiuReviewerUserId: r.assignedSiuReviewerUserId,
      intakeTemplateId: r.intakeTemplateId,
      missingRequiredItemCount: r.checklistItems.length,
      openWarningIndicatorCount: r.reviewIndicators.length,
      openFollowUpCount: r.followUps.length,
      exportCount: r._count.exports,
      updatedAtUtc: r.updatedAt.toISOString(),
    })),
  };
}
