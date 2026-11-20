/**
 * Matrix review NEW-RG-23-1 (RG-23, "exactly one dispatcher sends a claimed
 * delivery") — the lifecycle dispatcher's PRE-claim writes (endpoint gone or
 * inactive, workspace not operating, entitlement lost, creator lost / not
 * provable, machine egress restricted, destination refused, payload too large,
 * signing secret unreadable) used to update the delivery by id alone after a
 * read that can be stale. Across replicas another process may have claimed the
 * row (DISPATCHING) in between: the unconditional write then overwrote that
 * claim — RETRYING made the row due again (a second send), FAILED/WITHHELD
 * hid a send already in flight, and the holder's fenced outcome was then not
 * recorded. Every pre-claim write is now conditional on the row still being in
 * a polled state (PENDING / RETRYING), the same states the claim moves out of.
 *
 * In-memory delivery table with real `where` semantics; the stale read is a
 * claim by "another replica" landing between this process's read and write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string; state: string };

const db = vi.hoisted(() => {
  const state = {
    deliveries: new Map<string, Record<string, unknown> & { id: string; state: string }>(),
    endpoint: null as null | Record<string, unknown>,
    team: null as null | Record<string, unknown>,
    /** When set, the row is claimed by another replica right after this process reads it. */
    claimAfterRead: false,
  };
  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [k, cond] of Object.entries(where)) {
      const v = row[k];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { in?: unknown[]; lt?: Date };
        if (c.in && !c.in.includes(v)) return false;
        if (c.lt && !(v instanceof Date && v < c.lt)) return false;
      } else if (v !== cond) return false;
    }
    return true;
  }
  const prisma = {
    lifecycleWebhookDelivery: {
      findMany: async () =>
        [...state.deliveries.values()]
          .filter((r) => r.state === "PENDING" || r.state === "RETRYING")
          .map((r) => ({ id: r.id })),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = state.deliveries.get(where.id);
        if (!row) return null;
        const snapshot = { ...row };
        if (state.claimAfterRead) {
          row.state = "DISPATCHING";
          row.lastAttemptAtUtc = new Date();
        }
        return snapshot;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.deliveries.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of state.deliveries.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    lifecycleWebhookEndpoint: {
      findUnique: async () => (state.endpoint ? { ...state.endpoint } : null),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.endpoint) Object.assign(state.endpoint, data);
        return { count: 1 };
      },
    },
    team: { findUnique: async () => (state.team ? { ...state.team } : null) },
  };
  return { state, prisma };
});

const gates = vi.hoisted(() => ({
  entitled: true,
  creator: { verdict: "HOLDS" } as { verdict: string; reason?: string },
  egressRestricted: false,
}));

vi.mock("../src/db.js", () => ({ prisma: db.prisma }));
vi.mock("../src/governance/workspace-entitlement.js", () => ({
  workerFeatureEntitled: async () => gates.entitled,
}));
vi.mock("@proovra/shared-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@proovra/shared-runtime")>();
  return {
    ...actual,
    evaluateStandingCreatorAuthority: async () => gates.creator,
    machineEgressRestricted: async () => gates.egressRestricted,
  };
});

import { runWebhookDispatcherTick } from "../src/webhook-dispatcher.js";

const DELIVERY_ID = "d-rg23";
const SECRET = Buffer.from("rg23-secret").toString("base64");

function reset(): void {
  db.state.deliveries.clear();
  db.state.deliveries.set(DELIVERY_ID, {
    id: DELIVERY_ID,
    teamId: "t-rg23",
    endpointId: "e-rg23",
    eventKind: "EVIDENCE_CREATED",
    payload: { evidenceId: "ev-1" },
    state: "PENDING",
    attemptCount: 0,
    nextAttemptAtUtc: null,
    lastAttemptAtUtc: null,
  });
  db.state.endpoint = {
    id: "e-rg23",
    url: "https://203.0.113.10/rg23",
    state: "ACTIVE",
    secret: SECRET,
    createdByUserId: "u-owner",
  };
  db.state.team = {
    isPersonal: false,
    workspaceKind: "OWNED",
    billingPlan: "TEAM",
    closedAtUtc: null,
    organization: null,
  };
  db.state.claimAfterRead = false;
  gates.entitled = true;
  gates.creator = { verdict: "HOLDS" };
  gates.egressRestricted = false;
}

beforeEach(reset);

type Branch = { name: string; arrange: () => void; settles: string };

const BRANCHES: Branch[] = [
  { name: "endpoint inactive", arrange: () => { db.state.endpoint!.state = "DEACTIVATED"; }, settles: "FAILED" },
  { name: "endpoint gone", arrange: () => { db.state.endpoint = null; }, settles: "FAILED" },
  { name: "workspace not operating (deferral)", arrange: () => { db.state.team!.closedAtUtc = new Date(); }, settles: "RETRYING" },
  { name: "FEATURE_WEBHOOKS lost (withheld)", arrange: () => { gates.entitled = false; }, settles: "WITHHELD" },
  { name: "creator lost authority", arrange: () => { gates.creator = { verdict: "LOST", reason: "permission_denied" }; }, settles: "FAILED" },
  { name: "creator authority not provable (deferral)", arrange: () => { gates.creator = { verdict: "INDETERMINATE" }; }, settles: "RETRYING" },
  { name: "machine egress restricted (withheld)", arrange: () => { gates.egressRestricted = true; }, settles: "WITHHELD" },
  { name: "destination refused (non-https)", arrange: () => { db.state.endpoint!.url = "http://203.0.113.10/rg23"; }, settles: "FAILED" },
  {
    name: "payload too large",
    arrange: () => { db.state.deliveries.get(DELIVERY_ID)!.payload = { blob: "x".repeat(70 * 1024) }; },
    settles: "FAILED",
  },
  { name: "signing secret unreadable", arrange: () => { db.state.endpoint!.secret = ""; }, settles: "FAILED" },
];

async function tick(): Promise<string[]> {
  const sent: string[] = [];
  await runWebhookDispatcherTick({
    fetcher: async (url) => {
      sent.push(url);
      return { status: 200, text: async () => "" };
    },
  });
  return sent;
}

const row = (): Row => db.state.deliveries.get(DELIVERY_ID)! as Row;

describe("NEW-RG-23-1 — the dispatcher's pre-claim writes never overwrite another replica's claim", () => {
  for (const b of BRANCHES) {
    it(`${b.name}: settles ${b.settles} on a fresh read (control)`, async () => {
      b.arrange();
      const sent = await tick();
      expect(sent).toEqual([]);
      expect(row().state).toBe(b.settles);
    });

    it(`${b.name}: a row claimed by another replica after the read stays DISPATCHING`, async () => {
      b.arrange();
      db.state.claimAfterRead = true;
      const sent = await tick();
      expect(sent).toEqual([]);
      expect(row().state).toBe("DISPATCHING");
    });
  }

  it("a row already read as DISPATCHING is left to its holder (no write, no send)", async () => {
    row().state = "DISPATCHING";
    row().lastAttemptAtUtc = new Date();
    // Not polled, so drive the same row through the poll by a stale list.
    const findMany = db.prisma.lifecycleWebhookDelivery.findMany;
    db.prisma.lifecycleWebhookDelivery.findMany = async () => [{ id: DELIVERY_ID }];
    try {
      db.state.endpoint!.state = "DEACTIVATED";
      const sent = await tick();
      expect(sent).toEqual([]);
      expect(row().state).toBe("DISPATCHING");
    } finally {
      db.prisma.lifecycleWebhookDelivery.findMany = findMany;
    }
  });

  it("positive control: an eligible delivery is claimed, sent once and DELIVERED", async () => {
    const sent = await tick();
    expect(sent).toEqual(["https://203.0.113.10/rg23"]);
    expect(row().state).toBe("DELIVERED");
    expect(row().attemptCount).toBe(1);
  });
});
