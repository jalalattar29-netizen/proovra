/**
 * Phase 31 — Media intelligence REST surface.
 *
 * Two routes:
 *
 *   GET  /v1/evidence/:evidenceId/media-intelligence?teamId=…
 *     → return the bounded list of media intelligence signals for
 *       this evidence, along with the bounded catalog of known
 *       signal categories. Read-only.
 *
 *   POST /v1/evidence/:evidenceId/media-intelligence/run
 *     → invoke the deterministic analyzer for this evidence.
 *       Idempotent. Returns the analyzer summary. Never blocks
 *       finalize / report / package flows on failure.
 *
 * Hard contracts:
 *   * Both routes gated by `authorizeOrFail` + `evidence.read` (GET)
 *     or `evidence.update_metadata` (POST). Anti-enumeration safe.
 *   * The response projection NEVER includes raw `technical_details_json`
 *     for restricted callers (this route's caller is workspace-
 *     internal; external reviewer surfaces would need their own
 *     narrower projection — that's a follow-up route).
 *   * Bounded shape — `signalType` / `severity` / `confidence` /
 *     `status` all from closed catalogs.
 *   * NEVER returns custody-grade integrity claims. The catalog's
 *     safe wording is the operator's only guidance.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { runMediaIntelligenceAnalysis } from "../services/media-intelligence/analyzer.service.js";
import {
  MEDIA_INTELLIGENCE_CONFIDENCES,
  MEDIA_INTELLIGENCE_SEVERITIES,
  MEDIA_INTELLIGENCE_SIGNAL_TYPES,
  MEDIA_INTELLIGENCE_STATUSES,
  SIGNAL_METADATA,
} from "../services/media-intelligence/signal-catalog.js";
import { bump } from "../services/ops/metrics.service.js";

// =============================================================================
// Bounded validators
// =============================================================================

const ParamsEvidenceId = z.object({
  evidenceId: z.string().uuid(),
});
const TeamQuery = z.object({
  teamId: z.string().uuid(),
});
const RunBody = z
  .object({
    teamId: z.string().uuid(),
    /**
     * Phase 31.6 — when true, enqueues the analyzer onto the
     * media-intelligence BullMQ queue instead of running it
     * synchronously on the request thread. Default false preserves
     * the Phase 31 synchronous behavior so any existing callers
     * are unaffected.
     */
    async: z.boolean().optional(),
  })
  .strict();

// Phase 31.5 — ack / dismiss
const SignalActionBody = z
  .object({
    teamId: z.string().uuid(),
    action: z.enum(["ACKNOWLEDGED", "DISMISSED"]),
  })
  .strict();
const ParamsSignalId = z.object({
  signalId: z.string().uuid(),
});

// =============================================================================
// Projection — anti-leak safe shape
// =============================================================================

type ProjectedSignal = {
  id: string;
  signalType: (typeof MEDIA_INTELLIGENCE_SIGNAL_TYPES)[number];
  materialId: string | null;
  severity: (typeof MEDIA_INTELLIGENCE_SEVERITIES)[number];
  confidence: (typeof MEDIA_INTELLIGENCE_CONFIDENCES)[number];
  safeSummary: string;
  status: (typeof MEDIA_INTELLIGENCE_STATUSES)[number];
  createdAtUtc: string;
  updatedAtUtc: string;
  acknowledgedAtUtc: string | null;
};

function projectSignal(row: {
  id: string;
  signal_type: string;
  material_id: string | null;
  severity: string;
  confidence: string;
  safe_summary: string;
  status: string;
  created_at_utc: Date;
  updated_at_utc: Date;
  acknowledged_at_utc: Date | null;
}): ProjectedSignal {
  return {
    id: row.id,
    signalType: row.signal_type as ProjectedSignal["signalType"],
    materialId: row.material_id,
    severity: row.severity as ProjectedSignal["severity"],
    confidence: row.confidence as ProjectedSignal["confidence"],
    safeSummary: row.safe_summary,
    status: row.status as ProjectedSignal["status"],
    createdAtUtc: row.created_at_utc.toISOString(),
    updatedAtUtc: row.updated_at_utc.toISOString(),
    acknowledgedAtUtc: row.acknowledged_at_utc?.toISOString() ?? null,
  };
}

// =============================================================================
// Routes
// =============================================================================

export async function mediaIntelligenceRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/evidence/:evidenceId/media-intelligence?teamId=…
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/evidence/:evidenceId/media-intelligence",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { evidenceId } = ParamsEvidenceId.parse(req.params);
      const { teamId } = TeamQuery.parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      // Anti-enumeration: a non-team evidence_id surfaces 404 even
      // if the row exists in another workspace.
      const evidence = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { id: true, teamId: true },
      });
      if (!evidence || evidence.teamId !== teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT "id", "signal_type", "material_id", "severity", "confidence",
                "safe_summary", "status", "created_at_utc", "updated_at_utc",
                "acknowledged_at_utc"
           FROM "media_intelligence_signals"
           WHERE "team_id" = $1 AND "evidence_id" = $2
           ORDER BY
             CASE "severity"
               WHEN 'ATTENTION' THEN 0
               WHEN 'REVIEW_RECOMMENDED' THEN 1
               ELSE 2
             END,
             "created_at_utc" DESC
           LIMIT 200`,
        teamId,
        evidenceId,
      )) as Array<{
        id: string;
        signal_type: string;
        material_id: string | null;
        severity: string;
        confidence: string;
        safe_summary: string;
        status: string;
        created_at_utc: Date;
        updated_at_utc: Date;
        acknowledged_at_utc: Date | null;
      }>;
      bump("graph_query_total"); // shared "intelligence query" counter
      return reply.code(200).send({
        evidenceId,
        signals: rows.map(projectSignal),
        // Surface the bounded catalog so the UI can render
        // categories with no rows yet (e.g. "OCR_AVAILABLE — not
        // yet computed"). The catalog itself is public — no
        // tenant-specific data.
        catalog: MEDIA_INTELLIGENCE_SIGNAL_TYPES.map((type) => ({
          signalType: type,
          displayLabel: SIGNAL_METADATA[type].displayLabel,
          implemented: SIGNAL_METADATA[type].implemented,
        })),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/evidence/:evidenceId/media-intelligence/run
  //
  // Invoke the deterministic analyzer. Idempotent. Never blocks
  // the evidence lifecycle. Returns the analyzer summary.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/evidence/:evidenceId/media-intelligence/run",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { evidenceId } = ParamsEvidenceId.parse(req.params);
      const body = RunBody.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.update_metadata",
        antiEnumeration: true,
      });
      if (!actor) return;

      // Phase 31.6 — async path. When the client opts in, enqueue
      // the job onto the media-intelligence BullMQ queue and
      // return 202 Accepted with the run id. The worker picks it
      // up + invokes the same `runMediaIntelligenceAnalysis`
      // function inside its own Prisma context. Idempotent: a
      // repeat POST for the same (kind, evidenceId) collapses to
      // the existing job.
      if (body.async) {
        // First create the run row (idempotency: `analyze:{evidenceId}`).
        const { enqueueMediaIntelligenceRun } = await import(
          "../services/media-intelligence/run-tracker.service.js"
        );
        const runResult = await enqueueMediaIntelligenceRun({
          teamId: body.teamId,
          evidenceId,
          kind: "analyze_metadata",
          idempotencyKey: `analyze:${evidenceId}`,
        });
        if (!runResult.ok) {
          return reply.code(503).send({
            error: { code: "media_intelligence_unavailable" },
          });
        }
        // Then enqueue the worker job (carries the run id so the
        // processor can update its state machine).
        const { enqueueMediaIntelligenceAnalysis } = await import(
          "../queue/media-intelligence-queue.js"
        );
        const enq = await enqueueMediaIntelligenceAnalysis({
          teamId: body.teamId,
          evidenceId,
          kind: "analyze_metadata",
          runId: runResult.run.id,
        });
        if (!enq.enqueued) {
          // Queue unavailable. The run row exists in PENDING so a
          // future reconcile / manual retry can pick it up.
          return reply.code(202).send({
            evidenceId,
            mode: "async",
            queued: false,
            runId: runResult.run.id,
            reason: enq.reason,
          });
        }
        return reply.code(202).send({
          evidenceId,
          mode: "async",
          queued: true,
          runId: runResult.run.id,
          jobId: enq.jobId,
        });
      }

      // Synchronous path (Phase 31 default).
      const result = await runMediaIntelligenceAnalysis({
        evidenceId,
        teamId: body.teamId,
      });
      if (!result.ok) {
        if (result.reason === "evidence_not_found" || result.reason === "team_mismatch") {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(503).send({
          error: { code: "media_intelligence_unavailable" },
        });
      }
      return reply.code(200).send({
        evidenceId,
        mode: "sync",
        signalsEmitted: result.signalsEmitted,
        signalsByType: result.signalsByType,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/media-intelligence/signals/:signalId/action
  //
  // Operator action: acknowledge or dismiss a single signal.
  // Idempotent. Anti-enumeration safe.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/media-intelligence/signals/:signalId/action",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { signalId } = ParamsSignalId.parse(req.params);
      const body = SignalActionBody.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.update_metadata",
        antiEnumeration: true,
      });
      if (!actor) return;
      // Verify the signal belongs to this team (anti-enumeration).
      const owner = (await prisma.$queryRawUnsafe(
        `SELECT "team_id" FROM "media_intelligence_signals"
           WHERE "id" = $1 LIMIT 1`,
        signalId,
      )) as Array<{ team_id: string }>;
      if (owner.length === 0 || owner[0]!.team_id !== body.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      // Idempotent transition. Acknowledged-at carries the actor +
      // server clock (NEVER client clock).
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE "media_intelligence_signals"
             SET "status" = $1,
                 "acknowledged_by_user_id" = $2,
                 "acknowledged_at_utc" = NOW(),
                 "updated_at_utc" = NOW()
             WHERE "id" = $3 AND "team_id" = $4`,
          body.action,
          actor.actorUserId,
          signalId,
          body.teamId,
        );
        bump("media_signal_acknowledged_total");
      } catch {
        return reply.code(503).send({
          error: { code: "media_intelligence_unavailable" },
        });
      }
      return reply.code(200).send({
        signalId,
        status: body.action,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/investigation/overview?teamId=…
  //
  // Phase 31.12 — workspace-scoped intelligence + investigation
  // overview. Aggregates bounded signal counts + recent activity.
  // Powers the /investigation dashboard surface.
  //
  // Hard rules:
  //   * authorizeOrFail evidence.read + antiEnumeration.
  //   * Returns NO per-evidence material attribution beyond what the
  //     workspace-internal panel already surfaces.
  //   * Bounded result sizes — 20 recent signals, 30 recent timeline
  //     events. Each scan capped at LIMIT in SQL.
  //   * DISMISSED signals included in totals but excluded from the
  //     recent activity list (mirrors operator dismissal intent).
  //   * Team-anchored — every SQL fragment binds team_id = $1.
  //   * NEVER throws — failures land in bounded empty arrays.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/investigation/overview",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { teamId } = TeamQuery.parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;

      // 1) Severity + status totals.
      let totals = {
        signalsTotal: 0,
        attention: 0,
        reviewRecommended: 0,
        info: 0,
        pending: 0,
        acknowledged: 0,
        dismissed: 0,
      };
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT
             COUNT(*)::int AS "total",
             COUNT(*) FILTER (WHERE "severity" = 'ATTENTION')::int AS "attention",
             COUNT(*) FILTER (WHERE "severity" = 'REVIEW_RECOMMENDED')::int AS "review_recommended",
             COUNT(*) FILTER (WHERE "severity" = 'INFO')::int AS "info",
             COUNT(*) FILTER (WHERE "status" = 'PENDING')::int AS "pending",
             COUNT(*) FILTER (WHERE "status" = 'ACKNOWLEDGED')::int AS "acknowledged",
             COUNT(*) FILTER (WHERE "status" = 'DISMISSED')::int AS "dismissed"
           FROM "media_intelligence_signals"
           WHERE "team_id" = $1`,
          teamId,
        )) as Array<{
          total: number;
          attention: number;
          review_recommended: number;
          info: number;
          pending: number;
          acknowledged: number;
          dismissed: number;
        }>;
        const r = rows[0];
        if (r) {
          totals = {
            signalsTotal: r.total ?? 0,
            attention: r.attention ?? 0,
            reviewRecommended: r.review_recommended ?? 0,
            info: r.info ?? 0,
            pending: r.pending ?? 0,
            acknowledged: r.acknowledged ?? 0,
            dismissed: r.dismissed ?? 0,
          };
        }
      } catch {
        // Soft-fail. Empty totals; the dashboard renders zeros.
      }

      // 2) Recent non-dismissed signals — bounded, redaction-aware
      //    (no storage internals, no internal IDs leaked).
      type RecentSignal = {
        id: string;
        signalType: string;
        evidenceId: string;
        severity: string;
        confidence: string;
        status: string;
        safeSummary: string;
        createdAtUtc: string;
      };
      let recentSignals: ReadonlyArray<RecentSignal> = [];
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT "id", "signal_type", "evidence_id", "severity",
                  "confidence", "status", "safe_summary",
                  "created_at_utc"
             FROM "media_intelligence_signals"
            WHERE "team_id" = $1
              AND "status" IN ('PENDING','ACKNOWLEDGED')
            ORDER BY
              CASE "severity"
                WHEN 'ATTENTION' THEN 0
                WHEN 'REVIEW_RECOMMENDED' THEN 1
                ELSE 2
              END,
              "created_at_utc" DESC
            LIMIT 20`,
          teamId,
        )) as Array<{
          id: string;
          signal_type: string;
          evidence_id: string;
          severity: string;
          confidence: string;
          status: string;
          safe_summary: string;
          created_at_utc: Date;
        }>;
        recentSignals = rows.map((r) => ({
          id: r.id,
          signalType: r.signal_type,
          evidenceId: r.evidence_id,
          severity: r.severity,
          confidence: r.confidence,
          status: r.status,
          safeSummary: r.safe_summary.slice(0, 240),
          createdAtUtc: r.created_at_utc.toISOString(),
        }));
      } catch {
        recentSignals = [];
      }

      // 3) Recent graph activity — node + edge create events.
      type GraphActivityEvent = {
        id: string;
        kind: "NODE_CREATED" | "EDGE_CREATED";
        atUtc: string;
        summary: string;
      };
      let recentGraphActivity: ReadonlyArray<GraphActivityEvent> = [];
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `(
             SELECT 'NODE_CREATED'::text AS "kind",
                    n."created_at_utc" AS "at_utc",
                    n."id" AS "id",
                    COALESCE(n."safe_label", n."node_kind") AS "summary"
               FROM "investigation_graph_nodes" n
               WHERE n."team_id" = $1
                 AND n."stale_at_utc" IS NULL
           )
           UNION ALL
           (
             SELECT 'EDGE_CREATED'::text AS "kind",
                    e."created_at_utc" AS "at_utc",
                    e."id" AS "id",
                    COALESCE(e."safe_summary", e."edge_type") AS "summary"
               FROM "investigation_graph_edges" e
               WHERE e."team_id" = $1
                 AND e."stale_at_utc" IS NULL
           )
           ORDER BY "at_utc" DESC
           LIMIT 30`,
          teamId,
        )) as Array<{
          kind: "NODE_CREATED" | "EDGE_CREATED";
          at_utc: Date;
          id: string;
          summary: string;
        }>;
        recentGraphActivity = rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          atUtc: r.at_utc.toISOString(),
          summary: r.summary.slice(0, 240),
        }));
      } catch {
        recentGraphActivity = [];
      }

      bump("graph_query_total");
      return reply.code(200).send({
        teamId,
        totals,
        recentSignals,
        recentGraphActivity,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/investigation/reviewers?teamId=…
  //
  // Phase 31.18 — Reviewer Intelligence Console aggregator. Returns
  // a bounded workspace projection of:
  //   * review-workflow status counts (PENDING/IN_PROGRESS/REJECTED/
  //     COMPLETED/etc. — all bounded enum tokens).
  //   * escalation status counts (OPEN/ACKNOWLEDGED/RESOLVED/...).
  //   * external-review grant status counts (INVITED/ACTIVE/...).
  //   * the most recent 20 OPEN escalations + 20 active external
  //     review grants (operator-safe projections only).
  //
  // Hard rules:
  //   * authorizeOrFail evidence.read + antiEnumeration.
  //   * NEVER projects escalation_reason / rejection_reason /
  //     paused_reason / resolution_note / suppression_reason / safe_note /
  //     reviewer_email / token_hash. These are reviewer-private
  //     or operator-private fields by design.
  //   * NEVER throws — failures collapse to empty arrays + zero
  //     totals.
  //   * Team-anchored: every SQL fragment binds team_id = $1.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/investigation/reviewers",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { teamId } = TeamQuery.parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;

      // 1) Workflow status totals.
      let workflowTotals = {
        notStarted: 0,
        inProgress: 0,
        escalated: 0,
        paused: 0,
        completed: 0,
        rejected: 0,
        total: 0,
      };
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT
             COUNT(*)::int AS "total",
             COUNT(*) FILTER (WHERE "status" = 'NOT_STARTED')::int AS "not_started",
             COUNT(*) FILTER (WHERE "status" = 'IN_PROGRESS')::int AS "in_progress",
             COUNT(*) FILTER (WHERE "status" = 'ESCALATED')::int AS "escalated",
             COUNT(*) FILTER (WHERE "status" = 'PAUSED')::int AS "paused",
             COUNT(*) FILTER (WHERE "status" = 'COMPLETED')::int AS "completed",
             COUNT(*) FILTER (WHERE "status" = 'REJECTED_INSUFFICIENT')::int AS "rejected"
           FROM "evidence_review_workflows"
           WHERE "team_id" = $1`,
          teamId,
        )) as Array<{
          total: number;
          not_started: number;
          in_progress: number;
          escalated: number;
          paused: number;
          completed: number;
          rejected: number;
        }>;
        const r = rows[0];
        if (r) {
          workflowTotals = {
            notStarted: r.not_started ?? 0,
            inProgress: r.in_progress ?? 0,
            escalated: r.escalated ?? 0,
            paused: r.paused ?? 0,
            completed: r.completed ?? 0,
            rejected: r.rejected ?? 0,
            total: r.total ?? 0,
          };
        }
      } catch {
        /* soft-fail */
      }

      // 2) Escalation status totals.
      let escalationTotals = {
        open: 0,
        acknowledged: 0,
        reassigned: 0,
        resolved: 0,
        suppressed: 0,
        total: 0,
      };
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT
             COUNT(*)::int AS "total",
             COUNT(*) FILTER (WHERE "status" = 'OPEN')::int AS "open",
             COUNT(*) FILTER (WHERE "status" = 'ACKNOWLEDGED')::int AS "acknowledged",
             COUNT(*) FILTER (WHERE "status" = 'REASSIGNED')::int AS "reassigned",
             COUNT(*) FILTER (WHERE "status" = 'RESOLVED')::int AS "resolved",
             COUNT(*) FILTER (WHERE "status" = 'SUPPRESSED')::int AS "suppressed"
           FROM "review_escalations"
           WHERE "team_id" = $1`,
          teamId,
        )) as Array<{
          total: number;
          open: number;
          acknowledged: number;
          reassigned: number;
          resolved: number;
          suppressed: number;
        }>;
        const r = rows[0];
        if (r) {
          escalationTotals = {
            open: r.open ?? 0,
            acknowledged: r.acknowledged ?? 0,
            reassigned: r.reassigned ?? 0,
            resolved: r.resolved ?? 0,
            suppressed: r.suppressed ?? 0,
            total: r.total ?? 0,
          };
        }
      } catch {
        /* soft-fail */
      }

      // 3) External-review grant status totals.
      let externalReviewTotals = {
        invited: 0,
        active: 0,
        expired: 0,
        revoked: 0,
        total: 0,
      };
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT
             COUNT(*)::int AS "total",
             COUNT(*) FILTER (WHERE "state" = 'INVITED')::int AS "invited",
             COUNT(*) FILTER (WHERE "state" = 'ACTIVE')::int AS "active",
             COUNT(*) FILTER (WHERE "state" = 'EXPIRED')::int AS "expired",
             COUNT(*) FILTER (WHERE "state" = 'REVOKED')::int AS "revoked"
           FROM "external_review_grants"
           WHERE "team_id" = $1`,
          teamId,
        )) as Array<{
          total: number;
          invited: number;
          active: number;
          expired: number;
          revoked: number;
        }>;
        const r = rows[0];
        if (r) {
          externalReviewTotals = {
            invited: r.invited ?? 0,
            active: r.active ?? 0,
            expired: r.expired ?? 0,
            revoked: r.revoked ?? 0,
            total: r.total ?? 0,
          };
        }
      } catch {
        /* soft-fail */
      }

      // 4) Recent OPEN escalations — bounded projection, NEVER pulls
      //    resolution_note / suppression_reason / safe_note free-text
      //    beyond safe_summary (which is operator-safe by construction).
      type RecentEscalation = {
        id: string;
        workflowId: string;
        evidenceId: string | null;
        reason: string;
        severity: string;
        status: string;
        safeSummary: string;
        createdAtUtc: string;
      };
      let recentEscalations: ReadonlyArray<RecentEscalation> = [];
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT "id", "workflow_id", "evidence_id", "reason",
                  "severity", "status", "safe_summary", "created_at"
             FROM "review_escalations"
            WHERE "team_id" = $1
              AND "status" IN ('OPEN','ACKNOWLEDGED')
            ORDER BY
              CASE "severity"
                WHEN 'CRITICAL' THEN 0
                WHEN 'HIGH' THEN 1
                WHEN 'WARNING' THEN 2
                ELSE 3
              END,
              "created_at" DESC
            LIMIT 20`,
          teamId,
        )) as Array<{
          id: string;
          workflow_id: string;
          evidence_id: string | null;
          reason: string;
          severity: string;
          status: string;
          safe_summary: string;
          created_at: Date;
        }>;
        recentEscalations = rows.map((r) => ({
          id: r.id,
          workflowId: r.workflow_id,
          evidenceId: r.evidence_id,
          reason: r.reason,
          severity: r.severity,
          status: r.status,
          safeSummary: r.safe_summary.slice(0, 240),
          createdAtUtc: r.created_at.toISOString(),
        }));
      } catch {
        recentEscalations = [];
      }

      // 5) Recent external-review grants — bounded projection. Never
      //    leaks reviewer_email / safe_note / token_hash.
      type RecentGrant = {
        id: string;
        scopeKind: string;
        state: string;
        evidenceId: string | null;
        caseId: string | null;
        packageId: string | null;
        expiresAtUtc: string;
        createdAtUtc: string;
        accessCount: number;
      };
      let recentGrants: ReadonlyArray<RecentGrant> = [];
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT "id", "scope_kind", "state",
                  "evidence_id", "case_id", "package_id",
                  "expires_at_utc", "created_at_utc", "access_count"
             FROM "external_review_grants"
            WHERE "team_id" = $1
              AND "state" IN ('INVITED','ACTIVE')
            ORDER BY "created_at_utc" DESC
            LIMIT 20`,
          teamId,
        )) as Array<{
          id: string;
          scope_kind: string;
          state: string;
          evidence_id: string | null;
          case_id: string | null;
          package_id: string | null;
          expires_at_utc: Date;
          created_at_utc: Date;
          access_count: number;
        }>;
        recentGrants = rows.map((r) => ({
          id: r.id,
          scopeKind: r.scope_kind,
          state: r.state,
          evidenceId: r.evidence_id,
          caseId: r.case_id,
          packageId: r.package_id,
          expiresAtUtc: r.expires_at_utc.toISOString(),
          createdAtUtc: r.created_at_utc.toISOString(),
          accessCount: r.access_count ?? 0,
        }));
      } catch {
        recentGrants = [];
      }

      // 6.1) Phase 31.19 — OCR / transcript producer mode summary.
      //    Bounded read-only env summary. NEVER reads vendor
      //    credentials. Default mode is NOT_CONFIGURED so the
      //    operator UI can show the correct status without the
      //    backend silently transmitting data off-prem.
      const { summariseProducerModes } = await import(
        "../services/media-intelligence/producer-mode.js"
      );
      const producerModes = summariseProducerModes();

      // 6.2) Phase 31.19 — Pending media signals needing reviewer
      //    action. Bounded projection. Operator-safe wording only
      //    (safe_summary is enforced by the SafeWording library).
      //    Surfaces signal id + evidence id so the console can wire
      //    ack/dismiss buttons that call
      //    POST /v1/media-intelligence/signals/:signalId/action.
      type PendingSignal = {
        id: string;
        evidenceId: string;
        signalType: string;
        severity: string;
        confidence: string;
        safeSummary: string;
        createdAtUtc: string;
      };
      let pendingSignals: ReadonlyArray<PendingSignal> = [];
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT "id", "evidence_id", "signal_type", "severity",
                  "confidence", "safe_summary", "created_at_utc"
             FROM "media_intelligence_signals"
            WHERE "team_id" = $1
              AND "status" = 'PENDING'
            ORDER BY
              CASE "severity"
                WHEN 'ATTENTION' THEN 0
                WHEN 'REVIEW_RECOMMENDED' THEN 1
                ELSE 2
              END,
              "created_at_utc" DESC
            LIMIT 20`,
          teamId,
        )) as Array<{
          id: string;
          evidence_id: string;
          signal_type: string;
          severity: string;
          confidence: string;
          safe_summary: string;
          created_at_utc: Date;
        }>;
        pendingSignals = rows.map((r) => ({
          id: r.id,
          evidenceId: r.evidence_id,
          signalType: r.signal_type,
          severity: r.severity,
          confidence: r.confidence,
          safeSummary: r.safe_summary.slice(0, 240),
          createdAtUtc: r.created_at_utc.toISOString(),
        }));
      } catch {
        pendingSignals = [];
      }

      // 7) Phase 31.21 — OCR / transcript signal-volume snapshot.
      //    Bounded count projection — how many OCR_AVAILABLE /
      //    OCR_INDEXED / TRANSCRIPT_AVAILABLE / TRANSCRIPT_INDEXED
      //    rows exist for this team. Real numbers, NOT fake.
      //    Never reads underlying OCR / transcript text.
      let indexingTotals = {
        ocrAvailable: 0,
        ocrIndexed: 0,
        transcriptAvailable: 0,
        transcriptIndexed: 0,
      };
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT
             COUNT(*) FILTER (WHERE "signal_type" = 'OCR_AVAILABLE')::int AS "ocr_available",
             COUNT(*) FILTER (WHERE "signal_type" = 'OCR_INDEXED')::int AS "ocr_indexed",
             COUNT(*) FILTER (WHERE "signal_type" = 'TRANSCRIPT_AVAILABLE')::int AS "transcript_available",
             COUNT(*) FILTER (WHERE "signal_type" = 'TRANSCRIPT_INDEXED')::int AS "transcript_indexed"
           FROM "media_intelligence_signals"
           WHERE "team_id" = $1
             AND "status" IN ('PENDING', 'ACKNOWLEDGED')`,
          teamId,
        )) as Array<{
          ocr_available: number;
          ocr_indexed: number;
          transcript_available: number;
          transcript_indexed: number;
        }>;
        const r = rows[0];
        if (r) {
          indexingTotals = {
            ocrAvailable: r.ocr_available ?? 0,
            ocrIndexed: r.ocr_indexed ?? 0,
            transcriptAvailable: r.transcript_available ?? 0,
            transcriptIndexed: r.transcript_indexed ?? 0,
          };
        }
      } catch {
        /* soft-fail */
      }

      // 8) Phase 31.21 — local-extractor capability snapshot. Always
      //    NOT_ENABLED today (production runs INDEX_EXISTING_ONLY).
      //    Surfaced so ops can see at a glance the platform is NOT
      //    silently extracting OCR or transcribing audio.
      const localExtractorCapability = {
        tesseract: { ok: false as const, reason: "not_enabled" as const },
        whisper: { ok: false as const, reason: "not_enabled" as const },
      };

      bump("reviewer_console_query_total");
      return reply.code(200).send({
        teamId,
        workflowTotals,
        escalationTotals,
        externalReviewTotals,
        recentEscalations,
        recentGrants,
        // Phase 31.19 — Pending signals available for ack/dismiss.
        pendingSignals,
        // Phase 31.19 — Producer mode summary so the UI can show
        // a clear NOT_CONFIGURED status for OCR / transcript.
        producerModes,
        // Phase 31.21 — Indexing volume snapshot + local-extractor
        // capability state.
        indexingTotals,
        localExtractorCapability,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/evidence/:evidenceId/derived-assets?teamId=…
  //
  // Phase 31.13 — read the bounded list of derived assets for one
  // evidence record. The projection NEVER includes storage_bucket /
  // storage_key / signed URLs — those columns exist internally on
  // the worker side for byte serving but the public API surface is
  // bounded by construction (the persistence service's projectRow
  // helper strips them).
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/evidence/:evidenceId/derived-assets",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { evidenceId } = ParamsEvidenceId.parse(req.params);
      const { teamId } = TeamQuery.parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;
      // Anti-enumeration: a non-team evidence id surfaces 404 even
      // when the row exists in another workspace.
      const evidence = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { id: true, teamId: true },
      });
      if (!evidence || evidence.teamId !== teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const { listDerivedAssetsForEvidence } = await import(
        "../services/media-intelligence/derived-assets.service.js"
      );
      const assets = await listDerivedAssetsForEvidence(teamId, evidenceId);
      // Phase 31.14 — attach a bounded `bytesUrl` per COMPLETED
      // asset. The URL is a workspace-internal proxy endpoint that
      // streams the bytes from S3 server-side; the client never
      // sees a storage_key, signed URL, or bucket name. PENDING /
      // FAILED / UNSUPPORTED assets have `bytesUrl: null`.
      const projected = assets.map((a) => ({
        ...a,
        bytesUrl:
          a.status === "COMPLETED"
            ? `/v1/evidence/${encodeURIComponent(evidenceId)}/derived-assets/${encodeURIComponent(a.id)}/bytes?teamId=${encodeURIComponent(teamId)}`
            : null,
      }));
      return reply.code(200).send({
        evidenceId,
        assets: projected,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/evidence/:evidenceId/derived-assets/:assetId/bytes?teamId=…
  //
  // Phase 31.14 — server-side bytes proxy. Streams the derived
  // bytes from S3 through the API so the client NEVER sees a
  // storage_bucket / storage_key / signed URL.
  //
  // Hard rules:
  //   * Bounded auth: authorizeOrFail + evidence.read + antiEnumeration.
  //   * Anti-enumeration: cross-team or missing asset → 404
  //     `not_found` (same shape as no-row-exists).
  //   * Status gate: only COMPLETED assets serve bytes. PENDING /
  //     PROCESSING / FAILED / UNSUPPORTED → 404 `asset_not_ready`.
  //   * Content-type from the DB row (the worker writes it). Bounded
  //     cache-control: derived bytes are content-addressable
  //     (SHA-256 in the key), so they're immutable once written —
  //     long-lived cache is safe.
  //   * Storage failures → 503 `storage_unavailable`. Never leaks
  //     the bucket / key.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/evidence/:evidenceId/derived-assets/:assetId/bytes",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { evidenceId, assetId } = z
        .object({
          evidenceId: z.string().uuid(),
          assetId: z.string().uuid(),
        })
        .parse(req.params);
      const { teamId } = TeamQuery.parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId,
        permission: "evidence.read",
        antiEnumeration: true,
      });
      if (!actor) return;

      // Anti-enumeration: cross-team evidence id surfaces 404 even
      // when the row exists in another workspace.
      const evidence = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { id: true, teamId: true },
      });
      if (!evidence || evidence.teamId !== teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      // Verify the asset belongs to this team + evidence, and is
      // COMPLETED. PENDING / FAILED / UNSUPPORTED ones don't serve.
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT "status", "content_type", "size_bytes",
                "derived_sha256"
           FROM "evidence_part_derived_assets"
          WHERE "id" = $1
            AND "team_id" = $2
            AND "evidence_id" = $3
          LIMIT 1`,
        assetId,
        teamId,
        evidenceId,
      )) as Array<{
        status: string;
        content_type: string | null;
        size_bytes: number | null;
        derived_sha256: string | null;
      }>;
      const row = rows[0];
      if (!row) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      if (row.status !== "COMPLETED") {
        return reply.code(404).send({ error: { code: "asset_not_ready" } });
      }

      const { _getDerivedAssetStorageReference } = await import(
        "../services/media-intelligence/derived-assets.service.js"
      );
      const storageRef = await _getDerivedAssetStorageReference(
        teamId,
        assetId,
      );
      if (!storageRef) {
        return reply
          .code(503)
          .send({ error: { code: "storage_unavailable" } });
      }

      // Fetch + buffer the derived bytes. Thumbnails are small
      // (sharp output is ≤256px WebP at 80%; typical real bytes are
      // well under 100 KB). The DB row size_bytes column carries
      // the actual recorded size; the schema caps it at 50 MB.
      let body: Buffer;
      try {
        const { getObjectStream } = await import("../storage.js");
        const stream = await getObjectStream({
          bucket: storageRef.bucket,
          key: storageRef.key,
        });
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(
            typeof chunk === "string"
              ? Buffer.from(chunk)
              : (chunk as Buffer),
          );
        }
        body = Buffer.concat(chunks);
      } catch {
        return reply
          .code(503)
          .send({ error: { code: "storage_unavailable" } });
      }

      reply.header(
        "content-type",
        row.content_type ?? storageRef.contentType ?? "application/octet-stream",
      );
      reply.header("content-length", String(body.byteLength));
      // Derived asset keys include the sha256 prefix, so the bytes
      // are content-addressable + immutable. Long cache is safe.
      reply.header("cache-control", "private, max-age=86400, immutable");
      if (row.derived_sha256) {
        reply.header("etag", `"${row.derived_sha256}"`);
      }
      // Defence in depth: never let an intermediary cache attach
      // the bytes to an indexable URL.
      reply.header("x-content-type-options", "nosniff");
      reply.header("referrer-policy", "no-referrer");
      return reply.code(200).send(body);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/evidence/:evidenceId/derived-assets/run
  //
  // Phase 31.13 — operator-triggered derived asset generation. The
  // body must specify which part + which kind. Idempotent via the
  // deterministic queue jobId.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/evidence/:evidenceId/derived-assets/run",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { evidenceId } = ParamsEvidenceId.parse(req.params);
      const RunBody = z
        .object({
          teamId: z.string().uuid(),
          evidencePartId: z.string().uuid(),
          assetKind: z.enum([
            "image_thumbnail",
            "video_frame",
            "audio_waveform",
            "low_res_proxy",
            "compact_review_preview",
          ]),
        })
        .strict();
      const body = RunBody.parse(req.body ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "evidence.update_metadata",
        antiEnumeration: true,
      });
      if (!actor) return;

      // Anti-enumeration on evidence + part.
      const evidence = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { id: true, teamId: true },
      });
      if (!evidence || evidence.teamId !== body.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const part = await prisma.evidencePart.findFirst({
        where: { id: body.evidencePartId, evidenceId },
        select: { id: true },
      });
      if (!part) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      const { enqueueDerivedAssetGeneration } = await import(
        "../queue/derived-assets-queue.js"
      );
      const enq = await enqueueDerivedAssetGeneration({
        teamId: body.teamId,
        evidenceId,
        evidencePartId: body.evidencePartId,
        assetKind: body.assetKind,
      });
      if (!enq.enqueued && !enq.reason.startsWith("job_")) {
        return reply.code(503).send({
          error: { code: "queue_unavailable", detail: enq.reason },
        });
      }
      return reply.code(202).send({
        evidenceId,
        evidencePartId: body.evidencePartId,
        assetKind: body.assetKind,
        queued: enq.enqueued,
        reason: enq.enqueued ? null : enq.reason,
      });
    },
  );
}
