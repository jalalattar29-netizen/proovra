import "./env-loader.js";
// Phase P2.0B — OTEL bootstrap must be among the first imports so
// auto-instrumentations patch http / ioredis / pg before BullMQ /
// Prisma load. No-op when OTEL_ENABLED is not "true".
import "./otel-bootstrap.js";
// Phase 31.22 — register the worker's Prisma instance with the
// @proovra/shared-runtime registry BEFORE any processor module
// loads. Side-effect import; do not remove or reorder.
import "./register-shared-runtime.js";
import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
// PHASE 12 CORRECTIVE PASS §4 (SEC-004) — the ONE secrets authority, shared
// with the API. See the call site near the bottom of this file.
import { initSecretsAuthority } from "@proovra/shared-runtime";
import { logger, withJobContext } from "./logger.js";
import {
  derivedAssetsQueue,
  derivedAssetsQueueName,
  redactionDerivativeQueueName,
  redactionDerivativeQueue,
  enqueueRedactionDerivativeRenderWorker,
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
  miEmbedQueue,
  miEmbedQueueName,
  miSearchIndexQueue,
  miSearchIndexQueueName,
  orgHealthRefreshQueue,
  orgHealthRefreshQueueName,
  otsUpgradeQueue,
  otsUpgradeQueueName,
  purgeDeletedEvidenceJobName,
  mediaIntelligenceDlqQueue,
  mediaIntelligenceDlqQueueName,
  redisConnection,
  reportDlqQueue,
  reportDlqQueueName,
  reportQueue,
  reportQueueName,
  searchIndexingQueue,
  searchIndexingQueueName,
} from "./queue.js";
import {
  processGenerateReport,
  processPurgeDeletedEvidence,
} from "./processor.js";
import { processOtsUpgrade } from "./ots-upgrade.processor.js";
import { processSearchIndexingJob } from "./search-indexing.processor.js";
import {
  processExifQueueJob,
  processMediaIntelligenceJob,
} from "./media-intelligence.processor.js";
import { processDerivedAssetJob } from "./derived-assets.processor.js";
// Phase 16 — dedicated mi-embed worker for semantic embedding compute.
import { processMiEmbedJob } from "./mi-embed.processor.js";
// Phase 31.19 / 31.20 — seven isolated subsystem queue processors.
import {
  processGraphDomainSyncJob,
  processGraphReconcileJob,
  processGraphSearchProjectionJob,
  processGraphTimelineSyncJob,
  processMiSearchIndexJob,
  processOrgHealthRefreshJob,
} from "./subsystem-queue-processors.js";
import { startHealthServer, type HealthServer } from "./health.js";
import { startTelemetrySampler, type TelemetrySampler } from "./telemetry.js";
import { captureException, initSentry } from "./sentry.js";
// Phase O1.3 — cross-service trace propagation helper + bounded span
// enum. The helper wraps the BullMQ job processor so it inherits the
// parent OTEL context injected by the API at enqueue time.
import { wrapJobHandlerWithOtelContext } from "./observability/queue-otel-context.js";
import { PROOVRA_SPAN_NAMES } from "./otel.js";
import { reapExpiredCaptureDrafts } from "./capture-reaper.js";
import { runOrphanArtifactScan } from "./orphan-scan.js";
import { runSearchIndexReconciler } from "./search-index-reconciler.js";
import { runIntelligenceRunReconciler } from "./intelligence-run-reconciler.js";
import { runLifecycleRecovery } from "./lifecycle-recovery.js";
import { withCronLock } from "./cron-lock.js";
// Phase 27.5 — Governance operationalization workers.
import {
  processRedactionDerivativeJob,
  reconcileStrandedRedactionDerivatives,
} from "./redaction/redaction-derivative.processor.js";
import { runRetentionReconciliation } from "./governance/retention-reconciliation.worker.js";
import { runDestructionOrchestration } from "./governance/destruction-orchestrator.worker.js";
import {
  automaticDestructionEnabled,
  runTrashGraceReconciliation,
} from "./governance/trash-grace-reconciler.js";
import { runImmutableStorageReconciliation } from "./governance/immutable-storage-reconciliation.worker.js";
// Phase 4B Final Closure I7 — Archive tier auto-transition scheduler.
import { runArchiveTierAutoTransitions } from "./governance/archive-tier-auto-transition.worker.js";
// Reviewer Ops activation — periodic reconcile tick across all teams.
import { runReviewerReconciliation } from "./reviewer-ops/reviewer-reconciliation.worker.js";
// Macro-Wave A2 — org-invite delivery sweep tick (stranded/due PENDING
// outbox rows; retries rotate the invite token API-side).
import { runOrgInviteDeliverySweep } from "./org-invite-delivery.worker.js";
import { runAutomationDispatchSweepTick } from "./automation-dispatch.js";
// P5 — Webhook dispatcher + Evidence Exchange package builder schedulers.
import { runWebhookDispatcherTick } from "./webhook-dispatcher.js";
import { pollExchangePackageBuilds } from "./exchange-package-builder.js";
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
// Phase R4 — SIGNED-without-report lifecycle recovery scheduler.
//
// Closes the commit-to-enqueue crash window (finding F4): evidence
// completion commits (status → SIGNED) and enqueues the report job AFTER
// the commit; a crash / Redis outage in that gap leaves evidence durably
// SIGNED with no report job, stuck forever. This periodic reconciler
// re-enqueues the report job for such rows. It is idempotent (dedup by
// deterministic report job id) and churn-free (skips plan-ineligible
// evidence), so a missed tick or multi-replica overlap is safe.
//
// Default interval: 5 minutes. Disable with LIFECYCLE_RECOVERY_ENABLED=false.
// -----------------------------------------------------------------------------

const lifecycleRecoveryEnabled = envBoolean("LIFECYCLE_RECOVERY_ENABLED", true);
const lifecycleRecoveryIntervalMs = envNumber(
  "LIFECYCLE_RECOVERY_INTERVAL_MS",
  5 * 60 * 1000,
);

let lifecycleRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let lifecycleRecoveryRunning = false;

async function runLifecycleRecoverySafe(trigger: string) {
  if (lifecycleRecoveryRunning) return;
  lifecycleRecoveryRunning = true;
  try {
    await runLifecycleRecovery({ trigger });
  } catch (err) {
    logger.error({ err, trigger }, "lifecycle.recovery.failed");
    captureException(err, { trigger });
  } finally {
    lifecycleRecoveryRunning = false;
  }
}

function startLifecycleRecoveryScheduler() {
  if (!lifecycleRecoveryEnabled) {
    logger.info({}, "lifecycle.recovery.scheduler.disabled");
    return;
  }
  lifecycleRecoveryTimer = setInterval(() => {
    void runLifecycleRecoverySafe("interval");
  }, lifecycleRecoveryIntervalMs);
  logger.info(
    { intervalMs: lifecycleRecoveryIntervalMs },
    "lifecycle.recovery.scheduler.started",
  );
}

function stopLifecycleRecoveryScheduler() {
  if (lifecycleRecoveryTimer) {
    clearInterval(lifecycleRecoveryTimer);
    lifecycleRecoveryTimer = null;
  }
}

// -----------------------------------------------------------------------------
// Phase R8.1.4 — MFA pending challenge / recovery-request GC scheduler.
//
// Bounded scheduled cleanup for the durable replay-protection store
// (`mfa_pending_challenges`) plus the lost-factor recovery workflow
// (`mfa_recovery_requests`). The API service has an opportunistic
// GC path that runs on create/consume; this worker provides the
// scheduled coverage for low-traffic or replicas that never see
// either path.
//
// Default interval: 15 minutes. Disable with
// MFA_CHALLENGE_GC_ENABLED=false. The job is idempotent and bounded
// (200 rows per call); a missed tick is recoverable.
// -----------------------------------------------------------------------------

const mfaChallengeGcEnabled = envBoolean("MFA_CHALLENGE_GC_ENABLED", true);
const mfaChallengeGcIntervalMs = envNumber(
  "MFA_CHALLENGE_GC_INTERVAL_MS",
  15 * 60 * 1000,
);
let mfaChallengeGcTimer: ReturnType<typeof setInterval> | null = null;
let mfaChallengeGcRunning = false;

async function runMfaChallengeGcTick(trigger: string) {
  if (mfaChallengeGcRunning) return;
  mfaChallengeGcRunning = true;
  try {
    const mod = await import("./mfa-challenge-gc.js");
    await mod.runMfaChallengeGc({ trigger });
  } catch (err) {
    logger.error({ err, trigger }, "mfa.challenge_gc.failed");
    captureException(err, { trigger });
  } finally {
    mfaChallengeGcRunning = false;
  }
}

function startMfaChallengeGcScheduler() {
  if (!mfaChallengeGcEnabled) {
    logger.info({}, "mfa.challenge_gc.scheduler.disabled");
    return;
  }
  mfaChallengeGcTimer = setInterval(() => {
    void runMfaChallengeGcTick("interval");
  }, mfaChallengeGcIntervalMs);
  logger.info(
    { intervalMs: mfaChallengeGcIntervalMs },
    "mfa.challenge_gc.scheduler.started",
  );
}

function stopMfaChallengeGcScheduler() {
  if (mfaChallengeGcTimer) {
    clearInterval(mfaChallengeGcTimer);
    mfaChallengeGcTimer = null;
  }
}

// -----------------------------------------------------------------------------
// PHASE R8.1.6 — pending MFA recovery digest scheduler.
//
// Daily digest emails to org owners/admins when recovery requests
// have been sitting in PENDING_ADMIN_REVIEW for more than 24h.
// Idempotency is enforced by the `MfaRecoveryDigestLog` row's
// UNIQUE (teamId, sentDate); the worker can tick more often than
// once a day without producing duplicate emails.
//
// Default interval: 6 hours (default ticks are cheap — most ticks
// observe "already sent today" for each candidate team). Disable
// with MFA_RECOVERY_DIGEST_ENABLED=false.
// -----------------------------------------------------------------------------

const mfaRecoveryDigestEnabled = envBoolean(
  "MFA_RECOVERY_DIGEST_ENABLED",
  true,
);
const mfaRecoveryDigestIntervalMs = envNumber(
  "MFA_RECOVERY_DIGEST_INTERVAL_MS",
  6 * 60 * 60 * 1000,
);
let mfaRecoveryDigestTimer: ReturnType<typeof setInterval> | null = null;
let mfaRecoveryDigestRunning = false;

async function runMfaRecoveryDigestTick(trigger: string) {
  if (mfaRecoveryDigestRunning) return;
  mfaRecoveryDigestRunning = true;
  try {
    const mod = await import("./mfa-recovery-digest.js");
    await mod.runMfaRecoveryDigest({ trigger });
  } catch (err) {
    logger.error({ err, trigger }, "mfa.recovery_digest.failed");
    captureException(err, { trigger });
  } finally {
    mfaRecoveryDigestRunning = false;
  }
}

function startMfaRecoveryDigestScheduler() {
  if (!mfaRecoveryDigestEnabled) {
    logger.info({}, "mfa.recovery_digest.scheduler.disabled");
    return;
  }
  mfaRecoveryDigestTimer = setInterval(() => {
    void runMfaRecoveryDigestTick("interval");
  }, mfaRecoveryDigestIntervalMs);
  logger.info(
    { intervalMs: mfaRecoveryDigestIntervalMs },
    "mfa.recovery_digest.scheduler.started",
  );
}

function stopMfaRecoveryDigestScheduler() {
  if (mfaRecoveryDigestTimer) {
    clearInterval(mfaRecoveryDigestTimer);
    mfaRecoveryDigestTimer = null;
  }
}

// -----------------------------------------------------------------------------
// Phase 27.5 — Governance operationalization schedulers.
// Three workers, each with its own enable / interval env. The workers
// are idempotent and lock-protected, so missed ticks are recoverable.
// Defaults are deliberately conservative — operator can lower in prod.
// -----------------------------------------------------------------------------

// PHASE 12B WAVE 2A — stranded-QUEUED redaction-derivative reconciler.
// Re-enqueues QUEUED derivatives whose enqueue was lost (DB-success/
// queue-failure direction of the durable-enqueue contract). Idempotent
// (stable jobId) + cron-locked; missed ticks are recoverable.
const redactionReconcilerEnabled = envBoolean("REDACTION_RECONCILER_ENABLED", true);
const redactionReconcilerIntervalMs = envNumber(
  "REDACTION_RECONCILER_INTERVAL_MS",
  5 * 60 * 1000, // 5m
);
let redactionReconcilerTimer: ReturnType<typeof setInterval> | null = null;
let redactionReconcilerRunning = false;
async function runRedactionReconciler() {
  if (redactionReconcilerRunning) return;
  redactionReconcilerRunning = true;
  try {
    await withCronLock("redaction-derivative-reconciler", () =>
      reconcileStrandedRedactionDerivatives({
        enqueue: enqueueRedactionDerivativeRenderWorker,
      }),
    );
  } catch (err) {
    logger.error({ err }, "redaction_derivative.reconciler.failed");
  } finally {
    redactionReconcilerRunning = false;
  }
}
function startRedactionReconcilerScheduler() {
  if (!redactionReconcilerEnabled) return;
  redactionReconcilerTimer = setInterval(() => {
    void runRedactionReconciler();
  }, redactionReconcilerIntervalMs);
  redactionReconcilerTimer.unref?.();
}
startRedactionReconcilerScheduler();
void redactionReconcilerTimer;

// ---------------------------------------------------------------------------
// EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the trash-grace reconciler.
//
// The producer that closes the trash lifecycle. Before it, a record whose
// 90-day recovery window elapsed was only ever revisited by the ONE delayed job
// enqueued at trash time; if that job was lost, drained or never enqueued, the
// record stayed in the trash forever and the workspace's retention policy was
// silently not enforced for it.
//
// OBSERVE-ONLY unless AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED is explicitly
// "true". The scan, the evaluation and the reporting all run either way — the
// flag gates only the enqueue of an actual destruction. See the reconciler's
// module header for why a newly-correct irreversible pipeline is not turned
// loose on an existing backlog without an operator reading the candidate report
// first.
// ---------------------------------------------------------------------------
const trashGraceReconcilerEnabled = envBoolean(
  "TRASH_GRACE_RECONCILER_ENABLED",
  true,
);
const trashGraceReconcilerIntervalMs = envNumber(
  "TRASH_GRACE_RECONCILER_INTERVAL_MS",
  60 * 60 * 1000, // 1h — grace boundaries are days wide; a tighter tick buys nothing.
);
let trashGraceReconcilerTimer: ReturnType<typeof setInterval> | null = null;
let trashGraceReconcilerRunning = false;
async function runTrashGraceReconcilerTick() {
  if (trashGraceReconcilerRunning) return;
  trashGraceReconcilerRunning = true;
  try {
    await withCronLock("trash-grace-reconciler", () =>
      runTrashGraceReconciliation({ trigger: "scheduler" }),
    );
  } catch (err) {
    logger.error({ err }, "trash_grace.reconciler.failed");
  } finally {
    trashGraceReconcilerRunning = false;
  }
}
function startTrashGraceReconcilerScheduler() {
  if (!trashGraceReconcilerEnabled) {
    logger.info({}, "trash_grace.reconciler.scheduler.disabled");
    return;
  }
  trashGraceReconcilerTimer = setInterval(() => {
    void runTrashGraceReconcilerTick();
  }, trashGraceReconcilerIntervalMs);
  trashGraceReconcilerTimer.unref?.();
  logger.info(
    {
      intervalMs: trashGraceReconcilerIntervalMs,
      automaticDestructionEnabled: automaticDestructionEnabled(),
    },
    "trash_grace.reconciler.scheduler.started",
  );
}
startTrashGraceReconcilerScheduler();
void trashGraceReconcilerTimer;

// ===========================================================================
// PHASE 12 — POINT 5: stranded-work reconcilers for the projection and
// intelligence families.
//
// Both close the SAME window: a durable row committed by an authorized path,
// followed by an enqueue that never happened (process death, Redis outage) or
// a claim whose worker died mid-flight. Without them the row sits stranded
// forever while the queue looks perfectly healthy — the failure mode that
// produces "the projection is stale and nothing is alerting".
//
// Both are bounded, idempotent and non-destructive; see each module for the
// reasoning. Overlapping ticks are prevented by the same running-flag pattern
// every other sweep here uses, and correctness does not depend on it — the
// reconcilers claim conditionally, so a concurrent tick loses the race rather
// than double-recovering a row.
// ===========================================================================

const searchIndexReconcilerEnabled = envBoolean(
  "SEARCH_INDEX_RECONCILER_ENABLED",
  true,
);
const searchIndexReconcilerIntervalMs = envNumber(
  "SEARCH_INDEX_RECONCILER_INTERVAL_MS",
  10 * 60 * 1000,
);
let searchIndexReconcilerTimer: ReturnType<typeof setInterval> | null = null;
let searchIndexReconcilerRunning = false;

async function runSearchIndexReconcilerTick(trigger = "scheduler") {
  if (searchIndexReconcilerRunning) return;
  searchIndexReconcilerRunning = true;
  try {
    const result = await runSearchIndexReconciler({ trigger });
    // A TICK THAT FAILED MUST BE VISIBLE.
    //
    // `runSearchIndexReconciler` catches its own discovery failure and
    // returns `ok: false` rather than throwing, so this `try` never fired and
    // the only trace a broken sweep left was one log line. For the whole
    // period the production database was missing the `SEARCH_INDEX` enum
    // value, every tick returned not-ok and nothing escalated — which is why
    // the sweep could be dead for as long as it was without anyone being
    // told.
    if (!result.ok || result.workspacesFailed > 0) {
      logger.error(
        {
          trigger,
          ok: result.ok,
          error: result.error ?? null,
          workspacesFailed: result.workspacesFailed,
          workspacesReconciled: result.workspacesReconciled,
        },
        "search_index.reconciler.unhealthy",
      );
      captureException(
        new Error(
          `search_index_reconciler_unhealthy:${result.error ?? "workspace_failures"}`,
        ),
        { kind: "worker.search_index_reconciler" },
      );
    }
  } catch (err) {
    logger.error({ err }, "search_index.reconciler.failed");
    captureException(err, { kind: "worker.search_index_reconciler" });
  } finally {
    searchIndexReconcilerRunning = false;
  }
}

/**
 * How long after boot the first sweep runs.
 *
 * A worker that only ever reconciles on its interval leaves every workspace
 * that drifted while it was down waiting up to a full interval after it comes
 * back — and a deploy that fixed the reason they drifted does not take effect
 * until then. The startup pass is the recovery path for exactly that: existing
 * workspaces with `eligible > indexed` and no valid run are picked up because
 * the deployment happened, with no user visit and no button press.
 *
 * It is DELAYED and JITTERED, not immediate. Immediate would put every replica
 * in a rolling deploy onto the same discovery query at the same moment —
 * against a database that has just been migrated — which is a thundering herd
 * aimed at the one component that is already the recovery path. The jitter is
 * per-process, so replicas spread themselves out without coordinating.
 */
const SEARCH_INDEX_RECONCILER_STARTUP_BASE_MS = envNumber(
  "SEARCH_INDEX_RECONCILER_STARTUP_DELAY_MS",
  30_000,
);
let searchIndexReconcilerStartupTimer: ReturnType<typeof setTimeout> | null =
  null;

function startSearchIndexReconcilerScheduler() {
  if (!searchIndexReconcilerEnabled) {
    // A disabled reconciler is a DECISION, and a decision nobody can see is
    // indistinguishable from a bug. Search has no other automatic recovery
    // path, so switching this off is stated once, loudly, at boot.
    logger.warn(
      { reconciler: "search-index" },
      "search_index.reconciler.disabled",
    );
    return;
  }
  const startupDelayMs =
    Math.max(0, SEARCH_INDEX_RECONCILER_STARTUP_BASE_MS) +
    Math.floor(Math.random() * 30_000);
  searchIndexReconcilerStartupTimer = setTimeout(() => {
    void runSearchIndexReconcilerTick("startup");
  }, startupDelayMs);
  searchIndexReconcilerStartupTimer.unref?.();

  searchIndexReconcilerTimer = setInterval(() => {
    void runSearchIndexReconcilerTick();
  }, searchIndexReconcilerIntervalMs);
  searchIndexReconcilerTimer.unref?.();
  logger.info(
    {
      reconciler: "search-index",
      intervalMs: searchIndexReconcilerIntervalMs,
      startupDelayMs,
    },
    "search_index.reconciler.scheduled",
  );
}

function stopSearchIndexReconcilerScheduler() {
  if (searchIndexReconcilerTimer) clearInterval(searchIndexReconcilerTimer);
  searchIndexReconcilerTimer = null;
  if (searchIndexReconcilerStartupTimer) {
    clearTimeout(searchIndexReconcilerStartupTimer);
  }
  searchIndexReconcilerStartupTimer = null;
}

const intelligenceRunReconcilerEnabled = envBoolean(
  "INTELLIGENCE_RUN_RECONCILER_ENABLED",
  true,
);
const intelligenceRunReconcilerIntervalMs = envNumber(
  "INTELLIGENCE_RUN_RECONCILER_INTERVAL_MS",
  10 * 60 * 1000,
);
let intelligenceRunReconcilerTimer: ReturnType<typeof setInterval> | null = null;
let intelligenceRunReconcilerRunning = false;

async function runIntelligenceRunReconcilerTick() {
  if (intelligenceRunReconcilerRunning) return;
  intelligenceRunReconcilerRunning = true;
  try {
    await runIntelligenceRunReconciler({ trigger: "scheduler" });
  } catch (err) {
    logger.error({ err }, "intelligence_run.reconciler.failed");
    captureException(err, { kind: "worker.intelligence_run_reconciler" });
  } finally {
    intelligenceRunReconcilerRunning = false;
  }
}

function startIntelligenceRunReconcilerScheduler() {
  if (!intelligenceRunReconcilerEnabled) return;
  intelligenceRunReconcilerTimer = setInterval(() => {
    void runIntelligenceRunReconcilerTick();
  }, intelligenceRunReconcilerIntervalMs);
  intelligenceRunReconcilerTimer.unref?.();
}

function stopIntelligenceRunReconcilerScheduler() {
  if (intelligenceRunReconcilerTimer) clearInterval(intelligenceRunReconcilerTimer);
  intelligenceRunReconcilerTimer = null;
}

startSearchIndexReconcilerScheduler();
startIntelligenceRunReconcilerScheduler();

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
    const outcome = await withCronLock("retention-reconciliation", () =>
      runRetentionReconciliation({ trigger }),
    );
    if (!outcome.ran) {
      logger.debug({ trigger }, "governance.retention_reconciliation.skipped_locked");
    }
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
    const outcome = await withCronLock("destruction-orchestrator", () =>
      runDestructionOrchestration({ trigger }),
    );
    if (!outcome.ran) {
      logger.debug({ trigger }, "governance.destruction_orchestrator.skipped_locked");
    }
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
    const outcome = await withCronLock("immutable-storage-reconciliation", () =>
      runImmutableStorageReconciliation({ trigger }),
    );
    if (!outcome.ran) {
      logger.debug({ trigger }, "governance.immutable_storage_reconciliation.skipped_locked");
    }
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
// Phase 4B Final Closure I7 — Archive tier auto-transition scheduler.
//
// Walks every non-personal workspace and tiers down evidence past the
// age thresholds (30d HOT→WARM, 120d WARM→COLD, 485d COLD→DEEP_ARCHIVE).
// Bounded at 100 transitions per team per tick + MAX_TEAMS_PER_SWEEP=500.
//
// Default interval: 1 hour. Disable with
// ARCHIVE_AUTO_TRANSITION_ENABLED=false.
// -----------------------------------------------------------------------------

const archiveAutoTransitionEnabled = envBoolean(
  "ARCHIVE_AUTO_TRANSITION_ENABLED",
  true,
);
const archiveAutoTransitionIntervalMs = envNumber(
  "ARCHIVE_AUTO_TRANSITION_INTERVAL_MS",
  60 * 60 * 1000, // 1 hour
);
let archiveAutoTransitionTimer: ReturnType<typeof setInterval> | null = null;
let archiveAutoTransitionRunning = false;

async function runArchiveAutoTransitionTick(trigger: string) {
  if (archiveAutoTransitionRunning) return;
  archiveAutoTransitionRunning = true;
  try {
    const outcome = await withCronLock("archive-tier-auto-transition", () =>
      runArchiveTierAutoTransitions({ trigger }),
    );
    if (!outcome.ran) {
      logger.debug({ trigger }, "governance.archive_tier_auto_transition.skipped_locked");
    }
  } catch (err) {
    logger.error({ err, trigger }, "archive.auto_transition.tick_failed");
    captureException(err, { trigger });
  } finally {
    archiveAutoTransitionRunning = false;
  }
}

function startArchiveAutoTransitionScheduler() {
  if (!archiveAutoTransitionEnabled) {
    logger.info({}, "archive.auto_transition.scheduler.disabled");
    return;
  }
  archiveAutoTransitionTimer = setInterval(() => {
    void runArchiveAutoTransitionTick("interval");
  }, archiveAutoTransitionIntervalMs);
  logger.info(
    { intervalMs: archiveAutoTransitionIntervalMs },
    "archive.auto_transition.scheduler.started",
  );
}

function stopArchiveAutoTransitionScheduler() {
  if (archiveAutoTransitionTimer) {
    clearInterval(archiveAutoTransitionTimer);
    archiveAutoTransitionTimer = null;
  }
}

// P5 — Webhook dispatcher scheduler.
const webhookDispatcherEnabled = envBoolean("WEBHOOK_DISPATCHER_ENABLED", true);
const webhookDispatcherIntervalMs = envNumber(
  "WEBHOOK_DISPATCHER_INTERVAL_MS",
  5_000,
);
let webhookDispatcherTimer: ReturnType<typeof setInterval> | null = null;

function startWebhookDispatcherScheduler() {
  if (!webhookDispatcherEnabled) {
    logger.info({}, "webhook_dispatcher.scheduler.disabled");
    return;
  }
  webhookDispatcherTimer = setInterval(() => {
    void runWebhookDispatcherTick().catch((err) =>
      logger.warn({ err }, "webhook_dispatcher.tick.error"),
    );
  }, webhookDispatcherIntervalMs);
  void (async () => {
    const readiness = await gateStartupOnApiReadiness("webhook-dispatcher");
    if (!readiness.ready) return;
    void runWebhookDispatcherTick().catch((err) =>
      logger.warn({ err }, "webhook_dispatcher.startup.error"),
    );
  })();
  logger.info(
    { intervalMs: webhookDispatcherIntervalMs },
    "webhook_dispatcher.scheduler.started",
  );
}

function stopWebhookDispatcherScheduler() {
  if (webhookDispatcherTimer) {
    clearInterval(webhookDispatcherTimer);
    webhookDispatcherTimer = null;
  }
}

// P5 — Evidence Exchange package builder scheduler.
const exchangeBuilderEnabled = envBoolean(
  "EXCHANGE_PACKAGE_BUILDER_ENABLED",
  true,
);
const exchangeBuilderIntervalMs = envNumber(
  "EXCHANGE_BUILDER_INTERVAL_MS",
  10_000,
);
let exchangePackageBuilderTimer: ReturnType<typeof setInterval> | null = null;

function startExchangePackageBuilderScheduler() {
  if (!exchangeBuilderEnabled) {
    logger.info({}, "exchange_package_builder.scheduler.disabled");
    return;
  }
  exchangePackageBuilderTimer = setInterval(() => {
    void pollExchangePackageBuilds().catch((err) =>
      logger.warn({ err }, "exchange_package_builder.tick.error"),
    );
  }, exchangeBuilderIntervalMs);
  void (async () => {
    const readiness = await gateStartupOnApiReadiness(
      "exchange-package-builder",
    );
    if (!readiness.ready) return;
    void pollExchangePackageBuilds().catch((err) =>
      logger.warn({ err }, "exchange_package_builder.startup.error"),
    );
  })();
  logger.info(
    { intervalMs: exchangeBuilderIntervalMs },
    "exchange_package_builder.scheduler.started",
  );
}

function stopExchangePackageBuilderScheduler() {
  if (exchangePackageBuilderTimer) {
    clearInterval(exchangePackageBuilderTimer);
    exchangePackageBuilderTimer = null;
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
    const outcome = await withCronLock("reviewer-ops-reconciliation", () =>
      runReviewerReconciliation({
        trigger,
        batchSize: reviewerReconciliationBatchSize,
        maxTeamsPerSweep: reviewerReconciliationMaxTeamsPerSweep,
      }),
    );
    if (!outcome.ran) {
      logger.debug({ trigger }, "reviewer_ops.reconciliation.skipped_locked");
    }
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

// -----------------------------------------------------------------------------
// Macro-Wave A2 — Org-invite delivery sweep scheduler.
//
// Drives the durable invite-delivery outbox: the api endpoint
// POST /v1/org-invite-deliveries/process claims due PENDING rows
// atomically and retries each with token rotation. The worker only
// SCHEDULES the sweep (the token + email authorities are API-side).
// Idempotent + cron-locked; a missed tick is recoverable and an
// overlapping tick sends zero duplicate emails (state-precondition
// claims). The inline first attempt happens at invite creation, so
// this sweep only ever sees stranded/failed-transient rows.
//
// Tunables:
//   ORG_INVITE_DELIVERY_SWEEP_ENABLED     — default true
//   ORG_INVITE_DELIVERY_SWEEP_INTERVAL_MS — default 5m
//   ORG_INVITE_DELIVERY_SWEEP_BATCH_SIZE  — default 50 (api caps at 200)
// -----------------------------------------------------------------------------

const orgInviteDeliverySweepEnabled = envBoolean(
  "ORG_INVITE_DELIVERY_SWEEP_ENABLED",
  true,
);
const orgInviteDeliverySweepIntervalMs = envNumber(
  "ORG_INVITE_DELIVERY_SWEEP_INTERVAL_MS",
  5 * 60 * 1000, // 5m
);
const orgInviteDeliverySweepBatchSize = envNumber(
  "ORG_INVITE_DELIVERY_SWEEP_BATCH_SIZE",
  50,
);
let orgInviteDeliverySweepTimer: ReturnType<typeof setInterval> | null = null;
let orgInviteDeliverySweepRunning = false;

async function runOrgInviteDeliverySweepTick(trigger: string) {
  if (orgInviteDeliverySweepRunning) return;
  orgInviteDeliverySweepRunning = true;
  try {
    const outcome = await withCronLock("org-invite-delivery-sweep", () =>
      runOrgInviteDeliverySweep({
        trigger,
        batchSize: orgInviteDeliverySweepBatchSize,
      }),
    );
    if (!outcome.ran) {
      logger.debug({ trigger }, "org_invite_delivery.sweep.skipped_locked");
    }
  } catch (err) {
    logger.error({ err, trigger }, "org_invite_delivery.sweep.tick_failed");
    captureException(err, { trigger });
  } finally {
    orgInviteDeliverySweepRunning = false;
  }
}

function startOrgInviteDeliverySweepScheduler() {
  if (!orgInviteDeliverySweepEnabled) {
    logger.info({}, "org_invite_delivery.sweep.scheduler.disabled");
    return;
  }
  orgInviteDeliverySweepTimer = setInterval(() => {
    void runOrgInviteDeliverySweepTick("interval");
  }, orgInviteDeliverySweepIntervalMs);
  logger.info(
    {
      intervalMs: orgInviteDeliverySweepIntervalMs,
      batchSize: orgInviteDeliverySweepBatchSize,
    },
    "org_invite_delivery.sweep.scheduler.started",
  );
  // Gate the startup-triggered first run on api readiness — the sweep
  // endpoint lives on the api.
  void (async () => {
    const readiness = await gateStartupOnApiReadiness(
      "org-invite-delivery-sweep",
    );
    if (!readiness.ready) {
      logger.warn(
        {
          requestId: randomUUID(),
          consumer: "org-invite-delivery-sweep",
          attempts: readiness.attempts,
          totalLatencyMs: readiness.totalLatencyMs,
          lastError: readiness.lastError,
        },
        "org_invite_delivery.sweep.skipped_api_unready",
      );
      return;
    }
    void runOrgInviteDeliverySweepTick("startup");
  })();
}

function stopOrgInviteDeliverySweepScheduler() {
  if (orgInviteDeliverySweepTimer) {
    clearInterval(orgInviteDeliverySweepTimer);
    orgInviteDeliverySweepTimer = null;
  }
}

// -----------------------------------------------------------------------------
// PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07) —
// AutomationDispatchSweep.
//
// The keystone this whole subsystem was missing. Automation had a schema, an
// API and a UI, and NOTHING scheduled it: `dispatchAutomationTrigger` had zero
// production callers and `sweepDueRetries` was never wired to a timer, so an
// enabled rule never ran and a scheduled retry died with the process that
// scheduled it.
//
// One tick claims due AutomationRun rows under a lease and a fence, executes
// the bounded action, persists exactly one outcome, retries what is retryable,
// dead-letters what is exhausted, reconciles what a dead worker stranded, and
// then sweeps the durable webhook-delivery outbox on the same terms.
//
// `withCronLock` is not optional here: it is what makes a second worker
// replica safe, alongside the per-row fence.
//
// Tunables:
//   AUTOMATION_DISPATCH_SWEEP_ENABLED      — default true
//   AUTOMATION_DISPATCH_SWEEP_INTERVAL_MS  — default 60s
//   AUTOMATION_DISPATCH_SWEEP_BATCH_SIZE   — default 25 (api caps at 100)
// -----------------------------------------------------------------------------

const automationDispatchSweepEnabled = envBoolean(
  "AUTOMATION_DISPATCH_SWEEP_ENABLED",
  true,
);
const automationDispatchSweepIntervalMs = envNumber(
  "AUTOMATION_DISPATCH_SWEEP_INTERVAL_MS",
  60 * 1000,
);
const automationDispatchSweepBatchSize = envNumber(
  "AUTOMATION_DISPATCH_SWEEP_BATCH_SIZE",
  25,
);
let automationDispatchSweepTimer: ReturnType<typeof setInterval> | null = null;
let automationDispatchSweepRunning = false;

async function runAutomationDispatchTick(trigger: string) {
  if (automationDispatchSweepRunning) return;
  automationDispatchSweepRunning = true;
  try {
    const outcome = await withCronLock("automation-dispatch-sweep", () =>
      runAutomationDispatchSweepTick({
        trigger,
        batchSize: automationDispatchSweepBatchSize,
        deliveryBatchSize: automationDispatchSweepBatchSize,
      }),
    );
    if (!outcome.ran) {
      logger.debug({ trigger }, "automation_dispatch.sweep.skipped_locked");
    }
  } catch (err) {
    logger.error({ err, trigger }, "automation_dispatch.sweep.tick_failed");
    captureException(err, { trigger });
  } finally {
    automationDispatchSweepRunning = false;
  }
}

function startAutomationDispatchScheduler() {
  if (!automationDispatchSweepEnabled) {
    logger.info({}, "automation_dispatch.sweep.scheduler.disabled");
    return;
  }
  automationDispatchSweepTimer = setInterval(() => {
    void runAutomationDispatchTick("interval");
  }, automationDispatchSweepIntervalMs);
  logger.info(
    {
      intervalMs: automationDispatchSweepIntervalMs,
      batchSize: automationDispatchSweepBatchSize,
    },
    "automation_dispatch.sweep.scheduler.started",
  );
  // The sweep endpoint lives on the api, so the startup-triggered first run is
  // gated on api readiness exactly like the sibling sweeps.
  void (async () => {
    const readiness = await gateStartupOnApiReadiness("automation-dispatch-sweep");
    if (!readiness.ready) {
      logger.warn(
        {
          requestId: randomUUID(),
          consumer: "automation-dispatch-sweep",
          attempts: readiness.attempts,
          totalLatencyMs: readiness.totalLatencyMs,
          lastError: readiness.lastError,
        },
        "automation_dispatch.sweep.skipped_api_unready",
      );
      return;
    }
    void runAutomationDispatchTick("startup");
  })();
}

function stopAutomationDispatchScheduler() {
  if (automationDispatchSweepTimer) {
    clearInterval(automationDispatchSweepTimer);
    automationDispatchSweepTimer = null;
  }
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
    // Phase Final-Worker-Visibility — heartbeat sampler now covers
    // EVERY live queue declared in `queue.ts`. Prior to this change
    // the sampler reported only `report` / `ots-upgrade` /
    // `evidence-purge`, so the 11 newer queues (`mi-*`, `graph-*`,
    // `org-health-refresh`, `search-indexing`, `media-intelligence`,
    // `mi-derived-assets`) were invisible to ops via the heartbeat
    // signal. The dedicated `worker_telemetry_snapshots` sampler
    // already covered them but the heartbeat log line was misleading.
    const snapshot = await snapshotQueueHealth([
      { name: reportQueueName, queue: reportQueue },
      { name: reportDlqQueueName, queue: reportDlqQueue },
      { name: otsUpgradeQueueName, queue: otsUpgradeQueue },
      { name: evidencePurgeQueueName, queue: evidencePurgeQueue },
      { name: searchIndexingQueueName, queue: searchIndexingQueue },
      { name: mediaIntelligenceQueueName, queue: mediaIntelligenceQueue },
      { name: mediaIntelligenceDlqQueueName, queue: mediaIntelligenceDlqQueue },
      { name: derivedAssetsQueueName, queue: derivedAssetsQueue },
      { name: redactionDerivativeQueueName, queue: redactionDerivativeQueue },
      { name: exifQueueName, queue: exifQueue },
      { name: miSearchIndexQueueName, queue: miSearchIndexQueue },
      // PHASE 12 POINT 5 — `mi-embed` was MISSING from this list. It is a
      // live, registered BullMQ unit (`EmbedSemanticChunks`) that calls a paid
      // AI provider, and the heartbeat has never sampled it: a backlog or a
      // stall on the embedding chain produced no heartbeat signal at all.
      //
      // It was missed because the contract test guarding this array carried a
      // HAND-WRITTEN list of queue names, so it only ever proved the sampler
      // covered the queues somebody remembered. That test now DISCOVERS the
      // list from `queue.ts`, which is what surfaced this.
      { name: miEmbedQueueName, queue: miEmbedQueue },
      { name: graphReconcileQueueName, queue: graphReconcileQueue },
      { name: graphDomainSyncQueueName, queue: graphDomainSyncQueue },
      { name: graphTimelineSyncQueueName, queue: graphTimelineSyncQueue },
      {
        name: graphSearchProjectionQueueName,
        queue: graphSearchProjectionQueue,
      },
      { name: orgHealthRefreshQueueName, queue: orgHealthRefreshQueue },
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
  | "mi-search-index"
  | "mi-embed"
  | "graph-reconcile"
  | "graph-domain-sync"
  | "graph-timeline-sync"
  | "graph-search-projection"
  | "org-health-refresh"
  | "redaction-derivative";

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

// Phase O1.3 — wrap the two highest-value job handlers in the
// bounded OTEL context extractor + child-span helper. This makes the
// API enqueue → worker handler chain visible as ONE distributed
// trace in Grafana Tempo. Other queues are wired in follow-up phases;
// see `docs/operations/phase-o1-3-otel-final-closure.md` §5.
const reportWorker = safeRegisterWorker("report", () =>
  new Worker(
    reportQueueName,
    wrapJobHandlerWithOtelContext(
      PROOVRA_SPAN_NAMES.WORKER_REPORT_GENERATE,
      reportQueueName,
      processGenerateReport,
    ),
    {
      connection: redisConnection,
      concurrency: 2,
    },
  ),
);

const otsUpgradeWorker = safeRegisterWorker("ots-upgrade", () =>
  new Worker(
    otsUpgradeQueueName,
    wrapJobHandlerWithOtelContext(
      PROOVRA_SPAN_NAMES.WORKER_OTS_UPGRADE,
      otsUpgradeQueueName,
      processOtsUpgrade,
    ),
    {
      connection: redisConnection,
      concurrency: 1,
    },
  ),
);

const evidencePurgeWorker = safeRegisterWorker("evidence-purge", () =>
  new Worker(
    evidencePurgeQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.evidence_purge",
      evidencePurgeQueueName,
      processPurgeDeletedEvidence,
    ),
    {
      connection: redisConnection,
      concurrency: 1,
    },
  ),
);

// Phase 24-J — Search Discovery indexing worker.
const searchIndexingWorker = safeRegisterWorker("search-indexing", () =>
  new Worker(
    searchIndexingQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.search_indexing",
      searchIndexingQueueName,
      processSearchIndexingJob,
    ),
    {
      connection: redisConnection,
      concurrency: 2,
    },
  ),
);

// Phase 31.6 — Media intelligence async worker. Bounded concurrency
// (1) — the analyzer is read-only against EvidencePart + clientSignals
// + EvidenceIntelligenceJob, so saturating the DB with parallel
// per-evidence scans is the only realistic failure mode. One at a
// time keeps backpressure on the queue rather than on Postgres.
const mediaIntelligenceWorker = safeRegisterWorker("media-intelligence", () =>
  new Worker(
    mediaIntelligenceQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.media_intelligence",
      mediaIntelligenceQueueName,
      processMediaIntelligenceJob,
    ),
    {
      connection: redisConnection,
      concurrency: 1,
    },
  ),
);

// Phase 31.13 — dedicated derived-assets worker. ISOLATED from the
// media-intelligence worker so a sharp-side stall can never affect
// EXIF extraction or analyzer jobs. Concurrency 1 keeps the load
// on sharp + S3 bounded (each job pulls up to 4MB source + writes
// a small thumbnail).
const derivedAssetsWorker = safeRegisterWorker("derived-assets", () =>
  new Worker(
    derivedAssetsQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.derived_assets",
      derivedAssetsQueueName,
      processDerivedAssetJob,
    ),
    {
      connection: redisConnection,
      concurrency: 1,
    },
  ),
);

// PHASE 12B WAVE 2A — redaction-derivative renderer. Payload carries ONLY the
// derivativeId; the processor reloads all authoritative state, atomically
// claims QUEUED→RENDERING, renders IMAGE (sharp) / PDF (pdfjs raster + pdfkit
// flattened reassembly), stores to the redactions/ prefix and completes via
// the ONE worker-side writer. Concurrency 1 — rendering is CPU/memory bound.
const redactionDerivativeWorker = safeRegisterWorker("redaction-derivative", () =>
  new Worker(
    redactionDerivativeQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.redaction_derivative",
      redactionDerivativeQueueName,
      processRedactionDerivativeJob,
    ),
    {
      connection: redisConnection,
      concurrency: 1,
    },
  ),
);
void redactionDerivativeWorker;

// Phase 31.18 — dedicated EXIF worker (mi-exif). ISOLATED from the
// generic media-intelligence worker so EXIF extraction (which only
// reads ~16KB per part and parses with `exifr`) cannot be head-of-
// line blocked by analyzer runs. Concurrency 2 — EXIF parsing is
// CPU-light and bounded; we can run two in parallel without
// saturating Postgres. Reuses processMediaIntelligenceJob: the
// processor branches on `kind`, and only `extract_exif` flows here.
const exifWorker = safeRegisterWorker("mi-exif", () =>
  new Worker(
    exifQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.mi_exif",
      exifQueueName,
      // PHASE 12 — POINT 5. This bound `processMediaIntelligenceJob` — the SAME
      // function the `media-intelligence` queue uses. That sharing is why the
      // old payload had to carry both a run id and a part id and trust
      // whichever was present: one function, two identities. `mi-exif` now has
      // its own entry point, decoding under its own work name against its own
      // authority (the evidence part whose bytes it reads).
      processExifQueueJob,
    ),
    {
      connection: redisConnection,
      concurrency: 2,
    },
  ),
);

// Phase 31.19 — two more isolated subsystem workers.
//
// PHASE 12 POINT 5 — the `mi-ocr` and `mi-transcript` registrations that used
// to sit here are gone. They bound no-op processors to two queues no producer
// has ever written to, duplicating an authority the `media-intelligence` queue
// already owns end to end. See the note in `subsystem-queue-processors.ts`.
//
// mi-search-index: thin shim that delegates to the existing Phase
// 24-J search-indexing queue. Lets the reviewer console / ops UI
// trigger a bounded reindex per evidence without coupling to the
// generic search-indexing producer.
//
// graph-reconcile: dedicated queue for ad-hoc graph rebuild
// triggers (operator action, escalation hook, scheduled recurrence).
// Worker invokes the read-only `reconcileTeamGraph` service.
const miSearchIndexWorker = safeRegisterWorker("mi-search-index", () =>
  new Worker(
    miSearchIndexQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.mi_search_index",
      miSearchIndexQueueName,
      processMiSearchIndexJob,
    ),
    {
      connection: redisConnection,
      concurrency: 2,
    },
  ),
);

const graphReconcileWorker = safeRegisterWorker("graph-reconcile", () =>
  new Worker(
    graphReconcileQueueName,
    wrapJobHandlerWithOtelContext(
      PROOVRA_SPAN_NAMES.WORKER_GRAPH_RECONCILE,
      graphReconcileQueueName,
      processGraphReconcileJob,
    ),
    {
      connection: redisConnection,
      concurrency: 1,
    },
  ),
);

// Phase 16 — dedicated mi-embed worker. Concurrency 1 — vendor calls
// (OpenAI) are network-bound and rate-limited; saturating them
// in-process buys nothing. Per-workspace daily cap + monthly EUR
// budget is enforced INSIDE the processor.
const miEmbedWorker = safeRegisterWorker("mi-embed", () =>
  new Worker(
    miEmbedQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.mi_embed",
      miEmbedQueueName,
      processMiEmbedJob,
    ),
    {
      connection: redisConnection,
      concurrency: 1,
    },
  ),
);

// Phase 31.20 — final three isolated subsystem workers, completing
// the 9-queue isolation program. graph-domain-sync delegates to the
// existing reconciler; graph-timeline-sync and graph-search-projection
// are observable canonical targets for future incremental writers.
const graphDomainSyncWorker = safeRegisterWorker("graph-domain-sync", () =>
  new Worker(
    graphDomainSyncQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.graph_domain_sync",
      graphDomainSyncQueueName,
      processGraphDomainSyncJob,
    ),
    {
      connection: redisConnection,
      concurrency: 1,
    },
  ),
);

const graphTimelineSyncWorker = safeRegisterWorker("graph-timeline-sync", () =>
  new Worker(
    graphTimelineSyncQueueName,
    wrapJobHandlerWithOtelContext(
      "proovra.worker.graph_timeline_sync",
      graphTimelineSyncQueueName,
      processGraphTimelineSyncJob,
    ),
    {
      connection: redisConnection,
      concurrency: 2,
    },
  ),
);

const graphSearchProjectionWorker = safeRegisterWorker(
  "graph-search-projection",
  () =>
    new Worker(
      graphSearchProjectionQueueName,
      wrapJobHandlerWithOtelContext(
        "proovra.worker.graph_search_projection",
        graphSearchProjectionQueueName,
        processGraphSearchProjectionJob,
      ),
      {
        connection: redisConnection,
        concurrency: 2,
      },
    ),
);

// Phase 37.98 — Org-health projection refresh worker. Consumes
// `org-health-refresh` jobs (one teamId per job) and upserts the
// projection row that the Command Center reads. Idempotent +
// tenant-scoped by construction; see subsystem-queue-processors.ts.
const orgHealthRefreshWorker = safeRegisterWorker(
  "org-health-refresh",
  () =>
    new Worker(
      orgHealthRefreshQueueName,
      wrapJobHandlerWithOtelContext(
        "proovra.worker.org_health_refresh",
        orgHealthRefreshQueueName,
        processOrgHealthRefreshJob,
      ),
      {
        connection: redisConnection,
        concurrency: 4,
      },
    ),
);

let healthServer: HealthServer | null = null;
let telemetrySampler: TelemetrySampler | null = null;
let shuttingDown = false;

async function shutdown(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ requestId: randomUUID(), exitCode }, "worker.shutdown_started");

  /*
   * THE LEASE IS MARKED FIRST, WHILE THE DATABASE IS STILL REACHABLE.
   *
   * Everything below this line tears connections down. If the shutdown
   * marker were written after that, a clean stop would routinely fail to
   * record and every deliberate scale-down would read as a crash.
   *
   * Marking DRAINING here also means the Admin fleet view stops counting
   * this instance the moment shutdown begins, rather than continuing to show
   * it as healthy until the stale threshold expires.
   *
   * A failure to record is NOT swallowed into a success: `shutdown()` returns
   * false, we log it, and the instance will correctly read as a crash —
   * which, from the reader's side, is exactly what happened.
   */
  try {
    const recorded = (await telemetrySampler?.shutdown("SIGTERM")) ?? null;
    if (recorded === false) {
      logger.warn(
        { requestId: randomUUID() },
        "worker.lease.shutdown_not_recorded — this instance will read as a crash",
      );
    }
  } catch (err) {
    logger.error({ requestId: randomUUID(), err }, "worker.lease.shutdown_failed");
  }

  stopDemoFollowUpScheduler();
  stopCaptureDraftReaperScheduler();
  stopOrphanScanScheduler();
  // PHASE 12 — POINT 5 reconcilers.
  stopSearchIndexReconcilerScheduler();
  stopIntelligenceRunReconcilerScheduler();
  stopLifecycleRecoveryScheduler();
  stopMfaChallengeGcScheduler();
  stopMfaRecoveryDigestScheduler();
  // Phase 27.5 — Governance schedulers.
  stopRetentionReconciliationScheduler();
  stopDestructionOrchestratorScheduler();
  stopImmutableStorageReconciliationScheduler();
  // Phase 4B Final Closure I7 — Archive tier auto-transition.
  stopArchiveAutoTransitionScheduler();
  // P5 — Webhook dispatcher + Evidence Exchange package builder.
  stopWebhookDispatcherScheduler();
  stopExchangePackageBuilderScheduler();
  // Reviewer Ops scheduler.
  stopReviewerReconciliationScheduler();
  // Macro-Wave A2 — org-invite delivery sweep.
  stopOrgInviteDeliverySweepScheduler();
  stopAutomationDispatchScheduler();
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
    ["mi-search-index", miSearchIndexWorker] as const,
    // Phase 16 — mi-embed worker shutdown.
    ["mi-embed", miEmbedWorker] as const,
    ["graph-reconcile", graphReconcileWorker] as const,
    ["graph-domain-sync", graphDomainSyncWorker] as const,
    ["graph-timeline-sync", graphTimelineSyncWorker] as const,
    ["graph-search-projection", graphSearchProjectionWorker] as const,
    ["org-health-refresh", orgHealthRefreshWorker] as const,
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
    await miSearchIndexQueue.close();
    // Phase 16 — mi-embed queue.
    await miEmbedQueue.close();
    await graphReconcileQueue.close();
    // Phase 31.20 — final three isolated subsystem queues.
    await graphDomainSyncQueue.close();
    await graphTimelineSyncQueue.close();
    await graphSearchProjectionQueue.close();
    // Phase 37.98 — org-health refresh queue.
    await orgHealthRefreshQueue.close();
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
    // Idempotent: the graceful path at the top of shutdown() already
    // stopped the timer. This stays as the belt-and-braces stop for any
    // path that reached here without it.
    telemetrySampler?.stop();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.telemetry_stop_failed");
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

/**
 * PHASE 12 CORRECTIVE PASS §4 (SEC-004, 2026-08-06) — THE WORKER HYDRATES THE
 * SAME SECRETS AUTHORITY THE API DOES, AND DOES IT FIRST.
 *
 * Before this, the API called `initSecretsManager` at boot and the Worker
 * called nothing — it could not, because the loader was a private module of
 * the other service. So the two processes of one deployment could resolve
 * their secrets from DIFFERENT stores: the API from Secrets Manager, the
 * Worker from whatever `process.env` happened to hold. A deployment that
 * declared `required` was required in one process and unenforced in the other,
 * and the unenforced one is the one that signs and sends.
 *
 * It runs BEFORE `startHealthServer` and before any scheduler, because a
 * consumer that reads a secret before hydration would silently take the
 * environment's value and look identical to a correctly-configured
 * env-authority deployment. In `required` mode this REJECTS, and the existing
 * `.catch` below shuts the process down non-zero — fail closed, before any job
 * is claimed.
 */
initSecretsAuthority(logger)
  .then(() => startHealthServer())
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
    startLifecycleRecoveryScheduler();
    startMfaChallengeGcScheduler();
    startMfaRecoveryDigestScheduler();
    // Phase 27.5 — Governance schedulers.
    startRetentionReconciliationScheduler();
    startDestructionOrchestratorScheduler();
    startImmutableStorageReconciliationScheduler();
    // Phase 4B Final Closure I7 — Archive tier auto-transition (1h interval).
    startArchiveAutoTransitionScheduler();
    // P5 — Webhook dispatcher + Evidence Exchange package builder.
    startWebhookDispatcherScheduler();
    startExchangePackageBuilderScheduler();
    // Reviewer Ops activation — drives SLA / escalation / workload /
    // reminder engines across all teams on a fixed interval.
    startReviewerReconciliationScheduler();
    // Macro-Wave A2 — org-invite delivery sweep (stranded PENDING
    // outbox rows → API-side rotation retry).
    startOrgInviteDeliverySweepScheduler();
    startAutomationDispatchScheduler();
    // Phase Y — Observability heartbeat + queue-health sampler.
    // The heartbeat fires every 30s; a log-based metrics provider
    // can derive `worker_last_heartbeat_age_seconds` by tailing
    // `worker.heartbeat` log lines. The queue sampler fires every
    // 60s and emits a structured snapshot operators / dashboards
    // can read.
    startObservabilityHeartbeat();
    startQueueHealthSampler();
    // Phase 32.8C+++++ — Durable queue + worker telemetry snapshots.
    // Failure-tolerant; never blocks job processing.
    try {
      telemetrySampler = startTelemetrySampler({
        intervalMs: 60_000,
        workerId: `worker-${process.pid}`,
      });
    } catch (err) {
      logger.warn({ err }, "telemetry.sampler_start_failed");
    }
  })
  .catch((err) => {
    const requestId = randomUUID();
    // SEC-004: this now also covers `aws_secrets.required_authority_unavailable`.
    // A `required` deployment whose secret store refused MUST NOT proceed to
    // claim jobs on an empty environment, and the non-zero exit is what makes
    // that visible to the orchestrator instead of surviving as a degraded
    // worker that silently produces unsigned or undelivered work.
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

// Enterprise Technical Metadata — one-time media-tooling capability
// diagnostic. Surfaces whether ffprobe (deterministic video/audio
// metadata) is actually available in this runtime so SRE can confirm
// production parses video rather than silently degrading to UNSUPPORTED.
// NEVER blocks startup and NEVER throws — capability detection is
// itself non-throwing.
void (async () => {
  try {
    const { detectFfmpegCapability } = await import("./ffmpeg-capability.js");
    const cap = await detectFfmpegCapability();
    logger.info(
      cap.ok
        ? {
            ok: true,
            source: cap.source,
            ffmpegAvailable: true,
            ffprobeAvailable: cap.ffprobePath !== null,
            ffprobePath: cap.ffprobePath,
          }
        : { ok: false, ffmpegAvailable: false, ffprobeAvailable: false, reason: cap.reason },
      "worker.media_tooling.capability",
    );
  } catch {
    /* diagnostic only — never affects worker boot */
  }
})();
