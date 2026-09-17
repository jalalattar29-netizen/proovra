/**
 * BATCH K2 (security / sessions / support, part B) — runtime proof of the
 * session-destroying personal-security actions, the platform-staff
 * break-glass / support-access actions, and the external reviewer portal
 * session, against a disposable PostgreSQL 16 through `harness.app.inject`.
 *
 * Every actor here is DISPOSABLE — created for one proof and deleted after —
 * because these actions end sessions or open emergency access:
 *
 *   - personal accounts with a password and REAL session inventory rows
 *     (`recordAuthenticatedSession`, the login path's own writer) behind
 *     tokens whose `sid` the auth middleware hashes onto `req.user`;
 *   - platform staff (`User.platformRole = "admin"`, read from the row on
 *     every request) who OWN an internal anchor workspace and hold a verified
 *     authenticator app for the step-up both staff routes demand;
 *   - an external review grant issued through the canonical invitation
 *     service, whose raw token is the portal credential.
 *
 * "Still signed in" is proven by the token authenticating a request, and
 * "signed out" by the same request answering 401 — the RevokedSession registry
 * `requireAuth` consults, not only the inventory list.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("K2 security (B) — sessions, break-glass, support access, portal (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let jwt: typeof import("../src/services/jwt.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let verifyPassword: (typeof import("../src/services/email-password-auth.service.js"))["verifyPassword"];
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

  async function eventually<T>(label: string, read: () => Promise<T | null | undefined>): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`${label} was never written`);
      await new Promise((r) => setImmediate(r));
    }
  }

  const mint = (userId: string, email: string) =>
    jwt.signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );

  /** A disposable account. */
  async function persona(label: string, opts: { password?: string; platformRole?: string } = {}) {
    const email = `k2b-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: {
        email,
        firstName: "K2",
        lastName: label,
        provider: "EMAIL",
        providerUserId: email,
        passwordHash: opts.password ? hashPassword(opts.password) : null,
        emailVerifiedAt: new Date(),
        platformRole: opts.platformRole ?? null,
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
        source: "k2-fixture",
      })),
    });
    return { id: user.id, email, token: mint(user.id, email) };
  }

  /** A signed-in device: a token AND the inventory row login writes for it. */
  async function session(user: { id: string; email: string }) {
    const token = mint(user.id, user.email);
    const claims = jwt.verifyJwt(token, process.env.AUTH_JWT_SECRET as string) as unknown as {
      sid: string;
      iat: number;
      exp: number;
    };
    const { recordAuthenticatedSession } = await import(
      "../src/services/access-control/session-inventory.service.js"
    );
    const projection = await recordAuthenticatedSession({
      userId: user.id,
      teamId: null,
      sid: claims.sid,
      iat: claims.iat,
      exp: claims.exp,
      uaPreview: "K2 device",
    });
    const row = await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: projection.id } });
    return { token, id: row.id, hash: row.sessionIdHash };
  }

  /** True when the token still authenticates a request. */
  const signedIn = async (token: string) => {
    const res = await call({ method: "GET", url: "/v1/identity-security/my-sessions", token });
    expect([200, 401]).toContain(res.statusCode);
    return res.statusCode === 200;
  };

  const platformAudit = (action: string, resourceId: string) =>
    eventually(`audit ${action}`, () =>
      prisma.adminAuditLog.findFirst({ where: { action, resourceId }, orderBy: { createdAt: "desc" } }),
    );

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
  async function approvedChallenge(token: string, userId: string, teamId: string, purpose: string) {
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token,
      payload: { teamId, purpose },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (json(started).challenge as { id: string }).id;
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token,
      payload: { teamId, challengeId, code: await freshCode(userId) },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  /** Platform staff who own an internal anchor workspace and hold an authenticator app. */
  async function staffMember(label: string) {
    const user = await persona(label, { platformRole: "admin" });
    const org = await prisma.organization.create({
      data: { name: `K2 Support ${label}`, billingOwnerUserId: user.id, status: "ACTIVE", kind: "CUSTOMER" },
      select: { id: true },
    });
    createdOrgIds.push(org.id);
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: user.id, role: "ORG_OWNER" },
    });
    const team = await prisma.team.create({
      data: {
        name: `K2 Support ${label}`,
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
    return { ...user, teamId: team.id };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    jwt = await import("../src/services/jwt.js");
    ({ hashPassword, verifyPassword } = await import("../src/services/email-password-auth.service.js"));
    orgA = (
      await prisma.team.findUniqueOrThrow({
        where: { id: harness.fixtures.teamA.teamId },
        select: { organizationId: true },
      })
    ).organizationId;
    // The customer org admin used as the refused persona holds an authenticator
    // app and identity.org_policy.manage in their own workspace — everything
    // the staff routes ask for EXCEPT platform-staff status.
    await seedTotp(harness.fixtures.teamA.adminUserId);
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const users = { in: createdUserIds };
      await prisma.emergencyAccessGrant.deleteMany({ where: { requestedByUserId: users } }).catch(() => undefined);
      await prisma.supportAccessGrant.deleteMany({ where: { supportUserId: users } }).catch(() => undefined);
      await prisma.revokedSession.deleteMany({ where: { userId: users } }).catch(() => undefined);
      await prisma.authenticatedSession.deleteMany({ where: { userId: users } }).catch(() => undefined);
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
  // External reviewer portal — the grant token is the credential
  // ===========================================================================

  describe("external reviewer portal session", () => {
    async function issueGrant() {
      const { issueInvitation } = await import(
        "../src/services/external-review/portal-invitation.service.js"
      );
      const { teamA } = harness.fixtures;
      const issued = await issueInvitation({
        teamId: teamA.teamId,
        invitedByUserId: teamA.ownerUserId,
        reviewerEmail: `k2-reviewer-${randomUUID().slice(0, 8)}@test.proovra.local`,
        role: "EXTERNAL_REVIEWER",
        scope: { kind: "EVIDENCE", evidenceId: teamA.evidenceId },
        expiresAtUtc: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      });
      if (!issued.ok) throw new Error(`invitation refused: ${issued.denial}`);
      return { grantId: issued.grantId, rawToken: issued.rawToken };
    }
    const activity = (grantId: string, code: string) =>
      prisma.externalReviewActivity.findMany({ where: { grantId, code } });

    it("POST /v1/portal/auth — the invitation token opens a session and accepts the invitation; a revoked or unknown token is refused", async () => {
      const { teamA } = harness.fixtures;
      const revoked = await issueGrant();
      const { revokeInvitation } = await import(
        "../src/services/external-review/portal-invitation.service.js"
      );
      expect((await revokeInvitation({ teamId: teamA.teamId, grantId: revoked.grantId, revokedByUserId: teamA.ownerUserId })).ok).toBe(true);
      const refused = await call({ method: "POST", url: "/v1/portal/auth", payload: { token: revoked.rawToken } });
      expect(refused.statusCode).toBe(401);
      expect(json(refused)).toEqual({ denial: "TOKEN_REVOKED" });
      expect(await activity(revoked.grantId, "LOGIN")).toHaveLength(0);
      const unknown = await call({
        method: "POST",
        url: "/v1/portal/auth",
        payload: { token: `k2-not-a-token-${randomUUID()}` },
      });
      expect(unknown.statusCode).toBe(401);
      expect(json(unknown)).toEqual({ denial: "TOKEN_INVALID" });
      // Accepting at the door never widens the gate: a lapsed invitation stays refused and unaccepted.
      const lapsed = await issueGrant();
      await prisma.externalReviewGrant.update({
        where: { id: lapsed.grantId },
        data: { createdAtUtc: new Date(Date.now() - 120_000), expiresAtUtc: new Date(Date.now() - 60_000) },
      });
      const lapsedRes = await call({ method: "POST", url: "/v1/portal/auth", payload: { token: lapsed.rawToken } });
      expect(lapsedRes.statusCode).toBe(401);
      expect(json(lapsedRes)).toEqual({ denial: "TOKEN_EXPIRED" });
      expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: lapsed.grantId } })).state).toBe("INVITED");

      // portal-client.ts authenticate — { token, mfaToken, existingSessionId }.
      const grant = await issueGrant();
      expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grant.grantId } })).state).toBe("INVITED");
      const res = await call({ method: "POST", url: "/v1/portal/auth", payload: { token: grant.rawToken } });
      expect(res.statusCode, res.body).toBe(200);
      const body = json(res) as { sessionId: string; newLogin: boolean; role: string };
      expect(body).toMatchObject({ newLogin: true, role: "EXTERNAL_REVIEWER" });
      expect(body.sessionId).toMatch(/^[0-9a-f]{32}$/);
      expect(res.body).not.toContain(grant.rawToken);
      const row = await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grant.grantId } });
      expect(row.state).toBe("ACTIVE");
      const assignment = await prisma.externalReviewerRoleAssignment.findUniqueOrThrow({ where: { id: grant.grantId } });
      expect(assignment.inviteAcceptedAtUtc).not.toBeNull();
      // The portal's audit trail is its activity ledger.
      const logins = await activity(grant.grantId, "LOGIN");
      expect(logins).toHaveLength(1);
      expect(logins[0]).toMatchObject({ teamId: teamA.teamId, sessionId: body.sessionId });
      expect(await activity(grant.grantId, "GRANT_ACCEPTED")).toHaveLength(1);
    });

    it("POST /v1/portal/logout — the session's LOGOUT is recorded against its session id; a missing or revoked credential records nothing", async () => {
      const { teamA } = harness.fixtures;
      const grant = await issueGrant();
      const auth = await call({ method: "POST", url: "/v1/portal/auth", payload: { token: grant.rawToken } });
      expect(auth.statusCode, auth.body).toBe(200);
      const sessionId = (json(auth) as { sessionId: string }).sessionId;

      const anonymous = await call({ method: "POST", url: "/v1/portal/logout" });
      expect(anonymous.statusCode).toBe(401);
      expect(json(anonymous)).toEqual({ denial: "TOKEN_INVALID" });
      expect(await activity(grant.grantId, "LOGOUT")).toHaveLength(0);

      // portal-client.ts logout — bearer token + x-portal-session, no body.
      const res = await call({
        method: "POST",
        url: "/v1/portal/logout",
        token: grant.rawToken,
        headers: { "x-portal-session": sessionId },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ ok: true });
      const logouts = await activity(grant.grantId, "LOGOUT");
      expect(logouts).toHaveLength(1);
      expect(logouts[0]).toMatchObject({ teamId: teamA.teamId, sessionId });
      // Refreshing an existing session is not a second login.
      expect(await activity(grant.grantId, "LOGIN")).toHaveLength(1);

      const { revokeInvitation } = await import(
        "../src/services/external-review/portal-invitation.service.js"
      );
      await revokeInvitation({ teamId: teamA.teamId, grantId: grant.grantId, revokedByUserId: teamA.ownerUserId });
      const afterRevoke = await call({
        method: "POST",
        url: "/v1/portal/logout",
        token: grant.rawToken,
        headers: { "x-portal-session": sessionId },
      });
      expect(afterRevoke.statusCode).toBe(401);
      expect(json(afterRevoke)).toEqual({ denial: "TOKEN_REVOKED" });
      expect(await activity(grant.grantId, "LOGOUT")).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Platform staff — break-glass and support access
  // ===========================================================================

  describe("break-glass and support access (platform staff)", () => {
    const reason = "K2 incident 4711: customer outage triage";

    it("POST /v1/break-glass/activate — staff activate a step-up-bound emergency grant; a customer org admin is concealed and a duplicate is a conflict", async () => {
      const staff = await staffMember("bg");
      const { teamA } = harness.fixtures;
      // support-access/page.tsx — { teamId, organizationId, emergencyUserId, reason, grantedRole }.
      const payload = (teamId: string) => ({
        teamId,
        organizationId: orgA,
        emergencyUserId: teamA.ownerUserId,
        reason,
        grantedRole: "EMERGENCY_READ_ONLY",
      });

      const customer = await call({
        method: "POST",
        url: "/v1/break-glass/activate",
        token: teamA.adminToken,
        payload: payload(teamA.teamId),
        headers: {
          "x-proovra-step-up-challenge-id": await approvedChallenge(
            teamA.adminToken,
            teamA.adminUserId,
            teamA.teamId,
            "ORG_SECURITY_POLICY_UPDATE",
          ),
        },
      });
      expect(customer.statusCode).toBe(404);
      expect(json(customer)).toEqual({ error: { code: "NOT_FOUND" } });
      expect(await prisma.emergencyAccessGrant.count({ where: { organizationId: orgA, emergencyUserId: teamA.ownerUserId } })).toBe(0);

      const gated = await call({ method: "POST", url: "/v1/break-glass/activate", token: staff.token, payload: payload(staff.teamId) });
      expect(gated.statusCode).toBe(401);
      expect((json(gated).error as Json).code).toBe("STEP_UP_REQUIRED");

      const challengeId = await approvedChallenge(staff.token, staff.id, staff.teamId, "ORG_SECURITY_POLICY_UPDATE");
      const res = await call({
        method: "POST",
        url: "/v1/break-glass/activate",
        token: staff.token,
        payload: payload(staff.teamId),
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(res.statusCode, res.body).toBe(200);
      const grantId = ((json(res) as { grant: { id: string } }).grant).id;
      const row = await prisma.emergencyAccessGrant.findUniqueOrThrow({ where: { id: grantId } });
      expect(row).toMatchObject({
        organizationId: orgA,
        emergencyUserId: teamA.ownerUserId,
        requestedByUserId: staff.id,
        grantedRole: "EMERGENCY_READ_ONLY",
        status: "ACTIVE",
        stepUpProofId: challengeId,
        reason,
      });
      expect(row.expiresAtUtc.getTime() - row.startedAtUtc.getTime()).toBeLessThanOrEqual(4 * 3600 * 1000);
      expect(res.body).not.toContain(challengeId);
      const audit = await eventually("audit identity.break_glass.activated", () =>
        prisma.adminAuditLog.findFirst({
          where: { action: "identity.break_glass.activated", organizationId: orgA, userId: staff.id },
        }),
      );
      expect(audit).toMatchObject({ outcome: "success", resourceId: orgA });
      expect(audit.metadata).toMatchObject({ emergencyUserId: teamA.ownerUserId, requestedByUserId: staff.id });

      const again = await call({
        method: "POST",
        url: "/v1/break-glass/activate",
        token: staff.token,
        payload: payload(staff.teamId),
        headers: {
          "x-proovra-step-up-challenge-id": await approvedChallenge(staff.token, staff.id, staff.teamId, "ORG_SECURITY_POLICY_UPDATE"),
        },
      });
      expect(again.statusCode).toBe(409);
      expect((json(again).error as Json).code).toBe("BREAK_GLASS_ALREADY_ACTIVE");
      expect(await prisma.emergencyAccessGrant.count({ where: { organizationId: orgA, emergencyUserId: teamA.ownerUserId } })).toBe(1);
    });

    let supportStaff: Awaited<ReturnType<typeof staffMember>>;
    let supportGrantId = "";

    it("POST /v1/support-access/start — staff mint a customer-approved grant; a customer admin is concealed, and a missing or non-admin approver is refused", async () => {
      supportStaff = await staffMember("sa");
      const { teamA, teamB } = harness.fixtures;
      // support-access/page.tsx — the exact body shape.
      const payload = (overrides: Json = {}) => ({
        teamId: supportStaff.teamId,
        organizationId: orgA,
        reason,
        accessLevel: "READ_ONLY",
        approvedByUserId: teamA.ownerUserId,
        customerApprovalUnavailableReason: null,
        ...overrides,
      });
      const staffChallenge = () =>
        approvedChallenge(supportStaff.token, supportStaff.id, supportStaff.teamId, "ORG_SECURITY_POLICY_UPDATE");
      const start = async (body: Json, token = supportStaff.token, challengeId?: string) =>
        call({
          method: "POST",
          url: "/v1/support-access/start",
          token,
          payload: body,
          headers: { "x-proovra-step-up-challenge-id": challengeId ?? (await staffChallenge()) },
        });

      const customer = await start(
        payload({ teamId: teamA.teamId }),
        teamA.adminToken,
        await approvedChallenge(teamA.adminToken, teamA.adminUserId, teamA.teamId, "ORG_SECURITY_POLICY_UPDATE"),
      );
      expect(customer.statusCode).toBe(404);
      expect(json(customer)).toEqual({ error: { code: "NOT_FOUND" } });

      const noApprover = await start(payload({ approvedByUserId: null }));
      expect(noApprover.statusCode).toBe(400);
      expect((json(noApprover).error as Json).code).toBe("SUPPORT_ACCESS_APPROVER_REQUIRED");
      const foreignApprover = await start(payload({ approvedByUserId: teamB.ownerUserId }));
      expect(foreignApprover.statusCode).toBe(400);
      expect((json(foreignApprover).error as Json).code).toBe("SUPPORT_ACCESS_APPROVER_INVALID");
      expect(await prisma.supportAccessGrant.count({ where: { organizationId: orgA } })).toBe(0);

      const res = await start(payload());
      expect(res.statusCode, res.body).toBe(200);
      supportGrantId = ((json(res) as { grant: { id: string } }).grant).id;
      const row = await prisma.supportAccessGrant.findUniqueOrThrow({ where: { id: supportGrantId } });
      expect(row).toMatchObject({
        supportUserId: supportStaff.id,
        organizationId: orgA,
        teamId: null,
        accessLevel: "READ_ONLY",
        approvedByUserId: teamA.ownerUserId,
        status: "ACTIVE",
        reason,
      });
      const audit = await eventually("audit identity.support_access.started", () =>
        prisma.adminAuditLog.findFirst({
          where: { action: "identity.support_access.started", organizationId: orgA, userId: supportStaff.id },
        }),
      );
      expect(audit).toMatchObject({ outcome: "success", resourceId: orgA });
      expect(audit.metadata).toMatchObject({ grantId: supportGrantId, approvedByUserId: teamA.ownerUserId });
    });

    it("POST /v1/support-access/enter — the grant holder enters behind step-up and receives a token bound to THIS session; another staff member and a customer admin are refused", async () => {
      expect(supportGrantId).not.toBe("");
      const { teamA } = harness.fixtures;
      const other = await staffMember("sa2");
      // support-access/page.tsx — { teamId, grantId }.
      const otherRes = await call({
        method: "POST",
        url: "/v1/support-access/enter",
        token: other.token,
        payload: { teamId: other.teamId, grantId: supportGrantId },
        headers: {
          "x-proovra-step-up-challenge-id": await approvedChallenge(other.token, other.id, other.teamId, "ORG_SECURITY_POLICY_UPDATE"),
        },
      });
      expect(otherRes.statusCode).toBe(403);
      expect(json(otherRes)).toEqual({ error: { code: "SUPPORT_CONTEXT_ENTRY_DENIED", reason: "actor_mismatch" } });
      expect(otherRes.body).not.toContain("supportContextToken");
      const customer = await call({
        method: "POST",
        url: "/v1/support-access/enter",
        token: teamA.adminToken,
        payload: { teamId: teamA.teamId, grantId: supportGrantId },
      });
      expect(customer.statusCode).toBe(404);
      expect(json(customer)).toEqual({ error: { code: "NOT_FOUND" } });

      const challengeId = await approvedChallenge(
        supportStaff.token,
        supportStaff.id,
        supportStaff.teamId,
        "ORG_SECURITY_POLICY_UPDATE",
      );
      const res = await call({
        method: "POST",
        url: "/v1/support-access/enter",
        token: supportStaff.token,
        payload: { teamId: supportStaff.teamId, grantId: supportGrantId },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = json(res) as { supportContextToken: string; expiresInSeconds: number };
      expect(body.expiresInSeconds).toBe(15 * 60);
      const { verifySupportContextToken } = await import(
        "../src/services/identity/support-context-token.service.js"
      );
      const { hashSessionId } = await import("../src/services/identity-security/session-revocation.service.js");
      const verified = verifySupportContextToken(body.supportContextToken);
      expect(verified.valid).toBe(true);
      const claims = jwt.verifyJwt(supportStaff.token, process.env.AUTH_JWT_SECRET as string) as unknown as { sid: string };
      expect(verified.valid && verified.payload).toMatchObject({
        grantId: supportGrantId,
        supportUserId: supportStaff.id,
        sessionIdHash: hashSessionId(claims.sid),
      });
      // Entry is read-only on the grant; the only write is the spent approval.
      const grant = await prisma.supportAccessGrant.findUniqueOrThrow({ where: { id: supportGrantId } });
      expect(grant).toMatchObject({ status: "ACTIVE", revokedAtUtc: null });
      const spent = await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
      // consumeApprovedChallenge's atomic APPROVED -> CANCELLED claim.
      expect(spent.status).toBe("CANCELLED");
      const replay = await call({
        method: "POST",
        url: "/v1/support-access/enter",
        token: supportStaff.token,
        payload: { teamId: supportStaff.teamId, grantId: supportGrantId },
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(replay.statusCode).toBe(401);
    });
  });

  // ===========================================================================
  // Session-destroying personal security actions — LAST
  // ===========================================================================

  describe("session-destroying personal security actions (disposable accounts)", () => {
    const password = "K2-Correct-Horse-9";

    it("POST /v1/identity-security/my-sessions/:id/revoke — ends ONE other device; the current session, a foreign session and an unproven request are refused", async () => {
      const user = await persona("single", { password });
      const current = await session(user);
      const other = await session(user);
      const stranger = await persona("stranger", { password });
      const strangerSession = await session(stranger);
      const proof = { stepUp: { method: "password", currentPassword: password } };
      const revoke = (id: string, body: Json = proof) =>
        call({ method: "POST", url: `/v1/identity-security/my-sessions/${id}/revoke`, token: current.token, payload: body });

      // The list names the current device, so the page can withhold its button.
      const listed = await call({ method: "GET", url: "/v1/identity-security/my-sessions", token: current.token });
      expect(listed.statusCode).toBe(200);
      const sessions = (json(listed) as { sessions: Array<{ id: string; isCurrent: boolean }> }).sessions;
      expect(sessions.find((s) => s.id === current.id)?.isCurrent).toBe(true);
      expect(sessions.find((s) => s.id === other.id)?.isCurrent).toBe(false);

      const unproven = await revoke(other.id, {});
      expect(unproven.statusCode).toBe(401);
      expect((json(unproven).error as Json).code).toBe("STEP_UP_REQUIRED");
      const self = await revoke(current.id);
      expect(self.statusCode).toBe(409);
      expect((json(self).error as Json).code).toBe("current_session_not_revocable");
      const foreign = await revoke(strangerSession.id);
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: { code: "session_not_found" } });
      expect(await signedIn(current.token)).toBe(true);
      expect(await signedIn(strangerSession.token)).toBe(true);
      expect(await prisma.revokedSession.count({ where: { userId: { in: [user.id, stranger.id] } } })).toBe(0);

      // PersonalSecuritySections.tsx — { stepUp: proof }.
      const res = await revoke(other.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ revoked: 1 });
      expect(await signedIn(other.token)).toBe(false);
      expect(await signedIn(current.token)).toBe(true);
      const row = await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: other.id } });
      expect(row).toMatchObject({ revokedByUserId: user.id, revokedReason: "SELF_REVOKE_SINGLE" });
      expect(await prisma.revokedSession.findFirst({ where: { userId: user.id, sessionIdHash: other.hash } })).toMatchObject({
        scope: "SINGLE_SESSION",
        reason: "USER_LOGGED_OUT",
      });
      const audit = await platformAudit("identity_security.self_revoke_session", other.id);
      expect(audit).toMatchObject({ userId: user.id, outcome: "success", workspaceId: null });
    });

    it("POST /v1/identity-security/my-sessions/revoke-others — signs out every OTHER device and keeps this one; a wrong password revokes nothing", async () => {
      const user = await persona("others", { password });
      const current = await session(user);
      const second = await session(user);
      const third = await session(user);
      const url = "/v1/identity-security/my-sessions/revoke-others";

      const wrong = await call({
        method: "POST",
        url,
        token: current.token,
        payload: { stepUp: { method: "password", currentPassword: "not-the-password-1A" } },
      });
      expect(wrong.statusCode).toBe(401);
      expect((json(wrong).error as Json).code).toBe("STEP_UP_INVALID");
      expect(await prisma.authenticatedSession.count({ where: { userId: user.id, revokedAtUtc: null } })).toBe(3);
      expect(await signedIn(second.token)).toBe(true);

      // PersonalSecuritySections.tsx — { stepUp: proof }.
      const res = await call({
        method: "POST",
        url,
        token: current.token,
        payload: { stepUp: { method: "password", currentPassword: password } },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ revoked: 2 });
      expect(await signedIn(current.token)).toBe(true);
      expect(await signedIn(second.token)).toBe(false);
      expect(await signedIn(third.token)).toBe(false);
      const rows = await prisma.authenticatedSession.findMany({ where: { userId: user.id } });
      expect(rows.find((r) => r.id === current.id)?.revokedAtUtc).toBeNull();
      for (const id of [second.id, third.id]) {
        expect(rows.find((r) => r.id === id)).toMatchObject({ revokedReason: "SELF_REVOKE_OTHERS", revokedByUserId: user.id });
      }
      expect(await prisma.revokedSession.count({ where: { userId: user.id, sessionIdHash: current.hash } })).toBe(0);
      const audit = await platformAudit("identity_security.self_revoke_others", user.id);
      expect(audit).toMatchObject({ userId: user.id, outcome: "success" });
      expect(audit.metadata).toMatchObject({ revoked: 2 });
    });

    it("POST /v1/identity-security/password — changes the password and signs out the other devices; a wrong current password changes nothing", async () => {
      const user = await persona("password", { password });
      const current = await session(user);
      const other = await session(user);
      const url = "/v1/identity-security/password";
      const next = "K2-Battery-Staple-42";

      const wrong = await call({
        method: "POST",
        url,
        token: current.token,
        payload: { currentPassword: "not-the-password-1A", newPassword: next, revokeOtherSessions: true },
      });
      expect(wrong.statusCode).toBe(400);
      expect(json(wrong)).toEqual({ error: { code: "current_password_invalid" } });
      const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(verifyPassword(password, unchanged.passwordHash!)).toBe(true);
      expect(await signedIn(other.token)).toBe(true);
      const failure = await platformAudit("identity_security.password_change", user.id);
      expect(failure).toMatchObject({ userId: user.id, outcome: "error" });

      // PersonalSecuritySections.tsx — { currentPassword, newPassword, revokeOtherSessions }.
      const res = await call({
        method: "POST",
        url,
        token: current.token,
        payload: { currentPassword: password, newPassword: next, revokeOtherSessions: true },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ ok: true, revokedOtherSessions: 1 });
      const changed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(verifyPassword(next, changed.passwordHash!)).toBe(true);
      expect(verifyPassword(password, changed.passwordHash!)).toBe(false);
      // The promise the page makes: this device stays, the other one is out.
      expect(await signedIn(current.token)).toBe(true);
      expect(await signedIn(other.token)).toBe(false);
      const rows = await prisma.authenticatedSession.findMany({ where: { userId: user.id } });
      expect(rows.find((r) => r.id === current.id)?.revokedAtUtc).toBeNull();
      expect(rows.find((r) => r.id === other.id)).toMatchObject({ revokedReason: "PASSWORD_CHANGED" });
      const success = await eventually("password_change success audit", () =>
        prisma.adminAuditLog.findFirst({
          where: { action: "identity_security.password_change", resourceId: user.id, outcome: "success" },
        }),
      );
      expect(success).toMatchObject({ userId: user.id });
      expect(success.metadata).toMatchObject({ revokeOtherSessions: true, revokedOtherSessionsCount: 1 });
    });
  });
});
