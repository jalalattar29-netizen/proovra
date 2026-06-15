/**
 * Internal search-reindex endpoint.
 *
 *   POST /v1/internal/search/reindex
 *   Header:  x-internal-secret: <SEARCH_REINDEX_SECRET>
 *   Body:    { "teamId": "<uuid>", "includeCases"?: bool, "batch"?: int, "dryRun"?: bool }
 *   Result:  200 { teamId, evidence, cases, reports, packages, notes, durationMs, dryRun }
 *
 * Why this exists
 * ---------------
 *
 * `POST /v1/search/reconcile` requires a real user token + workspace
 * membership. Production incidents where the search index is empty
 * (every row an orphan, including for users who can no longer reach
 * the workspace via the UI) cannot be fixed via that endpoint from
 * inside the API container without minting an actual user token.
 *
 * This endpoint takes the same canonical `runWorkspaceReindex` path
 * but gates on a shared internal secret instead of user auth, so the
 * container itself can curl localhost to repair the index after an
 * incident.
 *
 * Hard guarantees
 * ---------------
 *
 *   - Secret-only auth — there is NO fallback that allows an
 *     unauthenticated request through in production. The
 *     `requireSearchReindexSecret` middleware fails closed when
 *     SEARCH_REINDEX_SECRET is unset in prod (503).
 *   - Workspace-scoped. Body MUST include a valid teamId; the
 *     reindex service never writes cross-team rows.
 *   - Idempotent. Re-running for the same teamId is a no-op for
 *     already-current rows.
 *   - Audited. Every invocation writes a platform-audit-log row with
 *     actor = "internal:search-reindex" so compliance can answer
 *     "who reindexed when."
 *   - Does NOT weaken user auth on `/v1/search/reconcile` — both
 *     endpoints exist; this one is an additive surface.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireSearchReindexSecret } from "../middleware/cron-secret.js";
import { runWorkspaceReindex } from "../services/search/reindex.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";

export async function internalReindexRoutes(app: FastifyInstance) {
  app.post(
    "/v1/internal/search/reindex",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ok = await requireSearchReindexSecret(req, reply);
      if (!ok) return;

      const parsed = z
        .object({
          teamId: z.string().uuid(),
          includeCases: z.boolean().optional(),
          batch: z.coerce.number().int().min(1).max(50_000).optional(),
          dryRun: z.boolean().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: "validation_error",
            detail: parsed.error.flatten(),
          },
        });
      }
      const body = parsed.data;

      let result;
      try {
        result = await runWorkspaceReindex({
          teamId: body.teamId,
          includeCases: body.includeCases,
          batch: body.batch,
          dryRun: body.dryRun,
          log: {
            info: (obj, msg) => req.log.info(obj, msg ?? ""),
            warn: (obj, msg) => req.log.warn(obj, msg ?? ""),
            error: (obj, msg) => req.log.error(obj, msg ?? ""),
          },
        });
      } catch (err) {
        req.log.error(
          {
            teamId: body.teamId,
            err: err instanceof Error ? err.message : String(err),
          },
          "internal.search.reindex.failed",
        );
        return reply.code(500).send({
          error: { code: "reindex_failed" },
        });
      }

      // Fire-and-forget audit. Same surface label the cron-secret
      // routes use so compliance dashboards bucket internal-triggered
      // ops together.
      void appendPlatformAuditLog({
        userId: null,
        isPublic: true,
        action: "search.internal_reindex",
        category: "search",
        severity: "info",
        source: "internal",
        outcome: result.dryRun ? "dry_run" : "success",
        resourceType: "evidence_search_documents",
        resourceId: body.teamId,
        requestId: req.id ?? null,
        metadata: {
          surface: "POST /v1/internal/search/reindex",
          teamId: body.teamId,
          dryRun: result.dryRun,
          evidenceIndexed: result.evidence.indexed,
          evidenceOrphans: result.evidence.orphans,
          evidenceFailed: result.evidence.failed,
          caseIndexed: result.cases.indexed,
          reportIndexed: result.reports.indexed,
          packageIndexed: result.packages.indexed,
          noteIndexed: result.notes.indexed,
          durationMs: result.durationMs,
        },
      }).catch((err: unknown) => {
        req.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "internal.search.reindex.audit_failed",
        );
      });

      return reply.code(200).send(result);
    },
  );
}
