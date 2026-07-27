/**
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

const Body = z.object({
  teamId: z.string().uuid(),
  query: z.string().min(1).max(300),
});

type NlRow = { id: string; title: string; route: string; badge: string };

async function runStateQuery(teamId: string, query: NlStateQuery): Promise<{ rows: NlRow[]; total: number }> {
  const take = 25;
  const evRows = async (where: Record<string, unknown>, badge: string) => {
    const rows = await prisma.evidence.findMany({
      where: { teamId, deletedAt: null, ...where },
      select: { id: true, title: true },
      orderBy: { createdAt: "desc" },
      take,
    });
    const total = await prisma.evidence.count({ where: { teamId, deletedAt: null, ...where } });
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
