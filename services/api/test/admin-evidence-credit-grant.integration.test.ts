/**
 * THE PLATFORM-ADMIN EVIDENCE CREDIT GRANT, against live PostgreSQL 16.
 *
 * WHY THIS MECHANISM EXISTS
 * ---------------------------------------------------------------------------
 * The evidence-credit wallet had exactly one way to gain credits: a completed
 * Stripe or PayPal payment. Support remediation, goodwill and controlled
 * internal testing had no mechanism at all — and the workaround for that is
 * always the same, a PURCHASE row asserting a payment that never happened, in
 * the one table whose purpose is to prove where every credit came from. The
 * customer's own billing history reads that table.
 *
 * WHAT IS PINNED
 * ---------------------------------------------------------------------------
 *   - only a platform admin can grant;
 *   - the grant enters the CANONICAL wallet — same balance column, same
 *     ledger, one increment implementation;
 *   - it is truthful: ADMIN_GRANT, no provider, no provider_ref, and it never
 *     reads back as a purchase;
 *   - it is idempotent at the DATABASE, not at the button;
 *   - it grants credits and NOTHING else — the plan and every allowance are
 *     untouched;
 *   - a granted credit is spent exactly as a bought one is, and never by a
 *     shared workspace.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOwnedWorkspace,
  seedPersonalTenant,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

describe("ADMIN — evidence credit grant (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let admin: { userId: string; token: string };
  let resolveScope: typeof import("../src/services/billing-enforcement.service.js")["resolveEnforcementScopeForRequester"];
  let settle: typeof import("../src/services/billing-enforcement.service.js")["settleEvidenceCompletionFunding"];

  const call = (opts: {
    method: "POST";
    url: string;
    token?: string;
    payload?: unknown;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  /*
   * `null` means NO token. A defaulted parameter cannot express that —
   * passing `undefined` selects the default, so an "unauthenticated" case
   * written that way silently sends the admin token and proves nothing.
   */
  const grant = (payload: unknown, token: string | null = admin.token) =>
    call({
      method: "POST",
      url: "/v1/admin/billing/evidence-credits",
      token: token ?? undefined,
      payload,
    });

  const creditsOf = async (userId: string) =>
    (
      await prisma.entitlement.findFirst({
        where: { userId, active: true },
        orderBy: { createdAt: "desc" },
        select: { credits: true },
      })
    )?.credits ?? 0;

  const planOf = async (userId: string) =>
    (
      await prisma.entitlement.findFirst({
        where: { userId, active: true },
        orderBy: { createdAt: "desc" },
        select: { plan: true, legacyRecordCapOverride: true },
      })
    )!;

  const createRecord = (token: string, teamId: string) =>
    call({
      method: "POST",
      url: "/v1/evidence",
      token,
      payload: { type: "DOCUMENT", mimeType: "text/plain", teamId },
    });

  /** Settle exactly as completeEvidence does: scope from the persisted row. */
  async function settleOne(evidenceId: string) {
    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { ownerUserId: true, teamId: true },
    });
    const scope = await resolveScope({
      ownerUserId: ev.ownerUserId,
      teamId: ev.teamId,
    });
    return prisma.$transaction((tx) => settle({ scope, evidenceId }, tx as never));
  }

  async function holdExactly(t: PersonalTenant, count: number) {
    const have = await prisma.evidence.count({
      where: {
        ownerUserId: t.owner.userId,
        deletedAt: null,
        lifecycleState: { not: "DESTROYED" },
        OR: [{ teamId: null }, { teamId: t.personalTeamId }],
      },
    });
    if (have < count) {
      await prisma.evidence.createMany({
        data: Array.from({ length: count - have }, () => ({
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO" as const,
        })),
      });
    }
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({
      resolveEnforcementScopeForRequester: resolveScope,
      settleEvidenceCompletionFunding: settle,
    } = await import("../src/services/billing-enforcement.service.js"));

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `aecg-${Date.now().toString(36)}`,
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

    // A REAL platform admin: the authority is read from persisted state on
    // every request, so the fixture sets the state rather than the claim.
    const staff = await seedUser(deps, "platform-admin");
    await prisma.user.update({
      where: { id: staff.userId },
      data: { platformRole: "admin" },
    });
    admin = { userId: staff.userId, token: staff.token };
  });

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // =========================================================================
  // AUTHORIZATION — this is not workspace-admin functionality.
  // =========================================================================
  describe("authorization", () => {
    it("refuses an unauthenticated caller", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const res = await grant(
        {
          userId: t.owner.userId,
          credits: 5,
          reason: "unauthenticated probe",
          idempotencyKey: "key-1",
        },
        null,
      );
      expect(res.statusCode).toBe(401);
      expect(await creditsOf(t.owner.userId)).toBe(0);
    });

    it("refuses a workspace OWNER who is not platform staff", async () => {
      /*
       * The distinction that matters. This user owns a workspace, holds a paid
       * plan and is an admin of everything they can see — and none of that is
       * authority over the platform's own wallet.
       */
      const t = await seedPersonalTenant(deps, "TEAM");
      await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      const res = await grant(
        { userId: t.owner.userId, credits: 5, reason: "self grant attempt", idempotencyKey: "key-2" },
        t.owner.token,
      );
      expect(res.statusCode).toBe(403);
      expect(await creditsOf(t.owner.userId)).toBe(0);
    });

    it("refuses a grant to an account that does not exist", async () => {
      const res = await grant({
        userId: "00000000-0000-4000-8000-0000000000ff",
        credits: 5,
        reason: "grant to a missing account",
        idempotencyKey: "key-3",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // THE GRANT — canonical wallet, truthful ledger, bounded input.
  // =========================================================================
  describe("the grant", () => {
    it("credits the canonical wallet and records ONE truthful ledger row", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const before = await planOf(t.owner.userId);

      const res = await grant({
        userId: t.owner.userId,
        credits: 50,
        reason: "INC-4711 support remediation",
        idempotencyKey: "INC-4711",
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as {
        applied: boolean;
        previousBalance: number;
        balanceAfter: number;
        grantRef: string;
      };
      expect(body.applied).toBe(true);
      expect(body.previousBalance).toBe(0);
      expect(body.balanceAfter).toBe(50);
      expect(body.grantRef).toBe(`${t.owner.userId}:INC-4711`);

      // The ENFORCED balance — the column the conditional decrement guards.
      expect(await creditsOf(t.owner.userId)).toBe(50);

      const rows = await prisma.evidenceCreditLedgerEntry.findMany({
        where: { userId: t.owner.userId },
      });
      expect(rows).toHaveLength(1);
      const [entry] = rows;
      expect(entry.entryType).toBe("ADMIN_GRANT");
      expect(entry.creditsDelta).toBe(50);
      expect(entry.balanceAfter).toBe(50);
      expect(entry.grantRef).toBe(`${t.owner.userId}:INC-4711`);
      // NOT a purchase, and not pretending to be one.
      expect(entry.provider).toBeNull();
      expect(entry.providerRef).toBeNull();

      /*
       * IT GRANTS CREDITS AND NOTHING ELSE. The plan is the thing an operator
       * must not be able to change by hand, and the grandfather override is
       * the thing that would silently move a published cap.
       */
      const after = await planOf(t.owner.userId);
      expect(after.plan).toBe(before.plan);
      expect(after.plan).toBe("PRO");
      expect(after.legacyRecordCapOverride).toBe(before.legacyRecordCapOverride);
    });

    it("reads back as GRANTED, never as purchased", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      await grant({
        userId: t.owner.userId,
        credits: 4,
        reason: "goodwill",
        idempotencyKey: "GW-1",
      });
      const { readEvidenceCreditWallet } = await import(
        "../src/services/billing/evidence-credits.service.js"
      );
      const wallet = await readEvidenceCreditWallet(t.owner.userId);
      expect(wallet.availableCredits).toBe(4);
      expect(wallet.grantedCredits).toBe(4);
      // The customer paid for nothing, so nothing may say they did.
      expect(wallet.purchasedCredits).toBe(0);
    });

    it("bounds the request and refuses a negative or zero grant", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      for (const credits of [0, -5, 501]) {
        const res = await grant({
          userId: t.owner.userId,
          credits,
          reason: "out of bounds probe",
          idempotencyKey: `b${credits}`,
        });
        expect(res.statusCode, `credits=${credits}`).toBe(400);
      }
      // A reason and an idempotency key are both required.
      expect(
        (await grant({ userId: t.owner.userId, credits: 1, idempotencyKey: "x" }))
          .statusCode,
      ).toBe(400);
      expect(
        (await grant({ userId: t.owner.userId, credits: 1, reason: "why" })).statusCode,
      ).toBe(400);
      expect(await creditsOf(t.owner.userId)).toBe(0);
    });
  });

  // =========================================================================
  // IDEMPOTENCY — at the database, not at the button.
  // =========================================================================
  describe("idempotency", () => {
    it("a retry of the same grant credits nothing further", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const payload = {
        userId: t.owner.userId,
        credits: 10,
        reason: "INC-9 remediation",
        idempotencyKey: "INC-9",
      };
      const first = await grant(payload);
      const second = await grant(payload);

      expect((JSON.parse(first.body) as { applied: boolean }).applied).toBe(true);
      // The honest record of a retry: nothing moved.
      expect((JSON.parse(second.body) as { applied: boolean }).applied).toBe(false);
      expect(second.statusCode).toBe(200);
      expect(await creditsOf(t.owner.userId)).toBe(10);
      expect(
        await prisma.evidenceCreditLedgerEntry.count({
          where: { userId: t.owner.userId },
        }),
      ).toBe(1);
    });

    it("concurrent retries of one key cannot double-credit", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const payload = {
        userId: t.owner.userId,
        credits: 7,
        reason: "concurrent retry probe",
        idempotencyKey: "RACE-1",
      };
      // The application check can lose; the partial unique index cannot.
      await Promise.all([grant(payload), grant(payload), grant(payload)]);
      expect(await creditsOf(t.owner.userId)).toBe(7);
      expect(
        await prisma.evidenceCreditLedgerEntry.count({
          where: { userId: t.owner.userId },
        }),
      ).toBe(1);
    });

    it("the same operator reference for a DIFFERENT account is a different grant", async () => {
      /*
       * The key is namespaced by target server-side. A bare key would make one
       * reference mean one grant platform-wide, so two operators remediating
       * two customers under the same obvious id ("INC-1042") would silently
       * give the second one nothing.
       */
      const a = await seedPersonalTenant(deps, "PRO");
      const b = await seedPersonalTenant(deps, "PRO");
      await grant({ userId: a.owner.userId, credits: 3, reason: "same ticket id", idempotencyKey: "SHARED" });
      await grant({ userId: b.owner.userId, credits: 3, reason: "same ticket id", idempotencyKey: "SHARED" });
      expect(await creditsOf(a.owner.userId)).toBe(3);
      expect(await creditsOf(b.owner.userId)).toBe(3);
    });
  });

  // =========================================================================
  // AUDIT — a grant that nobody can trace is not a supported mechanism.
  // =========================================================================
  it("records the movement in the platform audit trail", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    const since = new Date();
    await grant({
      userId: t.owner.userId,
      credits: 12,
      reason: "INC-77 goodwill after outage",
      idempotencyKey: "INC-77",
    });

    const rows = await prisma.adminAuditLog.findMany({
      where: {
        action: "billing.evidence_credits_granted",
        createdAt: { gte: since },
      },
      select: { userId: true, resourceId: true, metadata: true },
    });
    expect(rows).toHaveLength(1);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(rows[0].userId).toBe(admin.userId); // the ACTOR
    expect(rows[0].resourceId).toBe(t.owner.userId); // the TARGET
    expect(meta.credits).toBe(12);
    expect(meta.reason).toBe("INC-77 goodwill after outage");
    expect(meta.previousBalance).toBe(0);
    expect(meta.resultingBalance).toBe(12);
    expect(meta.grantRef).toBe(`${t.owner.userId}:INC-77`);
    expect(meta.applied).toBe(true);
  });

  // =========================================================================
  // THE POINT OF IT — a granted credit is spent like a bought one.
  // =========================================================================
  describe("a granted credit funds evidence exactly as a purchased one does", () => {
    it("Personal PRO past its allowance: created, funded, one credit spent", async () => {
      const t = await seedPersonalTenant(deps, "PRO", { legacyRecordCapOverride: 2 });
      await holdExactly(t, 2);

      // At the cap with an empty wallet, the platform refuses — as it should.
      const refused = await createRecord(t.owner.token, t.personalTeamId);
      expect(refused.statusCode).toBe(409);

      await grant({
        userId: t.owner.userId,
        credits: 50,
        reason: "controlled testing capacity",
        idempotencyKey: "TEST-CAP",
      });

      const allowed = await createRecord(t.owner.token, t.personalTeamId);
      expect(allowed.statusCode, allowed.body).toBe(201);
      const id = (JSON.parse(allowed.body) as { id: string }).id;

      const settled = await settleOne(id);
      expect(settled.funding).toBe("EVIDENCE_CREDIT");
      expect(await creditsOf(t.owner.userId)).toBe(49);
      expect(
        await prisma.evidenceCreditLedgerEntry.count({
          where: { evidenceId: id, entryType: "CONSUMPTION" },
        }),
      ).toBe(1);

      // Still PRO. The allowance did not move; the wallet paid for the excess.
      expect((await planOf(t.owner.userId)).plan).toBe("PRO");
    });

    it("a shared workspace never spends the member's granted credits", async () => {
      /*
       * A platform grant to User X must not silently subsidise Workspace Y.
       * The wallet is PERSONAL; a SHARED scope carries none by construction,
       * and settlement returns PLAN without reaching it.
       */
      const owner = await seedUser(deps, "ws-owner");
      await setAccountPlan(deps, owner.userId, "TEAM");
      const ws = await seedOwnedWorkspace(deps, {
        ownerUserId: owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      await grant({
        userId: owner.userId,
        credits: 20,
        reason: "personal remediation",
        idempotencyKey: "PERSONAL-ONLY",
      });

      const res = await createRecord(owner.token, ws.teamId);
      expect(res.statusCode, res.body).toBe(201);
      const id = (JSON.parse(res.body) as { id: string }).id;

      const settled = await settleOne(id);
      expect(settled.funding).toBe("PLAN");
      // Twenty in, twenty out.
      expect(await creditsOf(owner.userId)).toBe(20);
      expect(
        await prisma.evidenceCreditLedgerEntry.count({
          where: { evidenceId: id },
        }),
      ).toBe(0);
    });
  });
});
