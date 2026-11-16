/**
 * B1-F-002 / B1-F-006 — second-factor recovery for a personal-only account, and
 * the login MFA gate failing closed.
 *
 * B1-F-002: a Free user whose only workspace is their personal one could file
 * an MFA recovery request that nobody could ever approve (the approval refuses
 * the requester, and a personal workspace has no one else). The request is now
 * refused before any row exists. What such a person CAN use is proven here
 * through the real routes: the factor they enrolled, and single-use recovery
 * codes — which a phone- or passkey-only account receives only by generating
 * them (account step-up), and which are single-use, bound to their account,
 * claimed atomically, never burnt by a replayed sign-in, and recorded on the
 * person's own security timeline.
 *
 * B1-F-006: when the enforcement resolver throws, sign-in used to issue a
 * password-only session. It now answers 503 SECURITY_CONTEXT_UNAVAILABLE and
 * issues nothing.
 *
 * Real routes against live PostgreSQL; one-time codes go to the in-process
 * recording messaging transport (no provider is contacted). The only stub is
 * the resolver fault in the B1-F-006 block.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, SeededUser } from "./point7/product-fixtures.js";

const gateFault = vi.hoisted(() => ({ active: false }));
vi.mock("../src/services/security/login-mfa-enforcement.service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/security/login-mfa-enforcement.service.js")>();
  return {
    ...real,
    resolveLoginMfaEnforcement: async (...args: Parameters<typeof real.resolveLoginMfaEnforcement>) => {
      if (gateFault.active) throw new Error("simulated enforcement resolver failure");
      return real.resolveLoginMfaEnforcement(...args);
    },
  };
});

type Res = { statusCode: number; body: string; headers: Record<string, unknown> };

describe("B1-F-002 / B1-F-006 — personal-account MFA recovery and the fail-closed login gate (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let recording: typeof import("../src/services/communications/recording-provider.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let resetLimits: () => Promise<void>;
  let computeLookupHash: (typeof import("../src/services/security/mfa-recovery.js"))["computeLookupHash"];
  let deps: FixtureDeps;
  const password = "Str0ng-personal-recovery-passphrase!";
  let ip = 1;

  const call = (method: "GET" | "POST", url: string, token: string | null, payload?: unknown): Promise<Res> =>
    h.app.inject({
      method,
      url,
      remoteAddress: `203.0.113.${(ip++ % 250) + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;
  const post = (url: string, token: string | null, payload: unknown = {}) => call("POST", url, token, payload);
  const json = (r: Res) => JSON.parse(r.body) as Record<string, unknown>;

  type Account = { user: SeededUser; teamId: string; phoneAlias: string | null };

  /** A Free personal account (personal workspace only) with a password. */
  async function personalAccount(): Promise<Account> {
    const t = await fx.seedPersonalTenant(deps, "FREE");
    await prisma.user.update({
      where: { id: t.owner.userId },
      data: { passwordHash: await hashPassword(password), emailVerifiedAt: new Date() },
    });
    return { user: t.owner, teamId: t.personalTeamId, phoneAlias: null };
  }

  /** The same, with a phone enrolled through the real routes as its ONLY factor. */
  async function personalPhoneAccount(): Promise<Account> {
    const a = await personalAccount();
    const phone = `+1415555${String(1000 + Math.floor(Math.random() * 8999))}`;
    const st = await post("/v1/identity-security/contact-factors/enroll/start", a.user.token, {
      teamId: a.teamId,
      channel: "SMS",
      destination: phone,
    });
    expect(st.statusCode, st.body).toBe(200);
    const alias = recording.recipientAliasForPhone(phone);
    const ok = await post("/v1/identity-security/contact-factors/enroll/verify", a.user.token, {
      teamId: a.teamId,
      factorId: (json(st).factor as { factorId: string }).factorId,
      verificationAttemptId: json(st).verificationAttemptId,
      code: lastCodeTo(alias),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await prisma.mfaFactor.count({ where: { userId: a.user.userId, status: "ACTIVE" } })).toBe(1);
    expect(await prisma.mfaFactor.count({ where: { userId: a.user.userId, kind: "TOTP" } })).toBe(0);
    return { ...a, phoneAlias: alias };
  }

  const lastCodeTo = (alias: string) =>
    recording.recordedMessages().filter((m) => m.recipientAlias === alias && m.code).at(-1)?.code;

  /** Password sign-in; asserts a second factor is demanded and no session is handed out. */
  async function pendingFor(a: Account): Promise<string> {
    const res = await post("/v1/auth/email/login", null, { email: a.user.email, password });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toMatchObject({ mfaRequired: true });
    expect(json(res).token).toBeUndefined();
    return json(res).mfaPendingToken as string;
  }

  /** Generate recovery codes through the real route and its account step-up. */
  async function generateCodes(a: Account): Promise<string[]> {
    const res = await post("/v1/identity/mfa/recovery-codes/regenerate", a.user.token, {
      stepUp: { method: "password", currentPassword: password },
    });
    expect(res.statusCode, res.body).toBe(200);
    const codes = json(res).recoveryCodes as string[];
    expect(codes.length).toBeGreaterThanOrEqual(8);
    return codes;
  }

  const sessions = (userId: string) => prisma.authenticatedSession.count({ where: { userId } });
  const codeUsed = async (userId: string, code: string) => {
    const row = await prisma.mfaRecoveryCode.findFirstOrThrow({ where: { userId, codeLookupHash: computeLookupHash(code) } });
    return row.usedAt !== null;
  };

  /** The person's own "Account & security activity" timeline. */
  async function timelineHas(a: Account, action: string): Promise<Record<string, unknown> | null> {
    for (let i = 0; i < 40; i += 1) {
      const res = await call("GET", "/v1/identity-security/security-events?limit=50", a.user.token);
      expect(res.statusCode, res.body).toBe(200);
      const hit = (json(res).events as Array<Record<string, unknown>>).find((e) => e.action === action);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    recording = await import("../src/services/communications/recording-provider.js");
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    ({ __resetLoginMfaRateLimiterForTests: resetLimits } = await import("../src/routes/auth.routes.js"));
    ({ computeLookupHash } = await import("../src/services/security/mfa-recovery.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `b1f-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 180_000);

  beforeEach(async () => {
    gateFault.active = false;
    await resetLimits();
  });

  afterAll(async () => {
    gateFault.active = false;
    await h?.cleanup();
  });

  // ===========================================================================
  // B1-F-002 — a request nobody can approve is not filed
  // ===========================================================================
  describe("recovery requests need an eligible approver", () => {
    const file = (token: string, teamId: string) =>
      post("/v1/identity/mfa-admin/recovery-requests", token, {
        teamId,
        reason: "My phone was replaced and the codes were on it.",
      });

    it("a Free user's personal workspace: refused with no_eligible_approver, and no row exists", async () => {
      const a = await personalAccount();
      const res = await file(a.user.token, a.teamId);
      expect(res.statusCode, res.body).toBe(409);
      expect(json(res).error).toBe("no_eligible_approver");
      expect(json(res).request).toBeUndefined();
      expect(await prisma.mfaRecoveryRequest.count({ where: { userId: a.user.userId } })).toBe(0);
      // Repeating it does not fill a queue either.
      expect((await file(a.user.token, a.teamId)).statusCode).toBe(409);
      expect(await prisma.mfaRecoveryRequest.count({ where: { userId: a.user.userId } })).toBe(0);
    });

    it("control: an Organization member, whom the workspace OWNER may decide, files normally", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 1 });
      const m = o.members[0]!;
      const res = await file(m.token, o.workspaceId);
      expect(res.statusCode, res.body).toBe(200);
      expect(await prisma.mfaRecoveryRequest.count({ where: { userId: m.userId } })).toBe(1);
    });

    it("the workspace OWNER: a peer ORG_OWNER counts only while their workspace access is live (canonical access evaluation)", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 1 });
      const peer = o.members[0]!;
      await prisma.teamMember.updateMany({
        where: { teamId: o.workspaceId, userId: peer.userId },
        data: { role: "ADMIN", accessExpiresAtUtc: new Date(Date.now() - 60_000) },
      });
      await prisma.organizationMembership.updateMany({
        where: { organizationId: o.organizationId, userId: peer.userId },
        data: { role: "ORG_OWNER" },
      });
      // The peer's membership row is ACTIVE, but its access has expired.
      const refused = await file(o.owner.token, o.workspaceId);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(json(refused).error).toBe("no_eligible_approver");
      expect(await prisma.mfaRecoveryRequest.count({ where: { userId: o.owner.userId } })).toBe(0);

      await prisma.teamMember.updateMany({
        where: { teamId: o.workspaceId, userId: peer.userId },
        data: { accessExpiresAtUtc: null },
      });
      const filed = await file(o.owner.token, o.workspaceId);
      expect(filed.statusCode, filed.body).toBe(200);
      expect(await prisma.mfaRecoveryRequest.count({ where: { userId: o.owner.userId } })).toBe(1);
    });
  });

  // ===========================================================================
  // B1-F-002 — what a personal-only account can already use
  // ===========================================================================
  describe("a personal-only account's own recovery proof", () => {
    it("a phone-only account signs in with its phone, holds no recovery codes until it generates them, and the batch is on its timeline", async () => {
      const a = await personalPhoneAccount();
      const pending = await pendingFor(a);
      const before = await post("/v1/auth/mfa/methods", null, { mfaPendingToken: pending });
      expect(before.statusCode, before.body).toBe(200);
      // The gap the finding is about: the phone, and nothing to fall back on.
      expect(json(before).methods).toEqual(["SMS"]);

      const sent = await post("/v1/auth/mfa/send-code", null, { mfaPendingToken: pending });
      expect(sent.statusCode, sent.body).toBe(200);
      const ok = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, contactCode: lastCodeTo(a.phoneAlias!) });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(typeof json(ok).token).toBe("string");

      // Generating codes is an account step-up action: no proof, no codes.
      const unproven = await post("/v1/identity/mfa/recovery-codes/regenerate", a.user.token, {});
      expect(unproven.statusCode, unproven.body).toBe(401);
      expect(await prisma.mfaRecoveryCode.count({ where: { userId: a.user.userId } })).toBe(0);
      await generateCodes(a);
      expect(await timelineHas(a, "identity.mfa_recovery_codes_regenerated")).not.toBeNull();

      const after = await post("/v1/auth/mfa/methods", null, { mfaPendingToken: await pendingFor(a) });
      expect(json(after).methods).toEqual(["SMS", "RECOVERY_CODE"]);
    });

    it("a recovery code signs in once: reuse is refused, a replayed pending token burns nothing, and a session exists only after a valid factor", async () => {
      const a = await personalPhoneAccount();
      const codes = await generateCodes(a);
      const baseline = await sessions(a.user.userId);

      const pending = await pendingFor(a);
      const wrong = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, recoveryCode: "aaaaa-bbbbb" });
      expect(wrong.statusCode).toBe(401);
      expect(json(wrong).token).toBeUndefined();
      expect(await sessions(a.user.userId)).toBe(baseline);

      const ok = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, recoveryCode: codes[0] });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(typeof json(ok).token).toBe("string");
      expect(await sessions(a.user.userId)).toBe(baseline + 1);
      // The person is told, on their own timeline, with what remains.
      const used = await timelineHas(a, "auth.mfa_recovery_code_used");
      expect(used).not.toBeNull();
      expect((used!.metadata as Record<string, unknown>).recoveryCodesRemaining).toBe(codes.length - 1);

      // The spent pending token completes nothing — and does not burn a fresh code.
      const replay = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, recoveryCode: codes[1] });
      expect(replay.statusCode).toBe(401);
      expect(json(replay).token).toBeUndefined();
      expect(await codeUsed(a.user.userId, codes[1]!)).toBe(false);

      // The spent code completes nothing on a new sign-in.
      const reuse = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: await pendingFor(a), recoveryCode: codes[0] });
      expect(reuse.statusCode).toBe(401);
      expect(json(reuse).token).toBeUndefined();
      expect(await sessions(a.user.userId)).toBe(baseline + 1);
    });

    it("one code submitted to two sign-ins at once signs in exactly one of them", async () => {
      const a = await personalPhoneAccount();
      const codes = await generateCodes(a);
      const baseline = await sessions(a.user.userId);
      const [p1, p2] = [await pendingFor(a), await pendingFor(a)];
      const results = await Promise.all([
        post("/v1/auth/mfa/verify", null, { mfaPendingToken: p1, recoveryCode: codes[2] }),
        post("/v1/auth/mfa/verify", null, { mfaPendingToken: p2, recoveryCode: codes[2] }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
      expect(await sessions(a.user.userId)).toBe(baseline + 1);
    });

    it("account A's recovery code cannot complete account B's sign-in, and stays usable by A", async () => {
      const a = await personalPhoneAccount();
      const b = await personalPhoneAccount();
      const aCodes = await generateCodes(a);
      await generateCodes(b);
      const bBaseline = await sessions(b.user.userId);
      const cross = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: await pendingFor(b), recoveryCode: aCodes[0] });
      expect(cross.statusCode).toBe(401);
      expect(json(cross).token).toBeUndefined();
      expect(await sessions(b.user.userId)).toBe(bBaseline);
      expect(await codeUsed(a.user.userId, aCodes[0]!)).toBe(false);
      const own = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: await pendingFor(a), recoveryCode: aCodes[0] });
      expect(own.statusCode, own.body).toBe(200);
    });
  });

  // ===========================================================================
  // B1-F-006 — the login MFA gate fails closed
  // ===========================================================================
  describe("B1-F-006: the enforcement resolver throws", () => {
    it("an account with an enrolled factor gets 503 SECURITY_CONTEXT_UNAVAILABLE — no token, no cookie, no session, no challenge", async () => {
      const a = await personalPhoneAccount();
      const baseline = await sessions(a.user.userId);
      const challenges = await prisma.mfaPendingChallenge.count({ where: { userId: a.user.userId } });
      gateFault.active = true;
      const res = await post("/v1/auth/email/login", null, { email: a.user.email, password });
      gateFault.active = false;
      expect(res.statusCode, res.body).toBe(503);
      expect((json(res).error as { code?: string }).code).toBe("SECURITY_CONTEXT_UNAVAILABLE");
      expect(json(res).token).toBeUndefined();
      expect(json(res).mfaPendingToken).toBeUndefined();
      expect(String(res.headers["set-cookie"] ?? "")).not.toMatch(/proovra_session=[^;]+/);
      expect(await sessions(a.user.userId)).toBe(baseline);
      expect(await prisma.mfaPendingChallenge.count({ where: { userId: a.user.userId } })).toBe(challenges);

      // Control: with the resolver answering again, the factor is demanded.
      await pendingFor(a);
    });

    it("an account with no factor is not signed in on an unknown security context either", async () => {
      const a = await personalAccount();
      const baseline = await sessions(a.user.userId);
      gateFault.active = true;
      const res = await post("/v1/auth/email/login", null, { email: a.user.email, password });
      gateFault.active = false;
      expect(res.statusCode, res.body).toBe(503);
      expect(json(res).token).toBeUndefined();
      expect(await sessions(a.user.userId)).toBe(baseline);
      const control = await post("/v1/auth/email/login", null, { email: a.user.email, password });
      expect(control.statusCode, control.body).toBe(200);
      expect(typeof json(control).token).toBe("string");
    });
  });
});
