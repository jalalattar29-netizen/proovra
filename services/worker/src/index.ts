import "./env-loader.js";
import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { logger, withJobContext } from "./logger.js";
import {
  evidencePurgeQueue,
  evidencePurgeQueueName,
  generateReportJobName,
  otsUpgradeQueue,
  otsUpgradeQueueName,
  purgeDeletedEvidenceJobName,
  redisConnection,
  reportDlqQueue,
  reportQueue,
  reportQueueName,
} from "./queue.js";
import {
  processGenerateReport,
  processPurgeDeletedEvidence,
} from "./processor.js";
import { processOtsUpgrade } from "./ots-upgrade.processor.js";
import { startHealthServer, type HealthServer } from "./health.js";
import { captureException, initSentry } from "./sentry.js";
import { reapExpiredCaptureDrafts } from "./capture-reaper.js";
import { runOrphanArtifactScan } from "./orphan-scan.js";
// Phase 27.5 — Governance operationalization workers.
import { runRetentionReconciliation } from "./governance/retention-reconciliation.worker.js";
import { runDestructionOrchestration } from "./governance/destruction-orchestrator.worker.js";
import { runImmutableStorageReconciliation } from "./governance/immutable-storage-reconciliation.worker.js";
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
  jobKind: "report" | "ots-upgrade" | "evidence-purge",
  err: unknown
): boolean {
  if (jobKind !== "ots-upgrade") return false;
  return getErrorMessage(err).trim() === "NOT_ANCHORED_YET";
}

function bindWorkerEvents(
  workerInstance: Worker,
  jobKind: "report" | "ots-upgrade" | "evidence-purge"
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

const reportWorker = new Worker(reportQueueName, processGenerateReport, {
  connection: redisConnection,
  concurrency: 2,
});

const otsUpgradeWorker = new Worker(otsUpgradeQueueName, processOtsUpgrade, {
  connection: redisConnection,
  concurrency: 1,
});

const evidencePurgeWorker = new Worker(
  evidencePurgeQueueName,
  processPurgeDeletedEvidence,
  {
    connection: redisConnection,
    concurrency: 1,
  }
);

bindWorkerEvents(reportWorker, "report");
bindWorkerEvents(otsUpgradeWorker, "ots-upgrade");
bindWorkerEvents(evidencePurgeWorker, "evidence-purge");

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
  // Phase Y — Observability schedulers.
  stopObservabilityHeartbeat();
  stopQueueHealthSampler();

  try {
    await reportWorker.pause(true);
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.pause_report_failed");
    captureException(err, { requestId });
  }

  try {
    await otsUpgradeWorker.pause(true);
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.pause_ots_upgrade_failed");
    captureException(err, { requestId });
  }

  try {
    await evidencePurgeWorker.pause(true);
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.pause_evidence_purge_failed");
    captureException(err, { requestId });
  }

  try {
    await reportWorker.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.close_report_failed");
    captureException(err, { requestId });
  }

  try {
    await otsUpgradeWorker.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.close_ots_upgrade_failed");
    captureException(err, { requestId });
  }

  try {
    await evidencePurgeWorker.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.close_evidence_purge_failed");
    captureException(err, { requestId });
  }

  try {
    await reportQueue.close();
    await reportDlqQueue.close();
    await otsUpgradeQueue.close();
    await evidencePurgeQueue.close();
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
