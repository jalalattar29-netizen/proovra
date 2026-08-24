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
 * VISIBILITY IS NOT A PERMISSION — IN EITHER DIRECTION
 * ---------------------------------------------------------------------------
 * `TEAM` makes a view VISIBLE to the workspace. It grants nothing: replaying
 * one issues the ordinary queue read under the reader's own authority, so a
 * shared view held by an administrator shows a viewer exactly what that viewer
 * could already have filtered to by hand.
 *
 * The converse also holds, and it is what this module now enforces: being able
 * to READ the queue does not confer the right to PUBLISH configuration into
 * it. A TEAM view appears in every authorized colleague's toolbar, so creating
 * or changing one is an administrative act over shared state — the same class
 * of decision as assignment or suppression — and it requires
 * `operations.saved_views.manage`.
 *
 * ---------------------------------------------------------------------------
 * TWO OWNERSHIP MODELS, DELIBERATELY DIFFERENT
 * ---------------------------------------------------------------------------
 * PRIVATE  strictly CREATOR-owned, with no administrative override at all. An
 *          administrator cannot read, rename or delete somebody else's private
 *          bookmark; "admin" is authority over the WORKSPACE, not over a
 *          colleague's own working notes.
 *
 * TEAM     managed by anyone holding the management capability in that
 *          workspace, including an administrator who did not create it. The
 *          alternative — creator-only — strands shared configuration the
 *          moment somebody leaves, which is precisely when a workspace most
 *          needs to be able to clean it up.
 *
 * An administrator acting on somebody else's TEAM view does NOT become its
 * creator: `createdByUserId` is preserved and the audit event records the
 * real actor alongside it, so the history says who made it and who changed it.
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

/**
 * Whether the caller may manage SHARED views in this workspace.
 *
 * Passed in as a resolved boolean rather than looked up here, so there is one
 * authorization authority (the route's `evaluateMemberAccess`) and this
 * service cannot drift into being a second one.
 */
export type SavedViewAuthority = {
  canManageShared: boolean;
};

export type CreateOperationsSavedViewInput = {
  teamId: string;
  actorUserId: string;
  name: string;
  description?: string | null;
  visibility: SavedViewVisibility;
  pinned?: boolean;
  filter: OperationsSavedViewFilter;
} & SavedViewAuthority;

export type CreateOperationsSavedViewResult =
  | { ok: true; view: OperationsSavedViewProjection }
  | {
      ok: false;
      reason: "duplicate_name" | "workspace_mismatch" | "not_permitted";
    };

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
  // Publishing into every colleague's toolbar is an administrative act.
  // PRIVATE is deliberately unguarded: a bookmark nobody else can see is not
  // shared state, and gating it would make the feature useless to readers.
  if (input.visibility === "TEAM" && !input.canManageShared) {
    return { ok: false, reason: "not_permitted" };
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
} & SavedViewAuthority;

export type UpdateOperationsSavedViewResult =
  | {
      ok: true;
      view: OperationsSavedViewProjection;
      /** True when an administrator acted on somebody else's shared view. */
      adminOverride: boolean;
      /** Preserved through the write, for the audit record. */
      creatorUserId: string;
      previousVisibility: SavedViewVisibility;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "conflict"
        | "duplicate_name"
        | "workspace_mismatch"
        | "not_permitted";
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

  // Resolve the row FIRST, under tenant scope only.
  //
  // The ownership rule depends on the row's VISIBILITY, so it cannot be
  // expressed as a single WHERE clause: PRIVATE is creator-only, TEAM is
  // manageable by any holder of the capability. Reading first also lets a
  // refusal distinguish "you may not" from "it is not there", which are
  // different sentences an operator needs.
  const existing = await client.savedSearchView.findFirst({
    where: {
      id: input.id,
      teamId: input.teamId,
      scope: OPERATIONS_SAVED_VIEW_SCOPE,
    },
  });

  // Not in this workspace at all. 404 for a cross-tenant id, so a probe
  // learns nothing about which ids exist elsewhere.
  if (!existing) return { ok: false, reason: "not_found" };

  const isOwner = existing.createdByUserId === input.actorUserId;
  const isShared = existing.visibility === "TEAM";

  // PRIVATE: strictly the creator's, with NO administrative override.
  // Somebody else's private bookmark is NOT FOUND rather than forbidden —
  // "admin" is authority over the workspace, not over a colleague's own
  // working notes, and confirming the id exists would already be too much.
  if (!isShared && !isOwner) return { ok: false, reason: "not_found" };

  // TEAM: visible to the workspace, so its existence is not a secret. A
  // caller without the capability is told plainly that they may not act.
  if (isShared && !input.canManageShared) {
    return { ok: false, reason: "not_permitted" };
  }

  // Converting a PRIVATE view to TEAM is a publish, and needs the same
  // authority creating one does.
  if (
    input.visibility === "TEAM" &&
    existing.visibility !== "TEAM" &&
    !input.canManageShared
  ) {
    return { ok: false, reason: "not_permitted" };
  }

  try {
    const result = await client.savedSearchView.updateMany({
      where: {
        id: input.id,
        teamId: input.teamId,
        scope: OPERATIONS_SAVED_VIEW_SCOPE,
        // The concurrency token, and NOT the creator: authorization was
        // decided above against the visibility rule. Re-adding the creator
        // here would silently reinstate creator-only management for TEAM.
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
        // `createdByUserId` is deliberately NOT written. An administrator
        // managing somebody else's shared view does not become its author;
        // the history must still say who made it.
      },
    });

    if (result.count === 0) {
      // The row existed a moment ago and the id matched, so the only thing
      // that can have failed is the token: somebody else wrote first.
      return { ok: false, reason: "conflict" };
    }

    const row = await client.savedSearchView.findFirstOrThrow({
      where: { id: input.id, teamId: input.teamId },
    });
    return {
      ok: true,
      view: projectView(row, input.actorUserId),
      adminOverride: isShared && !isOwner,
      creatorUserId: existing.createdByUserId,
      previousVisibility: existing.visibility as SavedViewVisibility,
    };
  } catch {
    // The unique key is (team, creator, name): a rename onto a name the same
    // operator already uses is a distinguishable answer, not a failure.
    return { ok: false, reason: "duplicate_name" };
  }
}

/**
 * Delete one view.
 *
 * PRIVATE is strictly the creator's, with no administrative override:
 * somebody else's private bookmark is NOT FOUND, because confirming that an
 * id exists is already more than a caller who cannot act on it should learn.
 *
 * TEAM is manageable by any holder of the capability, including an
 * administrator who did not create it. Creator-only deletion would strand
 * shared configuration the moment somebody leaves the workspace — precisely
 * when it most needs cleaning up.
 */
export type DeleteOperationsSavedViewResult =
  | {
      ok: true;
      adminOverride: boolean;
      creatorUserId: string;
      visibility: SavedViewVisibility;
      name: string;
    }
  | { ok: false; reason: "not_found" | "not_permitted" };

export async function deleteOperationsSavedView(
  input: {
    teamId: string;
    actorUserId: string;
    id: string;
  } & SavedViewAuthority,
  client: PrismaClient = defaultPrisma,
): Promise<DeleteOperationsSavedViewResult> {
  const existing = await client.savedSearchView.findFirst({
    where: {
      id: input.id,
      teamId: input.teamId,
      scope: OPERATIONS_SAVED_VIEW_SCOPE,
    },
  });
  if (!existing) return { ok: false, reason: "not_found" };

  const isOwner = existing.createdByUserId === input.actorUserId;
  const isShared = existing.visibility === "TEAM";

  if (!isShared && !isOwner) return { ok: false, reason: "not_found" };
  if (isShared && !input.canManageShared) {
    return { ok: false, reason: "not_permitted" };
  }

  const result = await client.savedSearchView.deleteMany({
    where: {
      id: input.id,
      teamId: input.teamId,
      scope: OPERATIONS_SAVED_VIEW_SCOPE,
    },
  });
  if (result.count === 0) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    adminOverride: isShared && !isOwner,
    creatorUserId: existing.createdByUserId,
    visibility: existing.visibility as SavedViewVisibility,
    name: existing.name,
  };
}
