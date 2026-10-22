/**
 * What an ISOLATED TEST STACK reports about itself on /health.
 *
 * `null` for every other process, so a deployed API exposes nothing new and
 * performs no extra query. In a test stack the report is the evidence an E2E
 * run checks before EVERY account it creates (e2e/helpers/stack-isolation.ts):
 * the API's own isolation facts, and those of every LIVE worker — because the
 * worker sends email too, and a worker started without a marker would not be
 * isolated however well the API is. Variable NAMES only — never a value.
 */
import { buildIsolationFacts, type IsolationFacts } from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { getEnvFileLoad } from "../env.js";
import { getWorkerFleetLiveness } from "../services/operations/worker-liveness.service.js";

export type WorkerIsolation = {
  workerId: string;
  /** What the worker's latest heartbeat said; null when it reported nothing (not a test stack). */
  isolation: IsolationFacts | null;
};

export type TestStackIsolationReport = IsolationFacts & {
  /** Every LIVE worker (lease LIVE inside the freshness window), as the worker itself reported. */
  workers: WorkerIsolation[];
};

/** The live workers and the isolation each one put in its most recent heartbeat. */
export async function readLiveWorkerIsolation(): Promise<WorkerIsolation[]> {
  const fleet = await getWorkerFleetLiveness();
  const live = fleet.instances.filter((instance) => instance.live);
  return Promise.all(
    live.map(async ({ workerId }) => {
      const latest = await prisma.workerTelemetrySnapshot.findFirst({
        where: { workerId },
        orderBy: { heartbeatAtUtc: "desc" },
        select: { metadataJson: true },
      });
      const meta = (latest?.metadataJson ?? null) as { isolation?: IsolationFacts } | null;
      return { workerId, isolation: meta?.isolation ?? null };
    }),
  );
}

export async function buildTestStackIsolationReport(
  env: Record<string, string | undefined> = process.env,
  deps: { liveWorkers: () => Promise<WorkerIsolation[]> } = { liveWorkers: readLiveWorkerIsolation },
): Promise<TestStackIsolationReport | null> {
  const facts = buildIsolationFacts({ env, envFilesLoaded: getEnvFileLoad().loaded.length });
  if (!facts) return null;
  return { ...facts, workers: await deps.liveWorkers() };
}
