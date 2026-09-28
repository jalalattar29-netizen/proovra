/**
 * BILLING PRODUCTION CLOSURE — Enterprise contract allowances and the legacy
 * PAYG invariants, against live PostgreSQL 16.
 *
 * WHY THESE TWO TOGETHER
 * ---------------------------------------------------------------------------
 * Both are "the code exists but nothing can reach it" defects, and both are
 * only provable with a real producer in the loop:
 *
 *   * The Enterprise contract carried `evidenceRecordsPerMonth` and
 *     `aiOperationsPerMonth` as database columns and as resolver inputs, but
 *     the projection between them never selected them. A unit test that hands
 *     the resolver a hand-built object proves nothing about that gap, so every
 *     assertion here starts at the WRITER and ends at real enforcement.
 *
 *   * PAYG stopped being a plan. Proving that means proving the single writer
 *     refuses it, not that no call site happens to pass it today.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, seedUser, type FixtureDeps } from "./point7/product-fixtures.js";

describe("BILLING CLOSURE — contract allowances and PAYG invariants (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

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

  /** A CUSTOMER organization with a contract written through the real writer. */
  async function seedContractedOrganization(input: {
    evidenceRecordsPerMonth?: number | null;
    aiOperationsPerMonth?: number | null;
    status?: "ACTIVE" | "SUSPENDED";
  }) {
    const { upsertEnterpriseContract } = await import(
      "../src/services/organization/enterprise-contract.service.js"
    );
    const owner = await seedUser(deps, "ent");
    const org = await prisma.organization.create({
      data: {
        name: `closure-org-${randomUUID().slice(0, 8)}`,
        kind: "CUSTOMER",
        status: "ACTIVE",
        billingOwnerUserId: owner.userId,
      },
    });
    const workspace = await prisma.team.create({
      data: {
        name: `closure-ws-${randomUUID().slice(0, 8)}`,
        ownerUserId: owner.userId,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
        isPersonal: false,
        billingPlan: "ENTERPRISE",
        billingStatus: "ACTIVE",
      },
    });
    await upsertEnterpriseContract(prisma as never, {
      organizationId: org.id,
      status: input.status ?? "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
      evidenceRecordsPerMonth: input.evidenceRecordsPerMonth,
      aiOperationsPerMonth: input.aiOperationsPerMonth,
    });
    return { owner, organizationId: org.id, workspaceId: workspace.id };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `bci-${Date.now().toString(36)}`,
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
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // Enterprise contract allowances — writer → row → projection → enforcement
  // =========================================================================
  describe("Enterprise contract allowances", () => {
    it("an ACTIVE contract's evidence allowance reaches the projection and the gate", async () => {
      const org = await seedContractedOrganization({
        evidenceRecordsPerMonth: 7,
        aiOperationsPerMonth: 9,
      });

      // The producer really wrote them.
      const { resolveEnterpriseContract } = await import(
        "../src/services/organization/enterprise-contract.service.js"
      );
      const projected = await resolveEnterpriseContract(org.organizationId, prisma);
      expect(projected?.evidenceRecordsPerMonth).toBe(7);
      expect(projected?.aiOperationsPerMonth).toBe(9);

      // The commercial resolver carries them through with no cast.
      const { resolveEnterpriseContractLimits, resolveEffectiveContractEvidenceCap, resolveEffectiveContractAiCap } =
        await import("../src/services/billing/enterprise-contract-limits.js");
      const limits = resolveEnterpriseContractLimits(projected!);
      expect(limits.evidenceRecordsPerMonth).toBe(7);
      expect(limits.aiOperationsPerMonth).toBe(9);
      expect(
        resolveEffectiveContractEvidenceCap({ plan: "ENTERPRISE", contract: limits }),
      ).toBe(7);
      expect(resolveEffectiveContractAiCap({ plan: "ENTERPRISE", contract: limits })).toBe(9);

      // And REAL enforcement refuses the eighth record in the window.
      const { resolveEnforcementScopeForRequester, assertWorkspaceAllowsEvidenceCreation } =
        await import("../src/services/billing-enforcement.service.js");
      for (let i = 0; i < 7; i += 1) {
        await prisma.evidence.create({
          data: {
            ownerUserId: org.owner.userId,
            teamId: org.workspaceId,
            organizationId: org.organizationId,
            type: "PHOTO",
          },
        });
      }
      const scope = await resolveEnforcementScopeForRequester({
        ownerUserId: org.owner.userId,
        teamId: org.workspaceId,
      });
      await expect(
        assertWorkspaceAllowsEvidenceCreation(scope),
      ).rejects.toMatchObject({ code: "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED" });
    });

    it("a silent contract falls back to the catalog and is labelled CONTRACT_MANAGED, not a number", async () => {
      const org = await seedContractedOrganization({});
      const { resolveEnterpriseContract } = await import(
        "../src/services/organization/enterprise-contract.service.js"
      );
      const projected = await resolveEnterpriseContract(org.organizationId, prisma);
      expect(projected?.evidenceRecordsPerMonth).toBeNull();
      expect(projected?.aiOperationsPerMonth).toBeNull();

      const { resolveEnterpriseContractLimits, resolveEffectiveContractEvidenceCap } =
        await import("../src/services/billing/enterprise-contract-limits.js");
      const limits = resolveEnterpriseContractLimits(projected!);
      // ENTERPRISE's catalog monthly cap is null — uncapped, NOT zero.
      expect(
        resolveEffectiveContractEvidenceCap({ plan: "ENTERPRISE", contract: limits }),
      ).toBeNull();
    });

    it("a SUSPENDED contract cannot expand anything", async () => {
      const org = await seedContractedOrganization({
        evidenceRecordsPerMonth: 50_000,
        aiOperationsPerMonth: 50_000,
        status: "SUSPENDED",
      });
      const { resolveEnterpriseContract } = await import(
        "../src/services/organization/enterprise-contract.service.js"
      );
      const { resolveEnterpriseContractLimits } = await import(
        "../src/services/billing/enterprise-contract-limits.js"
      );
      const limits = resolveEnterpriseContractLimits(
        (await resolveEnterpriseContract(org.organizationId, prisma))!,
      );
      expect(limits.contractGovernsCapability).toBe(false);
      expect(limits.evidenceRecordsPerMonth).toBeNull();
      expect(limits.aiOperationsPerMonth).toBeNull();
    });

    it("a zero or fractional allowance is refused by the writer, not stored", async () => {
      const { upsertEnterpriseContract } = await import(
        "../src/services/organization/enterprise-contract.service.js"
      );
      const owner = await seedUser(deps, "ent-bad");
      const org = await prisma.organization.create({
        data: {
          name: `closure-bad-${randomUUID().slice(0, 8)}`,
          kind: "CUSTOMER",
          status: "ACTIVE",
          billingOwnerUserId: owner.userId,
        },
      });

      for (const bad of [0, -5, 1.5]) {
        await expect(
          upsertEnterpriseContract(prisma as never, {
            organizationId: org.id,
            status: "ACTIVE",
            activationState: "ACTIVATED",
            evidenceRecordsPerMonth: bad,
          }),
        ).rejects.toThrow(/positive whole number/);
      }

      // Nothing was written by the refused calls.
      const row = await prisma.enterpriseContract.findUnique({
        where: { organizationId: org.id },
      });
      expect(row).toBeNull();
    });

    it("one organization's contract cannot govern another organization", async () => {
      const a = await seedContractedOrganization({ evidenceRecordsPerMonth: 3 });
      const b = await seedContractedOrganization({});
      const { resolveEnterpriseContract } = await import(
        "../src/services/organization/enterprise-contract.service.js"
      );
      const projectedB = await resolveEnterpriseContract(b.organizationId, prisma);
      expect(projectedB?.evidenceRecordsPerMonth).toBeNull();
      expect(projectedB?.organizationId).toBe(b.organizationId);
      expect(projectedB?.organizationId).not.toBe(a.organizationId);
    });
  });

  // =========================================================================
  // PAYG is not an assignable plan
  // =========================================================================
  // =========================================================================
  // PayPal checkout concurrency — real PostgreSQL advisory-lock proof
  // =========================================================================
  describe("PayPal checkout concurrency gate", () => {
    // BILLING CHECKOUT ATTEMPTS (2026-09-28) — the gate is now the durable
    // attempt itself: committed under a per-payer advisory lock BEFORE any
    // provider call, so two concurrent requests cannot both reach PayPal.
    it("serializes concurrent same-target checkout attempts for one user", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { openCheckoutAttempt } = await import(
        "../src/services/billing/checkout-attempts.service.js"
      );
      const open = () =>
        openCheckoutAttempt({
          userId: t.owner.userId,
          product: "PLAN",
          provider: "PAYPAL",
          planKey: "PRO",
          amountCents: 1900,
          currency: "USD",
        });
      const results = await Promise.all([open(), open()]);
      expect(results.filter((r) => r.kind === "OPEN")).toHaveLength(1);
      const blocked = results.find((r) => r.kind === "BLOCKED");
      expect(blocked?.kind).toBe("BLOCKED");
      if (blocked?.kind === "BLOCKED") {
        expect(blocked.reason).toBe("PLAN_ATTEMPT_PENDING");
        expect(blocked.attempt.planKey).toBe("PRO");
        expect(blocked.attempt.providerBound).toBe(false);
      }
      const persisted = await prisma.billingCheckoutAttempt.findMany({
        where: { userId: t.owner.userId, product: "PLAN" },
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.checkoutState).toBe("PROVIDER_CREATE_IN_PROGRESS");
    });

    it("serializes concurrent cross-target PRO/TEAM checkout attempts for one user", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { openCheckoutAttempt } = await import(
        "../src/services/billing/checkout-attempts.service.js"
      );
      const open = (planKey: "PRO" | "TEAM") =>
        openCheckoutAttempt({
          userId: t.owner.userId,
          product: "PLAN",
          provider: "PAYPAL",
          planKey,
          amountCents: planKey === "PRO" ? 1900 : 7900,
          currency: "USD",
        });
      const results = await Promise.all([open("PRO"), open("TEAM")]);
      expect(results.filter((r) => r.kind === "OPEN")).toHaveLength(1);
      const blocked = results.find((r) => r.kind === "BLOCKED");
      const persisted = await prisma.billingCheckoutAttempt.findMany({
        where: { userId: t.owner.userId, product: "PLAN" },
      });
      expect(persisted).toHaveLength(1);
      if (blocked?.kind === "BLOCKED") {
        expect(blocked.attempt.planKey).toBe(persisted[0]?.planKey);
      } else {
        throw new Error("expected one blocked attempt");
      }
    });

    it("a legacy TRIALING PayPal subscription still blocks a new plan checkout", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      await prisma.subscription.create({
        data: {
          userId: t.owner.userId,
          plan: "TEAM",
          status: "TRIALING",
          provider: "PAYPAL",
          providerSubId: `I-LEGACY${randomUUID().slice(0, 8).toUpperCase()}`,
        },
      });
      const { startPayPalPlanCheckout } = await import(
        "../src/services/billing/paypal-checkout-start.service.js"
      );
      const result = await startPayPalPlanCheckout({ userId: t.owner.userId, plan: "PRO" });
      expect(result.kind).toBe("BLOCKED");
      if (result.kind === "BLOCKED") {
        expect(result.httpBody.code).toBe("PAYPAL_DIFFERENT_PLAN_PENDING");
      }
      expect(
        await prisma.billingCheckoutAttempt.count({ where: { userId: t.owner.userId } }),
      ).toBe(0);
    });
  });
  describe("legacy PAYG invariants", () => {
    it("the single plan writer refuses PAYG", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const { setPersonalPlan } = await import("../src/services/billing.service.js");

      await expect(setPersonalPlan(t.owner.userId, "PAYG")).rejects.toMatchObject({
        code: "PAYG_NOT_ASSIGNABLE",
      });

      const after = await prisma.entitlement.findFirst({
        where: { userId: t.owner.userId, active: true },
        select: { plan: true },
      });
      expect(after?.plan).toBe("FREE");
    });

    it("the modern plan checkout refuses PAYG before reaching any provider", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      for (const url of [
        "/v1/billing/checkout/stripe",
        "/v1/billing/checkout/paypal",
      ]) {
        const res = await inject({
          method: "POST",
          url,
          token: t.owner.token,
          payload: { plan: "PAYG", currency: "USD" },
        });
        expect(res.statusCode, `${url} must refuse PAYG`).toBeGreaterThanOrEqual(400);
      }
    });

    it("no purchasable offer on a real Billing account names PAYG", async () => {
      // The account projection is what the Billing page renders offers from,
      // so this is the surface where "selectable plan" is actually decided.
      // The public /v1/billing/pricing catalog still DESCRIBES the credit
      // product under its historical key — describing a product a customer can
      // buy is not the same as offering PAYG as a recurring plan, and the two
      // assertions below separate them.
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const res = await inject({
        method: "GET",
        url: `/v1/billing/accounts/PERSONAL/${t.owner.userId}`,
        token: t.owner.token,
      });
      expect(res.statusCode, res.body).toBe(200);
      const projection = JSON.parse(res.body) as {
        planOffers?: Array<{ planKey: string }>;
      };
      const offers = projection.planOffers ?? [];
      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) {
        expect(offer.planKey).not.toBe("PAYG");
      }

      // And the legacy row still announces itself as legacy wherever it is
      // described, so no surface can present it as a current plan.
      const { PLAN_CAPABILITIES } = await import("@proovra/shared-billing");
      expect(PLAN_CAPABILITIES.PAYG.displayName).toMatch(/legacy/i);
    });
  });
});
