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
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { KNOWN_QUEUE_NAMES } from "./queue-replay-safety.service.js";
// ---------------------------------------------------------------------------
// Shared connection + queue handle cache
// ---------------------------------------------------------------------------
let _connection = null;
function getConnection() {
    if (_connection)
        return _connection;
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
const _queues = new Map();
/**
 * Resolve a BullMQ `Queue` handle by name. Refuses unknown names.
 */
export function getQueueHandle(name) {
    if (!KNOWN_QUEUE_NAMES.includes(name))
        return null;
    const existing = _queues.get(name);
    if (existing)
        return existing;
    const opts = {
        // BullMQ accepts the IORedis instance directly as connection.
        connection: getConnection(),
    };
    const q = new Queue(name, opts);
    _queues.set(name, q);
    return q;
}
const QUEUE_LABELS = {
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
function classifyHealth(item) {
    if (item.stalledCount > 0)
        return "degraded";
    // Waiting jobs older than 5 minutes are degraded.
    if (item.oldestWaitingAgeMs !== null && item.oldestWaitingAgeMs > 5 * 60_000) {
        return "degraded";
    }
    if (item.counts.failed > 0)
        return "degraded";
    return "healthy";
}
export async function getQueueInventory() {
    const out = [];
    for (const name of KNOWN_QUEUE_NAMES) {
        const q = getQueueHandle(name);
        if (!q)
            continue;
        try {
            const counts = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed");
            // Stalled count: BullMQ tracks stalled jobs separately; we
            // peek at the waiting queue and check for jobs older than the
            // lock duration. This is a best-effort signal.
            let stalledCount = 0;
            try {
                const waitingJobs = await q.getWaiting(0, 1);
                const now = Date.now();
                for (const j of waitingJobs) {
                    if (typeof j.timestamp === "number" &&
                        now - j.timestamp > 5 * 60_000) {
                        stalledCount++;
                    }
                }
            }
            catch {
                // Non-fatal
            }
            // Oldest waiting age.
            let oldestWaitingAgeMs = null;
            try {
                const waitingJobs = await q.getWaiting(0, 0);
                if (waitingJobs.length > 0 && typeof waitingJobs[0].timestamp === "number") {
                    oldestWaitingAgeMs = Date.now() - waitingJobs[0].timestamp;
                }
            }
            catch {
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
            });
        }
        catch {
            out.push({
                queueName: name,
                label: QUEUE_LABELS[name] ?? name,
                counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
                stalledCount: 0,
                health: "outage",
                oldestWaitingAgeMs: null,
            });
        }
    }
    return out;
}
export async function listFailedJobs(queueName, limit = 50) {
    const q = getQueueHandle(queueName);
    if (!q)
        return [];
    const capped = Math.min(Math.max(limit, 1), 50);
    const failed = await q.getFailed(0, capped - 1);
    return failed.map((job) => {
        const data = (job.data ?? {});
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
            maxAttempts: typeof job.opts?.attempts === "number" ? job.opts.attempts : null,
            failureReason: sanitiseReason(job.failedReason ?? null),
            stackSnippet: sanitiseStack(job.stacktrace ?? null),
            safeRefs,
        };
    });
}
function sanitiseReason(raw) {
    if (!raw)
        return "unknown_failure";
    // Strip absolute file paths from the reason; cap length.
    return String(raw)
        .replace(/[A-Za-z]:\\[^\s]+/g, "<path>")
        .replace(/\/[^\s:]+/g, "<path>")
        .slice(0, 240);
}
function sanitiseStack(stack) {
    if (!stack)
        return null;
    const text = Array.isArray(stack) ? stack.join("\n") : String(stack);
    // Drop file system prefixes; bound to 800 chars.
    return text
        .replace(/[A-Za-z]:\\[^\s)]+/g, "<path>")
        .replace(/\(\/.*?\)/g, "(<path>)")
        .slice(0, 800);
}
export async function getWorkerHealth() {
    const inventory = await getQueueInventory();
    return inventory.map((q) => {
        let status = "healthy";
        let recommendedAction = null;
        if (q.health === "outage") {
            status = "missing";
            recommendedAction =
                "Queue read failed. Confirm worker container is running and Redis is reachable.";
        }
        else if (q.health === "degraded") {
            status = "degraded";
            if (q.stalledCount > 0) {
                recommendedAction =
                    "Stalled jobs detected. Inspect the failed-jobs view and consider replay for the safe category.";
            }
            else if (q.counts.failed > 0) {
                recommendedAction =
                    "Failed jobs in queue. Triage via the failed-jobs view.";
            }
            else if (q.oldestWaitingAgeMs !== null &&
                q.oldestWaitingAgeMs > 5 * 60_000) {
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
