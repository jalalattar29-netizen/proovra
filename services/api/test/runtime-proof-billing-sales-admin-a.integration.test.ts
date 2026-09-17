/**
 * BATCH K7 (part A) — runtime proof for the platform-admin sales and billing
 * actions the UI mutation sweep could not drive to their SUCCESS branch.
 *
 *   POST  /v1/admin/audit-log                          admin-audit.routes.ts
 *   POST  /v1/admin/billing/evidence-credits           admin-billing.routes.ts
 *   POST  /v1/admin/demo-requests/:id/route            admin-demo-requests.routes.ts
 *   POST  /v1/admin/demo-requests/:id/follow-up/send   admin-demo-requests.routes.ts
 *   PATCH /v1/admin/orgs/:id/plan                      admin-provisioning.routes.ts
 *   POST  /v1/admin/enterprise/provision               admin-provisioning.routes.ts
 *
 * Every payload is the one the real consumer builds:
 *   - apps/web/app/(app)/admin/users/[id]/EvidenceCreditGrant.tsx
 *   - apps/web/app/(app)/admin/demo-requests/page.tsx (saveRouting, sendFollowUp)
 *   - apps/web/app/(app)/admin/provisioning/page.tsx (grant plan, provision)
 * `POST /v1/admin/audit-log` has no product consumer (OWN-5: API-only); its
 * body is the route's own zod schema.
 *
 * The platform operator is a real `User.platformRole = 'admin'` row. Step-up is
 * satisfied exactly as `step-up-totp-org-boundary.integration.test.ts` does it:
 * a verified authenticator factor and the real start/check routes, bound to
 * the workspace the operator stands in. Email goes to the local RECORDING
 * transport; no provider is contacted.
 *
 * Disposable local PostgreSQL + Redis only — the harness refuses anything else.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  registerSessionForToken,
  seedOrganizationTenant,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

type Method = "POST" | "PATCH";

describe("K7-A — platform admin sales + billing actions (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let deps: FixtureDeps;

  const tag = `k7a-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const secrets = new Map<string, Buffer>();
  /** Highest TOTP time-step already spent per user (the replay guard is monotonic). */
  const lastStep = new Map<string, number>();

  /** An authenticated user with no platform role. */
  let normalUser: SeededUser;

  const call = (opts: {
    method: Method;
    url: string;
    token?: string | null;
    payload?: unknown;
    headers?: Record<string, string>;
    remoteAddress?: string;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  // Response bodies are asserted structurally below; a loose read type keeps each assertion one line.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;

  function mintToken(userId: string, email: string, role: "admin" | null): string {
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
        ...(role === "admin" ? { role: "admin" as const } : {}),
      },
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );
  }

  async function seedTotp(userId: string): Promise<void> {
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

  /** The next code the replay guard will accept: strictly later than the last one spent, inside ±1 step. */
  function nextCode(userId: string): string {
    const current = totp.timeStep(Math.floor(Date.now() / 1000));
    const step = Math.max((lastStep.get(userId) ?? -Infinity) + 1, current - 1);
    if (step > current + 1) throw new Error("no unspent TOTP step left in the window for this operator");
    lastStep.set(userId, step);
    return totp.computeTotpCode(secrets.get(userId)!, step);
  }

  type Operator = SeededUser & { stepUpTeamId: string };

  /**
   * A platform operator exactly as production has one: a DB platform role, a
   * verified authenticator app, and a workspace to stand in (the web pages send
   * the active workspace as `teamId`, which binds the step-up and nothing else).
   */
  async function newOperator(label: string): Promise<Operator> {
    const user = await seedUser(deps, label);
    await prisma.user.update({ where: { id: user.userId }, data: { platformRole: "admin" } });
    const token = mintToken(user.userId, user.email, "admin");
    await registerSessionForToken(deps, user.userId, token);
    const stepUpTeamId = harness.fixtures.teamA.teamId;
    await prisma.teamMember.create({
      data: { teamId: stepUpTeamId, userId: user.userId, role: "ADMIN", status: "ACTIVE" },
    });
    await seedTotp(user.userId);
    return { ...user, token, stepUpTeamId };
  }

  /** Start + approve a step-up through the real routes; returns the challenge id. */
  async function approvedStepUp(
    op: Operator,
    purpose: string,
    resourceKind: string,
    resourceId: string | null,
  ): Promise<string> {
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token: op.token,
      payload: {
        teamId: op.stepUpTeamId,
        purpose,
        resourceKind,
        ...(resourceId ? { resourceId } : {}),
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(json(started).method).toBe("TOTP");
    const challengeId = json(started).challenge.id as string;
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: op.token,
      payload: { teamId: op.stepUpTeamId, challengeId, code: nextCode(op.userId) },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(json(checked).status).toBe("approved");
    return challengeId;
  }

  /** Fire-and-forget audits (`void emitPlatformAudit(...)`) land after the response. */
  function waitForAudit(where: Record<string, unknown>) {
    return vi.waitFor(
      async () => {
        const row = await prisma.adminAuditLog.findFirst({ where, orderBy: { createdAt: "desc" } });
        if (!row) throw new Error(`audit row not yet written: ${JSON.stringify(where)}`);
        return row;
      },
      { timeout: 5_000, interval: 25 },
    );
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    deps = {
      prisma: prisma as never,
      tag,
      mintToken: (userId, email) => mintToken(userId, email, null),
    };
    normalUser = await seedUser(deps, "normal");
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // ===========================================================================
  // POST /v1/admin/audit-log
  // ===========================================================================

  describe("POST /v1/admin/audit-log", () => {
    it("a platform admin records a manual entry: 201 and a PLATFORM-scoped chain row naming the session actor", async () => {
      const op = await newOperator("audit-writer");
      const resourceId = randomUUID();
      const action = `support.manual_note.${tag.replace(/[^a-z0-9]/g, "")}`;
      const res = await call({
        method: "POST",
        url: "/v1/admin/audit-log",
        token: op.token,
        payload: {
          action,
          category: "support",
          severity: "warning",
          source: "incident-console",
          outcome: "success",
          resourceType: "organization",
          resourceId,
          requestId: "k7-req-1",
          metadata: { ticket: "INC-1042" },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(json(res)).toEqual({ ok: true });

      const row = await prisma.adminAuditLog.findFirstOrThrow({ where: { action, resourceId } });
      expect(row).toMatchObject({
        userId: op.userId,
        category: "platform_admin_manual",
        source: "admin_api",
        severity: "warning",
        outcome: "success",
        resourceType: "organization",
        organizationId: null,
        workspaceId: null,
        requestId: "k7-req-1",
        actorType: "HUMAN",
      });
      expect(row.metadata).toMatchObject({
        scope: "PLATFORM",
        adminManual: true,
        requestedCategory: "support",
        requestedSource: "incident-console",
        ticket: "INC-1042",
      });
      expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("a non-admin is refused 403 FORBIDDEN and a malformed action is 400 — neither writes a row", async () => {
      const op = await newOperator("audit-bad");
      const action = `support.refused.${tag.replace(/[^a-z0-9]/g, "")}`;
      const refused = await call({
        method: "POST",
        url: "/v1/admin/audit-log",
        token: normalUser.token,
        payload: { action },
      });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error.code).toBe("FORBIDDEN");

      const invalid = await call({
        method: "POST",
        url: "/v1/admin/audit-log",
        token: op.token,
        payload: { action: "Not A Valid Action!" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(json(invalid).error.details).toEqual({ reason: "invalid_action" });

      expect(
        await prisma.adminAuditLog.count({
          where: { action: { in: [action, "Not A Valid Action!"] } },
        }),
      ).toBe(0);
    });
  });

  // ===========================================================================
  // POST /v1/admin/billing/evidence-credits
  // ===========================================================================

  describe("POST /v1/admin/billing/evidence-credits", () => {
    it("grants credits to a personal account through the wallet ledger, audits the movement, and a retry moves nothing", async () => {
      const op = await newOperator("credit-granter");
      const customer = await seedPersonalTenant(deps, "FREE", { credits: 2 });
      const body = {
        userId: customer.owner.userId,
        credits: 5,
        reason: "Goodwill after incident INC-1042",
        idempotencyKey: "INC-1042",
      };
      const res = await call({
        method: "POST",
        url: "/v1/admin/billing/evidence-credits",
        token: op.token,
        payload: body,
      });
      expect(res.statusCode, res.body).toBe(200);
      const grantRef = `${customer.owner.userId}:INC-1042`;
      expect(json(res)).toEqual({
        userId: customer.owner.userId,
        credits: 5,
        applied: true,
        previousBalance: 2,
        balanceAfter: 7,
        grantRef,
      });

      const entitlement = await prisma.entitlement.findFirstOrThrow({
        where: { userId: customer.owner.userId, active: true },
      });
      expect(entitlement.credits).toBe(7);
      const ledger = await prisma.evidenceCreditLedgerEntry.findUniqueOrThrow({ where: { grantRef } });
      expect(ledger).toMatchObject({
        userId: customer.owner.userId,
        entryType: "ADMIN_GRANT",
        creditsDelta: 5,
        balanceAfter: 7,
        provider: null,
      });

      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "billing.evidence_credits_granted", resourceId: customer.owner.userId },
      });
      expect(audit).toMatchObject({
        userId: op.userId,
        resourceType: "billing_credit",
        outcome: "success",
        organizationId: null,
        workspaceId: null,
        actorType: "HUMAN",
      });
      expect(audit.metadata).toMatchObject({
        targetUserId: customer.owner.userId,
        credits: 5,
        reason: "Goodwill after incident INC-1042",
        previousBalance: 2,
        resultingBalance: 7,
        applied: true,
      });

      // The same reference is a retry: nothing moves, and the audit says so.
      const retry = await call({
        method: "POST",
        url: "/v1/admin/billing/evidence-credits",
        token: op.token,
        payload: body,
      });
      expect(retry.statusCode).toBe(200);
      expect(json(retry)).toMatchObject({ applied: false, previousBalance: 7, balanceAfter: 7 });
      expect(
        (await prisma.entitlement.findFirstOrThrow({ where: { userId: customer.owner.userId, active: true } }))
          .credits,
      ).toBe(7);
      expect(
        await prisma.evidenceCreditLedgerEntry.count({ where: { userId: customer.owner.userId, entryType: "ADMIN_GRANT" } }),
      ).toBe(1);
    });

    it("a workspace OWNER (no platform role) is refused 403, and an unknown account is 404 — no ledger row either way", async () => {
      const op = await newOperator("credit-missing");
      const customer = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      const refused = await call({
        method: "POST",
        url: "/v1/admin/billing/evidence-credits",
        token: harness.fixtures.teamA.ownerToken,
        payload: { userId: customer.owner.userId, credits: 50, reason: "self-help", idempotencyKey: "SELF-1" },
      });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error.code).toBe("FORBIDDEN");

      const missing = await call({
        method: "POST",
        url: "/v1/admin/billing/evidence-credits",
        token: op.token,
        payload: { userId: randomUUID(), credits: 1, reason: "typo", idempotencyKey: "TYPO-1" },
      });
      expect(missing.statusCode).toBe(404);
      expect(json(missing).error.code).toBe("USER_NOT_FOUND");

      expect(await prisma.evidenceCreditLedgerEntry.count({ where: { userId: customer.owner.userId } })).toBe(0);
      expect(
        (await prisma.entitlement.findFirstOrThrow({ where: { userId: customer.owner.userId, active: true } }))
          .credits,
      ).toBe(0);
    });
  });

  // ===========================================================================
  // /v1/admin/demo-requests/:id/route and /follow-up/send
  // ===========================================================================

  async function seedDemo(extra: Record<string, unknown> = {}) {
    const id = randomUUID();
    return prisma.demoRequest.create({
      data: {
        id,
        fullName: "Dana Prospect",
        workEmail: `dana-${tag}-${id.slice(0, 8)}@fixture-demo.local`,
        organization: "Fixture Demo Co",
        jobTitle: "Head of Legal Operations",
        country: "PT",
        teamSize: "11-50",
        useCase: "Evaluating chain-of-custody evidence capture for insurance disputes.",
        message: "Interested in the verification package format.",
        source: "k7-runtime-proof",
        status: "NEW",
        ...extra,
      },
    });
  }

  describe("POST /v1/admin/demo-requests/:id/route", () => {
    it("routes a request to the enterprise desk: routing columns written and audited with previous/next", async () => {
      const op = await newOperator("demo-router");
      const demo = await seedDemo({ routingTarget: "AUTO_RESOURCES" });
      const res = await call({
        method: "POST",
        url: `/v1/admin/demo-requests/${demo.id}/route`,
        token: op.token,
        payload: { routingTarget: "ENTERPRISE_DESK", routingReason: "500-seat insurer" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).item).toMatchObject({
        id: demo.id,
        routingTarget: "ENTERPRISE_DESK",
        routingReason: "500-seat insurer",
        routedByUserId: op.userId,
      });

      const row = await prisma.demoRequest.findUniqueOrThrow({ where: { id: demo.id } });
      expect(row.routingTarget).toBe("ENTERPRISE_DESK");
      expect(row.routingReason).toBe("500-seat insurer");
      expect(row.routedByUserId).toBe(op.userId);
      expect(row.routedAt).not.toBeNull();

      const audit = await waitForAudit({ action: "admin.demo_requests.route", resourceId: demo.id });
      expect(audit).toMatchObject({ userId: op.userId, resourceType: "demo_request", outcome: "success" });
      expect(audit.metadata).toMatchObject({
        previousRoutingTarget: "AUTO_RESOURCES",
        nextRoutingTarget: "ENTERPRISE_DESK",
        nextRoutingReason: "500-seat insurer",
      });
    });

    it("a non-admin is refused 403 and an unknown id is 404 — the routing is untouched", async () => {
      const op = await newOperator("demo-router-refusal");
      const demo = await seedDemo({ routingTarget: "AUTO_RESOURCES" });
      const refused = await call({
        method: "POST",
        url: `/v1/admin/demo-requests/${demo.id}/route`,
        token: normalUser.token,
        payload: { routingTarget: "MANUAL_SALES", routingReason: null },
      });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error.code).toBe("FORBIDDEN");

      const missing = await call({
        method: "POST",
        url: `/v1/admin/demo-requests/${randomUUID()}/route`,
        token: op.token,
        payload: { routingTarget: "MANUAL_SALES", routingReason: null },
      });
      expect(missing.statusCode).toBe(404);

      const row = await prisma.demoRequest.findUniqueOrThrow({ where: { id: demo.id } });
      expect(row.routingTarget).toBe("AUTO_RESOURCES");
      expect(row.routedAt).toBeNull();
      expect(row.routedByUserId).toBeNull();
      expect(
        await prisma.adminAuditLog.count({ where: { action: "admin.demo_requests.route", resourceId: demo.id } }),
      ).toBe(0);
    });
  });

  describe("POST /v1/admin/demo-requests/:id/follow-up/send", () => {
    it("sends step 1 through the recording transport: attempt SENT, step advanced, request CONTACTED, audited", async () => {
      const op = await newOperator("demo-follow-up");
      const demo = await seedDemo({ followUpStatus: "ACTIVE", followUpStep: 0 });
      const res = await call({
        method: "POST",
        url: `/v1/admin/demo-requests/${demo.id}/follow-up/send`,
        token: op.token,
        payload: { step: 1 },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).item).toMatchObject({ id: demo.id, followUpStep: 1, status: "CONTACTED" });

      const row = await prisma.demoRequest.findUniqueOrThrow({ where: { id: demo.id } });
      expect(row.followUpStep).toBe(1);
      expect(row.status).toBe("CONTACTED");
      expect(row.lastFollowUpSentAt).not.toBeNull();
      expect(row.lastFollowUpTemplateKey).toEqual(expect.any(String));
      expect(row.contactedByUserId).toBe(op.userId);

      const attempts = await prisma.notificationDelivery.findMany({
        where: { recipient: demo.workEmail, channel: "EMAIL" },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        status: "SENT",
        teamId: null,
        templateKey: row.lastFollowUpTemplateKey,
      });
      expect(attempts[0]!.providerMessageId).toEqual(expect.any(String));

      const audit = await waitForAudit({ action: "admin.demo_requests.follow_up_send", resourceId: demo.id });
      expect(audit).toMatchObject({
        userId: op.userId,
        outcome: "success",
        actorAuthority: "PLATFORM_ADMIN",
        resultingState: "STEP_1",
        reasonCode: "PROVIDER_ACKNOWLEDGED_NOT_CONFIRMED_DELIVERED",
      });
    });

    it("a non-admin is refused 403, and a spam-flagged request is refused 400 before any send is attempted", async () => {
      const op = await newOperator("demo-follow-up-refusal");
      const demo = await seedDemo({ followUpStatus: "ACTIVE" });
      const refused = await call({
        method: "POST",
        url: `/v1/admin/demo-requests/${demo.id}/follow-up/send`,
        token: normalUser.token,
        payload: {},
      });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error.code).toBe("FORBIDDEN");

      const spam = await seedDemo({ followUpStatus: "ACTIVE", isSpam: true });
      const blocked = await call({
        method: "POST",
        url: `/v1/admin/demo-requests/${spam.id}/follow-up/send`,
        token: op.token,
        payload: {},
      });
      expect(blocked.statusCode).toBe(400);
      expect(json(blocked).error.details).toEqual({ reason: "DEMO_REQUEST_SPAM_BLOCKED" });

      for (const d of [demo, spam]) {
        const row = await prisma.demoRequest.findUniqueOrThrow({ where: { id: d.id } });
        expect(row.followUpStep).toBe(d.followUpStep);
        expect(row.lastFollowUpSentAt).toBeNull();
        expect(await prisma.notificationDelivery.count({ where: { recipient: d.workEmail } })).toBe(0);
      }
    });
  });

  // ===========================================================================
  // PATCH /v1/admin/orgs/:id/plan  and  POST /v1/admin/enterprise/provision
  // ===========================================================================

  describe("PATCH /v1/admin/orgs/:id/plan", () => {
    it("grants ENTERPRISE to every workspace of a customer org after a bound step-up, with org + platform audit", async () => {
      const op = await newOperator("plan-granter");
      const tenant = await seedOrganizationTenant(deps, { billingPlan: "FREE", billingStatus: "INACTIVE", memberCount: 1 });
      const url = `/v1/admin/orgs/${tenant.organizationId}/plan`;
      const payload = { teamId: op.stepUpTeamId, plan: "ENTERPRISE", seats: 40 };

      // Without the step-up the gate answers first and nothing changes.
      const gated = await call({ method: "PATCH", url, token: op.token, payload });
      expect(gated.statusCode).toBe(401);
      expect(json(gated).error.code).toBe("STEP_UP_REQUIRED");
      expect((await prisma.team.findUniqueOrThrow({ where: { id: tenant.workspaceId } })).billingPlan).toBe("FREE");

      const challengeId = await approvedStepUp(op, "CAPABILITY_GRANT", "organization", tenant.organizationId);
      const res = await call({
        method: "PATCH",
        url,
        token: op.token,
        payload,
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({
        organizationId: tenant.organizationId,
        plan: "ENTERPRISE",
        seats: 40,
        workspacesUpdated: 1,
      });

      const ws = await prisma.team.findUniqueOrThrow({ where: { id: tenant.workspaceId } });
      expect(ws).toMatchObject({
        billingPlan: "ENTERPRISE",
        includedSeats: 40,
        billingStatus: "ACTIVE",
        workspaceKind: "ORGANIZATION",
        overSeatLimit: false,
      });
      const contract = await prisma.enterpriseContract.findUniqueOrThrow({
        where: { organizationId: tenant.organizationId },
      });
      expect(contract).toMatchObject({ status: "ACTIVE", activationState: "ACTIVATED", seatCount: 40 });

      const orgEvent = await prisma.organizationAuditEvent.findFirstOrThrow({
        where: { organizationId: tenant.organizationId, eventType: "ORG_PLAN_GRANTED" },
      });
      expect(orgEvent).toMatchObject({ actorUserId: op.userId, targetType: "organization", targetId: tenant.organizationId });
      const platform = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "ORG_PLAN_GRANTED", resourceId: tenant.organizationId },
      });
      expect(platform).toMatchObject({
        userId: op.userId,
        organizationId: tenant.organizationId,
        outcome: "success",
        resourceType: "organization",
      });

      // The challenge was single-use.
      const replay = await call({
        method: "PATCH",
        url,
        token: op.token,
        payload: { ...payload, seats: 41 },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(replay.statusCode).toBe(401);
      expect((await prisma.team.findUniqueOrThrow({ where: { id: tenant.workspaceId } })).includedSeats).toBe(40);
    });

    it("a workspace owner without a platform role is refused 403; a personal-space container is 409 NOT_CUSTOMER_ORGANIZATION", async () => {
      const op = await newOperator("plan-refusal");
      const tenant = await seedOrganizationTenant(deps, { billingPlan: "FREE", billingStatus: "INACTIVE" });
      const refused = await call({
        method: "PATCH",
        url: `/v1/admin/orgs/${tenant.organizationId}/plan`,
        token: tenant.owner.token,
        payload: { teamId: tenant.workspaceId, plan: "ENTERPRISE", seats: 999 },
      });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error.code).toBe("FORBIDDEN");
      expect((await prisma.team.findUniqueOrThrow({ where: { id: tenant.workspaceId } })).billingPlan).toBe("FREE");

      const personal = await seedPersonalTenant(deps, "PRO");
      const challengeId = await approvedStepUp(op, "CAPABILITY_GRANT", "organization", personal.personalOrganizationId);
      const conflict = await call({
        method: "PATCH",
        url: `/v1/admin/orgs/${personal.personalOrganizationId}/plan`,
        token: op.token,
        payload: { teamId: op.stepUpTeamId, plan: "ENTERPRISE" },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(conflict.statusCode).toBe(409);
      expect(json(conflict).error.code).toBe("NOT_CUSTOMER_ORGANIZATION");
      const personalTeam = await prisma.team.findUniqueOrThrow({ where: { id: personal.personalTeamId } });
      expect(personalTeam.billingPlan).not.toBe("ENTERPRISE");
      expect(
        await prisma.organizationAuditEvent.count({
          where: { organizationId: { in: [tenant.organizationId, personal.personalOrganizationId] }, eventType: "ORG_PLAN_GRANTED" },
        }),
      ).toBe(0);
    });
  });

  describe("POST /v1/admin/enterprise/provision", () => {
    it("provisions a customer for an existing owner: org, enterprise workspace, owner seat, request row, org + platform audit; same key replays", async () => {
      const op = await newOperator("provisioner");
      const owner = await seedUser(deps, "future-owner");
      const idempotencyKey = randomUUID();
      const organizationName = `K7 Insurer ${randomUUID().slice(0, 6)}`;
      const payload = {
        idempotencyKey,
        teamId: op.stepUpTeamId,
        organizationName,
        ownerEmail: owner.email.toUpperCase(),
        seats: 25,
        workspaceName: "Claims",
      };

      const challengeId = await approvedStepUp(op, "CAPABILITY_GRANT", "enterprise_provision", null);
      const res = await call({
        method: "POST",
        url: "/v1/admin/enterprise/provision",
        token: op.token,
        payload,
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = json(res);
      expect(body).toMatchObject({ provisioned: true, ownerUserId: owner.userId, idempotentReplay: false });

      const org = await prisma.organization.findUniqueOrThrow({ where: { id: body.organizationId } });
      expect(org).toMatchObject({ name: organizationName, kind: "CUSTOMER", status: "ACTIVE", billingOwnerUserId: owner.userId });
      const ws = await prisma.team.findUniqueOrThrow({ where: { id: body.workspaceId } });
      expect(ws).toMatchObject({
        organizationId: org.id,
        name: "Claims",
        billingPlan: "ENTERPRISE",
        includedSeats: 25,
        workspaceKind: "ORGANIZATION",
        ownerUserId: owner.userId,
      });
      expect(
        await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: ws.id, userId: owner.userId } } }),
      ).toMatchObject({ role: "OWNER" });
      expect(
        await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId: org.id, userId: owner.userId } }),
      ).toMatchObject({ role: "ORG_OWNER" });
      const request = await prisma.enterpriseProvisioningRequest.findUniqueOrThrow({ where: { idempotencyKey } });
      expect(request).toMatchObject({ status: "COMPLETED", resultOrganizationId: org.id, requestedByUserId: op.userId });

      const orgEvent = await prisma.organizationAuditEvent.findFirstOrThrow({
        where: { organizationId: org.id, eventType: "ENTERPRISE_PROVISIONED" },
      });
      expect(orgEvent.actorUserId).toBe(op.userId);
      const platform = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "ENTERPRISE_PROVISIONED", resourceId: org.id },
      });
      expect(platform).toMatchObject({ userId: op.userId, organizationId: org.id, workspaceId: ws.id, outcome: "success" });

      // Same key + same payload: the original result, nothing new created.
      const replayChallenge = await approvedStepUp(op, "CAPABILITY_GRANT", "enterprise_provision", null);
      const replay = await call({
        method: "POST",
        url: "/v1/admin/enterprise/provision",
        token: op.token,
        payload,
        headers: { "x-proovra-step-up-challenge-id": replayChallenge },
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(json(replay)).toMatchObject({ idempotentReplay: true, organizationId: org.id });
      expect(await prisma.organization.count({ where: { name: organizationName } })).toBe(1);
    });

    it("provisions a customer whose owner is not yet a user: pending-owner org, ORG_OWNER invite and a recorded first delivery", async () => {
      const op = await newOperator("provisioner-invite");
      const ownerEmail = `new-owner-${tag}-${randomUUID().slice(0, 6)}@fixture-customer.local`;
      const challengeId = await approvedStepUp(op, "CAPABILITY_GRANT", "enterprise_provision", null);
      const res = await call({
        method: "POST",
        url: "/v1/admin/enterprise/provision",
        token: op.token,
        payload: {
          idempotencyKey: randomUUID(),
          teamId: op.stepUpTeamId,
          organizationName: `K7 Pending ${randomUUID().slice(0, 6)}`,
          ownerEmail,
          seats: 10,
        },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = json(res);
      expect(body).toMatchObject({ provisioned: false, pendingOwner: true, idempotentReplay: false });
      expect(body.inviteUrl).toBe(`/org-invites/${body.ownerInviteToken}/accept`);

      const org = await prisma.organization.findUniqueOrThrow({ where: { id: body.organizationId } });
      expect(org).toMatchObject({ kind: "CUSTOMER", billingOwnerUserId: null, pendingEnterpriseSeats: 10 });
      const invite = await prisma.organizationInvite.findFirstOrThrow({ where: { organizationId: org.id } });
      expect(invite).toMatchObject({ email: ownerEmail, role: "ORG_OWNER", invitedByUserId: op.userId, token: null });
      expect(invite.tokenHash).not.toContain(body.ownerInviteToken);
      expect(body.ownerInviteDelivery).toMatchObject({ status: "SENT", attempts: 1 });
      expect(
        (await prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId: org.id } })).activationState,
      ).toBe("OWNER_INVITED");
      expect(
        await prisma.organizationAuditEvent.count({
          where: { organizationId: org.id, eventType: { in: ["ENTERPRISE_PROVISIONED", "ORG_MEMBER_INVITED"] } },
        }),
      ).toBe(2);
    });

    it("a non-admin is refused 403; a reused key with a different payload is 409 IDEMPOTENCY_CONFLICT — nothing created", async () => {
      const op = await newOperator("provision-refusal");
      const owner = await seedUser(deps, "conflict-owner");
      const name = `K7 Refused ${randomUUID().slice(0, 6)}`;
      const refused = await call({
        method: "POST",
        url: "/v1/admin/enterprise/provision",
        token: harness.fixtures.teamA.ownerToken,
        payload: {
          idempotencyKey: randomUUID(),
          teamId: harness.fixtures.teamA.teamId,
          organizationName: name,
          ownerEmail: owner.email,
        },
      });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error.code).toBe("FORBIDDEN");
      expect(await prisma.organization.count({ where: { name } })).toBe(0);

      const idempotencyKey = randomUUID();
      const first = await approvedStepUp(op, "CAPABILITY_GRANT", "enterprise_provision", null);
      const created = await call({
        method: "POST",
        url: "/v1/admin/enterprise/provision",
        token: op.token,
        payload: { idempotencyKey, teamId: op.stepUpTeamId, organizationName: `${name} A`, ownerEmail: owner.email },
        headers: { "x-proovra-step-up-challenge-id": first },
      });
      expect(created.statusCode, created.body).toBe(201);

      const second = await approvedStepUp(op, "CAPABILITY_GRANT", "enterprise_provision", null);
      const conflict = await call({
        method: "POST",
        url: "/v1/admin/enterprise/provision",
        token: op.token,
        payload: { idempotencyKey, teamId: op.stepUpTeamId, organizationName: `${name} B`, ownerEmail: owner.email },
        headers: { "x-proovra-step-up-challenge-id": second },
      });
      expect(conflict.statusCode).toBe(409);
      expect(json(conflict).error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(await prisma.organization.count({ where: { name: `${name} B` } })).toBe(0);
      expect(await prisma.organization.count({ where: { name: `${name} A` } })).toBe(1);
    });
  });
});
