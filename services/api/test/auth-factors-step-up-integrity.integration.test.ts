/**
 * ROUND 3 — auth-factors. Factor enrolment, factor removal, administrator
 * reach over account-wide MFA, quarantine release, MFA recovery approval,
 * one-time-code and step-up races, delegated-scope self-extension, the
 * same-second revocation boundary and concurrent account-closure requests,
 * proven through the real routes against live PostgreSQL.
 *
 *   PRO-015 (AUTH-09)  adding a factor once one exists needs the account step-up
 *   PRO-021 (AUTH-15)  the contact-factor revoke route touches contact factors
 *                      only, and an ACTIVE one needs the step-up
 *   PRO-022 (AUTH-16)  an administrator cannot wipe the MFA of someone they do
 *                      not outrank
 *   PRO-023 (AUTH-17)  a quarantined session cannot release itself, nor can its
 *                      holder from another session
 *   PRO-026 (AUTH-20)  an approval never overwrites a cancelled recovery request
 *   PRO-027 (AUTH-21)  recovery approval is stepped up and ends the member's
 *                      sessions
 *   PRO-028 (AUTH-22)  the one-time-code attempt limit holds under concurrency
 *   PRO-029 (AUTH-23)  one code is evaluated per step-up challenge under
 *                      concurrency
 *   PRO-032 (AUTH-26)  a delegate cannot rewrite their own scope's expiry
 *   PRO-019 (AUTH-13)  a revocation does not kill a session minted after it in
 *                      the same second
 *   PRO-035 (AUTH-29)  concurrent closure requests leave one open request
 *
 * Disposable local PostgreSQL + Redis only (the harness refuses anything
 * else). One-time codes go to the in-process recording messaging transport;
 * no provider is contacted. Race cases hold a PostgreSQL lock inside the
 * test's own transaction to order two real requests deterministically; no
 * product code is patched.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant, SeededUser } from "./point7/product-fixtures.js";

type Res = { statusCode: number; body: string; json: () => Record<string, unknown> };

describe("Round 3 auth-factors — factors, step-up and recovery integrity (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let recording: typeof import("../src/services/communications/recording-provider.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let revocation: typeof import("../src/services/identity-security/session-revocation.service.js");
  let signJwt: (typeof import("../src/services/jwt.js"))["signJwt"];
  let ceremony: ReturnType<(typeof import("./support/step-up-ceremony.js"))["createStepUpCeremony"]>;
  let deps: FixtureDeps;
  let ipCounter = 1;

  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    token?: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Res> =>
    h.app.inject({
      method,
      url,
      // Distinct client addresses so per-IP throttles never decide a case.
      remoteAddress: `192.0.2.${(ipCounter++ % 250) + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;

  const errorCode = (res: Res): string | undefined =>
    (res.json().error as { code?: string } | undefined)?.code;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function withPassword(userId: string, password: string): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: hashPassword(password) } });
  }

  const lastCodeTo = (phone: string): string | undefined =>
    recording
      .recordedMessages()
      .filter((m) => m.recipientAlias === recording.recipientAliasForPhone(phone) && m.code)
      .at(-1)?.code ?? undefined;

  const randomPhone = () => `+1415555${String(1000 + Math.floor(Math.random() * 8999))}`;

  const tmOf = (teamId: string, userId: string) =>
    prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId, userId } } });

  const waiters = async (): Promise<number> =>
    Number(
      ((await prisma.$queryRawUnsafe(
        `select count(*)::int as n from pg_locks where not granted`,
      )) as Array<{ n: number }>)[0]!.n,
    );

  async function untilWaiters(n: number, ms = 8000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if ((await waiters()) >= n) return true;
      await sleep(25);
    }
    return false;
  }

  /** Hold `lockSql` in the test's own transaction while `during` fires requests. */
  async function withLock<T>(
    lockSql: string,
    params: unknown[],
    during: (release: () => void) => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const tx = prisma.$transaction(
      async (t) => {
        await t.$executeRawUnsafe(lockSql, ...params);
        locked();
        await gate;
      },
      { timeout: 20_000, maxWait: 5_000 },
    );
    await isLocked;
    try {
      return await during(release);
    } finally {
      release();
      await tx.catch(() => null);
    }
  }

  async function org(memberCount = 1): Promise<OrganizationTenant> {
    return fx.seedOrganizationTenant(deps, { memberCount });
  }

  async function makeAdmin(o: OrganizationTenant, m: SeededUser): Promise<void> {
    await prisma.teamMember.updateMany({
      where: { teamId: o.workspaceId, userId: m.userId },
      data: { role: "ADMIN" },
    });
  }

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    recording = await import("../src/services/communications/recording-provider.js");
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    revocation = await import("../src/services/identity-security/session-revocation.service.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject(o as never) as never,
    });
    deps = {
      prisma: prisma as never,
      tag: `af-${Date.now().toString(36)}`,
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
  // PRO-015 — adding a factor
  // ===========================================================================

  describe("PRO-015: adding a factor once one exists needs the account step-up", () => {
    it("authenticator enrolment: refused without proof, refused with a wrong password, allowed with the password", async () => {
      const o = await org(0);
      const owner = o.owner;
      await withPassword(owner.userId, "OwnerPassw0rd!x");
      await ceremony.enroll(owner.userId);
      const before = await prisma.mfaFactor.count({ where: { userId: owner.userId } });

      const bare = await call("POST", "/v1/identity/mfa/enroll/start", owner.token, {});
      expect(bare.statusCode, bare.body).toBe(401);
      expect(errorCode(bare)).toBe("STEP_UP_REQUIRED");
      const wrong = await call("POST", "/v1/identity/mfa/enroll/start", owner.token, {
        stepUp: { method: "password", currentPassword: "not-the-password" },
      });
      expect(wrong.statusCode).toBe(401);
      expect(errorCode(wrong)).toBe("STEP_UP_INVALID");
      // Nothing was created by either refusal: no factor, so no recovery codes.
      expect(await prisma.mfaFactor.count({ where: { userId: owner.userId } })).toBe(before);

      const ok = await call("POST", "/v1/identity/mfa/enroll/start", owner.token, {
        stepUp: { method: "password", currentPassword: "OwnerPassw0rd!x" },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const factorId = ok.json().factorId as string;
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } })).status).toBe("ENROLLING");
    });

    it("an account with no factor enrols its first authenticator without a step-up (control)", async () => {
      const o = await org(0);
      const res = await call("POST", "/v1/identity/mfa/enroll/start", o.owner.token, {});
      expect(res.statusCode, res.body).toBe(200);
    });

    it("phone enrolment: refused without proof (no factor, no code sent), allowed with the authenticator code", async () => {
      const o = await org(0);
      const owner = o.owner;
      await ceremony.enroll(owner.userId);
      const phone = randomPhone();
      const start = (body: Record<string, unknown>) =>
        call("POST", "/v1/identity-security/contact-factors/enroll/start", owner.token, {
          teamId: o.workspaceId,
          channel: "SMS",
          destination: phone,
          ...body,
        });

      const bare = await start({});
      expect(bare.statusCode, bare.body).toBe(401);
      expect(errorCode(bare)).toBe("STEP_UP_REQUIRED");
      expect(await prisma.mfaFactor.count({ where: { userId: owner.userId, kind: "SMS" } })).toBe(0);
      expect(lastCodeTo(phone)).toBeUndefined();

      const ok = await start({ stepUp: { method: "mfa", code: await ceremony.freshCode(owner.userId) } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(lastCodeTo(phone)).toBeDefined();
    });

    it("phone enrolment with no existing factor needs no step-up (control)", async () => {
      const o = await org(0);
      const res = await call("POST", "/v1/identity-security/contact-factors/enroll/start", o.owner.token, {
        teamId: o.workspaceId,
        channel: "SMS",
        destination: randomPhone(),
      });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  // ===========================================================================
  // PRO-021 — the contact-factor revoke route
  // ===========================================================================

  describe("PRO-021: the contact-factor revoke route", () => {
    it("cannot revoke an authenticator app", async () => {
      const o = await org(0);
      await ceremony.enroll(o.owner.userId);
      const totp = await prisma.mfaFactor.findFirstOrThrow({
        where: { userId: o.owner.userId, kind: "TOTP", status: "ACTIVE" },
      });
      const res = await call("POST", `/v1/identity-security/contact-factors/${totp.id}/revoke`, o.owner.token, {});
      expect(res.statusCode).toBe(404);
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: totp.id } })).status).toBe("ACTIVE");
    });

    it("an ACTIVE phone needs the step-up; a pending enrolment is cancelled without one", async () => {
      const o = await org(0);
      const owner = o.owner;
      await withPassword(owner.userId, "RevokePassw0rd!");
      // First phone: enrolled end to end (no other factor yet, so no step-up).
      const phone = randomPhone();
      const st = await call("POST", "/v1/identity-security/contact-factors/enroll/start", owner.token, {
        teamId: o.workspaceId,
        channel: "SMS",
        destination: phone,
      });
      expect(st.statusCode, st.body).toBe(200);
      const factorId = (st.json().factor as { factorId: string }).factorId;
      const verified = await call("POST", "/v1/identity-security/contact-factors/enroll/verify", owner.token, {
        teamId: o.workspaceId,
        factorId,
        verificationAttemptId: st.json().verificationAttemptId,
        code: lastCodeTo(phone),
      });
      expect(verified.statusCode, verified.body).toBe(200);

      const bare = await call("POST", `/v1/identity-security/contact-factors/${factorId}/revoke`, owner.token, {});
      expect(bare.statusCode).toBe(401);
      expect(errorCode(bare)).toBe("STEP_UP_REQUIRED");
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } })).status).toBe("ACTIVE");

      const ok = await call("POST", `/v1/identity-security/contact-factors/${factorId}/revoke`, owner.token, {
        stepUp: { method: "password", currentPassword: "RevokePassw0rd!" },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } })).status).toBe("REVOKED");

      // A pending enrolment (no factor ACTIVE now) is the cancel path.
      const pending = await call("POST", "/v1/identity-security/contact-factors/enroll/start", owner.token, {
        teamId: o.workspaceId,
        channel: "SMS",
        destination: randomPhone(),
      });
      const pendingId = (pending.json().factor as { factorId: string }).factorId;
      const cancel = await call("POST", `/v1/identity-security/contact-factors/${pendingId}/revoke`, owner.token, {});
      expect(cancel.statusCode, cancel.body).toBe(200);
    });
  });

  // ===========================================================================
  // PRO-022 — administrator reach over account-wide MFA
  // ===========================================================================

  describe("PRO-022: an administrator cannot wipe the MFA of someone they do not outrank", () => {
    const reenrol = (o: OrganizationTenant, actor: SeededUser, targetUserId: string, headers: Record<string, string>) =>
      call(
        "POST",
        `/v1/identity/mfa-admin/factors/${o.workspaceId}/${targetUserId}/require-reenrollment`,
        actor.token,
        { reason: "lost device report" },
        headers,
      );

    it("an ADMIN is refused on the OWNER, and the OWNER's factor survives", async () => {
      const o = await org(1);
      const admin = o.members[0]!;
      await makeAdmin(o, admin);
      await ceremony.enroll(o.owner.userId);
      const stepUp = await ceremony.approvedHeader({
        token: admin.token,
        userId: admin.userId,
        teamId: o.workspaceId,
        purpose: "MFA_REENROLLMENT_REQUIRE",
        resourceKind: "user",
        resourceId: o.owner.userId,
      });
      const res = await reenrol(o, admin, o.owner.userId, stepUp);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toEqual({ error: { code: "permission_denied", reason: "rank_insufficient" } });
      expect(await prisma.mfaFactor.count({ where: { userId: o.owner.userId, status: "ACTIVE" } })).toBe(1);
    });

    it("an ADMIN is refused on another ADMIN, single-factor revoke included", async () => {
      const o = await org(2);
      const [admin, peer] = o.members as [SeededUser, SeededUser];
      await makeAdmin(o, admin);
      await makeAdmin(o, peer);
      await ceremony.enroll(peer.userId);
      const factor = await prisma.mfaFactor.findFirstOrThrow({
        where: { userId: peer.userId, status: "ACTIVE" },
      });
      const stepUp = await ceremony.approvedHeader({
        token: admin.token,
        userId: admin.userId,
        teamId: o.workspaceId,
        purpose: "MFA_FACTOR_REVOKE",
        resourceKind: "mfa_factor",
        resourceId: factor.id,
      });
      const res = await call(
        "POST",
        `/v1/identity/mfa-admin/factors/${o.workspaceId}/${peer.userId}/${factor.id}/revoke`,
        admin.token,
        { reason: "lost device report" },
        stepUp,
      );
      expect(res.statusCode, res.body).toBe(403);
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factor.id } })).status).toBe("ACTIVE");
    });

    it("the OWNER requires re-enrolment of a MEMBER (control)", async () => {
      const o = await org(1);
      const member = o.members[0]!;
      await ceremony.enroll(member.userId);
      const stepUp = await ceremony.approvedHeader({
        token: o.owner.token,
        userId: o.owner.userId,
        teamId: o.workspaceId,
        purpose: "MFA_REENROLLMENT_REQUIRE",
        resourceKind: "user",
        resourceId: member.userId,
      });
      const res = await reenrol(o, o.owner, member.userId, stepUp);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().revokedFactorCount).toBe(1);
      expect(await prisma.mfaFactor.count({ where: { userId: member.userId, status: "ACTIVE" } })).toBe(0);
    });
  });

  // ===========================================================================
  // PRO-023 — quarantine release
  // ===========================================================================

  describe("PRO-023: a quarantined session cannot be released by its holder", () => {
    it("refused from the quarantined session and from another session of the same person; another operator releases it", async () => {
      const o = await org(1);
      const admin = o.members[0]!;
      await makeAdmin(o, admin);
      const { hashSessionId } = revocation;
      const sid = (t: string) =>
        (JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString("utf8")) as { sid: string }).sid;
      const adminSession = await prisma.authenticatedSession.findFirstOrThrow({
        where: { userId: admin.userId, sessionIdHash: hashSessionId(sid(admin.token)) },
      });

      const q = await call("POST", `/v1/admin/identity/sessions/${adminSession.id}/quarantine`, o.owner.token, {
        teamId: o.workspaceId,
        reason: "MANUAL_OPERATOR",
      });
      expect(q.statusCode, q.body).toBe(200);

      const fromQuarantined = await call("POST", `/v1/admin/identity/sessions/${adminSession.id}/release`, admin.token, {
        teamId: o.workspaceId,
      });
      expect(fromQuarantined.statusCode, fromQuarantined.body).toBe(403);
      expect(errorCode(fromQuarantined)).toBe("session_quarantined");

      // A second, clean session of the same administrator.
      const second = deps.mintToken(admin.userId, admin.email);
      await fx.registerSessionForToken(deps, admin.userId, second);
      const fromOther = await call("POST", `/v1/admin/identity/sessions/${adminSession.id}/release`, second, {
        teamId: o.workspaceId,
      });
      expect(fromOther.statusCode, fromOther.body).toBe(403);
      expect(errorCode(fromOther)).toBe("self_action_forbidden");
      expect(
        (await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: adminSession.id } })).quarantinedAtUtc,
      ).not.toBeNull();

      const byOwner = await call("POST", `/v1/admin/identity/sessions/${adminSession.id}/release`, o.owner.token, {
        teamId: o.workspaceId,
      });
      expect(byOwner.statusCode, byOwner.body).toBe(204);
      expect(
        (await prisma.authenticatedSession.findUniqueOrThrow({ where: { id: adminSession.id } })).quarantinedAtUtc,
      ).toBeNull();
    });
  });

  // ===========================================================================
  // PRO-026 / PRO-027 — MFA recovery approval
  // ===========================================================================

  describe("PRO-026 / PRO-027: MFA recovery approval", () => {
    async function verifiedRequest(o: OrganizationTenant, m: SeededUser): Promise<string> {
      const c = await call("POST", "/v1/identity/mfa-admin/recovery-requests", m.token, {
        teamId: o.workspaceId,
        reason: "Phone lost on a site visit (round 3)",
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

    async function recoveryFixture() {
      const o = await org(2);
      const [m, a] = o.members as [SeededUser, SeededUser];
      await makeAdmin(o, a);
      await ceremony.enroll(m.userId);
      return { o, m, a };
    }

    const approvalHeader = (o: OrganizationTenant, a: SeededUser, m: SeededUser) =>
      ceremony.approvedHeader({
        token: a.token,
        userId: a.userId,
        teamId: o.workspaceId,
        purpose: "MFA_REENROLLMENT_REQUIRE",
        resourceKind: "user",
        resourceId: m.userId,
      });

    it("PRO-027: approval without a step-up is refused and changes nothing; with one it wipes the factors and ends the member's sessions", async () => {
      const { o, m, a } = await recoveryFixture();
      const id = await verifiedRequest(o, m);

      const bare = await call("POST", `/v1/identity/mfa-admin/recovery-requests/${id}/approve`, a.token, {});
      expect(bare.statusCode, bare.body).toBe(401);
      expect(errorCode(bare)).toBe("STEP_UP_REQUIRED");
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING_ADMIN_REVIEW");
      expect(await prisma.mfaFactor.count({ where: { userId: m.userId, status: "ACTIVE" } })).toBe(1);
      expect((await call("GET", "/v1/auth/me", m.token)).statusCode).toBe(200);

      const ok = await call(
        "POST",
        `/v1/identity/mfa-admin/recovery-requests/${id}/approve`,
        a.token,
        {},
        await approvalHeader(o, a, m),
      );
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().approvedNow).toBe(true);
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
      expect(await prisma.mfaFactor.count({ where: { userId: m.userId, status: "ACTIVE" } })).toBe(0);
      expect((await call("GET", "/v1/auth/me", m.token)).statusCode).toBe(401);
      // The approver's own session is untouched.
      expect((await call("GET", "/v1/auth/me", a.token)).statusCode).toBe(200);
    });

    it("PRO-026: an approval racing the requester's cancel never leaves a CANCELLED request with its factors wiped", async () => {
      const { o, m, a } = await recoveryFixture();
      const id = await verifiedRequest(o, m);
      const header = await approvalHeader(o, a, m);

      const outcome = await withLock(
        'LOCK TABLE "mfa_recovery_request_approvals" IN EXCLUSIVE MODE',
        [],
        async (release) => {
          const approving = call("POST", `/v1/identity/mfa-admin/recovery-requests/${id}/approve`, a.token, {}, header);
          expect(await untilWaiters(1)).toBe(true);
          const cancelling = call("POST", `/v1/identity/mfa/recovery-requests/${id}/cancel`, m.token, {});
          // The cancel now waits for the approval's decision instead of
          // slipping between its read and its write.
          await untilWaiters(2, 3000);
          release();
          const [ap, cn] = await Promise.all([approving, cancelling]);
          return { approve: ap.statusCode, cancel: cn.statusCode };
        },
      );

      const final = await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id } });
      const active = await prisma.mfaFactor.count({ where: { userId: m.userId, status: "ACTIVE" } });
      // Exactly one decision stands, and the factors agree with it.
      expect([outcome.approve, outcome.cancel].filter((s) => s === 200)).toHaveLength(1);
      if (final.status === "APPROVED") {
        expect(outcome.approve).toBe(200);
        expect(active).toBe(0);
      } else {
        expect(final.status).toBe("CANCELLED");
        expect(outcome.cancel).toBe(200);
        expect(active).toBe(1);
      }
    });

    it("PRO-026: an approval after a cancel is refused and the factors survive", async () => {
      const { o, m, a } = await recoveryFixture();
      const id = await verifiedRequest(o, m);
      const header = await approvalHeader(o, a, m);
      expect((await call("POST", `/v1/identity/mfa/recovery-requests/${id}/cancel`, m.token, {})).statusCode).toBe(200);
      const ap = await call("POST", `/v1/identity/mfa-admin/recovery-requests/${id}/approve`, a.token, {}, header);
      expect(ap.statusCode).toBe(400);
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
      expect(await prisma.mfaFactor.count({ where: { userId: m.userId, status: "ACTIVE" } })).toBe(1);
    });
  });

  // ===========================================================================
  // PRO-028 / PRO-029 — one-time code and step-up races
  // ===========================================================================

  describe("PRO-028 / PRO-029: code limits hold under concurrency", () => {
    it("PRO-028: eight concurrent wrong codes spend the attempt; the right code is then refused", async () => {
      const o = await org(0);
      const owner = o.owner;
      const phone = randomPhone();
      const st = await call("POST", "/v1/identity-security/contact-factors/enroll/start", owner.token, {
        teamId: o.workspaceId,
        channel: "SMS",
        destination: phone,
      });
      expect(st.statusCode, st.body).toBe(200);
      const factorId = (st.json().factor as { factorId: string }).factorId;
      const attemptId = st.json().verificationAttemptId as string;
      const right = lastCodeTo(phone)!;
      const wrong = (i: number) => String((Number(right) + 1 + i) % 1_000_000).padStart(6, "0");
      const verify = (code: string) =>
        call("POST", "/v1/identity-security/contact-factors/enroll/verify", owner.token, {
          teamId: o.workspaceId,
          factorId,
          verificationAttemptId: attemptId,
          code,
        });

      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => verify(wrong(i))));
      expect(results.every((r) => r.statusCode === 400)).toBe(true);
      const row = await prisma.verificationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(row.checkAttemptCount).toBeLessThanOrEqual(5);
      expect(row.status).toBe("DENIED");

      const late = await verify(right);
      expect(late.statusCode).toBe(400);
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } })).status).toBe("ENROLLING");
    });

    it("PRO-028: a right code within the limit still enrols (control)", async () => {
      const o = await org(0);
      const phone = randomPhone();
      const st = await call("POST", "/v1/identity-security/contact-factors/enroll/start", o.owner.token, {
        teamId: o.workspaceId,
        channel: "SMS",
        destination: phone,
      });
      const factorId = (st.json().factor as { factorId: string }).factorId;
      const verify = (code: string) =>
        call("POST", "/v1/identity-security/contact-factors/enroll/verify", o.owner.token, {
          teamId: o.workspaceId,
          factorId,
          verificationAttemptId: st.json().verificationAttemptId,
          code,
        });
      const right = lastCodeTo(phone)!;
      expect((await verify(String((Number(right) + 1) % 1_000_000).padStart(6, "0"))).statusCode).toBe(400);
      const ok = await verify(right);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } })).status).toBe("ACTIVE");
    });

    it("PRO-029: a wrong code queued ahead of the right one spends the challenge; the right code is never evaluated", async () => {
      const o = await org(1);
      const owner = o.owner;
      await ceremony.enroll(owner.userId);
      const tm = await tmOf(o.workspaceId, o.members[0]!.userId);
      const start = await call("POST", "/v1/identity-security/step-up/start", owner.token, {
        teamId: o.workspaceId,
        purpose: "MEMBER_SUSPEND",
        resourceKind: "team_member",
        resourceId: tm.id,
        channel: "TOTP",
      });
      expect(start.statusCode, start.body).toBe(200);
      const challengeId = (start.json().challenge as { id: string }).id;
      const goodCode = await ceremony.freshCode(owner.userId);
      const badCode = String((Number(goodCode) + 7) % 1_000_000).padStart(6, "0");
      const check = (code: string) =>
        call("POST", "/v1/identity-security/step-up/check", owner.token, {
          teamId: o.workspaceId,
          challengeId,
          code,
        });

      const raced = await withLock(
        "SELECT 1 FROM step_up_challenges WHERE id = $1::uuid FOR UPDATE",
        [challengeId],
        async (release) => {
          const pWrong = check(badCode);
          expect(await untilWaiters(1)).toBe(true);
          const pRight = check(goodCode);
          expect(await untilWaiters(2)).toBe(true);
          release();
          const [w, r] = await Promise.all([pWrong, pRight]);
          return { wrong: w.statusCode, right: r.statusCode };
        },
      );
      expect(raced).toEqual({ wrong: 400, right: 400 });
      expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: challengeId } })).status).toBe("DENIED");

      // The right code was never evaluated, so its time step is unclaimed and
      // it still approves a fresh challenge.
      const again = await call("POST", "/v1/identity-security/step-up/start", owner.token, {
        teamId: o.workspaceId,
        purpose: "MEMBER_SUSPEND",
        resourceKind: "team_member",
        resourceId: tm.id,
        channel: "TOTP",
      });
      const againId = (again.json().challenge as { id: string }).id;
      const ok = await call("POST", "/v1/identity-security/step-up/check", owner.token, {
        teamId: o.workspaceId,
        challengeId: againId,
        code: goodCode,
      });
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });

  // ===========================================================================
  // PRO-032 — delegated scope self-extension
  // ===========================================================================

  describe("PRO-032: a delegate cannot rewrite their own scope", () => {
    it("the holder's PATCH is refused and the expiry stands; the owner's PATCH succeeds", async () => {
      const o = await org(1);
      const d = o.members[0]!;
      const tmD = await tmOf(o.workspaceId, d.userId);
      const grantHeader = await ceremony.approvedHeader({
        token: o.owner.token,
        userId: o.owner.userId,
        teamId: o.workspaceId,
        purpose: "DELEGATED_ADMIN_GRANT",
        resourceKind: "team_member",
        resourceId: tmD.id,
      });
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const grant = await call(
        "POST",
        `/v1/identity/members/${tmD.id}/delegated-admin`,
        o.owner.token,
        { teamId: o.workspaceId, scopeKind: "IDENTITY_ADMIN", expiresAtUtc: expiresAt },
        grantHeader,
      );
      expect(grant.statusCode, grant.body).toBe(200);
      const scopeId = (grant.json().scope as { id: string }).id;

      const selfHeader = await ceremony.approvedHeader({
        token: d.token,
        userId: d.userId,
        teamId: o.workspaceId,
        purpose: "DELEGATED_ADMIN_GRANT",
        resourceKind: "delegated_admin_scope",
        resourceId: scopeId,
      });
      const self = await call(
        "PATCH",
        `/v1/identity/delegated-admin/${scopeId}`,
        d.token,
        { teamId: o.workspaceId, expiresAtUtc: null },
        selfHeader,
      );
      expect(self.statusCode, self.body).toBe(403);
      expect(self.body).toContain("self_action_forbidden");
      expect(
        (await prisma.memberDelegatedAdminScope.findUniqueOrThrow({ where: { id: scopeId } })).expiresAtUtc?.toISOString(),
      ).toBe(expiresAt);

      const ownerHeader = await ceremony.approvedHeader({
        token: o.owner.token,
        userId: o.owner.userId,
        teamId: o.workspaceId,
        purpose: "DELEGATED_ADMIN_GRANT",
        resourceKind: "delegated_admin_scope",
        resourceId: scopeId,
      });
      const byOwner = await call(
        "PATCH",
        `/v1/identity/delegated-admin/${scopeId}`,
        o.owner.token,
        { teamId: o.workspaceId, expiresAtUtc: null },
        ownerHeader,
      );
      expect(byOwner.statusCode, byOwner.body).toBe(200);
      expect((await prisma.memberDelegatedAdminScope.findUniqueOrThrow({ where: { id: scopeId } })).expiresAtUtc).toBeNull();
    });
  });

  // ===========================================================================
  // PRO-019 — the revocation's own second
  // ===========================================================================

  describe("PRO-019: a revocation ends what existed, not what is minted after it", () => {
    it("in one second: the old session dies, a new inventoried session lives, a row-less token minted after stays dead", async () => {
      const o = await org(0);
      const user = o.owner;
      // Start at the top of a second so every step below shares it.
      const s0 = Math.floor(Date.now() / 1000);
      while (Math.floor(Date.now() / 1000) === s0) await sleep(10);
      const second = Math.floor(Date.now() / 1000);

      const before = deps.mintToken(user.userId, user.email);
      await fx.registerSessionForToken(deps, user.userId, before);
      await revocation.revokeAllSessionsForUser({ userId: user.userId, reason: "PASSWORD_CHANGED" });
      const after = deps.mintToken(user.userId, user.email);
      await fx.registerSessionForToken(deps, user.userId, after);
      const rowless = deps.mintToken(user.userId, user.email);
      // The case is only meaningful if all three tokens share the revocation's
      // second; the steps above are a few local writes.
      expect(Math.floor(Date.now() / 1000), "the same-second path must be the one exercised").toBe(second);

      expect((await call("GET", "/v1/auth/me", before)).statusCode).toBe(401);
      expect((await call("GET", "/v1/auth/me", user.token)).statusCode).toBe(401);
      expect((await call("GET", "/v1/auth/me", after)).statusCode).toBe(200);
      expect((await call("GET", "/v1/auth/me", rowless)).statusCode).toBe(401);
    });
  });

  // ===========================================================================
  // PRO-035 — concurrent account-closure requests
  // ===========================================================================

  describe("PRO-035: concurrent closure requests leave one open request", () => {
    it("three concurrent requests: one 201, two 409, one open row", async () => {
      const email = `af-closure-${randomUUID().slice(0, 8)}@test.proovra.local`;
      const user = await prisma.user.create({
        data: { email, provider: "EMAIL", providerUserId: email, passwordHash: hashPassword("ClosureDupPass123"), emailVerifiedAt: new Date() },
        select: { id: true },
      });
      const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
      await prisma.userLegalAcceptance.createMany({
        data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
          userId: user.id,
          policyKey,
          policyVersion: policyVersion as string,
          source: "round3-auth-factors",
        })),
      });
      const token = deps.mintToken(user.id, email);
      await fx.registerSessionForToken(deps, user.id, token);
      const body = { confirmation: "close my account", stepUp: { method: "password", currentPassword: "ClosureDupPass123" } };
      const results = await Promise.all([0, 1, 2].map(() => call("POST", "/v1/identity/account-closure", token, body)));
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses, results.map((r) => r.body).join(" | ")).toEqual([201, 409, 409]);
      for (const r of results.filter((x) => x.statusCode === 409)) {
        expect(errorCode(r)).toBe("closure_request_active");
      }
      expect(
        await prisma.accountClosureRequest.count({ where: { userId: user.id, status: "COOLING_OFF" } }),
      ).toBe(1);
    });
  });
});
