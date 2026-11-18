/**
 * WS-SCHED / PRO-W1C-08 — a combined-recording attempt renews its run lease
 * between stages, fenced on the claim generation, and learns when it has lost
 * the claim (so it never records a derived row from a stale attempt).
 */
import { describe, expect, it } from "vitest";

import { renewRunLease } from "@proovra/shared-runtime/media-intelligence";

function fakeClient(row: { status: string; attempt_count: number }) {
  const calls: unknown[][] = [];
  return {
    calls,
    client: {
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push([sql, ...args]);
        const [, , fence] = args as [string, string, number];
        return row.status === "PROCESSING" && row.attempt_count === fence ? 1 : 0;
      },
    },
  };
}

describe("renewRunLease (PRO-W1C-08)", () => {
  it("the current claim holder renews; the SQL is fenced on status PROCESSING and attempt_count", async () => {
    const { client, calls } = fakeClient({ status: "PROCESSING", attempt_count: 2 });
    expect(await renewRunLease("run", "team", 2, client as never)).toEqual({ held: true });
    const sql = String(calls[0]![0]);
    expect(sql).toMatch(/"started_at_utc" = NOW\(\)/);
    expect(sql).toMatch(/"status" = 'PROCESSING'/);
    expect(sql).toMatch(/"attempt_count" = \$3::int/);
  });

  it("a stale attempt (taken over: attempt_count moved on) is told it lost the claim", async () => {
    const { client } = fakeClient({ status: "PROCESSING", attempt_count: 3 });
    expect(await renewRunLease("run", "team", 2, client as never)).toEqual({ held: false });
  });

  it("a settled run is not renewed, and a tracker failure reads as lost (fail closed)", async () => {
    const { client } = fakeClient({ status: "COMPLETED", attempt_count: 2 });
    expect(await renewRunLease("run", "team", 2, client as never)).toEqual({ held: false });
    const broken = { $executeRawUnsafe: async () => { throw new Error("db down"); } };
    expect(await renewRunLease("run", "team", 2, broken as never)).toEqual({ held: false });
  });
});
