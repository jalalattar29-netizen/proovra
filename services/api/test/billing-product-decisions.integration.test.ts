/**
 * BILLING DECISIONS (2026-10-31) — D1 to D5 and the stacking and legacy holdings
 * rules, on live PostgreSQL through the real services and routes.
 *
 * Stripe and PayPal are synthetic and shaped like their documented responses:
 * nothing here is evidence of how either provider actually behaves. Every lock,
 * transaction and unique index below is the real one.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, seedUser, type FixtureDeps } from "./point7/product-fixtures.js";

const S = vi.hoisted(() => ({
  stripeCancels: [] as string[],
  stripeCancelFails: false,
  planChangeFails: false,
}));

vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    stripeRequest: async (path: string, body: URLSearchParams) => {
      if (body.get("cancel_at_period_end") === "true") {
        if (S.stripeCancelFails) throw new Error("stripe unavailable");
        S.stripeCancels.push(path);
        return { cancel_at_period_end: true };
      }
      throw new Error(`unexpected Stripe write in test: ${path}`);
    },
    stripeGet: async (path: string) => {
      if (S.planChangeFails) throw new Error("stripe unavailable");
      throw new Error(`unexpected Stripe read in test: ${path}`);
    },
  };
});

describe("billing product decisions (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let admin: { userId: string; token: string; teamId: string };
  let adminSecret: Buffer;

  const call = (opts: { url: string; token?: string; payload?: unknown; challengeId?: string }) =>
    h.app.inject({
      method: "POST",
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.challengeId ? { "x-proovra-step-up-challenge-id": opts.challengeId } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });
  type Body = {
    code: string;
    error: { code: string };
    challenge: { id: string };
    details: { ending: Array<Record<string, unknown>> };
  };
  const json = (res: { body: string }) => JSON.parse(res.body) as Body;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `bpd-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    const staff = await seedUser(deps, "platform-admin");
    await prisma.user.update({ where: { id: staff.userId }, data: { platformRole: "admin" } });
    const org = await prisma.organization.create({
      data: { name: `BPD anchor ${deps.tag}`, billingOwnerUserId: staff.userId, status: "ACTIVE", kind: "CUSTOMER" },
      select: { id: true },
    });
    await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: staff.userId, role: "ORG_OWNER" } });
    const team = await prisma.team.create({
      data: { name: `BPD anchor ${deps.tag}`, ownerUserId: staff.userId, isPersonal: false, organizationId: org.id, workspaceKind: "ORGANIZATION" },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: staff.userId, role: "OWNER", status: "ACTIVE" } });
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    adminSecret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(adminSecret);
    const now = new Date();
    await prisma.mfaFactor.create({
      data: {
        userId: staff.userId,
        kind: "TOTP",
        status: "ACTIVE",
        label: "Authenticator",
        secretCiphertext: Buffer.from(sealed.ciphertext),
        secretIv: Buffer.from(sealed.iv),
        secretAuthTag: Buffer.from(sealed.authTag),
        secretKekId: sealed.kekId,
        verifiedAtUtc: now,
        enrolledAt: now,
      },
    });
    admin = { userId: staff.userId, token: staff.token, teamId: team.id };
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  beforeEach(() => {
    S.stripeCancels.length = 0;
    S.stripeCancelFails = false;
    S.planChangeFails = false;
  });

  async function freshUser(plan: "FREE" | "PRO" | "TEAM" = "FREE") {
    const { ensureEntitlement, setPersonalPlan } = await import("../src/services/billing.service.js");
    const id = randomUUID();
    const email = `billing-dec-${id}@example.test`;
    await prisma.user.create({ data: { id, email, provider: "EMAIL", providerUserId: email } });
    await ensureEntitlement(id);
    if (plan !== "FREE") await setPersonalPlan(id, plan);
    return id;
  }

  const baseOf = (userId: string, data: Record<string, unknown> = {}) =>
    prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID().slice(0, 14)}`,
        status: "ACTIVE",
        plan: "TEAM",
        activatedAtUtc: new Date(),
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        ...data,
      } as never,
    });

  const addonOf = (ownerUserId: string, data: Record<string, unknown> = {}) =>
    prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId,
        addonKey: "TEAM_100_GB",
        extraStorageBytes: 107_374_182_400n,
        billingCycle: "MONTHLY",
        status: "ACTIVE",
        paymentProvider: "STRIPE",
        externalSubscriptionId: `sub_${randomUUID().slice(0, 14)}`,
        currentPeriodEnd: new Date(Date.now() + 9 * 86_400_000),
        amountCents: 999,
        currency: "EUR",
        ...data,
      } as never,
    });

  const ownedWorkspace = async (ownerUserId: string, name = "Older workspace") => {
    const org = await prisma.organization.create({
      data: { name: "Legacy container", billingOwnerUserId: ownerUserId, status: "ACTIVE", kind: "SYSTEM" } as never,
      select: { id: true },
    });
    return prisma.team.create({
      data: { name, ownerUserId, isPersonal: false, organizationId: org.id, workspaceKind: "OWNED" } as never,
      select: { id: true },
    });
  };

  // ---------------------------------------------------------------------------
  // D3 — administrative credit grants
  // ---------------------------------------------------------------------------
  describe("D3: credit grants", () => {
    async function approval(
      resourceId: string,
      overrides: { resourceKind?: string; purpose?: string } = {},
    ): Promise<string> {
      await prisma.mfaFactor.updateMany({ where: { userId: admin.userId, kind: "TOTP" }, data: { lastUsedAt: null } });
      const started = await call({
        url: "/v1/identity-security/step-up/start",
        token: admin.token,
        payload: {
          teamId: admin.teamId,
          purpose: overrides.purpose ?? "CAPABILITY_GRANT",
          resourceKind: overrides.resourceKind ?? "evidence_credit_grant",
          resourceId,
        },
      });
      expect(started.statusCode, started.body).toBe(200);
      const challengeId = json(started).challenge.id as string;
      const checked = await call({
        url: "/v1/identity-security/step-up/check",
        token: admin.token,
        payload: {
          teamId: admin.teamId,
          challengeId,
          code: totp.computeTotpCode(adminSecret, totp.timeStep(Math.floor(Date.now() / 1000))),
        },
      });
      expect(checked.statusCode, checked.body).toBe(200);
      return challengeId;
    }
    const creditsOf = async (userId: string) =>
      (await prisma.entitlement.findFirstOrThrow({ where: { userId, active: true } })).credits;
    const grantBody = (userId: string, idempotencyKey = `REF-${randomUUID().slice(0, 8)}`) => ({
      teamId: admin.teamId,
      userId,
      credits: 4,
      reason: "Support remediation for a failed import",
      idempotencyKey,
    });
    const auditsFor = (userId: string) =>
      prisma.adminAuditLog.findMany({ where: { action: "billing.evidence_credits_granted", resourceId: userId } });

    it("needs a fresh approval: missing, for another account, for another purpose, or spent all move nothing", async () => {
      const customer = await freshUser();
      const other = await freshUser();
      const url = "/v1/admin/billing/evidence-credits";
      const missing = await call({ url, token: admin.token, payload: grantBody(customer) });
      expect(missing.statusCode).toBe(401);
      expect(json(missing).error.code).toBe("STEP_UP_REQUIRED");

      const elsewhere = await call({
        url,
        token: admin.token,
        payload: grantBody(customer),
        challengeId: await approval(other),
      });
      expect(elsewhere.statusCode).toBe(401);

      const planGrant = await call({
        url,
        token: admin.token,
        payload: grantBody(customer),
        challengeId: await approval(customer, { resourceKind: "internal_plan_grant" }),
      });
      expect(planGrant.statusCode).toBe(401);

      const good = await approval(customer);
      const first = await call({ url, token: admin.token, payload: grantBody(customer), challengeId: good });
      expect(first.statusCode, first.body).toBe(200);
      const replayed = await call({ url, token: admin.token, payload: grantBody(customer), challengeId: good });
      expect(replayed.statusCode).toBe(401);
      expect(await creditsOf(customer)).toBe(4);
    });

    it("an expired approval is refused", async () => {
      const customer = await freshUser();
      const challengeId = await approval(customer);
      await prisma.stepUpChallenge.update({ where: { id: challengeId }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
      const res = await call({
        url: "/v1/admin/billing/evidence-credits",
        token: admin.token,
        payload: grantBody(customer),
        challengeId,
      });
      expect(res.statusCode).toBe(401);
      expect(await creditsOf(customer)).toBe(0);
    });

    it("a non-admin holding no platform role is refused before any approval is read", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const res = await call({
        url: "/v1/admin/billing/evidence-credits",
        token: t.owner.token,
        payload: { ...grantBody(t.owner.userId), teamId: t.personalTeamId },
      });
      expect(res.statusCode).toBe(403);
    });

    it("records actor, reason, reference and method in the same commit as the grant", async () => {
      const customer = await freshUser();
      const body = grantBody(customer);
      const res = await call({
        url: "/v1/admin/billing/evidence-credits",
        token: admin.token,
        payload: body,
        challengeId: await approval(customer),
      });
      expect(res.statusCode, res.body).toBe(200);
      const [audit] = await auditsFor(customer);
      expect(audit).toMatchObject({ userId: admin.userId, outcome: "success" });
      expect(audit!.metadata).toMatchObject({
        targetUserId: customer,
        reason: body.reason,
        grantRef: `${customer}:${body.idempotencyKey}`,
        applied: true,
        previousBalance: 0,
        resultingBalance: 4,
        authMethod: "TOTP",
      });
    });

    it("rolls back the grant when the audit cannot be written, and a retry then succeeds once", async () => {
      const { grantEvidenceCreditsByPlatformAdmin } = await import("../src/services/billing/evidence-credits.service.js");
      const customer = await freshUser();
      const grantRef = `${customer}:ROLLBACK-1`;
      await expect(
        grantEvidenceCreditsByPlatformAdmin({
          userId: customer,
          credits: 9,
          grantRef,
          audit: async () => {
            throw new Error("audit sink unavailable");
          },
        }),
      ).rejects.toThrow("audit sink unavailable");
      expect(await creditsOf(customer)).toBe(0);
      expect(await prisma.evidenceCreditLedgerEntry.count({ where: { grantRef } })).toBe(0);

      const retried = await grantEvidenceCreditsByPlatformAdmin({
        userId: customer,
        credits: 9,
        grantRef,
        audit: async () => undefined,
      });
      expect(retried).toEqual({ granted: true, balanceAfter: 9 });
    });

    it("an audit unique violation is an audit failure, not a lost race: nothing commits and nothing is reported as done", async () => {
      const { grantEvidenceCreditsByPlatformAdmin } = await import("../src/services/billing/evidence-credits.service.js");
      const customer = await freshUser();
      const grantRef = `${customer}:P2002-1`;
      await expect(
        grantEvidenceCreditsByPlatformAdmin({
          userId: customer,
          credits: 2,
          grantRef,
          audit: async () => {
            throw Object.assign(new Error("audit chain collision"), { code: "P2002" });
          },
        }),
      ).rejects.toThrow("audit chain collision");
      expect(await creditsOf(customer)).toBe(0);
    });

    it("concurrent duplicates credit once, and every request leaves an audit that says what it did", async () => {
      const { grantEvidenceCreditsByPlatformAdmin } = await import("../src/services/billing/evidence-credits.service.js");
      const { emitPlatformAudit } = await import("../src/services/audit/tenant-audit.service.js");
      const customer = await freshUser();
      const grantRef = `${customer}:RACE-1`;
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () =>
          grantEvidenceCreditsByPlatformAdmin({
            userId: customer,
            credits: 3,
            grantRef,
            audit: (client, outcome) =>
              emitPlatformAudit(
                {
                  action: "billing.evidence_credits_granted",
                  outcome: "success",
                  sourceApp: "API",
                  actorUserId: admin.userId,
                  resourceType: "billing_credit",
                  resourceId: customer,
                  metadata: { applied: outcome.granted },
                },
                client,
              ),
          }),
        ),
      );
      expect(outcomes.filter((o) => o.granted)).toHaveLength(1);
      expect(await creditsOf(customer)).toBe(3);
      expect(await prisma.evidenceCreditLedgerEntry.count({ where: { grantRef } })).toBe(1);
      const audits = await auditsFor(customer);
      expect(audits).toHaveLength(5);
      expect(audits.filter((a) => (a.metadata as { applied?: boolean }).applied === true)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy holdings
  // ---------------------------------------------------------------------------
  describe("legacy add-on holdings", () => {
    async function projectionFor(userId: string) {
      const { buildBillingAccountProjection } = await import("../src/services/billing/billing-account-projection.service.js");
      const { resolveBillingAccountForViewer } = await import("../src/services/billing/billing-accounts.service.js");
      return JSON.parse(
        JSON.stringify(
          await buildBillingAccountProjection({
            viewerUserId: userId,
            account: await resolveBillingAccountForViewer({ viewerUserId: userId, type: "PERSONAL", id: userId }),
          }),
        ),
      ) as { storageAddons: { active: Array<Record<string, unknown>>; legacyWorkspaceCapacityLabel: string | null } };
    }

    it("lists each add-on once, names the payer's own workspace, totals it apart, and shows nothing of another owner's", async () => {
      const payer = await freshUser("TEAM");
      const stranger = await freshUser("TEAM");
      const workspace = await ownedWorkspace(payer, "Acme archive");
      const foreign = await ownedWorkspace(stranger, "Not yours");
      const personal = await addonOf(payer);
      const legacy = await addonOf(payer, { teamId: workspace.id, status: "PAST_DUE" });
      const theirs = await addonOf(stranger, { teamId: foreign.id });

      const { storageAddons } = await projectionFor(payer);
      const ids = storageAddons.active.map((row) => row.id);
      expect(ids.filter((id) => id === legacy.id)).toHaveLength(1);
      expect(ids).toContain(personal.id);
      expect(ids).not.toContain(theirs.id);
      const row = storageAddons.active.find((r) => r.id === legacy.id)!;
      expect(row).toMatchObject({ legacyWorkspace: true, legacyWorkspaceName: "Acme archive", status: "PAST_DUE" });
      expect(storageAddons.active.find((r) => r.id === personal.id)).toMatchObject({
        legacyWorkspace: false,
        legacyWorkspaceName: null,
      });
      expect(storageAddons.legacyWorkspaceCapacityLabel).toBe("100 GB");
    });

    it("history names the payer's own older workspace and rewrites nothing", async () => {
      const { readBillingHistoryForAccount } = await import("../src/services/billing/billing-account-projection.service.js");
      const { resolveBillingAccountForViewer } = await import("../src/services/billing/billing-accounts.service.js");
      const payer = await freshUser();
      const workspace = await ownedWorkspace(payer, "Acme archive");
      const payment = await prisma.payment.create({
        data: {
          userId: payer,
          teamId: workspace.id,
          provider: "STRIPE",
          providerPaymentId: `in_${randomUUID().slice(0, 12)}`,
          amountCents: 999,
          currency: "EUR",
          status: "SUCCEEDED",
        } as never,
      });
      const history = await readBillingHistoryForAccount({
        account: await resolveBillingAccountForViewer({ viewerUserId: payer, type: "PERSONAL", id: payer }),
      });
      expect(history.find((row) => row.id === payment.id)?.legacyWorkspaceName).toBe("Acme archive");
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.teamId).toBe(workspace.id);
    });

    it("a long purchase history cannot push a live add-on out of the totals", async () => {
      const payer = await freshUser("TEAM");
      const live = await addonOf(payer, { createdAt: new Date(Date.now() - 400 * 86_400_000) });
      await prisma.workspaceStorageAddon.createMany({
        data: Array.from({ length: 60 }, () => ({
          ownerUserId: payer,
          addonKey: "TEAM_100_GB" as const,
          extraStorageBytes: 1n,
          billingCycle: "MONTHLY" as const,
          status: "CANCELED" as const,
        })),
      });
      const { storageAddons } = await projectionFor(payer);
      expect(storageAddons.active.map((row) => row.id)).toContain(live.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Intentional stacking
  // ---------------------------------------------------------------------------
  describe("intentional stacking", () => {
    it("a confirmation covers the count it saw, and only that", async () => {
      const { findStorageDuplicate } = await import("../src/services/billing/storage-purchase-guard.service.js");
      const payer = await freshUser("TEAM");
      await addonOf(payer);
      const ask = (confirmation: { heldCount: number | null } | null) =>
        findStorageDuplicate({ userId: payer, addonKey: "TEAM_100_GB", provider: "STRIPE", confirmation });

      expect((await ask(null))?.code).toBe("STORAGE_ADDON_ALREADY_HELD");
      expect(await ask({ heldCount: 1 })).toBeNull();
      await addonOf(payer);
      const stale = await ask({ heldCount: 1 });
      expect(stale?.code).toBe("STORAGE_ADDON_ALREADY_HELD");
      expect(stale?.details.activeCount).toBe(2);
      expect(await ask({ heldCount: 2 })).toBeNull();
    });

    it("an open purchase on the other provider stops even a confirmed addition", async () => {
      const { findStorageDuplicate } = await import("../src/services/billing/storage-purchase-guard.service.js");
      const payer = await freshUser("TEAM");
      await addonOf(payer);
      await addonOf(payer, { status: "PENDING", paymentProvider: "PAYPAL" });
      const found = await findStorageDuplicate({
        userId: payer,
        addonKey: "TEAM_100_GB",
        provider: "STRIPE",
        confirmation: { heldCount: 1 },
      });
      expect(found?.code).toBe("STORAGE_PURCHASE_PENDING");
    });
  });

  // ---------------------------------------------------------------------------
  // D1 — Team storage after a downgrade
  // ---------------------------------------------------------------------------
  describe("D1: downgrade", () => {
    const stateOf = (id: string) => prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id } });
    const consented = { addonEndConsentPlan: "PRO", addonEndConsentAtUtc: new Date() };
    const pending = { pendingPlan: "PRO", pendingPlanEffectiveAtUtc: new Date(Date.now() + 20 * 86_400_000) };

    it("the route names what ends and asks the provider nothing until the customer agrees", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const base = await baseOf(t.owner.userId);
      await addonOf(t.owner.userId);
      S.planChangeFails = true;
      const res = await call({
        url: "/v1/billing/subscription/plan",
        token: t.owner.token,
        payload: { plan: "PRO" },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(json(res).code).toBe("PLAN_CHANGE_ENDS_STORAGE");
      expect(json(res).details.ending[0]).toMatchObject({ addonKey: "TEAM_100_GB", storageLabel: "100 GB" });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: base.id } })).addonEndConsentPlan).toBeNull();
    });

    it("a provider refusal takes the agreement with it", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const base = await baseOf(t.owner.userId);
      await addonOf(t.owner.userId);
      S.planChangeFails = true;
      const res = await call({
        url: "/v1/billing/subscription/plan",
        token: t.owner.token,
        payload: { plan: "PRO", confirmStorageEnding: true },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: base.id } });
      expect(row).toMatchObject({ addonEndConsentPlan: null, pendingPlan: null });
    });

    it("an add-on nothing can cancel refuses the downgrade outright", async () => {
      const { prepareDowngradeStorage } = await import("../src/services/billing/plan-transition.service.js");
      const payer = await freshUser("TEAM");
      const base = await baseOf(payer);
      await addonOf(payer, { dependentCancellationState: "MANUAL_INTERVENTION" });
      await expect(
        prepareDowngradeStorage({ userId: payer, subscriptionId: base.id, targetPlan: "PRO", confirmed: true }),
      ).rejects.toMatchObject({ publicCode: "PLAN_CHANGE_STORAGE_MUST_END_FIRST" });
    });

    it("a downgrade scheduled WITHOUT the agreement ends nothing, whatever the sweep sees", async () => {
      const { recordDependentCancellationObligations } = await import("../src/services/billing/dependent-cancellation.service.js");
      const payer = await freshUser("TEAM");
      await baseOf(payer, pending);
      const addon = await addonOf(payer);
      await recordDependentCancellationObligations({ ownerUserId: payer, teamId: null }, prisma);
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("NONE");
    });

    it("a PayPal change still awaiting approval ends nothing yet", async () => {
      const { recordDependentCancellationObligations } = await import("../src/services/billing/dependent-cancellation.service.js");
      const payer = await freshUser("TEAM");
      await baseOf(payer, { ...pending, ...consented, pendingPlanAwaitingApproval: true });
      const addon = await addonOf(payer);
      await recordDependentCancellationObligations({ ownerUserId: payer, teamId: null }, prisma);
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("NONE");
    });

    it("an agreed downgrade stops renewal at the add-on's own paid date and keeps its capacity", async () => {
      const { scheduleDowngradeStorageEnd } = await import("../src/services/billing/plan-transition.service.js");
      const payer = await freshUser("TEAM");
      await baseOf(payer, { ...pending, ...consented });
      const addon = await addonOf(payer);
      const kept = await addonOf(payer, { addonKey: "PERSONAL_50_GB", extraStorageBytes: 1n });

      expect(await scheduleDowngradeStorageEnd(payer)).toMatchObject({ retrying: 0 });
      expect(S.stripeCancels).toEqual([`/subscriptions/${addon.externalSubscriptionId}`]);
      const row = await stateOf(addon.id);
      expect(row).toMatchObject({
        status: "ACTIVE",
        dependentCancellationState: "CONFIRMED",
        dependentCancellationReasonCode: "PLAN_NO_LONGER_INCLUDES_STORAGE",
      });
      expect(row.currentPeriodEnd).toEqual(addon.currentPeriodEnd);
      expect((await stateOf(kept.id)).dependentCancellationState).toBe("NONE");
    });

    it("the sweep finishes the job if the process died after the provider accepted", async () => {
      const { recordDependentCancellationObligations, attemptPayerDependentCancellations } = await import(
        "../src/services/billing/dependent-cancellation.service.js"
      );
      const payer = await freshUser("TEAM");
      await baseOf(payer, { ...pending, ...consented });
      const addon = await addonOf(payer);
      await recordDependentCancellationObligations({ ownerUserId: payer, teamId: null }, prisma);
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("PENDING");
      await attemptPayerDependentCancellations({ userId: payer });
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("CONFIRMED");
    });

    it("a failed provider call stays owed after the downgrade lands, instead of being withdrawn", async () => {
      const { scheduleDowngradeStorageEnd } = await import("../src/services/billing/plan-transition.service.js");
      const { attemptPayerDependentCancellations } = await import("../src/services/billing/dependent-cancellation.service.js");
      const payer = await freshUser("TEAM");
      const base = await baseOf(payer, { ...pending, ...consented });
      const addon = await addonOf(payer, { dependsOnSubscriptionId: undefined });
      S.stripeCancelFails = true;
      expect(await scheduleDowngradeStorageEnd(payer)).toMatchObject({ retrying: 1 });
      const failed = await stateOf(addon.id);
      expect(failed.dependentCancellationState).toBe("RETRY_SCHEDULED");
      expect(failed.dependentCancellationReasonCode).toBe("PLAN_NO_LONGER_INCLUDES_STORAGE");

      // The change lands: PRO in force, nothing pending.
      await prisma.subscription.update({
        where: { id: base.id },
        data: { plan: "PRO", pendingPlan: null, pendingPlanEffectiveAtUtc: null, addonEndConsentPlan: null },
      });
      S.stripeCancelFails = false;
      await attemptPayerDependentCancellations({ userId: payer });
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("CONFIRMED");
      expect(S.stripeCancels).toHaveLength(1);
    });

    it("withdrawing the downgrade before an attempt withdraws the obligation", async () => {
      const { recordDependentCancellationObligations, withdrawUnsupportedObligations } = await import(
        "../src/services/billing/dependent-cancellation.service.js"
      );
      const { clearPendingPlan } = await import("../src/services/billing/plan-transition.service.js");
      const payer = await freshUser("TEAM");
      const base = await baseOf(payer, { ...pending, ...consented });
      const addon = await addonOf(payer);
      await recordDependentCancellationObligations({ ownerUserId: payer, teamId: null }, prisma);
      await clearPendingPlan(base.id);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: base.id } })).addonEndConsentPlan).toBeNull();
      expect(await withdrawUnsupportedObligations({ ownerUserId: payer, teamId: null })).toBe(1);
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("NONE");
      expect(S.stripeCancels).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // D2 — storage funded by an internal grant
  // ---------------------------------------------------------------------------
  describe("D2: grant-funded storage", () => {
    const stateOf = (id: string) => prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id } });
    const grantOf = (userId: string, data: Record<string, unknown> = {}) =>
      prisma.planGrant.create({
        data: {
          userId,
          plan: "TEAM",
          source: "INTERNAL_TEST",
          reason: "Internal test access",
          grantedByUserId: admin.userId,
          idempotencyKey: randomUUID(),
          grantedAtUtc: new Date(Date.now() - 86_400_000),
          ...data,
        } as never,
      });

    it("activation records the grant the SKU depended on, from the payer", async () => {
      const { applyStorageSubscriptionObservation } = await import("../src/services/billing/storage-activation.service.js");
      const payer = await freshUser();
      const grant = await grantOf(payer);
      const addon = await addonOf(payer, { status: "PENDING", activatedAtUtc: null });
      const result = await applyStorageSubscriptionObservation({
        provider: "STRIPE",
        subscriptionId: addon.externalSubscriptionId!,
        status: "ACTIVE",
        planId: null,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        observedAtUtc: new Date(),
        source: "TEST",
        claimed: { userId: payer, teamId: null, addonKey: "TEAM_100_GB", attemptId: addon.id },
      } as never);
      expect(result.outcome).toBe("GRANTED");
      expect(await stateOf(addon.id)).toMatchObject({ dependsOnPlanGrantId: grant.id, dependsOnSubscriptionId: null });
    });

    it("expiry owes the cancellation in the transaction that closes the grant; the provider call keeps the paid month", async () => {
      const { closeDueInternalGrants } = await import("../src/services/billing/internal-plan-grant.service.js");
      const { attemptPayerDependentCancellations } = await import("../src/services/billing/dependent-cancellation.service.js");
      const payer = await freshUser();
      const grant = await grantOf(payer, { expiresAtUtc: new Date(Date.now() - 1000) });
      const addon = await addonOf(payer, { dependsOnPlanGrantId: grant.id });
      const untouched = await addonOf(payer);

      await closeDueInternalGrants(prisma);
      const owed = await stateOf(addon.id);
      expect(owed).toMatchObject({
        dependentCancellationState: "PENDING",
        dependentCancellationReasonCode: "ENTITLEMENT_GRANT_ENDED",
      });
      expect((await stateOf(untouched.id)).dependentCancellationState).toBe("NONE");

      await attemptPayerDependentCancellations({ userId: payer });
      expect(await stateOf(addon.id)).toMatchObject({ status: "ACTIVE", dependentCancellationState: "CONFIRMED" });
    });

    it("revocation does the same", async () => {
      const { revokeInternalPlanGrant } = await import("../src/services/billing/internal-plan-grant.service.js");
      const payer = await freshUser();
      const grant = await grantOf(payer);
      const addon = await addonOf(payer, { dependsOnPlanGrantId: grant.id });
      await revokeInternalPlanGrant({ userId: payer, reason: "Testing finished", actorUserId: admin.userId });
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("PENDING");
    });

    it("a live plan that sells the SKU keeps it renewing", async () => {
      const { revokeInternalPlanGrant } = await import("../src/services/billing/internal-plan-grant.service.js");
      const payer = await freshUser("TEAM");
      await baseOf(payer);
      const grant = await grantOf(payer);
      const addon = await addonOf(payer, { dependsOnPlanGrantId: grant.id });
      await revokeInternalPlanGrant({ userId: payer, reason: "Testing finished", actorUserId: admin.userId });
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("NONE");
    });

    it("buying a plan before the attempt withdraws the obligation", async () => {
      const { revokeInternalPlanGrant } = await import("../src/services/billing/internal-plan-grant.service.js");
      const { withdrawUnsupportedObligations } = await import("../src/services/billing/dependent-cancellation.service.js");
      const payer = await freshUser();
      const grant = await grantOf(payer);
      const addon = await addonOf(payer, { dependsOnPlanGrantId: grant.id });
      await revokeInternalPlanGrant({ userId: payer, reason: "Testing finished", actorUserId: admin.userId });
      await baseOf(payer);
      expect(await withdrawUnsupportedObligations({ ownerUserId: payer, teamId: null })).toBe(1);
      expect((await stateOf(addon.id)).dependentCancellationState).toBe("NONE");
    });
  });

  // ---------------------------------------------------------------------------
  // D4 — Stripe customer reuse
  // ---------------------------------------------------------------------------
  describe("D4: Stripe customer binding", () => {
    type Customer = { id: string; livemode: boolean; metadata: Record<string, string>; deleted?: boolean; currency?: string };

    /** A synthetic Stripe, keyed by idempotency key as Stripe's create is. */
    function fakeStripe(environment: "live" | "test" | null = "test") {
      const customers = new Map<string, Customer>();
      const subscriptions = new Map<string, Record<string, unknown>>();
      const byKey = new Map<string, string>();
      let created = 0;
      let down = false;
      return {
        customers,
        subscriptions,
        created: () => created,
        setDown: (value: boolean) => {
          down = value;
        },
        deps: {
          environment: () => environment,
          get: async (path: string) => {
            if (down) throw new Error("stripe unavailable");
            const customer = path.match(/^\/customers\/(.+)$/);
            if (customer) {
              const found = customers.get(decodeURIComponent(customer[1]!));
              if (!found) {
                const { StripeHttpError } = await import("../src/services/stripe.service.js");
                throw new StripeHttpError({ message: "No such customer", status: 404, providerErrorName: "resource_missing", debugId: null } as never);
              }
              return found.deleted ? { id: found.id, deleted: true } : found;
            }
            const subscription = subscriptions.get(decodeURIComponent(path.replace("/subscriptions/", "")));
            if (!subscription) throw new Error(`unexpected read ${path}`);
            return subscription;
          },
          post: async (_path: string, body: URLSearchParams, options?: { idempotencyKey?: string | null }) => {
            if (down) throw new Error("stripe unavailable");
            const key = options?.idempotencyKey ?? randomUUID();
            let id = byKey.get(key);
            if (!id) {
              created += 1;
              id = `cus_${randomUUID().slice(0, 12)}`;
              byKey.set(key, id);
              customers.set(id, { id, livemode: environment === "live", metadata: { userId: body.get("metadata[userId]")! } });
            }
            return customers.get(id)!;
          },
        },
      };
    }

    const resolve = async (userId: string, stripe: ReturnType<typeof fakeStripe>, currency = "EUR") => {
      const { resolveStripeCheckoutCustomer } = await import("../src/services/billing/stripe-customer-binding.service.js");
      return resolveStripeCheckoutCustomer({ userId, currency }, stripe.deps as never);
    };
    const rowFor = (userId: string, environment = "test") =>
      prisma.billingProviderCustomer.findUnique({
        where: { userId_provider_environment: { userId, provider: "STRIPE", environment } },
      });

    it("creates once and reuses after that, sending no personal data", async () => {
      const payer = await freshUser();
      const stripe = fakeStripe();
      const first = await resolve(payer, stripe);
      expect(first).toBeTruthy();
      expect(await resolve(payer, stripe)).toBe(first);
      expect(stripe.created()).toBe(1);
      expect(Object.keys(stripe.customers.get(first!)!.metadata)).toEqual(["userId"]);
      expect(await rowFor(payer)).toMatchObject({ source: "CREATED", state: "ACTIVE", providerCustomerId: first });
    });

    it("concurrent checkouts end on one customer and one row", async () => {
      const payer = await freshUser();
      const stripe = fakeStripe();
      const results = await Promise.all(Array.from({ length: 6 }, () => resolve(payer, stripe)));
      expect(new Set(results).size).toBe(1);
      expect(stripe.created()).toBe(1);
      expect(await prisma.billingProviderCustomer.count({ where: { userId: payer } })).toBe(1);
    });

    it("two owners never share a customer, and test and live never meet", async () => {
      const a = await freshUser();
      const b = await freshUser();
      const test = fakeStripe("test");
      const live = fakeStripe("live");
      const ca = await resolve(a, test);
      expect(await resolve(b, test)).not.toBe(ca);
      const liveA = await resolve(a, live);
      expect(liveA).not.toBe(ca);
      expect((await rowFor(a, "live"))?.providerCustomerId).toBe(liveA);
      expect((await rowFor(a, "test"))?.providerCustomerId).toBe(ca);
    });

    it("a customer already bound to someone else is refused by the database", async () => {
      const a = await freshUser();
      const b = await freshUser();
      await prisma.billingProviderCustomer.create({
        data: { userId: a, provider: "STRIPE", environment: "test", providerCustomerId: "cus_taken", source: "CREATED" },
      });
      await expect(
        prisma.billingProviderCustomer.create({
          data: { userId: b, provider: "STRIPE", environment: "test", providerCustomerId: "cus_taken", source: "CREATED" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("adopts the live base plan's customer when its metadata names the owner", async () => {
      const payer = await freshUser("PRO");
      const base = await baseOf(payer, { plan: "PRO" });
      const stripe = fakeStripe();
      stripe.customers.set("cus_old", { id: "cus_old", livemode: false, metadata: {} });
      stripe.subscriptions.set(base.providerSubId, { customer: "cus_old", metadata: { userId: payer } });
      expect(await resolve(payer, stripe)).toBe("cus_old");
      expect(await rowFor(payer)).toMatchObject({ source: "ADOPTED_BASE_PLAN", providerCustomerId: "cus_old" });
      expect(stripe.created()).toBe(0);
    });

    it("a subscription naming another owner is not adopted, and nothing is created", async () => {
      const payer = await freshUser("PRO");
      const base = await baseOf(payer, { plan: "PRO" });
      const stripe = fakeStripe();
      stripe.subscriptions.set(base.providerSubId, { customer: "cus_old", metadata: { userId: randomUUID() } });
      expect(await resolve(payer, stripe)).toBeNull();
      expect(await rowFor(payer)).toBeNull();
      expect(stripe.created()).toBe(0);
    });

    it("several add-on customers with no base choose nothing and leave their references alone", async () => {
      const payer = await freshUser();
      const one = await addonOf(payer, { addonKey: "PERSONAL_50_GB" });
      const two = await addonOf(payer, { addonKey: "PERSONAL_50_GB" });
      const stripe = fakeStripe();
      stripe.subscriptions.set(one.externalSubscriptionId!, { customer: "cus_a", metadata: { userId: payer } });
      stripe.subscriptions.set(two.externalSubscriptionId!, { customer: "cus_b", metadata: { userId: payer } });
      expect(await resolve(payer, stripe)).toBeNull();
      expect(await rowFor(payer)).toBeNull();
    });

    it("one add-on customer with no base is adopted", async () => {
      const payer = await freshUser();
      const one = await addonOf(payer, { addonKey: "PERSONAL_50_GB" });
      const stripe = fakeStripe();
      stripe.customers.set("cus_a", { id: "cus_a", livemode: false, metadata: {} });
      stripe.subscriptions.set(one.externalSubscriptionId!, { customer: "cus_a", metadata: { userId: payer } });
      expect(await resolve(payer, stripe)).toBe("cus_a");
      expect((await rowFor(payer))?.source).toBe("ADOPTED_STORAGE");
    });

    it("a deleted customer is replaced, keeping the old reference on the row", async () => {
      const payer = await freshUser();
      const stripe = fakeStripe();
      const first = (await resolve(payer, stripe))!;
      stripe.customers.get(first)!.deleted = true;
      const second = await resolve(payer, stripe);
      expect(second).not.toBe(first);
      expect(await rowFor(payer)).toMatchObject({ providerCustomerId: second, replacedProviderCustomerId: first });
    });

    it("a record naming someone else or the wrong environment becomes a conflict for review, never rebound", async () => {
      const payer = await freshUser();
      const stripe = fakeStripe();
      const first = (await resolve(payer, stripe))!;
      stripe.customers.get(first)!.metadata.userId = randomUUID();
      expect(await resolve(payer, stripe)).toBeNull();
      expect((await rowFor(payer))?.state).toBe("CONFLICT");
      expect(await resolve(payer, stripe)).toBeNull();
      expect(stripe.created()).toBe(1);
      expect(
        await prisma.billingReviewItem.count({ where: { userId: payer, reason: "PROVIDER_CUSTOMER_CONFLICT" } }),
      ).toBe(1);
    });

    it("an outage leaves the row alone and the checkout goes without a customer", async () => {
      const payer = await freshUser();
      const stripe = fakeStripe();
      const first = (await resolve(payer, stripe))!;
      stripe.setDown(true);
      expect(await resolve(payer, stripe)).toBeNull();
      expect((await rowFor(payer))?.providerCustomerId).toBe(first);
    });

    it("a customer billed in another currency sits this checkout out and stays bound", async () => {
      const payer = await freshUser();
      const stripe = fakeStripe();
      const first = (await resolve(payer, stripe))!;
      stripe.customers.get(first)!.currency = "usd";
      expect(await resolve(payer, stripe, "EUR")).toBeNull();
      expect(await resolve(payer, stripe, "USD")).toBe(first);
    });

    it("an unrecognised key mode binds nothing", async () => {
      const payer = await freshUser();
      expect(await resolve(payer, fakeStripe(null))).toBeNull();
      expect(await rowFor(payer)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // D5 — a credit and a failed operation
  // ---------------------------------------------------------------------------
  describe("D5: credits and failure", () => {
    async function creditedRecord() {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 2 });
      await prisma.evidence.createMany({
        data: Array.from({ length: 3 }, () => ({
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO" as const,
        })),
      });
      const record = await prisma.evidence.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO",
        },
        select: { id: true },
      });
      const { resolveEnforcementScopeForRequester, settleEvidenceCompletionFunding } = await import(
        "../src/services/billing-enforcement.service.js"
      );
      const settle = async (tx: unknown) =>
        settleEvidenceCompletionFunding(
          {
            scope: await resolveEnforcementScopeForRequester({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }),
            evidenceId: record.id,
          },
          tx as never,
        );
      const credits = async () =>
        (await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits;
      return { t, record, settle, credits };
    }

    it("a completion that does not commit leaves no spend and no ledger row", async () => {
      const { record, settle, credits } = await creditedRecord();
      await expect(
        prisma.$transaction(async (tx) => {
          expect((await settle(tx)).funding).toBe("EVIDENCE_CREDIT");
          throw new Error("signing failed after settlement");
        }),
      ).rejects.toThrow("signing failed");
      expect(await credits()).toBe(2);
      expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: record.id } })).toBe(0);
    });

    it("a committed record re-settled after an output failure costs nothing more", async () => {
      const { record, settle, credits } = await creditedRecord();
      await prisma.$transaction((tx) => settle(tx));
      expect(await credits()).toBe(1);
      expect((await prisma.$transaction((tx) => settle(tx))).funding).toBe("EVIDENCE_CREDIT");
      expect(await credits()).toBe(1);
      expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: record.id } })).toBe(1);
    });

    it("the record reads as credit-funded, so the status can say so", async () => {
      const { record, settle } = await creditedRecord();
      await prisma.$transaction((tx) => settle(tx));
      const { resolveEvidenceFunding } = await import("../src/services/billing/evidence-credits.service.js");
      expect(await resolveEvidenceFunding(record.id)).toBe("EVIDENCE_CREDIT");
    });
  });
});
