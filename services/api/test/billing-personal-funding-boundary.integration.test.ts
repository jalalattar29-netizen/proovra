/**
 * BILLING PRODUCTION CLOSURE — the personal Evidence funding boundary, against
 * live PostgreSQL 16.
 *
 * THE DEFECT THIS PINS
 * ---------------------------------------------------------------------------
 * `completeEvidence` used to compute "records held before this one" with a
 * plain count taken at a moment when the record being completed already
 * existed and was committed. FREE's third record therefore evaluated
 * `3 < 3` and demanded a paid credit: with no credit the completion failed
 * 402, and with one banked credit it spent it on a record the plan already
 * covered — after which the fourth record was refused and the purchase had
 * bought nothing at all.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * The records are created through `POST /v1/evidence` on the booted production
 * app, so the creation gate, scope resolution and tenancy all run for real.
 * The funding decision is then driven through the REAL production settlement
 * boundary — `settleEvidenceCompletionFunding`, invoked inside a real
 * interactive transaction exactly as `completeEvidence` invokes it — against
 * the real entitlement row and the real credit ledger.
 *
 * WHAT IS NOT COVERED HERE, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * `completeEvidence` also performs object-store reads, hashing, signing and
 * timestamping. None of those participate in the funding decision, and this
 * suite does not stand them up. It proves the commercial boundary, not the
 * integrity envelope; `phase-12-sec-001-completion.integration.test.ts` and
 * the worker suites own that.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedPersonalTenant,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

describe("BILLING — personal evidence funding boundary (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let settle: typeof import("../src/services/billing-enforcement.service.js")["settleEvidenceCompletionFunding"];
  let resolveScope: typeof import("../src/services/workspace-billing.service.js")["getPersonalWorkspaceScope"];
  let resolveOutputs: typeof import("../src/services/billing-enforcement.service.js")["resolveEvidenceOutputs"];

  const inject = (opts: {
    method: "GET" | "POST";
    url: string;
    token: string;
    payload?: unknown;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  /** Create ONE record through the real route. Returns its id. */
  async function createRecord(t: PersonalTenant, title: string): Promise<string> {
    const res = await inject({
      method: "POST",
      url: "/v1/evidence",
      token: t.owner.token,
      payload: { title, type: "PHOTO" },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return (JSON.parse(res.body) as { id: string }).id;
  }

  /**
   * Settle ONE completion exactly as `completeEvidence` does: inside an
   * interactive transaction, with that transaction's client.
   */
  async function settleOne(ownerUserId: string, evidenceId: string) {
    const scope = await resolveScope(ownerUserId);
    return prisma.$transaction((tx) =>
      settle({ scope, evidenceId }, tx as never),
    );
  }

  /** Available credits straight off the column the decrement guards. */
  async function creditsOf(userId: string): Promise<number> {
    const row = await prisma.entitlement.findFirst({
      where: { userId, active: true },
      orderBy: { createdAt: "desc" },
      select: { credits: true },
    });
    return row?.credits ?? 0;
  }

  async function consumptionRowsFor(evidenceId: string): Promise<number> {
    return prisma.evidenceCreditLedgerEntry.count({
      where: { evidenceId, entryType: "CONSUMPTION" },
    });
  }

  /**
   * Seed `count` already-held records directly, the way the PRO boundary needs
   * them: the interesting rows are 99/100/101, and driving ninety-eight full
   * requests to reach them would buy no additional coverage.
   */
  async function seedHeldRecords(t: PersonalTenant, count: number) {
    for (let i = 0; i < count; i += 1) {
      await prisma.evidence.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO",
        },
      });
    }
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ settleEvidenceCompletionFunding: settle, resolveEvidenceOutputs: resolveOutputs } =
      await import("../src/services/billing-enforcement.service.js"));
    ({ getPersonalWorkspaceScope: resolveScope } = await import(
      "../src/services/workspace-billing.service.js"
    ));

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `bpfb-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };
    void bootstrapPersonalSpace;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // FREE with no credits — the three included records must all complete
  // =========================================================================
  describe("FREE without credits", () => {
    it("records 1, 2 and 3 all complete as PLAN and spend nothing", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });

      for (const n of [1, 2, 3]) {
        const id = await createRecord(t, `free-${n}`);
        const settled = await settleOne(t.owner.userId, id);
        expect(settled.funding, `record ${n} must be plan-funded`).toBe("PLAN");
        expect(await consumptionRowsFor(id)).toBe(0);
      }

      // The wallet was never touched.
      expect(await creditsOf(t.owner.userId)).toBe(0);
      expect(
        await prisma.evidenceCreditLedgerEntry.count({
          where: { userId: t.owner.userId },
        }),
      ).toBe(0);
    });

    it("record 4 is refused, and the refusal writes nothing", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      await seedHeldRecords(t, 3);

      // The creation gate itself refuses the fourth record.
      const denied = await inject({
        method: "POST",
        url: "/v1/evidence",
        token: t.owner.token,
        payload: { title: "free-4", type: "PHOTO" },
      });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      expect(denied.body).toContain("FREE_LIMIT_REACHED");

      // And so does settlement, if a record ever reached it.
      const fourth = await prisma.evidence.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO",
        },
      });
      await expect(settleOne(t.owner.userId, fourth.id)).rejects.toMatchObject({
        publicCode: "INSUFFICIENT_EVIDENCE_CREDITS",
      });
      expect(await creditsOf(t.owner.userId)).toBe(0);
      expect(await consumptionRowsFor(fourth.id)).toBe(0);
    });
  });

  // =========================================================================
  // FREE with one credit — the credit buys the FOURTH record, not the third
  // =========================================================================
  describe("FREE with one purchased credit", () => {
    it("keeps the credit through records 1-3 and spends it on record 4", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });

      const planFunded: string[] = [];
      for (const n of [1, 2, 3]) {
        const id = await createRecord(t, `credit-${n}`);
        const settled = await settleOne(t.owner.userId, id);
        expect(settled.funding, `record ${n} must be plan-funded`).toBe("PLAN");
        planFunded.push(id);
      }

      // THE regression this suite exists for: the third record is free.
      expect(await creditsOf(t.owner.userId)).toBe(1);
      for (const id of planFunded) expect(await consumptionRowsFor(id)).toBe(0);

      const fourth = await prisma.evidence.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO",
        },
      });
      const settled = await settleOne(t.owner.userId, fourth.id);
      expect(settled.funding).toBe("EVIDENCE_CREDIT");
      expect(await creditsOf(t.owner.userId)).toBe(0);
      expect(await consumptionRowsFor(fourth.id)).toBe(1);

      // Retrying the SAME record spends nothing further.
      const again = await settleOne(t.owner.userId, fourth.id);
      expect(again.funding).toBe("EVIDENCE_CREDIT");
      expect(await creditsOf(t.owner.userId)).toBe(0);
      expect(await consumptionRowsFor(fourth.id)).toBe(1);
    });

    it("a completion that rolls back returns the credit", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
      await seedHeldRecords(t, 3);
      const fourth = await prisma.evidence.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO",
        },
      });

      const scope = await resolveScope(t.owner.userId);
      const boom = new Error("completion failed after settlement");
      await expect(
        prisma.$transaction(async (tx) => {
          await settle({ scope, evidenceId: fourth.id }, tx as never);
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(await creditsOf(t.owner.userId)).toBe(1);
      expect(await consumptionRowsFor(fourth.id)).toBe(0);
    });

    it("two concurrent completions with one credit fund exactly one", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
      await seedHeldRecords(t, 3);
      const [a, b] = await Promise.all([
        prisma.evidence.create({
          data: {
            ownerUserId: t.owner.userId,
            teamId: t.personalTeamId,
            organizationId: t.personalOrganizationId,
            type: "PHOTO",
          },
        }),
        prisma.evidence.create({
          data: {
            ownerUserId: t.owner.userId,
            teamId: t.personalTeamId,
            organizationId: t.personalOrganizationId,
            type: "PHOTO",
          },
        }),
      ]);

      const results = await Promise.allSettled([
        settleOne(t.owner.userId, a.id),
        settleOne(t.owner.userId, b.id),
      ]);
      const funded = results.filter(
        (r) => r.status === "fulfilled" && r.value.funding === "EVIDENCE_CREDIT",
      );
      expect(funded.length, "exactly one completion may take the last credit").toBe(1);
      expect(await creditsOf(t.owner.userId)).toBe(0);
      expect(
        (await consumptionRowsFor(a.id)) + (await consumptionRowsFor(b.id)),
      ).toBe(1);
    });

    it("a credit-funded record earns report, package and public verify on FREE", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
      await seedHeldRecords(t, 3);
      const fourth = await prisma.evidence.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO",
        },
      });
      const settled = await settleOne(t.owner.userId, fourth.id);

      const outputs = resolveOutputs({ plan: "FREE", funding: settled.funding });
      expect(outputs.reportsIncluded).toBe(true);
      expect(outputs.verificationPackageIncluded).toBe(true);
      expect(outputs.publicVerifyIncluded).toBe(true);

      // The ACCOUNT is untouched: no plan promotion, no account-wide grant.
      const entitlement = await prisma.entitlement.findFirst({
        where: { userId: t.owner.userId, active: true },
        select: { plan: true },
      });
      expect(entitlement?.plan).toBe("FREE");
      const planOnly = resolveOutputs({ plan: "FREE", funding: "PLAN" });
      expect(planOnly.reportsIncluded).toBe(false);
      expect(planOnly.verificationPackageIncluded).toBe(false);
    });
  });

  // =========================================================================
  // PRO — the same boundary one hundred records further along
  // =========================================================================
  describe("PRO lifetime boundary", () => {
    it("record 100 is plan-funded and record 101 is refused", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 0 });
      // 99 already held; the boundary rows are created and settled for real.
      await seedHeldRecords(t, 99);

      const hundredth = await createRecord(t, "pro-100");
      const settled = await settleOne(t.owner.userId, hundredth);
      expect(settled.funding).toBe("PLAN");
      expect(await consumptionRowsFor(hundredth)).toBe(0);
      expect(await creditsOf(t.owner.userId)).toBe(0);

      const denied = await inject({
        method: "POST",
        url: "/v1/evidence",
        token: t.owner.token,
        payload: { title: "pro-101", type: "PHOTO" },
      });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      expect(denied.body).toContain("EVIDENCE_RECORD_LIMIT_REACHED");
    });

    it("record 101 completes when a credit is available", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { credits: 1 });
      await seedHeldRecords(t, 100);
      const overflow = await prisma.evidence.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO",
        },
      });
      const settled = await settleOne(t.owner.userId, overflow.id);
      expect(settled.funding).toBe("EVIDENCE_CREDIT");
      expect(await creditsOf(t.owner.userId)).toBe(0);
    });
  });

  // =========================================================================
  // A trashed record releases its slot — the exclusion must not change that
  // =========================================================================
  it("a trashed record frees a slot and the freed slot is plan-funded", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
    await seedHeldRecords(t, 2);
    const trashed = await prisma.evidence.create({
      data: {
        ownerUserId: t.owner.userId,
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        type: "PHOTO",
        deletedAt: new Date(),
      },
    });
    void trashed;

    const next = await createRecord(t, "after-trash");
    const settled = await settleOne(t.owner.userId, next);
    expect(settled.funding).toBe("PLAN");
    expect(await creditsOf(t.owner.userId)).toBe(0);
  });
});
