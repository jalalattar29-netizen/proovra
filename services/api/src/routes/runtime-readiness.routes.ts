/**
 * Phase 28-F — Runtime readiness routes. PLATFORM ADMIN ONLY.
 *
 *   GET /v1/admin/runtime/readiness  — full aggregator
 *   GET /v1/admin/runtime/queues     — queue health subset
 *   GET /v1/admin/runtime/workers    — worker subset
 *   GET /v1/admin/runtime/migrations — migration drift detail
 *
 * (GET /v1/admin/runtime/schema-status is the same family, in ops.routes.ts.)
 *
 * =============================================================================
 * WHY THE PATHS AND THE GATE BOTH CHANGED (ADM-P1-003)
 * =============================================================================
 * These four were served UNVERSIONED at `/admin/runtime/*` and authorised by
 * `requireReadinessActor` — team membership plus the `audit.read` permission.
 * That is a TENANT permission, and none of the payloads is tenant data:
 * `runReadinessCheck` and `runMigrationDriftCheck` take no teamId and answer
 * for the whole deployment. The `teamId` on the query string selected which
 * membership authorised the call and filtered nothing.
 *
 * Measured against a seeded fixture before this change, with real tokens:
 *
 *   workspace ADMIN, org OWNER      200 on all four
 *   FREE personal-plan owner,       200 on all four — including the migration
 *   using their OWN workspace id         inventory, which named four unapplied
 *                                        migrations by title
 *   workspace VIEWER                403 here, 200 on schema-status
 *
 * So a self-registered free account could read which migrations were unapplied,
 * that S3 Object Lock was disabled, how many WORKER incidents were open at
 * HIGH/CRITICAL, and whether the cron secrets and Sentry DSN were configured.
 * No secret VALUE was ever emitted; the deployment's posture was.
 *
 * OWN-1 settles it: full platform runtime, migrations, schema drift, worker
 * state and global queue detail are PLATFORM-ADMIN ONLY. The gate is now the
 * canonical `requirePlatformAdmin` and the paths sit under the versioned admin
 * namespace with the rest of the platform surface.
 *
 * The application shell still needs to colour an operational pill. It does not
 * get this payload to do it — see `GET /v1/platform/runtime-status` in
 * platform-context.routes.ts, which answers a three-value enum and nothing else.
 *
 * Read-only. Safe to poll.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { prisma } from "../db.js";
import { bump } from "../services/ops/metrics.service.js";
import { runReadinessCheck } from "../runtime/runtime-readiness.js";
import { runMigrationDriftCheck } from "../runtime/migration-drift.js";

/**
 * `teamId` IS NO LONGER AN INPUT.
 *
 * It used to be required, and it decided which membership authorised the call.
 * Nothing downstream ever read it: the readiness aggregator and the migration
 * drift checker both answer for the process and the database, not for a tenant.
 * Accepting it now would invite a caller to believe this payload is scoped, and
 * would leave a caller-supplied field sitting next to an authorization
 * decision — the shape ADM-P1-003 is about. The platform-admin gate IS the
 * boundary, exactly as it is for the rest of /v1/admin.
 */

export async function runtimeReadinessRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/admin/runtime/readiness
  //
  // Phase O — Sentry NODE-1Q (chain_transfers.updated_at) + NODE-1J
  // (subprocessors.{category,country,description}). The repair
  // migration 20270802000000_phase_sentry_batch_schema_drift_repair
  // adds the missing columns; until it is applied everywhere, any
  // sibling probe that transitively touches a drifted table MUST
  // NOT crash the whole readiness endpoint.
  //
  // `runReadinessCheck` already wraps every per-subsystem probe in
  // a try/catch that returns a typed UNKNOWN/DEGRADED/CRITICAL
  // status — that is the per-probe degradation contract documented
  // at the top of runtime-readiness.ts ("Never throws. Every error
  // path produces a `DEGRADED` or `CRITICAL` status with an
  // operator-safe reason.").
  //
  // The OUTER wrap below is belt-and-braces: if a future probe is
  // added that forgets the per-probe catch — or if Prisma raises a
  // P2022 from a connection-level path before the per-probe code
  // runs — the endpoint still returns a bounded SCHEMA_NOT_READY
  // payload instead of a 500. The payload preserves the canonical
  // shape (status / ranAtUtc / subsystems) so consumers don't
  // crash on the degraded branch.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/runtime/readiness",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      bump("runtime_readiness_check_total");
      try {
        const report = await runReadinessCheck(prisma, req.id ?? null);
        if (report.status === "DEGRADED") bump("runtime_readiness_degraded_total");
        if (report.status === "CRITICAL") bump("runtime_readiness_critical_total");
        return reply.code(200).send(report);
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          bump("runtime_readiness_degraded_total");
          return reply.code(200).send({
            status: "DEGRADED",
            ranAtUtc: new Date().toISOString(),
            durationMs: 0,
            requestId: req.id ?? null,
            subsystems: [],
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/admin/runtime/queues — queue subset of readiness.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/runtime/queues",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      bump("runtime_queue_health_check_total");
      try {
        const report = await runReadinessCheck(prisma, req.id ?? null);
        const queues = report.subsystems.find((s) => s.id === "queues");
        const redis = report.subsystems.find((s) => s.id === "redis");
        return reply.code(200).send({
          status: queues?.status ?? "UNKNOWN",
          ranAtUtc: report.ranAtUtc,
          queues,
          redis,
        });
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          return reply.code(200).send({
            status: "DEGRADED",
            ranAtUtc: new Date().toISOString(),
            queues: null,
            redis: null,
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/admin/runtime/workers — worker subset of readiness.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/runtime/workers",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const report = await runReadinessCheck(prisma, req.id ?? null);
        const workers = report.subsystems.find((s) => s.id === "workers");
        const cronSecrets = report.subsystems.find((s) => s.id === "cron_secrets");
        return reply.code(200).send({
          status: workers?.status ?? "UNKNOWN",
          ranAtUtc: report.ranAtUtc,
          workers,
          cronSecrets,
        });
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          return reply.code(200).send({
            status: "DEGRADED",
            ranAtUtc: new Date().toISOString(),
            workers: null,
            cronSecrets: null,
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/admin/runtime/migrations — migration drift detail.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/runtime/migrations",
    { preHandler: requirePlatformAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const report = await runMigrationDriftCheck(prisma);
        if (report.drift.length > 0) {
          bump("runtime_migration_drift_detected_total");
        }
        return reply.code(200).send(report);
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          return reply.code(200).send({
            drift: [],
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );
}
