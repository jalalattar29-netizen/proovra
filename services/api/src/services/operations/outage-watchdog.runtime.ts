/**
 * The outage watchdog's production wiring (outage-watchdog.service.ts holds the
 * detectors and the dispatch logic, and is what the tests drive).
 *
 * Reads: worker_leases (getWorkerFleetHealth), BullMQ counts
 * (getQueueInventory), governance_reconciliation_runs and
 * platform_backup_records (Prisma), and the worker's boot records in the shared
 * Redis (the queue-inventory connection, REDIS_URL). Sends through
 * dispatchOpsAlert. Called by the platform maintenance sweep under its lease.
 */
import { prisma } from "../../db.js";
import { dispatchOpsAlert } from "../alerts/alert.service.js";
import { getQueueHandle, getQueueInventory } from "./queue-inventory.service.js";
import { KNOWN_QUEUE_NAMES } from "./queue-replay-safety.service.js";
import { getWorkerFleetHealth } from "./worker-liveness.service.js";
import {
  readOutageFacts,
  readOutageWatchdogConfig,
  redisWatchdogState,
  runOutageWatchdog,
  type OutageWatchdogSummary,
  type WatchdogRedis,
} from "./outage-watchdog.service.js";

type Logger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
};

async function sharedRedis(): Promise<WatchdogRedis | null> {
  try {
    const name = KNOWN_QUEUE_NAMES[0];
    const q = name ? getQueueHandle(name) : null;
    return q ? ((await q.client) as unknown as WatchdogRedis) : null;
  } catch {
    return null;
  }
}

export async function runOutageWatchdogNow(logger?: Logger): Promise<OutageWatchdogSummary> {
  const config = readOutageWatchdogConfig();
  const redis = await sharedRedis();
  return runOutageWatchdog({
    config,
    logger,
    dispatch: dispatchOpsAlert,
    ...redisWatchdogState(redis),
    readFacts: () =>
      readOutageFacts({
        prisma: prisma as never,
        redis,
        config,
        readFleet: async () => {
          const h = await getWorkerFleetHealth();
          return {
            state: h.state,
            liveInstances: h.liveInstances,
            lastHeartbeatAgeSeconds: h.lastHeartbeatAgeSeconds,
            reason: h.reason,
          };
        },
        readQueues: async () =>
          (await getQueueInventory()).map((q) => ({
            queueName: q.queueName,
            waiting: q.counts.waiting,
            oldestWaitingAgeMs: q.oldestWaitingAgeMs,
            isWorkQueue: q.role !== "DEAD_LETTER" && q.health !== "disabled" && q.health !== "unconfigured",
          })),
      }),
  });
}
