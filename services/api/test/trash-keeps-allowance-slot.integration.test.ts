/**
 * ET-COM-02 — a trashed record keeps its allowance slot and its funding.
 * Live PostgreSQL 16, real HTTP.
 *
 * Owner decision (2026-09-30): trash is reversible and must not release
 * capacity. On a40ca76f the record count excluded trashed rows and restore ran
 * no admission, so a FREE account at 3/3 could trash one record, create a
 * fourth, and restore the first — four plan-funded records, repeatable for the
 * whole 90-day grace. Only governed destruction releases a slot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

describe("trash keeps the allowance slot (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let clearRates: () => Promise<unknown>;
  let countHeld: (typeof import("../src/services/billing-enforcement.service.js"))["countPersonalEvidenceRecords"];
  let resolveScope: (typeof import("../src/services/billing-enforcement.service.js"))["resolveEnforcementScopeForRequester"];
  let settle: (typeof import("../src/services/billing-enforcement.service.js"))["settleEvidenceCompletionFunding"];
  let usageOf: (typeof import("../src/services/workspace-usage.service.js"))["getWorkspaceUsage"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    ({
      countPersonalEvidenceRecords: countHeld,
      resolveEnforcementScopeForRequester: resolveScope,
      settleEvidenceCompletionFunding: settle,
    } = await import("../src/services/billing-enforcement.service.js"));
    ({ getWorkspaceUsage: usageOf } = await import("../src/services/workspace-usage.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `com02-${Date.now().toString(36)}`,
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

  const call = (method: "POST" | "DELETE", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { payload: payload as never } : {}),
    });
  const create = (t: PersonalTenant) => call("POST", "/v1/evidence", t.owner.token, { type: "PHOTO", mimeType: "image/jpeg" });
  const trash = (t: PersonalTenant, id: string) => call("DELETE", `/v1/evidence/${id}`, t.owner.token);
  const restore = (t: PersonalTenant, id: string) =>
    call("POST", `/v1/evidence/${id}/restore`, t.owner.token, { restore: true });

  /** A FREE Personal Space holding exactly `n` signed records. Returns their ids, oldest first. */
  async function freeTenantHolding(n: number, opts: { credits?: number } = {}): Promise<{ t: PersonalTenant; ids: string[] }> {
    const t = await seedPersonalTenant(deps, "FREE", opts);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const row = await prisma.evidence.create({
        data: {
          title: `com02-${i}`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          ownerUserId: t.owner.userId,
          createdAt: new Date(Date.now() - (n - i) * 60_000),
        } as never,
        select: { id: true },
      });
      ids.push(row.id);
    }
    return { t, ids };
  }

  const meters = async (t: PersonalTenant) => {
    const scope = await resolveScope({ ownerUserId: t.owner.userId, teamId: null });
    return { gate: await countHeld(t.owner.userId), usage: (await usageOf(scope)).evidenceCount };
  };

  it("FREE 3/3 → trash one → a fourth is refused, and every meter still reads 3", async () => {
    const { t, ids } = await freeTenantHolding(3);
    expect((await trash(t, ids[0]!)).statusCode).toBe(200);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ids[0]! } })).lifecycleState).toBe("TRASHED");

    expect(await meters(t)).toEqual({ gate: 3, usage: 3 });
    const fourth = await create(t);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe("FREE_LIMIT_REACHED");

    // Billing states the same number, says one of them is in Trash, and the
    // next-record decision it shows is the refusal the gate just gave.
    const billing = await h.app.inject({
      method: "GET",
      url: `/v1/billing/accounts/PERSONAL/${t.owner.userId}`,
      headers: { authorization: `Bearer ${t.owner.token}` },
    });
    expect(billing.statusCode).toBe(200);
    const body = billing.json();
    expect(body.usage.evidence).toMatchObject({ state: "MEASURED", used: 3, limit: 3 });
    expect(body.evidenceAdmission).toMatchObject({
      recordsHeld: 3,
      recordsInTrash: 1,
      planCapacityRemaining: 0,
      next: { allowed: false },
    });
  });

  it("FREE 3/3 → trash → restore: the restore succeeds, consumes nothing, and the account holds 3", async () => {
    const { t, ids } = await freeTenantHolding(3, { credits: 2 });
    expect((await trash(t, ids[1]!)).statusCode).toBe(200);
    expect((await restore(t, ids[1]!)).statusCode).toBe(200);

    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ids[1]! } })).lifecycleState).toBe("ACTIVE");
    expect(await meters(t)).toEqual({ gate: 3, usage: 3 });
    // No credit was spent on re-admitting a record that never left.
    const ent = await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } });
    expect(ent.credits).toBe(2);
    expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: ids[1]! } })).toBe(0);
  });

  it("concurrent trash and create at 3/3: the create is refused whichever commits first", async () => {
    for (let round = 0; round < 4; round++) {
      const { t, ids } = await freeTenantHolding(3);
      const [tr, cr] = await Promise.all([trash(t, ids[0]!), create(t)]);
      expect(tr.statusCode).toBe(200);
      expect(cr.statusCode).toBe(409);
      expect((await meters(t)).gate).toBe(3);
    }
  });

  it("concurrent create and restore with one of three trashed: never a fourth record", async () => {
    for (let round = 0; round < 4; round++) {
      const { t, ids } = await freeTenantHolding(3);
      expect((await trash(t, ids[2]!)).statusCode).toBe(200);
      const [rs, cr] = await Promise.all([restore(t, ids[2]!), create(t)]);
      expect(rs.statusCode).toBe(200);
      expect(cr.statusCode).toBe(409);
      expect(await meters(t)).toEqual({ gate: 3, usage: 3 });
    }
  });

  it("a credit-funded record keeps its one credit allocation through trash and restore", async () => {
    // Three plan-funded records, then a fourth admitted on a purchased credit.
    const { t } = await freeTenantHolding(3, { credits: 1 });
    const fourth = await create(t);
    expect(fourth.statusCode).toBe(201);
    const id = fourth.json().id as string;
    const settleOnce = async () => {
      const scope = await resolveScope({ ownerUserId: t.owner.userId, teamId: t.personalTeamId });
      return prisma.$transaction((tx) => settle({ scope, evidenceId: id }, tx as never));
    };
    expect((await settleOnce()).funding).toBe("EVIDENCE_CREDIT");
    await prisma.evidence.update({ where: { id }, data: { status: "SIGNED" } });
    const credits = async () =>
      (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits;
    expect(await credits()).toBe(0);

    expect((await trash(t, id)).statusCode).toBe(200);
    expect(await meters(t)).toEqual({ gate: 4, usage: 4 });
    expect((await restore(t, id)).statusCode).toBe(200);

    // The same allocation, once: settling again is a no-op on the same funding fact.
    expect((await settleOnce()).funding).toBe("EVIDENCE_CREDIT");
    expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: id, entryType: "CONSUMPTION" } })).toBe(1);
    expect(await credits()).toBe(0);
    expect(await meters(t)).toEqual({ gate: 4, usage: 4 });
  });

  it("a permanently DESTROYED record releases its slot; a record pending destruction does not", async () => {
    const { t, ids } = await freeTenantHolding(3);
    expect((await trash(t, ids[0]!)).statusCode).toBe(200);

    await prisma.evidence.update({ where: { id: ids[0]! }, data: { lifecycleState: "PENDING_DESTRUCTION" } });
    expect((await meters(t)).gate).toBe(3);
    expect((await create(t)).statusCode).toBe(409);

    await prisma.evidence.update({ where: { id: ids[0]! }, data: { lifecycleState: "DESTROYED" } });
    expect(await meters(t)).toEqual({ gate: 2, usage: 2 });
    expect((await create(t)).statusCode).toBe(201);
  });

  it("a released unsealed reservation holds no slot", async () => {
    const { t } = await freeTenantHolding(2);
    const draft = await create(t);
    expect(draft.statusCode).toBe(201);
    await prisma.evidence.update({ where: { id: draft.json().id as string }, data: { deletedAt: new Date() } });
    expect(await meters(t)).toEqual({ gate: 2, usage: 2 });
  });
});
