/* eslint-disable @typescript-eslint/no-explicit-any -- a stateful Prisma double. */
/**
 * WS-SCHED / PRO-WZ-02 — the legal-hold custody sweep visits EVERY hold.
 *
 * At base the sweep read the 200 most recently updated holds every run, so the
 * oldest hold behind 299 newer ones was never examined and records added under
 * it never received their hold custody event. Now the sweep pages holds by a
 * durable id cursor. The double records which holds the coverage query was
 * asked about.
 */
import { describe, expect, it } from "vitest";

import { reconcileLegalHoldCustody } from "@proovra/shared-runtime";

function harness(total: number) {
  const holds = Array.from({ length: total }, (_, i) => ({
    id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    teamId: "t",
    scope: "WORKSPACE",
    evidenceId: null,
    caseId: null,
    status: "RELEASED",
    title: "h",
    placedByUserId: "u",
    releasedByUserId: "u",
    historical: false,
    // The OLDEST hold (index 0) is the least recently updated.
    updatedAt: new Date(Date.now() - (total - i) * 60_000),
  }));
  const visited = new Set<string>();
  const cursors = new Map<string, string | null>();
  const client = {
    evidenceLegalHold: {
      findMany: async (args: any) => {
        let out = holds.filter((h) => !args.where.id?.gt || h.id > args.where.id.gt);
        const [field, dir] = Object.entries(args.orderBy)[0] as [string, string];
        out = [...out].sort((a: any, b: any) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === "desc" ? -1 : 1));
        return out.slice(0, args.take);
      },
    },
    workerSweepCursor: {
      findUnique: async (args: any) => (cursors.has(args.where.key) ? { cursorId: cursors.get(args.where.key) } : null),
      upsert: async (args: any) => {
        cursors.set(args.where.key, args.update.cursorId);
        return {};
      },
    },
    $queryRaw: async (_strings: TemplateStringsArray, ...values: any[]) => {
      const text = JSON.stringify(values);
      for (const h of holds) if (text.includes(h.id)) visited.add(h.id);
      return [];
    },
    $transaction: async (fn: any) => fn(client),
  };
  return { client, visited, oldest: holds[0]!.id };
}

describe("legal-hold custody sweep coverage (PRO-WZ-02)", () => {
  it("with 300 holds the least recently updated one is visited within two runs", async () => {
    const { client, visited, oldest } = harness(300);
    await reconcileLegalHoldCustody(client as never, { maxHolds: 200 });
    await reconcileLegalHoldCustody(client as never, { maxHolds: 200 });
    expect(visited.has(oldest)).toBe(true);
    expect(visited.size).toBe(300);
  });
});
