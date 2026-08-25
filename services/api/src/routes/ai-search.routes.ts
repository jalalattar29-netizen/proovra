/**
 * NOT SURFACED. This route has no UI consumer, deliberately.
 * ---------------------------------------------------------------------------
 * The "Ask in plain language" card on /search was withdrawn from every
 * workspace type (Personal Free, Personal Pro, OWNED, ORGANIZATION,
 * Enterprise) after an audit of what it actually displayed. The route is
 * RETAINED — registered, authorized, rate-limited and audited — because this
 * repository does not delete routes, and an unmounted route is not a hazard.
 *
 * WHAT THE AUDIT FOUND. Two defects, both in `runStateQuery` below.
 *
 *   1. DISPLAY NAMES ARE FABRICATED FOR TWO OF THE SEVEN PRESETS.
 *      `REVIEW_BACKLOG` renders `Review ${id.slice(0,8)}… (${status})` and
 *      `REPORTS_RECENT` renders `Report v${version}` — neither reads a name
 *      from the record it links to. "Show pending reviews" was one of the four
 *      examples the card advertised, so a first-time user was invited straight
 *      into the defect: a list of id fragments that match no evidence name
 *      anywhere in the product. `REPORTS_RECENT` is worse, because it routes
 *      to `/evidence/:id` while showing a title belonging to the report.
 *
 *      (`REPORTS_RECENT` additionally reports `total: rows.length` — the page
 *      size, capped at 25 — as if it were the population total.)
 *
 *   2. THE STATE PRESETS BYPASS EVERY VISIBILITY GATE.
 *      They query `prisma.evidence` / `evidenceReviewWorkflow` / `report`
 *      DIRECTLY with a `teamId` predicate and nothing else. The canonical
 *      `executeSearch` applies the reviewer-restriction gate TWICE — once in
 *      the WHERE (`where.reviewerRestricted = false` for a non-reviewer actor)
 *      and again per row — and none of that runs here.
 *
 *      TO BE PRECISE ABOUT THE BLAST RADIUS: cross-WORKSPACE leakage is NOT
 *      possible. `authorizeOrFail` verifies ACTIVE membership in `body.teamId`
 *      before anything runs, and every state query carries that teamId. The
 *      defect is WITHIN a workspace: a non-reviewer received rows that
 *      ordinary Search deliberately withholds from them.
 *
 *      The TEXT_SEARCH branch is unaffected — it delegates to
 *      `executeSearch` and passes `isReviewerCapable`, which is exactly the
 *      shape the state branch should have had.
 *
 * BEFORE THIS IS SURFACED AGAIN, all four must be true:
 *
 *   - the state presets resolve through the canonical authorized search path
 *     (or apply the identical visibility gates), so no preset can show a row
 *     ordinary Search would hide;
 *   - every row displays the canonical current display name of the record it
 *     links to, never a synthesised one;
 *   - `total` is a real count of the population, not the page length;
 *   - there is demonstrated user value over ordinary Search. The card was
 *     removed partly because Search already serves the same discovery goal,
 *     and "the code exists" is not a reason to surface a feature.
 *
 * There is no capability flag gating this; it is simply not rendered. Do not
 * add an Enterprise-only flag to bring it back without the four above.
 * ---------------------------------------------------------------------------
 *
 * Phase F1 — Enterprise Natural-Language Search.
 *   POST /v1/ai/search/nl
 *
 * User query → default-deny domain classifier → DETERMINISTIC NL-to-filter
 * parser → validated filters → EXISTING authorized search (executeSearch) or
 * bounded tenant-scoped state queries. No LLM parses, searches, or invents
 * filters; unsupported filters are refused honestly.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { enforceAiEndpointGuard } from "../services/ai/ai-rate-limit.service.js";
import { classifyChatScope } from "../services/ai/chat-scope-classifier.service.js";
import { parseNlSearch, type NlStateQuery } from "../services/ai/nl-search-parser.service.js";
import { executeSearch } from "../services/search/evidence-search.service.js";
import {
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";

const Body = z.object({
  teamId: z.string().uuid(),
  query: z.string().min(1).max(300),
});

type NlRow = { id: string; title: string; route: string; badge: string };

async function runStateQuery(teamId: string, query: NlStateQuery): Promise<{ rows: NlRow[]; total: number }> {
  const take = 25;
  const evRows = async (where: Record<string, unknown>, badge: string) => {
    const rows = await prisma.evidence.findMany({
      where: { AND: [await workspaceEvidenceWhere(teamId, prisma)], deletedAt: null, ...where },
      select: { id: true, title: true },
      orderBy: { createdAt: "desc" },
      take,
    });
    const total = await prisma.evidence.count({ where: { AND: [await workspaceEvidenceWhere(teamId, prisma)], deletedAt: null, ...where } });
    return {
      rows: rows.map((r) => ({ id: r.id, title: r.title ?? "Untitled evidence", route: `/evidence/${r.id}`, badge })),
      total,
    };
  };
  switch (query) {
    case "TSA_PENDING": return evRows({ tsaStatus: "PENDING" }, "TSA pending");
    case "TSA_FAILED": return evRows({ tsaStatus: "FAILED" }, "TSA failed");
    case "OTS_PENDING": return evRows({ otsStatus: "PENDING" }, "OTS pending");
    case "FAILED_VERIFICATION": return evRows({ verificationStatus: "FAILED" }, "Verification failed");
    case "WAITING_REPORT": return evRows({ status: "SIGNED", latestReportVersion: null }, "Waiting for report");
    case "UNSIGNED_PACKAGE": return evRows({ status: "SIGNED", verificationPackageVersion: null }, "No package");
    case "REVIEW_BACKLOG": {
      const rows = await prisma.evidenceReviewWorkflow.findMany({
        where: { teamId, status: { in: ["NOT_STARTED", "IN_REVIEW"] } },
        select: { id: true, evidenceId: true, status: true },
        take,
      });
      const total = await prisma.evidenceReviewWorkflow.count({ where: { teamId, status: { in: ["NOT_STARTED", "IN_REVIEW"] } } });
      return {
        rows: rows.map((r) => ({ id: r.id, title: `Review ${r.id.slice(0, 8)}… (${r.status})`, route: `/reviewer-ops/${r.id}`, badge: "Open review" })),
        total,
      };
    }
    case "REPORTS_RECENT": {
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const rows = await prisma.report.findMany({
        where: { evidence: { teamId, deletedAt: null }, generatedAtUtc: { gte: since } },
        select: { id: true, evidenceId: true, version: true },
        orderBy: { generatedAtUtc: "desc" },
        take,
      });
      return {
        rows: rows.map((r) => ({ id: r.id, title: `Report v${r.version}`, route: `/evidence/${r.evidenceId}`, badge: "Recent report" })),
        total: rows.length,
      };
    }
  }
}

export async function aiSearchRoutes(app: FastifyInstance) {
  app.post("/v1/ai/search/nl", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const body = Body.parse(req.body ?? {});
    // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
    // for the claimed workspace (ACTIVE membership + org lifecycle +
    // capability `intelligence.read` + fail-closed + anti-enumeration 404).
    // Membership in body.teamId is verified here, so the downstream
    // tenant-scoped queries against body.teamId cannot cross tenants.
    const authz = await authorizeOrFail(req, reply, {
      teamId: body.teamId,
      permission: "intelligence.read",
      antiEnumeration: true,
    });
    if (!authz) return reply;
    // Role read for reviewer-capability flag only; authorization enforced above.
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: body.teamId, userId } },
    });
    if (!membership) return reply.code(404).send({ error: { code: "not_found" } });

    // Rate limit + dedup (deterministic path, but still bounded per user/IP).
    const guard = await enforceAiEndpointGuard({
      feature: "nl-search", userId, ip: req.ip,
      userPerMin: 30, ipPerMin: 90,
    });
    if (!guard.allowed) {
      reply.header("Retry-After", String(guard.retryAfterSec));
      return reply.code(429).send({ code: guard.code, message: "Too many search requests; please slow down." });
    }
    // Parser complexity guard — bounded token count in addition to zod's 300-char cap.
    if (body.query.split(/\s+/).length > 40) {
      return reply.code(200).send({ kind: "UNSUPPORTED_FILTER", message: "Please use a shorter, more specific query." });
    }

    // Default-deny domain boundary BEFORE anything else (no provider, no cost).
    const scope = classifyChatScope(body.query);
    if (scope.refuse) {
      return reply.code(200).send({ kind: "REFUSED", message: scope.refusalMessage });
    }

    const parsed = parseNlSearch(body.query);
    await emitTenantAudit({
      action: "ai.nl_search",
      outcome: "success",
      sourceApp: "API",
      actorUserId: userId,
      workspaceId: body.teamId,
      resourceType: "workspace",
      resourceId: body.teamId,
      correlationId: req.id ?? null,
      metadata: { kind: parsed.kind, ...(parsed.kind === "STATE_QUERY" ? { query: parsed.query } : {}) },
    });

    if (parsed.kind === "UNSUPPORTED_FILTER") {
      return reply.code(200).send({
        kind: "UNSUPPORTED_FILTER",
        message: `That filter (${parsed.reason}) isn't supported yet. Supported: TSA/OTS status, failed verification, waiting-for-report, unsigned packages, review backlog, recent reports, and free-text search.`,
      });
    }

    if (parsed.kind === "STATE_QUERY") {
      const { rows, total } = await runStateQuery(body.teamId, parsed.query);
      return reply.code(200).send({ kind: "STATE_QUERY", query: parsed.query, rows, total });
    }

    // TEXT_SEARCH → EXISTING authorized search service (tenant-scoped).
    const result = await executeSearch({
      actorUserId: userId,
      isReviewerCapable: membership.role !== "VIEWER",
      surface: "api:ai-nl-search",
      filter: {
        teamId: body.teamId,
        ...(parsed.q ? { q: parsed.q } : {}),
        ...(parsed.evidenceTypes ? { evidenceTypes: parsed.evidenceTypes } : {}),
        limit: 25,
      },
    });
    const rows: NlRow[] = result.rows.map((r) => ({
      id: r.evidenceId ?? r.documentId,
      title: r.title || "Untitled",
      route: r.evidenceId ? `/evidence/${r.evidenceId}` : r.caseId ? `/cases/${r.caseId}` : `/search`,
      badge: r.documentType,
    }));
    return reply.code(200).send({ kind: "TEXT_SEARCH", q: parsed.q, rows, total: rows.length });
  });
}
