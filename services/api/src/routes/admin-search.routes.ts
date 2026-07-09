/**
 * Platform Control Center (item I) — Global Search route.
 *
 * ONE READ-ONLY, platform-admin-only endpoint that fans a bounded search
 * across the core platform entities and returns uniform, link-first,
 * secret-free results. Gated by `requirePlatformAdmin`. NOTHING here
 * mutates state, recomputes an evidence hash, touches custody / signing /
 * reports / packages / billing / the tenant model. Pure aggregation.
 *
 *   GET /v1/admin/search?q=&types=&limit=
 *     - q      : the search needle (min length 2, trimmed, bounded).
 *     - types  : optional CSV of entity types to restrict the search to.
 *                Unknown types are ignored; empty → all types.
 *     - limit  : optional per-type result cap (bounded 1..50, default 10).
 *
 * Safety: the aggregation service selects ONLY non-secret columns. No
 * password hash, no token, no evidence file bytes / hash-derived secret, no
 * storageKey/bucket ever crosses the wire. Evidence exposes ID + title /
 * filename metadata ONLY. The single permitted PII field is email /
 * workEmail — already shown on the existing admin roster pages.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import {
  adminGlobalSearch,
  ALL_SEARCH_TYPES,
  type AdminSearchType,
} from "../services/admin/search.service.js";

const MIN_QUERY_LENGTH = 2;

const SearchQuery = z.object({
  q: z.string().trim().min(MIN_QUERY_LENGTH).max(200),
  // Comma-separated entity types; parsed and filtered to the known set.
  types: z.string().trim().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
});

function parseTypes(raw: string | undefined): AdminSearchType[] | undefined {
  if (!raw) return undefined;
  const known = new Set<string>(ALL_SEARCH_TYPES);
  const picked = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => known.has(s)) as AdminSearchType[];
  return picked.length > 0 ? picked : undefined;
}

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- every route in this plugin is
// gated by requirePlatformAdmin and reads GLOBAL cross-tenant aggregates. It is
// intentionally NOT scoped to a single tenant; the platform-admin gate IS the
// authorization boundary. No per-tenant authorizeOrFail applies here.
export async function adminSearchRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/admin/search — bounded, read-only, secret-free global search.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/search",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = SearchQuery.safeParse(req.query);
      if (!parsed.success) {
        // Honest, structured validation error. A too-short/empty query is a
        // 400 here — the UI enforces the same min-length before calling.
        return reply.code(400).send({
          error: {
            code: "validation_error",
            message: `Query must be at least ${MIN_QUERY_LENGTH} characters.`,
            detail: parsed.error.flatten(),
          },
        });
      }

      const { q, types, limit } = parsed.data;

      const result = await adminGlobalSearch({
        query: q,
        types: parseTypes(types),
        perTypeLimit: limit,
      });

      return reply.code(200).send(result);
    },
  );
}

export default adminSearchRoutes;
