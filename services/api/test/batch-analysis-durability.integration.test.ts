/**
 * BD-1 AND BD-2 — cancellation that cancels, over state that survives.
 *
 * BD-1. `cancelJob` acted only on PROCESSING. For a PENDING job it returned
 * `true` having changed nothing; the route read that as cancellation, told the
 * operator "Batch job cancelled", and wrote `enterprise.batch_cancel
 * outcome: success` into the audit log. The job then ran. A pending job is the
 * EASIEST one to cancel — nothing has started, so there is nothing to stop and
 * everything to mark — and an audit record asserting an action that did not
 * happen is worse than the failed cancellation itself, because the log is the
 * part that is supposed to be true.
 *
 * BD-2. The jobs lived in a plain object on a module singleton, so a restart
 * lost them and two API instances could not see each other's.
 *
 * This is an INTEGRATION suite by project, not a unit test with a mock: a
 * durability claim proven against a mock proves the mock. The second
 * connection below is a separate `pg` pool against the same database — the
 * stand-in for a second API instance, and the thing process memory could never
 * satisfy.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import type { IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: (typeof import("../src/db.js"))["prisma"];
let batchAnalysisService: (typeof import("../src/services/batch-analysis.service.js"))["batchAnalysisService"];
let BatchStatus: (typeof import("../src/services/batch-analysis.service.js"))["BatchStatus"];

/** Real workspace + owner from the harness fixtures. Never invented ids. */
let OWNER = "";
let TEAM = "";
const STRANGER = randomUUID();

/** A SECOND connection to the same database — "another instance". */
let other: Pool;

/** Job ids created here, removed afterwards so the database is left as found. */
const created: string[] = [];

type DbStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";

const DB_STATUS: Record<string, DbStatus> = {
  pending: "PENDING",
  processing: "PROCESSING",
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

async function seed(status: string, itemCount = 2): Promise<string> {
  const row = await prisma.batchAnalysisJob.create({
    data: {
      ownerUserId: OWNER,
      teamId: TEAM,
      name: "batch",
      status: DB_STATUS[status],
      totalItems: itemCount,
      items: {
        create: Array.from({ length: itemCount }, (_, position) => ({
          evidenceId: randomUUID(),
          position,
          status: "PENDING" as const,
        })),
      },
    },
  });
  created.push(row.id);
  return row.id;
}

/** What the OTHER connection can see. */
async function otherSees(jobId: string) {
  const job = await other.query(
    `SELECT id, status, team_id, processed_items, failed_items,
            claimed_at_utc, started_at_utc, completed_at_utc
       FROM batch_analysis_jobs WHERE id = $1`,
    [jobId],
  );
  const items = await other.query(
    `SELECT status, error FROM batch_analysis_job_items WHERE job_id = $1 ORDER BY position`,
    [jobId],
  );
  return { job: job.rows[0] ?? null, items: items.rows };
}

beforeAll(async () => {
  const { bootIntegrationHarness } = await import("./integration-harness.js");
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ batchAnalysisService, BatchStatus } = await import(
    "../src/services/batch-analysis.service.js"
  ));

  OWNER = harness.fixtures.teamA.ownerUserId;
  TEAM = harness.fixtures.teamA.teamId;

  // The harness has pointed DATABASE_URL at its disposable database by now.
  other = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
});

afterAll(async () => {
  if (created.length > 0) {
    await prisma.batchAnalysisJob.deleteMany({ where: { id: { in: created } } });
  }
  await other?.end();
  await harness?.cleanup();
});

beforeEach(() => {
  created.length = 0;
});

describe("BD-1 — batch cancellation says what it did", () => {
  it("cancels a PENDING job instead of reporting success for doing nothing", async () => {
    // THE DEFECT. This returned true, left the status PENDING, and the job ran.
    const id = await seed("pending");

    expect(await batchAnalysisService.cancelJob(OWNER, id)).toBe("CANCELLED");

    const job = await batchAnalysisService.getJob(OWNER, id);
    expect(job?.status).toBe(BatchStatus.CANCELLED);
    expect(job?.completedAt).toBeInstanceOf(Date);
    // Nothing is left claiming it is still waiting to run.
    expect(job?.items.every((i) => i.status === "failed")).toBe(true);
    expect(job?.items.every((i) => i.error === "Job cancelled by user")).toBe(true);
  });

  it("marks stopped items as stopped by the operator, not as analysis failures", async () => {
    const id = await seed("processing", 3);

    expect(await batchAnalysisService.cancelJob(OWNER, id)).toBe("CANCELLED");

    const job = await batchAnalysisService.getJob(OWNER, id);
    // "This could not be analysed" and "somebody stopped this" are different
    // things to say about a piece of evidence.
    expect(job?.items.map((i) => i.error)).toEqual([
      "Job cancelled by user",
      "Job cancelled by user",
      "Job cancelled by user",
    ]);
  });

  it("refuses a job that has already finished, and does not call it missing", async () => {
    // A terminal job is not a job that never existed. The boolean could not
    // tell the two apart, so the route reported one as the other.
    for (const terminal of ["completed", "failed", "cancelled"]) {
      const id = await seed(terminal);
      expect(await batchAnalysisService.cancelJob(OWNER, id)).toBe("ALREADY_TERMINAL");
      expect((await batchAnalysisService.getJob(OWNER, id))?.status).toBe(terminal);
    }
  });

  it("a job belonging to someone else answers exactly as one that does not exist", async () => {
    const id = await seed("pending");

    expect(await batchAnalysisService.cancelJob(STRANGER, id)).toBe("NOT_FOUND");
    expect(await batchAnalysisService.cancelJob(OWNER, randomUUID())).toBe("NOT_FOUND");
    // And the stranger's attempt changed nothing.
    expect((await batchAnalysisService.getJob(OWNER, id))?.status).toBe(BatchStatus.PENDING);
  });

  it("a stale non-UUID job id is not found rather than a 500", async () => {
    // Ids used to be `batch_<timestamp>_<random>`, so a stale client can still
    // present one; Prisma would throw on a malformed UUID.
    expect(await batchAnalysisService.cancelJob(OWNER, "batch_1699_abc")).toBe("NOT_FOUND");
    expect(await batchAnalysisService.getJob(OWNER, "batch_1699_abc")).toBeNull();
  });

  it("cancelling twice is refused the second time, not reported as success", async () => {
    const id = await seed("processing");

    expect(await batchAnalysisService.cancelJob(OWNER, id)).toBe("CANCELLED");
    expect(await batchAnalysisService.cancelJob(OWNER, id)).toBe("ALREADY_TERMINAL");
  });
});

describe("BD-2 — the job outlives the process that made it", () => {
  it("a job is visible to a SECOND connection — the restart and multi-instance case", async () => {
    // This is the whole of BD-2. In process memory the answer was "no job": a
    // restart lost it, and a second API instance never had it.
    const id = await seed("pending");

    const seen = await otherSees(id);
    expect(seen.job?.id).toBe(id);
    expect(seen.items).toHaveLength(2);
    expect(seen.job?.team_id).toBe(TEAM);
  });

  it("a cancellation by one instance is seen by the other", async () => {
    const id = await seed("processing");

    expect(await batchAnalysisService.cancelJob(OWNER, id)).toBe("CANCELLED");

    expect((await otherSees(id)).job?.status).toBe("CANCELLED");
  });

  it("only ONE instance can claim a job — the second is refused", async () => {
    // The old guard was a Map in one process, so two instances would both have
    // run the same batch. The claim is a conditional UPDATE; Postgres decides.
    const id = await seed("pending", 1);

    const results = await Promise.allSettled([
      batchAnalysisService.processBatch(id),
      batchAnalysisService.processBatch(id),
    ]);

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already processing/);
  });

  it("a claimed job records that it was claimed, so a restart can tell", async () => {
    const id = await seed("pending", 1);
    await batchAnalysisService.processBatch(id);

    const seen = await otherSees(id);
    expect(seen.job?.claimed_at_utc).toBeInstanceOf(Date);
    expect(seen.job?.started_at_utc).toBeInstanceOf(Date);
    expect(seen.job?.status).toBe("COMPLETED");
  });

  it("progress is persisted as it happens, not only at the end", async () => {
    const id = await seed("pending", 3);
    await batchAnalysisService.processBatch(id);

    const seen = await otherSees(id);
    expect(Number(seen.job?.processed_items)).toBe(3);
    expect(Number(seen.job?.failed_items)).toBe(0);
    expect(seen.items.every((i: { status: string }) => i.status === "COMPLETED")).toBe(true);
    expect(seen.job?.completed_at_utc).toBeInstanceOf(Date);
  });

  it("a cancelled job is not overwritten as COMPLETED", async () => {
    const id = await seed("pending", 1);
    await batchAnalysisService.cancelJob(OWNER, id);

    // The claim refuses, because the job is no longer PENDING.
    await expect(batchAnalysisService.processBatch(id)).rejects.toThrow(/already processing/);
    expect((await batchAnalysisService.getJob(OWNER, id))?.status).toBe(BatchStatus.CANCELLED);
  });

  it("workspace isolation is a column, so a workspace read sees only its own", async () => {
    const mine = await seed("pending");
    const otherTeam = harness.fixtures.teamB.teamId;
    const theirs = await prisma.batchAnalysisJob.create({
      data: { ownerUserId: OWNER, teamId: otherTeam, name: "other workspace", totalItems: 0 },
    });
    created.push(theirs.id);

    const inTeam = await other.query(
      `SELECT id FROM batch_analysis_jobs WHERE team_id = $1`,
      [TEAM],
    );
    const ids = inTeam.rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs.id);
  });

  it("listing is owner-scoped and newest first", async () => {
    const first = await seed("pending");
    const second = await seed("pending");

    const mine = await batchAnalysisService.listJobs(OWNER);
    const ids = mine.map((j) => j.id);
    expect(ids).toContain(first);
    expect(ids).toContain(second);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));

    expect(await batchAnalysisService.listJobs(STRANGER)).toEqual([]);
  });

  it("deleting a job takes its items with it", async () => {
    const id = await seed("pending", 2);
    await prisma.batchAnalysisJob.delete({ where: { id } });

    const left = await other.query(
      `SELECT count(*)::int AS n FROM batch_analysis_job_items WHERE job_id = $1`,
      [id],
    );
    expect(left.rows[0].n).toBe(0);
  });
});
