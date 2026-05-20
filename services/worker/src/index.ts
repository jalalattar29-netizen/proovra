import "./env-loader.js";
import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { logger, withJobContext } from "./logger.js";
import {
  derivedAssetsQueue,
  derivedAssetsQueueName,
  evidencePurgeQueue,
  evidencePurgeQueueName,
  exifQueue,
  exifQueueName,
  generateReportJobName,
  graphDomainSyncQueue,
  graphDomainSyncQueueName,
  graphReconcileQueue,
  graphReconcileQueueName,
  graphSearchProjectionQueue,
  graphSearchProjectionQueueName,
  graphTimelineSyncQueue,
  graphTimelineSyncQueueName,
  mediaIntelligenceQueue,
  mediaIntelligenceQueueName,
  miSearchIndexQueue,
  miSearchIndexQueueName,
  ocrQueue,
  ocrQueueName,
  otsUpgradeQueue,
  otsUpgradeQueueName,
  purgeDeletedEvidenceJobName,
  redisConnection,
  reportDlqQueue,
  reportQueue,
  reportQueueName,
  searchIndexingQueue,
  searchIndexingQueueName,
  transcriptQueue,
  transcriptQueueName,
} from "./queue.js";
import {
  processGenerateReport,
  processPurgeDeletedEvidence,
} from "./processor.js";
import { processOtsUpgrade } from "./ots-upgrade.processor.js";
import { processSearchIndexingJob } from "./search-indexing.processor.js";
import { processMediaIntelligenceJob } from "./media-intelligence.processor.js";
import { processDerivedAssetJob } from "./derived-assets.processor.js";
// Phase 31.19 / 31.20 — seven isolated subsystem queue processors.
import {
  processGraphDomainSyncJob,
  processGraphReconcileJob,
  processGraphSearchProjectionJob,
  processGraphTimelineSyncJob,
  processMiSearchIndexJob,
  processOcrJob,
  processTranscriptJob,
} from "./subsystem-queue-processors.js";
import { startHealthServer, type HealthServer } from "./health.js";
import { captureException, initSentry } from "./sentry.js";
import { reapExpiredCaptureDrafts } from "./capture-reaper.js";
import { runOrphanArtifactScan } from "./orphan-scan.js";
// Phase 27.5 — Governance operationalization workers.
import { runRetentionReconciliation } from "./governance/retention-reconciliation.worker.js";
import { runDestructionOrchestration } from "./governance/destruction-orchestrator.worker.js";
import { runImmutableStorageReconciliation } from "./governance/immutable-storage-reconciliation.worker.js";
// Reviewer Ops activation — periodic reconcile tick across all teams.
import { runReviewerReconciliation } from "./reviewer-ops/reviewer-reconciliation.worker.js";
// Hotfix — API readiness probe so startup-triggered fetches don't
// race the api process and trigger spurious operational alerts.
import {
  ensureApiReadyOnce,
  type ApiReadinessResult,
} from "./api-readiness.js";
// Phase Y — Observability heartbeat + job-outcome instrumentation.
import {
  heartbeat,
  instrumentJobOutcome,
  snapshotQueueHealth,
} from "./observability.js";

type JobData = { evidenceId?: string };

function envString(name: string): string | undefined {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = envString(name);
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

function emitOperationalAlert(params: {
  requestId: string;
  reason: string;
  err?: unknown;
  context?: Record<string, unknown>;
}) {
  logger.error(
    {
      alert: true,
      severity: "critical",
      requestId: params.requestId,
      reason: params.reason,
      ...(params.context ?? {}),
      ...(params.err ? { err: params.err } : {}),
    },
    "operational.alert"
  );
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

function isExpectedOtsPendingError(
  jobKind: WorkerKind,
  err: unknown
): boolean {
  if (jobKind !== "ots-upgrade") return false;
  return getErrorMessage(err).trim() === "NOT_ANCHORED_YET";
}

function bindWorkerEvents(
  workerInstance: Worker,
  jobKind: WorkerKind
) {
  workerInstance.on("completed", (job) => {
    const requestId = randomUUID();
    const durationMs =
      job.finishedOn && job.processedOn
        ? job.finishedOn - job.processedOn
        : null;

    logger.info(
      withJobContext({
        requestId,
        jobId: job.id,
        evidenceId: (job.data as JobData | undefined)?.evidenceId,
        attempt: job.attemptsMade + 1,
        durationMs: durationMs ?? undefined,
        status: "completed",
      }),
      `${jobKind}.job.completed`
    );
    // Phase Y — structured outcome line for log-based metrics.
    instrumentJobOutcome({
      queueName: jobKind,
      jobId: job.id ?? null,
      attempt: job.attemptsMade + 1,
      durationMs,
      outcome: "completed",
      correlationId: requestId,
    });
  });

  workerInstance.on("failed", (job, err) => {
    if (!job) return;

    const requestId = randomUUID();
    const durationMs =
      job.finishedOn && job.processedOn
        ? job.finishedOn - job.processedOn
        : job.processedOn
          ? Date.now() - job.processedOn
          : null;

    const context = {
      ...withJobContext({
        requestId,
        jobId: job.id,
        evidenceId: (job.data as JobData | undefined)?.evidenceId,
        attempt: job.attemptsMade + 1,
        durationMs: durationMs ?? undefined,
        status: "failed",
      }),
    };

    if (isExpectedOtsPendingError(jobKind, err)) {
      logger.warn(
        {
          ...context,
          err,
        },
        `${jobKind}.job.pending_retry`
      );
      // Phase Y — pending retry is NOT a failure, but track it as a
      // distinct outcome for the dashboard.
      instrumentJobOutcome({
        queueName: jobKind,
        jobId: job.id ?? null,
        attempt: job.attemptsMade + 1,
        durationMs,
        outcome: "stalled",
        correlationId: requestId,
        errorMessage: getErrorMessage(err),
      });
      return;
    }

    logger.error({ ...context, err }, `${jobKind}.job.failed`);
    captureException(err, {
      requestId,
      evidenceId: (job.data as JobData | undefined)?.evidenceId,
      jobId: job.id ?? null,
      jobKind,
    });

    emitOperationalAlert({
      requestId,
      reason: `${jobKind}_job_failed`,
      err,
      context,
    });
    // Phase Y — structured outcome line for log-based metrics.
    instrumentJobOutcome({
      queueName: jobKind,
      jobId: job.id ?? null,
      attempt: job.attemptsMade + 1,
      durationMs,
      outcome: "failed",
      correlationId: requestId,
      errorMessage: getErrorMessage(err),
    });
  });

  workerInstance.on("error", (err) => {
    const requestId = randomUUID();
    logger.error({ requestId, err, jobKind }, `${jobKind}.worker.error`);
    captureException(err, { requestId, jobKind });

    emitOperationalAlert({
      requestId,
      reason: `${jobKind}_worker_runtime_error`,
      err,
    });
  });
}

const internalApiBase =
  envString("INTERNAL_API_BASE_URL") ??
  envString("API_BASE_URL") ??
  "http://proovra-api:8080";

const internalApiKey = envString("INTERNAL_API_KEY");
const followUpEnabled = envBoolean("DEMO_FOLLOW_UP_ENABLED", true);
const followUpIntervalMs = envNumber(
  "DEMO_FOLLOW_UP_INTERVAL_MS",
  60 * 60 * 1000
);

// Hotfix — API readiness probe knobs. Defaults: 12 attempts × ~30s cap.
// Operators can tune via env (mostly useful in slow staging envs).
const apiReadinessEnabled = envBoolean("WORKER_API_READINESS_PROBE_ENABLED", true);
const apiReadinessMaxAttempts = envNumber(
  "WORKER_API_READINESS_MAX_ATTEMPTS",
  12,
);
const apiReadinessInitialBackoffMs = envNumber(
  "WORKER_API_READINESS_INITIAL_BACKOFF_MS",
  500,
);
const apiReadinessMaxBackoffMs = envNumber(
  "WORKER_API_READINESS_MAX_BACKOFF_MS",
  5_000,
);
const apiReadinessAttemptTimeoutMs = envNumber(
  "WORKER_API_READINESS_ATTEMPT_TIMEOUT_MS",
  2_000,
);

/**
 * Gate a startup-triggered consumer behind the api readiness probe.
 *
 * If the api is reachable, the consumer runs immediately. If the api
 * is NOT reachable after `maxAttempts`, the consumer skips this tick.
 * The interval scheduler will retry on its next cron firing.
 *
 * Sustained failure (post-exhaustion) emits exactly ONE operational
 * alert — startup-race failures (the common case) never alert.
 */
async function gateStartupOnApiReadiness(
  consumer: string,
): Promise<ApiReadinessResult> {
  if (!apiReadinessEnabled) {
    return { ready: true, attempts: 0, totalLatencyMs: 0 };
  }
  return ensureApiReadyOnce({
    baseUrl: internalApiBase,
    consumer,
    maxAttempts: apiReadinessMaxAttempts,
    initialBackoffMs: apiReadinessInitialBackoffMs,
    maxBackoffMs: apiReadinessMaxBackoffMs,
    attemptTimeoutMs: apiReadinessAttemptTimeoutMs,
    onSustainedFailure: ({ requestId, attempts, totalLatencyMs, lastError }) => {
      emitOperationalAlert({
        requestId,
        reason: "worker_api_readiness_probe_exhausted",
        context: {
          consumer,
          attempts,
          totalLatencyMs,
          lastError,
          internalApiBase,
        },
      });
    },
  });
}

let followUpTimer: NodeJS.Timeout | null = null;
let followUpRunning = false;

async function runDemoFollowUps(trigger: "startup" | "interval") {
  if (!followUpEnabled) return;

  if (!internalApiKey) {
    logger.warn(
      {
        requestId: randomUUID(),
        trigger,
      },
      "followup.run.skipped_missing_internal_api_key"
    );
    return;
  }

  if (followUpRunning) {
    logger.warn(
      {
        requestId: randomUUID(),
        trigger,
      },
      "followup.run.skipped_already_running"
    );
    return;
  }

  followUpRunning = true;
  const requestId = randomUUID();
  const startedAt = Date.now();

  try {
    const url = `${internalApiBase.replace(/\/+$/, "")}/v1/admin/demo-requests/follow-up/run`;

    logger.info(
      {
        requestId,
        trigger,
        url,
      },
      "followup.run.started"
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": internalApiKey,
      },
      body: JSON.stringify({
        limit: 25,
      }),
    });

    const raw = await response.text();
    let parsed: unknown = null;

    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw || null;
    }

    if (!response.ok) {
      throw new Error(
        `Follow-up run failed with status ${response.status}${
          parsed
            ? `: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`
            : ""
        }`
      );
    }

    logger.info(
      {
        requestId,
        trigger,
        durationMs: Date.now() - startedAt,
        result: parsed,
      },
      "followup.run.completed"
    );
  } catch (err) {
    logger.error(
      {
        requestId,
        trigger,
        durationMs: Date.now() - startedAt,
        err,
      },
      "followup.run.failed"
    );

    captureException(err, {
      requestId,
      trigger,
      internalApiBase,
    });

    emitOperationalAlert({
      requestId,
      reason: "demo_followup_run_failed",
      err,
      context: {
        trigger,
        internalApiBase,
      },
    });
  } finally {
    followUpRunning = false;
  }
}

function startDemoFollowUpScheduler() {
  if (!followUpEnabled) {
    logger.info(
      {
        requestId: randomUUID(),
      },
      "followup.scheduler.disabled"
    );
    return;
  }

  if (!internalApiKey) {
    logger.warn(
      {
        requestId: randomUUID(),
        internalApiBase,
      },
      "followup.scheduler.started_without_internal_api_key"
    );
  }

  followUpTimer = setInterval(() => {
    void runDemoFollowUps("interval");
  }, followUpIntervalMs);

  logger.info(
    {
      requestId: randomUUID(),
      intervalMs: followUpIntervalMs,
      internalApiBase,
      followUpEnabled,
    },
    "followup.scheduler.started"
  );

  // Hotfix — gate the startup invocation behind the api readiness
  // probe. If readiness fails after `maxAttempts`, we skip the
  // startup tick (the interval timer above will retry naturally) and
  // emit exactly one alert for sustained unavailability. Transient
  // startup-race ECONNREFUSED no longer escapes as an alert.
  void (async () => {
    const readiness = await gateStartupOnApiReadiness("demo-followup");
    if (!readiness.ready) {
      logger.warn(
        {
          requestId: randomUUID(),
          consumer: "demo-followup",
          attempts: readiness.attempts,
          totalLatencyMs: readiness.totalLatencyMs,
          lastError: readiness.lastError,
        },
        "followup.run.skipped_api_unready",
      );
      return;
    }
    void runDemoFollowUps("startup");
  })();
}

function stopDemoFollowUpScheduler() {
  if (followUpTimer) {
    clearInterval(followUpTimer);
    followUpTimer = null;
  }
}

// Phase C #8 — capture draft reaper scheduler.
// Defaults to a 30-minute sweep. Disable with CAPTURE_DRAFT_REAPER_ENABLED=false.
const captureReaperEnabled = envBoolean(
  "CAPTURE_DRAFT_REAPER_ENABLED",
  true
);
const captureReaperIntervalMs = envNumber(
  "CAPTURE_DRAFT_REAPER_INTERVAL_MS",
  30 * 60 * 1000
);
let captureReaperTimer: ReturnType<typeof setInterval> | null = null;
let captureReaperRunning = false;

async function runCaptureDraftReaper(trigger: string) {
  if (captureReaperRunning) return;
  captureReaperRunning = true;
  try {
    await reapExpiredCaptureDrafts({ trigger });
  } catch (err) {
    logger.error({ err, trigger }, "capture.reaper.failed");
    captureException(err, { trigger });
  } finally {
    captureReaperRunning = false;
  }
}

function startCaptureDraftReaperScheduler() {
  if (!captureReaperEnabled) {
    logger.info({}, "capture.reaper.scheduler.disabled");
    return;
  }
  captureReaperTimer = setInterval(() => {
    void runCaptureDraftReaper("interval");
  }, captureReaperIntervalMs);
  logger.info(
    { intervalMs: captureReaperIntervalMs },
    "capture.reaper.scheduler.started"
  );
  // Hotfix — gate the startup invocation behind api readiness. The
  // reaper itself only writes to the DB, but we keep the system as a
  // whole quiet until the api is reachable so the startup log stream
  // is uniform across consumers. After the first ready signal the
  // probe short-circuits via the process singleton.
  void (async () => {
    const readiness = await gateStartupOnApiReadiness("capture-reaper");
    if (!readiness.ready) {
      logger.warn(
        {
          requestId: randomUUID(),
          consumer: "capture-reaper",
          attempts: readiness.attempts,
          totalLatencyMs: readiness.totalLatencyMs,
          lastError: readiness.lastError,
        },
        "capture.reaper.skipped_api_unready",
      );
      return;
    }
    void runCaptureDraftReaper("startup");
  })();
}

function stopCaptureDraftReaperScheduler() {
  if (captureReaperTimer) {
    clearInterval(captureReaperTimer);
    captureReaperTimer = null;
  }
}

// Phase C #9 — orphan upload / artifact scan scheduler.
// Defaults to a 6-hour sweep. Disable with ORPHAN_ARTIFACT_SCAN_ENABLED=false.
const orphanScanEnabled = envBoolean(
  "ORPHAN_ARTIFACT_SCAN_ENABLED",
  true
);
const orphanScanIntervalMs = envNumber(
  "ORPHAN_ARTIFACT_SCAN_INTERVAL_MS",
  6 * 60 * 60 * 1000
);
let orphanScanTimer: ReturnType<typeof setInterval> | null = null;
let orphanScanRunning = false;

async function runOrphanScan(trigger: string) {
  if (orphanScanRunning) return;
  orphanScanRunning = true;
  try {
    await runOrphanArtifactScan({ trigger });
  } catch (err) {
    logger.error({ err, trigger }, "orphan.scan.failed");
    captureException(err, { trigger });
  } finally {
    orphanScanRunning = false;
  }
}

function startOrphanScanScheduler() {
  if (!orphanScanEnabled) {
    logger.info({}, "orphan.scan.scheduler.disabled");
    return;
  }
  orphanScanTimer = setInterval(() => {
    void runOrphanScan("interval");
  }, orphanScanIntervalMs);
  logger.info(
    { intervalMs: orphanScanIntervalMs },
    "orphan.scan.scheduler.started"
  );
}

function stopOrphanScanScheduler() {
  if (orphanScanTimer) {
    clearInterval(orphanScanTimer);
    orphanScanTimer = null;
  }
}

// -----------------------------------------------------------------------------
// Phase 27.5 — Governance operationalization schedulers.
// Three workers, each with its own enable / interval env. The workers
// are idempotent and lock-protected, so missed ticks are recoverable.
// Defaults are deliberately conservative — operator can lower in prod.
// -----------------------------------------------------------------------------

const retentionReconciliationEnabled = envBoolean(
  "RETENTION_RECONCILIATION_ENABLED",
  true,
);
const retentionReconciliationIntervalMs = envNumber(
  "RETENTION_RECONCILIATION_INTERVAL_MS",
  15 * 60 * 1000, // 15m
);
let retentionReconciliationTimer: ReturnType<typeof setInterval> | null = null;
let retentionReconciliationRunning = false;

async function runRetentionRecon(trigger: string) {
  if (retentionReconciliationRunning) return;
  retentionReconciliationRunning = true;
  try {
    await runRetentionReconciliation({ trigger });
  } catch (err) {
    logger.error({ err, trigger }, "governance.retention_reconciliation.failed");
    captureException(err, { trigger });
  } finally {
    retentionReconciliationRunning = false;
  }
}

function startRetentionReconciliationScheduler() {
  if (!retentionReconciliationEnabled) {
    logger.info({}, "governance.retention_reconciliation.scheduler.disabled");
    return;
  }
  retentionReconciliationTimer = setInterval(() => {
    void runRetentionRecon("interval");
  }, retentionReconciliationIntervalMs);
  logger.info(
    { intervalMs: retentionReconciliationIntervalMs },
    "governance.retention_reconciliation.scheduler.started",
  );
  // Hotfix — governance workers must not execute before api readiness
  // confirmation. The recon worker writes to the same DB but the
  // operational contract is that the system runtime is "up" only when
  // the api accepts traffic. Sustained probe failure escalates to one
  // operational alert; transient startup races are silent.
  void (async () => {
    const readiness = await gateStartupOnApiReadiness(
      "retention-reconciliation",
    );
    if (!readiness.ready) {
      logger.warn(
        {
          requestId: randomUUID(),
          consumer: "retention-reconciliation",
          attempts: readiness.attempts,
          totalLatencyMs: readiness.totalLatencyMs,
          lastError: readiness.lastError,
        },
        "governance.retention_reconciliation.skipped_api_unready",
      );
      return;
    }
    void runRetentionRecon("startup");
  })();
}

function stopRetentionReconciliationScheduler() {
  if (retentionReconciliationTimer) {
    clearInterval(retentionReconciliationTimer);
    retentionReconciliationTimer = null;
  }
}

const destructionOrchestratorEnabled = envBoolean(
  "DESTRUCTION_ORCHESTRATOR_ENABLED",
  true,
);
const destructionOrchestratorIntervalMs = envNumber(
  "DESTRUCTION_ORCHESTRATOR_INTERVAL_MS",
  5 * 60 * 1000, // 5m
);
let destructionOrchestratorTimer: ReturnType<typeof setInterval> | null = null;
let destructionOrchestratorRunning = false;

async function runDestructionOrch(trigger: string) {
  if (destructionOrchestratorRunning) return;
  destructionOrchestratorRunning = true;
  try {
    await runDestructionOrchestration({ trigger });
  } catch (err) {
    logger.error({ err, trigger }, "governance.destruction_orchestrator.failed");
    captureException(err, { trigger });
  } finally {
    destructionOrchestratorRunning = false;
  }
}

function startDestructionOrchestratorScheduler() {
  if (!destructionOrchestratorEnabled) {
    logger.info({}, "governance.destruction_orchestrator.scheduler.disabled");
    return;
  }
  destructionOrchestratorTimer = setInterval(() => {
    void runDestructionOrch("interval");
  }, destructionOrchestratorIntervalMs);
  logger.info(
    { intervalMs: destructionOrchestratorIntervalMs },
    "governance.destruction_orchestrator.scheduler.started",
  );
}

function stopDestructionOrchestratorScheduler() {
  if (destructionOrchestratorTimer) {
    clearInterval(destructionOrchestratorTimer);
    destructionOrchestratorTimer = null;
  }
}

const immutableStorageReconciliationEnabled = envBoolean(
  "IMMUTABLE_STORAGE_RECONCILIATION_ENABLED",
  true,
);
const immutableStorageReconciliationIntervalMs = envNumber(
  "IMMUTABLE_STORAGE_RECONCILIATION_INTERVAL_MS",
  60 * 60 * 1000, // 1h
);
let immutableStorageReconciliationTimer: ReturnType<typeof setInterval> | null = null;
let immutableStorageReconciliationRunning = false;

async function runImmutableRecon(trigger: string) {
  if (immutableStorageReconciliationRunning) return;
  immutableStorageReconciliationRunning = true;
  try {
    await runImmutableStorageReconciliation({ trigger });
  } catch (err) {
    logger.error(
      { err, trigger },
      "governance.immutable_storage_reconciliation.failed",
    );
    captureException(err, { trigger });
  } finally {
    immutableStorageReconciliationRunning = false;
  }
}

function startImmutableStorageReconciliationScheduler() {
  if (!immutableStorageReconciliationEnabled) {
    logger.info(
      {},
      "governance.immutable_storage_reconciliation.scheduler.disabled",
    );
    return;
  }
  immutableStorageReconciliationTimer = setInterval(() => {
    void runImmutableRecon("interval");
  }, immutableStorageReconciliationIntervalMs);
  logger.info(
    { intervalMs: immutableStorageReconciliationIntervalMs },
    "governance.immutable_storage_reconciliation.scheduler.started",
  );
}

function stopImmutableStorageReconciliationScheduler() {
  if (immutableStorageReconciliationTimer) {
    clearInterval(immutableStorageReconciliationTimer);
    immutableStorageReconciliationTimer = null;
  }
}

// -----------------------------------------------------------------------------
// Reviewer Ops reconciliation scheduler.
//
// Drives the entire reviewer-ops lifecycle (SLA progression, escalation
// generation, workload snapshots, reminder fan-out) by invoking the
// api's all-teams reconcile endpoint on a fixed interval. Before this
// scheduler existed the lifecycle was dormant — pages loaded but no
// SLA timer fired, no escalation row was generated, no workload
// snapshot was written. This is the missing wire.
//
// Tunables (all envs are optional with safe defaults):
//   REVIEWER_OPS_RECONCILIATION_ENABLED  — default true
//   REVIEWER_OPS_RECONCILIATION_INTERVAL_MS — default 5m (sensible
//                                            cadence for SLA timers
//                                            that flip at hour
//                                            boundaries)
//   REVIEWER_OPS_RECONCILIATION_BATCH_SIZE — passed to runReconcile()
//                                            per team
//   REVIEWER_OPS_MAX_TEAMS_PER_SWEEP       — upper bound per tick
// -----------------------------------------------------------------------------

const reviewerReconciliationEnabled = envBoolean(
  "REVIEWER_OPS_RECONCILIATION_ENABLED",
  true,
);
const reviewerReconciliationIntervalMs = envNumber(
  "REVIEWER_OPS_RECONCILIATION_INTERVAL_MS",
  5 * 60 * 1000, // 5m
);
const reviewerReconciliationBatchSize = envNumber(
  "REVIEWER_OPS_RECONCILIATION_BATCH_SIZE",
  200,
);
const reviewerReconciliationMaxTeamsPerSweep = envNumber(
  "REVIEWER_OPS_MAX_TEAMS_PER_SWEEP",
  500,
);
let reviewerReconciliationTimer: ReturnType<typeof setInterval> | null = null;
let reviewerReconciliationRunning = false;

async function runReviewerRecon(trigger: string) {
  if (reviewerReconciliationRunning) return;
  reviewerReconciliationRunning = true;
  try {
    await runReviewerReconciliation({
      trigger,
      batchSize: reviewerReconciliationBatchSize,
      maxTeamsPerSweep: reviewerReconciliationMaxTeamsPerSweep,
    });
  } catch (err) {
    logger.error({ err, trigger }, "reviewer_ops.reconciliation.failed");
    captureException(err, { trigger });
  } finally {
    reviewerReconciliationRunning = false;
  }
}

function startReviewerReconciliationScheduler() {
  if (!reviewerReconciliationEnabled) {
    logger.info({}, "reviewer_ops.reconciliation.scheduler.disabled");
    return;
  }
  reviewerReconciliationTimer = setInterval(() => {
    void runReviewerRecon("interval");
  }, reviewerReconciliationIntervalMs);
  logger.info(
    {
      intervalMs: reviewerReconciliationIntervalMs,
      batchSize: reviewerReconciliationBatchSize,
      maxTeamsPerSweep: reviewerReconciliationMaxTeamsPerSweep,
    },
    "reviewer_ops.reconciliation.scheduler.started",
  );
  // Gate startup-triggered first run on api readiness. The reconcile
  // endpoint lives on the api; calling it before /readyz returns
  // 200 would just trip the existing api-readiness fallback.
  void (async () => {
    const readiness = await gateStartupOnApiReadiness(
      "reviewer-reconciliation",
    );
    if (!readiness.ready) {
      logger.warn(
        {
          requestId: randomUUID(),
          consumer: "reviewer-reconciliation",
          attempts: readiness.attempts,
          totalLatencyMs: readiness.totalLatencyMs,
          lastError: readiness.lastError,
        },
        "reviewer_ops.reconciliation.skipped_api_unready",
      );
      return;
    }
    void runReviewerRecon("startup");
  })();
}

function stopReviewerReconciliationScheduler() {
  if (reviewerReconciliationTimer) {
    clearInterval(reviewerReconciliationTimer);
    reviewerReconciliationTimer = null;
  }
}

// -----------------------------------------------------------------------------
// Phase Y — Observability heartbeat + queue health sampler.
//
// Heartbeat: emits a structured log line every 30 seconds. The log
// contains `heartbeat: true` + `workerId` + ISO timestamp. A future
// scraper (or `tail -f`) can compute "age of last heartbeat" to
// detect stuck workers.
//
// Queue health sampler: every 60 seconds, snapshots BullMQ counts
// for the three known queues and emits a structured log line. The
// dashboard reads this directly via the worker's health endpoint.
// -----------------------------------------------------------------------------

const observabilityHeartbeatIntervalMs = envNumber(
  "WORKER_HEARTBEAT_INTERVAL_MS",
  30_000,
);
const queueHealthSamplerIntervalMs = envNumber(
  "WORKER_QUEUE_HEALTH_INTERVAL_MS",
  60_000,
);
let observabilityHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let queueHealthSamplerTimer: ReturnType<typeof setInterval> | null = null;
let lastQueueHealthSample: unknown = null;

function startObservabilityHeartbeat() {
  heartbeat("worker-main");
  observabilityHeartbeatTimer = setInterval(() => {
    heartbeat("worker-main");
  }, observabilityHeartbeatIntervalMs);
  logger.info(
    { intervalMs: observabilityHeartbeatIntervalMs },
    "worker.heartbeat.scheduler.started",
  );
}

function stopObservabilityHeartbeat() {
  if (observabilityHeartbeatTimer) {
    clearInterval(observabilityHeartbeatTimer);
    observabilityHeartbeatTimer = null;
  }
}

async function sampleQueueHealthOnce() {
  try {
    const snapshot = await snapshotQueueHealth([
      { name: reportQueueName, queue: reportQueue },
      { name: otsUpgradeQueueName, queue: otsUpgradeQueue },
      { name: evidencePurgeQueueName, queue: evidencePurgeQueue },
    ]);
    lastQueueHealthSample = snapshot;
    logger.info(
      { queueHealthSample: true, queues: snapshot },
      "worker.queue_health.sampled",
    );
  } catch (err) {
    logger.warn({ err }, "worker.queue_health.sample_failed");
  }
}

function startQueueHealthSampler() {
  void sampleQueueHealthOnce();
  queueHealthSamplerTimer = setInterval(() => {
    void sampleQueueHealthOnce();
  }, queueHealthSamplerIntervalMs);
  logger.info(
    { intervalMs: queueHealthSamplerIntervalMs },
    "worker.queue_health.sampler.started",
  );
}

function stopQueueHealthSampler() {
  if (queueHealthSamplerTimer) {
    clearInterval(queueHealthSamplerTimer);
    queueHealthSamplerTimer = null;
  }
}

/** Read-only accessor for the most recent queue-health snapshot. */
export function getLatestQueueHealthSnapshot(): unknown {
  return lastQueueHealthSample;
}

initSentry();

// HOTFIX — Startup readiness protection.
//
// A single processor that throws during `new Worker(...)`
// construction must NOT kill the entire worker runtime. Before
// this guard, a faulty processor (e.g. an import-time
// PrismaClientInitializationError from `search-indexing.processor`)
// would crash the boot sequence and take down report generation,
// verification package generation, and every other queue —
// triggering downstream API 404s on `/v1/evidence/:id/report/latest`
// and `/v1/evidence/:id/verification-package`.
//
// safeRegisterWorker wraps each Worker construction in a try/catch
// + binds events on success. On failure it emits a structured
// `worker.processor_registration_failed` alert and returns null.
// Downstream shutdown logic null-checks before closing.
//
// This is defense in depth: the underlying root cause must still
// be fixed (and is — see search-indexing.processor.ts hotfix).
// Belt + suspenders so SRE never again sees a silent total worker
// outage from a single processor regression.

type WorkerKind =
  | "report"
  | "ots-upgrade"
  | "evidence-purge"
  | "search-indexing"
  | "media-intelligence"
  | "derived-assets"
  | "mi-exif"
  | "mi-ocr"
  | "mi-transcript"
  | "mi-search-index"
  | "graph-reconcile"
  | "graph-domain-sync"
  | "graph-timeline-sync"
  | "graph-search-projection";

function safeRegisterWorker(
  kind: WorkerKind,
  factory: () => Worker,
): Worker | null {
  try {
    const workerInstance = factory();
    bindWorkerEvents(workerInstance, kind);
    logger.info(
      { processor: kind, status: "registered" },
      "worker.processor_registered",
    );
    return workerInstance;
  } catch (err) {
    const requestId = randomUUID();
    emitOperationalAlert({
      requestId,
      reason: "processor_registration_failed",
      err,
      context: {
        processor: kind,
        message:
          err instanceof Error
            ? err.message.slice(0, 200)
            : "unknown",
      },
    });
    captureException(err, {
      kind: "worker.processor_registration_failed",
      processor: kind,
    });
    // Return null so the rest of the worker boots. SRE sees the
    // structured alert + the affected queue stays unprocessed
    // (versus today where one bad processor kills every queue).
    return null;
  }
}

const reportWorker = safeRegisterWorker("report", () =>
  new Worker(reportQueueName, processGenerateReport, {
    connection: redisConnection,
    concurrency: 2,
  }),
);

const otsUpgradeWorker = safeRegisterWorker("ots-upgrade", () =>
  new Worker(otsUpgradeQueueName, processOtsUpgrade, {
    connection: redisConnection,
    concurrency: 1,
  }),
);

const evidencePurgeWorker = safeRegisterWorker("evidence-purge", () =>
  new Worker(evidencePurgeQueueName, processPurgeDeletedEvidence, {
    connection: redisConnection,
    concurrency: 1,
  }),
);

// Phase 24-J — Search Discovery indexing worker.
const searchIndexingWorker = safeRegisterWorker("search-indexing", () =>
  new Worker(searchIndexingQueueName, processSearchIndexingJob, {
    connection: redisConnection,
    concurrency: 2,
  }),
);

// Phase 31.6 — Media intelligence async worker. Bounded concurrency
// (1) — the analyzer is read-only against EvidencePart + clientSignals
// + EvidenceIntelligenceJob, so saturating the DB with parallel
// per-evidence scans is the only realistic failure mode. One at a
// time keeps backpressure on the queue rather than on Postgres.
const mediaIntelligenceWorker = safeRegisterWorker("media-intelligence", () =>
  new Worker(mediaIntelligenceQueueName, processMediaIntelligenceJob, {
    connection: redisConnection,
    concurrency: 1,
  }),
);

// Phase 31.13 — dedicated derived-assets worker. ISOLATED from the
// media-intelligence worker so a sharp-side stall can never affect
// EXIF extraction or analyzer jobs. Concurrency 1 keeps the load
// on sharp + S3 bounded (each job pulls up to 4MB source + writes
// a small thumbnail).
const derivedAssetsWorker = safeRegisterWorker("derived-assets", () =>
  new Worker(derivedAssetsQueueName, processDerivedAssetJob, {
    connection: redisConnection,
    concurrency: 1,
  }),
);

// Phase 31.18 — dedicated EXIF worker (mi-exif). ISOLATED from the
// generic media-intelligence worker so EXIF extraction (which only
// reads ~16KB per part and parses with `exifr`) cannot be head-of-
// line blocked by analyzer runs. Concurrency 2 — EXIF parsing is
// CPU-light and bounded; we can run two in parallel without
// saturating Postgres. Reuses processMediaIntelligenceJob: the
// processor branches on `kind`, and only `extract_exif` flows here.
const exifWorker = safeRegisterWorker("mi-exif", () =>
  new Worker(exifQueueName, processMediaIntelligenceJob, {
    connection: redisConnection,
    concurrency: 2,
  }),
);

// Phase 31.19 — four more isolated subsystem workers.
//
// mi-ocr / mi-transcript: producers gated on vendor decision. The
// processor logs receipt and completes (NOT_CONFIGURED). Concurrency
// is bounded so a vendor that returns slowly cannot saturate the
// worker process.
//
// mi-search-index: thin shim that delegates to the existing Phase
// 24-J search-indexing queue. Lets the reviewer console / ops UI
// trigger a bounded reindex per evidence without coupling to the
// generic search-indexing producer.
//
// graph-reconcile: dedicated queue for ad-hoc graph rebuild
// triggers (operator action, escalation hook, scheduled recurrence).
// Worker invokes the read-only `reconcileTeamGraph` service.
const ocrWorker = safeRegisterWorker("mi-ocr", () =>
  new Worker(ocrQueueName, processOcrJob, {
    connection: redisConnection,
    concurrency: 1,
  }),
);

const transcriptWorker = safeRegisterWorker("mi-transcript", () =>
  new Worker(transcriptQueueName, processTranscriptJob, {
    connection: redisConnection,
    concurrency: 1,
  }),
);

const miSearchIndexWorker = safeRegisterWorker("mi-search-index", () =>
  new Worker(miSearchIndexQueueName, processMiSearchIndexJob, {
    connection: redisConnection,
    concurrency: 2,
  }),
);

const graphReconcileWorker = safeRegisterWorker("graph-reconcile", () =>
  new Worker(graphReconcileQueueName, processGraphReconcileJob, {
    connection: redisConnection,
    concurrency: 1,
  }),
);

// Phase 31.20 — final three isolated subsystem workers, completing
// the 9-queue isolation program. graph-domain-sync delegates to the
// existing reconciler; graph-timeline-sync and graph-search-projection
// are observable canonical targets for future incremental writers.
const graphDomainSyncWorker = safeRegisterWorker("graph-domain-sync", () =>
  new Worker(graphDomainSyncQueueName, processGraphDomainSyncJob, {
    connection: redisConnection,
    concurrency: 1,
  }),
);

const graphTimelineSyncWorker = safeRegisterWorker("graph-timeline-sync", () =>
  new Worker(graphTimelineSyncQueueName, processGraphTimelineSyncJob, {
    connection: redisConnection,
    concurrency: 2,
  }),
);

const graphSearchProjectionWorker = safeRegisterWorker(
  "graph-search-projection",
  () =>
    new Worker(graphSearchProjectionQueueName, processGraphSearchProjectionJob, {
      connection: redisConnection,
      concurrency: 2,
    }),
);

let healthServer: HealthServer | null = null;
let shuttingDown = false;

async function shutdown(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ requestId: randomUUID(), exitCode }, "worker.shutdown_started");

  stopDemoFollowUpScheduler();
  stopCaptureDraftReaperScheduler();
  stopOrphanScanScheduler();
  // Phase 27.5 — Governance schedulers.
  stopRetentionReconciliationScheduler();
  stopDestructionOrchestratorScheduler();
  stopImmutableStorageReconciliationScheduler();
  // Reviewer Ops scheduler.
  stopReviewerReconciliationScheduler();
  // Phase Y — Observability schedulers.
  stopObservabilityHeartbeat();
  stopQueueHealthSampler();

  // HOTFIX — null-check before pause/close. With startup-readiness
  // protection (safeRegisterWorker), a failed processor returns
  // null instead of crashing the runtime. Shutdown must skip
  // null workers cleanly.

  if (reportWorker) {
    try {
      await reportWorker.pause(true);
    } catch (err) {
      const requestId = randomUUID();
      logger.error({ requestId, err }, "worker.pause_report_failed");
      captureException(err, { requestId });
    }
  }

  if (otsUpgradeWorker) {
    try {
      await otsUpgradeWorker.pause(true);
    } catch (err) {
      const requestId = randomUUID();
      logger.error({ requestId, err }, "worker.pause_ots_upgrade_failed");
      captureException(err, { requestId });
    }
  }

  if (evidencePurgeWorker) {
    try {
      await evidencePurgeWorker.pause(true);
    } catch (err) {
      const requestId = randomUUID();
      logger.error({ requestId, err }, "worker.pause_evidence_purge_failed");
      captureException(err, { requestId });
    }
  }

  if (reportWorker) {
    try {
      await reportWorker.close();
    } catch (err) {
      const requestId = randomUUID();
      logger.error({ requestId, err }, "worker.close_report_failed");
      captureException(err, { requestId });
    }
  }

  if (otsUpgradeWorker) {
    try {
      await otsUpgradeWorker.close();
    } catch (err) {
      const requestId = randomUUID();
      logger.error({ requestId, err }, "worker.close_ots_upgrade_failed");
      captureException(err, { requestId });
    }
  }

  if (evidencePurgeWorker) {
    try {
      await evidencePurgeWorker.close();
    } catch (err) {
      const requestId = randomUUID();
      logger.error({ requestId, err }, "worker.close_evidence_purge_failed");
      captureException(err, { requestId });
    }
  }

  if (searchIndexingWorker) {
    try {
      await searchIndexingWorker.close();
    } catch (err) {
      const requestId = randomUUID();
      logger.error({ requestId, err }, "worker.close_search_indexing_failed");
      captureException(err, { requestId });
    }
  }

  // Phase 31.6 — media intelligence worker null-checked close.
  if (mediaIntelligenceWorker) {
    try {
      await mediaIntelligenceWorker.close();
    } catch (err) {
      const requestId = randomUUID();
      logger.error(
        { requestId, err },
        "worker.close_media_intelligence_failed",
      );
      captureException(err, { requestId });
    }
  }

  // Phase 31.13 — derived assets worker null-checked close.
  if (derivedAssetsWorker) {
    try {
      await derivedAssetsWorker.close();
    } catch (err) {
      const requestId = randomUUID();
      logger.error(
        { requestId, err },
        "worker.close_derived_assets_failed",
      );
      captureException(err, { requestId });
    }
  }

  // Phase 31.18 — exif worker null-checked close.
  if (exifWorker) {
    try {
      await exifWorker.close();
    } catch (err) {
      const requestId = randomUUID();
      logger.error({ requestId, err }, "worker.close_exif_failed");
      captureException(err, { requestId });
    }
  }

  // Phase 31.19 / 31.20 — seven more isolated subsystem workers,
  // each null-checked. A failed safeRegisterWorker returns null so
  // a single processor regression cannot crash the shutdown path.
  for (const [name, w] of [
    ["mi-ocr", ocrWorker] as const,
    ["mi-transcript", transcriptWorker] as const,
    ["mi-search-index", miSearchIndexWorker] as const,
    ["graph-reconcile", graphReconcileWorker] as const,
    ["graph-domain-sync", graphDomainSyncWorker] as const,
    ["graph-timeline-sync", graphTimelineSyncWorker] as const,
    ["graph-search-projection", graphSearchProjectionWorker] as const,
  ]) {
    if (!w) continue;
    try {
      await w.close();
    } catch (err) {
      const requestId = randomUUID();
      logger.error({ requestId, name, err }, "worker.close_subsystem_failed");
      captureException(err, { requestId });
    }
  }

  try {
    await reportQueue.close();
    await reportDlqQueue.close();
    await otsUpgradeQueue.close();
    await evidencePurgeQueue.close();
    await searchIndexingQueue.close();
    // Phase 31.6 — media intelligence queue + DLQ.
    await mediaIntelligenceQueue.close();
    // Phase 31.13 — derived assets queue.
    await derivedAssetsQueue.close();
    // Phase 31.18 — exif queue.
    await exifQueue.close();
    // Phase 31.19 — four more isolated subsystem queues.
    await ocrQueue.close();
    await transcriptQueue.close();
    await miSearchIndexQueue.close();
    await graphReconcileQueue.close();
    // Phase 31.20 — final three isolated subsystem queues.
    await graphDomainSyncQueue.close();
    await graphTimelineSyncQueue.close();
    await graphSearchProjectionQueue.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.queue_close_failed");
    captureException(err, { requestId });
  }

  try {
    await redisConnection.quit();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.redis_close_failed");
    captureException(err, { requestId });
  }

  try {
    await healthServer?.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.health_close_failed");
    captureException(err, { requestId });
  }

  process.exit(exitCode);
}

startHealthServer()
  .then(async (server) => {
    healthServer = server;
    // Phase C #1 — Object Lock startup verification at the worker too.
    // Throws in production-shaped envs when S3_OBJECT_LOCK_ENABLED=true but
    // the bucket cannot accept retention writes.
    try {
      const { bootstrapObjectLockVerification } = await import(
        "./object-lock-bootstrap.js"
      );
      await bootstrapObjectLockVerification();
    } catch (err) {
      logger.error({ err }, "worker.object_lock.bootstrap_failed");
      captureException(err, { phase: "worker.object_lock_bootstrap" });
      // Refuse to start so operators see the failure in production.
      void shutdown(1);
      return;
    }
    startDemoFollowUpScheduler();
    startCaptureDraftReaperScheduler();
    startOrphanScanScheduler();
    // Phase 27.5 — Governance schedulers.
    startRetentionReconciliationScheduler();
    startDestructionOrchestratorScheduler();
    startImmutableStorageReconciliationScheduler();
    // Reviewer Ops activation — drives SLA / escalation / workload /
    // reminder engines across all teams on a fixed interval.
    startReviewerReconciliationScheduler();
    // Phase Y — Observability heartbeat + queue-health sampler.
    // The heartbeat fires every 30s; a log-based metrics provider
    // can derive `worker_last_heartbeat_age_seconds` by tailing
    // `worker.heartbeat` log lines. The queue sampler fires every
    // 60s and emits a structured snapshot operators / dashboards
    // can read.
    startObservabilityHeartbeat();
    startQueueHealthSampler();
  })
  .catch((err) => {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.health_start_failed");
    captureException(err, { requestId });

    emitOperationalAlert({
      requestId,
      reason: "worker_health_server_failed",
      err,
    });

    void shutdown(1);
  });

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("unhandledRejection", (reason) => {
  const requestId = randomUUID();
  logger.error({ requestId, err: reason }, "worker.unhandled_rejection");
  captureException(reason, { requestId });

  emitOperationalAlert({
    requestId,
    reason: "worker_unhandled_rejection",
    err: reason,
  });

  void shutdown(1);
});

process.on("uncaughtException", (err) => {
  const requestId = randomUUID();
  logger.error({ requestId, err }, "worker.uncaught_exception");
  captureException(err, { requestId });

  emitOperationalAlert({
    requestId,
    reason: "worker_uncaught_exception",
    err,
  });

  void shutdown(1);
});

logger.info(
  {
    requestId: randomUUID(),
    jobs: [generateReportJobName, otsUpgradeQueueName, purgeDeletedEvidenceJobName],
    followUpEnabled,
    followUpIntervalMs,
    internalApiBase,
  },
  "worker.started"
);
