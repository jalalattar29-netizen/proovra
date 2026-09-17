/**
 * RETIRED — POST /v1/ai/search/nl answers a typed 410 (2026-09-16).
 * ---------------------------------------------------------------------------
 * Phase F1 "Enterprise Natural-Language Search" backed the "Ask in plain
 * language" card on /search. That card was withdrawn from every workspace type
 * (Personal Free, Personal Pro, OWNED, ORGANIZATION, Enterprise) after an audit
 * of what it actually displayed, and its only consumer
 * (apps/web/components/ai-copilot/NlSearchBox.tsx) was deleted in e2f5cf2d.
 * No caller remains in apps/web or apps/mobile. On 2026-09-16 the route was
 * proven obsolete and retired to a tombstone: it stays registered so a stale
 * client is told the capability is gone instead of receiving a 404, it keeps
 * authentication, and it does no work — no membership read, no parse, no
 * query, no audit row.
 *
 * WHAT THE AUDIT FOUND (why the handler was not kept "just in case").
 *
 *   1. DISPLAY NAMES WERE FABRICATED FOR TWO OF THE SEVEN STATE PRESETS.
 *      `REVIEW_BACKLOG` rendered `Review <id8>… (<status>)` and
 *      `REPORTS_RECENT` rendered `Report v<n>` while routing to
 *      `/evidence/:id` — neither read a name from the record it linked to.
 *      `REPORTS_RECENT` also reported the page length as the total.
 *
 *   2. THE STATE PRESETS BYPASSED EVERY VISIBILITY GATE.
 *      They queried evidence / review workflows / reports directly on
 *      `teamId` alone. The canonical `executeSearch` applies the
 *      reviewer-restriction gate in the WHERE and again per row; none of that
 *      ran here, so a non-reviewer received rows ordinary Search withholds.
 *      (Cross-WORKSPACE leakage was not possible — membership in the claimed
 *      workspace was verified first.)
 *
 * The one discovery path is ordinary Search (GET /v1/search), which applies
 * those gates. BEFORE natural-language search is offered again, all four must
 * be true, and it must be built on that path rather than by restoring this
 * handler from history:
 *
 *   - every preset resolves through the canonical authorized search path, so
 *     no preset can show a row ordinary Search would hide;
 *   - every row displays the canonical current display name of the record it
 *     links to, never a synthesised one;
 *   - `total` is a real count of the population, not the page length;
 *   - there is demonstrated user value over ordinary Search.
 *
 * The deterministic parser (`services/ai/nl-search-parser.service.ts`) is left
 * in place; it has no production caller after this retirement.
 * ---------------------------------------------------------------------------
 */
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

export async function aiSearchRoutes(app: FastifyInstance) {
  app.post("/v1/ai/search/nl", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(410).send({
      error: {
        code: "NL_SEARCH_RETIRED",
        message:
          "Plain-language search is not offered. Use Search, which applies the same visibility rules as the rest of the product.",
      },
      canonical: "/v1/search",
    }),
  );
}
