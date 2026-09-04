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
import {
  metricError,
  metricNotMeasured,
  metricStale,
  metricValue,
  type Metric,
} from "../admin/metric-state.js";

/**
 * THE HEARTBEAT CONTRACT, IN ONE PLACE.
 *
 * The worker's sampler (`services/worker/src/telemetry.ts`) writes one
 * `worker_telemetry_snapshots` row per cycle from inside a `finally`, so a
 * sample lands even when every queue probe that cycle threw. Its interval is
 * bounded at the source: default 60s, floor 15s, ceiling 600s.
 *
 * The stale threshold has to be a MULTIPLE of that interval, not a number
 * picked to feel right. At exactly one interval every ordinary scheduling
 * delay reads as a dead fleet; at three, a worker has to miss three
 * consecutive cycles before the platform says so, which is the difference
 * between "late" and "gone". 180s is 3 × 60s and is derived that way below so
 * the relationship survives someone changing the interval.
 *
 * Both are overridable for tests — the lifecycle proof needs a threshold it
 * can outlive in seconds rather than minutes — but the override is bounded so
 * a mistyped env cannot make every fleet permanently live.
 */
export const WORKER_HEARTBEAT_INTERVAL_SECONDS = 60;

/** How many consecutive missed heartbeats before the fleet is not "live". */
export const WORKER_HEARTBEAT_MISSED_CYCLES = 3;

/** Older than this and a heartbeat is not evidence of a live worker. */
export const WORKER_HEARTBEAT_STALE_SECONDS =
  WORKER_HEARTBEAT_INTERVAL_SECONDS * WORKER_HEARTBEAT_MISSED_CYCLES;

/**
 * The effective threshold, honouring a bounded test override.
 *
 * Floor 5s so a proof can run in seconds; ceiling 3600s so a fat-fingered
 * value cannot silently declare a dead fleet healthy for a day.
 */
export function resolveStaleAfterSeconds(explicit?: number): number {
  const raw =
    explicit ?? Number(process.env.WORKER_HEARTBEAT_STALE_SECONDS ?? "");
  // An unset env gives Number("") === 0, which falls through to the default
  // along with every other unusable value.
  if (!Number.isFinite(raw) || raw <= 0) return WORKER_HEARTBEAT_STALE_SECONDS;
  return Math.min(Math.max(Math.round(raw), 5), 3600);
}


/**
 * The heartbeat metadata, read defensively.
 *
 * These rows are written by a DIFFERENT deployable on its own release
 * cadence, so a heartbeat from an older worker simply has no metadata and a
 * newer one may have fields this reader has never heard of. Neither is an
 * error, and neither may be allowed to throw inside a liveness read — a
 * crash here would turn "the fleet is alive" into "unknown".
 */
function meta(raw: unknown): {
  buildRevision: string | null;
  queueSubscriptions: string[];
} {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rev = typeof o.buildRevision === "string" ? o.buildRevision : null;
  const subs = Array.isArray(o.queueSubscriptions)
    ? o.queueSubscriptions.filter((q): q is string => typeof q === "string")
    : [];
  return { buildRevision: rev, queueSubscriptions: subs };
}

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
  /** The build this instance is running, when it reported one. */
  buildRevision: string | null;
  /** Queues this instance subscribes to, when it reported them. */
  queueSubscriptions: ReadonlyArray<string>;
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
  const staleAfterSeconds = resolveStaleAfterSeconds(options?.staleAfterSeconds);
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
      buildRevision: meta(r.metadataJson).buildRevision,
      queueSubscriptions: meta(r.metadataJson).queueSubscriptions,
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

// ---------------------------------------------------------------------------
// THE CANONICAL PROJECTION
//
// `getWorkerFleetLiveness` answers the question. This turns that one answer
// into the shape every Admin surface renders, so Overview, Platform Health,
// Observability, Runtime and Operations cannot reach different verdicts about
// the same fleet at the same instant — which is what happened when one read
// the heartbeat, one read queue depth, and one read a reviewer-reconcile audit
// row and all three called their answer "workers".
//
// The four states are deliberately the four the heartbeat can justify:
//
//   HEALTHY       at least one instance reported inside the window.
//   STALE         instances exist and every one is outside it. Carries the
//                 LAST REAL count and timestamp, because "3 workers, 11
//                 minutes ago" is actionable and "0 workers" is a lie.
//   NOT_MEASURED  the store holds no heartbeat at all. Never STALE: there is
//                 no measurement to have gone stale.
//   UNAVAILABLE   the store could not be read. Never STALE and never HEALTHY:
//                 a failure to ask is not an answer.
// ---------------------------------------------------------------------------

export type WorkerFleetHealthState =
  | "HEALTHY"
  | "STALE"
  | "NOT_MEASURED"
  | "UNAVAILABLE";

export type WorkerFleetHealth = {
  state: WorkerFleetHealthState;
  reason: string;
  /** `null` only when the state is HEALTHY. */
  operatorAction: string | null;
  /** The last real heartbeat, preserved through STALE. */
  lastHeartbeatAtUtc: string | null;
  /** Its age at the evaluated instant, preserved through STALE. */
  lastHeartbeatAgeSeconds: number | null;
  liveInstances: number;
  staleInstances: number;
  knownInstances: number;
  staleAfterSeconds: number;
  heartbeatIntervalSeconds: number;
  evaluatedAtUtc: string;
  instances: ReadonlyArray<WorkerInstanceLiveness>;
  /**
   * The metric every card renders. Its state mirrors the fleet state one for
   * one, so a surface cannot paint a green badge over a stale fleet by
   * consulting a different field.
   */
  metric: Metric<number>;
};

export async function getWorkerFleetHealth(options?: {
  nowMs?: number;
  staleAfterSeconds?: number;
}): Promise<WorkerFleetHealth> {
  const fleet = await getWorkerFleetLiveness(options);
  const newest = fleet.instances[0] ?? null;

  const base = {
    reason: fleet.reason,
    lastHeartbeatAtUtc: fleet.newestHeartbeatAtUtc,
    lastHeartbeatAgeSeconds: newest?.ageSeconds ?? null,
    liveInstances: fleet.liveInstances,
    staleInstances: fleet.staleInstances,
    knownInstances: fleet.instances.length,
    staleAfterSeconds: fleet.staleAfterSeconds,
    heartbeatIntervalSeconds: WORKER_HEARTBEAT_INTERVAL_SECONDS,
    evaluatedAtUtc: fleet.evaluatedAtUtc,
    instances: fleet.instances,
  };

  switch (fleet.state) {
    case "LIVE":
      return {
        ...base,
        state: "HEALTHY",
        operatorAction: null,
        metric: metricValue(fleet.liveInstances),
      };

    case "STALE":
      return {
        ...base,
        state: "STALE",
        operatorAction:
          "Confirm the worker deployment is running and can reach Postgres. " +
          "Its last heartbeat and age are recorded above — treat the counts as that old.",
        // The value is the fleet size we last had evidence for, not zero.
        metric: metricStale(
          fleet.instances.length,
          {
            measuredAtUtc:
              fleet.newestHeartbeatAtUtc ?? fleet.evaluatedAtUtc,
            maxAgeSeconds: fleet.staleAfterSeconds,
          },
          fleet.reason,
        ),
      };

    case "NO_HEARTBEAT":
      return {
        ...base,
        state: "NOT_MEASURED",
        operatorAction:
          "No worker has ever reported. Confirm a worker is deployed and that its telemetry sampler is enabled.",
        metric: metricNotMeasured(fleet.reason),
      };

    case "UNKNOWN":
    default:
      return {
        ...base,
        state: "UNAVAILABLE",
        operatorAction:
          "The heartbeat store could not be read. Check Postgres reachability from the API process before drawing any conclusion about the workers.",
        metric: metricError(fleet.reason),
      };
  }
}
