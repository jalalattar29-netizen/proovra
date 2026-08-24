/**
 * OPERATIONS SAVED VIEWS.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT A NEW TABLE, AND NOT A NEW SERVICE PATTERN
 * ---------------------------------------------------------------------------
 * `SavedSearchView` already stores named, scoped, PRIVATE-or-TEAM queries for
 * two surfaces. Its `scope` column is a plain VARCHAR precisely so that a
 * third surface is a new discriminator rather than a new table — so this adds
 * no model, no migration and no second visibility model. It is the same shape
 * as `reviewer-ops/saved-queue-views.service.ts`, deliberately: two services
 * over one table that behaved differently would be the drift this reuse
 * exists to avoid.
 *
 * Every read and every write pins `scope = OPERATIONS`, so a search view and
 * an operations view can never appear in each other's list.
 *
 * ---------------------------------------------------------------------------
 * WHAT A VIEW STORES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * A view stores a QUESTION: the queue's filters, validated against the strict
 * schema that mirrors the queue route's own parameters. It stores no result
 * count, no timestamp of what was true when it was saved and no cached rows —
 * anything resembling an answer would be stale the instant it was written,
 * and a saved view showing a count from last week is worse than no count.
 *
 * `owner: "me"` is stored as the WORD. A shared view called "Mine" must mean
 * the reader's own work; resolving it to the author's id at save time would
 * make it permanently about one person while still being named for everyone.
 *
 * ---------------------------------------------------------------------------
 * VISIBILITY IS NOT A PERMISSION
 * ---------------------------------------------------------------------------
 * `TEAM` makes a view VISIBLE to the workspace. It grants nothing: replaying
 * one issues the ordinary queue read under the reader's own authority, so a
 * shared view held by an administrator shows a viewer exactly what that viewer
 * could already have filtered to by hand. A saved view that widened what its
 * reader could see would be an authority, and this is not one.
 */

import type { PrismaClient, SavedSearchView } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  OPERATIONS_SAVED_VIEW_SCOPE,
  OperationsSavedViewFilterSchema,
  type OperationsSavedViewFilter,
  type SavedViewVisibility,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export type OperationsSavedViewProjection = {
  id: string;
  name: string;
  description: string | null;
  visibility: SavedViewVisibility;
  pinned: boolean;
  createdByUserId: string;
  /** True when the READER owns it — the only one who may rename or delete it. */
  ownedByViewer: boolean;
  createdAt: string;
  /**
   * The optimistic-concurrency token.
   *
   * `updatedAt` IS the version: an update must send the value it read, and a
   * write whose token no longer matches is refused rather than applied. Two
   * operators editing one shared view otherwise produce a silent lost update —
   * the second save wins and the first person's change disappears with no
   * error anywhere.
   */
  updatedAt: string;
  filter: OperationsSavedViewFilter;
};

function projectView(
  row: SavedSearchView,
  viewerUserId: string,
): OperationsSavedViewProjection {
  // Re-validated on READ as well as on write. A row can predate a schema
  // change or have been edited by hand, and replaying an unvalidated filter
  // into the queue would apply something nobody chose. An unreadable filter
  // degrades to the workspace scope alone — the view still lists and still
  // opens, it simply carries no filter it cannot vouch for.
  const parsed = OperationsSavedViewFilterSchema.safeParse(row.queryJson);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility as SavedViewVisibility,
    pinned: row.pinned,
    createdByUserId: row.createdByUserId,
    ownedByViewer: row.createdByUserId === viewerUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    filter: parsed.success ? parsed.data : { teamId: row.teamId },
  };
}

export async function listOperationsSavedViews(
  input: { teamId: string; userId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<OperationsSavedViewProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await client.savedSearchView.findMany({
    where: {
      teamId: input.teamId,
      scope: OPERATIONS_SAVED_VIEW_SCOPE,
      // Mine, plus whatever the workspace shares. A PRIVATE view belonging to
      // somebody else is not listed, not counted and not addressable.
      OR: [{ createdByUserId: input.userId }, { visibility: "TEAM" }],
    },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    take: limit,
  });
  return rows.map((r) => projectView(r, input.userId));
}

export type CreateOperationsSavedViewInput = {
  teamId: string;
  actorUserId: string;
  name: string;
  description?: string | null;
  visibility: SavedViewVisibility;
  pinned?: boolean;
  filter: OperationsSavedViewFilter;
};

export type CreateOperationsSavedViewResult =
  | { ok: true; view: OperationsSavedViewProjection }
  | { ok: false; reason: "duplicate_name" | "workspace_mismatch" };

export async function createOperationsSavedView(
  input: CreateOperationsSavedViewInput,
  client: PrismaClient = defaultPrisma,
): Promise<CreateOperationsSavedViewResult> {
  // The stored filter's own workspace must be the workspace it is stored in.
  // Without this a view could be saved into workspace A carrying a query
  // bound to workspace B — and it is the FILTER that gets replayed.
  if (input.filter.teamId !== input.teamId) {
    return { ok: false, reason: "workspace_mismatch" };
  }
  try {
    const row = await client.savedSearchView.create({
      data: {
        teamId: input.teamId,
        createdByUserId: input.actorUserId,
        name: input.name.trim().slice(0, 120),
        description: input.description?.trim().slice(0, 400) || null,
        visibility: input.visibility,
        pinned: input.pinned ?? false,
        scope: OPERATIONS_SAVED_VIEW_SCOPE,
        queryJson: input.filter as unknown as prismaPkg.Prisma.InputJsonValue,
      },
    });
    return { ok: true, view: projectView(row, input.actorUserId) };
  } catch {
    // The table's unique key is (team, creator, name). A collision is the
    // operator saving over their own view, which is a distinguishable answer
    // and not a failure — the route reports it as one.
    return { ok: false, reason: "duplicate_name" };
  }
}

export type UpdateOperationsSavedViewInput = {
  teamId: string;
  actorUserId: string;
  id: string;
  /** The `updatedAt` the caller read. A stale token is refused. */
  expectedUpdatedAt: string;
  name?: string;
  description?: string | null;
  visibility?: SavedViewVisibility;
  filter?: OperationsSavedViewFilter;
};

export type UpdateOperationsSavedViewResult =
  | { ok: true; view: OperationsSavedViewProjection }
  | {
      ok: false;
      reason: "not_found" | "conflict" | "duplicate_name" | "workspace_mismatch";
    };

/**
 * Rename, re-scope or re-filter one view.
 *
 * The WHERE clause carries the creator AND the expected `updatedAt`, so:
 *
 *   - somebody else's view is NOT FOUND rather than refused, since sharing a
 *     view exposes its results and must not also expose which ids exist;
 *   - a view that changed since the caller read it is a CONFLICT rather than
 *     an overwrite. The lost update this prevents is silent by nature: both
 *     saves succeed, and the first operator's change is simply gone.
 *
 * The two are distinguished by re-reading afterwards, so a conflict never
 * reports itself as a missing view — an operator told "not found" about a
 * view they are looking at will assume the product is broken.
 */
export async function updateOperationsSavedView(
  input: UpdateOperationsSavedViewInput,
  client: PrismaClient = defaultPrisma,
): Promise<UpdateOperationsSavedViewResult> {
  if (input.filter && input.filter.teamId !== input.teamId) {
    return { ok: false, reason: "workspace_mismatch" };
  }

  const expected = new Date(input.expectedUpdatedAt);
  if (Number.isNaN(expected.getTime())) return { ok: false, reason: "conflict" };

  try {
    const result = await client.savedSearchView.updateMany({
      where: {
        id: input.id,
        teamId: input.teamId,
        scope: OPERATIONS_SAVED_VIEW_SCOPE,
        createdByUserId: input.actorUserId,
        updatedAt: expected,
      },
      data: {
        ...(input.name !== undefined
          ? { name: input.name.trim().slice(0, 120) }
          : {}),
        ...(input.description !== undefined
          ? { description: input.description?.trim().slice(0, 400) || null }
          : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.filter !== undefined
          ? {
              queryJson: input.filter as unknown as prismaPkg.Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    if (result.count === 0) {
      // Nothing matched. Re-read WITHOUT the token to tell "gone" from
      // "changed underneath you", because those need different words.
      const still = await client.savedSearchView.findFirst({
        where: {
          id: input.id,
          teamId: input.teamId,
          scope: OPERATIONS_SAVED_VIEW_SCOPE,
          createdByUserId: input.actorUserId,
        },
      });
      return { ok: false, reason: still ? "conflict" : "not_found" };
    }

    const row = await client.savedSearchView.findFirstOrThrow({
      where: { id: input.id, teamId: input.teamId },
    });
    return { ok: true, view: projectView(row, input.actorUserId) };
  } catch {
    // The unique key is (team, creator, name): a rename onto a name the same
    // operator already uses is a distinguishable answer, not a failure.
    return { ok: false, reason: "duplicate_name" };
  }
}

/**
 * Delete one view.
 *
 * The WHERE clause carries the creator, so a view belonging to somebody else
 * is not found rather than refused: sharing a view exposes its results, and
 * exposing it must not also expose the ability to remove it. A workspace
 * administrator is not exempt — an admin who could silently delete a
 * colleague's saved view has an authority nobody asked for, and the colleague
 * would have no record of what happened.
 */
export async function deleteOperationsSavedView(
  input: { teamId: string; actorUserId: string; id: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const result = await client.savedSearchView.deleteMany({
    where: {
      id: input.id,
      teamId: input.teamId,
      scope: OPERATIONS_SAVED_VIEW_SCOPE,
      createdByUserId: input.actorUserId,
    },
  });
  return result.count > 0;
}
