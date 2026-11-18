/**
 * WS-REL / PRO-W2C2-01 — the API retention sweeper records a record's
 * transition into expiry ONCE in its custody chain, and reaches every expired
 * record instead of re-taking the same oldest page.
 *
 * The real reconcileRetention over an in-memory evidence table; the custody
 * append, legal-hold resolver and security-event sink are doubles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  teamId: string | null;
  retentionUntilUtc: Date | null;
  retentionReconciliationFlaggedAtUtc: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
};

const H = vi.hoisted(() => ({
  rows: [] as Row[],
  custody: [] as Array<{ evidenceId: string; eventType: string; payload: Record<string, unknown> }>,
  held: new Set<string>(),
}));

vi.mock("@proovra/shared-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@proovra/shared-runtime")>();
  return {
    ...actual,
    appendCustodyEventTx: async (_tx: unknown, e: { evidenceId: string; eventType: string; payload: Record<string, unknown> }) => {
      H.custody.push(e);
    },
  };
});
vi.mock("../src/services/governance/legal-hold.service.js", () => ({
  isEvidenceUnderAnyLegalHold: async (id: string) => H.held.has(id),
}));
vi.mock("../src/services/security/security-event.service.js", () => ({ safeEmitSecurityEvent: () => undefined }));
vi.mock("../src/db.js", () => ({ prisma: {} }));

import { reconcileRetention } from "../src/services/governance/retention-sweeper.service.js";

type Where = {
  retentionUntilUtc: { lte: Date };
  OR?: Array<{ retentionReconciliationFlaggedAtUtc: null | { lte: Date } }>;
};

function matches(r: Row, where: Where): boolean {
  if (!r.retentionUntilUtc || r.retentionUntilUtc > where.retentionUntilUtc.lte) return false;
  if (r.deletedAt || r.archivedAt) return false;
  if (!where.OR) return true;
  return where.OR.some((c) =>
    c.retentionReconciliationFlaggedAtUtc === null
      ? r.retentionReconciliationFlaggedAtUtc === null
      : r.retentionReconciliationFlaggedAtUtc !== null &&
        r.retentionReconciliationFlaggedAtUtc <= c.retentionReconciliationFlaggedAtUtc.lte,
  );
}

const client = {
  evidence: {
    findMany: async (args: { where: Where; take: number }) =>
      H.rows
        .filter((r) => matches(r, args.where))
        .sort((a, b) => a.retentionUntilUtc!.getTime() - b.retentionUntilUtc!.getTime())
        .slice(0, args.take)
        .map((r) => ({ ...r })),
  },
  $transaction: async (fn: (tx: unknown) => Promise<void>) =>
    fn({
      evidence: {
        update: async (args: { where: { id: string }; data: { retentionReconciliationFlaggedAtUtc: Date } }) => {
          const r = H.rows.find((x) => x.id === args.where.id)!;
          r.retentionReconciliationFlaggedAtUtc = args.data.retentionReconciliationFlaggedAtUtc;
        },
      },
    }),
};

const DAY = 24 * 3600 * 1000;
function expired(id: string, daysAgo: number): Row {
  return {
    id,
    teamId: "t",
    retentionUntilUtc: new Date(Date.now() - daysAgo * DAY),
    retentionReconciliationFlaggedAtUtc: null,
    archivedAt: null,
    deletedAt: null,
  };
}

beforeEach(() => {
  H.rows = [];
  H.custody = [];
  H.held.clear();
  vi.useRealTimers();
});

describe("PRO-W2C2-01 retention custody events", () => {
  it("three daily runs add one custody event per expired record, held or not", async () => {
    H.rows = [expired("a", 10), expired("b", 5)];
    H.held.add("b");
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let day = 0; day < 3; day += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 18 + day, 12)));
      await reconcileRetention({}, client as never);
    }
    vi.useRealTimers();
    expect(H.custody.filter((e) => e.evidenceId === "a")).toHaveLength(1);
    const held = H.custody.filter((e) => e.evidenceId === "b");
    expect(held).toHaveLength(1);
    expect(held[0]!.payload.blockedByLegalHold).toBe(true);
    // The row still carries the daily signal.
    expect(H.rows.find((r) => r.id === "a")!.retentionReconciliationFlaggedAtUtc!.getUTCDate()).toBe(20);
  });

  it("a retention date extended past the flag and expiring again is a new transition", async () => {
    const r = expired("c", 3);
    H.rows = [r];
    await reconcileRetention({}, client as never);
    expect(H.custody).toHaveLength(1);
    // Extended, then expired again later; flag is older than the window.
    r.retentionReconciliationFlaggedAtUtc = new Date(Date.now() - 3 * DAY);
    r.retentionUntilUtc = new Date(Date.now() - 1 * DAY);
    await reconcileRetention({}, client as never);
    expect(H.custody).toHaveLength(2);
  });

  it("250 expired records are all flagged within two runs of 200", async () => {
    H.rows = Array.from({ length: 250 }, (_, i) => expired(`r${i}`, 300 - i));
    await reconcileRetention({ batchSize: 200 }, client as never);
    await reconcileRetention({ batchSize: 200 }, client as never);
    expect(H.rows.every((r) => r.retentionReconciliationFlaggedAtUtc !== null)).toBe(true);
    expect(H.custody).toHaveLength(250);
  });
});
