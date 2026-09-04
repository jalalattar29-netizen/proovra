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
import { getWorkerFleetLiveness } from "./worker-liveness.service.js";

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
    // PHASE 12 POINT 8 — bound the SOCKET attempt too. `maxRetriesPerRequest:
    // null` is what BullMQ wants, and it is kept, but it means a command is
    // retried indefinitely; without a connect timeout each retry also waits on
    // the OS default. The per-call deadline in `withDeadline` is the guarantee;
    // this stops the client accumulating long-lived connect attempts behind it.
    connectTimeout: 2000,
  });
  // An unreachable Redis emits `error` on every retry. Without a listener those
  // are unhandled 'error' events on an EventEmitter, which crash the process.
  // The inventory's job is to PROJECT unavailability, not to be killed by it.
  _connection.on("error", () => {
    /* projected as `outage` by the inventory; never rethrown */
  });
  return _connection;
}

/**
 * PHASE 12 — POINT 8: every Redis await in this module is bounded.
 *
 * The module's contract says it is best-effort and projects `outage` when a
 * queue cannot be read. That projection was UNREACHABLE. `getConnection()`
 * builds the client with `maxRetriesPerRequest: null`, so a command issued
 * against an unreachable Redis is retried forever rather than rejected — and a
 * promise that never settles is not caught by `catch`. Measured: with
 * `REDIS_URL` pointing at a closed loopback port, `getQueueInventory()` was
 * still pending after six seconds with two live sockets retrying.
 *
 * That is a production hang, not only a test problem: `GET /v1/graph/diagnostics`
 * awaits this helper, and its own `try/catch` is equally powerless. With Redis
 * down the request would hang until something upstream gave up.
 *
 * A deadline turns "never settles" into the rejection the existing failure
 * projection already knows how to render. It does not swallow anything — a
 * timed-out queue is reported as `outage`, which is honest, rather than as
 * healthy-with-zero-counts.
 */
const QUEUE_PROBE_TIMEOUT_MS = Number(process.env.QUEUE_PROBE_TIMEOUT_MS ?? 2000);

/**
 * A per-probe deadline alone is NOT a bound on this function. The inventory
 * walks fifteen queues SEQUENTIALLY, so fifteen timeouts is thirty seconds —
 * measured, not assumed: with the per-probe deadline in place and Redis
 * unreachable, `getQueueInventory()` was still pending after six.
 *
 * So the whole call carries a budget. When it is spent, the remaining queues
 * are projected without being probed. They are reported `unknown` rather than
 * `outage`: "we ran out of time" and "Redis refused us" are different facts,
 * and neither is ever reported as healthy.
 */
const QUEUE_INVENTORY_BUDGET_MS = Number(process.env.QUEUE_INVENTORY_BUDGET_MS ?? 3000);

class QueueProbeTimeout extends Error {
  constructor(operation: string) {
    super(`queue probe "${operation}" exceeded ${QUEUE_PROBE_TIMEOUT_MS}ms`);
    this.name = "QueueProbeTimeout";
  }
}

function withDeadline<T>(operation: string, work: Promise<T>, budgetMs?: number): Promise<T> {
  const ms = Math.max(1, Math.min(QUEUE_PROBE_TIMEOUT_MS, budgetMs ?? QUEUE_PROBE_TIMEOUT_MS));
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new QueueProbeTimeout(operation)), ms);
      // The API process must not be held open by a probe timer.
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
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

// PHASE 12 POINT 5 — this map is EMPTY, and that is the outcome, not an
// oversight. Its only two entries were `mi-ocr` and `mi-transcript`, queues
// whose processors logged "not_configured_completed" and returned success.
// Those queues no longer exist: OCR and transcript extraction run on the
// media-intelligence queue (extract_ocr_azure / extract_transcript_deepgram)
// against a durable run row, which is where they always actually ran.
//
// A queue that needs an entry here is a queue with no live processor — which
// Point 5 does not permit. Keep the map so adding one stays a deliberate
// review step, and keep it empty.
const DISABLED_QUEUES: Record<string, string> = {};

/** Read-only view for the honesty contract test. Not a runtime seam. */
export const DISABLED_QUEUES_FOR_TESTS: Readonly<Record<string, string>> =
  DISABLED_QUEUES;

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
  const budgetExpiresAt = Date.now() + QUEUE_INVENTORY_BUDGET_MS;
  for (const name of KNOWN_QUEUE_NAMES) {
    const remainingBudgetMs = budgetExpiresAt - Date.now();
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
    if (remainingBudgetMs <= 0) {
      // Budget spent by earlier queues. Say so rather than probing a Redis
      // that is evidently not answering, and never claim health we did not
      // observe.
      out.push({
        queueName: name,
        label: QUEUE_LABELS[name] ?? name,
        counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        stalledCount: 0,
        health: "unknown",
        oldestWaitingAgeMs: null,
        disabledReason: "not probed — queue inventory time budget exhausted",
      });
      continue;
    }
    try {
      const counts = await withDeadline(
        `${name}.getJobCounts`,
        q.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
        remainingBudgetMs,
      );
      // Stalled count: BullMQ tracks stalled jobs separately; we
      // peek at the waiting queue and check for jobs older than the
      // lock duration. This is a best-effort signal.
      let stalledCount = 0;
      try {
        const waitingJobs = await withDeadline(`${name}.getWaiting.stalled`, q.getWaiting(0, 1), budgetExpiresAt - Date.now());
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
        const waitingJobs = await withDeadline(`${name}.getWaiting.oldest`, q.getWaiting(0, 0), budgetExpiresAt - Date.now());
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

export type ListFailedJobsResult = {
  jobs: ReadonlyArray<FailedJobItem>;
  /**
   * The queue's ACTUAL failed depth, from Redis.
   *
   * The page could only report how many rows it received, and the request caps
   * at 50 — so a dead-letter queue with 900 jobs and one with exactly 50 both
   * read as "50 failed jobs". For somebody deciding whether a subsystem is
   * degraded or destroyed, those are not the same page.
   *
   * `getFailedCount()` is an O(1) Redis ZCARD, not a scan.
   */
  total: number;
  /** The cap applied, echoed so the caller discloses rather than infers it. */
  limit: number;
};

export async function listFailedJobs(
  queueName: string,
  limit = 50,
): Promise<ListFailedJobsResult> {
  const capped = Math.min(Math.max(limit, 1), 50);
  const q = getQueueHandle(queueName);
  if (!q) return { jobs: [], total: 0, limit: capped };
  const [failed, total] = await Promise.all([
    q.getFailed(0, capped - 1),
    q.getFailedCount(),
  ]);
  const jobs = failed.map((job) => {
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
  return { jobs, total, limit: capped };
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
  /**
   * LIVENESS FIRST, QUEUE DEPTH SECOND.
   *
   * This function used to answer "is the worker alive?" with "is its queue
   * tidy?", so a crashed fleet with drained queues reported healthy on every
   * row. The durable heartbeat is the evidence; the queue is only the work.
   *
   * When the fleet is not confirmed live, no queue row may claim health —
   * whatever its counts say. A quiet queue in front of a dead worker is the
   * exact state the old code called healthy.
   */
  const inventory = await getQueueInventory();
  const fleet = await getWorkerFleetLiveness();

  const fleetBlocksHealth = fleet.state !== "LIVE";
  const fleetStatus: WorkerHealthRow["status"] =
    fleet.state === "STALE" || fleet.state === "NO_HEARTBEAT"
      ? "missing"
      : "unknown";

  return inventory.map((q) => {
    let status: WorkerHealthRow["status"] = "healthy";
    let recommendedAction: string | null = null;

    if (fleetBlocksHealth) {
      status = fleetStatus;
      recommendedAction = fleet.reason;
    } else if (q.health === "outage") {
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
    /**
     * An UNPROBED queue is not a healthy queue.
     *
     * `getQueueInventory` reports `health: "unknown"` when its probe budget
     * is spent — which happens precisely when Redis is not answering. Those
     * rows fell into the default `healthy` branch, so the moment the probe
     * stopped working every queue started reporting well.
     */
    if (!fleetBlocksHealth && (q.health === "unknown" || q.health === "unconfigured")) {
      status = "unknown";
      recommendedAction =
        recommendedAction ??
        "This queue was not probed in this sample, so its state is unknown rather than healthy.";
    }

    return {
      queueName: q.queueName,
      status,
      // The real heartbeat, at last: the newest observation from the fleet
      // this queue is served by.
      lastActivityAtUtc: fleet.newestHeartbeatAtUtc,
      stalledCount: q.stalledCount,
      recommendedAction,
    };
  });
}
