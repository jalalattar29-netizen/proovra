/**
 * WS-SCHED / PRO-E1C-04 — a retention-archive restore that keeps throwing an
 * unexpected error reaches a terminal state after the attempt ceiling.
 *
 * At base only STORAGE_UNAVAILABLE consulted ARCHIVE_RESTORE_MAX_ATTEMPTS; any
 * other exception was logged and the RUNNING row was re-claimed every lease,
 * forever, while the owner saw "Restore in progress" and could not ask again.
 * The real sweep runs here against a stateful double of the request row; the
 * unexpected error is a database failure while reading the record.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  row: {
    id: "11111111-1111-4111-8111-111111111111",
    evidenceId: "22222222-2222-4222-8222-222222222222",
    teamId: "33333333-3333-4333-8333-333333333333",
    requestedByUserId: "44444444-4444-4444-8444-444444444444",
    status: "REQUESTED" as string,
    attemptCount: 0,
    leaseUntilUtc: null as Date | null,
    startedAtUtc: null as Date | null,
    failureCode: null as string | null,
  },
  custody: [] as string[],
}));

vi.mock("../src/db.js", () => {
  const req = {
    findMany: vi.fn(async () => (["REQUESTED", "RUNNING"].includes(s.row.status) ? [{ id: s.row.id }] : [])),
    findUnique: vi.fn(async () => ({ ...s.row })),
    findUniqueOrThrow: vi.fn(async () => ({ ...s.row })),
    updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose stub of the Prisma delegate
      const data = args.data as Record<string, any>;
      if (data.status === "RUNNING") {
        if (!(s.row.status === "REQUESTED" || s.row.status === "RUNNING")) return { count: 0 };
        s.row.status = "RUNNING";
        s.row.attemptCount += 1;
        s.row.leaseUntilUtc = data.leaseUntilUtc;
        return { count: 1 };
      }
      if (data.status === "FAILED") {
        if (s.row.status !== "RUNNING") return { count: 0 };
        s.row.status = "FAILED";
        s.row.failureCode = data.failureCode;
        return { count: 1 };
      }
      return { count: 0 };
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose stub of the Prisma delegate
  const prisma: Record<string, any> = {
    evidenceArchiveRestoreRequest: req,
    evidence: {
      findUnique: vi.fn(async () => {
        throw new Error("simulated database failure");
      }),
    },
  };
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});

vi.mock("@proovra/shared-runtime", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  appendCustodyEventTx: vi.fn(async (_tx: unknown, input: { eventType: string }) => {
    s.custody.push(input.eventType);
  }),
}));

import { ARCHIVE_RESTORE_MAX_ATTEMPTS, processArchiveRestoreRequests } from "../src/governance/archive-restore.js";

beforeEach(() => {
  Object.assign(s.row, { status: "REQUESTED", attemptCount: 0, leaseUntilUtc: null, failureCode: null });
  s.custody.length = 0;
});

describe("archive restore attempt ceiling (PRO-E1C-04)", () => {
  it("a persistent unexpected error ends FAILED INTERNAL_ERROR after the ceiling, with a custody failure event", async () => {
    let t = Date.now();
    for (let i = 0; i < ARCHIVE_RESTORE_MAX_ATTEMPTS + 2; i += 1) {
      // Each tick runs after the previous lease lapsed.
      t += 16 * 60_000;
      await processArchiveRestoreRequests({ now: new Date(t) });
    }
    expect(s.row.status).toBe("FAILED");
    expect(s.row.failureCode).toBe("INTERNAL_ERROR");
    expect(s.row.attemptCount).toBe(ARCHIVE_RESTORE_MAX_ATTEMPTS);
    expect(s.custody).toEqual(["ARCHIVE_RESTORE_FAILED"]);
  });

  it("below the ceiling the request stays retryable (a transient error may still succeed later)", async () => {
    await processArchiveRestoreRequests({ now: new Date() });
    expect(s.row.status).toBe("RUNNING");
    expect(s.row.attemptCount).toBe(1);
  });
});
