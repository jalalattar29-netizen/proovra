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
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
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

/** A complete v1-v8 UUID, which is the only identifier shape this API issues. */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/**
 * Is this term an identifier, an attempt at one, or neither?
 *
 * The middle case is the one that matters. "Identifier-shaped" is deliberately
 * narrow: hex digits and hyphens only, and either containing a hyphen or long
 * enough that nobody types it as a name. `a1b2c3d4-0000` is an attempt;
 * `Northwind Legal` and `not-a-real-thing` are not, because the latter carries
 * letters outside the hex alphabet and so could never be a truncated id.
 *
 * Getting this wrong in the permissive direction would reject legitimate name
 * searches, so the rule errs toward treating a term as a name.
 */
export function classifyIdentifierAttempt(
  q: string,
): "EXACT" | "MALFORMED" | "NOT_AN_IDENTIFIER" {
  const term = q.trim();
  if (UUID_RE.test(term)) return "EXACT";
  const hexish = /^[0-9a-fA-F-]+$/.test(term);
  if (!hexish) return "NOT_AN_IDENTIFIER";
  // Hex-and-hyphens only. A hyphen, or 16+ characters, means somebody is
  // pasting an id rather than typing a word.
  if (term.includes("-") || term.length >= 16) return "MALFORMED";
  return "NOT_AN_IDENTIFIER";
}

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

      /*
       * A MALFORMED IDENTIFIER IS A 400, NOT AN EMPTY PAGE.
       *
       * This surface answers two different questions with one box: free-text
       * NAME search, and EXACT identifier lookup. Only exact identifiers are
       * supported — there is no prefix matching, deliberately, because a
       * prefix over UUIDs has no useful collision story and a partial match
       * on an id is a guess about which record an operator meant.
       *
       * The old behaviour returned `200` with `total: 0` for a truncated
       * UUID, which is the same response a valid-but-absent id gets. Those
       * are opposite facts — "you typed half an id" and "that record does not
       * exist" — and an operator pasting a clipped id from a log had no way
       * to tell which had happened. A term that is clearly an identifier
       * ATTEMPT and is not a complete one is now refused with a typed code.
       *
       * A term that is not identifier-shaped at all stays a name search: it
       * is not a malformed identifier, it is a different query.
       */
      const idAttempt = classifyIdentifierAttempt(q);
      if (idAttempt === "MALFORMED") {
        return reply.code(400).send({
          error: {
            code: "INVALID_IDENTIFIER",
            message:
              "Identifier lookups must use a complete id. Partial identifiers are not matched — paste the whole value, or search by name instead.",
          },
        });
      }

      const result = await adminGlobalSearch({
        query: q,
        types: parseTypes(types),
        perTypeLimit: limit,
      });

      // ADM-022 — global search IS audited, because "who looked up whom" is
      // exactly the accountability signal an audit log exists to carry. A
      // platform admin can find any person on the platform by email from here;
      // that lookup must leave a trace naming the operator and the term.
      //
      // The ROSTERS are deliberately not audited — they are bounded pages of
      // metadata with no single subject, and a row per page render buries the
      // targeted reads that matter. This is the same rule the user- and
      // workspace-detail routes follow, applied to the one aggregate read that
      // takes an operator-supplied term.
      await emitPlatformAudit({
        action: "admin.global_search_performed",
        outcome: "success",
        sourceApp: "API",
        actorUserId: req.user?.sub ?? null,
        resourceType: "platform_search",
        resourceId: null,
        correlationId: req.id,
        metadata: {
          // The TERM, because that is the point of the record. No result rows,
          // no identifiers of what was found — the search surface already
          // returns those to the caller, and duplicating them here would put a
          // second copy of subject data in the audit log.
          query: q,
          types: parseTypes(types) ?? null,
          resultGroups: result.groups?.length ?? 0,
        },
      }).catch(() => null);

      return reply.code(200).send(result);
    },
  );
}

export default adminSearchRoutes;
