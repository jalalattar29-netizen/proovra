/**
 * ET-COM-04 — a lapsed paid plan falls back to FREE-equivalent creation and
 * keeps what it earned. Live PostgreSQL 16, real HTTP.
 *
 * Owner decision (2026-09-30): a billing lapse is not an account-security
 * suspension. On a40ca76f the lifecycle gate threw 402
 * COMMERCIAL_LIFECYCLE_RESTRICTED before the allowance or the wallet was
 * consulted, so a lapsed PRO account could create nothing — not within the
 * Free allowance, not with a purchased credit — and the worker refused report
 * jobs that had been queued while the plan was still paid.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedPersonalTenant,
  type FixtureDeps,
  type OrganizationTenant,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

describe("lapsed paid plan — FREE-equivalent creation, earned outputs kept (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let clearRates: () => Promise<unknown>;
  let resolveScope: (typeof import("../src/services/billing-enforcement.service.js"))["resolveEnforcementScopeForRequester"];
  let settle: (typeof import("../src/services/billing-enforcement.service.js"))["settleEvidenceCompletionFunding"];
  let finalizationIssuance: (typeof import("../src/services/billing-enforcement.service.js"))["resolveFinalizationIssuance"];
  let eligibilityOf: (typeof import("../src/services/billing/evidence-output-eligibility.service.js"))["resolveEvidenceOutputEligibility"];
  let owedWhere: (typeof import("../src/services/billing/evidence-output-eligibility.service.js"))["outputEntitledEvidenceWhere"];
  let earnedFactFrom: (typeof import("@proovra/shared-billing"))["outputEarnedFactFromDecision"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    ({
      resolveEnforcementScopeForRequester: resolveScope,
      settleEvidenceCompletionFunding: settle,
      resolveFinalizationIssuance: finalizationIssuance,
    } = await import("../src/services/billing-enforcement.service.js"));
    ({ resolveEvidenceOutputEligibility: eligibilityOf, outputEntitledEvidenceWhere: owedWhere } = await import(
      "../src/services/billing/evidence-output-eligibility.service.js"
    ));
    ({ outputEarnedFactFromDecision: earnedFactFrom } = await import("@proovra/shared-billing"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `com04-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  }, 180_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  const DAY = 24 * 3600_000;
  const create = (t: PersonalTenant) =>
    h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${t.owner.token}`, "content-type": "application/json" },
      payload: { type: "PHOTO", mimeType: "image/jpeg" },
    });

  async function subscribe(t: PersonalTenant, status: "ACTIVE" | "PAST_DUE", periodEnd: Date) {
    await prisma.subscription.deleteMany({ where: { userId: t.owner.userId } });
    await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        provider: "STRIPE",
        providerSubId: `sub_${deps.tag}_${Math.random().toString(36).slice(2)}`,
        status,
        plan: "PRO",
        currentPeriodEnd: periodEnd,
      },
    });
  }
  /** Past due, 8 days after the period end: beyond the 7-day grace. */
  const lapse = (t: PersonalTenant) => subscribe(t, "PAST_DUE", new Date(Date.now() - 8 * DAY));
  const renew = (t: PersonalTenant) => subscribe(t, "ACTIVE", new Date(Date.now() + 20 * DAY));

  async function proTenantHolding(n: number, opts: { credits?: number } = {}): Promise<{ t: PersonalTenant; ids: string[] }> {
    const t = await seedPersonalTenant(deps, "PRO", opts);
    await renew(t);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const row = await prisma.evidence.create({
        data: {
          title: `com04-${i}`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          ownerUserId: t.owner.userId,
          createdAt: new Date(Date.now() - (n - i + 1) * 60_000),
        } as never,
        select: { id: true },
      });
      ids.push(row.id);
    }
    return { t, ids };
  }

  const scopeOf = (t: PersonalTenant) => resolveScope({ ownerUserId: t.owner.userId, teamId: t.personalTeamId });
  const settleOne = async (t: PersonalTenant, evidenceId: string) => {
    const scope = await scopeOf(t);
    return prisma.$transaction((tx) => settle({ scope, evidenceId }, tx as never));
  };
  /** What the completion transaction does after settling: decide, and store the earned fact. */
  async function finalize(t: PersonalTenant, evidenceId: string) {
    const scope = await scopeOf(t);
    const settled = await prisma.$transaction((tx) => settle({ scope, evidenceId }, tx as never));
    const decision = finalizationIssuance(scope, settled.funding);
    const { evidenceCreationScope } = await import("../src/services/billing-enforcement.service.js");
    const earned = earnedFactFrom({ plan: evidenceCreationScope(scope).plan as never, decision });
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: {
        status: "SIGNED",
        ...(earned
          ? { outputEarnedPlan: earned.plan, outputEarnedBasis: earned.basis, outputEarnedAtUtc: new Date() }
          : {}),
      },
    });
    return { funding: settled.funding, decision };
  }
  const credits = async (t: PersonalTenant) =>
    (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits;
  const eligibility = (t: PersonalTenant, evidenceId: string) =>
    eligibilityOf({ evidenceId, ownerUserId: t.owner.userId, teamId: t.personalTeamId });
  const billing = async (t: PersonalTenant) =>
    (
      await h.app.inject({
        method: "GET",
        url: `/v1/billing/accounts/PERSONAL/${t.owner.userId}`,
        headers: { authorization: `Bearer ${t.owner.token}` },
      })
    ).json();

  it("PRO → lapsed, below the Free allowance: a new record is admitted and plan-funded as Free (no plan outputs)", async () => {
    const { t } = await proTenantHolding(1);
    await lapse(t);

    const res = await create(t);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const done = await finalize(t, id);
    expect(done.funding).toBe("PLAN");
    expect(done.decision).toMatchObject({ decision: "NOT_ENTITLED", basis: "FREE_PLAN" });
    // Nothing was earned, so nothing is stored and nothing is owed.
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id } });
    expect(row.outputEarnedBasis).toBeNull();
    expect((await eligibility(t, id)).issuance.decision).toBe("NOT_ENTITLED");

    const b = await billing(t);
    expect(b.evidenceAdmission).toMatchObject({
      effectiveLifetimeCap: 3,
      recordsHeld: 2,
      planCapacityRemaining: 1,
      planLapse: { lapsedPlan: "PRO", state: "FREE_ALLOWANCE_AVAILABLE" },
    });
  });

  it("PRO → lapsed, above the Free allowance, no credit: refused honestly with the lapse named", async () => {
    const { t } = await proTenantHolding(10);
    await lapse(t);

    const res = await create(t);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PLAN_LAPSED_ALLOWANCE_EXHAUSTED");
    expect(res.json().message).toMatch(/plan has lapsed/i);
    expect(res.json().message).toMatch(/renew your plan or use an evidence credit/i);

    const b = await billing(t);
    expect(b.evidenceAdmission).toMatchObject({
      effectiveLifetimeCap: 3,
      recordsHeld: 10,
      overCap: true,
      next: { allowed: false },
      planLapse: { lapsedPlan: "PRO", state: "FREE_ALLOWANCE_EXHAUSTED_NO_CREDIT" },
    });
  });

  it("lapsed with a valid credit: the record is admitted, funded by the credit, and earns its outputs", async () => {
    const { t } = await proTenantHolding(10, { credits: 1 });
    await lapse(t);
    expect((await billing(t)).evidenceAdmission.planLapse.state).toBe("FREE_ALLOWANCE_EXHAUSTED_CREDIT_AVAILABLE");

    const res = await create(t);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const done = await finalize(t, id);
    expect(done.funding).toBe("EVIDENCE_CREDIT");
    expect(await credits(t)).toBe(0);
    expect((await eligibility(t, id)).issuance).toMatchObject({ decision: "ENTITLED", basis: "EVIDENCE_CREDIT" });
    // The credit is spent: the next record is refused.
    expect((await create(t)).statusCode).toBe(409);
  });

  it("two lapsed records settling on ONE credit: exactly one is funded, the balance never goes negative", async () => {
    const { t } = await proTenantHolding(10, { credits: 1 });
    await lapse(t);
    // Both drafts are admitted while the credit is unspent.
    const a = await create(t);
    const b = await create(t);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);

    const outcomes = await Promise.allSettled([
      settleOne(t, a.json().id as string),
      settleOne(t, b.json().id as string),
    ]);
    const funded = outcomes.filter((o) => o.status === "fulfilled");
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(funded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((funded[0] as PromiseFulfilledResult<{ funding: string }>).value.funding).toBe("EVIDENCE_CREDIT");
    expect((refused[0] as PromiseRejectedResult).reason?.publicCode ?? (refused[0] as PromiseRejectedResult).reason?.code).toBe(
      "INSUFFICIENT_EVIDENCE_CREDITS",
    );
    expect(await credits(t)).toBe(0);
    expect(
      await prisma.evidenceCreditLedgerEntry.count({ where: { userId: t.owner.userId, entryType: "CONSUMPTION" } }),
    ).toBe(1);
  });

  it("a record finalized while PRO keeps its earned outputs after the lapse; an unearned one is not owed", async () => {
    const { t, ids } = await proTenantHolding(2);
    // Finalized while the plan is paid: the fact is stored on the record.
    const paid = await create(t);
    expect(paid.statusCode).toBe(201);
    const paidId = paid.json().id as string;
    const done = await finalize(t, paidId);
    expect(done.decision).toMatchObject({ decision: "ENTITLED", basis: "PAID_SUBSCRIPTION" });
    const stored = await prisma.evidence.findUniqueOrThrow({ where: { id: paidId } });
    expect(stored).toMatchObject({ outputEarnedPlan: "PRO", outputEarnedBasis: "PAID_SUBSCRIPTION" });

    await lapse(t);

    // The job queued before the lapse still has its entitlement…
    const after = await eligibility(t, paidId);
    expect(after.issuance).toMatchObject({
      decision: "ENTITLED",
      basis: "EARNED_AT_FINALIZATION",
      reportsIncluded: true,
      verificationPackageIncluded: true,
    });
    // …a record with no stored fact (seeded before the fact existed) is decided
    // by the lapsed lifecycle and is not owed anything…
    expect((await eligibility(t, ids[0]!)).issuance).toMatchObject({ decision: "NOT_ENTITLED", basis: "PAYMENT_LAPSED" });
    // …and the owed-backlog population is exactly the earned record.
    const where = await owedWhere({ ownerUserId: t.owner.userId, teamId: t.personalTeamId });
    expect(where).not.toBeNull();
    const owed = await prisma.evidence.findMany({
      where: { AND: [{ ownerUserId: t.owner.userId }, where!] },
      select: { id: true },
    });
    expect(owed.map((r) => r.id)).toEqual([paidId]);
  });

  it("renewal after a lapse restores the plan's creation policy and its outputs", async () => {
    const { t } = await proTenantHolding(10);
    await lapse(t);
    expect((await create(t)).statusCode).toBe(409);

    await renew(t);
    const res = await create(t);
    expect(res.statusCode).toBe(201);
    const done = await finalize(t, res.json().id as string);
    expect(done.funding).toBe("PLAN");
    expect(done.decision).toMatchObject({ decision: "ENTITLED", basis: "PAID_SUBSCRIPTION" });
    expect((await billing(t)).evidenceAdmission.planLapse).toBeUndefined();
  });

  it("existing evidence and an already-issued report answer the same while lapsed as while paid", async () => {
    const { t, ids } = await proTenantHolding(4);
    await prisma.report.create({
      data: {
        evidenceId: ids[0]!,
        version: 1,
        storageBucket: process.env.S3_BUCKET ?? "proovra-test",
        storageKey: `reports/${ids[0]!}/v1.pdf`,
        generatedAtUtc: new Date(),
      } as never,
    });
    await prisma.evidence.update({ where: { id: ids[0]! }, data: { status: "REPORTED" } });
    const get = (url: string) =>
      h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${t.owner.token}` } });

    const paidRead = await get(`/v1/evidence/${ids[0]!}`);
    const paidReport = await get(`/v1/evidence/${ids[0]!}/report/latest`);
    expect(paidRead.statusCode).toBe(200);
    // The report row exists; whether its object does is a storage answer
    // (200 with a URL, or 410 for a missing object) — never a commercial one.
    expect([200, 410]).toContain(paidReport.statusCode);

    await lapse(t);
    await clearRates();
    expect((await get(`/v1/evidence/${ids[0]!}`)).statusCode).toBe(200);
    const lapsedReport = await get(`/v1/evidence/${ids[0]!}/report/latest`);
    expect(lapsedReport.statusCode).toBe(paidReport.statusCode);
  });

  it("a SUSPENDED organization is still refused, and owner credits do not open it: the lapse fallback loosens no security gate", async () => {
    const active = await seedOrganizationTenant(deps, { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    const createIn = (o: OrganizationTenant) =>
      h.app.inject({
        method: "POST",
        url: "/v1/evidence",
        headers: { authorization: `Bearer ${o.owner.token}`, "content-type": "application/json" },
        payload: { type: "PHOTO", mimeType: "image/jpeg", teamId: o.workspaceId },
      });
    // Control: the same request in an ACTIVE organization is admitted.
    expect((await createIn(active)).statusCode).toBe(201);

    const suspended = await seedOrganizationTenant(deps, {
      status: "SUSPENDED",
      billingPlan: "ENTERPRISE",
      billingStatus: "ACTIVE",
    });
    // A full wallet on the owner's personal account is not a way in.
    await prisma.entitlement.updateMany({ where: { userId: suspended.owner.userId, active: true }, data: { credits: 5 } });
    const refused = await createIn(suspended);
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.statusCode).toBeLessThan(500);
    // Not a commercial answer: no allowance or lapse code, and nothing written.
    expect(["FREE_LIMIT_REACHED", "PLAN_LAPSED_ALLOWANCE_EXHAUSTED", "COMMERCIAL_LIFECYCLE_RESTRICTED"]).not.toContain(
      refused.json().code,
    );
    expect(await prisma.evidence.count({ where: { teamId: suspended.workspaceId } })).toBe(0);
  });

  it("a lapsed SHARED workspace has no Free-equivalent: creation is still refused with the lifecycle code", async () => {
    const org = await seedOrganizationTenant(deps, { billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await prisma.subscription.create({
      data: {
        userId: org.owner.userId,
        teamId: org.workspaceId,
        provider: "STRIPE",
        providerSubId: `sub_${deps.tag}_ws_${Math.random().toString(36).slice(2)}`,
        status: "PAST_DUE",
        plan: "TEAM",
        currentPeriodEnd: new Date(Date.now() - 8 * DAY),
      } as never,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${org.owner.token}`, "content-type": "application/json" },
      payload: { type: "PHOTO", mimeType: "image/jpeg", teamId: org.workspaceId },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe("COMMERCIAL_LIFECYCLE_RESTRICTED");
    expect(await prisma.evidence.count({ where: { teamId: org.workspaceId } })).toBe(0);
  });
});
