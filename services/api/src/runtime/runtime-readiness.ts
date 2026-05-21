/**
 * Phase 28-F — Runtime readiness aggregator.
 *
 * Extends the Phase 28-A schema-validation module into a full
 * enterprise-readiness probe across 9 subsystems. Each subsystem
 * check is bounded, never throws, and produces a typed status
 * projection.
 *
 * Subsystems probed:
 *   - schema          (delegates to `runSchemaValidation`)
 *   - migrations      (compares prisma/migrations/ with _prisma_migrations table)
 *   - database        (SELECT 1)
 *   - redis           (env presence + bounded ping — best-effort)
 *   - s3_object_lock  (env presence; cannot verify bucket from this process safely)
 *   - queues          (BullMQ counts via existing health helpers)
 *   - workers         (recent reviewer_reconcile.completed presence)
 *   - metrics         (METRICS_SCRAPE_TOKEN env)
 *   - sentry          (SENTRY_DSN env)
 *   - cron_secrets    (REVIEWER_OPS_CRON_SECRET / INTEGRATION_CRON_SECRET env)
 *
 * Hard rules:
 *   - Never throws. Every error path produces a `DEGRADED` or
 *     `CRITICAL` status with an operator-safe reason.
 *   - Each subsystem check has a hard 2s timeout — slow probes never
 *     stall the aggregator.
 *   - Returns operator-readable remediation hints so the on-call has
 *     a starting point.
 *   - No secret values are surfaced in the output.
 *   - Schema CRITICAL still fails-fast at startup (preserved from
 *     Phase 28-A).
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db.js";
import { setGauge } from "../services/ops/metrics.service.js";
import { runSchemaValidation, type SchemaValidationReport } from "./schema-validation.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ReadinessStatus = "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";

export type SubsystemId =
  | "schema"
  | "migrations"
  | "database"
  | "redis"
  | "s3_object_lock"
  | "queues"
  | "workers"
  | "metrics"
  | "sentry"
  | "cron_secrets"
  | "search_indexing"
  | "multipart_storage"
  | "media_intelligence"
  | "investigation_graph";

export type SubsystemReadiness = {
  id: SubsystemId;
  status: ReadinessStatus;
  reasonCode: string;
  /** Operator-readable, bounded. Safe to render in UI. */
  detail: string;
  /** Optional remediation hint. Catalog-bound. */
  remediationHint: string | null;
  /** Per-subsystem bag of safe metadata. NEVER contains secrets. */
  metadata: Record<string, string | number | boolean | null>;
};

export type RuntimeReadinessReport = {
  status: ReadinessStatus;
  ranAtUtc: string;
  durationMs: number;
  requestId: string | null;
  subsystems: ReadonlyArray<SubsystemReadiness>;
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function envPresent(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

function rollUpStatus(
  subsystems: ReadonlyArray<SubsystemReadiness>,
): ReadinessStatus {
  if (subsystems.some((s) => s.status === "CRITICAL")) return "CRITICAL";
  if (subsystems.some((s) => s.status === "DEGRADED")) return "DEGRADED";
  if (subsystems.every((s) => s.status === "HEALTHY")) return "HEALTHY";
  return "UNKNOWN";
}

// -----------------------------------------------------------------------------
// Per-subsystem checks
// -----------------------------------------------------------------------------

async function checkSchema(prisma: PrismaClient): Promise<SubsystemReadiness> {
  try {
    const report: SchemaValidationReport = await withTimeout(
      runSchemaValidation(prisma),
      // Fallback on timeout: UNKNOWN.
      {
        status: "degraded",
        ranAtUtc: new Date().toISOString(),
        durationMs: CHECK_TIMEOUT_MS,
        checked: 0,
        driftFingerprint: "timeout",
        failures: [],
        subsystems: [],
      } as SchemaValidationReport,
    );
    if (report.driftFingerprint === "timeout") {
      return {
        id: "schema",
        status: "UNKNOWN",
        reasonCode: "schema_check_timeout",
        detail: "Schema validation did not complete within the readiness budget.",
        remediationHint: "Re-run /admin/runtime/schema-status manually.",
        metadata: {},
      };
    }
    const status: ReadinessStatus =
      report.status === "healthy"
        ? "HEALTHY"
        : report.status === "degraded"
          ? "DEGRADED"
          : "CRITICAL";
    return {
      id: "schema",
      status,
      reasonCode:
        report.status === "healthy"
          ? "ok"
          : `drift_${report.driftFingerprint}`,
      detail:
        report.status === "healthy"
          ? "All expected schema objects present."
          : `${report.failures.length} of ${report.checked} expected schema objects missing.`,
      remediationHint:
        report.status === "healthy"
          ? null
          : "Inspect /admin/runtime/schema-status for the per-object list and apply the production-drift-fix SQL patch.",
      metadata: {
        checked: report.checked,
        failures: report.failures.length,
        driftFingerprint: report.driftFingerprint,
      },
    };
  } catch (err) {
    return {
      id: "schema",
      status: "CRITICAL",
      reasonCode: "schema_check_error",
      detail:
        err instanceof Error
          ? err.message.slice(0, 200)
          : "schema check threw unexpectedly",
      remediationHint:
        "Schema introspection is unavailable. Verify DB connectivity and Prisma client health.",
      metadata: {},
    };
  }
}

async function checkMigrations(
  prisma: PrismaClient,
): Promise<SubsystemReadiness> {
  try {
    const rows = await withTimeout(
      prisma.$queryRawUnsafe<
        Array<{
          migration_name: string;
          finished_at: Date | null;
          rolled_back_at: Date | null;
          started_at: Date;
        }>
      >(
        `SELECT migration_name, finished_at, rolled_back_at, started_at
         FROM "_prisma_migrations"
         ORDER BY started_at DESC
         LIMIT 500`,
      ),
      [],
    );
    if (rows.length === 0) {
      return {
        id: "migrations",
        status: "DEGRADED",
        reasonCode: "no_migration_history",
        detail:
          "Prisma migrations history table is empty or unreachable. " +
          "Cannot detect drift.",
        remediationHint:
          "Confirm DB connectivity and that `prisma migrate deploy` has been run at least once.",
        metadata: {},
      };
    }

    // Phase 32.6.5 — stale-rolled-back false positive repair.
    //
    // Before this change, the check counted EVERY row where
    // `rolled_back_at != NULL` and treated any such row as currently
    // rolled back. Prisma's `migrate resolve --rolled-back` followed
    // by `migrate deploy` leaves the OLD row in place (with
    // `rolled_back_at` set) and inserts a fresh row for the same
    // `migration_name` with `finished_at` set. The historical row
    // was being counted as "currently rolled back" even though the
    // migration has since been successfully re-applied.
    //
    // Correct interpretation: take the MOST RECENT row per
    // `migration_name` (by `started_at`). Only that row reflects the
    // current state of the migration. Historical rows are kept by
    // Prisma for audit but do not represent live drift.
    //
    // `prisma migrate status` uses the same per-name latest-wins
    // interpretation; this brings the readiness check into agreement.
    const latestPerMigration = new Map<
      string,
      {
        migration_name: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
        started_at: Date;
      }
    >();
    for (const row of rows) {
      // rows are already ordered by started_at DESC, so the first row
      // we see for a given migration_name is the most recent.
      if (!latestPerMigration.has(row.migration_name)) {
        latestPerMigration.set(row.migration_name, row);
      }
    }
    const liveRows = Array.from(latestPerMigration.values());

    const failed = liveRows.filter((r) => r.rolled_back_at != null).length;
    const pending = liveRows.filter(
      (r) => r.finished_at == null && r.rolled_back_at == null,
    ).length;
    const applied = liveRows.filter(
      (r) => r.finished_at != null && r.rolled_back_at == null,
    ).length;

    // The newest "live" row (post-dedup) by started_at — this is what
    // `latest` should reflect, NOT the newest row in the raw table
    // (which could be a stale rolled-back historical artifact).
    const latestLive = liveRows.reduce<typeof liveRows[number] | null>(
      (acc, r) =>
        acc == null || r.started_at.getTime() > acc.started_at.getTime()
          ? r
          : acc,
      null,
    );

    if (failed > 0) {
      return {
        id: "migrations",
        status: "CRITICAL",
        reasonCode: "migration_rolled_back",
        detail: `${failed} migration(s) are currently rolled back. DB schema may be inconsistent.`,
        remediationHint:
          "Investigate the most recent rolled-back migration. Resolve manually via `prisma migrate resolve --rolled-back <name>` then re-run `prisma migrate deploy`.",
        metadata: {
          failed,
          pending,
          applied,
          totalLive: liveRows.length,
          latest: latestLive?.migration_name ?? "",
        },
      };
    }
    if (pending > 0) {
      return {
        id: "migrations",
        status: "DEGRADED",
        reasonCode: "migration_pending",
        detail: `${pending} migration(s) still pending. DB schema may be partial.`,
        remediationHint:
          "Run `prisma migrate deploy` or mark applied via `prisma migrate resolve --applied <name>` after manual SQL.",
        metadata: {
          pending,
          applied,
          totalLive: liveRows.length,
          latest: latestLive?.migration_name ?? "",
        },
      };
    }
    return {
      id: "migrations",
      status: "HEALTHY",
      reasonCode: "ok",
      detail: `${applied} migration(s) recorded; latest applied successfully.`,
      remediationHint: null,
      metadata: {
        applied,
        totalLive: liveRows.length,
        totalRowsScanned: rows.length,
        latest: latestLive?.migration_name ?? "",
      },
    };
  } catch (err) {
    return {
      id: "migrations",
      status: "DEGRADED",
      reasonCode: "migrations_query_failed",
      detail:
        err instanceof Error
          ? err.message.slice(0, 200)
          : "Could not query _prisma_migrations.",
      remediationHint:
        "Confirm the prisma migrations table exists. If you ran the database from a snapshot, restore the migrations history.",
      metadata: {},
    };
  }
}

async function checkDatabase(prisma: PrismaClient): Promise<SubsystemReadiness> {
  try {
    await withTimeout(
      prisma.$queryRawUnsafe<{ ok: number }[]>(`SELECT 1 AS ok`),
      [],
    );
    return {
      id: "database",
      status: "HEALTHY",
      reasonCode: "ok",
      detail: "Database reachable.",
      remediationHint: null,
      metadata: {},
    };
  } catch (err) {
    return {
      id: "database",
      status: "CRITICAL",
      reasonCode: "database_unreachable",
      detail:
        err instanceof Error
          ? err.message.slice(0, 200)
          : "Database query failed",
      remediationHint:
        "Database is unreachable. Verify connection string + network policy.",
      metadata: {},
    };
  }
}

// Phase 32.6.1 — live Redis ping with a one-shot, bounded-timeout
// client. The previous implementation only checked env presence,
// which reported HEALTHY even during a 30s outage. This new probe
// distinguishes:
//   * REDIS_URL not set → DEGRADED
//   * REDIS_URL set + ping succeeds within 1s → HEALTHY
//   * REDIS_URL set + ping times out / errors → CRITICAL
//
// The probe creates a SHORT-LIVED client, pings, then quits. We
// do NOT share the worker's persistent connection because:
//   1. The api process doesn't import worker code (Phase 31.22 boundary).
//   2. A long-lived shared client in the api would compete with the
//      worker's connection pool.
//   3. The ping client is configured for fast failure (connectTimeout
//      500ms, maxRetriesPerRequest 0) — no point retrying for a
//      health check.
async function checkRedis(): Promise<SubsystemReadiness> {
  if (!envPresent("REDIS_URL")) {
    return {
      id: "redis",
      status: "DEGRADED",
      reasonCode: "redis_not_configured",
      detail: "REDIS_URL is not set. BullMQ queues will not function.",
      remediationHint: "Set REDIS_URL in the api environment.",
      metadata: { configured: false },
    };
  }
  let pingClient: import("ioredis").default | null = null;
  const startedAt = Date.now();
  try {
    const { default: IORedis } = await import("ioredis");
    pingClient = new IORedis(process.env.REDIS_URL as string, {
      connectTimeout: 500,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
      enableOfflineQueue: false,
      // Suppress reconnect attempts — this is a single probe.
      retryStrategy: () => null,
    });
    await withTimeout(pingClient.ping(), null, 1000);
    const latencyMs = Date.now() - startedAt;
    return {
      id: "redis",
      status: "HEALTHY",
      reasonCode: "ok",
      detail: `Redis reachable in ${latencyMs}ms.`,
      remediationHint: null,
      metadata: { configured: true, reachable: true, latencyMs },
    };
  } catch (err) {
    return {
      id: "redis",
      status: "CRITICAL",
      reasonCode: "redis_unreachable",
      detail:
        err instanceof Error
          ? `Redis ping failed: ${err.message.slice(0, 120)}`
          : "Redis ping failed.",
      remediationHint:
        "Restart Redis and verify REDIS_URL. If on Docker, check container status with `docker ps`.",
      metadata: { configured: true, reachable: false },
    };
  } finally {
    if (pingClient) {
      try {
        // disconnect() is synchronous and won't throw.
        pingClient.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}

function checkS3ObjectLock(): SubsystemReadiness {
  const required = ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY"];
  const missing = required.filter((k) => !envPresent(k));
  const objectLockEnabled =
    (process.env.S3_OBJECT_LOCK_ENABLED ?? "").toLowerCase() === "true";
  if (missing.length > 0) {
    return {
      id: "s3_object_lock",
      status: "CRITICAL",
      reasonCode: "s3_env_missing",
      detail: `Missing S3 env: ${missing.join(", ")}`,
      remediationHint:
        "Configure S3 credentials. Without S3 the platform cannot store evidence.",
      metadata: { objectLockEnabled, missing: missing.join(",") },
    };
  }
  if (!objectLockEnabled) {
    return {
      id: "s3_object_lock",
      status: "DEGRADED",
      reasonCode: "object_lock_disabled",
      detail:
        "S3 Object Lock is not enabled. Destruction / immutable retention guarantees are downgraded.",
      remediationHint:
        "Set S3_OBJECT_LOCK_ENABLED=true and verify the bucket has Object Lock configured.",
      metadata: { objectLockEnabled: false },
    };
  }
  return {
    id: "s3_object_lock",
    status: "HEALTHY",
    reasonCode: "ok",
    detail: "S3 + Object Lock configured.",
    remediationHint: null,
    metadata: { objectLockEnabled: true },
  };
}

async function checkQueues(prisma: PrismaClient): Promise<SubsystemReadiness> {
  // No direct BullMQ client in the api process. We derive a coarse
  // signal from the OperationalIncident table: a HIGH-severity
  // `queue_oldest_pending_age` or `queue_backlog_high` incident open
  // right now means queues are stuck.
  try {
    const open = await withTimeout(
      prisma.operationalIncident.count({
        where: {
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          category: "WORKER",
          severity: { in: ["HIGH", "CRITICAL"] },
        },
      }),
      0,
    );
    if (open === 0) {
      return {
        id: "queues",
        status: "HEALTHY",
        reasonCode: "ok",
        detail: "No open WORKER-category incidents at HIGH/CRITICAL severity.",
        remediationHint: null,
        metadata: { openHighWorkerIncidents: 0 },
      };
    }
    return {
      id: "queues",
      status: "DEGRADED",
      reasonCode: "open_worker_incident",
      detail: `${open} open WORKER incident(s) at HIGH/CRITICAL severity. Queue may be stuck.`,
      remediationHint:
        "Inspect /v1/ops/incidents?category=WORKER. See runbooks/worker-wedged.md.",
      metadata: { openHighWorkerIncidents: open },
    };
  } catch {
    return {
      id: "queues",
      status: "UNKNOWN",
      reasonCode: "queue_check_unavailable",
      detail: "Could not derive queue health from incident table.",
      remediationHint:
        "Check worker process via deploy logs. The worker emits queue health every 60s.",
      metadata: {},
    };
  }
}

async function checkWorkers(prisma: PrismaClient): Promise<SubsystemReadiness> {
  // The worker emits a structured `reviewer_reconcile.completed` log
  // line every interval. We can't read the log stream from the api,
  // but we CAN check the audit trail: every reconcile pass writes a
  // SecurityEvent row with `eventType = "reviewer_reconcile_run"`.
  //
  // Phase 32.6 — startup grace period.
  //
  // Previously this function reported DEGRADED the instant no recent
  // audit row was found. That fired on EVERY fresh process start
  // because the reviewer-reconciliation scheduler hasn't ticked yet
  // (default interval 5 min). The result was a permanent "Failing
  // subsystems: workers" banner on every fresh deploy even though
  // the worker process was perfectly healthy and just hadn't
  // completed its first scheduled run.
  //
  // The grace period: if the API process has been alive for less
  // than 2x the reconcile interval AND no audit row exists, we
  // report WARMING (status HEALTHY, reasonCode `worker_warming`).
  // After the grace window passes, the original DEGRADED path
  // continues to fire — so a worker that genuinely never ticks
  // still surfaces as broken.
  //
  // Phase 32.6.5 — query target repair.
  //
  // Previously this check queried `AdminAuditLog.action =
  // "reviewer_reconcile_run"`. But the reconcile loop's heartbeat is
  // written by `safeEmitSecurityEvent({ eventType:
  // "reviewer_reconcile_run", ... })` in
  // services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts
  // — which writes to the `security_events` table, NOT
  // `admin_audit_logs`. The check was therefore reporting
  // `no_recent_reconcile` indefinitely after the grace window,
  // regardless of whether the worker was healthy.
  //
  // The reader now queries `SecurityEvent.eventType` to match the
  // writer. The `admin_audit_logs` write path was never present;
  // this aligns the existing reader with the existing writer.
  const intervalMs = Number(process.env.REVIEWER_OPS_RECONCILIATION_INTERVAL_MS ?? 300_000);
  const apiUptimeMs = Math.round(process.uptime() * 1000);
  const startupGraceMs = intervalMs * 2;
  try {
    const recent = await withTimeout(
      prisma.securityEvent.findFirst({
        where: { eventType: "reviewer_reconcile_run" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      null,
    );
    if (!recent) {
      // Phase 32.6 — within startup grace window, treat absence as
      // "warming up" (HEALTHY) rather than degraded. This eliminates
      // the false-positive on every fresh process start.
      if (apiUptimeMs < startupGraceMs) {
        // Bounded SRE counter — warming is not an error but is
        // worth surfacing so dashboards can spot a long-warming
        // window (e.g. worker process never started).
        try {
          const { bump } = await import("@proovra/shared-runtime/ops");
          bump("worker_readiness_warming_total");
        } catch {
          /* metrics are best-effort */
        }
        return {
          id: "workers",
          status: "HEALTHY",
          reasonCode: "worker_warming",
          detail: `API process started ${Math.round(apiUptimeMs / 1000)}s ago; awaiting first reviewer reconcile tick (interval ${Math.round(intervalMs / 60_000)}m).`,
          remediationHint: null,
          metadata: {
            apiUptimeMs,
            startupGraceMs,
          },
        };
      }
      try {
        const { bump } = await import("@proovra/shared-runtime/ops");
        bump("worker_readiness_degraded_total");
      } catch {
        /* metrics are best-effort */
      }
      return {
        id: "workers",
        status: "DEGRADED",
        reasonCode: "no_recent_reconcile",
        detail:
          "No reviewer reconciliation has been observed. Worker may not have started yet.",
        remediationHint:
          "Confirm worker process is running and REVIEWER_OPS_RECONCILIATION_ENABLED is set.",
        metadata: { apiUptimeMs, startupGraceMs },
      };
    }
    const ageMs = Date.now() - recent.createdAt.getTime();
    // Allow 3x the interval before we flag as stuck.
    const staleThresholdMs = intervalMs * 3;
    if (ageMs > staleThresholdMs) {
      return {
        id: "workers",
        status: "DEGRADED",
        reasonCode: "stale_reconcile",
        detail: `Last reconcile ${Math.round(ageMs / 60_000)}m ago — older than ${Math.round(staleThresholdMs / 60_000)}m threshold.`,
        remediationHint:
          "Worker tick may be wedged. See runbooks/worker-wedged.md.",
        metadata: {
          lastReconcileAgeMs: ageMs,
          staleThresholdMs,
        },
      };
    }
    return {
      id: "workers",
      status: "HEALTHY",
      reasonCode: "ok",
      detail: `Last reconcile ${Math.round(ageMs / 1000)}s ago.`,
      remediationHint: null,
      metadata: { lastReconcileAgeMs: ageMs },
    };
  } catch {
    return {
      id: "workers",
      status: "UNKNOWN",
      reasonCode: "worker_check_unavailable",
      detail: "Could not query worker health from audit log.",
      remediationHint:
        "Confirm AdminAuditLog table is reachable and worker writes are landing.",
      metadata: {},
    };
  }
}

function checkMetrics(): SubsystemReadiness {
  const hasToken = envPresent("METRICS_SCRAPE_TOKEN");
  return {
    id: "metrics",
    status: "HEALTHY",
    reasonCode: hasToken ? "token_configured" : "open_endpoint",
    detail: hasToken
      ? "Metrics endpoint is token-gated."
      : "Metrics endpoint is open (network-firewalled).",
    remediationHint: null,
    metadata: { tokenGated: hasToken },
  };
}

function checkSentry(): SubsystemReadiness {
  const dsnPresent = envPresent("SENTRY_DSN");
  return {
    id: "sentry",
    status: dsnPresent ? "HEALTHY" : "DEGRADED",
    reasonCode: dsnPresent ? "configured" : "sentry_disabled",
    detail: dsnPresent
      ? "Sentry DSN configured."
      : "Sentry DSN not configured. Exception capture is a no-op.",
    remediationHint: dsnPresent ? null : "Set SENTRY_DSN to enable error capture.",
    metadata: { configured: dsnPresent },
  };
}

function checkCronSecrets(): SubsystemReadiness {
  const reviewer = envPresent("REVIEWER_OPS_CRON_SECRET");
  const integration = envPresent("INTEGRATION_CRON_SECRET");
  if (reviewer || integration) {
    return {
      id: "cron_secrets",
      status: "HEALTHY",
      reasonCode: "configured",
      detail: "At least one cron secret is configured.",
      remediationHint: null,
      metadata: {
        reviewerOpsSecretConfigured: reviewer,
        integrationSecretConfigured: integration,
      },
    };
  }
  return {
    id: "cron_secrets",
    status: "DEGRADED",
    reasonCode: "no_cron_secret",
    detail: "No cron secret configured. Reconcile endpoint will return 503.",
    remediationHint:
      "Set REVIEWER_OPS_CRON_SECRET (or INTEGRATION_CRON_SECRET as fallback).",
    metadata: {},
  };
}

// -----------------------------------------------------------------------------
// Phase 24-B — Search Discovery indexing readiness.
//
// Signals:
//   - oldest unindexed OCR row age (seconds)
//   - oldest unindexed transcript row age (seconds)
//   - failed-indexing event in the last hour (best-effort, via
//     SecurityEvent table)
//   - schema presence of evidence_search_documents (already covered by
//     `schema` subsystem; this check focuses on data freshness)
//   - presence of the optional FTS `tsv` column (HEALTHY ⇒ FTS path is
//     active; missing ⇒ ILIKE fallback, DEGRADED hint)
//
// Status rollup:
//   - CRITICAL when the search_audit_logs / evidence_search_documents
//     tables are missing (schema drift on a load-bearing surface)
//   - DEGRADED when any indexing lag > 30 min or FTS column missing
//   - HEALTHY otherwise
//   - UNKNOWN when the readiness probe itself failed
// -----------------------------------------------------------------------------

const SEARCH_INDEXING_LAG_DEGRADED_SECONDS = 30 * 60;
const SEARCH_INDEXING_LAG_CRITICAL_SECONDS = 24 * 60 * 60;

async function checkSearchIndexing(
  prisma: PrismaClient,
): Promise<SubsystemReadiness> {
  try {
    const [ocrLag, transcriptLag, ftsPresent, auditPresent, docsPresent] =
      await Promise.all([
        // Oldest unindexed OCR row across the entire instance (workspace-
        // agnostic — readiness is a global signal).
        (prisma.$queryRawUnsafe(
          `SELECT EXTRACT(EPOCH FROM (NOW() - MIN("extracted_at_utc"))) AS lag
             FROM "evidence_ocr_text"
             WHERE "indexed_at_utc" IS NULL`,
        ) as Promise<Array<{ lag: string | null }>>).catch(
          () => [{ lag: null }],
        ),
        (prisma.$queryRawUnsafe(
          `SELECT EXTRACT(EPOCH FROM (NOW() - MIN("extracted_at_utc"))) AS lag
             FROM "evidence_transcript_segments"
             WHERE "indexed_at_utc" IS NULL`,
        ) as Promise<Array<{ lag: string | null }>>).catch(
          () => [{ lag: null }],
        ),
        // FTS column presence — drives the "FTS active vs ILIKE
        // fallback" branch of the readiness rollup.
        (prisma.$queryRawUnsafe(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'evidence_search_documents'
               AND column_name = 'tsv'
           ) AS present`,
        ) as Promise<Array<{ present: boolean }>>).catch(
          () => [{ present: false }],
        ),
        (prisma.$queryRawUnsafe(
          `SELECT (to_regclass('public.search_audit_logs') IS NOT NULL) AS present`,
        ) as Promise<Array<{ present: boolean }>>).catch(
          () => [{ present: false }],
        ),
        (prisma.$queryRawUnsafe(
          `SELECT (to_regclass('public.evidence_search_documents') IS NOT NULL) AS present`,
        ) as Promise<Array<{ present: boolean }>>).catch(
          () => [{ present: false }],
        ),
      ]);
    const ocrLagSeconds = ocrLag[0]?.lag
      ? Number(ocrLag[0].lag)
      : null;
    const transcriptLagSeconds = transcriptLag[0]?.lag
      ? Number(transcriptLag[0].lag)
      : null;
    const ftsActive = ftsPresent[0]?.present === true;
    const auditOk = auditPresent[0]?.present === true;
    const docsOk = docsPresent[0]?.present === true;
    const maxLag = Math.max(ocrLagSeconds ?? 0, transcriptLagSeconds ?? 0);

    // Schema-drift CRITICAL: docs or audit missing.
    if (!docsOk || !auditOk) {
      return {
        id: "search_indexing",
        status: "CRITICAL",
        reasonCode: docsOk ? "audit_log_missing" : "search_documents_missing",
        detail: docsOk
          ? "Discovery audit log table is missing — run the Phase 24-J drift patch (search_audit_logs)."
          : "Search document table is missing — Discovery is disabled until the Phase 24 migration is applied.",
        remediationHint:
          "Apply services/api/sql/drift-patches/2026-05-19-search-audit-log.sql and re-run readiness.",
        metadata: {
          docsPresent: docsOk,
          auditPresent: auditOk,
          ftsActive,
          ocrLagSeconds,
          transcriptLagSeconds,
        },
      };
    }

    // Lag CRITICAL ⇒ indexing has been stalled > 24h.
    if (maxLag >= SEARCH_INDEXING_LAG_CRITICAL_SECONDS) {
      return {
        id: "search_indexing",
        status: "CRITICAL",
        reasonCode: "indexing_lag_critical",
        detail: `Discovery indexing is stalled — oldest unindexed row is ${Math.round(maxLag / 3600)}h old.`,
        remediationHint:
          "Inspect the search-indexing worker logs and the BullMQ search-indexing queue depth in /ops/observability.",
        metadata: {
          docsPresent: true,
          auditPresent: true,
          ftsActive,
          ocrLagSeconds,
          transcriptLagSeconds,
        },
      };
    }

    // Lag DEGRADED OR FTS missing (ILIKE fallback active).
    if (
      maxLag >= SEARCH_INDEXING_LAG_DEGRADED_SECONDS ||
      !ftsActive
    ) {
      return {
        id: "search_indexing",
        status: "DEGRADED",
        reasonCode: !ftsActive
          ? "fts_column_missing"
          : "indexing_lag_degraded",
        detail: !ftsActive
          ? "Discovery FTS column (evidence_search_documents.tsv) is missing — search is using the ILIKE fallback. Apply the Phase 24-J FTS drift patch for full-text search performance."
          : `Discovery indexing is behind — oldest unindexed row is ${Math.round(maxLag / 60)} min old.`,
        remediationHint: !ftsActive
          ? "Apply services/api/sql/drift-patches/2026-05-19-search-fts-pgvector.sql."
          : "Check the search-indexing worker heartbeat.",
        metadata: {
          docsPresent: true,
          auditPresent: true,
          ftsActive,
          ocrLagSeconds,
          transcriptLagSeconds,
        },
      };
    }

    return {
      id: "search_indexing",
      status: "HEALTHY",
      reasonCode: "ok",
      detail: ftsActive
        ? "Discovery indexing is current — FTS active, no indexing lag."
        : "Discovery indexing is current — ILIKE fallback active.",
      remediationHint: null,
      metadata: {
        docsPresent: true,
        auditPresent: true,
        ftsActive,
        ocrLagSeconds,
        transcriptLagSeconds,
      },
    };
  } catch (err) {
    return {
      id: "search_indexing",
      status: "UNKNOWN",
      reasonCode: "readiness_probe_failed",
      detail:
        err instanceof Error
          ? `Discovery readiness probe failed: ${err.message.slice(0, 160)}`
          : "Discovery readiness probe failed.",
      remediationHint:
        "Re-run /admin/runtime/readiness. If repeated, inspect the api process logs.",
      metadata: {},
    };
  }
}

// -----------------------------------------------------------------------------
// Phase 30.8 — multipart storage health
//
// Reports on the S3 native multipart upload subsystem:
//   * Active multipart sessions (state UPLOADING with multipart_upload_id)
//   * Stale multipart sessions (expired but storage_complete/abort still null)
//   * Abort backlog (stale rows the reaper has not yet swept)
//   * Failed multipart completions in the last hour
//
// Status:
//   * CRITICAL if S3_BUCKET is unset (multipart cannot run).
//   * DEGRADED if abort backlog > 20 OR failed completions > 10 / hour.
//   * HEALTHY otherwise.
// -----------------------------------------------------------------------------

async function checkMultipartStorage(
  prisma: PrismaClient,
): Promise<SubsystemReadiness> {
  if (!envPresent("S3_BUCKET")) {
    return {
      id: "multipart_storage",
      status: "CRITICAL",
      reasonCode: "s3_bucket_missing",
      detail:
        "S3_BUCKET is not set. Multipart uploads cannot be initiated against storage.",
      remediationHint: "Set S3_BUCKET to the bucket configured for evidence storage.",
      metadata: { configured: false },
    };
  }
  let active = 0;
  let stale = 0;
  let recentlyFailed = 0;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE "multipart_upload_id" IS NOT NULL
                          AND "completed_at_storage_utc" IS NULL
                          AND "aborted_at_storage_utc" IS NULL
                          AND "state" = 'UPLOADING') AS "active",
         COUNT(*) FILTER (WHERE "multipart_upload_id" IS NOT NULL
                          AND "completed_at_storage_utc" IS NULL
                          AND "aborted_at_storage_utc" IS NULL
                          AND "expires_at_utc" < NOW()) AS "stale",
         COUNT(*) FILTER (WHERE "state" = 'FAILED'
                          AND "updated_at_utc" > NOW() - INTERVAL '1 hour'
                          AND "multipart_upload_id" IS NOT NULL) AS "recently_failed"
       FROM "evidence_upload_sessions"`,
    )) as Array<{ active: bigint | number; stale: bigint | number; recently_failed: bigint | number }>;
    const r = rows[0];
    if (r) {
      active = Number(r.active ?? 0);
      stale = Number(r.stale ?? 0);
      recentlyFailed = Number(r.recently_failed ?? 0);
    }
  } catch {
    return {
      id: "multipart_storage",
      status: "UNKNOWN",
      reasonCode: "query_failed",
      detail: "Could not query evidence_upload_sessions for multipart health.",
      remediationHint:
        "Verify the Phase 30.8 drift patch has been applied + DB is reachable.",
      metadata: { configured: true },
    };
  }
  const degraded = stale > 20 || recentlyFailed > 10;
  return {
    id: "multipart_storage",
    status: degraded ? "DEGRADED" : "HEALTHY",
    reasonCode: degraded ? "abort_backlog_high" : "ok",
    detail: degraded
      ? `Multipart storage degraded: stale=${stale}, recently_failed=${recentlyFailed}`
      : `Multipart storage healthy: active=${active}, stale=${stale}, recently_failed=${recentlyFailed}`,
    remediationHint: degraded
      ? "Run the multipart reaper (see reapStaleMultipartUploads in upload-session service). Check S3 bucket lifecycle policy."
      : null,
    metadata: {
      active,
      stale,
      recentlyFailed,
      configured: true,
    },
  };
}

// -----------------------------------------------------------------------------
// Phase 31 — Media intelligence advisory layer health
//
// Reports the deterministic-analyzer backlog. Because the analyzer
// is invoked synchronously today (no async worker queue), this
// subsystem is HEALTHY whenever the `media_intelligence_signals`
// table is reachable. A future async-worker phase will surface
// backlog / failure-rate metrics here.
//
// Status:
//   * UNKNOWN if the table is missing (e.g. drift patch not yet run).
//   * HEALTHY otherwise.
// The core evidence path runs without this subsystem; it is
// IMPORTANT but never CRITICAL by design.
// -----------------------------------------------------------------------------

async function checkMediaIntelligence(
  prisma: PrismaClient,
): Promise<SubsystemReadiness> {
  // Signals table — the read surface. Required for the subsystem
  // to be HEALTHY.
  let pending = 0;
  let acknowledged = 0;
  let attention = 0;
  let signalsReachable = true;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE "status" = 'PENDING') AS "pending",
         COUNT(*) FILTER (WHERE "status" = 'ACKNOWLEDGED') AS "acknowledged",
         COUNT(*) FILTER (WHERE "severity" = 'ATTENTION') AS "attention"
       FROM "media_intelligence_signals"`,
    )) as Array<{
      pending: bigint | number;
      acknowledged: bigint | number;
      attention: bigint | number;
    }>;
    const r = rows[0];
    pending = r ? Number(r.pending ?? 0) : 0;
    acknowledged = r ? Number(r.acknowledged ?? 0) : 0;
    attention = r ? Number(r.attention ?? 0) : 0;
  } catch {
    signalsReachable = false;
  }
  if (!signalsReachable) {
    return {
      id: "media_intelligence",
      status: "UNKNOWN",
      reasonCode: "table_unreachable",
      detail:
        "Could not query media_intelligence_signals. Drift patch may not be applied yet.",
      remediationHint:
        "Apply services/api/sql/drift-patches/2026-05-20-media-intelligence-signals.sql to your database.",
      metadata: {},
    };
  }

  // Phase 31.6 — async runs lifecycle. The runs table is optional
  // (Phase 31 ran the analyzer synchronously). If present we surface
  // pending/processing/failed counts plus the oldest pending age so
  // SRE can pin "queue is wedged" tiles on the same readiness panel.
  let runsPending = 0;
  let runsProcessing = 0;
  let runsFailed = 0;
  let oldestPendingAgeSeconds = 0;
  let runsTableReachable = true;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE "status" = 'PENDING') AS "pending",
         COUNT(*) FILTER (WHERE "status" = 'PROCESSING') AS "processing",
         COUNT(*) FILTER (WHERE "status" = 'FAILED') AS "failed",
         COALESCE(
           EXTRACT(
             EPOCH FROM (
               NOW() - MIN("created_at_utc")
               FILTER (WHERE "status" IN ('PENDING','PROCESSING'))
             )
           ),
           0
         ) AS "oldest_pending_age_seconds"
       FROM "media_intelligence_runs"`,
    )) as Array<{
      pending: bigint | number;
      processing: bigint | number;
      failed: bigint | number;
      oldest_pending_age_seconds: number | string | null;
    }>;
    const r = rows[0];
    runsPending = r ? Number(r.pending ?? 0) : 0;
    runsProcessing = r ? Number(r.processing ?? 0) : 0;
    runsFailed = r ? Number(r.failed ?? 0) : 0;
    oldestPendingAgeSeconds = r
      ? Math.max(0, Math.floor(Number(r.oldest_pending_age_seconds ?? 0)))
      : 0;
    // Surface as gauges so the /v1/ops/metrics snapshot tiles see
    // them on the next scrape.
    setGauge("media_intelligence_runs_pending", runsPending);
    setGauge("media_intelligence_runs_processing", runsProcessing);
    setGauge("media_intelligence_runs_failed", runsFailed);
    setGauge(
      "media_intelligence_oldest_pending_age_seconds",
      oldestPendingAgeSeconds,
    );
    setGauge(
      "media_intelligence_queue_depth",
      runsPending + runsProcessing,
    );
  } catch {
    runsTableReachable = false;
  }

  // DEGRADED if we have a meaningful backlog OR an old pending run.
  const HOUR = 3600;
  const backlogDegraded = runsPending + runsProcessing > 200;
  const pendingTooOld = oldestPendingAgeSeconds > 6 * HOUR;
  if (runsTableReachable && (backlogDegraded || pendingTooOld)) {
    return {
      id: "media_intelligence",
      status: "DEGRADED",
      reasonCode: pendingTooOld ? "run_backlog_stale" : "run_backlog_large",
      detail: pendingTooOld
        ? `Oldest pending media-intelligence run is ${Math.round(oldestPendingAgeSeconds / 3600)}h old.`
        : `Media-intelligence run backlog is ${runsPending + runsProcessing}.`,
      remediationHint:
        "Inspect /v1/ops/metrics for media_intelligence_queue_depth + media-intelligence worker logs.",
      metadata: {
        pending,
        acknowledged,
        attention,
        runsPending,
        runsProcessing,
        runsFailed,
        oldestPendingAgeSeconds,
        runsTableReachable,
      },
    };
  }

  return {
    id: "media_intelligence",
    status: "HEALTHY",
    reasonCode: "ok",
    detail: runsTableReachable
      ? `Media intelligence reachable. signals: pending=${pending}, acknowledged=${acknowledged}, attention=${attention}. runs: pending=${runsPending}, processing=${runsProcessing}, failed=${runsFailed}`
      : `Media intelligence advisory layer reachable. pending=${pending}, acknowledged=${acknowledged}, attention=${attention}`,
    remediationHint: null,
    metadata: {
      pending,
      acknowledged,
      attention,
      runsPending,
      runsProcessing,
      runsFailed,
      oldestPendingAgeSeconds,
      runsTableReachable,
    },
  };
}

// -----------------------------------------------------------------------------
// Phase 32 — Investigation graph health
//
// Reports node/edge counts + the active vs stale split. Advisory-
// only subsystem (never blocks evidence lifecycle). UNKNOWN if the
// table is unreachable (drift patch not yet applied).
// -----------------------------------------------------------------------------

async function checkInvestigationGraph(
  prisma: PrismaClient,
): Promise<SubsystemReadiness> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*) FROM "investigation_graph_nodes" WHERE "stale_at_utc" IS NULL) AS "active_nodes",
         (SELECT COUNT(*) FROM "investigation_graph_edges" WHERE "stale_at_utc" IS NULL) AS "active_edges",
         (SELECT COUNT(*) FROM "investigation_graph_edges" WHERE "stale_at_utc" IS NOT NULL) AS "stale_edges"`,
    )) as Array<{
      active_nodes: bigint | number;
      active_edges: bigint | number;
      stale_edges: bigint | number;
    }>;
    const r = rows[0];
    const activeNodes = r ? Number(r.active_nodes ?? 0) : 0;
    const activeEdges = r ? Number(r.active_edges ?? 0) : 0;
    const staleEdges = r ? Number(r.stale_edges ?? 0) : 0;
    return {
      id: "investigation_graph",
      status: "HEALTHY",
      reasonCode: "ok",
      detail: `Investigation graph reachable. active_nodes=${activeNodes}, active_edges=${activeEdges}, stale_edges=${staleEdges}`,
      remediationHint: null,
      metadata: { activeNodes, activeEdges, staleEdges },
    };
  } catch {
    return {
      id: "investigation_graph",
      status: "UNKNOWN",
      reasonCode: "table_unreachable",
      detail:
        "Could not query investigation_graph_nodes / _edges. Drift patch may not be applied yet.",
      remediationHint:
        "Apply services/api/sql/drift-patches/2026-05-20-investigation-graph.sql to your database.",
      metadata: {},
    };
  }
}

// -----------------------------------------------------------------------------
// Aggregator entry
// -----------------------------------------------------------------------------

export async function runReadinessCheck(
  prisma: PrismaClient = defaultPrisma,
  requestId: string | null = null,
): Promise<RuntimeReadinessReport> {
  const startedAt = Date.now();
  const subsystems: SubsystemReadiness[] = await Promise.all([
    checkSchema(prisma),
    checkMigrations(prisma),
    checkDatabase(prisma),
    Promise.resolve(checkRedis()),
    Promise.resolve(checkS3ObjectLock()),
    checkQueues(prisma),
    checkWorkers(prisma),
    Promise.resolve(checkMetrics()),
    Promise.resolve(checkSentry()),
    Promise.resolve(checkCronSecrets()),
    checkSearchIndexing(prisma),
    checkMultipartStorage(prisma),
    checkMediaIntelligence(prisma),
    checkInvestigationGraph(prisma),
  ]);
  return {
    status: rollUpStatus(subsystems),
    ranAtUtc: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    requestId,
    subsystems,
  };
}
