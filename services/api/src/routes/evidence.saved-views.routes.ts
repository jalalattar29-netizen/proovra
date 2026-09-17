/**
 * Phase G4.5 — Evidence Saved Views routes (extracted).
 *
 * Hosts the five `/v1/evidence/saved-views` route handlers that
 * previously lived inside the 10,950-line `evidence.routes.ts`. The
 * extraction is PURELY mechanical:
 *
 *   * Same URLs (`/v1/evidence/saved-views`, `/:id`, `/:id/default`).
 *   * Same auth (`requireAuth`).
 *   * Same Zod schemas (`SavedViewFiltersSchema`, `CreateSavedViewBody`,
 *     `UpdateSavedViewBody`).
 *   * Same response shapes (`{ items }`, `{ savedView }`, `{ deleted }`).
 *   * Same status codes (200 / 201 / 403 / 404).
 *   * No audit / custody side effects (saved views never emit
 *     custody events — they're per-operator UI bookmarks).
 *
 * Hard rules:
 *   * No semantic changes. The handlers are byte-equivalent (modulo
 *     formatting) to the originals.
 *   * The new module is registered from `evidenceRoutes(app)` so
 *     route registration order is preserved.
 *   * One tiny private helper (`toJsonSafe`) is duplicated here rather
 *     than exported from the parent — the duplication keeps module
 *     boundaries clean. (D57 retired the local `getTeamMembershipRole`:
 *     mutations are gated by the canonical workspace primitive in
 *     `assertSavedViewAccess`.)
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma } from "../db.js";
import {
  authorizeOrFail,
  evaluateAuthorizedWorkspace,
} from "../middleware/authorize.js";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";

// ---------------------------------------------------------------------------
// Schemas (verbatim port from evidence.routes.ts pre-G4.5).
// ---------------------------------------------------------------------------

const SavedViewFiltersSchema = z.object({
  search: z.string().max(160).optional().default(""),
  scope: z
    .enum(["active", "archived", "deleted", "locked"])
    .optional()
    .default("active"),
  status: z.string().max(64).optional().default("all"),
  type: z.string().max(64).optional().default("all"),
  review: z.string().max(64).optional().default("all"),
  exportReadiness: z.string().max(64).optional().default("all"),
  caseAssignment: z.string().max(64).optional().default("all"),
  retention: z.string().max(64).optional().default("all"),
  // Phase R8 (F15) — trust-signal filters. The evidence LIST endpoint
  // fully supports filtering by these (evidence.routes.ts:2224-2246 via
  // inOrEq / parseEvidenceMultiEnumFilter), but this saved-view schema
  // previously omitted them, so Zod silently STRIPPED them on save —
  // a saved/deep-linked view then returned different results than the
  // filters the user actually applied. Same string shape as the sibling
  // multi-enum filters above (comma-joined values, default "all").
  tsaStatus: z.string().max(160).optional().default("all"),
  otsStatus: z.string().max(160).optional().default("all"),
  publicVerifyState: z.string().max(160).optional().default("all"),
  verificationStatus: z.string().max(160).optional().default("all"),
  sort: z.string().max(64).optional().default("newest"),
});

const CreateSavedViewBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).optional().nullable(),
  teamId: z.string().uuid().optional().nullable(),
  scope: z.enum(["active", "archived", "deleted", "locked"]),
  filters: SavedViewFiltersSchema,
  sortKey: z.string().trim().max(64).optional().nullable(),
  isDefault: z.boolean().optional().default(false),
});

const UpdateSavedViewBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(400).optional().nullable(),
  scope: z.enum(["active", "archived", "deleted", "locked"]).optional(),
  filters: SavedViewFiltersSchema.optional(),
  sortKey: z.string().trim().max(64).optional().nullable(),
  isDefault: z.boolean().optional(),
});

type ParamsId = { id: string };

// ---------------------------------------------------------------------------
// Private helpers — kept verbatim from evidence.routes.ts so the
// extraction is byte-equivalent. See module-level docstring.
// ---------------------------------------------------------------------------

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}

function savedViewError(statusCode: 403 | 404): Error & { statusCode: number } {
  const err = new Error(
    statusCode === 404 ? "Saved view not found" : "Forbidden",
  ) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/**
 * The gate for every MUTATION of a saved view (PATCH, DELETE, set-default).
 *
 * D57 — the rule the reviewer-ops, search and SIU saved-view families apply:
 *
 *   - a PERSONAL view (no team) belongs to its creator alone; anyone else is
 *     told exactly what a missing id is told (404) — they cannot list it, so
 *     a 403 would confirm it exists;
 *   - a TEAM view needs an ACTIVE membership of a live workspace, decided by
 *     the canonical workspace primitive. An outsider, a suspended or revoked
 *     member (the creator included) and a member of a suspended Organization
 *     cannot list the view either, and get the same 404;
 *   - among the members who CAN see it, only its creator or a workspace
 *     OWNER/ADMIN may change it. Any other member is told 403 — they already
 *     see the view in their list, so there is nothing to conceal.
 *
 * Before this, the creator short-circuit ran before any membership check and
 * any member of the view's team could rename, re-filter, delete or re-default
 * a colleague's team view.
 */
async function assertSavedViewAccess(
  req: FastifyRequest,
  userId: string,
  savedViewId: string,
) {
  const savedView = await prisma.evidenceSavedView.findUnique({
    where: { id: savedViewId },
  });

  if (!savedView) throw savedViewError(404);

  if (!savedView.teamId) {
    if (savedView.ownerUserId !== userId) throw savedViewError(404);
    return savedView;
  }

  const outcome = await evaluateAuthorizedWorkspace(req, {
    workspaceId: savedView.teamId,
    permission: "evidence.read",
    resourceKind: "evidence_saved_view",
    resourceId: savedView.id,
    antiEnumeration: true,
  });
  if (!outcome.allowed) {
    // Authorization that could not be evaluated fails closed as a fault, not
    // as a statement about the view.
    if (outcome.httpStatus === 503) {
      throw new Error("Saved view authorization unavailable");
    }
    // Everyone else who cannot see the view is told it does not exist.
    throw savedViewError(404);
  }
  const role = outcome.context.workspaceRole;
  if (
    savedView.ownerUserId === outcome.context.userId ||
    role === "OWNER" ||
    role === "ADMIN"
  ) {
    return savedView;
  }
  throw savedViewError(403);
}

function mapEvidenceSavedView(savedView: {
  id: string;
  ownerUserId: string;
  teamId: string | null;
  name: string;
  description: string | null;
  filtersJson: Prisma.JsonValue;
  sortKey: string | null;
  scope: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: savedView.id,
    ownerUserId: savedView.ownerUserId,
    teamId: savedView.teamId,
    name: savedView.name,
    description: savedView.description ?? null,
    filters: toJsonSafe(savedView.filtersJson),
    sortKey: savedView.sortKey ?? null,
    scope: savedView.scope,
    isDefault: savedView.isDefault,
    createdAt: savedView.createdAt.toISOString(),
    updatedAt: savedView.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route registration.
// ---------------------------------------------------------------------------

export async function evidenceSavedViewsRoutes(app: FastifyInstance) {
  app.get(
    "/v1/evidence/saved-views",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      // PHASE 1 (2026-07-21) — this personal aggregation of the caller's own
      // saved views is NOT a per-workspace authorization gate; it scopes the
      // list to teams the caller belongs to. Restrict to ACTIVE memberships so
      // a suspended member no longer sees that team's shared views.
      const memberTeams = await prisma.teamMember.findMany({
        where: { userId, status: "ACTIVE" },
        select: { teamId: true },
      });
      const memberTeamIds = memberTeams.map((item) => item.teamId);

      const items = await prisma.evidenceSavedView.findMany({
        where: {
          OR: [
            { ownerUserId: userId },
            ...(memberTeamIds.length > 0
              ? [{ teamId: { in: memberTeamIds } }]
              : []),
          ],
        },
        orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      });

      return reply.code(200).send({
        items: items.map(mapEvidenceSavedView),
      });
    },
  );

  app.post(
    "/v1/evidence/saved-views",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      const body = CreateSavedViewBody.parse(req.body);

      if (body.teamId) {
        // PHASE 1 (2026-07-21) — creating a team-scoped saved view is gated by
        // the canonical primitive (ACTIVE membership + org lifecycle +
        // evidence.read + fail-closed + anti-enumeration 404).
        const authz = await authorizeOrFail(req, reply, {
          teamId: body.teamId,
          permission: "evidence.read",
          antiEnumeration: true,
        });
        if (!authz) return;
      }

      if (body.isDefault) {
        await prisma.evidenceSavedView.updateMany({
          where: {
            ownerUserId: userId,
            teamId: body.teamId ?? null,
            isDefault: true,
          },
          data: { isDefault: false },
        });
      }

      const created = await prisma.evidenceSavedView.create({
        data: {
          ownerUserId: userId,
          teamId: body.teamId ?? null,
          name: body.name,
          description: body.description ?? null,
          filtersJson: body.filters as Prisma.InputJsonValue,
          sortKey: body.sortKey ?? null,
          scope: body.scope,
          isDefault: body.isDefault,
        },
      });

      return reply
        .code(201)
        .send({ savedView: mapEvidenceSavedView(created) });
    },
  );

  app.patch(
    "/v1/evidence/saved-views/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = UpdateSavedViewBody.parse(req.body);
      const savedView = await assertSavedViewAccess(req, userId, id);

      if (body.isDefault === true) {
        await prisma.evidenceSavedView.updateMany({
          where: {
            ownerUserId: savedView.ownerUserId,
            teamId: savedView.teamId,
            isDefault: true,
          },
          data: { isDefault: false },
        });
      }

      const updated = await prisma.evidenceSavedView.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description ?? null }
            : {}),
          ...(body.scope !== undefined ? { scope: body.scope } : {}),
          ...(body.filters !== undefined
            ? { filtersJson: body.filters as Prisma.InputJsonValue }
            : {}),
          ...(body.sortKey !== undefined
            ? { sortKey: body.sortKey ?? null }
            : {}),
          ...(body.isDefault !== undefined
            ? { isDefault: body.isDefault }
            : {}),
        },
      });

      return reply
        .code(200)
        .send({ savedView: mapEvidenceSavedView(updated) });
    },
  );

  app.delete(
    "/v1/evidence/saved-views/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      await assertSavedViewAccess(req, userId, id);
      await prisma.evidenceSavedView.delete({ where: { id } });
      return reply.code(200).send({ deleted: true });
    },
  );

  app.post(
    "/v1/evidence/saved-views/:id/default",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const savedView = await assertSavedViewAccess(req, userId, id);

      await prisma.$transaction([
        prisma.evidenceSavedView.updateMany({
          where: {
            ownerUserId: savedView.ownerUserId,
            teamId: savedView.teamId,
            isDefault: true,
          },
          data: { isDefault: false },
        }),
        prisma.evidenceSavedView.update({
          where: { id },
          data: { isDefault: true },
        }),
      ]);

      const updated = await prisma.evidenceSavedView.findUniqueOrThrow({
        where: { id },
      });
      return reply
        .code(200)
        .send({ savedView: mapEvidenceSavedView(updated) });
    },
  );
}

// `prismaPkg` re-import — Prisma client surface stays consistent
// with the parent module so a future helper that needs the enum
// types (e.g. TeamRole) can pull from the same import path.
export { prismaPkg };
