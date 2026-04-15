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

  void runDemoFollowUps("startup");
}

function stopDemoFollowUpScheduler() {
  if (followUpTimer) {
    clearInterval(followUpTimer);
    followUpTimer = null;
  }
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
  .then((server) => {
    healthServer = server;
    startDemoFollowUpScheduler();
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
    jobs: [generateReportJobName, purgeDeletedEvidenceJobName],
    followUpEnabled,
    followUpIntervalMs,
    internalApiBase,
  },
  "worker.started"
);
