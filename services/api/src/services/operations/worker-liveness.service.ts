/**
 * IS THE WORKER FLEET ALIVE? — asked of the fleet, not of its queues.
 *
 * =============================================================================
 * WHAT WENT WRONG
 * =============================================================================
 * `getWorkerHealth()` derived worker status from QUEUE COUNTS. A queue with no
 * failed jobs and nothing stalled classified `healthy`, so a worker fleet that
 * had crashed — with its queues therefore quiet — rendered exactly like a
 * fleet that was running and idle. The row even carried
 * `lastActivityAtUtc: null` with the comment "heartbeat is logged but not
 * persisted today".
 *
 * That comment was stale by a phase. A durable heartbeat DOES exist:
 * `worker_telemetry_snapshots` is written every 60 seconds by
 * `services/worker/src/telemetry.ts` from inside a `finally`, so a sample
 * lands even when every queue probe that cycle failed. It carries
 * `heartbeatAtUtc`, the worker id, its kind and its processed/failed counts,
 * and it is already read correctly by the trust-centre probe. The queue
 * inventory simply never looked at it.
 *
 * =============================================================================
 * WHAT LIVENESS ACTUALLY MEANS HERE
 * =============================================================================
 * An empty queue is not evidence of a living worker, and the absence of a
 * heartbeat is not evidence of a healthy one. So:
 *
 *   LIVE          a heartbeat inside the freshness window.
 *   STALE         a heartbeat, but older than the window. The fleet WAS there.
 *                 This is the state that used to read as healthy.
 *   NO_HEARTBEAT  the table has no row for this kind at all. Not zero, not
 *                 healthy — we have never heard from a worker.
 *   UNKNOWN       the heartbeat store itself could not be read. A failure to
 *                 ask is not an answer.
 *
 * `NO_HEARTBEAT` is deliberately distinct from `UNKNOWN`: "no worker has ever
 * reported" and "we could not reach the table" lead an operator to different
 * places, and collapsing them is how an outage hides inside a fresh install.
 */

import { prisma } from "../../db.js";

/** Older than this and a heartbeat is not evidence of a live worker. */
export const WORKER_HEARTBEAT_STALE_SECONDS = 180;

export type WorkerLivenessState =
  | "LIVE"
  | "STALE"
  | "NO_HEARTBEAT"
  | "UNKNOWN";

export type WorkerInstanceLiveness = {
  workerId: string;
  workerKind: string;
  /** The worker's own last self-reported status, not our verdict. */
  reportedStatus: string;
  heartbeatAtUtc: string;
  ageSeconds: number;
  live: boolean;
  processedCount: number | null;
  failedCount: number | null;
};

export type WorkerFleetLiveness = {
  state: WorkerLivenessState;
  reason: string;
  /** One instant for the whole evaluation — never re-read per instance. */
  evaluatedAtUtc: string;
  liveInstances: number;
  staleInstances: number;
  instances: ReadonlyArray<WorkerInstanceLiveness>;
  /** The freshness rule this verdict was reached under. */
  staleAfterSeconds: number;
  /** The most recent heartbeat of any instance, live or not. */
  newestHeartbeatAtUtc: string | null;
};

/**
 * The fleet's liveness, from the durable heartbeat.
 *
 * `nowMs` is injected so a test can age a heartbeat without sleeping, and so
 * every row in one evaluation is judged against ONE instant.
 */
export async function getWorkerFleetLiveness(options?: {
  nowMs?: number;
  staleAfterSeconds?: number;
}): Promise<WorkerFleetLiveness> {
  const nowMs = options?.nowMs ?? Date.now();
  const staleAfterSeconds =
    options?.staleAfterSeconds ?? WORKER_HEARTBEAT_STALE_SECONDS;
  const evaluatedAtUtc = new Date(nowMs).toISOString();

  const base: Omit<WorkerFleetLiveness, "state" | "reason"> = {
    evaluatedAtUtc,
    liveInstances: 0,
    staleInstances: 0,
    instances: [],
    staleAfterSeconds,
    newestHeartbeatAtUtc: null,
  };

  let rows;
  try {
    // Newest heartbeat per worker id. The table is append-per-sample, so a
    // long-running instance has many rows and only its latest one is evidence.
    rows = await prisma.workerTelemetrySnapshot.findMany({
      orderBy: { heartbeatAtUtc: "desc" },
      take: 200,
    });
  } catch {
    return {
      ...base,
      state: "UNKNOWN",
      reason:
        "The worker heartbeat store could not be read, so worker liveness is unknown. This is not a statement that workers are healthy.",
    };
  }

  const newestByWorker = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const seen = newestByWorker.get(r.workerId);
    if (!seen || r.heartbeatAtUtc > seen.heartbeatAtUtc) {
      newestByWorker.set(r.workerId, r);
    }
  }

  if (newestByWorker.size === 0) {
    return {
      ...base,
      state: "NO_HEARTBEAT",
      reason:
        "No worker has ever reported a heartbeat. An empty queue is not evidence that a worker is running.",
    };
  }

  const instances: WorkerInstanceLiveness[] = [];
  let newestMs = -Infinity;
  for (const r of newestByWorker.values()) {
    const beatMs = r.heartbeatAtUtc.getTime();
    const ageSeconds = Math.max(0, Math.round((nowMs - beatMs) / 1000));
    newestMs = Math.max(newestMs, beatMs);
    instances.push({
      workerId: r.workerId,
      workerKind: String(r.workerKind),
      reportedStatus: String(r.status),
      heartbeatAtUtc: r.heartbeatAtUtc.toISOString(),
      ageSeconds,
      live: ageSeconds <= staleAfterSeconds,
      processedCount: r.processedCount ?? null,
      failedCount: r.failedCount ?? null,
    });
  }
  instances.sort((a, b) => a.ageSeconds - b.ageSeconds);

  const liveInstances = instances.filter((i) => i.live).length;
  const staleInstances = instances.length - liveInstances;
  const newestHeartbeatAtUtc =
    newestMs === -Infinity ? null : new Date(newestMs).toISOString();

  if (liveInstances === 0) {
    return {
      ...base,
      state: "STALE",
      reason:
        `No worker has reported within ${staleAfterSeconds}s. The newest heartbeat is ` +
        `${instances[0]?.ageSeconds ?? "?"}s old, so the fleet is not confirmed running.`,
      staleInstances,
      instances,
      newestHeartbeatAtUtc,
    };
  }

  return {
    ...base,
    state: "LIVE",
    reason: `${liveInstances} worker instance(s) reported within ${staleAfterSeconds}s.`,
    liveInstances,
    staleInstances,
    instances,
    newestHeartbeatAtUtc,
  };
}
