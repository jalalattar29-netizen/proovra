/**
 * BATCH K2 (security / sessions / support, part A) — runtime proof of the
 * workspace identity-administration, communications-verification, step-up,
 * contact-factor and trusted-device actions the UI mutation sweep could not
 * drive to success.
 *
 * Every action is proven three ways against a disposable PostgreSQL 16 through
 * `harness.app.inject` only:
 *
 *   1. the authorized SUCCESS branch with the payload the real web consumer
 *      sends (apps/web, cited per test), and the durable column the action
 *      exists to change, re-read;
 *   2. the tenant audit row (AdminAuditLog) the service writes, with actor,
 *      workspace, target and outcome;
 *   3. an expected refusal with its bounded status/code and no durable effect.
 *
 * Step-up is satisfied exactly as a user satisfies it: a verified authenticator
 * app (TOTP), the real /step-up/start + /step-up/check routes, and the
 * approved challenge id in `x-proovra-step-up-challenge-id`. TOTP codes are
 * single-use per 30s step (WCC-NEW-008); independent proofs reset the factor's
 * step ledger (`lastUsedAt = null`) first, standing in for the time a real user
 * waits between two unrelated actions.
 *
 * SMS codes travel through the RECORDING messaging provider
 * (`MESSAGING_TRANSPORT=recording`, set by the test bootstrap): the code is read
 * back from what the provider recorded for the recipient, never from the
 * database. No vendor is contacted.
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("K2 security (A) — identity administration, verification, step-up (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let recorder: typeof import("../src/services/communications/recording-provider.js");
  let signJwt: (typeof import("../src/services/jwt.js"))["signJwt"];
  let orgA: string;

  const secrets = new Map<string, Buffer>();
  const createdUserIds: string[] = [];

  const call = (opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;
  const stepUpHeader = (challengeId: string) => ({ "x-proovra-step-up-challenge-id": challengeId });

  /** Bounded wait for a row the product writes fire-and-forget. */
  async function eventually<T>(label: string, read: () => Promise<T | null | undefined>): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`${label} was never written`);
      await new Promise((r) => setImmediate(r));
    }
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

  /** The code the user's authenticator shows now, with the step ledger cleared. */
  async function freshCode(userId: string): Promise<string> {
    await prisma.mfaFactor.updateMany({
      where: { userId, kind: "TOTP", status: "ACTIVE" },
      data: { lastUsedAt: null },
    });
    return totp.computeTotpCode(secrets.get(userId)!, totp.timeStep(Math.floor(Date.now() / 1000)));
  }

  /**
   * The step-up ceremony the web StepUpModal performs after a 401
   * STEP_UP_REQUIRED: start a challenge with the purpose/resource the 401
   * named, answer it with the authenticator code, return the approved id.
   */
  async function approvedChallenge(input: {
    token: string;
    userId: string;
    teamId: string;
    purpose: string;
    resourceKind?: string;
    resourceId?: string;
  }): Promise<string> {
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token: input.token,
      payload: {
        teamId: input.teamId,
        purpose: input.purpose,
        ...(input.resourceKind ? { resourceKind: input.resourceKind } : {}),
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (json(started).challenge as { id: string }).id;
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: input.token,
      payload: { teamId: input.teamId, challengeId, code: await freshCode(input.userId) },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  /** The one-time code the recording provider sent to this number. */
  function recordedCode(e164: string): string {
    const alias = recorder.recipientAliasForPhone(e164);
    const sent = recorder
      .recordedMessages()
      .filter((m) => m.kind === "verification_start" && m.recipientAlias === alias && m.code);
    const last = sent.at(-1);
    if (!last?.code) throw new Error("no verification code was recorded for this recipient");
    return last.code;
  }

  const tenantAudit = (action: string, resourceId: string) =>
    eventually(`audit ${action}`, () =>
      prisma.adminAuditLog.findFirst({ where: { action, resourceId }, orderBy: { createdAt: "desc" } }),
    );

  /** A disposable workspace member, created for exactly one proof. */
  async function teamAMember(label: string): Promise<{ id: string; token: string }> {
    const email = `k2a-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "K2", lastName: label, provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "k2-fixture",
      })),
    });
    await prisma.teamMember.create({
      data: { teamId: harness.fixtures.teamA.teamId, userId: user.id, role: "MEMBER", status: "ACTIVE" },
    });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    recorder = await import("../src/services/communications/recording-provider.js");
    ({ signJwt } = await import("../src/services/jwt.js"));

    const { teamA, teamB } = harness.fixtures;
    orgA = (
      await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } })
    ).organizationId;
    // Organization A is an Enterprise customer, built as the billing suites build one.
    await prisma.team.update({
      where: { id: teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    const { upsertEnterpriseContract } = await import(
      "../src/services/organization/enterprise-contract.service.js"
    );
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
    // Authenticator apps for the step-up actors.
    await seedTotp(teamA.adminUserId);
    await seedTotp(teamB.ownerUserId);
    // The identity console's server-derived workspace (resolveAdminWorkspace).
    await prisma.user.update({
      where: { id: teamA.adminUserId },
      data: { currentWorkspaceId: teamA.teamId },
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma && createdUserIds.length) {
      await prisma.mfaFactor.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
      await prisma.teamMember.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  // ===========================================================================
  // /v1/admin/identity/* — SSO providers, temporary elevation, SCIM tokens
  // ===========================================================================

  describe("identity administration console", () => {
    let connectionId = "";

    it("POST /v1/admin/identity/providers — an admin creates an OIDC connection behind step-up; a viewer and an outsider are refused", async () => {
      const { adminToken, adminUserId, viewerToken, teamId } = harness.fixtures.teamA;
      // IdentityProvidersSection.tsx submitCreate — the exact body shape.
      const payload = {
        teamId,
        provider: "GENERIC_OIDC",
        displayName: `K2 OIDC ${randomUUID().slice(0, 6)}`,
        issuerUrl: "https://idp.k2.example.test/oauth2",
        clientId: "k2-local-client",
        clientSecret: "k2-local-client-secret-not-real",
        allowedEmailDomains: ["k2.example.test"],
        jitDefaultRole: "MEMBER",
      };

      const viewer = await call({ method: "POST", url: "/v1/admin/identity/providers", token: viewerToken, payload });
      expect(viewer.statusCode).toBe(403);
      expect((json(viewer).error as Json).code).toBe("permission_denied");
      const outsider = await call({
        method: "POST",
        url: "/v1/admin/identity/providers",
        token: harness.fixtures.teamB.ownerToken,
        payload,
      });
      expect(outsider.statusCode).toBe(404);
      expect(json(outsider)).toEqual({ error: { code: "not_found" } });
      expect(await prisma.ssoConnection.count({ where: { teamId, displayName: payload.displayName } })).toBe(0);

      // The gate names the purpose the modal then satisfies.
      const gated = await call({ method: "POST", url: "/v1/admin/identity/providers", token: adminToken, payload });
      expect(gated.statusCode).toBe(401);
      expect((json(gated).error as Json).purpose).toBe("EXTERNAL_IDENTITY_LINK");

      const challengeId = await approvedChallenge({
        token: adminToken,
        userId: adminUserId,
        teamId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "sso_connection",
      });
      const created = await call({
        method: "POST",
        url: "/v1/admin/identity/providers",
        token: adminToken,
        payload,
        headers: stepUpHeader(challengeId),
      });
      expect(created.statusCode, created.body).toBe(201);
      const body = json(created) as { projection: { id: string }; clientSecretOnce: string };
      connectionId = body.projection.id;
      const row = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(row).toMatchObject({
        teamId,
        provider: "GENERIC_OIDC",
        status: "PENDING",
        issuerUrl: payload.issuerUrl,
        clientId: payload.clientId,
        createdByUserId: adminUserId,
        allowedEmailDomains: ["k2.example.test"],
      });
      expect(row.clientSecretHash).toMatch(/\S/);
      expect(row.clientSecretHash).not.toContain(payload.clientSecret);
      const audit = await tenantAudit("sso.connection.create", connectionId);
      expect(audit).toMatchObject({ userId: adminUserId, workspaceId: teamId, outcome: "success" });
      // The approval was single-use.
      const replay = await call({
        method: "POST",
        url: "/v1/admin/identity/providers",
        token: adminToken,
        payload: { ...payload, provider: "OKTA" },
        headers: stepUpHeader(challengeId),
      });
      expect(replay.statusCode).toBe(401);
    });

    it("POST /v1/admin/identity/providers/:id/policy — the admin turns on SAML request signing; a foreign workspace is concealed and an unmet domain guard writes nothing", async () => {
      const { adminToken, adminUserId, teamId } = harness.fixtures.teamA;
      expect(connectionId).not.toBe("");
      const url = `/v1/admin/identity/providers/${connectionId}/policy`;

      // Another tenant's owner — stepped up in THEIR workspace — cannot reach A's connection.
      const b = harness.fixtures.teamB;
      const foreignChallenge = await approvedChallenge({
        token: b.ownerToken,
        userId: b.ownerUserId,
        teamId: b.teamId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "sso_connection",
        resourceId: connectionId,
      });
      const foreign = await call({
        method: "POST",
        url,
        token: b.ownerToken,
        payload: { teamId: b.teamId, samlSignRequests: true },
        headers: stepUpHeader(foreignChallenge),
      });
      expect(foreign.statusCode).toBe(404);
      expect((json(foreign).error as Json).code).toBe("SSO_CONNECTION_NOT_FOUND");

      // Restricting to verified domains with none verified is refused, unchanged.
      const guardChallenge = await approvedChallenge({
        token: adminToken,
        userId: adminUserId,
        teamId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "sso_connection",
        resourceId: connectionId,
      });
      const guarded = await call({
        method: "POST",
        url,
        token: adminToken,
        payload: { teamId, restrictToVerifiedDomains: true },
        headers: stepUpHeader(guardChallenge),
      });
      expect(guarded.statusCode).toBe(400);
      expect((json(guarded).error as Json).code).toBe("SSO_NO_VERIFIED_DOMAINS");
      const unchanged = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(unchanged.samlSignRequests).toBe(false);
      expect(unchanged.restrictToVerifiedDomains).toBe(false);

      // IdentityProvidersSection.tsx updatePolicy — { teamId, ...patch }.
      const challengeId = await approvedChallenge({
        token: adminToken,
        userId: adminUserId,
        teamId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "sso_connection",
        resourceId: connectionId,
      });
      const updated = await call({
        method: "POST",
        url,
        token: adminToken,
        payload: { teamId, samlSignRequests: true },
        headers: stepUpHeader(challengeId),
      });
      expect(updated.statusCode, updated.body).toBe(200);
      const row = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(row.samlSignRequests).toBe(true);
      const audit = await tenantAudit("sso.connection.policy_update", connectionId);
      expect(audit).toMatchObject({ userId: adminUserId, workspaceId: teamId, outcome: "success" });
      expect(audit.metadata).toMatchObject({ changed: ["samlSignRequests"] });
    });

    it("POST /v1/admin/identity/elevations — the admin grants a member a bounded elevation in the server-derived workspace; a subject from another tenant and a mismatched workspace are concealed", async () => {
      const { adminToken, adminUserId, memberUserId, teamId } = harness.fixtures.teamA;
      const permission = "identity.member.invite";
      // permission-matrix/page.tsx — { teamId, userId, permission, reason, ttlSeconds }.
      const body = (userId: string, team = teamId) => ({
        teamId: team,
        userId,
        permission,
        reason: "K2 incident triage cover",
        ttlSeconds: 900,
      });

      // A declared workspace that is not the server-derived one names nothing.
      const mismatch = await call({
        method: "POST",
        url: "/v1/admin/identity/elevations",
        token: adminToken,
        payload: body(memberUserId, harness.fixtures.teamB.teamId),
      });
      expect(mismatch.statusCode).toBe(404);
      expect(json(mismatch)).toEqual({ error: { code: "not_found" } });

      // A subject who is not a member of A: concealed AFTER the step-up.
      const outsiderId = harness.fixtures.teamB.memberUserId;
      const outsiderChallenge = await approvedChallenge({
        token: adminToken,
        userId: adminUserId,
        teamId,
        purpose: "CAPABILITY_GRANT",
        resourceKind: "temporary_elevation",
        resourceId: outsiderId,
      });
      const outsider = await call({
        method: "POST",
        url: "/v1/admin/identity/elevations",
        token: adminToken,
        payload: body(outsiderId),
        headers: stepUpHeader(outsiderChallenge),
      });
      expect(outsider.statusCode).toBe(404);
      expect((json(outsider).error as Json).code).toBe("RBAC_MEMBER_NOT_FOUND");
      expect(await prisma.memberCapabilityGrant.count({ where: { teamId, permission, teamMember: { userId: outsiderId } } })).toBe(0);

      const challengeId = await approvedChallenge({
        token: adminToken,
        userId: adminUserId,
        teamId,
        purpose: "CAPABILITY_GRANT",
        resourceKind: "temporary_elevation",
        resourceId: memberUserId,
      });
      const before = Date.now();
      const granted = await call({
        method: "POST",
        url: "/v1/admin/identity/elevations",
        token: adminToken,
        payload: body(memberUserId),
        headers: stepUpHeader(challengeId),
      });
      expect(granted.statusCode, granted.body).toBe(201);
      const { grantId } = json(granted) as { grantId: string };
      const row = await prisma.memberCapabilityGrant.findUniqueOrThrow({
        where: { id: grantId },
        include: { teamMember: { select: { userId: true } } },
      });
      expect(row).toMatchObject({ teamId, permission, grantedByUserId: adminUserId, revokedAtUtc: null });
      expect(row.teamMember.userId).toBe(memberUserId);
      const ttlMs = row.expiresAtUtc!.getTime() - before;
      expect(ttlMs).toBeGreaterThan(850_000);
      expect(ttlMs).toBeLessThanOrEqual(905_000);
      const audit = await tenantAudit("rbac.temporary_elevation.grant", grantId);
      expect(audit).toMatchObject({ userId: adminUserId, workspaceId: teamId, outcome: "success" });
      expect(audit.metadata).toMatchObject({ subjectUserId: memberUserId, permission });
    });

    it("POST /v1/admin/identity/scim/tokens/:id/revoke — the admin revokes a directory token; another tenant's stepped-up owner gets the missing-token answer", async () => {
      const { adminToken, adminUserId, teamId } = harness.fixtures.teamA;
      const { createScimToken } = await import("../src/services/access-control/scim.service.js");
      const created = await createScimToken({
        teamId,
        actorUserId: adminUserId,
        name: "K2 directory",
        scopes: ["users.read"],
      });
      const tokenId = created.projection.id;
      const url = `/v1/admin/identity/scim/tokens/${tokenId}/revoke`;

      // Cross-tenant: B's owner, stepped up in B and bound to A's token id,
      // is told exactly what a caller naming a missing token is told.
      const b = harness.fixtures.teamB;
      const bChallenge = async (resourceId: string) =>
        approvedChallenge({
          token: b.ownerToken,
          userId: b.ownerUserId,
          teamId: b.teamId,
          purpose: "EXTERNAL_IDENTITY_UNLINK",
          resourceKind: "SCIM_TOKEN",
          resourceId,
        });
      const foreign = await call({
        method: "POST",
        url,
        token: b.ownerToken,
        payload: { teamId: b.teamId, reason: "Admin revocation" },
        headers: stepUpHeader(await bChallenge(tokenId)),
      });
      const missingId = randomUUID();
      const missing = await call({
        method: "POST",
        url: `/v1/admin/identity/scim/tokens/${missingId}/revoke`,
        token: b.ownerToken,
        payload: { teamId: b.teamId, reason: "Admin revocation" },
        headers: stepUpHeader(await bChallenge(missingId)),
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
      expect((await prisma.scimProvisioningToken.findUniqueOrThrow({ where: { id: tokenId } })).status).toBe("ACTIVE");

      // scim/page.tsx — { teamId, reason: "Admin revocation" }.
      const challengeId = await approvedChallenge({
        token: adminToken,
        userId: adminUserId,
        teamId,
        purpose: "EXTERNAL_IDENTITY_UNLINK",
        resourceKind: "SCIM_TOKEN",
        resourceId: tokenId,
      });
      const revoked = await call({
        method: "POST",
        url,
        token: adminToken,
        payload: { teamId, reason: "Admin revocation" },
        headers: stepUpHeader(challengeId),
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const row = await prisma.scimProvisioningToken.findUniqueOrThrow({ where: { id: tokenId } });
      expect(row).toMatchObject({ status: "REVOKED", revokedByUserId: adminUserId, revokedReason: "Admin revocation" });
      expect(row.revokedAtUtc).not.toBeNull();
      const audit = await tenantAudit("scim.token.revoke", tokenId);
      expect(audit).toMatchObject({ userId: adminUserId, workspaceId: teamId, outcome: "success" });
    });
  });

  // ===========================================================================
  // /v1/communications/* — contact verification and the channel preference
  // ===========================================================================

  describe("messaging contact verification (recording provider)", () => {
    const phone = `+1415555${String(Math.floor(1000 + Math.random() * 8999))}`;
    let hashRecipientPhone: (e164: string) => string;
    let attemptId = "";

    beforeAll(async () => {
      ({ hashRecipientPhone } = await import("../src/services/communications/communication.service.js"));
    });

    it("POST /v1/communications/verify/start — a member starts a verification and the provider records the send; an outsider is concealed", async () => {
      const { adminToken, adminUserId, teamId } = harness.fixtures.teamA;
      // ContactChannelVerificationCard.tsx — { teamId, channel, phone, purpose: "OTP" }.
      const payload = { teamId, channel: "SMS", phone, purpose: "OTP" };
      const outsider = await call({
        method: "POST",
        url: "/v1/communications/verify/start",
        token: harness.fixtures.teamB.ownerToken,
        payload,
      });
      expect(outsider.statusCode).toBe(404);
      expect(json(outsider)).toEqual({ error: { code: "not_found" } });
      expect(
        await prisma.verificationAttempt.count({ where: { teamId, recipientHash: hashRecipientPhone(phone) } }),
      ).toBe(0);

      const res = await call({ method: "POST", url: "/v1/communications/verify/start", token: adminToken, payload });
      expect(res.statusCode, res.body).toBe(200);
      const body = json(res) as { status: string; attempt: { id: string; recipientPreview: string } };
      expect(body.status).toBe("started");
      expect(res.body).not.toContain(phone);
      attemptId = body.attempt.id;
      const row = await prisma.verificationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(row).toMatchObject({
        teamId,
        channel: "SMS",
        status: "STARTED",
        recipientHash: hashRecipientPhone(phone),
        initiatedByUserId: adminUserId,
        checkAttemptCount: 0,
      });
      expect(row.providerVerificationSid).toMatch(/\S/);
      expect(recordedCode(phone)).toMatch(/^\d{6}$/);
      const audit = await tenantAudit("communications.verify.start", attemptId);
      expect(audit).toMatchObject({ userId: adminUserId, workspaceId: teamId, outcome: "success" });
    });

    it("POST /v1/communications/preferences — opting a contact IN before it is verified is refused and writes nothing; a viewer is refused", async () => {
      const { adminToken, viewerToken, teamId } = harness.fixtures.teamA;
      const payload = { teamId, target: { kind: "contact", phone }, smsOptOut: false, preferredChannel: "SMS" };
      const early = await call({ method: "POST", url: "/v1/communications/preferences", token: adminToken, payload });
      expect(early.statusCode).toBe(409);
      expect((json(early).error as Json).code).toBe("contact_not_verified");
      const viewer = await call({ method: "POST", url: "/v1/communications/preferences", token: viewerToken, payload });
      expect(viewer.statusCode).toBe(403);
      expect(
        await prisma.communicationPreference.count({
          where: { teamId, externalContactHash: hashRecipientPhone(phone) },
        }),
      ).toBe(0);
    });

    it("POST /v1/communications/verify/check — a wrong code is denied and counted; the recorded code approves the attempt", async () => {
      const { adminToken, adminUserId, teamId } = harness.fixtures.teamA;
      expect(attemptId).not.toBe("");
      const code = recordedCode(phone);
      const wrong = code === "000000" ? "111111" : "000000";
      // ContactChannelVerificationCard.tsx — { teamId, phone, code }.
      const denied = await call({
        method: "POST",
        url: "/v1/communications/verify/check",
        token: adminToken,
        payload: { teamId, phone, code: wrong },
      });
      expect(denied.statusCode).toBe(400);
      expect(json(denied)).toEqual({ status: "denied" });
      const afterDenial = await prisma.verificationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(afterDenial).toMatchObject({ status: "STARTED", checkAttemptCount: 1, approvedAtUtc: null });

      const outsider = await call({
        method: "POST",
        url: "/v1/communications/verify/check",
        token: harness.fixtures.teamB.ownerToken,
        payload: { teamId, phone, code },
      });
      expect(outsider.statusCode).toBe(404);

      const ok = await call({
        method: "POST",
        url: "/v1/communications/verify/check",
        token: adminToken,
        payload: { teamId, phone, code },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(json(ok)).toEqual({ status: "approved", verificationId: attemptId });
      const row = await prisma.verificationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(row.status).toBe("APPROVED");
      expect(row.approvedAtUtc).not.toBeNull();
      expect(row.checkAttemptCount).toBe(2);
      const audit = await tenantAudit("communications.verify.check.approved", attemptId);
      expect(audit).toMatchObject({ userId: adminUserId, workspaceId: teamId, outcome: "success" });
    });

    it("POST /v1/communications/preferences — once verified, the admin opts the contact in to SMS; the durable preference names the channel", async () => {
      const { adminToken, adminUserId, teamId } = harness.fixtures.teamA;
      // ContactChannelVerificationCard.tsx savePreference(true).
      const payload = { teamId, target: { kind: "contact", phone }, smsOptOut: false, preferredChannel: "SMS" };
      const res = await call({ method: "POST", url: "/v1/communications/preferences", token: adminToken, payload });
      expect(res.statusCode, res.body).toBe(200);
      const preference = (json(res) as { preference: Json }).preference;
      expect(preference).toMatchObject({ teamId, isExternalContact: true, smsOptOut: false, preferredChannel: "SMS" });
      expect(res.body).not.toContain("externalContactHash");
      const row = await prisma.communicationPreference.findFirstOrThrow({
        where: { teamId, externalContactHash: hashRecipientPhone(phone) },
      });
      expect(row).toMatchObject({ id: preference.id, smsOptOut: false, preferredChannel: "SMS", userId: null });
      const audit = await tenantAudit("communications.preference.upsert", row.id);
      expect(audit).toMatchObject({ userId: adminUserId, workspaceId: teamId, outcome: "success" });
      expect(audit.metadata).toMatchObject({ smsOptOut: false, preferredChannel: "SMS" });
    });
  });

  // ===========================================================================
  // /v1/identity-security/* — step-up check, contact factor, device trust
  // ===========================================================================

  describe("step-up, contact factors and trusted devices", () => {
    it("POST /v1/identity-security/step-up/check — the authenticator code approves the challenge; a wrong code denies it and an outsider is concealed", async () => {
      const { adminToken, adminUserId, teamId } = harness.fixtures.teamA;
      const start = async () => {
        const res = await call({
          method: "POST",
          url: "/v1/identity-security/step-up/start",
          token: adminToken,
          payload: { teamId, purpose: "GOVERNANCE_POLICY_UPDATE" },
        });
        expect(res.statusCode, res.body).toBe(200);
        return (json(res).challenge as { id: string }).id;
      };

      const deniedId = await start();
      const code = await freshCode(adminUserId);
      const wrong = String((Number(code) + 500_000) % 1_000_000).padStart(6, "0");
      const outsider = await call({
        method: "POST",
        url: "/v1/identity-security/step-up/check",
        token: harness.fixtures.teamB.ownerToken,
        payload: { teamId, challengeId: deniedId, code },
      });
      expect(outsider.statusCode).toBe(404);
      expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: deniedId } })).status).toBe("PENDING");
      const denied = await call({
        method: "POST",
        url: "/v1/identity-security/step-up/check",
        token: adminToken,
        payload: { teamId, challengeId: deniedId, code: wrong },
      });
      expect(denied.statusCode).toBe(400);
      expect(json(denied)).toEqual({ status: "denied" });
      expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: deniedId } })).status).toBe("DENIED");

      // StepUpModal.tsx — { teamId, challengeId, code }.
      const approvedId = await start();
      const ok = await call({
        method: "POST",
        url: "/v1/identity-security/step-up/check",
        token: adminToken,
        payload: { teamId, challengeId: approvedId, code: await freshCode(adminUserId) },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(json(ok).status).toBe("approved");
      const row = await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: approvedId } });
      expect(row).toMatchObject({ status: "APPROVED", initiatedByUserId: adminUserId, teamId });
      const audit = await tenantAudit("identity_security.step_up.approved", approvedId);
      expect(audit).toMatchObject({ userId: adminUserId, workspaceId: teamId, outcome: "success" });
    });

    it("POST /v1/identity-security/contact-factors/enroll/verify — the recorded code activates the enrolling phone; a wrong code and another user's attempt are denied", async () => {
      const { teamId } = harness.fixtures.teamA;
      const enrollee = await teamAMember("enrollee");
      const other = await teamAMember("other");
      const destination = `+1415555${String(Math.floor(1000 + Math.random() * 8999))}`;
      const started = await call({
        method: "POST",
        url: "/v1/identity-security/contact-factors/enroll/start",
        token: enrollee.token,
        payload: { teamId, channel: "SMS", destination, label: "Work phone" },
      });
      expect(started.statusCode, started.body).toBe(200);
      const { factor, verificationAttemptId } = json(started) as {
        factor: { factorId: string };
        verificationAttemptId: string;
      };
      const code = recordedCode(destination);
      const wrong = code === "000000" ? "111111" : "000000";
      // ContactFactorEnrollmentPanel.tsx — { teamId, factorId, verificationAttemptId, code } (strict).
      const verify = (token: string, c: string) =>
        call({
          method: "POST",
          url: "/v1/identity-security/contact-factors/enroll/verify",
          token,
          payload: { teamId, factorId: factor.factorId, verificationAttemptId, code: c },
        });

      const stranger = await verify(other.token, code);
      expect(stranger.statusCode).toBe(400);
      expect(json(stranger)).toEqual({ status: "denied" });
      const wrongCode = await verify(enrollee.token, wrong);
      expect(wrongCode.statusCode).toBe(400);
      expect(json(wrongCode)).toEqual({ status: "denied" });
      expect(await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factor.factorId } })).toMatchObject({
        status: "ENROLLING",
        verifiedAtUtc: null,
      });
      expect(await prisma.mfaFactor.count({ where: { userId: other.id } })).toBe(0);

      const ok = await verify(enrollee.token, code);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.body).not.toContain(destination);
      const row = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factor.factorId } });
      expect(row).toMatchObject({ userId: enrollee.id, kind: "SMS", status: "ACTIVE" });
      expect(row.verifiedAtUtc).not.toBeNull();
      const attempt = await prisma.verificationAttempt.findUniqueOrThrow({ where: { id: verificationAttemptId } });
      expect(attempt.status).toBe("APPROVED");
      const audit = await eventually("audit identity_security.contact_factor.enrolled", () =>
        prisma.adminAuditLog.findFirst({
          where: { action: "identity_security.contact_factor.enrolled", resourceId: factor.factorId },
        }),
      );
      expect(audit).toMatchObject({ userId: enrollee.id, outcome: "success", resourceType: "mfa_factor" });
    });

    it("POST /v1/identity-security/devices/trust — the admin trusts THIS browser behind step-up; naming another subject and a viewer are refused", async () => {
      const { adminToken, adminUserId, viewerToken, memberUserId, teamId } = harness.fixtures.teamA;
      const url = "/v1/identity-security/devices/trust";

      const forOther = await call({ method: "POST", url, token: adminToken, payload: { teamId, userId: memberUserId } });
      expect(forOther.statusCode).toBe(404);
      expect(json(forOther)).toEqual({ error: { code: "not_found" } });
      const viewer = await call({ method: "POST", url, token: viewerToken, payload: { teamId, ttlDays: 30 } });
      // A member without identity.access_review.action is told the truth (403),
      // not concealed — concealment is for non-members.
      expect(viewer.statusCode).toBe(403);
      expect((json(viewer).error as Json).code).toBe("permission_denied");
      const outsider = await call({
        method: "POST",
        url,
        token: harness.fixtures.teamB.ownerToken,
        payload: { teamId, ttlDays: 30 },
      });
      expect(outsider.statusCode).toBe(404);
      expect(json(outsider)).toEqual({ error: { code: "not_found" } });
      expect(await prisma.trustedDevice.count({ where: { teamId, userId: { in: [memberUserId, harness.fixtures.teamA.viewerUserId] } } })).toBe(0);

      // TrustedDevicesSection.tsx — { teamId, ttlDays }; no user id, no device secret.
      const challengeId = await approvedChallenge({
        token: adminToken,
        userId: adminUserId,
        teamId,
        purpose: "TRUSTED_DEVICE_TRUST",
        resourceKind: "trusted_device_subject",
        resourceId: adminUserId,
      });
      const res = await call({
        method: "POST",
        url,
        token: adminToken,
        payload: { teamId, ttlDays: 30 },
        headers: stepUpHeader(challengeId),
      });
      expect(res.statusCode, res.body).toBe(200);
      const cookie = res.cookies.find((c) => c.name === "proovra_device_id");
      expect(cookie?.httpOnly).toBe(true);
      expect(res.body).not.toContain(cookie!.value);
      const device = (json(res) as { device: { id: string } }).device;
      const row = await prisma.trustedDevice.findUniqueOrThrow({ where: { id: device.id } });
      expect(row).toMatchObject({ teamId, userId: adminUserId, status: "ACTIVE" });
      expect(row.deviceIdHash).not.toBe(cookie!.value);
      expect(row.deviceIdHash).not.toBe(createHash("sha256").update("").digest("hex"));
      const days = (row.trustedUntilUtc.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29);
      expect(days).toBeLessThanOrEqual(30);
      const audit = await tenantAudit("identity_security.trusted_device.add", row.id);
      expect(audit).toMatchObject({ userId: adminUserId, workspaceId: teamId, outcome: "success" });
    });
  });
});
