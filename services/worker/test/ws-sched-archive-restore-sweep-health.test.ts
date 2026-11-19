/**
 * WS-SCHED / PRO-P3DZ-04 — the retention-archive restore tick runs under the
 * reconciliation-run authority: a tick with work, and an idle heartbeat, leave
 * a run row the platform health snapshot can read; idle ticks in between
 * write nothing; and a database that cannot record the run (the enum value not
 * migrated yet) never stops a restore.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  due: 0,
  countThrows: false,
  createThrows: null as Error | null,
  runs: [] as Array<{ id: string; kind: string; status: string; errorSummary?: string | null }>,
  processed: 0,
}));

vi.mock("../src/db.js", () => {
  const run = {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async (args: { data: { kind: string } }) => {
      if (s.createThrows) throw s.createThrows;
      const row = { id: `run-${s.runs.length + 1}`, kind: args.data.kind, status: "RUNNING" };
      s.runs.push(row);
      return { id: row.id };
    }),
    update: vi.fn(async (args: { where: { id: string }; data: { status?: string; errorSummary?: string | null } }) => {
      const row = s.runs.find((r) => r.id === args.where.id)!;
      if (args.data.status) row.status = String(args.data.status);
      row.errorSummary = args.data.errorSummary ?? null;
      return row;
    }),
    updateMany: vi.fn(async (args: { where: { id?: string }; data: { status?: string; errorSummary?: string | null } }) => {
      const row = s.runs.find((r) => r.id === args.where.id);
      if (!row) return { count: 0 };
      if (args.data.status) row.status = String(args.data.status);
      row.errorSummary = args.data.errorSummary ?? null;
      return { count: 1 };
    }),
  };
  const req = {
    count: vi.fn(async () => {
      if (s.countThrows) throw new Error("requests unreadable");
      return s.due;
    }),
    findMany: vi.fn(async () => {
      if (s.countThrows) throw new Error("requests unreadable");
      s.processed += 1;
      return [];
    }),
  };
  return { prisma: { governanceReconciliationRun: run, evidenceArchiveRestoreRequest: req } };
});
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  __resetArchiveRestoreSweepHeartbeat,
  runArchiveRestoreSweep,
} from "../src/governance/archive-restore.js";

describe("retention-archive restore sweep leaves a run history (PRO-P3DZ-04)", () => {
  beforeEach(() => {
    s.due = 0;
    s.countThrows = false;
    s.createThrows = null;
    s.runs.length = 0;
    s.processed = 0;
    __resetArchiveRestoreSweepHeartbeat();
  });

  it("the first tick records an ARCHIVE_RESTORE run; idle ticks inside the heartbeat record nothing", async () => {
    expect((await runArchiveRestoreSweep()).recorded).toBe(true);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ kind: "ARCHIVE_RESTORE", status: "SUCCEEDED" });
    for (let i = 0; i < 5; i += 1) expect((await runArchiveRestoreSweep()).recorded).toBe(false);
    expect(s.runs).toHaveLength(1);
    expect(s.processed).toBe(1);
  });

  it("a tick with work is always recorded, heartbeat or not", async () => {
    await runArchiveRestoreSweep();
    s.due = 2;
    expect((await runArchiveRestoreSweep()).recorded).toBe(true);
    expect(s.runs).toHaveLength(2);
  });

  it("a tick that cannot read its requests is recorded as a FAILED run with the error, and reported to the scheduler", async () => {
    s.countThrows = true;
    await expect(runArchiveRestoreSweep()).rejects.toThrow(/requests unreadable/);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]!.status).toBe("FAILED");
    expect(String(s.runs[0]!.errorSummary)).toMatch(/requests unreadable/);
  });

  it("a database that cannot record the run does not stop the restore", async () => {
    s.due = 1;
    s.createThrows = new Error('invalid input value for enum "GovernanceReconciliationKind": "ARCHIVE_RESTORE"');
    const out = await runArchiveRestoreSweep();
    expect(out.recorded).toBe(false);
    expect(s.processed).toBe(1);
    expect(s.runs).toHaveLength(0);
  });
});
