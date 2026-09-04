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
 * The first repair pointed this at the durable heartbeat history. That was
 * right about the source and wrong about its shape: the history is
 * append-only, so the read was "newest 200 rows, deduplicated in memory",
 * which drops instances out of a large fleet and cannot express a clean
 * shutdown at all.
 *
 * =============================================================================
 * THE AUTHORITY IS NOW A CURRENT-STATE LEASE
 * =============================================================================
 * `worker_leases` holds ONE row per instance, upserted on every heartbeat and
 * updated in place. The worker writes its own lifecycle into it — STARTING,
 * LIVE, DRAINING, STOPPED — and this module derives the fleet verdict:
 *
 *   LIVE          a LIVE lease inside the freshness window.
 *   STALE         a LIVE lease outside it with NO stop marker. The worker
 *                 stopped without saying so, which is a crash.
 *   STOPPED       every instance recorded a clean shutdown. Not live, and
 *                 explicitly NOT stale: nothing about it is unexplained.
 *   STARTING      registered, first heartbeat not yet landed. Never live.
 *   NO_HEARTBEAT  no lease has ever been written.
 *   UNKNOWN       the lease store could not be read. A failure to ask is not
 *                 an answer.
 *
 * STALE is DERIVED, never stored, and the derivation turns on the stop
 * marker rather than on age alone. A crash cannot write a marker, which is
 * precisely what makes its absence evidence — and why a drained worker leaves
 * the live set the instant it drains rather than after the threshold.
 *
 * `NO_HEARTBEAT` is deliberately distinct from `UNKNOWN`: "no worker has ever
 * reported" and "we could not reach the table" lead an operator to different
 * places, and collapsing them is how an outage hides inside a fresh install.
 */

import { prisma } from "../../db.js";
import {
  metricError,
  metricNotApplicable,
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


/** The lease states a worker writes about itself. */
export type WorkerLeaseStateWord = "STARTING" | "LIVE" | "DRAINING" | "STOPPED";

export type WorkerLivenessState =
  | "LIVE"
  | "STALE"
  /** Every instance shut down cleanly. Explained, therefore not stale. */
  | "STOPPED"
  /** Registered, no first heartbeat yet. Never counted as live. */
  | "STARTING"
  | "NO_HEARTBEAT"
  | "UNKNOWN";

export type WorkerInstanceLiveness = {
  workerId: string;
  workerKind: string;
  /** The worker's own last self-reported status, not our verdict. */
  reportedStatus: string;
  /** The lease state this instance wrote about itself. */
  leaseState: WorkerLeaseStateWord;
  /** Set only by a clean shutdown; its absence is what makes a lease stale. */
  stoppedAtUtc: string | null;
  shutdownReason: string | null;
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
  /** LIVE leases past the window with NO stop marker: crashes. */
  staleInstances: number;
  /** Instances that recorded a clean drain or stop. */
  stoppedInstances: number;
  instances: ReadonlyArray<WorkerInstanceLiveness>;
  /** The freshness rule this verdict was reached under. */
  staleAfterSeconds: number;
  /** The most recent heartbeat of any instance, live or not. */
  newestHeartbeatAtUtc: string | null;
};

/**
 * The fleet's liveness, read from the CURRENT-STATE lease table.
 *
 * This used to scan the append-only heartbeat history — newest 200 rows,
 * deduplicated by worker id in memory. That answered the question badly in
 * two ways beyond its cost: the 200-row cap silently dropped instances out of
 * a busy fleet, and the history has no way to record a clean shutdown, so a
 * drained worker was indistinguishable from a killed one.
 *
 * `nowMs` is injected so a test can age a lease without sleeping, and so
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
    stoppedInstances: 0,
    instances: [],
    staleAfterSeconds,
    newestHeartbeatAtUtc: null,
  };

  let leases;
  try {
    // One row per instance, so there is no cap to fall off the end of and no
    // deduplication to get wrong.
    leases = await prisma.workerLease.findMany({
      orderBy: { lastSeenAtUtc: "desc" },
    });
  } catch {
    return {
      ...base,
      state: "UNKNOWN",
      reason:
        "The worker lease store could not be read, so worker liveness is unknown. This is not a statement that workers are healthy.",
    };
  }

  if (leases.length === 0) {
    return {
      ...base,
      state: "NO_HEARTBEAT",
      reason:
        "No worker has ever registered a lease. An empty queue is not evidence that a worker is running.",
    };
  }

  const instances: WorkerInstanceLiveness[] = [];
  let newestMs = -Infinity;
  for (const r of leases) {
    const seenMs = r.lastSeenAtUtc.getTime();
    const ageSeconds = Math.max(0, Math.round((nowMs - seenMs) / 1000));
    newestMs = Math.max(newestMs, seenMs);
    /*
     * ONLY A LIVE LEASE INSIDE THE WINDOW COUNTS.
     *
     * STARTING has never proved anything. DRAINING and STOPPED have said
     * they are going — counting either would keep a deliberately removed
     * worker in the fleet for the length of the stale threshold, which is
     * the exact defect the lease exists to fix.
     */
    instances.push({
      workerId: r.workerId,
      workerKind: String(r.workerKind),
      reportedStatus: String(r.state),
      leaseState: r.state as WorkerLeaseStateWord,
      heartbeatAtUtc: r.lastSeenAtUtc.toISOString(),
      ageSeconds,
      live: r.state === "LIVE" && ageSeconds <= staleAfterSeconds,
      stoppedAtUtc: r.stoppedAtUtc?.toISOString() ?? null,
      shutdownReason: r.shutdownReason ?? null,
      processedCount: r.processedCount ?? null,
      failedCount: r.failedCount ?? null,
      buildRevision: r.buildRevision ?? null,
      queueSubscriptions: r.queueSubscriptions ?? [],
    });
  }
  instances.sort((a, b) => a.ageSeconds - b.ageSeconds);

  const liveInstances = instances.filter((i) => i.live).length;
  /*
   * STALE IS DERIVED, AND ONLY FROM A MISSING SHUTDOWN MARKER.
   *
   * A lease still claiming LIVE whose heartbeat has aged out, with no
   * stop marker, means the process went away without saying so. That is a
   * crash. A lease that reached DRAINING or STOPPED said goodbye, and is
   * simply not live — no amount of ageing makes it stale, because nothing
   * about it is unexplained.
   */
  const staleInstances = instances.filter(
    (i) => i.leaseState === "LIVE" && !i.live && i.stoppedAtUtc === null,
  ).length;
  const stoppedInstances = instances.filter(
    (i) => i.leaseState === "STOPPED" || i.leaseState === "DRAINING",
  ).length;
  const newestHeartbeatAtUtc =
    newestMs === -Infinity ? null : new Date(newestMs).toISOString();

  if (liveInstances === 0 && staleInstances > 0) {
    const oldest = instances.find((i) => i.leaseState === "LIVE" && !i.live);
    return {
      ...base,
      state: "STALE",
      reason:
        `No worker has reported within ${staleAfterSeconds}s and none recorded a shutdown. ` +
        `The newest heartbeat is ${oldest?.ageSeconds ?? "?"}s old, so the fleet stopped without saying so.`,
      staleInstances,
      stoppedInstances,
      instances,
      newestHeartbeatAtUtc,
    };
  }

  if (liveInstances === 0) {
    /*
     * Every instance shut down cleanly, or none has started yet. Neither is
     * STALE: there is nothing unexplained. It is also emphatically not
     * healthy — there is no worker running.
     */
    const allStopped = stoppedInstances > 0;
    return {
      ...base,
      state: allStopped ? "STOPPED" : "STARTING",
      reason: allStopped
        ? `Every worker instance shut down cleanly (${stoppedInstances} recorded a stop marker). No worker is running.`
        : "A worker has registered but has not yet completed its first heartbeat, so it is not confirmed running.",
      staleInstances,
      stoppedInstances,
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
    stoppedInstances,
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
  /** Every instance shut down cleanly. Explained, so never STALE. */
  | "STOPPED"
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
  /** LIVE leases past the window with no stop marker: crashes. */
  staleInstances: number;
  /** Instances that recorded a clean drain or stop. */
  stoppedInstances: number;
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
    stoppedInstances: fleet.stoppedInstances,
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

    case "STOPPED":
      return {
        ...base,
        state: "STOPPED",
        operatorAction:
          "Every instance recorded a clean shutdown. If workers are meant to be running, start the deployment; nothing here indicates a fault.",
        // A clean stop is not a measurement of a live fleet, and it is not a
        // failure either. NOT_APPLICABLE says exactly that: there is no live
        // fleet to count, on purpose.
        metric: metricNotApplicable(fleet.reason),
      };

    case "STARTING":
      return {
        ...base,
        state: "NOT_MEASURED",
        operatorAction:
          "A worker registered but has not completed its first heartbeat. Wait one interval, then check the worker logs.",
        metric: metricNotMeasured(fleet.reason),
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
