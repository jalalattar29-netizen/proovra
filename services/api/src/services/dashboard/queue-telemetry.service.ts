/**
 * Phase 32.8C+++++ — QueueTelemetrySnapshot writer + reader.
 *
 * Persists durable samples of queue depth/backlog. Two flavors:
 *
 *   * DB-DERIVED — counts derived from existing source tables. This is
 *     the writer that lives in the API: it's always available and never
 *     touches Redis/BullMQ.
 *   * BULLMQ      — worker-side writer can populate these directly from
 *     BullMQ; that path lives in services/worker. The dashboard reads
 *     whichever flavor is freshest per `queue_name`.
 *
 * Hard rules:
 *   - ADVISORY operational data. Writer failures NEVER block evidence /
 *     report / package / verify core flows. Callers wrap invocations in
 *     try/catch.
 *   - Bounded queries (take cap) and bounded summaries only.
 *   - No raw evidence contents, no signed URLs, no storage keys.
 *   - Reader filters to the most-recent snapshot per (queue_name, teamId)
 *     so the dashboard sees one freshest row per queue.
 */

import { prisma } from "../../db.js";
import {
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";

export type QueueTelemetryDomain =
  | "REPORT"
  | "PACKAGE"
  | "REVIEW"
  | "GOVERNANCE"
  | "INTAKE"
  | "WORKER"
  | "OTHER";

export type QueueTelemetrySource =
  | "BULLMQ"
  | "DB_DERIVED"
  | "WORKER_INTERNAL"
  | "OTHER";

export type QueueTelemetrySample = {
  queueName: string;
  queueDomain: QueueTelemetryDomain;
  waitingCount: number;
  activeCount?: number;
  delayedCount?: number;
  failedCount?: number;
  completedCount?: number;
  retryCount?: number;
  stalledCount?: number;
  oldestJobAgeMs?: number | null;
  latestJobAgeMs?: number | null;
};

/**
 * Persist a single snapshot. Never throws. The caller wraps in try/catch
 * for paranoia but the function already swallows errors.
 */
export async function recordQueueTelemetrySnapshot(input: {
  teamId: string | null;
  source: QueueTelemetrySource;
  sample: QueueTelemetrySample;
}): Promise<void> {
  try {
    await prisma.queueTelemetrySnapshot.create({
      data: {
        teamId: input.teamId,
        source: input.source,
        queueName: input.sample.queueName.slice(0, 80),
        queueDomain: input.sample.queueDomain,
        waitingCount: input.sample.waitingCount,
        activeCount: input.sample.activeCount ?? 0,
        delayedCount: input.sample.delayedCount ?? 0,
        failedCount: input.sample.failedCount ?? 0,
        completedCount: input.sample.completedCount ?? null,
        retryCount: input.sample.retryCount ?? 0,
        stalledCount: input.sample.stalledCount ?? 0,
        oldestJobAgeMs: input.sample.oldestJobAgeMs ?? null,
        latestJobAgeMs: input.sample.latestJobAgeMs ?? null,
      },
    });
  } catch {
    /* Advisory write — never throws. */
  }
}

/**
 * Compute DB-derived snapshots for a workspace and persist them. The
 * derivation reads only counts (never raw rows) so the cost is bounded.
 *
 * Sources:
 *   - REVIEW backlog       = evidence_review_workflows.status in NOT_STARTED|IN_REVIEW
 *   - REPORT backlog       = evidence rows status=SIGNED with no latest report
 *   - PACKAGE backlog      = evidence rows status=REPORTED with no verification package
 *   - GOVERNANCE backlog   = destruction_reviews.status open
 *
 * Returns the count of snapshots persisted.
 */
export async function recordDbDerivedSnapshotsForWorkspace(input: {
  teamId: string;
}): Promise<{ persisted: number; failed: number }> {
  // WORKSPACE-SCOPE CONVERGENCE — the canonical workspace population,
  // resolved once for every query below. A strict `teamId` equality here
  // omitted a personal workspace's legacy NULL-team rows, and reported the
  // smaller number as if it were the whole population.
  const scope = await workspaceEvidenceWhere(input.teamId, prisma);
  let persisted = 0;
  let failed = 0;

  // REVIEW backlog
  try {
    const waiting = await prisma.evidenceReviewWorkflow.count({
      where: {
        teamId: input.teamId,
        status: { in: ["NOT_STARTED", "IN_REVIEW"] },
      },
    });
    await recordQueueTelemetrySnapshot({
      teamId: input.teamId,
      source: "DB_DERIVED",
      sample: {
        queueName: "review",
        queueDomain: "REVIEW",
        waitingCount: waiting,
      },
    });
    persisted += 1;
  } catch {
    failed += 1;
  }

  // REPORT backlog — signed evidence with no report
  try {
    const waiting = await prisma.evidence.count({
      where: {
        AND: [scope],
        status: "SIGNED",
        latestReportVersion: null,
      },
    });
    await recordQueueTelemetrySnapshot({
      teamId: input.teamId,
      source: "DB_DERIVED",
      sample: {
        queueName: "report",
        queueDomain: "REPORT",
        waitingCount: waiting,
      },
    });
    persisted += 1;
  } catch {
    failed += 1;
  }

  // PACKAGE backlog — reported evidence with no verification package
  try {
    const waiting = await prisma.evidence.count({
      where: {
        AND: [scope],
        status: "REPORTED",
        verificationPackageVersion: null,
      },
    });
    await recordQueueTelemetrySnapshot({
      teamId: input.teamId,
      source: "DB_DERIVED",
      sample: {
        queueName: "package",
        queueDomain: "PACKAGE",
        waitingCount: waiting,
      },
    });
    persisted += 1;
  } catch {
    failed += 1;
  }

  // GOVERNANCE backlog — open destruction reviews (status catalog:
  // PENDING | UNDER_REVIEW | APPROVED | DENIED | DEFERRED | RESTORED |
  // EXECUTED | CANCELLED).
  try {
    const waiting = await prisma.destructionReview.count({
      where: {
        teamId: input.teamId,
        status: { in: ["PENDING", "UNDER_REVIEW", "DEFERRED"] },
      },
    });
    await recordQueueTelemetrySnapshot({
      teamId: input.teamId,
      source: "DB_DERIVED",
      sample: {
        queueName: "governance",
        queueDomain: "GOVERNANCE",
        waitingCount: waiting,
      },
    });
    persisted += 1;
  } catch {
    failed += 1;
  }

  return { persisted, failed };
}

/**
 * Dashboard reader: returns the freshest snapshot per queue (within the
 * last N minutes). Bounded result, no raw payloads.
 */
export async function listLatestQueueSnapshots(input: {
  teamId: string;
  withinMinutes?: number;
  limit?: number;
}): Promise<
  Array<{
    queueName: string;
    queueDomain: QueueTelemetryDomain;
    waitingCount: number;
    activeCount: number;
    delayedCount: number;
    failedCount: number;
    retryCount: number;
    stalledCount: number;
    sampledAtUtc: string;
    source: QueueTelemetrySource;
  }>
> {
  const minutes = Math.min(Math.max(input.withinMinutes ?? 240, 1), 1440);
  const since = new Date(Date.now() - minutes * 60 * 1000);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  // Pull bounded recent rows for this workspace.
  const rows = await prisma.queueTelemetrySnapshot.findMany({
    where: {
      teamId: input.teamId,
      sampledAtUtc: { gte: since },
    },
    orderBy: { sampledAtUtc: "desc" },
    take: limit * 4, // headroom for de-dup
    select: {
      queueName: true,
      queueDomain: true,
      waitingCount: true,
      activeCount: true,
      delayedCount: true,
      failedCount: true,
      retryCount: true,
      stalledCount: true,
      sampledAtUtc: true,
      source: true,
    },
  });

  // Keep first occurrence per queueName (most recent first).
  const seen = new Set<string>();
  const out: ReturnType<typeof mapRow>[] = [];
  for (const r of rows) {
    if (seen.has(r.queueName)) continue;
    seen.add(r.queueName);
    out.push(mapRow(r));
    if (out.length >= limit) break;
  }
  return out;
}

function mapRow(r: {
  queueName: string;
  queueDomain: QueueTelemetryDomain;
  waitingCount: number;
  activeCount: number;
  delayedCount: number;
  failedCount: number;
  retryCount: number;
  stalledCount: number;
  sampledAtUtc: Date;
  source: QueueTelemetrySource;
}) {
  return {
    queueName: r.queueName,
    queueDomain: r.queueDomain as QueueTelemetryDomain,
    waitingCount: r.waitingCount,
    activeCount: r.activeCount,
    delayedCount: r.delayedCount,
    failedCount: r.failedCount,
    retryCount: r.retryCount,
    stalledCount: r.stalledCount,
    sampledAtUtc: r.sampledAtUtc.toISOString(),
    source: r.source as QueueTelemetrySource,
  };
}
