/**
 * PAID ACTIVATION → FIRST ISSUANCE, AND THE SUBSCRIPTION READING (2026-09-29).
 *
 * D5 and the Free→paid gap, against live PostgreSQL 16 with the REAL worker
 * reconciliation and the REAL commercial lifecycle resolver:
 *
 *   * an ACTIVE subscription beside an unapproved PayPal checkout attempt
 *     (stored TRIALING) reads ACTIVE — it read CANCELLED;
 *   * two genuine live subscriptions still fail closed;
 *   * a confirmed activation serves that subscriber's old Free records first:
 *     recent ones at once, older ones only with the (default-off) historical
 *     flag — exactly one first request per record, however often it runs;
 *   * a pending checkout (no provider-confirmed activation, plan FREE) gets
 *     nothing; a credit purchase is not a subscription;
 *   * the original's fingerprint and dates are untouched.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

const DAY = 24 * 60 * 60 * 1000;

describe("paid activation → first issuance (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let reconcile: typeof import("../../../worker/src/first-issuance-reconciliation.js");
  let lifecycle: typeof import("@proovra/shared-runtime");
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    lifecycle = await import("@proovra/shared-runtime");
    lifecycle.registerPrisma(prisma as never);
    reconcile = await import("../../../worker/src/first-issuance-reconciliation.js");
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    delete process.env.OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED;
    await harness?.cleanup();
  });

  beforeEach(() => {
    reconcile.resetFirstIssuanceCursors();
    delete process.env.OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED;
  });

  const P = () => harness.fixtures.personal;

  async function setPlan(plan: "FREE" | "PRO") {
    const ent = await prisma.entitlement.findFirst({ where: { userId: P().userId }, select: { id: true } });
    if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan } });
    else await prisma.entitlement.create({ data: { userId: P().userId, plan } });
  }

  async function subscription(over: Record<string, unknown>) {
    return prisma.subscription.create({
      data: {
        userId: P().userId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID()}`,
        status: "ACTIVE",
        plan: "PRO",
        ...over,
      } as never,
      select: { id: true },
    });
  }

  async function clearSubscriptions() {
    await prisma.subscription.deleteMany({ where: { userId: P().userId } });
  }

  async function oldFreeRecord(ageDays: number) {
    const signedAtUtc = new Date(Date.now() - ageDays * DAY);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: P().teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: `Free record ${ageDays}d`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: P().teamId,
        organizationId: team.organizationId,
        ownerUserId: P().userId,
        signedAtUtc,
        fingerprintHash: "9".repeat(64),
        fileSha256: "8".repeat(64),
        createdAt: signedAtUtc,
      } as never,
      select: { id: true },
    });
    created.push(ev.id);
    return ev.id;
  }

  const requestsFor = (ids: string[]) =>
    prisma.reportGenerationRequest.findMany({
      where: { evidenceId: { in: ids }, artifactType: "REPORT" },
      select: { evidenceId: true, purpose: true },
    });

  it("ACTIVE + an unapproved PayPal checkout attempt reads ACTIVE; two genuine live subscriptions fail closed", async () => {
    await clearSubscriptions();
    await setPlan("PRO");
    await subscription({ activatedAtUtc: new Date() });
    await subscription({ provider: "PAYPAL", status: "TRIALING", providerSubId: `I-${randomUUID()}` });
    const subject = { kind: "PERSONAL" as const, ownerUserId: P().userId, plan: "PRO" as never };
    const withAttempt = await lifecycle.readCommercialLifecycle(prisma as never, subject);
    expect(withAttempt).toMatchObject({ state: "ACTIVE", paidActive: true });

    await subscription({ provider: "PAYPAL", status: "ACTIVE", providerSubId: `I-${randomUUID()}`, activatedAtUtc: new Date() });
    const duplicate = await lifecycle.readCommercialLifecycle(prisma as never, subject);
    expect(duplicate.state, "a genuine second live subscription is not ignored").toBe("CANCELLED");
    await clearSubscriptions();
  });

  it("a confirmed activation serves the subscriber's old Free records: recent at once, older only with the historical flag, once each", async () => {
    await clearSubscriptions();
    await setPlan("PRO");
    const recent = await oldFreeRecord(1);
    const tenDays = await oldFreeRecord(10);
    const yearOld = await oldFreeRecord(400);
    const before = await prisma.evidence.findMany({
      where: { id: { in: [recent, tenDays, yearOld] } },
      select: { id: true, fingerprintHash: true, signedAtUtc: true, createdAt: true },
      orderBy: { id: "asc" },
    });
    await subscription({ activatedAtUtc: new Date() });

    const off = await reconcile.runFirstIssuanceReconciliation({ trigger: "test" });
    expect(off.activationScanned).toBeGreaterThanOrEqual(3);
    let reqs = await requestsFor([recent, tenDays, yearOld]);
    expect(reqs.map((r) => r.evidenceId)).toEqual([recent]);
    expect(off.firstIssueSkippedHistoricalGate).toBeGreaterThanOrEqual(2);

    process.env.OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED = "true";
    await reconcile.runFirstIssuanceReconciliation({ trigger: "test" });
    await reconcile.runFirstIssuanceReconciliation({ trigger: "test" }); // idempotent
    reqs = await requestsFor([recent, tenDays, yearOld]);
    expect(reqs.map((r) => r.evidenceId).sort()).toEqual([recent, tenDays, yearOld].sort());
    expect(reqs.filter((r) => r.evidenceId !== recent).every((r) => r.purpose === "first_issuance")).toBe(true);

    const after = await prisma.evidence.findMany({
      where: { id: { in: [recent, tenDays, yearOld] } },
      select: { id: true, fingerprintHash: true, signedAtUtc: true, createdAt: true },
      orderBy: { id: "asc" },
    });
    expect(after, "the originals' fingerprints and dates are unchanged").toEqual(before);
    await clearSubscriptions();
  });

  it("a pending checkout (plan FREE, unapproved PayPal attempt) receives nothing", async () => {
    await clearSubscriptions();
    await setPlan("FREE");
    const rec = await oldFreeRecord(2);
    await subscription({ provider: "PAYPAL", status: "TRIALING", providerSubId: `I-${randomUUID()}` });
    process.env.OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED = "true";
    await reconcile.runFirstIssuanceReconciliation({ trigger: "test" });
    expect(await requestsFor([rec])).toEqual([]);
    await clearSubscriptions();
  });

  it("a dry run decides and counts but schedules nothing", async () => {
    await clearSubscriptions();
    await setPlan("PRO");
    const rec = await oldFreeRecord(30);
    await subscription({ activatedAtUtc: new Date() });
    process.env.OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED = "true";
    const s = await reconcile.runFirstIssuanceReconciliation({ trigger: "test", dryRun: true });
    expect(s.firstIssueScheduled).toBeGreaterThanOrEqual(1);
    expect(await requestsFor([rec])).toEqual([]);
    await clearSubscriptions();
  });

  it("a real FREE→PRO upgrade moves old records from 'not included' to 'owed' in Reports, issues nothing itself, and the worker issues only the recent one", async () => {
    await clearSubscriptions();
    await setPlan("FREE");
    const recent = await oldFreeRecord(1);
    const older = await oldFreeRecord(10);
    const ids = [recent, older];
    const fingerprints = await prisma.evidence.findMany({
      where: { id: { in: ids } },
      select: { id: true, fingerprintHash: true, signedAtUtc: true, createdAt: true },
      orderBy: { id: "asc" },
    });
    const { listWorkspaceArtifacts } = await import("../../src/services/reports/reports-aggregator.service.js");
    const view = async () => {
      const env = (await listWorkspaceArtifacts({
        teamId: P().teamId,
        role: "OWNER",
        callerUserId: P().userId,
        includeSummary: true,
        limit: 200,
      })) as unknown as {
        sections: {
          summary: { data: Record<string, number> };
          artifacts: { items: Array<{ evidenceId?: string; id?: string; outputs?: { report?: { state?: string; action?: string } } }> };
        };
      };
      const pick = (id: string) => env.sections.artifacts.items.find((i) => (i.evidenceId ?? i.id) === id)?.outputs?.report;
      return { summary: env.sections.summary.data, recent: pick(recent), older: pick(older) };
    };

    const before = await view();
    expect(before.recent?.state).toBe("NOT_INCLUDED");
    expect(before.older?.state).toBe("NOT_INCLUDED");

    // The production plan authority, with the provider canceller injected so
    // nothing is contacted.
    const { syncPlanForSubscription } = await import("../../src/services/billing/subscription-lifecycle.handlers.js");
    const sync = await syncPlanForSubscription({
      userId: P().userId,
      plan: "PRO" as never,
      provider: "STRIPE" as never,
      providerSubId: `sub_${randomUUID()}`,
      status: "ACTIVE" as never,
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      observedAtUtc: new Date(),
      cancelSupersededAtProvider: async () => ({ canceled: false, observedAtUtc: null }) as never,
    });
    expect(sync).toMatchObject({ outcome: "APPLIED" });

    // The upgrade itself issues nothing.
    expect(await prisma.report.count({ where: { evidenceId: { in: ids } } })).toBe(0);
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: { in: ids } } })).toBe(0);

    // Both records are now owed a first report that the owner can generate.
    // The summary is workspace-wide: every record that was "not included"
    // under FREE is now owed, and nothing is left "not issued".
    const after = await view();
    for (const row of [after.recent, after.older]) {
      expect(row).toMatchObject({ state: "ELIGIBLE_NOT_GENERATED", action: "GENERATE" });
    }
    expect(before.summary.reportsNotIssued).toBeGreaterThanOrEqual(2);
    expect(after.summary.reportsNotIssued).toBe(0);
    expect(after.summary.reportsAwaitingFirstIssuance).toBe(
      before.summary.reportsAwaitingFirstIssuance + before.summary.reportsNotIssued,
    );

    // The worker issues only the recent record while the historical flag is off.
    await reconcile.runFirstIssuanceReconciliation({ trigger: "test" });
    expect((await requestsFor(ids)).map((r) => r.evidenceId)).toEqual([recent]);

    const unchanged = await prisma.evidence.findMany({
      where: { id: { in: ids } },
      select: { id: true, fingerprintHash: true, signedAtUtc: true, createdAt: true },
      orderBy: { id: "asc" },
    });
    expect(unchanged).toEqual(fingerprints);
    await clearSubscriptions();
  });
});
