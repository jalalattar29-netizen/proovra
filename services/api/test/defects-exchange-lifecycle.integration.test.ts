/**
 * Defect proofs — Exchange / lifecycle / retention / webhook cancel, against a
 * disposable PostgreSQL + Redis through the REAL routes.
 *
 *   D8   a created exchange package is handed to the builder (DRAFT → BUILDING)
 *        and the worker's READY step meters the monthly export allowance
 *   D18  signed link, delivery and download authorisation write an audit row
 *   D40  package revoke and lifecycle-webhook deactivate write an audit row
 *   D41  lifecycle retention-policy release writes a real audit row
 *   D42  a description-only governance retention edit saves a new version
 *   D43  two racing webhook-delivery cancels write ONE audit row
 *
 * Audit rows are re-read from `admin_audit_logs` (the canonical tenant-audit
 * sink) or, for the integrations family, `team_activities`.
 *
 * No provider is contacted: step-up is answered with an authenticator code,
 * and the worker's object-storage upload is replaced at its module boundary.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

// The worker package builder is exercised against the live database; only
// its object-storage upload and its env-validated config/db modules are
// replaced (the builder is handed the test's Prisma client explicitly).
vi.mock("../../worker/src/storage.js", () => ({
  putObjectBuffer: async () => undefined,
}));
vi.mock("../../worker/src/config.js", () => ({
  env: { S3_BUCKET: "test-bucket" },
}));
vi.mock("../../worker/src/db.js", () => ({ prisma: {} }));

describe("defects — exchange, lifecycle, retention, webhook cancel (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  const secrets = new Map<string, Buffer>();
  const STEP = "x-proovra-step-up-challenge-id";
  const savedEnv: Record<string, string | undefined> = {};

  const call = (opts: {
    method: "GET" | "POST" | "PATCH";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

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

  async function stepUp(input: {
    token: string;
    userId: string;
    teamId: string;
    purpose: string;
    resourceKind: string;
    resourceId: string;
  }): Promise<string> {
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token: input.token,
      payload: {
        teamId: input.teamId,
        purpose: input.purpose,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (started.json() as { challenge: { id: string } }).challenge.id;
    await prisma.mfaFactor.updateMany({
      where: { userId: input.userId, kind: "TOTP" },
      data: { lastUsedAt: null },
    });
    const code = totp.computeTotpCode(
      secrets.get(input.userId)!,
      totp.timeStep(Math.floor(Date.now() / 1000)),
    );
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: input.token,
      payload: { teamId: input.teamId, challengeId, code },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  function auditRows(where: Record<string, unknown>) {
    return prisma.adminAuditLog.findMany({
      where: where as never,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async function seedPackage(state: string, extra: Record<string, unknown> = {}) {
    const { teamA } = h.fixtures;
    return prisma.evidenceExchangePackage.create({
      data: {
        teamId: teamA.teamId,
        kind: "EVIDENCE",
        state,
        evidenceIds: [randomUUID()] as never,
        createdByUserId: teamA.ownerUserId,
        ...extra,
      } as never,
      select: { id: true },
    });
  }

  async function exportUsage(teamId: string): Promise<number> {
    const rows = await prisma.entitlementUsage.findMany({
      where: { teamId, key: "QUOTA_EXPORT_PACKAGES_PER_MONTH" },
      select: { consumed: true },
    });
    return rows.reduce((n, r) => n + Number(r.consumed), 0);
  }

  beforeAll(async () => {
    for (const k of ["INTEGRATIONS_ENABLED", "API_KEY_SECRET"]) savedEnv[k] = process.env[k];
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = "ab".repeat(32);

    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    totp = await import("../src/services/security/mfa-totp.js");
    const { teamA, teamB } = h.fixtures;
    for (const userId of [teamA.ownerUserId, teamA.adminUserId, teamA.memberUserId]) {
      await prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: teamA.teamId } });
    }
    await prisma.user.update({ where: { id: teamB.ownerUserId }, data: { currentWorkspaceId: teamB.teamId } });
    await seedTotp(teamA.ownerUserId);

    // Team A may create exchange packages (feature + monthly allowance).
    const { upsertEntitlementGrant } = await import(
      "../src/services/packaging/entitlement.service.js"
    );
    await upsertEntitlementGrant({
      teamId: teamA.teamId,
      key: "FEATURE_EVIDENCE_EXCHANGE",
      value: true,
      kind: "FEATURE",
      source: "CUSTOM",
      grantedByUserId: teamA.ownerUserId,
    });
    await upsertEntitlementGrant({
      teamId: teamA.teamId,
      key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
      value: 100,
      kind: "QUOTA",
      source: "CUSTOM",
      grantedByUserId: teamA.ownerUserId,
    });

    // Team A is an Enterprise customer (governance retention policies).
    await prisma.team.update({
      where: { id: teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    const orgA = (await prisma.team.findUniqueOrThrow({
      where: { id: teamA.teamId },
      select: { organizationId: true },
    })).organizationId;
    const { upsertEnterpriseContract } = await import(
      "../src/services/organization/enterprise-contract.service.js"
    );
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma && h) {
      const teamIds = [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId];
      const where = { teamId: { in: teamIds } };
      await prisma.evidenceExchangePackage.deleteMany({ where }).catch(() => undefined);
      await prisma.lifecycleWebhookEndpoint.deleteMany({ where }).catch(() => undefined);
      await prisma.retentionPolicyConfig.deleteMany({ where }).catch(() => undefined);
      await prisma.evidenceRetentionPolicy.deleteMany({ where }).catch(() => undefined);
      await prisma.webhookEndpoint.deleteMany({ where }).catch(() => undefined);
      await prisma.entitlementUsage.deleteMany({ where }).catch(() => undefined);
      await prisma.stepUpChallenge.deleteMany({ where }).catch(() => undefined);
    }
    await h?.cleanup();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ===========================================================================
  // D8
  // ===========================================================================

  it("D8 POST /v1/exchange/packages hands the new package to the builder (DRAFT -> BUILDING)", async () => {
    const { teamA } = h.fixtures;
    const res = await call({
      method: "POST",
      url: "/v1/exchange/packages",
      token: teamA.ownerToken,
      payload: { kind: "EVIDENCE", evidenceIds: [randomUUID()] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { packageId } = res.json() as { packageId: string };
    const row = await prisma.evidenceExchangePackage.findUniqueOrThrow({
      where: { id: packageId },
      select: { state: true },
    });
    expect(row.state).toBe("BUILDING");
    // The worker's poll query selects it.
    const pending = await prisma.evidenceExchangePackage.findMany({
      where: { state: "BUILDING", teamId: teamA.teamId },
      select: { id: true },
    });
    expect(pending.map((p) => p.id)).toContain(packageId);
    // Creation itself does not meter; the build does.
  });

  it("D8 the worker READY step meters the export-package allowance exactly once", async () => {
    const { teamA } = h.fixtures;
    const pkg = await seedPackage("BUILDING");
    const before = await exportUsage(teamA.teamId);
    const { buildExchangePackage } = await import("../../worker/src/exchange-package-builder.js");
    await buildExchangePackage(pkg.id, prisma as never);
    const row = await prisma.evidenceExchangePackage.findUniqueOrThrow({
      where: { id: pkg.id },
      select: { state: true, packageSha256: true, storageKey: true },
    });
    expect(row.state).toBe("READY");
    expect(row.packageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await exportUsage(teamA.teamId)).toBe(before + 1);
    // A second pass finds no BUILDING package and meters nothing.
    await buildExchangePackage(pkg.id, prisma as never);
    expect(await exportUsage(teamA.teamId)).toBe(before + 1);
  });

  // ===========================================================================
  // D18
  // ===========================================================================

  it("D18 sign-url, deliveries and download authorisation each write an audit row", async () => {
    const { teamA } = h.fixtures;
    const pkg = await seedPackage("READY", { packageSha256: "c".repeat(64) });

    const c1 = await stepUp({
      token: teamA.ownerToken,
      userId: teamA.ownerUserId,
      teamId: teamA.teamId,
      purpose: "PACKAGE_EXPORT_HIGH_RISK",
      resourceKind: "evidence_exchange_package",
      resourceId: pkg.id,
    });
    const signed = await call({
      method: "POST",
      url: `/v1/exchange/packages/${pkg.id}/sign-url`,
      token: teamA.ownerToken,
      headers: { [STEP]: c1 },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    const signedUrl = (signed.json() as { signedUrl: string }).signedUrl;
    const signAudit = await auditRows({
      action: "exchange.package.signed_url_issued",
      resourceId: pkg.id,
    });
    expect(signAudit).toHaveLength(1);
    expect(signAudit[0]).toMatchObject({
      userId: teamA.ownerUserId,
      workspaceId: teamA.teamId,
      resourceType: "evidence_exchange_package",
      outcome: "success",
    });
    // The signed URL (and its token) never enters the append-only trail.
    expect(JSON.stringify(signAudit[0])).not.toContain(signedUrl.split("?token=")[1]);

    const c2 = await stepUp({
      token: teamA.ownerToken,
      userId: teamA.ownerUserId,
      teamId: teamA.teamId,
      purpose: "PACKAGE_EXPORT_HIGH_RISK",
      resourceKind: "evidence_exchange_package",
      resourceId: pkg.id,
    });
    const delivered = await call({
      method: "POST",
      url: `/v1/exchange/packages/${pkg.id}/deliveries`,
      token: teamA.ownerToken,
      headers: { [STEP]: c2 },
      payload: { recipientEmail: "counsel@example.com", recipientOrgSlug: "counsel-llp" },
    });
    expect(delivered.statusCode, delivered.body).toBe(201);
    const { deliveryId } = delivered.json() as { deliveryId: string };
    const deliveryAudit = await auditRows({
      action: "exchange.package.delivery_recorded",
      resourceId: pkg.id,
    });
    expect(deliveryAudit).toHaveLength(1);
    expect(deliveryAudit[0]).toMatchObject({
      userId: teamA.ownerUserId,
      workspaceId: teamA.teamId,
      outcome: "success",
    });
    expect(deliveryAudit[0]!.metadata).toMatchObject({
      deliveryId,
      recipientOrgSlug: "counsel-llp",
      recipientEmailProvided: true,
    });
    expect(JSON.stringify(deliveryAudit[0])).not.toContain("counsel@example.com");

    const downloaded = await call({
      method: "POST",
      url: `/v1/exchange/deliveries/${deliveryId}/download`,
      token: teamA.ownerToken,
    });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    const downloadAudit = await auditRows({
      action: "exchange.delivery.download_authorized",
      resourceId: deliveryId,
    });
    expect(downloadAudit).toHaveLength(1);
    expect(downloadAudit[0]).toMatchObject({
      userId: teamA.ownerUserId,
      workspaceId: teamA.teamId,
      outcome: "success",
    });
  });

  // ===========================================================================
  // D40
  // ===========================================================================

  it("D40 package revoke writes an audit row (success, then no_op on replay)", async () => {
    const { teamA, teamB } = h.fixtures;
    const pkg = await seedPackage("READY", { packageSha256: "d".repeat(64) });

    // Another tenant cannot revoke it, and nothing is audited for it.
    const foreign = await call({
      method: "POST",
      url: `/v1/exchange/packages/${pkg.id}/revoke`,
      token: teamB.ownerToken,
    });
    expect(foreign.statusCode).toBe(404);

    const res = await call({
      method: "POST",
      url: `/v1/exchange/packages/${pkg.id}/revoke`,
      token: teamA.ownerToken,
    });
    expect(res.statusCode, res.body).toBe(200);
    const again = await call({
      method: "POST",
      url: `/v1/exchange/packages/${pkg.id}/revoke`,
      token: teamA.ownerToken,
    });
    expect(again.statusCode, again.body).toBe(200);

    const stored = await prisma.evidenceExchangePackage.findUniqueOrThrow({
      where: { id: pkg.id },
      select: { state: true },
    });
    expect(stored.state).toBe("REVOKED");
    const rows = await auditRows({ action: "exchange.package.revoke", resourceId: pkg.id });
    expect(rows.map((r) => r.outcome)).toEqual(["success", "no_op"]);
    expect(rows[0]).toMatchObject({
      userId: teamA.ownerUserId,
      workspaceId: teamA.teamId,
      resourceType: "evidence_exchange_package",
      previousState: "READY",
      resultingState: "REVOKED",
    });
  });

  it("D40 lifecycle webhook endpoint deactivate writes an audit row", async () => {
    const { teamA } = h.fixtures;
    const endpoint = await prisma.lifecycleWebhookEndpoint.create({
      data: {
        teamId: teamA.teamId,
        url: "https://hooks.example.com/proovra",
        secret: "x".repeat(40),
        subscribedEvents: ["PACKAGE_CREATED"] as never,
        createdByUserId: teamA.ownerUserId,
      },
      select: { id: true },
    });
    const res = await call({
      method: "POST",
      url: `/v1/integrations/webhooks/endpoints/${endpoint.id}/deactivate`,
      token: teamA.ownerToken,
    });
    expect(res.statusCode, res.body).toBe(200);
    const stored = await prisma.lifecycleWebhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
      select: { state: true },
    });
    expect(stored.state).toBe("DEACTIVATED");
    const rows = await auditRows({
      action: "integration.lifecycle_webhook.deactivate",
      resourceId: endpoint.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: teamA.ownerUserId,
      workspaceId: teamA.teamId,
      outcome: "success",
      previousState: "ACTIVE",
      resultingState: "DEACTIVATED",
    });
  });

  // ===========================================================================
  // D41
  // ===========================================================================

  it("D41 lifecycle retention policy release writes a persisted audit row", async () => {
    const { teamA } = h.fixtures;
    const policy = await prisma.retentionPolicyConfig.create({
      data: {
        teamId: teamA.teamId,
        name: "Insurance hold",
        template: "INSURANCE_7Y",
        years: 7,
        scopeKind: "WORKSPACE",
        state: "ACTIVE",
        createdByUserId: teamA.ownerUserId,
      },
      select: { id: true },
    });
    const res = await call({
      method: "POST",
      url: `/v1/lifecycle/retention/policies/${policy.id}/release`,
      token: teamA.ownerToken,
    });
    expect(res.statusCode, res.body).toBe(200);
    const stored = await prisma.retentionPolicyConfig.findUniqueOrThrow({
      where: { id: policy.id },
      select: { state: true },
    });
    expect(stored.state).toBe("ARCHIVED");
    const rows = await auditRows({
      action: "lifecycle.retention_policy.release",
      resourceId: policy.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: teamA.ownerUserId,
      workspaceId: teamA.teamId,
      outcome: "success",
      previousState: "ACTIVE",
      resultingState: "ARCHIVED",
    });
  });

  // ===========================================================================
  // D42
  // ===========================================================================

  it("D42 a description-only governance retention edit is saved as a new version", async () => {
    const { teamA } = h.fixtures;
    // Created through the real route: the service used to hand `actorUserId`
    // to a `.strict()` schema, so every create (and update) answered 400
    // RETENTION_POLICY_INVALID before any versioning logic ran.
    const createChallenge = await stepUp({
      token: teamA.ownerToken,
      userId: teamA.ownerUserId,
      teamId: teamA.teamId,
      purpose: "RETENTION_POLICY_UPDATE",
      resourceKind: "evidence_retention_policy",
      resourceId: teamA.teamId,
    });
    const created = await call({
      method: "POST",
      url: "/v1/governance/retention-policies",
      token: teamA.ownerToken,
      headers: { [STEP]: createChallenge },
      payload: {
        teamId: teamA.teamId,
        displayName: `Claims ${randomUUID().slice(0, 8)}`,
        description: "Original description",
        scope: "WORKSPACE",
        retentionDays: 365,
        changeNote: "Initial claims policy",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const policy = (created.json() as { policy: { id: string } }).policy;

    const challengeId = await stepUp({
      token: teamA.ownerToken,
      userId: teamA.ownerUserId,
      teamId: teamA.teamId,
      purpose: "RETENTION_POLICY_UPDATE",
      resourceKind: "evidence_retention_policy",
      resourceId: policy.id,
    });
    const res = await call({
      method: "PATCH",
      url: `/v1/governance/retention-policies/${policy.id}`,
      token: teamA.ownerToken,
      headers: { [STEP]: challengeId },
      payload: {
        teamId: teamA.teamId,
        description: "Clarified: applies to all claim photos",
        changeNote: "Clarify scope wording",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { policy: { description: string } }).policy.description).toBe(
      "Clarified: applies to all claim photos",
    );

    const stored = await prisma.evidenceRetentionPolicy.findUniqueOrThrow({
      where: { id: policy.id },
      select: { description: true, currentVersion: true },
    });
    expect(stored.description).toBe("Clarified: applies to all claim photos");
    expect(stored.currentVersion).toBe(2);
    const versions = await prisma.evidenceRetentionPolicyVersion.findMany({
      where: { retentionPolicyId: policy.id },
      orderBy: { version: "asc" },
    });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[1]!.diffJson).toEqual({
      description: {
        from: "Original description",
        to: "Clarified: applies to all claim photos",
      },
    });
    expect(versions[1]!.changeNote).toBe("Clarify scope wording");
  });

  // ===========================================================================
  // D43
  // ===========================================================================

  it("D43 two racing webhook-delivery cancels: one wins, one audit row", async () => {
    const { teamA } = h.fixtures;
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        teamId: teamA.teamId,
        url: "https://hooks.example.com/cancel-race",
        secretCiphertext: "not-used-by-cancel",
        secretPrefix: "whsec_test",
        createdByUserId: teamA.ownerUserId,
      },
      select: { id: true },
    });
    const delivery = await prisma.integrationWebhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        teamId: teamA.teamId,
        eventId: randomUUID(),
        eventType: "evidence.created",
        payloadJson: {},
        status: "RETRY_SCHEDULED",
        attemptCount: 2,
        nextAttemptAtUtc: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });

    // Barrier: both requests read the delivery (RETRY_SCHEDULED) before
    // either writes, which is the interleaving a real double-click produces.
    const delegate = prisma.integrationWebhookDelivery;
    const realFindFirst = delegate.findFirst.bind(delegate);
    let readers = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => {
      release = r;
    });
    const spy = vi.spyOn(delegate, "findFirst").mockImplementation((async (args: never) => {
      const row = await realFindFirst(args);
      readers += 1;
      if (readers >= 2) release();
      await bothRead;
      return row;
    }) as never);

    try {
      const cancel = () =>
        call({
          method: "POST",
          url: `/v1/integrations/webhook-deliveries/${delivery.id}/cancel`,
          token: teamA.ownerToken,
          payload: { teamId: teamA.teamId },
        });
      const results = await Promise.all([cancel(), cancel()]);
      expect(readers).toBe(2);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes, results.map((r) => r.body).join(" | ")).toEqual([200, 409]);
      const loser = results.find((r) => r.statusCode === 409)!;
      expect(loser.json()).toEqual({ error: { code: "delivery_not_cancellable" } });
    } finally {
      spy.mockRestore();
    }

    const stored = await prisma.integrationWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { status: true },
    });
    expect(stored.status).toBe("CANCELLED");
    const activity = await prisma.teamActivity.findMany({
      where: {
        teamId: teamA.teamId,
        eventType: "integration.webhook.delivery_cancelled",
        targetId: endpoint.id,
      },
    });
    expect(activity).toHaveLength(1);
    expect(activity[0]!.actorUserId).toBe(teamA.ownerUserId);
    expect(activity[0]!.metadata).toMatchObject({ deliveryId: delivery.id, status: "CANCELLED" });
  });
});
