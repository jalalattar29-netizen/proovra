/**
 * The Billing / Operations boundary for a storage add-on still billing.
 *
 *   * The PERSONAL billing account sees and acts on every add-on its payer
 *     pays for, including legacy workspace-scoped ones that Operations names
 *     as "retry from Billing".
 *   * The condition sweep can be bounded to one payer, pages by keyset, and
 *     says when it did not look at everything or could not attribute a row.
 *   * An obligation owed because the provider activated an add-on PROOVRA
 *     could not grant is never described as a plan cancellation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { stampConditionMessage } from "@proovra/shared";

const db = vi.hoisted(() => ({
  prisma: {
    workspaceStorageAddon: {
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    team: { findFirst: vi.fn() },
    subscription: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));
const recordIncident = vi.hoisted(() => vi.fn<(i: Record<string, unknown>) => Promise<unknown>>(async () => ({})));

vi.mock("../src/db.js", () => ({ prisma: db.prisma }));
vi.mock("../src/services/observability/incident.service.js", () => ({
  recordIncident: (i: Record<string, unknown>) => recordIncident(i),
}));

const conditions = await import("../src/services/billing/dependent-cancellation-conditions.service.js");
const obligations = await import("../src/services/billing/dependent-cancellation.service.js");

function addonRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    ownerUserId: "user-1",
    teamId: null,
    addonKey: "STORAGE_50GB",
    extraStorageBytes: BigInt(50) * BigInt(1024) ** BigInt(3),
    paymentProvider: "STRIPE",
    dependentCancellationState: "RETRY_SCHEDULED",
    dependentCancellationAttemptCount: 2,
    dependentCancellationReasonCode: null,
    dependentCancellationRequestedAtUtc: null,
    dependentCancellationFailedAtUtc: null,
    dependentCancellationNextRetryAtUtc: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.prisma.team.findFirst.mockResolvedValue({ id: "personal-team-1", ownerUserId: "user-1" });
});

describe("payer scope (legacy team-scoped add-ons are Billing's too)", () => {
  it("payerOwnedAddonWhere includes no-workspace rows and workspaces the payer owns", () => {
    expect(obligations.payerOwnedAddonWhere("user-1")).toEqual({
      ownerUserId: "user-1",
      OR: [{ teamId: null }, { team: { ownerUserId: "user-1" } }],
    });
  });

  it("the PERSONAL summary reads the payer scope and counts ungrantable obligations", async () => {
    db.prisma.workspaceStorageAddon.findMany.mockResolvedValue([
      {
        dependentCancellationReasonCode: "UNGRANTABLE_PROVIDER_ACTIVE",
        dependentCancellationState: "RETRY_SCHEDULED",
        dependentCancellationFailedAtUtc: null,
        dependentCancellationNextRetryAtUtc: null,
      },
      {
        dependentCancellationReasonCode: null,
        dependentCancellationState: "MANUAL_INTERVENTION",
        dependentCancellationFailedAtUtc: null,
        dependentCancellationNextRetryAtUtc: null,
      },
    ]);
    const summary = await obligations.summarizeDependentCancellations({
      ownerUserId: "user-1",
      teamId: null,
      payerScope: true,
    });
    const where = db.prisma.workspaceStorageAddon.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject(obligations.payerOwnedAddonWhere("user-1"));
    expect(summary).toMatchObject({
      affectedCount: 2,
      supportRequired: true,
      ungrantableCount: 1,
      status: "MANUAL_INTERVENTION",
    });
  });

  it("without payerScope the personal arm stays strict (teamId null)", async () => {
    db.prisma.workspaceStorageAddon.findMany.mockResolvedValue([]);
    await obligations.summarizeDependentCancellations({ ownerUserId: "user-1", teamId: null });
    const where = db.prisma.workspaceStorageAddon.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ ownerUserId: "user-1", teamId: null });
  });

  it("payer subjects are the personal subject plus each owned legacy workspace with an obligation", async () => {
    db.prisma.workspaceStorageAddon.findMany.mockResolvedValue([
      { teamId: "team-a" },
      { teamId: "team-b" },
      { teamId: "team-a" },
    ]);
    const subjects = await obligations.payerObligationSubjects("user-1");
    expect(subjects).toEqual([
      { ownerUserId: "user-1", teamId: null },
      { ownerUserId: "user-1", teamId: "team-a" },
      { ownerUserId: "user-1", teamId: "team-b" },
    ]);
    const where = db.prisma.workspaceStorageAddon.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ ownerUserId: "user-1", team: { ownerUserId: "user-1" } });
  });
});

describe("syncDependentCancellationConditions", () => {
  it("bounded to one payer, the query carries the payer scope (never the global sweep)", async () => {
    db.prisma.workspaceStorageAddon.findMany.mockResolvedValueOnce([addonRow("a1")]);
    const r = await conditions.syncDependentCancellationConditions({ payerUserId: "user-1" });
    const where = db.prisma.workspaceStorageAddon.findMany.mock.calls[0]![0].where;
    expect(where.AND).toEqual([obligations.payerOwnedAddonWhere("user-1")]);
    expect(r).toEqual({ opened: 1, scanned: 1, skippedUnscoped: 0, truncated: false });
    expect(recordIncident.mock.calls[0]![0]).toMatchObject({
      teamId: "personal-team-1",
      sourceId: "billing.dependent_cancellation_failed",
    });
  });

  it("pages by keyset on id and reports truncation when the page budget runs out", async () => {
    db.prisma.workspaceStorageAddon.findMany
      .mockResolvedValueOnce([addonRow("a1"), addonRow("a2"), addonRow("a3")])
      .mockResolvedValueOnce([addonRow("a3"), addonRow("a4"), addonRow("a5")]);
    const r = await conditions.syncDependentCancellationConditions({ limit: 2, maxPages: 2 });
    const calls = db.prisma.workspaceStorageAddon.findMany.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toMatchObject({ orderBy: { id: "asc" }, take: 3 });
    expect(calls[1]![0].where.AND[1]).toEqual({ id: { gt: "a2" } });
    expect(r).toEqual({ opened: 4, scanned: 4, skippedUnscoped: 0, truncated: true });
  });

  it("a short last page is complete, not truncated", async () => {
    db.prisma.workspaceStorageAddon.findMany
      .mockResolvedValueOnce([addonRow("a1"), addonRow("a2"), addonRow("a3")])
      .mockResolvedValueOnce([addonRow("a3")]);
    const r = await conditions.syncDependentCancellationConditions({ limit: 2, maxPages: 5 });
    expect(db.prisma.workspaceStorageAddon.findMany).toHaveBeenCalledTimes(2);
    expect(r.truncated).toBe(false);
    expect(r.scanned).toBe(3);
  });

  it("an owner with no Personal Space team is counted, never attributed", async () => {
    db.prisma.team.findFirst.mockResolvedValue(null);
    db.prisma.workspaceStorageAddon.findMany.mockResolvedValueOnce([addonRow("a1")]);
    const r = await conditions.syncDependentCancellationConditions();
    expect(r).toEqual({ opened: 0, scanned: 1, skippedUnscoped: 1, truncated: false });
    expect(recordIncident).not.toHaveBeenCalled();
  });

  it("an UNGRANTABLE obligation is not described as a plan cancellation", async () => {
    db.prisma.workspaceStorageAddon.findMany.mockResolvedValueOnce([
      addonRow("a1", { dependentCancellationReasonCode: "UNGRANTABLE_PROVIDER_ACTIVE" }),
    ]);
    await conditions.syncDependentCancellationConditions({ payerUserId: "user-1" });
    const arg = recordIncident.mock.calls[0]![0];
    // The writer records a code; the English it stores is rendered from it.
    expect(arg.message.code).toBe("ops.billing.dependent_cancellation.ungrantable_stopping");
    const stored = stampConditionMessage(arg.message)!;
    expect(stored.summary).not.toMatch(/plan was cancelled/);
    expect(stored.summary).toMatch(/could not be added to this account/);
  });
});

describe("dependentCancellationWording", () => {
  it("UNGRANTABLE wording names the real cause in every state", () => {
    for (const state of ["PENDING", "RETRY_SCHEDULED", "ACTION_REQUIRED", "MANUAL_INTERVENTION"]) {
      const w = conditions.dependentCancellationWording({
        state,
        reasonCode: "UNGRANTABLE_PROVIDER_ACTIVE",
        personal: true,
      });
      expect(w.safeSummary, state).not.toMatch(/plan was cancelled/);
      expect(w.title, state).toMatch(/Ungranted storage add-on/);
    }
    expect(
      conditions.dependentCancellationWording({
        state: "MANUAL_INTERVENTION",
        reasonCode: "UNGRANTABLE_PROVIDER_ACTIVE",
        personal: false,
      }).title,
    ).toMatch(/support needed/);
  });

  it("plan-cancellation wording is unchanged", () => {
    const w = conditions.dependentCancellationWording({
      state: "PENDING",
      reasonCode: null,
      personal: true,
    });
    expect(w.safeSummary).toMatch(/plan was cancelled/);
  });
});
