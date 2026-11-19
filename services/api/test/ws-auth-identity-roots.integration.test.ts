/**
 * WS-AUTH (RG-08 / RG-09) — identity, MFA and session-scope roots, through the
 * real routes and services against a disposable PostgreSQL (harness.app.inject).
 *
 *   PRO-A1-01 / PRO-S1-10 / B1-F-006  unknown factor state mints nothing (all fail modes)
 *   PRO-A1-10                          verification links: leftover link, directory row, MFA gate
 *   PRO-A1-05                          second-factor attempts per challenge + account lockout
 *   PRO-A1-04                          a linked Google sign-in keeps the account's address
 *   PRO-A1-08                          reset + revocation commit together
 *   PRO-T1-05 / PRO-A2-06              workspace / SCIM authority loss is scoped (DEC-08)
 *   PRO-A2-05                          admins do not remove a self-serve member's factors
 *   PRO-A2C-01                         recovery decisions use the canonical access evaluation
 *
 * The only stubs are fault switches (factor read, revocation write) and the
 * Google JWKS transport; no provider is contacted.
 */
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";

const faults = vi.hoisted(() => ({ factorRead: false, revocation: false }));

vi.mock("../src/services/security/mfa.service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/security/mfa.service.js")>();
  return {
    ...real,
    readMfaStatus: async (...args: Parameters<typeof real.readMfaStatus>) => {
      if (faults.factorRead) throw new Error("simulated factor read failure");
      return real.readMfaStatus(...args);
    },
  };
});
vi.mock("../src/services/identity-security/session-revocation.service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/identity-security/session-revocation.service.js")>();
  return {
    ...real,
    revokeAllSessionsForUser: async (...args: Parameters<typeof real.revokeAllSessionsForUser>) => {
      if (faults.revocation) throw new Error("simulated revocation write failure");
      return real.revokeAllSessionsForUser(...args);
    },
  };
});

type Json = Record<string, unknown>;
type Res = { statusCode: number; body: string; headers: Record<string, unknown> };

describe("WS-AUTH identity roots (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let auth: typeof import("../src/services/email-password-auth.service.js");
  let jwt: typeof import("../src/services/jwt.js");
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let enrol: typeof import("../src/services/auth/mfa-enrollment-session.js");
  let fx: typeof import("./point7/product-fixtures.js");
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let recovery: typeof import("../src/services/security/mfa-recovery-request.service.js");
  let resetLimits: () => Promise<void>;
  let deps: FixtureDeps;
  const password = "Str0ng-ws-auth-passphrase!";
  const secrets = new Map<string, Buffer>();
  let ip = 1;

  const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
  const GOOGLE_AUD = "ws-auth.apps.googleusercontent.test";
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const KID = `wsauth-${randomUUID().slice(0, 8)}`;

  const call = (method: string, url: string, token: string | null, payload?: unknown): Promise<Res> =>
    h.app.inject({
      method: method as never,
      url,
      remoteAddress: `203.0.113.${(ip++ % 250) + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;
  const post = (url: string, token: string | null, payload: unknown = {}) => call("POST", url, token, payload);
  const json = (r: Res) => JSON.parse(r.body) as Json;
  const sessions = (userId: string) => prisma.authenticatedSession.count({ where: { userId } });
  const allForUser = (userId: string) =>
    prisma.revokedSession.count({ where: { userId, scope: "ALL_FOR_USER" } });

  async function legal(userId: string) {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId,
        policyKey,
        policyVersion: policyVersion as string,
        source: "ws-auth-fixture",
      })),
    });
  }

  /** A verified password account with its personal workspace (ACTIVE OWNER membership). */
  async function passwordAccount(label: string, opts: { verified?: boolean; personal?: boolean } = {}) {
    const email = `wsauth-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const u = await prisma.user.create({
      data: {
        email,
        provider: "EMAIL",
        providerUserId: email,
        passwordHash: await auth.hashPassword(password),
        emailVerifiedAt: opts.verified === false ? null : new Date(),
      },
    });
    await legal(u.id);
    if (opts.personal !== false) await fx.bootstrapPersonalSpace(deps, u.id);
    return { id: u.id, email };
  }

  async function seedTotp(userId: string) {
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    const secret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const now = new Date();
    const row = await prisma.mfaFactor.create({
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
    return row.id;
  }
  const goodCode = (userId: string) =>
    totp.computeTotpCode(secrets.get(userId)!, totp.timeStep(Math.floor(Date.now() / 1000)));
  const wrongCode = (userId: string) => {
    const good = goodCode(userId);
    return good === "000000" ? "111111" : "000000";
  };

  const login = (email: string) => post("/v1/auth/email/login", null, { email, password });

  function googleIdToken(sub: string, email: string, nonce: string): string {
    const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = b({ alg: "RS256", kid: KID, typ: "JWT" });
    const body = b({ iss: "https://accounts.google.com", aud: GOOGLE_AUD, sub, email, email_verified: true, iat: now, exp: now + 600, nonce });
    const s = createSign("RSA-SHA256");
    s.update(`${head}.${body}`);
    s.end();
    return `${head}.${body}.${Buffer.from(s.sign(key.privateKey)).toString("base64url")}`;
  }
  async function google(sub: string, email: string): Promise<Res> {
    const n = await post("/v1/auth/oauth/nonce", null, { provider: "google" });
    expect(n.statusCode, n.body).toBe(200);
    return post("/v1/auth/google", null, { idToken: googleIdToken(sub, email, json(n).nonce as string) });
  }

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = GOOGLE_AUD;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    auth = await import("../src/services/email-password-auth.service.js");
    jwt = await import("../src/services/jwt.js");
    totp = await import("../src/services/security/mfa-totp.js");
    enrol = await import("../src/services/auth/mfa-enrollment-session.js");
    fx = await import("./point7/product-fixtures.js");
    rbac = await import("../src/services/identity/rbac.service.js");
    scim = await import("../src/services/access-control/scim.service.js");
    recovery = await import("../src/services/security/mfa-recovery-request.service.js");
    ({ __resetLoginMfaRateLimiterForTests: resetLimits } = await import("../src/routes/auth.routes.js"));
    deps = {
      prisma: prisma as never,
      tag: `wsauth-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === GOOGLE_JWKS) {
        return new Response(
          JSON.stringify({ keys: [{ ...(key.publicKey.export({ format: "jwk" }) as Json), kid: KID, alg: "RS256", use: "sig" }] }),
          { status: 200 },
        );
      }
      throw new Error(`ws-auth fake transport refuses ${url}`);
    }) as typeof fetch);
  }, 300_000);

  beforeEach(async () => {
    faults.factorRead = false;
    faults.revocation = false;
    delete process.env.MFA_ENFORCEMENT_FAIL_MODE;
    await resetLimits();
  });

  afterAll(async () => {
    faults.factorRead = false;
    faults.revocation = false;
    delete process.env.MFA_ENFORCEMENT_FAIL_MODE;
    delete process.env.GOOGLE_CLIENT_ID;
    vi.unstubAllGlobals();
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // PRO-A1-01 / PRO-S1-10 / B1-F-006
  // ===========================================================================
  describe("PRO-A1-01: an unknown factor state mints nothing", () => {
    for (const mode of ["smart", "open", "closed"] as const) {
      it(`fail mode ${mode}: 503 SECURITY_CONTEXT_UNAVAILABLE, no session, no enrolment token, no challenge`, async () => {
        process.env.MFA_ENFORCEMENT_FAIL_MODE = mode;
        const a = await passwordAccount(`a101-${mode}`);
        await seedTotp(a.id);
        const before = await sessions(a.id);
        const challenges = await prisma.mfaPendingChallenge.count({ where: { userId: a.id } });
        faults.factorRead = true;
        const res = await login(a.email);
        faults.factorRead = false;
        expect(res.statusCode, res.body).toBe(503);
        expect((json(res).error as Json).code).toBe("SECURITY_CONTEXT_UNAVAILABLE");
        expect(json(res).token).toBeUndefined();
        expect(json(res).mfaEnrollmentToken).toBeUndefined();
        expect(String(res.headers["set-cookie"] ?? "")).not.toMatch(/proovra_(session|mfa_enroll)=[^;]+/);
        expect(await sessions(a.id)).toBe(before);
        expect(await prisma.mfaPendingChallenge.count({ where: { userId: a.id } })).toBe(challenges);
        // Control: the factor read answers again — the factor is demanded.
        const ok = await login(a.email);
        expect(ok.statusCode, ok.body).toBe(200);
        expect(json(ok).mfaRequired).toBe(true);
      });
    }

    it("PRO-S1-10: an enrolled account with NO membership (smart mode) is not signed in with the password alone", async () => {
      const a = await passwordAccount("s110", { personal: false });
      await seedTotp(a.id);
      expect(await prisma.teamMember.count({ where: { userId: a.id, status: "ACTIVE" } })).toBe(0);
      const before = await sessions(a.id);
      faults.factorRead = true;
      const res = await login(a.email);
      faults.factorRead = false;
      expect(res.statusCode, res.body).toBe(503);
      expect(json(res).token).toBeUndefined();
      expect(await sessions(a.id)).toBe(before);
    });

    it("an enrolment token for an account that already holds an ACTIVE factor adds nothing and completes nothing", async () => {
      const a = await passwordAccount("a101-enrol");
      const held = await seedTotp(a.id);
      const payload = { sub: a.id, provider: "EMAIL", email: a.email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) };
      const token = enrol.signMfaEnrollmentToken(payload as never, process.env.AUTH_JWT_SECRET!);
      const start = await post("/v1/identity/mfa/enroll/start", token, { label: "Attacker" });
      expect(start.statusCode, start.body).toBe(401);
      expect(await prisma.mfaFactor.count({ where: { userId: a.id } })).toBe(1);

      // A factor the token "enrolled" while another ACTIVE one exists.
      const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
      const sealed = sealSecret(totp.generateTotpSecretBytes());
      const second = await prisma.mfaFactor.create({
        data: {
          userId: a.id, kind: "TOTP", status: "ACTIVE", label: "Second",
          secretCiphertext: Buffer.from(sealed.ciphertext), secretIv: Buffer.from(sealed.iv),
          secretAuthTag: Buffer.from(sealed.authTag), secretKekId: sealed.kekId,
          verifiedAtUtc: new Date(), enrolledAt: new Date(),
        },
      });
      const enrolled = enrol.signMfaEnrollmentToken(payload as never, process.env.AUTH_JWT_SECRET!, second.id);
      const before = await sessions(a.id);
      const complete = await post("/v1/auth/mfa/enrollment/complete", enrolled, {});
      expect(complete.statusCode, complete.body).toBe(409);
      expect(json(complete).token).toBeUndefined();
      expect(await sessions(a.id)).toBe(before);
      expect(held).not.toBe(second.id);
    });

    it("control: an account with NO factor still gets the enrolment flow from its enrolment token", async () => {
      const a = await passwordAccount("a101-first");
      const payload = { sub: a.id, provider: "EMAIL", email: a.email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) };
      const token = enrol.signMfaEnrollmentToken(payload as never, process.env.AUTH_JWT_SECRET!);
      const start = await post("/v1/identity/mfa/enroll/start", token, { label: "Mine" });
      expect(start.statusCode, start.body).toBe(200);
    });
  });

  // ===========================================================================
  // PRO-A1-10
  // ===========================================================================
  describe("PRO-A1-10: email verification", () => {
    it("(c) a leftover live link of an already-verified, MFA-enrolled account signs nobody in", async () => {
      const a = await passwordAccount("a110c", { verified: false });
      const l1 = await auth.createEmailVerificationToken(a.id, { retirePriorTokens: false });
      const l2 = await auth.createEmailVerificationToken(a.id, { retirePriorTokens: false });
      const first = await post("/v1/auth/email/verify", null, { token: l2.rawToken, password });
      expect(first.statusCode, first.body).toBe(200);
      await seedTotp(a.id);
      const before = await sessions(a.id);
      const leftover = await post("/v1/auth/email/verify", null, { token: l1.rawToken });
      expect(leftover.statusCode, leftover.body).toBe(400);
      expect(json(leftover).token).toBeUndefined();
      expect(await sessions(a.id)).toBe(before);
      // The first verification retired every other link.
      expect(await prisma.emailVerificationToken.count({ where: { userId: a.id, usedAt: null } })).toBe(0);
    });

    it("(b) an unproven directory-created row is neither sent a link nor activated by the mailbox holder", async () => {
      const email = `wsauth-dir-${randomUUID().slice(0, 8)}@test.proovra.local`;
      const row = await prisma.user.create({
        data: { email, provider: "EMAIL", providerUserId: `scim-${randomUUID()}:dir-subject`, emailVerifiedAt: null },
      });
      const resend = await post("/v1/auth/email/resend-verification", null, { email });
      expect(resend.statusCode).toBe(200);
      expect(await prisma.emailVerificationToken.count({ where: { userId: row.id } })).toBe(0);
      const link = await auth.createEmailVerificationToken(row.id);
      const res = await post("/v1/auth/email/verify", null, { token: link.rawToken });
      expect(res.statusCode, res.body).toBe(400);
      expect(json(res).token).toBeUndefined();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: row.id } })).emailVerifiedAt).toBeNull();
      expect(await sessions(row.id)).toBe(0);
    });

    it("(a) a first verification of an account holding a factor is answered with the challenge, not a session", async () => {
      const a = await passwordAccount("a110a", { verified: false });
      await seedTotp(a.id);
      const link = await auth.createEmailVerificationToken(a.id);
      const res = await post("/v1/auth/email/verify", null, { token: link.rawToken, password });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).mfaRequired).toBe(true);
      expect(json(res).token).toBeUndefined();
      expect(await sessions(a.id)).toBe(0);
    });

    it("control: a self-registered account verifies and signs in", async () => {
      const a = await passwordAccount("a110ok", { verified: false });
      const link = await auth.createEmailVerificationToken(a.id);
      const res = await post("/v1/auth/email/verify", null, { token: link.rawToken, password });
      expect(res.statusCode, res.body).toBe(200);
      expect(typeof json(res).token).toBe("string");
    });
  });

  // ===========================================================================
  // PRO-A1-05
  // ===========================================================================
  describe("PRO-A1-05: second-factor guessing is bounded", () => {
    const verify = (pending: string, code: string) => post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, code });

    it("a typo then the right code still signs in", async () => {
      const a = await passwordAccount("a105ok");
      await seedTotp(a.id);
      const pending = json(await login(a.email)).mfaPendingToken as string;
      expect((await verify(pending, wrongCode(a.id))).statusCode).toBe(401);
      const ok = await verify(pending, goodCode(a.id));
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("the 5th wrong code ends the challenge; 10 failures lock new challenges with Retry-After", async () => {
      const a = await passwordAccount("a105lock");
      await seedTotp(a.id);
      for (let round = 0; round < 2; round += 1) {
        await resetLimits();
        const pending = json(await login(a.email)).mfaPendingToken as string;
        for (let i = 0; i < 5; i += 1) {
          const r = await verify(pending, wrongCode(a.id));
          expect(r.statusCode, r.body).toBe(401);
          expect(json(r).message).toBe("mfa_invalid");
        }
        await resetLimits();
        // The right code no longer completes this challenge.
        const ended = await verify(pending, goodCode(a.id));
        expect(ended.statusCode, ended.body).toBe(401);
        expect(json(ended).message).toBe("mfa_challenge_expired");
        expect(json(ended).token).toBeUndefined();
      }
      const locked = await login(a.email);
      expect(locked.statusCode, locked.body).toBe(429);
      expect((json(locked).error as Json).code).toBe("MFA_TEMPORARILY_LOCKED");
      expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
      expect(json(locked).mfaPendingToken).toBeUndefined();
    });
  });

  // ===========================================================================
  // PRO-A1-04
  // ===========================================================================
  describe("PRO-A1-04: a linked provider never rewrites the account address", () => {
    it("a password account with a linked Google identity keeps its address and stamp after Google sign-in", async () => {
      const a = await passwordAccount("a104");
      const sub = `wsauth-g-${randomUUID()}`;
      const providerEmail = `wsauth-other-${randomUUID().slice(0, 8)}@test.proovra.local`;
      await prisma.userIdentityLink.create({
        data: { userId: a.id, provider: "GOOGLE", providerSubjectId: sub, normalizedEmail: providerEmail, providerEmailVerified: true },
      });
      const before = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
      const res = await google(sub, providerEmail);
      expect(res.statusCode, res.body).toBe(200);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
      expect(after.email).toBe(a.email);
      expect(after.emailVerifiedAt?.getTime()).toBe(before.emailVerifiedAt?.getTime());
      expect(after.providerUserId).toBe(a.email);
    });

    it("control: a Google-created account follows its provider's new address", async () => {
      const sub = `wsauth-gc-${randomUUID()}`;
      const e1 = `wsauth-gc1-${randomUUID().slice(0, 8)}@test.proovra.local`;
      const e2 = `wsauth-gc2-${randomUUID().slice(0, 8)}@test.proovra.local`;
      const first = await google(sub, e1);
      expect(first.statusCode, first.body).toBe(200);
      const second = await google(sub, e2);
      expect(second.statusCode, second.body).toBe(200);
      const row = await prisma.user.findFirstOrThrow({ where: { provider: "GOOGLE", providerUserId: sub } });
      expect(row.email).toBe(e2);
    });
  });

  // ===========================================================================
  // PRO-A1-08
  // ===========================================================================
  describe("PRO-A1-08: a reset and its revocation commit together", () => {
    it("when the revocation cannot be written the password is unchanged and the link still works", async () => {
      const a = await passwordAccount("a108");
      const t = await fx.registerSessionForToken(deps, a.id, deps.mintToken(a.id, a.email)).then(() => null);
      void t;
      const issued = await auth.createPasswordResetTokenForEmail(a.email);
      expect(issued).not.toBeNull();
      const newPassword = "Brand-new-Passphrase-42!";
      faults.revocation = true;
      const failed = await post("/v1/auth/password-reset/confirm", null, { token: issued!.rawToken, newPassword });
      faults.revocation = false;
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      // The old password still signs in: nothing was half-applied.
      expect((await login(a.email)).statusCode).toBe(200);
      expect(await allForUser(a.id)).toBe(0);
      const ok = await post("/v1/auth/password-reset/confirm", null, { token: issued!.rawToken, newPassword });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await allForUser(a.id)).toBe(1);
    });
  });

  // ===========================================================================
  // PRO-T1-05 / PRO-A2-06 (DEC-08)
  // ===========================================================================
  describe("PRO-T1-05 / PRO-A2-06: workspace authority loss is scoped", () => {
    it("removing a self-serve member ends their access there but not their own sessions; a managed identity loses every session", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 2 });
      const [selfServe, managed] = o.members as [typeof o.members[0], typeof o.members[0]];
      await prisma.user.update({
        where: { id: managed.userId },
        data: { providerUserId: `scim-${o.organizationId}:managed-${randomUUID().slice(0, 8)}` },
      });
      const idOf = async (userId: string) =>
        (await prisma.teamMember.findFirstOrThrow({ where: { teamId: o.workspaceId, userId } })).id;

      await rbac.revokeMember({ teamId: o.workspaceId, teamMemberId: await idOf(selfServe.userId), actorUserId: o.owner.userId });
      expect(await allForUser(selfServe.userId)).toBe(0);
      const me = await call("GET", "/v1/auth/me", selfServe.token);
      expect(me.statusCode, me.body).toBe(200);

      await rbac.revokeMember({ teamId: o.workspaceId, teamMemberId: await idOf(managed.userId), actorUserId: o.owner.userId });
      expect(await allForUser(managed.userId)).toBe(1);
      expect((await call("GET", "/v1/auth/me", managed.token)).statusCode).toBe(401);
    });

    it("SCIM: the first deprovision of a self-serve linked member suspends without signing them out; a repeat writes nothing; after departure it is 404", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 1 });
      const m = o.members[0]!;
      await prisma.externalIdentityMapping.create({
        data: { teamId: o.workspaceId, organizationId: o.organizationId, userId: m.userId, provider: "GENERIC_SCIM", externalSubjectId: `ext-${randomUUID()}` },
      });
      const ctx = { teamId: o.workspaceId, organizationId: o.organizationId, tokenId: randomUUID(), baseUrl: "https://scim.test" };
      expect(await scim.scimDeactivateUser(ctx as never, m.userId)).toEqual({ ok: true });
      expect((await prisma.teamMember.findFirstOrThrow({ where: { teamId: o.workspaceId, userId: m.userId } })).status).toBe("SUSPENDED");
      expect(await allForUser(m.userId)).toBe(0);
      expect((await call("GET", "/v1/auth/me", m.token)).statusCode).toBe(200);
      const revokedBefore = await prisma.revokedSession.count({ where: { userId: m.userId } });
      expect(await scim.scimDeactivateUser(ctx as never, m.userId)).toEqual({ ok: true });
      expect(await prisma.revokedSession.count({ where: { userId: m.userId } })).toBe(revokedBefore);
      await prisma.teamMember.updateMany({ where: { teamId: o.workspaceId, userId: m.userId }, data: { status: "REVOKED" } });
      expect(await scim.scimDeactivateUser(ctx as never, m.userId)).toEqual({ ok: false });
    });
  });

  // ===========================================================================
  // PRO-A2-05
  // ===========================================================================
  describe("PRO-A2-05: a workspace admin does not remove a self-serve member's account factors", () => {
    it("self-serve member: 403 target_self_serve_account before any step-up; a managed identity proceeds to step-up", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 2 });
      const [selfServe, managed] = o.members as [typeof o.members[0], typeof o.members[0]];
      await seedTotp(selfServe.userId);
      await seedTotp(managed.userId);
      await prisma.user.update({
        where: { id: managed.userId },
        data: { providerUserId: `scim-${o.organizationId}:managed-${randomUUID().slice(0, 8)}` },
      });
      const url = (userId: string) => `/v1/identity/mfa-admin/factors/${o.workspaceId}/${userId}/require-reenrollment`;
      const refused = await post(url(selfServe.userId), o.owner.token, { reason: "Suspected compromise of this device" });
      expect(refused.statusCode, refused.body).toBe(403);
      expect((json(refused).error as Json).reason).toBe("target_self_serve_account");
      expect(await prisma.mfaFactor.count({ where: { userId: selfServe.userId, status: "ACTIVE" } })).toBe(1);
      const managedRes = await post(url(managed.userId), o.owner.token, { reason: "Suspected compromise of this device" });
      expect(managedRes.statusCode, managedRes.body).toBe(401);
      expect((json(managedRes).error as Json).code).toBe("STEP_UP_REQUIRED");
    });
  });

  // ===========================================================================
  // PRO-A2C-01
  // ===========================================================================
  describe("PRO-A2C-01: recovery decisions use the canonical access evaluation", () => {
    it("an OWNER/ADMIN whose access window expired cannot approve or reject; in-window can", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 2 });
      const [admin, requester] = o.members as [typeof o.members[0], typeof o.members[0]];
      await prisma.teamMember.updateMany({ where: { teamId: o.workspaceId, userId: admin.userId }, data: { role: "ADMIN" } });
      const req = await prisma.mfaRecoveryRequest.create({
        data: {
          userId: requester.userId, teamId: o.workspaceId, status: "PENDING_ADMIN_REVIEW",
          reason: "Lost my phone", emailVerifiedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await prisma.teamMember.updateMany({
        where: { teamId: o.workspaceId, userId: admin.userId },
        data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) },
      });
      const expired = await recovery.approveRecoveryRequest({ requestId: req.id, approverUserId: admin.userId, preflightOnly: true });
      expect(expired).toMatchObject({ ok: false, reason: "approver_not_admin" });
      const rejectExpired = await recovery.rejectRecoveryRequest({ requestId: req.id, approverUserId: admin.userId, reason: "no" } as never);
      expect(rejectExpired).toMatchObject({ ok: false, reason: "approver_not_admin" });
      await prisma.teamMember.updateMany({ where: { teamId: o.workspaceId, userId: admin.userId }, data: { accessExpiresAtUtc: null } });
      const live = await recovery.approveRecoveryRequest({ requestId: req.id, approverUserId: admin.userId, preflightOnly: true });
      expect(live).toMatchObject({ ok: true });
    });
  });
});
