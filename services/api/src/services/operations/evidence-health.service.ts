/**
 * Platform Control Center P1 — Evidence Pipeline Health aggregation.
 *
 * READ-ONLY. This service ONLY counts. It NEVER recomputes a hash,
 * signs, mutates custody, generates a report or package, or reads
 * evidence *contents* (bytes, storage keys, signatures, fingerprints,
 * private notes, GPS). Every field is either:
 *
 *   - a real DB `count` / `groupBy` over an operational status column, or
 *   - a real queue-inventory number (reused from the existing
 *     queue-inventory.service — we do NOT re-implement queue reads), or
 *   - `null` when no honest signal exists ("Not measured" / "Not
 *     connected"). We NEVER fabricate a "healthy" / `0` where the
 *     underlying signal is genuinely absent.
 *
 * Scope: PLATFORM-WIDE (no teamId filter). The caller
 * (`admin-evidence-ops.routes.ts`) gates on `requirePlatformAdmin`.
 *
 * Failure posture: every metric read is wrapped so a single failing
 * count (or a Redis-down queue read) degrades THAT metric to `null`
 * rather than throwing the whole snapshot. `null` is the honest
 * "we could not measure this right now" value.
 */

import { prisma } from "../../db.js";
import {
  getQueueInventory,
  type QueueInventoryItem,
} from "./queue-inventory.service.js";

/**
 * A metric is either a real measured number or `null` when the signal
 * is genuinely absent / unreadable. Consumers render `null` as
 * "Not measured" / "Not connected" — never as a fabricated healthy 0.
 */
export type Measured = number | null;

export interface EvidenceHealthSnapshot {
  /** Wall-clock of when this snapshot was assembled. */
  generatedAtUtc: string;
  /** Windowed metrics use this look-back (hours). */
  windowHours: number;

  uploads: {
    /** UploadSession in UPLOADING or PARTIAL. */
    inProgress: Measured;
    /** UploadSession in STALLED. */
    stalled: Measured;
    /** UploadSession in FAILED. */
    failed: Measured;
  };

  evidence: {
    /** All live Evidence rows (deletedAt null). */
    created: Measured;
    /** Live Evidence created within the window. */
    createdInWindow: Measured;
    /** Live Evidence in SIGNED status. */
    signed: Measured;
    /** SIGNED evidence with no report yet (latestReportVersion null). */
    withoutReport: Measured;
    /** Evidence in the FAILED_HASH_MISMATCH terminal state. */
    hashMismatch: Measured;
  };

  reports: {
    /**
     * Failed report generation. A Report row is only written on
     * SUCCESS (the worker DLQs on failure without persisting a Report),
     * so this is sourced from the report queue's `failed` job count +
     * the report DLQ backlog — NOT from a Report.status column (there
     * is none). `null` if the queue signal is unreadable.
     */
    failedGeneration: Measured;
    /** Report queue waiting + active + delayed (work not yet done). */
    queued: Measured;
  };

  packages: {
    /** Evidence in REPORTED status still missing a verification package. */
    verificationBacklog: Measured;
    /**
     * Failed package jobs. Packages ride the `report` queue in this
     * build (there is no separate package queue), so a per-package
     * failure signal is NOT independently measurable — reported as
     * `null` ("Not measured") rather than a fabricated 0.
     */
    failed: Measured;
    /** Package work queued (same `report` queue). */
    queued: Measured;
  };

  preservation: {
    /**
     * RFC-3161 TSA timestamp failures. Real signal:
     * Evidence.tsaStatus = "FAILED" (set by the worker on TSA failure).
     */
    tsaFailures: Measured;
    /**
     * OpenTimestamps anchoring failures. Real signal:
     * Evidence.otsStatus = "FAILED" (set by the worker / ots-upgrade
     * processor on anchoring failure).
     */
    otsAnchoringFailures: Measured;
  };

  incidents: {
    /** Open/acknowledged incidents in the REPORT category. */
    openReport: Measured;
    /** Open/acknowledged incidents in the PACKAGE category. */
    openPackage: Measured;
    /** Open/acknowledged incidents in the STORAGE category. */
    openStorage: Measured;
    /** Open/acknowledged incidents in the UPLOAD category. */
    openUpload: Measured;
  };

  workerQueues: {
    /** Sum of failed jobs across all known queues. */
    totalFailed: Measured;
    /** Sum of stalled jobs across all known queues. */
    totalStalled: Measured;
    /** Number of queues whose health is degraded/outage. */
    degradedCount: Measured;
    /** Total queues we could read. */
    queueCount: Measured;
    /** Deep-link hint for the operator to the full queue console. */
    detailHref: string;
  };
}

/** Open + acknowledged are the two "still needs attention" states. */
// ADM-013 — one authority. See incident-open-statuses.ts.
import { UNRESOLVED_INCIDENT_STATUSES } from "./incident-open-statuses.js";

const OPEN_INCIDENT_STATUSES = UNRESOLVED_INCIDENT_STATUSES;

/**
 * Run a count; return `null` (honest "not measured") on any failure
 * instead of letting one bad read sink the snapshot.
 */
async function measured(run: () => Promise<number>): Promise<Measured> {
  try {
    return await run();
  } catch {
    return null;
  }
}

/**
 * Reuse the existing queue-inventory projection to derive report /
 * package queue numbers + the platform-wide worker rollup. We do NOT
 * re-read Redis here — that logic lives entirely in
 * queue-inventory.service.ts. Returns `null` blocks when the inventory
 * is unreadable.
 */
function summariseQueues(inventory: ReadonlyArray<QueueInventoryItem>) {
  const byName = new Map(inventory.map((q) => [q.queueName, q]));

  const reportQueue = byName.get("report") ?? null;
  const reportDlq = byName.get("report-dlq") ?? null;

  // Failed report generation: failed jobs on the report queue plus the
  // whole DLQ backlog (every DLQ entry is a report that failed all
  // retries). Null only if we could not read the report queue at all.
  let reportFailedGeneration: Measured = null;
  if (reportQueue) {
    reportFailedGeneration =
      reportQueue.counts.failed + (reportDlq ? reportDlq.counts.waiting + reportDlq.counts.active + reportDlq.counts.failed : 0);
  }

  const reportQueued: Measured = reportQueue
    ? reportQueue.counts.waiting +
      reportQueue.counts.active +
      reportQueue.counts.delayed
    : null;

  let totalFailed = 0;
  let totalStalled = 0;
  let degradedCount = 0;
  for (const q of inventory) {
    totalFailed += q.counts.failed;
    totalStalled += q.stalledCount;
    if (q.health === "degraded" || q.health === "outage") degradedCount += 1;
  }

  return {
    reportFailedGeneration,
    reportQueued,
    totalFailed,
    totalStalled,
    degradedCount,
    queueCount: inventory.length,
  };
}

export interface BuildEvidenceHealthOptions {
  /** Look-back window for windowed metrics. Defaults to 24h. */
  windowHours?: number;
}

/**
 * Assemble the platform-wide evidence pipeline health snapshot.
 * Every field is real or an honest `null`. Never throws for a single
 * failed sub-read.
 */
export async function buildEvidenceHealthSnapshot(
  options: BuildEvidenceHealthOptions = {},
): Promise<EvidenceHealthSnapshot> {
  const windowHours =
    typeof options.windowHours === "number" &&
    Number.isFinite(options.windowHours) &&
    options.windowHours > 0
      ? Math.min(options.windowHours, 24 * 30)
      : 24;

  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  // Queue inventory is read once and reused. If Redis is down the whole
  // projection returns an empty array and the derived numbers become
  // null (honest), never fabricated.
  let inventory: ReadonlyArray<QueueInventoryItem> = [];
  let inventoryOk = false;
  try {
    inventory = await getQueueInventory();
    inventoryOk = true;
  } catch {
    inventoryOk = false;
  }
  const queues = inventoryOk ? summariseQueues(inventory) : null;

  const [
    uploadsInProgress,
    stalledUploads,
    failedUploads,
    evidenceCreated,
    evidenceCreatedInWindow,
    signedEvidence,
    evidenceWithoutReport,
    hashMismatch,
    verificationBacklog,
    tsaFailures,
    otsAnchoringFailures,
    openReport,
    openPackage,
    openStorage,
    openUpload,
  ] = await Promise.all([
    measured(() =>
      prisma.uploadSession.count({
        where: { status: { in: ["UPLOADING", "PARTIAL"] } },
      }),
    ),
    measured(() =>
      prisma.uploadSession.count({ where: { status: "STALLED" } }),
    ),
    measured(() =>
      prisma.uploadSession.count({ where: { status: "FAILED" } }),
    ),
    measured(() => prisma.evidence.count({ where: { deletedAt: null } })),
    measured(() =>
      prisma.evidence.count({
        where: { deletedAt: null, createdAt: { gte: windowStart } },
      }),
    ),
    measured(() =>
      prisma.evidence.count({ where: { deletedAt: null, status: "SIGNED" } }),
    ),
    // "Signed but no report" — the canonical missing-artifact signal
    // (mirrors case-risk-engine.service.ts). READ of a version pointer
    // column only; never the report bytes.
    measured(() =>
      prisma.evidence.count({
        where: { deletedAt: null, status: "SIGNED", latestReportVersion: null },
      }),
    ),
    measured(() =>
      prisma.evidence.count({
        where: { deletedAt: null, status: "FAILED_HASH_MISMATCH" },
      }),
    ),
    // REPORTED evidence still missing a verification package.
    measured(() =>
      prisma.evidence.count({
        where: {
          deletedAt: null,
          status: "REPORTED",
          verificationPackageVersion: null,
        },
      }),
    ),
    // Real preservation-failure signals from Evidence status columns.
    measured(() =>
      prisma.evidence.count({
        where: { deletedAt: null, tsaStatus: "FAILED" },
      }),
    ),
    measured(() =>
      prisma.evidence.count({
        where: { deletedAt: null, otsStatus: "FAILED" },
      }),
    ),
    measured(() =>
      prisma.operationalIncident.count({
        where: {
          category: "REPORT",
          status: { in: [...OPEN_INCIDENT_STATUSES] },
        },
      }),
    ),
    measured(() =>
      prisma.operationalIncident.count({
        where: {
          category: "PACKAGE",
          status: { in: [...OPEN_INCIDENT_STATUSES] },
        },
      }),
    ),
    measured(() =>
      prisma.operationalIncident.count({
        where: {
          category: "STORAGE",
          status: { in: [...OPEN_INCIDENT_STATUSES] },
        },
      }),
    ),
    measured(() =>
      prisma.operationalIncident.count({
        where: {
          category: "UPLOAD",
          status: { in: [...OPEN_INCIDENT_STATUSES] },
        },
      }),
    ),
  ]);

  return {
    generatedAtUtc: new Date().toISOString(),
    windowHours,
    uploads: {
      inProgress: uploadsInProgress,
      stalled: stalledUploads,
      failed: failedUploads,
    },
    evidence: {
      created: evidenceCreated,
      createdInWindow: evidenceCreatedInWindow,
      signed: signedEvidence,
      withoutReport: evidenceWithoutReport,
      hashMismatch,
    },
    reports: {
      failedGeneration: queues ? queues.reportFailedGeneration : null,
      queued: queues ? queues.reportQueued : null,
    },
    packages: {
      verificationBacklog,
      // No independent package-queue signal in this build → honest null.
      failed: null,
      // Packages share the report queue; expose the same queued number.
      queued: queues ? queues.reportQueued : null,
    },
    preservation: {
      tsaFailures,
      otsAnchoringFailures,
    },
    incidents: {
      openReport,
      openPackage,
      openStorage,
      openUpload,
    },
    workerQueues: {
      totalFailed: queues ? queues.totalFailed : null,
      totalStalled: queues ? queues.totalStalled : null,
      degradedCount: queues ? queues.degradedCount : null,
      queueCount: queues ? queues.queueCount : null,
      detailHref: "/operations/queues",
    },
  };
}
