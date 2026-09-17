/**
 * Defect closure — identity administration (D11, D14, D24, D28, D29, D30, D32),
 * proven through the real routes (`harness.app.inject`) against a disposable
 * PostgreSQL 16 + Redis.
 *
 *   D11  MFA recovery resend-email / cancel / verify-email: someone else's
 *        request and a request that does not exist are ONE answer (404).
 *   D14  /v1/identity/mfa-admin/*: a member of the workspace who is not an
 *        MFA administrator is told 403 — byte-identical to a member without
 *        the capability — while another tenant keeps the concealed 404.
 *   D24  POST /v1/auth/email/register holds the password policy reset holds
 *        (weak_new_password).
 *   D28  POST /v1/admin/identity/providers is an Enterprise capability, like
 *        SCIM token minting.
 *   D29  POST /v1/admin/identity/elevations cannot elevate anyone into a
 *        permission the granting admin does not hold.
 *   D30  POST /v1/break-glass/activate only names an active administrator of
 *        the Organization as its emergency identity.
 *   D32  POST /v1/support-access/enter writes its own audit record, on success
 *        and on refusal.
 *
 * Every step-up is a real authenticator ceremony (`/v1/identity-security/
 * step-up/start` + `/check`); the step ledger is reset between ceremonies.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("identity administration defects (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let jwt: typeof import("../src/services/jwt.js");
  let orgA: string;

  const secrets = new Map<string, Buffer>();
  const createdUserIds: string[] = [];
  const createdTeamIds: string[] = [];
  const createdOrgIds: string[] = [];

  const call = (opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    payload?: unknown;
    challengeId?: string;
  }) =>
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
  const errorCode = (res: { body: string }) => (json(res).error as Json | undefined)?.code;

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

  async function freshCode(userId: string): Promise<string> {
    await prisma.mfaFactor.updateMany({
      where: { userId, kind: "TOTP", status: "ACTIVE" },
      data: { lastUsedAt: null },
    });
    return totp.computeTotpCode(secrets.get(userId)!, totp.timeStep(Math.floor(Date.now() / 1000)));
  }

  /** The StepUpModal ceremony; returns the approved challenge id. */
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

  const mint = (userId: string, email: string) =>
    jwt.signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );

  /** Platform staff who own an internal anchor workspace and hold an authenticator app. */
  async function staffMember(label: string) {
    const email = `dia-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: {
        email,
        firstName: "DIA",
        lastName: label,
        provider: "EMAIL",
        providerUserId: email,
        emailVerifiedAt: new Date(),
        platformRole: "admin",
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "dia-fixture",
      })),
    });
    const org = await prisma.organization.create({
      data: { name: `DIA Support ${label}`, billingOwnerUserId: user.id, status: "ACTIVE", kind: "CUSTOMER" },
      select: { id: true },
    });
    createdOrgIds.push(org.id);
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: user.id, role: "ORG_OWNER" },
    });
    const team = await prisma.team.create({
      data: {
        name: `DIA Support ${label}`,
        ownerUserId: user.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
      },
      select: { id: true },
    });
    createdTeamIds.push(team.id);
    await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, role: "OWNER", status: "ACTIVE" } });
    await seedTotp(user.id);
    return { id: user.id, token: mint(user.id, email), teamId: team.id };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    jwt = await import("../src/services/jwt.js");
    const { teamA } = harness.fixtures;
    orgA = (
      await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } })
    ).organizationId;
    await seedTotp(teamA.ownerUserId);
    await seedTotp(teamA.adminUserId);
    // The identity console acts in the caller's server-derived workspace.
    await prisma.user.update({ where: { id: teamA.adminUserId }, data: { currentWorkspaceId: teamA.teamId } });
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const users = { in: createdUserIds };
      const teamIds = [harness.fixtures.teamA.teamId, harness.fixtures.teamB.teamId];
      await prisma.emergencyAccessGrant.deleteMany({ where: { requestedByUserId: users } }).catch(() => undefined);
      await prisma.supportAccessGrant.deleteMany({ where: { supportUserId: users } }).catch(() => undefined);
      await prisma.ssoConnection.deleteMany({ where: { teamId: { in: teamIds } } }).catch(() => undefined);
      await prisma.mfaRecoveryRequest.deleteMany({ where: { teamId: { in: teamIds } } }).catch(() => undefined);
      await prisma.mfaFactor.deleteMany({ where: { userId: users } }).catch(() => undefined);
      await prisma.teamMember.deleteMany({ where: { teamId: { in: createdTeamIds } } }).catch(() => undefined);
      await prisma.team.deleteMany({ where: { id: { in: createdTeamIds } } }).catch(() => undefined);
      await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: createdOrgIds } } }).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: users } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  // ===========================================================================
  // D11
  // ===========================================================================

  it("D11 — resend-email, cancel and verify-email answer someone else's recovery request exactly as a missing one", async () => {
    const { viewerToken, memberToken, teamId } = harness.fixtures.teamA;
    const created = await call({
      method: "POST",
      url: "/v1/identity/mfa-admin/recovery-requests",
      token: viewerToken,
      payload: { teamId, reason: "Phone was lost on a site visit" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const requestId = (json(created).request as { id: string }).id;
    const before = await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } });

    for (const leg of ["resend-email", "cancel", "verify-email"] as const) {
      const payload = leg === "verify-email" ? { token: "x".repeat(32) } : undefined;
      const foreign = await call({
        method: "POST",
        url: `/v1/identity/mfa/recovery-requests/${requestId}/${leg}`,
        token: memberToken,
        payload,
      });
      const missing = await call({
        method: "POST",
        url: `/v1/identity/mfa/recovery-requests/${randomUUID()}/${leg}`,
        token: memberToken,
        payload,
      });
      expect(missing.statusCode, leg).toBe(404);
      expect(foreign.statusCode, leg).toBe(404);
      expect(foreign.body, leg).toBe(missing.body);
      expect(json(foreign), leg).toEqual({ error: "request_not_found" });
    }

    // Nothing moved on the real request.
    const after = await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(after.status).toBe(before.status);
    expect(after.emailResendCount).toBe(before.emailResendCount);
    expect(after.emailVerificationTokenHash).toBe(before.emailVerificationTokenHash);
  });

  // ===========================================================================
  // D14
  // ===========================================================================

  it("D14 — a workspace member who is not an MFA administrator gets 403, the same body as a member without the capability; another tenant gets the concealed 404", async () => {
    const { viewerToken, memberUserId, teamId } = harness.fixtures.teamA;
    // VIEWER holds identity.org_policy.read, so the posture read reaches the
    // OWNER/ADMIN narrowing.
    const narrowed = await call({
      method: "GET",
      url: `/v1/identity/mfa-admin/posture/${teamId}/${memberUserId}`,
      token: viewerToken,
    });
    // VIEWER does not hold identity.access_review.action, so authorizeOrFail
    // itself refuses the revoke.
    const noCapability = await call({
      method: "POST",
      url: `/v1/identity/mfa-admin/factors/${teamId}/${memberUserId}/${randomUUID()}/revoke`,
      token: viewerToken,
      payload: { reason: "Lost device" },
    });
    expect(noCapability.statusCode).toBe(403);
    expect(narrowed.statusCode).toBe(403);
    expect(json(narrowed)).toEqual({ error: { code: "permission_denied", reason: "permission_not_granted" } });
    expect(narrowed.body).toBe(noCapability.body);

    const outsider = await call({
      method: "GET",
      url: `/v1/identity/mfa-admin/posture/${teamId}/${memberUserId}`,
      token: harness.fixtures.teamB.ownerToken,
    });
    expect(outsider.statusCode).toBe(404);
    expect(json(outsider)).toEqual({ error: { code: "not_found" } });

    // The owner is an administrator and reads the posture.
    const owner = await call({
      method: "GET",
      url: `/v1/identity/mfa-admin/posture/${teamId}/${memberUserId}`,
      token: harness.fixtures.teamA.ownerToken,
    });
    expect(owner.statusCode, owner.body).toBe(200);
  });

  // ===========================================================================
  // D24
  // ===========================================================================

  it("D24 — register refuses a password below the policy with the reset code, and accepts a compliant one", async () => {
    const weakEmail = `dia-weak-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const weak = await call({
      method: "POST",
      url: "/v1/auth/email/register",
      payload: { email: weakEmail, password: "password1" },
    });
    expect(weak.statusCode, weak.body).toBe(400);
    expect(errorCode(weak)).toBe("weak_new_password");
    expect(await prisma.user.count({ where: { email: weakEmail } })).toBe(0);

    const okEmail = `dia-ok-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const ok = await call({
      method: "POST",
      url: "/v1/auth/email/register",
      payload: { email: okEmail, password: "Correct-Horse-9" },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const user = await prisma.user.findFirstOrThrow({ where: { email: okEmail }, select: { id: true } });
    createdUserIds.push(user.id);
  });

  // ===========================================================================
  // D28
  // ===========================================================================

  it("D28 — creating an SSO connection is refused below Enterprise, after a genuine step-up, and allowed on Enterprise", async () => {
    const payload = (teamId: string) => ({
      teamId,
      provider: "GENERIC_OIDC",
      displayName: `DIA OIDC ${randomUUID().slice(0, 6)}`,
      issuerUrl: "https://idp.dia.example.test/oauth2",
      clientId: "dia-local-client",
      clientSecret: "dia-local-client-secret-not-real",
      allowedEmailDomains: ["dia.example.test"],
      jitDefaultRole: "MEMBER",
    });
    const a = harness.fixtures.teamA;
    const plan = await prisma.team.findUniqueOrThrow({ where: { id: a.teamId }, select: { billingPlan: true } });
    expect(plan.billingPlan).not.toBe("ENTERPRISE");
    const body = payload(a.teamId);
    const challengeId = await approvedChallenge({
      token: a.adminToken,
      userId: a.adminUserId,
      teamId: a.teamId,
      purpose: "EXTERNAL_IDENTITY_LINK",
      resourceKind: "sso_connection",
    });
    const refused = await call({
      method: "POST",
      url: "/v1/admin/identity/providers",
      token: a.adminToken,
      payload: body,
      challengeId,
    });
    expect(refused.statusCode, refused.body).toBe(402);
    expect(errorCode(refused)).toBe("ENTERPRISE_FEATURE_REQUIRED");
    expect(await prisma.ssoConnection.count({ where: { teamId: a.teamId, displayName: body.displayName } })).toBe(0);

    // Positive control — an Enterprise workspace creates one.
    const b = harness.fixtures.teamB;
    const orgB = (
      await prisma.team.findUniqueOrThrow({ where: { id: b.teamId }, select: { organizationId: true } })
    ).organizationId;
    await prisma.team.update({ where: { id: b.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const { upsertEnterpriseContract } = await import(
      "../src/services/organization/enterprise-contract.service.js"
    );
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgB,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
    await seedTotp(b.ownerUserId);
    const bBody = payload(b.teamId);
    const created = await call({
      method: "POST",
      url: "/v1/admin/identity/providers",
      token: b.ownerToken,
      payload: bBody,
      challengeId: await approvedChallenge({
        token: b.ownerToken,
        userId: b.ownerUserId,
        teamId: b.teamId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "sso_connection",
      }),
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(await prisma.ssoConnection.count({ where: { teamId: b.teamId, displayName: bBody.displayName } })).toBe(1);
  });

  // ===========================================================================
  // D29
  // ===========================================================================

  it("D29 — an admin cannot elevate a member into a permission the admin does not hold; one the admin holds is granted", async () => {
    const { adminToken, adminUserId, memberUserId, teamId } = harness.fixtures.teamA;
    const body = (permission: string) => ({
      teamId,
      userId: memberUserId,
      permission,
      reason: "DIA incident triage cover",
      ttlSeconds: 900,
    });
    const stepUp = () =>
      approvedChallenge({
        token: adminToken,
        userId: adminUserId,
        teamId,
        purpose: "CAPABILITY_GRANT",
        resourceKind: "temporary_elevation",
        resourceId: memberUserId,
      });

    // ADMIN's role does not include billing.manage.
    const refused = await call({
      method: "POST",
      url: "/v1/admin/identity/elevations",
      token: adminToken,
      payload: body("billing.manage"),
      challengeId: await stepUp(),
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(json(refused)).toEqual({
      error: { code: "RBAC_ELEVATION_BLOCKED", details: { reason: "grantor_lacks_permission" } },
    });
    expect(
      await prisma.memberCapabilityGrant.count({
        where: { teamId, permission: "billing.manage", teamMember: { userId: memberUserId } },
      }),
    ).toBe(0);

    const granted = await call({
      method: "POST",
      url: "/v1/admin/identity/elevations",
      token: adminToken,
      payload: body("identity.member.invite"),
      challengeId: await stepUp(),
    });
    expect(granted.statusCode, granted.body).toBe(201);
  });

  // ===========================================================================
  // D30
  // ===========================================================================

  it("D30 — break-glass names only an active administrator of the Organization as its emergency identity", async () => {
    const staff = await staffMember("bg");
    const { teamA, teamB } = harness.fixtures;
    // An ORG_MEMBER of Organization A (not an administrator).
    await prisma.organizationMembership.create({
      data: { organizationId: orgA, userId: teamA.memberUserId, role: "ORG_MEMBER" },
    });
    const activate = async (emergencyUserId: string) =>
      call({
        method: "POST",
        url: "/v1/break-glass/activate",
        token: staff.token,
        payload: {
          teamId: staff.teamId,
          organizationId: orgA,
          emergencyUserId,
          reason: "DIA incident 4711: SSO outage recovery",
          grantedRole: "EMERGENCY_READ_ONLY",
        },
        challengeId: await approvedChallenge({
          token: staff.token,
          userId: staff.id,
          teamId: staff.teamId,
          purpose: "ORG_SECURITY_POLICY_UPDATE",
        }),
      });

    for (const emergencyUserId of [teamB.ownerUserId, teamA.memberUserId, randomUUID()]) {
      const res = await activate(emergencyUserId);
      expect(res.statusCode, res.body).toBe(400);
      expect(errorCode(res)).toBe("BREAK_GLASS_EMERGENCY_USER_INVALID");
      expect(await prisma.emergencyAccessGrant.count({ where: { organizationId: orgA, emergencyUserId } })).toBe(0);
    }

    const ok = await activate(teamA.ownerUserId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      await prisma.emergencyAccessGrant.count({
        where: { organizationId: orgA, emergencyUserId: teamA.ownerUserId, status: "ACTIVE" },
      }),
    ).toBe(1);
  });

  // ===========================================================================
  // D32
  // ===========================================================================

  it("D32 — support-access/enter records its own audit row for a successful entry and for a refused one", async () => {
    const { teamA } = harness.fixtures;
    const holder = await staffMember("sa");
    const other = await staffMember("sa2");
    const staffChallenge = (s: { id: string; token: string; teamId: string }) =>
      approvedChallenge({ token: s.token, userId: s.id, teamId: s.teamId, purpose: "ORG_SECURITY_POLICY_UPDATE" });

    const started = await call({
      method: "POST",
      url: "/v1/support-access/start",
      token: holder.token,
      payload: {
        teamId: holder.teamId,
        organizationId: orgA,
        reason: "DIA incident 4711: customer outage triage",
        accessLevel: "READ_ONLY",
        approvedByUserId: teamA.ownerUserId,
        customerApprovalUnavailableReason: null,
      },
      challengeId: await staffChallenge(holder),
    });
    expect(started.statusCode, started.body).toBe(200);
    const grantId = ((json(started) as { grant: { id: string } }).grant).id;

    const refused = await call({
      method: "POST",
      url: "/v1/support-access/enter",
      token: other.token,
      payload: { teamId: other.teamId, grantId },
      challengeId: await staffChallenge(other),
    });
    expect(refused.statusCode).toBe(403);
    const denied = await eventually("audit identity.support_access.entry_denied", () =>
      prisma.adminAuditLog.findFirst({
        where: { action: "identity.support_access.entry_denied", resourceId: grantId, userId: other.id },
      }),
    );
    expect(denied).toMatchObject({ outcome: "denied", organizationId: orgA, resourceType: "support_access_grant" });
    expect(denied.metadata).toMatchObject({
      grantId,
      anchorTeamId: other.teamId,
      supportActorUserId: other.id,
      denialReason: "actor_mismatch",
    });

    const entered = await call({
      method: "POST",
      url: "/v1/support-access/enter",
      token: holder.token,
      payload: { teamId: holder.teamId, grantId },
      challengeId: await staffChallenge(holder),
    });
    expect(entered.statusCode, entered.body).toBe(200);
    const audit = await eventually("audit identity.support_access.entered", () =>
      prisma.adminAuditLog.findFirst({
        where: { action: "identity.support_access.entered", resourceId: grantId, userId: holder.id },
      }),
    );
    expect(audit).toMatchObject({ outcome: "success", organizationId: orgA, resourceType: "support_access_grant" });
    expect(audit.metadata).toMatchObject({
      grantId,
      anchorTeamId: holder.teamId,
      supportActorUserId: holder.id,
      accessLevel: "READ_ONLY",
    });
    // The token never lands in the trail.
    const token = (json(entered) as { supportContextToken: string }).supportContextToken;
    expect(JSON.stringify(audit)).not.toContain(token);
  });
});
