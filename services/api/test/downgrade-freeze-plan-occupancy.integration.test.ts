/**
 * F-07 (Free-user audit, 2026-11-13) — the downgrade grandfather is frozen from
 * the SAME "plan-occupying record" the gate and settlement count.
 *
 * THE DEFECT THIS PINS
 * ---------------------------------------------------------------------------
 * `setPersonalPlan` froze `legacyRecordCapOverride` from
 * `countPersonalEvidenceRecords` — every slot-holding record, credit-funded
 * ones included — while admission and settlement compare that cap with
 * `planOccupying`, which excludes them. A Free account holding 3 plan records
 * and 2 credit-funded records that upgraded and cancelled was frozen at 5 and
 * then admitted two more PLAN-funded (FREE_ALLOWANCE) records; every cycle
 * repeated it. A repeated FREE write (a duplicate cancel event) did the same
 * without any upgrade at all.
 *
 * WHAT IS REAL: PostgreSQL 16, the production plan writer (`setPersonalPlan`),
 * the production scope resolver, admission and settlement. Records are seeded
 * as rows (sealed / unsealed) with real credit-ledger CONSUMPTION rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

describe("F-07 — downgrade freeze uses the gate's plan-occupying count (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let enforcement: typeof import("../src/services/billing-enforcement.service.js");
  let setPersonalPlan: (typeof import("../src/services/billing.service.js"))["setPersonalPlan"];

  beforeAll(async () => {
    process.env.S3_BUCKET = process.env.S3_BUCKET || "freeze-test-bucket";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    enforcement = await import("../src/services/billing-enforcement.service.js");
    ({ setPersonalPlan } = await import("../src/services/billing.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `frz-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function seedRecord(
    t: PersonalTenant,
    status: "SIGNED" | "UPLOADING",
    extra: { lifecycleState?: "TRASHED"; deletedAt?: Date; teamId?: string | null } = {},
  ) {
    const row = await prisma.evidence.create({
      data: {
        ownerUserId: t.owner.userId,
        teamId: extra.teamId === undefined ? t.personalTeamId : extra.teamId,
        organizationId: extra.teamId === null ? null : t.personalOrganizationId,
        type: "PHOTO",
        status,
        ...(extra.lifecycleState ? { lifecycleState: extra.lifecycleState } : {}),
        ...(extra.deletedAt ? { deletedAt: extra.deletedAt } : {}),
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  /** A sealed record funded by a consumed credit (ledger CONSUMPTION row, as settlement writes it). */
  async function seedCreditFunded(t: PersonalTenant) {
    const id = await seedRecord(t, "SIGNED");
    await prisma.evidenceCreditLedgerEntry.create({
      data: { userId: t.owner.userId, entryType: "CONSUMPTION", creditsDelta: -1, balanceAfter: 0, evidenceId: id },
    });
    return id;
  }

  const overrideOf = async (userId: string) =>
    (await prisma.entitlement.findFirstOrThrow({ where: { userId, active: true }, select: { legacyRecordCapOverride: true } }))
      .legacyRecordCapOverride;

  const admit = async (t: PersonalTenant) =>
    enforcement.assertWorkspaceAllowsEvidenceCreation(
      await enforcement.resolveEnforcementScopeForRequester({ ownerUserId: t.owner.userId, teamId: null }),
    );

  const occupancy = (userId: string) => prisma.$transaction((tx) => enforcement.measurePersonalPlanOccupancy(userId, tx as never));

  const settle = async (t: PersonalTenant, evidenceId: string) => {
    const scope = await enforcement.resolveEnforcementScopeForRequester({ ownerUserId: t.owner.userId, teamId: t.personalTeamId });
    // As completeEvidence does: the funding settlement and the seal commit together.
    return prisma.$transaction(async (tx) => {
      const settled = await enforcement.settleEvidenceCompletionFunding({ scope, evidenceId }, tx as never);
      await tx.evidence.update({ where: { id: evidenceId }, data: { status: "SIGNED", signedAtUtc: new Date() } as never });
      return settled;
    });
  };

  it("credit-funded records never become Free plan slots, across repeated upgrade/downgrade cycles", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    for (let i = 0; i < 3; i++) await seedRecord(t, "SIGNED");
    const credited = [await seedCreditFunded(t), await seedCreditFunded(t)];
    expect(await occupancy(t.owner.userId)).toBe(3);
    await expect(admit(t)).rejects.toMatchObject({ publicCode: "FREE_LIMIT_REACHED" });

    // A duplicate FREE write (e.g. a re-delivered cancel event) grants nothing.
    await setPersonalPlan(t.owner.userId, "FREE");
    expect(await overrideOf(t.owner.userId)).toBeNull();
    await expect(admit(t)).rejects.toMatchObject({ publicCode: "FREE_LIMIT_REACHED" });

    for (let cycle = 0; cycle < 3; cycle++) {
      await setPersonalPlan(t.owner.userId, "PRO");
      expect(await overrideOf(t.owner.userId), `cycle ${cycle}: PRO`).toBeNull();
      await setPersonalPlan(t.owner.userId, "FREE");
      // Before F-07 this froze at 5 (3 plan + 2 credit-funded) and admitted two more PLAN records.
      expect(await overrideOf(t.owner.userId), `cycle ${cycle}: FREE`).toBeNull();
      await expect(admit(t), `cycle ${cycle}`).rejects.toMatchObject({ publicCode: "FREE_LIMIT_REACHED" });
    }

    // What each credit bought stays bought.
    expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: { in: credited }, entryType: "CONSUMPTION" } })).toBe(2);
    expect(await prisma.evidence.count({ where: { id: { in: credited }, deletedAt: null } })).toBe(2);
  }, 120_000);

  it("a paid history above the Free allowance freezes at the SEALED plan-occupying count: trashed and legacy count, live unsealed and credit-funded do not", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    for (let i = 0; i < 3; i++) await seedRecord(t, "SIGNED");
    await seedRecord(t, "SIGNED", { lifecycleState: "TRASHED", deletedAt: new Date() }); // trash keeps its slot
    await seedRecord(t, "SIGNED", { teamId: null }); // legacy NULL-team row
    await seedRecord(t, "UPLOADING"); // a live reservation admitted under PRO — not a record that exists (PRO-BL2-01)
    await seedCreditFunded(t);
    expect(await occupancy(t.owner.userId)).toBe(5);

    await setPersonalPlan(t.owner.userId, "FREE");
    expect(await overrideOf(t.owner.userId)).toBe(5);
    // At the frozen cap, nothing more is admitted without a credit…
    await expect(admit(t)).rejects.toMatchObject({ publicCode: "FREE_LIMIT_REACHED" });
    // …and the reservation admitted under PRO, sealed on FREE above the frozen
    // history, needs a credit like any other over-cap record.
    const inFlight = (await prisma.evidence.findFirstOrThrow({ where: { ownerUserId: t.owner.userId, status: "UPLOADING" }, select: { id: true } })).id;
    await expect(settle(t, inFlight)).rejects.toBeTruthy();
    expect(await occupancy(t.owner.userId)).toBe(5);
  }, 120_000);

  it("PRO-BL2-01 — drafts alive at the downgrade mint no lifetime plan slots once they are gone", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    for (let i = 0; i < 4; i++) await seedRecord(t, "SIGNED");
    const drafts: string[] = [];
    for (let i = 0; i < 6; i++) drafts.push(await seedRecord(t, "UPLOADING"));

    await setPersonalPlan(t.owner.userId, "FREE");
    // At the base this froze at 10 (4 sealed + 6 releasable reservations).
    expect(await overrideOf(t.owner.userId)).toBe(4);

    // The drafts are deleted (or expire): nothing they held survives.
    await prisma.evidence.updateMany({ where: { id: { in: drafts } }, data: { deletedAt: new Date() } as never });
    await expect(admit(t)).rejects.toMatchObject({ publicCode: "FREE_LIMIT_REACHED" });
  }, 120_000);

  it("concurrent settlement and downgrade: the freeze counts the in-flight record only if it sealed first, and nothing more is admitted", async () => {
    for (let round = 0; round < 3; round++) {
      const t = await seedPersonalTenant(deps, "PRO");
      for (let i = 0; i < 4; i++) await seedRecord(t, "SIGNED");
      const inFlight = await seedRecord(t, "UPLOADING");

      const [settled] = await Promise.allSettled([settle(t, inFlight), setPersonalPlan(t.owner.userId, "FREE")]);
      if (settled.status === "fulfilled") expect(settled.value.funding).toBe("PLAN");
      // Sealed before the freeze: counted (5). Not yet sealed: never counted
      // (4) — a settlement that read the paid scope before the plan write may
      // still seal it on that scope, but no RESERVATION becomes a frozen slot.
      expect([4, 5], `round ${round}`).toContain(await overrideOf(t.owner.userId));
      await expect(admit(t)).rejects.toMatchObject({ publicCode: "FREE_LIMIT_REACHED" });
    }
  }, 120_000);

  it("a credit-funded settlement that commits before the downgrade is excluded from the freeze", async () => {
    const t = await seedPersonalTenant(deps, "PRO", { legacyRecordCapOverride: 4, credits: 1 });
    for (let i = 0; i < 4; i++) await seedRecord(t, "SIGNED");
    const overCap = await seedRecord(t, "UPLOADING");
    expect((await settle(t, overCap)).funding).toBe("EVIDENCE_CREDIT");

    await setPersonalPlan(t.owner.userId, "FREE");
    expect(await overrideOf(t.owner.userId)).toBe(4);
    await expect(admit(t)).rejects.toMatchObject({ publicCode: "FREE_LIMIT_REACHED" });
  }, 120_000);

  it("an uncapped plan clears the frozen number; the next downgrade recomputes it", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { legacyRecordCapOverride: 9 });
    for (let i = 0; i < 4; i++) await seedRecord(t, "SIGNED");
    await setPersonalPlan(t.owner.userId, "TEAM");
    expect(await overrideOf(t.owner.userId)).toBeNull();
    await setPersonalPlan(t.owner.userId, "FREE");
    expect(await overrideOf(t.owner.userId)).toBe(4);
  }, 120_000);

  // AUDIT E-04 (2026-11-14) — the Team rolling-30-day Billing meter reads the
  // gate's count over the same window: credit-funded records are not plan use.
  it("E-04: the Team rolling-window meter shows the gate's plan-occupying count, not every slot row", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    for (let i = 0; i < 2; i++) await seedRecord(t, "SIGNED");
    await seedRecord(t, "UPLOADING");
    await seedCreditFunded(t);
    await seedCreditFunded(t);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const gate = await enforcement.readPersonalAdmissionInputs(t.owner.userId, { credits: 0, cap: null, since });
    expect(gate.planOccupying).toBe(3);

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/billing/accounts/PERSONAL/${t.owner.userId}`,
      headers: { authorization: `Bearer ${t.owner.token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().usage.evidence).toMatchObject({ state: "MEASURED", used: 3, window: "ROLLING_30_DAYS" });
  }, 120_000);
});
