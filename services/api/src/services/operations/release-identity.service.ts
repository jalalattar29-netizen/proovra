/**
 * WHAT IS RUNNING (OPS-015, OPS-010). The images carry their commit in
 * APP_RELEASE_SHA, and each worker renews a lease stating the same value. Nothing
 * reported them together, so version alignment could not be established at all.
 *
 * The web build is not here: it deploys through Vercel, and this process has no
 * authoritative view of it. Its commit is at the web's /api/health, and
 * scripts/deploy-prod-pull.sh records all three on every deploy.
 */
import type { PrismaClient } from "@prisma/client";
import { PRESENTATION_CONTRACT_VERSION } from "@proovra/shared";

const LIVE_WINDOW_MS = 5 * 60 * 1000;

export type ReleaseIdentity = {
  api: { revision: string | null; contract: number };
  workers: Array<{ workerId: string; revision: string | null; lastSeenAtUtc: string }>;
  /** False when a live worker runs another build, or a build cannot be stated. */
  aligned: boolean;
};

export async function readReleaseIdentity(client: PrismaClient): Promise<ReleaseIdentity> {
  const revision = (process.env.APP_RELEASE_SHA ?? "").trim() || null;
  const leases = await client.workerLease.findMany({
    where: {
      stoppedAtUtc: null,
      lastSeenAtUtc: { gte: new Date(Date.now() - LIVE_WINDOW_MS) },
    },
    select: { workerId: true, buildRevision: true, lastSeenAtUtc: true },
    orderBy: { lastSeenAtUtc: "desc" },
    take: 50,
  });
  const workers = leases.map((l) => ({
    workerId: l.workerId,
    revision: l.buildRevision,
    lastSeenAtUtc: l.lastSeenAtUtc.toISOString(),
  }));
  return {
    api: { revision, contract: PRESENTATION_CONTRACT_VERSION },
    workers,
    aligned: revision !== null && workers.length > 0 && workers.every((w) => w.revision === revision),
  };
}
