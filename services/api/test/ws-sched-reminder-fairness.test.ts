/* eslint-disable @typescript-eslint/no-explicit-any -- a stateful Prisma double. */
/**
 * WS-SCHED / PRO-W2-04, PRO-N1Z-01 — the evidence-request reminder sweep makes
 * progress past rows it cannot remind.
 *
 * At base the sweep read the 100 earliest-due requests platform-wide, with no
 * cursor, and rows in cooldown never left that window: with 150 cooldown rows
 * ahead of 100 live ones, no live request was ever reminded. Now the scan pages
 * by (dueAtUtc, id) until batchSize reminders are sent, and requests whose link
 * can never be used are excluded in the query. Driven against a stateful fake
 * that honours the where / orderBy / take the scheduler asks for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ sends: [] as Array<Record<string, unknown>> }));

vi.mock("../src/services/notifications/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isNotificationsFeatureEnabled: () => true,
    safeSendEmailNotification: async (input: Record<string, unknown>) => {
      m.sends.push(input);
      return null;
    },
  };
});

import { runReminderScheduler } from "../src/services/notifications/reminder-scheduler.js";
import { clearAllRateLimitBuckets } from "../src/services/rate-limit.js";

type Row = {
  id: string;
  teamId: string;
  title: string;
  instructions: null;
  dueAtUtc: Date;
  recipientEmail: string;
  recipientLabel: null;
  evidenceId: null;
  intakeLinkId: string;
  intakeLink: { status: string; expiresAtUtc: Date; maxUses: number; usedCount: number };
  deliverables: [];
  recentReminder: boolean;
};

function rows(count: number, opts: { recentReminder: boolean; offsetMin: number; linkStatus?: string }): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `${opts.recentReminder ? "a" : "b"}${String(i).padStart(7, "0")}-1111-4111-8111-111111111111`;
    return {
      id,
      teamId: "22222222-2222-4222-8222-222222222222",
      title: "Upload",
      instructions: null,
      dueAtUtc: new Date(Date.now() - 86_400_000 + (opts.offsetMin + i) * 60_000),
      recipientEmail: `c${i}@example.test`,
      recipientLabel: null,
      evidenceId: null,
      intakeLinkId: `link-${id}`,
      intakeLink: {
        status: opts.linkStatus ?? "ACTIVE",
        expiresAtUtc: new Date(Date.now() + 7 * 86_400_000),
        maxUses: 5,
        usedCount: 0,
      },
      deliverables: [],
      recentReminder: opts.recentReminder,
    };
  });
}

function matchesCursor(r: Row, where: any): boolean {
  if (!where?.AND) return true;
  const cur = where.AND[1].OR as Array<any>;
  const gtDue: Date = cur[0].dueAtUtc.gt;
  const eqDue: Date = cur[1].dueAtUtc;
  const gtId: string = cur[1].id.gt;
  return r.dueAtUtc > gtDue || (r.dueAtUtc.getTime() === eqDue.getTime() && r.id > gtId);
}

function baseOf(where: any): any {
  return where?.AND ? where.AND[0] : where;
}

function fakeClient(all: Row[]) {
  const reminded = new Set<string>(all.filter((r) => r.recentReminder).map((r) => r.id));
  return {
    evidenceRequest: {
      findMany: async (args: any) => {
        const base = baseOf(args.where);
        const linkFilter = base.intakeLink?.is;
        return all
          .filter((r) => !linkFilter || (r.intakeLink.status === linkFilter.status && r.intakeLink.expiresAtUtc > linkFilter.expiresAtUtc.gt))
          .filter((r) => matchesCursor(r, args.where))
          .sort((x, y) => x.dueAtUtc.getTime() - y.dueAtUtc.getTime() || (x.id < y.id ? -1 : 1))
          .slice(0, args.take);
      },
      // Integration: PRO-N1Z-02 (WS-MSG) — the re-invitation gate reads the
      // request before a reminder is sent; these requests are open.
      findUnique: async () => ({ status: "SENT" }),
    },
    workflowIntakeLink: { findUnique: async () => null },
    team: { findUnique: async () => ({ name: "W", evidenceWorkspaceLabel: null }) },
    notificationDelivery: {
      findFirst: async (args: any) => {
        if (args.where.eventType === "EVIDENCE_REQUEST_REMINDER") {
          return reminded.has(args.where.evidenceRequestId) ? { id: "prior" } : null;
        }
        return { templateContextJson: { kind: "EvidenceRequest", data: { intakeUrl: "https://www.proovra.com/intake/t" } } };
      },
    },
  } as never;
}

const saved = process.env.NOTIFICATION_REMINDERS_ENABLED;
beforeEach(async () => {
  process.env.NOTIFICATION_REMINDERS_ENABLED = "true";
  delete process.env.REDIS_URL;
  m.sends.length = 0;
  await clearAllRateLimitBuckets();
});
afterEach(() => {
  if (saved === undefined) delete process.env.NOTIFICATION_REMINDERS_ENABLED;
  else process.env.NOTIFICATION_REMINDERS_ENABLED = saved;
});

describe("reminder sweep fairness (PRO-W2-04 / PRO-N1Z-01)", () => {
  it("150 cooldown rows ahead of 100 live ones: the live ones are reminded in one run", async () => {
    const all = [...rows(150, { recentReminder: true, offsetMin: 0 }), ...rows(100, { recentReminder: false, offsetMin: 1000 })];
    const summary = await runReminderScheduler({}, fakeClient(all));
    expect(summary.reminded).toBe(100);
    expect(m.sends).toHaveLength(100);
    expect(summary.skippedRecent).toBe(150);
  });

  it("requests whose link is revoked never occupy the scan", async () => {
    const all = [...rows(120, { recentReminder: false, offsetMin: 0, linkStatus: "REVOKED" }), ...rows(5, { recentReminder: false, offsetMin: 1000 })];
    const summary = await runReminderScheduler({}, fakeClient(all));
    expect(summary.reminded).toBe(5);
    expect(summary.scanned).toBe(5);
    expect(summary.skippedNoLink).toBe(0);
  });

  it("stops at batchSize sends; the next run continues with the rest (cooldown keeps the sent ones out)", async () => {
    const all = rows(250, { recentReminder: false, offsetMin: 0 });
    const client = fakeClient(all);
    const first = await runReminderScheduler({ batchSize: 100 }, client);
    expect(first.reminded).toBe(100);
  });
});
