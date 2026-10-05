/**
 * INTERNAL PLAN GRANT — apply / revoke / expire, resolution, checkout and the
 * admin surface, on live PostgreSQL 16 through the real API.
 *
 * What a grant is allowed to do: put an account's PERSONAL subject on TEAM
 * (source INTERNAL_GRANT) through the canonical resolution. What it must never
 * do: write entitlements, subscriptions, payments, checkout attempts, credit
 * ledger rows, workspaces or memberships; let a provider event remove it; or
 * let anyone but a stepped-up Platform Admin create one.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

type Json = Record<string, unknown>;

describe("INTERNAL PLAN GRANT (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let grants: typeof import("../src/services/billing/internal-plan-grant.service.js");
  let commercial: typeof import("../src/services/billing/commercial-context.service.js");
  let billing: typeof import("../src/services/billing.service.js");
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let caps: typeof import("@proovra/shared-billing");
  let admin: { userId: string; token: string; teamId: string };
  const secrets = new Map<string, Buffer>();

  const call = (opts: { method: "GET" | "POST"; url: string; token?: string; payload?: unknown; challengeId?: string }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.challengeId ? { "x-proovra-step-up-challenge-id": opts.challengeId } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;
  const code = (res: { body: string }) => (json(res).error as Json | undefined)?.code ?? json(res).code;

  async function seedTotp(userId: string) {
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    const secret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const now = new Date();
    await prisma.mfaFactor.create({
      data: {
        userId,
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
    secrets.set(userId, secret);
  }

  async function stepUp(subjectUserId?: string): Promise<string> {
    await prisma.mfaFactor.updateMany({ where: { userId: admin.userId, kind: "TOTP" }, data: { lastUsedAt: null } });
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token: admin.token,
      payload: {
        teamId: admin.teamId,
        purpose: "CAPABILITY_GRANT",
        resourceKind: "internal_plan_grant",
        ...(subjectUserId ? { resourceId: subjectUserId } : {}),
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (json(started).challenge as { id: string }).id;
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: admin.token,
      payload: {
        teamId: admin.teamId,
        challengeId,
        code: totp.computeTotpCode(secrets.get(admin.userId)!, totp.timeStep(Math.floor(Date.now() / 1000))),
      },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  const key = () => `itest-${randomUUID()}`;

  async function applyViaService(t: PersonalTenant, extra: Partial<Parameters<typeof grants.applyInternalPlanGrant>[0]> = {}, now?: Date) {
    return grants.applyInternalPlanGrant(
      { userId: t.owner.userId, plan: "TEAM", reason: "internal test access", idempotencyKey: key(), actorUserId: admin.userId, ...extra },
      undefined,
      now,
    );
  }

  const personal = (userId: string) => commercial.resolveCommercialContext({ type: "PERSONAL_ACCOUNT", userId });

  /** Every row a grant must never create, for one account. */
  async function footprint(userId: string) {
    const ent = await prisma.entitlement.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, plan: true, credits: true, teamSeats: true, active: true, legacyRecordCapOverride: true },
    });
    return {
      entitlements: ent,
      subscriptions: await prisma.subscription.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, plan: true } }),
      payments: await prisma.payment.count({ where: { userId } }),
      checkoutAttempts: await prisma.billingCheckoutAttempt.count({ where: { userId } }),
      ledger: await prisma.evidenceCreditLedgerEntry.count({ where: { userId } }),
      teams: await prisma.team.count({ where: { ownerUserId: userId } }),
      memberships: await prisma.teamMember.count({ where: { userId } }),
      evidence: await prisma.evidence.count({ where: { ownerUserId: userId } }),
    };
  }

  const auditCount = (action: string, resourceId: string) =>
    prisma.adminAuditLog.count({ where: { action, resourceId } });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    grants = await import("../src/services/billing/internal-plan-grant.service.js");
    commercial = await import("../src/services/billing/commercial-context.service.js");
    billing = await import("../src/services/billing.service.js");
    totp = await import("../src/services/security/mfa-totp.js");
    caps = await import("@proovra/shared-billing");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `ipg-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    // A REAL platform admin (persisted state), with an authenticator and an
    // anchor workspace for the team-bound step-up ceremony.
    const staff = await seedUser(deps, "platform-admin");
    await prisma.user.update({ where: { id: staff.userId }, data: { platformRole: "admin" } });
    const org = await prisma.organization.create({
      data: { name: `IPG anchor ${deps.tag}`, billingOwnerUserId: staff.userId, status: "ACTIVE", kind: "CUSTOMER" },
      select: { id: true },
    });
    await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: staff.userId, role: "ORG_OWNER" } });
    const team = await prisma.team.create({
      data: { name: `IPG anchor ${deps.tag}`, ownerUserId: staff.userId, isPersonal: false, organizationId: org.id, workspaceKind: "ORGANIZATION" },
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: staff.userId, role: "OWNER", status: "ACTIVE" } });
    await seedTotp(staff.userId);
    admin = { userId: staff.userId, token: staff.token, teamId: team.id };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // (1) (2) (13) (14) ---------------------------------------------------------
  it("no grant → FREE; an applied TEAM grant → TEAM / INTERNAL_GRANT everywhere, and nothing else is written", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const before = await personal(t.owner.userId);
    expect(before.plan).toBe("FREE");
    expect(before.scope.planSource).toBe("PERSONAL_ENTITLEMENT");
    const rowsBefore = await footprint(t.owner.userId);

    const res = await call({
      method: "POST",
      url: "/v1/admin/billing/internal-plan-grants",
      token: admin.token,
      challengeId: await stepUp(t.owner.userId),
      payload: { teamId: admin.teamId, email: t.owner.email.toUpperCase(), plan: "TEAM", reason: "QA test account", idempotencyKey: key() },
    });
    expect(res.statusCode, res.body).toBe(201);
    const grant = (json(res).grant as Json);
    expect(grant).toMatchObject({ userId: t.owner.userId, plan: "TEAM", source: "INTERNAL_TEST", revokedAtUtc: null });

    const after = await personal(t.owner.userId);
    expect(after.plan).toBe("TEAM");
    expect(after.scope.planSource).toBe("INTERNAL_GRANT");
    expect(after.scope.providerPlan).toBe("FREE");
    // Canonical TEAM configuration — not copied numbers.
    expect(after.capabilities).toEqual(caps.getPlanCapabilities("TEAM"));
    expect(after.lifecycle).toMatchObject({ state: "ACTIVE", mutationsAllowed: true, paidActive: false, providerStatus: null });

    // Nothing but the grant was written.
    expect(await footprint(t.owner.userId)).toEqual(rowsBefore);
    expect(await auditCount("billing.internal_grant.applied", grant.id as string)).toBe(1);

    // Web and mobile read the same surfaces.
    const ctx = json(await call({ method: "GET", url: "/v1/platform/context", token: t.owner.token }));
    expect((ctx.account as Json).accountPlan).toBe("TEAM");
    expect((ctx.personalSpace as Json).plan).toBe("TEAM");
    const account = await call({ method: "GET", url: `/v1/billing/accounts/PERSONAL/${t.owner.userId}`, token: t.owner.token });
    expect(account.statusCode, account.body).toBe(200);
    const plan = (json(account).plan as Json);
    expect(plan).toMatchObject({ planKey: "TEAM", accessKind: "GRANTED", accessSource: "INTERNAL_GRANT" });
    expect(json(account).planOffers ?? []).toEqual([]);
  });

  // (3) (6) (15) ---------------------------------------------------------------
  it("revoke falls back to the provider plan at once, and leaves provider state untouched", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    await prisma.subscription.create({
      data: { userId: t.owner.userId, provider: "STRIPE", providerSubId: `sub_ipg_${randomUUID()}`, status: "ACTIVE", plan: "PRO" },
    });
    await applyViaService(t);
    expect((await personal(t.owner.userId)).plan).toBe("TEAM");
    const providerBefore = await footprint(t.owner.userId);

    const res = await call({
      method: "POST",
      url: "/v1/admin/billing/internal-plan-grants/revoke",
      token: admin.token,
      challengeId: await stepUp(t.owner.userId),
      payload: { teamId: admin.teamId, userId: t.owner.userId, reason: "test finished" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const revoked = json(res).revoked as Json;
    expect(revoked).toMatchObject({ revocationReason: "OPERATOR_REVOKED", revokedByUserId: admin.userId });
    expect(await auditCount("billing.internal_grant.revoked", revoked.id as string)).toBe(1);

    const after = await personal(t.owner.userId);
    expect(after.plan).toBe("PRO");
    expect(after.scope.planSource).toBe("PERSONAL_ENTITLEMENT");
    expect(await footprint(t.owner.userId)).toEqual(providerBefore);

    // Idempotent: nothing active → nothing changes, nothing recorded.
    const again = await grants.revokeInternalPlanGrant({ userId: t.owner.userId, reason: "again", actorUserId: admin.userId });
    expect(again.revoked).toBeNull();
    expect(await auditCount("billing.internal_grant.revoked", revoked.id as string)).toBe(1);
  });

  it("an expired grant stops governing immediately; the sweep closes it EXPIRED with one event", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { grant } = await applyViaService(t, { expiresAtUtc: new Date(Date.now() - 60 * 60 * 1000) }, past);
    expect((await personal(t.owner.userId)).plan).toBe("FREE");
    const swept = await grants.expireInternalPlanGrants();
    expect(swept.expired.map((g) => g.id)).toContain(grant.id);
    const row = await prisma.planGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.revocationReason).toBe("EXPIRED");
    expect(await auditCount("billing.internal_grant.expired", grant.id)).toBe(1);
    // A new grant can follow an expired one.
    expect((await applyViaService(t)).created).toBe(true);
    expect((await personal(t.owner.userId)).plan).toBe("TEAM");
  });

  // (4) ------------------------------------------------------------------------
  it("a grant never lowers a provider plan: on a tie the provider governs", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    await applyViaService(t);
    const ctx = await personal(t.owner.userId);
    expect(ctx.plan).toBe("TEAM");
    expect(ctx.scope.planSource).toBe("PERSONAL_ENTITLEMENT");
    expect(caps.resolvePersonalEffectivePlan({ providerPlan: "ENTERPRISE", internalGrantPlan: "TEAM" })).toEqual({
      plan: "ENTERPRISE",
      source: "PERSONAL_ENTITLEMENT",
    });
  });

  // (5) ------------------------------------------------------------------------
  it("a provider cancellation does not remove an active grant, and its lapse does not block the account", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    const sub = await prisma.subscription.create({
      data: { userId: t.owner.userId, provider: "PAYPAL", providerSubId: `I-IPG${randomUUID().slice(0, 8)}`, status: "ACTIVE", plan: "PRO" },
    });
    const { grant } = await applyViaService(t);
    // What the provider lifecycle does on a cancellation with nothing else live.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "CANCELED", currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    await billing.setPersonalPlan(t.owner.userId, "FREE");

    const row = await prisma.planGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.revokedAtUtc).toBeNull();
    const ctx = await personal(t.owner.userId);
    expect(ctx.plan).toBe("TEAM");
    expect(ctx.scope.providerPlan).toBe("FREE");
    expect(ctx.lifecycle.mutationsAllowed).toBe(true);
  });

  // (7) (8) --------------------------------------------------------------------
  it("a repeated idempotency key returns the same grant and one applied event; a reused key for another subject is refused", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const k = key();
    const first = await applyViaService(t, { idempotencyKey: k });
    const second = await applyViaService(t, { idempotencyKey: k });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.grant.id).toBe(first.grant.id);
    expect(await prisma.planGrant.count({ where: { userId: t.owner.userId } })).toBe(1);
    expect(await auditCount("billing.internal_grant.applied", first.grant.id)).toBe(1);

    const other = await seedPersonalTenant(deps, "FREE");
    await expect(applyViaService(other, { idempotencyKey: k })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(await prisma.planGrant.count({ where: { userId: other.owner.userId } })).toBe(0);
  });

  it("concurrent applies cannot create two active grants", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => applyViaService(t)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "GRANT_ALREADY_ACTIVE" });
    expect(await prisma.planGrant.count({ where: { userId: t.owner.userId, revokedAtUtc: null } })).toBe(1);

    // Same key, concurrently: one grant, all answered with it.
    const u = await seedPersonalTenant(deps, "FREE");
    const k = key();
    const same = await Promise.all(Array.from({ length: 4 }, () => applyViaService(u, { idempotencyKey: k })));
    expect(new Set(same.map((r) => r.grant.id)).size).toBe(1);
    expect(same.filter((r) => r.created)).toHaveLength(1);
  });

  // (9) ------------------------------------------------------------------------
  it("checkout of a granted (or lower) plan is refused before any provider object; ENTERPRISE is not hidden by it", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    await applyViaService(t);
    const before = await footprint(t.owner.userId);
    for (const url of ["/v1/billing/checkout/stripe", "/v1/billing/checkout/paypal"]) {
      for (const plan of ["TEAM", "PRO"]) {
        const res = await call({ method: "POST", url, token: t.owner.token, payload: { plan } });
        expect(res.statusCode, `${url} ${plan}: ${res.body}`).toBe(409);
        expect(code(res)).toBe("INTERNAL_GRANT_ACTIVE");
      }
    }
    expect(await footprint(t.owner.userId)).toEqual(before);
    expect(await grants.internalGrantCheckoutRefusal(t.owner.userId, "ENTERPRISE")).toBeNull();
  });

  // (10) (11) (12) ---------------------------------------------------------------
  it("refuses a non-admin, an admin without step-up, and an ambiguous or missing subject — writing nothing", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const body = { teamId: admin.teamId, userId: t.owner.userId, plan: "TEAM", reason: "probe", idempotencyKey: key() };

    const notAdmin = await call({ method: "POST", url: "/v1/admin/billing/internal-plan-grants", token: t.owner.token, payload: body });
    expect(notAdmin.statusCode).toBe(403);
    const noStepUp = await call({ method: "POST", url: "/v1/admin/billing/internal-plan-grants", token: admin.token, payload: body });
    expect(noStepUp.statusCode).toBe(401);
    expect(code(noStepUp)).toBe("STEP_UP_REQUIRED");
    const wrongPlan = await call({
      method: "POST",
      url: "/v1/admin/billing/internal-plan-grants",
      token: admin.token,
      challengeId: await stepUp(),
      payload: { ...body, plan: "ENTERPRISE" },
    });
    expect(wrongPlan.statusCode).toBe(400);
    expect(await prisma.planGrant.count({ where: { userId: t.owner.userId } })).toBe(0);

    // An approval minted for ANOTHER account cannot be spent on this one.
    const elsewhere = await seedPersonalTenant(deps, "FREE");
    const misbound = await call({
      method: "POST",
      url: "/v1/admin/billing/internal-plan-grants",
      token: admin.token,
      challengeId: await stepUp(elsewhere.owner.userId),
      payload: body,
    });
    expect([401, 403], misbound.body).toContain(misbound.statusCode);
    expect(await prisma.planGrant.count({ where: { userId: { in: [t.owner.userId, elsewhere.owner.userId] } } })).toBe(0);

    const missing = await call({
      method: "POST",
      url: "/v1/admin/billing/internal-plan-grants",
      token: admin.token,
      challengeId: await stepUp(),
      payload: { teamId: admin.teamId, email: `nobody-${randomUUID()}@test.proovra.local`, plan: "TEAM", reason: "probe", idempotencyKey: key() },
    });
    expect(missing.statusCode).toBe(404);
    expect(code(missing)).toBe("SUBJECT_NOT_FOUND");

    // Two accounts whose emails differ only in case.
    const shared = `ipg-dup-${randomUUID().slice(0, 8)}@test.proovra.local`;
    for (const email of [shared, shared.toUpperCase()]) {
      await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email, firstName: "IPG", lastName: "dup" } });
    }
    const countBefore = await prisma.planGrant.count();
    await expect(
      grants.applyInternalPlanGrant({ email: shared, plan: "TEAM", reason: "probe", idempotencyKey: key(), actorUserId: admin.userId }),
    ).rejects.toMatchObject({ code: "SUBJECT_AMBIGUOUS" });
    await expect(
      grants.applyInternalPlanGrant({ plan: "TEAM", reason: "probe", idempotencyKey: key(), actorUserId: admin.userId }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      grants.applyInternalPlanGrant({
        userId: t.owner.userId,
        email: t.owner.email,
        plan: "TEAM",
        reason: "probe",
        idempotencyKey: key(),
        actorUserId: admin.userId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await prisma.planGrant.count()).toBe(countBefore);
  });

  it("the database refuses a non-TEAM grant and a second unrevoked grant even past the service", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const base = { userId: t.owner.userId, source: "INTERNAL_TEST" as const, reason: "db probe", grantedByUserId: admin.userId };
    await expect(prisma.planGrant.create({ data: { ...base, plan: "PRO", idempotencyKey: key() } })).rejects.toThrow();
    await prisma.planGrant.create({ data: { ...base, plan: "TEAM", idempotencyKey: key() } });
    await expect(prisma.planGrant.create({ data: { ...base, plan: "TEAM", idempotencyKey: key() } })).rejects.toThrow();
  });
});
