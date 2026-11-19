/* eslint-disable @typescript-eslint/no-explicit-any -- a stateful Prisma double. */
/**
 * WS-SCHED / PRO-W2C2-06 â€” time-based automation detectors cover every
 * workspace with a rule, not just the platform's 100 oldest rows.
 *
 * At base REVIEW_OVERDUE read the 100 oldest overdue workflows across ALL
 * tenants (no cursor, no rule filter). 150 overdue workflows of a workspace
 * with NO rule, older than a ruled workspace's, filled the window every tick,
 * and the ruled workspace never got a run. Now the detector reads only
 * workspaces with an enabled rule and pages by a durable id cursor.
 * Driven against a stateful double that honours where / orderBy / take /
 * distinct and the sweep-cursor table.
 */
import { describe, expect, it } from "vitest";

import { detectTimeBasedAutomationTriggers } from "../src/services/automation/automation-triggers.js";

const NOISY = "aaaaaaaa-0000-4000-8000-000000000001";
const RULED = "bbbbbbbb-0000-4000-8000-000000000002";

function uuid(n: number, prefix: string) {
  return `${prefix}${String(n).padStart(4, "0")}-0000-4000-8000-000000000000`;
}

function harness() {
  const now = Date.now();
  const workflows = [
    ...Array.from({ length: 150 }, (_, i) => ({
      id: uuid(i, "1000"),
      teamId: NOISY,
      dueAt: new Date(now - 30 * 86_400_000 + i * 1000),
      status: "OPEN",
      priority: "NORMAL",
      closedAt: null,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      id: uuid(i, "9000"),
      teamId: RULED,
      dueAt: new Date(now - 86_400_000 + i * 1000),
      status: "OPEN",
      priority: "NORMAL",
      closedAt: null,
    })),
  ];
  const rules = [{ id: "rule-1", teamId: RULED, triggerType: "REVIEW_OVERDUE", enabled: true, actionType: "NOTIFY_USER", conditionJson: {} }];
  const runs: any[] = [];
  const cursors = new Map<string, string | null>();
  const client = {
    automationRule: {
      findMany: async (args: any) => {
        let out = rules.filter((r) => r.enabled && r.triggerType === args.where.triggerType);
        if (args.where.teamId) out = out.filter((r) => r.teamId === args.where.teamId);
        return out.map((r) => ({ ...r }));
      },
    },
    evidenceReviewWorkflow: {
      findMany: async (args: any) => {
        const w = args.where;
        let out = workflows.filter((x) => x.dueAt < (w.dueAt.lt ?? new Date(8.64e15)) && (!w.dueAt.gte || x.dueAt >= w.dueAt.gte));
        if (w.teamId?.in) out = out.filter((x) => w.teamId.in.includes(x.teamId));
        if (w.id?.gt) out = out.filter((x) => x.id > w.id.gt);
        const key = Object.keys(args.orderBy)[0]!;
        out = [...out].sort((a: any, b: any) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
        return out.slice(0, args.take);
      },
    },
    externalReviewGrant: { findMany: async () => [] },
    evidence: { findMany: async () => [] },
    evidenceExchangePackage: { findMany: async () => [] },
    report: { findMany: async () => [] },
    team: { findMany: async () => [] },
    workerSweepCursor: {
      findUnique: async (args: any) => (cursors.has(args.where.key) ? { cursorId: cursors.get(args.where.key) } : null),
      upsert: async (args: any) => {
        cursors.set(args.where.key, args.update.cursorId);
        return {};
      },
    },
    automationRun: {
      createMany: async (args: any) => {
        let count = 0;
        for (const row of args.data) {
          if (runs.some((r) => r.idempotencyKey === row.idempotencyKey)) continue;
          runs.push(row);
          count += 1;
        }
        return { count };
      },
    },
  };
  return { client, runs };
}

describe("automation time-based detectors (PRO-W2C2-06)", () => {
  it("a ruled workspace behind 150 older overdue rows of an unruled one gets its runs on the first tick", async () => {
    const { client, runs } = harness();
    const out = await detectTimeBasedAutomationTriggers({ prisma: client as never });
    expect(out.reviewOverdue).toBe(3);
    expect(runs.every((r) => r.teamId === RULED)).toBe(true);
  });

  it("repeated ticks create no duplicates", async () => {
    const { client, runs } = harness();
    await detectTimeBasedAutomationTriggers({ prisma: client as never });
    const again = await detectTimeBasedAutomationTriggers({ prisma: client as never });
    expect(again.reviewOverdue).toBe(0);
    expect(runs).toHaveLength(3);
  });
});
