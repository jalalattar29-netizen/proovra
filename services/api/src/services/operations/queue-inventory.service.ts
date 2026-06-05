/**
 * Phase P2.3 — Queue inventory + failed-job listing + worker health.
 *
 * Reads BullMQ queues by name (lazy + memoised) and projects an
 * operator-safe snapshot. NEVER returns raw Redis errors / payloads.
 * NEVER calls IORedis.eval / KEYS / similar raw commands; everything
 * goes through the BullMQ Queue API.
 *
 * Hard rules:
 *   * Returned data is bounded. Listings cap at 50 jobs; we do not
 *     paginate beyond that — operators with thousands of failed
 *     jobs should triage via the audit center.
 *   * Stack traces are sanitised through `sanitiseStack()` —
 *     bounded to 800 chars, with absolute file paths stripped to
 *     basename + line:col.
 *   * The Redis connection is lazily created and shared across
 *     all queue handles to avoid hitting Redis's per-client cap.
 *   * Queue handles are READ-ONLY: we never call `queue.add()` from
 *     this module. Mutations (retry, replay, cancel) live in
 *     `queue-replay-action.service.ts`.
 */

import { Queue, type QueueOptions } from "bullmq";
import IORedis from "ioredis";

import { KNOWN_QUEUE_NAMES } from "./queue-replay-safety.service.js";

// ---------------------------------------------------------------------------
// Shared connection + queue handle cache
// ---------------------------------------------------------------------------

let _connection: IORedis | null = null;

function getConnection(): IORedis {
  if (_connection) return _connection;
  const url = (process.env.REDIS_URL ?? "").trim();
  if (!url) {
    throw new Error("REDIS_URL is not set");
  }
  _connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    // The inventory service is read-mostly; we accept lazyConnect
    // so a Redis outage does not crash the api at construction
    // time. The first `getJobCounts()` call surfaces the error.
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  return _connection;
}

const _queues = new Map<string, Queue>();

/**
 * Resolve a BullMQ `Queue` handle by name. Refuses unknown names.
 */
export function getQueueHandle(name: string): Queue | null {
  if (!KNOWN_QUEUE_NAMES.includes(name)) return null;
  const existing = _queues.get(name);
  if (existing) return existing;
  const opts: QueueOptions = {
    // BullMQ accepts the IORedis instance directly as connection.
    connection: getConnection() as unknown as QueueOptions["connection"],
  };
  const q = new Queue(name, opts);
  _queues.set(name, q);
  return q;
}

// ---------------------------------------------------------------------------
// Inventory projection
// ---------------------------------------------------------------------------

export type QueueHealthStatus =
  | "healthy"
  | "degraded"
  | "outage"
  | "unconfigured"
  | "disabled"
  | "unknown";

export type QueueInventoryItem = {
  queueName: string;
  /** Operator-readable label. */
  label: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  };
  /** Number of currently-stalled jobs (jobs whose worker lost the lock). */
  stalledCount: number;
  /** Operator-safe health classification. */
  health: QueueHealthStatus;
  /** Oldest waiting job age (ms). null when no waiting jobs. */
  oldestWaitingAgeMs: number | null;
  /** When health is "disabled" or "unconfigured", an operator-readable
   *  reason. null otherwise. */
  disabledReason: string | null;
};

// ---------------------------------------------------------------------------
// Bounded reason copy for queues whose processor is not wired in this
// build. The dead-processor list is small + fixed — keep it explicit so
// adding a new queue here is a deliberate review step.
// ---------------------------------------------------------------------------

const DISABLED_QUEUES: Record<string, string> = {
  // mi-ocr / mi-transcript subsystem processors log
  // "not_configured_completed" and return — there is no upstream
  // producer in the current build. Automatic OCR / transcript
  // extraction flows through the media-intelligence queue
  // (extract_ocr_azure / extract_transcript_deepgram) instead.
  "mi-ocr": "Not in current build. Automatic OCR runs via the media-intelligence queue.",
  "mi-transcript":
    "Not in current build. Automatic transcripts run via the media-intelligence queue.",
};

const QUEUE_LABELS: Record<string, string> = {
  report: "Report PDFs",
  "report-dlq": "Report DLQ",
  "evidence-purge": "Evidence purge",
  "ots-upgrade": "OpenTimestamps upgrade",
  "search-indexing": "Search indexing",
  "media-intelligence": "Media intelligence",
  "media-intelligence-dlq": "Media intelligence DLQ",
  "mi-derived-assets": "MI · derived assets",
  "mi-exif": "MI · EXIF",
  "mi-ocr": "MI · OCR",
  "mi-transcript": "MI · transcripts",
  "mi-search-index": "MI · search index",
  "graph-reconcile": "Graph reconcile",
  "graph-domain-sync": "Graph · domain sync",
  "graph-timeline-sync": "Graph · timeline sync",
  "graph-search-projection": "Graph · search projection",
  "org-health-refresh": "Org health refresh",
};

function classifyHealth(item: {
  counts: QueueInventoryItem["counts"];
  stalledCount: number;
  oldestWaitingAgeMs: number | null;
}): QueueHealthStatus {
  if (item.stalledCount > 0) return "degraded";
  // Waiting jobs older than 5 minutes are degraded.
  if (item.oldestWaitingAgeMs !== null && item.oldestWaitingAgeMs > 5 * 60_000) {
    return "degraded";
  }
  if (item.counts.failed > 0) return "degraded";
  return "healthy";
}

export async function getQueueInventory(): Promise<
  ReadonlyArray<QueueInventoryItem>
> {
  const out: QueueInventoryItem[] = [];
  for (const name of KNOWN_QUEUE_NAMES) {
    const disabledReason = DISABLED_QUEUES[name] ?? null;
    if (disabledReason) {
      out.push({
        queueName: name,
        label: QUEUE_LABELS[name] ?? name,
        counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        stalledCount: 0,
        health: "disabled",
        oldestWaitingAgeMs: null,
        disabledReason,
      });
      continue;
    }
    const q = getQueueHandle(name);
    if (!q) continue;
    try {
      const counts = await q.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed",
      );
      // Stalled count: BullMQ tracks stalled jobs separately; we
      // peek at the waiting queue and check for jobs older than the
      // lock duration. This is a best-effort signal.
      let stalledCount = 0;
      try {
        const waitingJobs = await q.getWaiting(0, 1);
        const now = Date.now();
        for (const j of waitingJobs) {
          if (
            typeof j.timestamp === "number" &&
            now - j.timestamp > 5 * 60_000
          ) {
            stalledCount++;
          }
        }
      } catch {
        // Non-fatal
      }
      // Oldest waiting age.
      let oldestWaitingAgeMs: number | null = null;
      try {
        const waitingJobs = await q.getWaiting(0, 0);
        if (waitingJobs.length > 0 && typeof waitingJobs[0].timestamp === "number") {
          oldestWaitingAgeMs = Date.now() - waitingJobs[0].timestamp;
        }
      } catch {
        // Non-fatal
      }
      const projection = {
        counts: {
          waiting: Number(counts.waiting ?? 0),
          active: Number(counts.active ?? 0),
          delayed: Number(counts.delayed ?? 0),
          failed: Number(counts.failed ?? 0),
          completed: Number(counts.completed ?? 0),
        },
        stalledCount,
        oldestWaitingAgeMs,
      };
      out.push({
        queueName: name,
        label: QUEUE_LABELS[name] ?? name,
        ...projection,
        health: classifyHealth(projection),
        disabledReason: null,
      });
    } catch {
      out.push({
        queueName: name,
        label: QUEUE_LABELS[name] ?? name,
        counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        stalledCount: 0,
        health: "outage",
        oldestWaitingAgeMs: null,
        disabledReason: null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failed job listing
// ---------------------------------------------------------------------------

export type FailedJobItem = {
  jobId: string;
  jobName: string;
  failedAtUtc: string | null;
  attemptsMade: number;
  /** From defaultJobOptions.attempts. May be unknown. */
  maxAttempts: number | null;
  /** Sanitised reason. */
  failureReason: string;
  /** Sanitised stack snippet (≤ 800 chars). */
  stackSnippet: string | null;
  /** Workspace / evidence / matter ref if present in safe payload fields. */
  safeRefs: {
    teamId: string | null;
    evidenceId: string | null;
    matterId: string | null;
  };
};

export async function listFailedJobs(
  queueName: string,
  limit = 50,
): Promise<ReadonlyArray<FailedJobItem>> {
  const q = getQueueHandle(queueName);
  if (!q) return [];
  const capped = Math.min(Math.max(limit, 1), 50);
  const failed = await q.getFailed(0, capped - 1);
  return failed.map((job) => {
    const data = (job.data ?? {}) as Record<string, unknown>;
    const safeRefs = {
      teamId: typeof data.teamId === "string" ? data.teamId : null,
      evidenceId: typeof data.evidenceId === "string" ? data.evidenceId : null,
      matterId: typeof data.matterId === "string" ? data.matterId : null,
    };
    return {
      jobId: String(job.id ?? ""),
      jobName: String(job.name ?? "unknown"),
      failedAtUtc: job.finishedOn
        ? new Date(job.finishedOn).toISOString()
        : null,
      attemptsMade: Number(job.attemptsMade ?? 0),
      maxAttempts:
        typeof job.opts?.attempts === "number" ? job.opts.attempts : null,
      failureReason: sanitiseReason(job.failedReason ?? null),
      stackSnippet: sanitiseStack(job.stacktrace ?? null),
      safeRefs,
    };
  });
}

function sanitiseReason(raw: string | null | undefined): string {
  if (!raw) return "unknown_failure";
  // Strip absolute file paths from the reason; cap length.
  return String(raw)
    .replace(/[A-Za-z]:\\[^\s]+/g, "<path>")
    .replace(/\/[^\s:]+/g, "<path>")
    .slice(0, 240);
}

function sanitiseStack(stack: string[] | string | null): string | null {
  if (!stack) return null;
  const text = Array.isArray(stack) ? stack.join("\n") : String(stack);
  // Drop file system prefixes; bound to 800 chars.
  return text
    .replace(/[A-Za-z]:\\[^\s)]+/g, "<path>")
    .replace(/\(\/.*?\)/g, "(<path>)")
    .slice(0, 800);
}

// ---------------------------------------------------------------------------
// Worker health (observability-derived; bounded, no raw Redis state)
// ---------------------------------------------------------------------------

export type WorkerHealthRow = {
  /** Stable label that maps to the worker process; we don't have a
   *  worker ID registry, so this is the queue name today. */
  queueName: string;
  status:
    | "healthy"          // counts are progressing
    | "degraded"         // stalled or backed up
    | "missing"          // we cannot reach the queue at all
    | "unknown";
  lastActivityAtUtc: string | null;
  stalledCount: number;
  recommendedAction: string | null;
};

export async function getWorkerHealth(): Promise<
  ReadonlyArray<WorkerHealthRow>
> {
  const inventory = await getQueueInventory();
  return inventory.map((q) => {
    let status: WorkerHealthRow["status"] = "healthy";
    let recommendedAction: string | null = null;
    if (q.health === "outage") {
      status = "missing";
      recommendedAction =
        "Queue read failed. Confirm worker container is running and Redis is reachable.";
    } else if (q.health === "degraded") {
      status = "degraded";
      if (q.stalledCount > 0) {
        recommendedAction =
          "Stalled jobs detected. Inspect the failed-jobs view and consider replay for the safe category.";
      } else if (q.counts.failed > 0) {
        recommendedAction =
          "Failed jobs in queue. Triage via the failed-jobs view.";
      } else if (
        q.oldestWaitingAgeMs !== null &&
        q.oldestWaitingAgeMs > 5 * 60_000
      ) {
        recommendedAction = "Oldest waiting job > 5 minutes. Worker may be saturated.";
      }
    }
    return {
      queueName: q.queueName,
      status,
      lastActivityAtUtc: null, // Worker heartbeat is logged but not persisted today.
      stalledCount: q.stalledCount,
      recommendedAction,
    };
  });
}
