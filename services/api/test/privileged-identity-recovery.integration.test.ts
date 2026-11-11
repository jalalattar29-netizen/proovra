/**
 * Privileged identity — who may remove whose second factor, proven through the
 * real routes against live PostgreSQL.
 *
 *   AUD-0026  an administrator cannot use the admin factor routes on their OWN
 *             account (the weaker way round the passkey-removal ladder)
 *   AUD-0038  recovery approval needs the same strict rank as removing factors
 *             directly: an ADMIN cannot approve the OWNER's or a peer ADMIN's
 *             recovery
 *   AUD-0039  a workspace administrator cannot strip the factors of an account
 *             that holds PLATFORM authority (dual membership); the platform
 *             recovers it instead — another MFA-verified platform administrator,
 *             stepped up, in the platform audit trail — and the recovered
 *             operator signs in again, enrols, and is back at work (platform-only
 *             account), not locked out
 *
 * Disposable local PostgreSQL + Redis only (the harness refuses anything else).
 * Real TOTP codes; no product code is patched.
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant, SeededUser } from "./point7/product-fixtures.js";

type Res = { statusCode: number; body: string; json: () => Record<string, unknown> };

function totp(secretBase32: string, atMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.from(bits.slice(0, bits.length - (bits.length % 8)).match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac("sha1", bytes).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

describe("privileged identity — factor removal authority (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let signJwt: (typeof import("../src/services/jwt.js"))["signJwt"];
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let ceremony: ReturnType<(typeof import("./support/step-up-ceremony.js"))["createStepUpCeremony"]>;
  let deps: FixtureDeps;
  let ipCounter = 1;
  const password = "Str0ng-platform-recovery-passphrase!";

  const call = (
    method: "GET" | "POST",
    url: string,
    token?: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Res> =>
    h.app.inject({
      method,
      url,
      remoteAddress: `198.51.100.${(ipCounter++ % 250) + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;

  const activeFactors = (userId: string) => prisma.mfaFactor.count({ where: { userId, status: "ACTIVE" } });

  /** A session that verified a second factor (`mfaAt`), as platform authority needs. */
  const mfaSession = (u: SeededUser) =>
    signJwt(
      {
        sub: u.userId,
        provider: "EMAIL",
        email: u.email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
        mfaAt: Math.floor(Date.now() / 1000),
      } as never,
      process.env.AUTH_JWT_SECRET!,
      3600,
    );

  async function org(memberCount: number): Promise<OrganizationTenant> {
    return fx.seedOrganizationTenant(deps, { memberCount });
  }

  async function setRole(o: OrganizationTenant, m: SeededUser, role: "ADMIN" | "MEMBER"): Promise<void> {
    await prisma.teamMember.updateMany({ where: { teamId: o.workspaceId, userId: m.userId }, data: { role } });
  }

  async function verifiedRequest(o: OrganizationTenant, m: SeededUser): Promise<string> {
    const c = await call("POST", "/v1/identity/mfa-admin/recovery-requests", m.token, {
      teamId: o.workspaceId,
      reason: "Authenticator lost with a phone (privileged identity)",
    });
    expect(c.statusCode, c.body).toBe(200);
    const id = (c.json().request as { id: string }).id;
    const token = randomBytes(32).toString("hex");
    await prisma.mfaRecoveryRequest.update({
      where: { id },
      data: { emailVerificationTokenHash: createHash("sha256").update(token).digest("hex") },
    });
    const v = await call("POST", `/v1/identity/mfa/recovery-requests/${id}/verify-email`, undefined, { token });
    expect(v.statusCode, v.body).toBe(200);
    return id;
  }

  /** A platform administrator with an operator workspace of their own (step-up challenges are team-bound). */
  async function platformOperator() {
    const o = await org(0);
    await prisma.user.update({ where: { id: o.owner.userId }, data: { platformRole: "admin" } });
    const token = mfaSession(o.owner);
    await fx.registerSessionForToken(deps, o.owner.userId, token);
    return { user: o.owner, teamId: o.workspaceId, token };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({ prisma: prisma as never, inject: (o) => h.app.inject(o as never) as never });
    deps = {
      prisma: prisma as never,
      tag: `pir-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  // ===========================================================================
  // AUD-0026 — no self-target on the admin factor routes
  // ===========================================================================
  describe("AUD-0026: an administrator cannot target their own account on the admin factor routes", () => {
    it("the OWNER's own single-factor revoke and own re-enrolment are refused and the factor survives", async () => {
      const o = await org(0);
      await ceremony.enroll(o.owner.userId);
      const factor = await prisma.mfaFactor.findFirstOrThrow({ where: { userId: o.owner.userId, status: "ACTIVE" } });
      const revoke = await call(
        "POST",
        `/v1/identity/mfa-admin/factors/${o.workspaceId}/${o.owner.userId}/${factor.id}/revoke`,
        o.owner.token,
        { reason: "self via the admin route" },
      );
      expect(revoke.statusCode, revoke.body).toBe(403);
      expect((revoke.json().error as { reason?: string }).reason).toBe("self_target_forbidden");
      const reenrol = await call(
        "POST",
        `/v1/identity/mfa-admin/factors/${o.workspaceId}/${o.owner.userId}/require-reenrollment`,
        o.owner.token,
        { reason: "self via the admin route" },
      );
      expect(reenrol.statusCode, reenrol.body).toBe(403);
      expect((reenrol.json().error as { reason?: string }).reason).toBe("self_target_forbidden");
      expect(await activeFactors(o.owner.userId)).toBe(1);
    });

    it("control: the OWNER still revokes a MEMBER's factor with a step-up", async () => {
      const o = await org(1);
      const m = o.members[0]!;
      await ceremony.enroll(m.userId);
      const factor = await prisma.mfaFactor.findFirstOrThrow({ where: { userId: m.userId, status: "ACTIVE" } });
      const header = await ceremony.approvedHeader({
        token: o.owner.token,
        userId: o.owner.userId,
        teamId: o.workspaceId,
        purpose: "MFA_FACTOR_REVOKE",
        resourceKind: "mfa_factor",
        resourceId: factor.id,
      });
      const res = await call(
        "POST",
        `/v1/identity/mfa-admin/factors/${o.workspaceId}/${m.userId}/${factor.id}/revoke`,
        o.owner.token,
        { reason: "lost device report" },
        header,
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(await activeFactors(m.userId)).toBe(0);
    });
  });

  // ===========================================================================
  // AUD-0038 — recovery approval needs strict rank
  // ===========================================================================
  describe("AUD-0038: recovery approval follows the factor-removal rank", () => {
    it("an ADMIN cannot approve the OWNER's recovery; nothing changes", async () => {
      const o = await org(1);
      const admin = o.members[0]!;
      await setRole(o, admin, "ADMIN");
      await ceremony.enroll(o.owner.userId);
      const id = await verifiedRequest(o, o.owner);
      const res = await call("POST", `/v1/identity/mfa-admin/recovery-requests/${id}/approve`, admin.token, {});
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("approver_rank_insufficient");
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING_ADMIN_REVIEW");
      expect(await activeFactors(o.owner.userId)).toBe(1);
      expect(await prisma.mfaRecoveryRequestApproval.count({ where: { requestId: id } })).toBe(0);
    });

    it("an ADMIN cannot approve a peer ADMIN's recovery; nothing changes", async () => {
      const o = await org(2);
      const [admin, peer] = o.members as [SeededUser, SeededUser];
      await setRole(o, admin, "ADMIN");
      await setRole(o, peer, "ADMIN");
      await ceremony.enroll(peer.userId);
      const id = await verifiedRequest(o, peer);
      const res = await call("POST", `/v1/identity/mfa-admin/recovery-requests/${id}/approve`, admin.token, {});
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("approver_rank_insufficient");
      expect(await activeFactors(peer.userId)).toBe(1);
    });

    // AUD-0038 (completed 2026-11-11) — the finding asked for the rank on
    // approve AND reject: an ADMIN who may not approve the OWNER's or a peer
    // ADMIN's recovery may not close it either.
    it("an ADMIN cannot reject the OWNER's or a peer ADMIN's recovery; the request stays open", async () => {
      const o = await org(2);
      const [admin, peer] = o.members as [SeededUser, SeededUser];
      await setRole(o, admin, "ADMIN");
      await setRole(o, peer, "ADMIN");
      await ceremony.enroll(o.owner.userId);
      await ceremony.enroll(peer.userId);
      for (const target of [o.owner, peer]) {
        const id = await verifiedRequest(o, target);
        const res = await call("POST", `/v1/identity/mfa-admin/recovery-requests/${id}/reject`, admin.token, { reason: "not mine to decide" });
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error).toBe("approver_rank_insufficient");
        expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING_ADMIN_REVIEW");
      }
    });

    it("control: the OWNER rejects an ADMIN's recovery and an ADMIN rejects a MEMBER's", async () => {
      const o = await org(2);
      const [admin, member] = o.members as [SeededUser, SeededUser];
      await setRole(o, admin, "ADMIN");
      await setRole(o, member, "MEMBER");
      const adminRequest = await verifiedRequest(o, admin);
      const byOwner = await call("POST", `/v1/identity/mfa-admin/recovery-requests/${adminRequest}/reject`, o.owner.token, {});
      expect(byOwner.statusCode, byOwner.body).toBe(200);
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: adminRequest } })).status).toBe("REJECTED");
      const memberRequest = await verifiedRequest(o, member);
      const byAdmin = await call("POST", `/v1/identity/mfa-admin/recovery-requests/${memberRequest}/reject`, admin.token, {});
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: memberRequest } })).status).toBe("REJECTED");
    });

    it("control: the OWNER approves an ADMIN's recovery; the factors go and the ADMIN's sessions end", async () => {
      const o = await org(1);
      const admin = o.members[0]!;
      await setRole(o, admin, "ADMIN");
      await ceremony.enroll(admin.userId);
      const id = await verifiedRequest(o, admin);
      const header = await ceremony.approvedHeader({
        token: o.owner.token,
        userId: o.owner.userId,
        teamId: o.workspaceId,
        purpose: "MFA_REENROLLMENT_REQUIRE",
        resourceKind: "user",
        resourceId: admin.userId,
      });
      const res = await call("POST", `/v1/identity/mfa-admin/recovery-requests/${id}/approve`, o.owner.token, {}, header);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().approvedNow).toBe(true);
      expect(await activeFactors(admin.userId)).toBe(0);
      expect((await call("GET", "/v1/auth/me", admin.token)).statusCode).toBe(401);
    });
  });

  // ===========================================================================
  // AUD-0039 — platform accounts are recovered by the platform
  // ===========================================================================
  describe("AUD-0039: platform authority accounts are outside customer-controlled recovery", () => {
    it("dual membership: the customer OWNER cannot approve the platform account's recovery, nor strip its factors directly", async () => {
      const o = await org(1);
      const staff = o.members[0]!;
      await prisma.user.update({ where: { id: staff.userId }, data: { platformRole: "admin" } });
      await ceremony.enroll(staff.userId);
      const id = await verifiedRequest(o, staff);

      const approve = await call("POST", `/v1/identity/mfa-admin/recovery-requests/${id}/approve`, o.owner.token, {});
      expect(approve.statusCode, approve.body).toBe(403);
      expect(approve.json().error).toBe("requester_platform_authority");
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING_ADMIN_REVIEW");

      const factor = await prisma.mfaFactor.findFirstOrThrow({ where: { userId: staff.userId, status: "ACTIVE" } });
      const revoke = await call(
        "POST",
        `/v1/identity/mfa-admin/factors/${o.workspaceId}/${staff.userId}/${factor.id}/revoke`,
        o.owner.token,
        { reason: "customer admin on a platform account" },
      );
      expect(revoke.statusCode, revoke.body).toBe(403);
      expect((revoke.json().error as { reason?: string }).reason).toBe("target_platform_authority");
      const reenrol = await call(
        "POST",
        `/v1/identity/mfa-admin/factors/${o.workspaceId}/${staff.userId}/require-reenrollment`,
        o.owner.token,
        { reason: "customer admin on a platform account" },
      );
      expect(reenrol.statusCode, reenrol.body).toBe(403);
      expect((reenrol.json().error as { reason?: string }).reason).toBe("target_platform_authority");
      expect(await activeFactors(staff.userId)).toBe(1);
    });

    it("platform recovery refuses: no step-up, a session without a second factor, self, and a non-platform target", async () => {
      const operator = await platformOperator();
      const target = await platformOperator();
      await ceremony.enroll(target.user.userId);
      const url = (id: string) => `/v1/admin/users/${id}/mfa/platform-recovery`;
      const body = { teamId: operator.teamId, reason: "Operator lost their authenticator device" };

      const noMfa = await call("POST", url(target.user.userId), operator.user.token, body);
      expect(noMfa.statusCode, noMfa.body).toBe(403);
      expect(noMfa.body).toContain("PLATFORM_ADMIN_MFA_REQUIRED");

      const bare = await call("POST", url(target.user.userId), operator.token, body);
      expect(bare.statusCode, bare.body).toBe(401);
      expect((bare.json().error as { code?: string }).code).toBe("STEP_UP_REQUIRED");

      const self = await call("POST", url(operator.user.userId), operator.token, body);
      expect(self.statusCode, self.body).toBe(403);
      expect(self.body).toContain("self_recovery_forbidden");

      const customer = await org(0);
      await ceremony.enroll(customer.owner.userId);
      const header = await ceremony.approvedHeader({
        token: operator.token,
        userId: operator.user.userId,
        teamId: operator.teamId,
        purpose: "MFA_FACTOR_REVOKE",
        resourceKind: "user",
        resourceId: customer.owner.userId,
      });
      const plain = await call("POST", url(customer.owner.userId), operator.token, body, header);
      expect(plain.statusCode, plain.body).toBe(409);
      expect(plain.body).toContain("target_not_platform_authority");
      expect(await activeFactors(customer.owner.userId)).toBe(1);
      expect(await activeFactors(target.user.userId)).toBe(1);
    });

    it("platform-only account: another platform administrator recovers it with a step-up; the operator signs in, enrols and is back at work", async () => {
      const operator = await platformOperator();
      const target = await fx.seedUser(deps, "platform-only");
      await prisma.user.update({
        where: { id: target.userId },
        data: { platformRole: "admin", passwordHash: hashPassword(password), emailVerifiedAt: new Date() },
      });
      // Platform-only: no workspace membership anywhere.
      expect(await prisma.teamMember.count({ where: { userId: target.userId } })).toBe(0);
      await ceremony.enroll(target.userId);
      const oldSession = mfaSession(target);
      await fx.registerSessionForToken(deps, target.userId, oldSession);
      expect((await call("GET", "/v1/auth/me", oldSession)).statusCode).toBe(200);

      const header = await ceremony.approvedHeader({
        token: operator.token,
        userId: operator.user.userId,
        teamId: operator.teamId,
        purpose: "MFA_FACTOR_REVOKE",
        resourceKind: "user",
        resourceId: target.userId,
      });
      const res = await call(
        "POST",
        `/v1/admin/users/${target.userId}/mfa/platform-recovery`,
        operator.token,
        { teamId: operator.teamId, reason: "Operator lost their authenticator device" },
        header,
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ recovered: true, revokedFactors: 1 });
      expect(await activeFactors(target.userId)).toBe(0);
      expect(
        await prisma.mfaRecoveryCode.count({ where: { userId: target.userId, usedAt: null, batchInvalidatedAt: null } }),
      ).toBe(0);
      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: "mfa.platform_recovery.completed", resourceId: target.userId },
        select: { userId: true, outcome: true },
      });
      expect(audit).toMatchObject({ userId: operator.user.userId, outcome: "success" });
      // The sessions that existed when the factors went are over.
      expect((await call("GET", "/v1/auth/me", oldSession)).statusCode).toBe(401);
      expect((await call("GET", "/v1/auth/me", target.token)).statusCode).toBe(401);

      // Not locked out: sign-in sends the operator to guided enrolment (never a
      // password-only session), and enrolment yields a session that reaches the
      // platform console. The sign-in comes after the revocation's second: a
      // token minted IN that second with no session-inventory row cannot be
      // proven newer than the revocation and stays ended (PRO-019), which is
      // the rule, not a lockout.
      const revokedSecond = Math.floor(Date.now() / 1000);
      while (Math.floor(Date.now() / 1000) <= revokedSecond) await new Promise((r) => setTimeout(r, 50));
      const signIn = await call("POST", "/v1/auth/email/login", undefined, { email: target.email, password });
      expect(signIn.statusCode, signIn.body).toBe(403);
      expect(signIn.json()).toMatchObject({
        mfaEnrollmentRequired: true,
        code: "MFA_ENROLLMENT_REQUIRED",
        reason: "platform_authority_requires_mfa",
      });
      const enrolToken = signIn.json().mfaEnrollmentToken as string;
      const start = await call("POST", "/v1/identity/mfa/enroll/start", enrolToken, {});
      expect(start.statusCode, start.body).toBe(200);
      const { factorId, secretBase32 } = start.json() as { factorId: string; secretBase32: string };
      const verified = await call("POST", "/v1/identity/mfa/enroll/verify", enrolToken, { factorId, code: totp(secretBase32) });
      expect(verified.statusCode, verified.body).toBe(200);
      const done = await call("POST", "/v1/auth/mfa/enrollment/complete", verified.json().mfaEnrollmentToken as string, {});
      expect(done.statusCode, done.body).toBe(200);
      const session = done.json().token as string;
      const platformConsole = await call("GET", "/v1/admin/users?pageSize=1", session);
      expect(platformConsole.statusCode, platformConsole.body).toBe(200);
    });
  });
});
