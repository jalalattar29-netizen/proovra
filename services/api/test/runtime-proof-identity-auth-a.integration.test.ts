/**
 * BATCH K1 (identity-auth, part A) — runtime proof of the personal sign-in and
 * account-security actions the UI mutation sweep could not drive to success.
 *
 * Every action is proven three ways against a disposable PostgreSQL 16 through
 * `harness.app.inject` only:
 *
 *   1. the authorized SUCCESS branch with the payload the real web consumer
 *      sends, and the durable column the action exists to change, re-read;
 *   2. the audit record the route writes (AdminAuditLog hash chain) or, where
 *      the route writes none, the SecurityEvent it does write;
 *   3. an expected refusal with its bounded status/code and no durable effect.
 *
 * External boundaries stay local:
 *   - Google / Apple ID-token verification fetches the provider JWKS through
 *     the global `fetch`. It is replaced for this file by a FAKE TRANSPORT that
 *     answers exactly the two JWKS URLs with a locally generated RSA key and
 *     refuses everything else. No socket is opened; the outbound guard is
 *     untouched. The code-exchange arm (`{ code }`) is not driven — it needs the
 *     provider's token endpoint.
 *   - Email is the recording provider; tokens are read from the recorded
 *     message's actionable link, never from the database.
 *
 * Audit rows written with `void emitPlatformAudit(...)` (fire-and-forget in the
 * product) are awaited with a bounded poll of the real row, never a sleep.
 *
 * TOTP codes are single-use per 30s step (WCC-NEW-008). Independent proofs in
 * this file reset the factor's step ledger (`lastUsedAt = null`) first, which
 * stands in for the time a real user waits between two unrelated actions.
 */

import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("K1 identity-auth (A) — personal sign-in and account security (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let verifyPassword: (typeof import("../src/services/email-password-auth.service.js"))["verifyPassword"];
  let signJwt: (typeof import("../src/services/jwt.js"))["signJwt"];
  let recorder: typeof import("@proovra/shared-runtime");

  const createdUserIds: string[] = [];
  const secrets = new Map<string, Buffer>();
  const fetchedUrls: string[] = [];

  const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
  const APPLE_JWKS = "https://appleid.apple.com/auth/keys";
  const GOOGLE_AUD = "k1-local-test-client.apps.googleusercontent.test";
  const APPLE_AUD = "local.test.proovra.k1.signin";

  const providerKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const strangerKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const GOOGLE_KID = `k1-google-${randomUUID().slice(0, 8)}`;
  const APPLE_KID = `k1-apple-${randomUUID().slice(0, 8)}`;
  const jwk = (kid: string) => ({
    ...(providerKey.publicKey.export({ format: "jwk" }) as Json),
    kid,
    alg: "RS256",
    use: "sig",
  });

  const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");
  function idToken(key: KeyObject, kid: string, claims: Json): string {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat: now, exp: now + 600, ...claims }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${head}.${body}`);
    signer.end();
    return `${head}.${body}.${b64url(signer.sign(key))}`;
  }

  const call = (opts: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    token?: string;
    payload?: unknown;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;

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

  const auditRow = (action: string, where: Json = {}) =>
    eventually(`audit ${action}`, () =>
      prisma.adminAuditLog.findFirst({
        where: { action, ...where },
        orderBy: { createdAt: "desc" },
      }),
    );

  const securityEvent = (eventType: string, actorUserId: string) =>
    eventually(`security event ${eventType}`, () =>
      prisma.securityEvent.findFirst({
        where: { eventType, details: { path: ["actorUserId"], equals: actorUserId } },
        orderBy: { createdAt: "desc" },
      }),
    );

  function mint(userId: string, email: string | null): string {
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
      },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
  }

  /** A disposable account, created for exactly one proof. */
  async function persona(opts: {
    label: string;
    password?: string;
    verified?: boolean;
    legal?: "current" | "stale";
  }): Promise<{ id: string; email: string; token: string }> {
    const email = `k1-${opts.label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: {
        email,
        firstName: "K1",
        lastName: opts.label,
        provider: "EMAIL",
        providerUserId: email,
        passwordHash: opts.password ? hashPassword(opts.password) : null,
        emailVerifiedAt: opts.verified ? new Date() : null,
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: opts.legal === "stale" ? "2020-01-01" : (policyVersion as string),
        source: "k1-fixture",
      })),
    });
    return { id: user.id, email, token: mint(user.id, email) };
  }

  async function seedTotp(userId: string): Promise<string> {
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
      select: { id: true },
    });
    secrets.set(userId, secret);
    return row.id;
  }

  /** The code the user's authenticator shows now, with the step ledger cleared. */
  async function freshCode(userId: string): Promise<string> {
    await prisma.mfaFactor.updateMany({
      where: { userId, kind: "TOTP", status: "ACTIVE" },
      data: { lastUsedAt: null },
    });
    return totp.computeTotpCode(
      secrets.get(userId)!,
      totp.timeStep(Math.floor(Date.now() / 1000)),
    );
  }

  /** The token a recipient would obtain from the most recent recorded message. */
  function mailedToken(email: string): string | null {
    const alias = recorder.recipientAliasFor(email);
    const inMemory = recorder.recordedEmails().filter((m) => m.recipientAlias === alias);
    const mails = inMemory.length
      ? inMemory
      : recorder.readRecordedEmailFile().filter((m) => m.recipientAlias === alias);
    const last = mails.filter((m) => m.result === "acknowledged" && m.actionableLink).at(-1);
    return last?.actionableLink ? new URL(last.actionableLink).searchParams.get("token") : null;
  }

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = GOOGLE_AUD;
    process.env.APPLE_CLIENT_ID = APPLE_AUD;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    ({ hashPassword, verifyPassword } = await import("../src/services/email-password-auth.service.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    recorder = await import("@proovra/shared-runtime");

    // The fake provider transport: the two JWKS documents, nothing else.
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      fetchedUrls.push(url);
      if (url === GOOGLE_JWKS) {
        return new Response(JSON.stringify({ keys: [jwk(GOOGLE_KID)] }), { status: 200 });
      }
      if (url === APPLE_JWKS) {
        return new Response(JSON.stringify({ keys: [jwk(APPLE_KID)] }), { status: 200 });
      }
      throw new Error(`K1 fake transport refuses ${url}`);
    }) as typeof fetch);
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.APPLE_CLIENT_ID;
    if (prisma && createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  // ===========================================================================
  // Social sign-in (ID-token arm; provider JWKS through the fake transport)
  // ===========================================================================

  describe("POST /v1/auth/google and /v1/auth/apple", () => {
    it("POST /v1/auth/google — a provider-signed ID token creates the account, its link and a session; a token for another audience is refused", async () => {
      const sub = `g-${randomUUID()}`;
      const email = `k1-google-${sub.slice(2, 10)}@test.proovra.local`;
      const res = await call({
        method: "POST",
        url: "/v1/auth/google",
        payload: {
          idToken: idToken(providerKey.privateKey, GOOGLE_KID, {
            iss: "https://accounts.google.com",
            aud: GOOGLE_AUD,
            sub,
            email,
            name: "K1 Google",
          }),
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(fetchedUrls).toContain(GOOGLE_JWKS);
      const body = json(res) as { token: string; user: { id: string } };
      const user = await prisma.user.findUniqueOrThrow({
        where: { provider_providerUserId: { provider: "GOOGLE", providerUserId: sub } },
      });
      createdUserIds.push(user.id);
      expect(body.user.id).toBe(user.id);
      expect(user.email).toBe(email);
      expect(user.emailVerifiedAt).not.toBeNull();
      const link = await prisma.userIdentityLink.findFirstOrThrow({
        where: { provider: "GOOGLE", providerSubjectId: sub },
      });
      expect(link).toMatchObject({ userId: user.id, status: "ACTIVE" });
      expect(await prisma.authenticatedSession.count({ where: { userId: user.id, revokedAtUtc: null } })).toBe(1);
      // The minted session authenticates.
      expect((await call({ method: "GET", url: "/v1/identity/links", token: body.token })).statusCode).toBe(200);
      const audit = await auditRow("auth.google_login", { userId: user.id });
      expect(audit).toMatchObject({ outcome: "success", resourceId: user.id, organizationId: null });

      const foreignSub = `g-${randomUUID()}`;
      const refused = await call({
        method: "POST",
        url: "/v1/auth/google",
        payload: {
          idToken: idToken(providerKey.privateKey, GOOGLE_KID, {
            iss: "https://accounts.google.com",
            aud: "someone-elses-client.apps.googleusercontent.test",
            sub: foreignSub,
          }),
        },
      });
      expect(refused.statusCode).toBe(401);
      expect(json(refused)).toEqual({ message: "invalid_id_token" });
      expect(
        await prisma.user.count({ where: { provider: "GOOGLE", providerUserId: foreignSub } }),
      ).toBe(0);
    });

    it("POST /v1/auth/apple — a provider-signed ID token creates the account and a session; a forged signature is refused", async () => {
      const sub = `a-${randomUUID()}`;
      const email = `k1-apple-${sub.slice(2, 10)}@test.proovra.local`;
      const res = await call({
        method: "POST",
        url: "/v1/auth/apple",
        payload: {
          id_token: idToken(providerKey.privateKey, APPLE_KID, {
            iss: "https://appleid.apple.com",
            aud: APPLE_AUD,
            sub,
            email,
          }),
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(fetchedUrls).toContain(APPLE_JWKS);
      const user = await prisma.user.findUniqueOrThrow({
        where: { provider_providerUserId: { provider: "APPLE", providerUserId: sub } },
      });
      createdUserIds.push(user.id);
      expect((json(res).user as { id: string }).id).toBe(user.id);
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(
        await prisma.userIdentityLink.count({
          where: { provider: "APPLE", providerSubjectId: sub, userId: user.id, status: "ACTIVE" },
        }),
      ).toBe(1);
      expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(1);
      const audit = await auditRow("auth.apple_login", { userId: user.id });
      expect(audit.outcome).toBe("success");

      // Same kid, signed by a key the provider never published.
      const forgedSub = `a-${randomUUID()}`;
      const forged = await call({
        method: "POST",
        url: "/v1/auth/apple",
        payload: {
          idToken: idToken(strangerKey.privateKey, APPLE_KID, {
            iss: "https://appleid.apple.com",
            aud: APPLE_AUD,
            sub: forgedSub,
          }),
        },
      });
      expect(forged.statusCode).toBe(401);
      expect(json(forged)).toEqual({ message: "invalid_id_token" });
      expect(await prisma.user.count({ where: { provider: "APPLE", providerUserId: forgedSub } })).toBe(0);
    });
  });

  // ===========================================================================
  // Email ownership + password reset (tokens read from the recorded mailbox)
  // ===========================================================================

  describe("email verification and password reset", () => {
    it("POST /v1/auth/email/verify — the mailed link verifies the address and signs in; a spent link is refused", async () => {
      const email = `k1-register-${randomUUID().slice(0, 8)}@test.proovra.local`;
      const reg = await call({
        method: "POST",
        url: "/v1/auth/email/register",
        payload: { email, password: "Register-Pass-1234", displayName: "K1 Register" },
      });
      expect(reg.statusCode, reg.body).toBe(201);
      expect(json(reg).verificationSent).toBe(true);
      const user = await prisma.user.findFirstOrThrow({ where: { email } });
      createdUserIds.push(user.id);
      expect(user.emailVerifiedAt).toBeNull();
      const token = mailedToken(email);
      expect(token).toEqual(expect.any(String));

      const res = await call({ method: "POST", url: "/v1/auth/email/verify", payload: { token } });
      expect(res.statusCode, res.body).toBe(200);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.emailVerifiedAt).not.toBeNull();
      const tokenRow = await prisma.emailVerificationToken.findFirstOrThrow({
        where: { tokenHash: createHash("sha256").update(token as string).digest("hex") },
      });
      expect(tokenRow.usedAt).not.toBeNull();
      expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(1);
      const audit = await auditRow("auth.email_verification_confirm", { userId: user.id });
      expect(audit.outcome).toBe("success");

      const replay = await call({ method: "POST", url: "/v1/auth/email/verify", payload: { token } });
      expect(replay.statusCode).toBe(400);
      expect((json(replay).error as Json).code).toBe("INVALID_OR_EXPIRED");
      expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(1);
    });

    it("POST /v1/auth/password-reset/confirm — the mailed token replaces the password once; a replay and a guessed token change nothing", async () => {
      const p = await persona({ label: "reset", password: "Old-Password-1234", verified: true });
      const requested = await call({
        method: "POST",
        url: "/v1/auth/password-reset/request",
        payload: { email: p.email },
      });
      expect(requested.statusCode).toBe(200);
      const token = mailedToken(p.email);
      expect(token).toEqual(expect.any(String));
      // The session the old password opened is live before the reset.
      expect((await call({ method: "GET", url: "/v1/auth/me", token: p.token })).statusCode).toBe(200);

      // D24 — the server holds the same floor as a password change; a weak
      // password is refused and the token stays usable.
      const weak = await call({
        method: "POST",
        url: "/v1/auth/password-reset/confirm",
        payload: { token, newPassword: "short-pw" },
      });
      expect(weak.statusCode).toBe(400);
      expect(json(weak)).toEqual({ message: "weak_new_password" });
      expect((await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: p.id } })).usedAt).toBeNull();

      const res = await call({
        method: "POST",
        url: "/v1/auth/password-reset/confirm",
        payload: { token, newPassword: "New-Password-5678" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ ok: true });
      const after = await prisma.user.findUniqueOrThrow({ where: { id: p.id } });
      expect(verifyPassword("New-Password-5678", after.passwordHash as string)).toBe(true);
      expect(verifyPassword("Old-Password-1234", after.passwordHash as string)).toBe(false);
      const row = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: p.id } });
      expect(row.usedAt).not.toBeNull();
      // D13 — the reset ends every session issued before it.
      expect((await call({ method: "GET", url: "/v1/auth/me", token: p.token })).statusCode).toBe(401);
      const revoked = await prisma.revokedSession.findFirst({
        where: { userId: p.id, scope: "ALL_FOR_USER", reason: "PASSWORD_CHANGED" },
      });
      expect(revoked).not.toBeNull();
      // The route's audit is deliberately actor-less (pre-session); it is
      // the public success row written for this request.
      const audit = await auditRow("auth.password_reset_confirm", {
        outcome: "success",
        createdAt: { gte: row.usedAt as Date },
      });
      expect(audit).toMatchObject({ isPublic: true, userId: null, resourceType: "user_auth" });

      for (const bad of [token, "f".repeat(64)]) {
        const refused = await call({
          method: "POST",
          url: "/v1/auth/password-reset/confirm",
          payload: { token: bad, newPassword: "Attacker-Pass-9999" },
        });
        expect(refused.statusCode).toBe(400);
        expect(json(refused)).toEqual({ message: "invalid_or_expired" });
      }
      const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: p.id } });
      expect(unchanged.passwordHash).toBe(after.passwordHash);
    });
  });

  // ===========================================================================
  // Login-time MFA and the authenticator lifecycle
  // ===========================================================================

  describe("authenticator app lifecycle", () => {
    it("POST /v1/auth/mfa/verify — the pending login completes with a current code; a wrong code and a replayed challenge are refused", async () => {
      const p = await persona({ label: "mfalogin", password: "Mfa-Login-Pass-12", verified: true });
      await seedTotp(p.id);
      const login = async () => {
        const res = await call({
          method: "POST",
          url: "/v1/auth/email/login",
          payload: { email: p.email, password: "Mfa-Login-Pass-12" },
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(json(res).mfaRequired).toBe(true);
        return json(res).mfaPendingToken as string;
      };

      // Refusal first: a wrong code leaves the challenge unconsumed.
      const firstPending = await login();
      const current = await freshCode(p.id);
      const wrong = await call({
        method: "POST",
        url: "/v1/auth/mfa/verify",
        payload: { mfaPendingToken: firstPending, code: current === "000000" ? "111111" : "000000" },
      });
      expect(wrong.statusCode).toBe(401);
      expect(json(wrong)).toEqual({ message: "mfa_invalid" });
      expect(await prisma.authenticatedSession.count({ where: { userId: p.id } })).toBe(0);
      const pendingRow = await prisma.mfaPendingChallenge.findFirstOrThrow({
        where: { userId: p.id },
        orderBy: { createdAt: "desc" },
      });
      expect(pendingRow.consumedAt).toBeNull();

      const pending = await login();
      const res = await call({
        method: "POST",
        url: "/v1/auth/mfa/verify",
        payload: { mfaPendingToken: pending, code: await freshCode(p.id) },
      });
      expect(res.statusCode, res.body).toBe(200);
      const session = json(res).token as string;
      expect((await call({ method: "GET", url: "/v1/identity/mfa/factors", token: session })).statusCode).toBe(200);
      const consumed = await prisma.mfaPendingChallenge.findFirstOrThrow({
        where: { userId: p.id },
        orderBy: { createdAt: "desc" },
      });
      expect(consumed.consumedAt).not.toBeNull();
      expect(await prisma.authenticatedSession.count({ where: { userId: p.id } })).toBe(1);
      const audit = await auditRow("auth.mfa_verify", { userId: p.id, outcome: "success" });
      expect(audit.resourceId).toBe(p.id);

      // The same pending token cannot mint a second session.
      const replay = await call({
        method: "POST",
        url: "/v1/auth/mfa/verify",
        payload: { mfaPendingToken: pending, code: await freshCode(p.id) },
      });
      expect(replay.statusCode).toBe(401);
      expect(json(replay)).toEqual({ message: "mfa_challenge_already_used" });
      expect(await prisma.authenticatedSession.count({ where: { userId: p.id } })).toBe(1);
    });

    it("POST /v1/identity/mfa/enroll/verify — the authenticator's code activates the factor and issues recovery codes; another user's factor is not found", async () => {
      const p = await persona({ label: "enroll" });
      const other = await persona({ label: "enroll-other" });
      const started = await call({
        method: "POST",
        url: "/v1/identity/mfa/enroll/start",
        token: p.token,
        payload: { label: "Phone app" },
      });
      expect(started.statusCode, started.body).toBe(200);
      const { factorId, secretBase32 } = json(started) as { factorId: string; secretBase32: string };
      const code = totp.computeTotpCode(
        totp.decodeBase32(secretBase32),
        totp.timeStep(Math.floor(Date.now() / 1000)),
      );

      const foreign = await call({
        method: "POST",
        url: "/v1/identity/mfa/enroll/verify",
        token: other.token,
        payload: { factorId, code },
      });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: "factor_not_found" });
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } })).status).toBe("ENROLLING");

      const res = await call({
        method: "POST",
        url: "/v1/identity/mfa/enroll/verify",
        token: p.token,
        payload: { factorId, code },
      });
      expect(res.statusCode, res.body).toBe(200);
      const codes = json(res).recoveryCodes as string[];
      expect(codes.length).toBeGreaterThan(0);
      const factor = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
      expect(factor.status).toBe("ACTIVE");
      expect(factor.verifiedAtUtc).not.toBeNull();
      expect(await prisma.mfaRecoveryCode.count({ where: { userId: p.id, usedAt: null } })).toBe(codes.length);
      // Route writes no AdminAuditLog; the SecurityEvent ledger is its record.
      expect(await securityEvent("mfa_enrollment_completed", p.id)).toBeTruthy();
    });

    it("POST /v1/identity/mfa/challenge/verify — a current code and an unused recovery code verify once; the spent recovery code is refused", async () => {
      const p = await persona({ label: "challenge" });
      const factorId = await seedTotp(p.id);
      const res = await call({
        method: "POST",
        url: "/v1/identity/mfa/challenge/verify",
        token: p.token,
        payload: { code: await freshCode(p.id) },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ ok: true, used: "totp", factorId });
      // The accepted step is claimed on the factor (single-use ledger).
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } })).lastUsedAt).not.toBeNull();
      expect(await securityEvent("mfa_verification_succeeded", p.id)).toBeTruthy();

      const { regenerateRecoveryBatch } = await import("../src/services/security/mfa.service.js");
      const { recoveryCodes } = await regenerateRecoveryBatch({ userId: p.id });
      const recoveryCode = recoveryCodes[0] as string;
      const used = await call({
        method: "POST",
        url: "/v1/identity/mfa/challenge/verify",
        token: p.token,
        payload: { recoveryCode },
      });
      expect(used.statusCode, used.body).toBe(200);
      expect(json(used)).toEqual({ ok: true, used: "recovery_code" });
      expect(await prisma.mfaRecoveryCode.count({ where: { userId: p.id, usedAt: { not: null } } })).toBe(1);

      const spent = await call({
        method: "POST",
        url: "/v1/identity/mfa/challenge/verify",
        token: p.token,
        payload: { recoveryCode },
      });
      expect(spent.statusCode).toBe(400);
      expect(json(spent)).toEqual({ error: "already_used" });
      // Another account cannot spend this user's code either.
      const other = await persona({ label: "challenge-other" });
      const stolen = await call({
        method: "POST",
        url: "/v1/identity/mfa/challenge/verify",
        token: other.token,
        payload: { recoveryCode: recoveryCodes[1] },
      });
      expect(stolen.statusCode).toBe(400);
      expect(json(stolen)).toEqual({ error: "wrong_user" });
      expect(await prisma.mfaRecoveryCode.count({ where: { userId: p.id, usedAt: { not: null } } })).toBe(1);
    });

    it("POST /v1/identity/mfa/recovery-codes/regenerate — an authenticator proof replaces the batch; no proof is refused with nothing replaced", async () => {
      const p = await persona({ label: "regen" });
      await seedTotp(p.id);
      const { regenerateRecoveryBatch } = await import("../src/services/security/mfa.service.js");
      await regenerateRecoveryBatch({ userId: p.id });
      const before = await prisma.mfaRecoveryCode.findMany({ where: { userId: p.id }, select: { id: true } });

      const refused = await call({
        method: "POST",
        url: "/v1/identity/mfa/recovery-codes/regenerate",
        token: p.token,
        payload: {},
      });
      expect(refused.statusCode).toBe(401);
      expect((json(refused).error as Json).code).toBe("STEP_UP_REQUIRED");
      expect(await prisma.mfaRecoveryCode.count({ where: { userId: p.id, batchInvalidatedAt: null } })).toBe(before.length);

      const res = await call({
        method: "POST",
        url: "/v1/identity/mfa/recovery-codes/regenerate",
        token: p.token,
        payload: { stepUp: { method: "mfa", code: await freshCode(p.id) } },
      });
      expect(res.statusCode, res.body).toBe(200);
      const codes = json(res).recoveryCodes as string[];
      const old = await prisma.mfaRecoveryCode.findMany({
        where: { id: { in: before.map((r) => r.id) } },
        select: { batchInvalidatedAt: true },
      });
      expect(old.every((r) => r.batchInvalidatedAt !== null)).toBe(true);
      expect(await prisma.mfaRecoveryCode.count({ where: { userId: p.id, batchInvalidatedAt: null } })).toBe(codes.length);
      const approved = await eventually("step_up_approved", () =>
        prisma.securityEvent.findFirst({
          where: {
            eventType: "step_up_approved",
            AND: [
              { details: { path: ["actorUserId"], equals: p.id } },
              { details: { path: ["action"], equals: "mfa_recovery_codes_regenerate" } },
            ],
          },
        }),
      );
      expect(approved).toBeTruthy();
    });

    it("DELETE /v1/identity/mfa/factors/:id — an active factor is revoked with an authenticator proof; a wrong code and another user's id change nothing", async () => {
      const p = await persona({ label: "rmfactor" });
      const factorId = await seedTotp(p.id);
      const other = await persona({ label: "rmfactor-other" });

      const foreign = await call({
        method: "DELETE",
        url: `/v1/identity/mfa/factors/${factorId}`,
        token: other.token,
        payload: {},
      });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: "factor_not_found" });

      const current = await freshCode(p.id);
      const wrong = await call({
        method: "DELETE",
        url: `/v1/identity/mfa/factors/${factorId}`,
        token: p.token,
        payload: { stepUp: { method: "mfa", code: current === "000000" ? "111111" : "000000" } },
      });
      expect(wrong.statusCode).toBe(401);
      expect((json(wrong).error as Json).code).toBe("STEP_UP_INVALID");
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } })).status).toBe("ACTIVE");

      const res = await call({
        method: "DELETE",
        url: `/v1/identity/mfa/factors/${factorId}`,
        token: p.token,
        payload: { stepUp: { method: "mfa", code: await freshCode(p.id) } },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ ok: true });
      const row = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
      expect(row.status).toBe("REVOKED");
      expect(row.revokedAt).not.toBeNull();
      expect(row.revokedReason).toBe("user_revoked");
      expect(await securityEvent("mfa_factor_removed", p.id)).toBeTruthy();
    });
  });

  // ===========================================================================
  // Legal acceptance, login methods, data export
  // ===========================================================================

  describe("account records", () => {
    it("POST /v1/users/legal-acceptance — the outstanding policies are recorded at the required version; an anonymous caller is refused", async () => {
      const p = await persona({ label: "legal", legal: "stale" });
      const status = json(await call({ method: "GET", url: "/v1/users/legal-status", token: p.token })) as {
        missingPolicies: string[];
        requiredVersions: Record<string, string>;
      };
      expect(status.missingPolicies.length).toBeGreaterThan(0);
      const acceptances = status.missingPolicies.map((policyKey) => ({
        policyKey,
        policyVersion: status.requiredVersions[policyKey],
      }));

      const anonymous = await call({
        method: "POST",
        url: "/v1/users/legal-acceptance",
        payload: { source: "settings", acceptances },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(
        await prisma.userLegalAcceptance.count({ where: { userId: p.id, policyVersion: "2020-01-01" } }),
      ).toBe(acceptances.length);

      const res = await call({
        method: "POST",
        url: "/v1/users/legal-acceptance",
        token: p.token,
        payload: { source: "settings", acceptances },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).ok).toBe(true);
      const rows = await prisma.userLegalAcceptance.findMany({ where: { userId: p.id } });
      for (const a of acceptances) {
        expect(rows.find((r) => r.policyKey === a.policyKey)).toMatchObject({
          policyVersion: a.policyVersion,
          source: "settings",
        });
      }
      const after = json(await call({ method: "GET", url: "/v1/users/legal-status", token: p.token }));
      expect(after.ok).toBe(true);
    });

    it("POST /v1/identity/password + DELETE /v1/identity/links/:id — an OAuth account adds a password on a fresh session, then disconnects Google; the refusals change nothing", async () => {
      const sub = `g-${randomUUID()}`;
      const signIn = await call({
        method: "POST",
        url: "/v1/auth/google",
        payload: {
          idToken: idToken(providerKey.privateKey, GOOGLE_KID, {
            iss: "https://accounts.google.com",
            aud: GOOGLE_AUD,
            sub,
            email: `k1-links-${sub.slice(2, 10)}@test.proovra.local`,
          }),
        },
      });
      expect(signIn.statusCode, signIn.body).toBe(200);
      const session = json(signIn).token as string;
      const userId = (json(signIn).user as { id: string }).id;
      createdUserIds.push(userId);
      const link = await prisma.userIdentityLink.findFirstOrThrow({
        where: { userId, provider: "GOOGLE", status: "ACTIVE" },
      });

      // Refusals before any password exists.
      const lastMethod = await call({
        method: "DELETE",
        url: `/v1/identity/links/${link.id}`,
        token: session,
        payload: {},
      });
      expect(lastMethod.statusCode).toBe(409);
      expect((json(lastMethod).error as Json).code).toBe("last_login_method_protected");
      // A token whose session was never recorded is not a recent sign-in.
      const stale = mint(userId, null);
      const staleAdd = await call({
        method: "POST",
        url: "/v1/identity/password",
        token: stale,
        payload: { newPassword: "Linked-Account-Pass-1" },
      });
      expect(staleAdd.statusCode).toBe(401);
      expect(json(staleAdd).error).toMatchObject({ code: "STEP_UP_REQUIRED", methods: ["reauth"] });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash).toBeNull();

      // Success: the OAuth-only account proves a RECENT session (no proof body).
      const added = await call({
        method: "POST",
        url: "/v1/identity/password",
        token: session,
        payload: { newPassword: "Linked-Account-Pass-1" },
      });
      expect(added.statusCode, added.body).toBe(200);
      expect(json(added)).toEqual({ passwordConfigured: true });
      const withPassword = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(verifyPassword("Linked-Account-Pass-1", withPassword.passwordHash as string)).toBe(true);
      const addAudit = await auditRow("identity.password_added", { userId });
      expect(addAudit).toMatchObject({ outcome: "success", resourceId: userId });

      // Another account cannot unlink this link (after passing its own step-up).
      const other = await persona({ label: "links-other", password: "Other-Account-Pass-1" });
      const foreign = await call({
        method: "DELETE",
        url: `/v1/identity/links/${link.id}`,
        token: other.token,
        payload: { stepUp: { method: "password", currentPassword: "Other-Account-Pass-1" } },
      });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: { code: "link_not_found" } });
      // Now a password exists, the owner must prove it.
      const noProof = await call({
        method: "DELETE",
        url: `/v1/identity/links/${link.id}`,
        token: session,
        payload: {},
      });
      expect(noProof.statusCode).toBe(401);
      expect((await prisma.userIdentityLink.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("ACTIVE");

      const unlinked = await call({
        method: "DELETE",
        url: `/v1/identity/links/${link.id}`,
        token: session,
        payload: { stepUp: { method: "password", currentPassword: "Linked-Account-Pass-1" } },
      });
      expect(unlinked.statusCode, unlinked.body).toBe(200);
      expect(json(unlinked)).toEqual({ unlinked: true });
      const revoked = await prisma.userIdentityLink.findUniqueOrThrow({ where: { id: link.id } });
      expect(revoked.status).toBe("REVOKED");
      expect(revoked.revokedAtUtc).not.toBeNull();
      const unlinkAudit = await auditRow("identity.login_method_unlinked", { userId });
      expect(unlinkAudit.metadata).toMatchObject({ provider: "GOOGLE", linkId: link.id });
    });

    it("POST /v1/identity/data-export + /:id/download — a password proof requests, the processor packages, the owner downloads; another account and a missing proof are refused", async () => {
      const p = await persona({ label: "export", password: "Export-Owner-Pass-1" });
      const proof = { method: "password", currentPassword: "Export-Owner-Pass-1" };

      const noProof = await call({ method: "POST", url: "/v1/identity/data-export", token: p.token, payload: {} });
      expect(noProof.statusCode).toBe(401);
      expect((json(noProof).error as Json).code).toBe("STEP_UP_REQUIRED");
      expect(await prisma.accountDataExportRequest.count({ where: { userId: p.id } })).toBe(0);

      const res = await call({
        method: "POST",
        url: "/v1/identity/data-export",
        token: p.token,
        payload: { stepUp: proof },
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = (json(res).request as { id: string }).id;
      expect((await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id } })).status).toBe("REQUESTED");
      const requestedAudit = await auditRow("identity.data_export_requested", { resourceId: id });
      expect(requestedAudit).toMatchObject({ userId: p.id, outcome: "success", workspaceId: null });

      // The real background processor turns the request into a package.
      const { processAccountDataExports } = await import(
        "../src/services/identity/account-data-export.service.js"
      );
      await processAccountDataExports(new Date());
      const ready = await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id } });
      expect(ready.status).toBe("READY");
      expect(ready.downloadCount).toBe(0);

      const other = await persona({ label: "export-other", password: "Export-Other-Pass-1" });
      const foreign = await call({
        method: "POST",
        url: `/v1/identity/data-export/${id}/download`,
        token: other.token,
        payload: { stepUp: { method: "password", currentPassword: "Export-Other-Pass-1" } },
      });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: { code: "export_not_found" } });
      const ownerNoProof = await call({
        method: "POST",
        url: `/v1/identity/data-export/${id}/download`,
        token: p.token,
        payload: {},
      });
      expect(ownerNoProof.statusCode).toBe(401);
      expect((await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id } })).downloadCount).toBe(0);

      const dl = await call({
        method: "POST",
        url: `/v1/identity/data-export/${id}/download`,
        token: p.token,
        payload: { stepUp: proof },
      });
      expect(dl.statusCode, dl.body).toBe(200);
      expect(dl.headers["content-disposition"]).toContain(`proovra-account-export-${id}.json`);
      expect(dl.headers["x-package-sha256"]).toBe(ready.packageSha256);
      expect(createHash("sha256").update(dl.body).digest("hex")).toBe(ready.packageSha256);
      const downloaded = await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id } });
      expect(downloaded.downloadCount).toBe(1);
      expect(downloaded.lastDownloadedAtUtc).not.toBeNull();
      const dlAudit = await auditRow("identity.data_export_downloaded", { resourceId: id });
      expect(dlAudit).toMatchObject({ userId: p.id, outcome: "success" });
    });
  });

  // ===========================================================================
  // LAST — account closure (disposable persona)
  // ===========================================================================

  describe("account closure (disposable persona, last)", () => {
    it("POST /v1/identity/account-closure — the typed phrase and a password proof open the cooling-off window; a wrong phrase and a wrong password record nothing", async () => {
      const p = await persona({ label: "closure", password: "Closure-Owner-Pass-1" });
      const { ensurePersonalWorkspace } = await import(
        "../src/services/platform-context/workspace-bootstrap.service.js"
      );
      await ensurePersonalWorkspace({ userId: p.id });

      const mismatch = await call({
        method: "POST",
        url: "/v1/identity/account-closure",
        token: p.token,
        payload: {
          confirmation: "close account",
          stepUp: { method: "password", currentPassword: "Closure-Owner-Pass-1" },
        },
      });
      expect(mismatch.statusCode).toBe(400);
      expect((json(mismatch).error as Json).code).toBe("confirmation_mismatch");
      const wrongPw = await call({
        method: "POST",
        url: "/v1/identity/account-closure",
        token: p.token,
        payload: {
          confirmation: "close my account",
          stepUp: { method: "password", currentPassword: "not-the-password" },
        },
      });
      expect(wrongPw.statusCode).toBe(401);
      expect((json(wrongPw).error as Json).code).toBe("STEP_UP_INVALID");
      expect(await prisma.accountClosureRequest.count({ where: { userId: p.id } })).toBe(0);

      const res = await call({
        method: "POST",
        url: "/v1/identity/account-closure",
        token: p.token,
        payload: {
          confirmation: "Close My Account",
          reason: "K1 runtime proof",
          stepUp: { method: "password", currentPassword: "Closure-Owner-Pass-1" },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = (json(res).request as { id: string }).id;
      const row = await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ userId: p.id, status: "COOLING_OFF", reason: "K1 runtime proof" });
      expect(row.coolingOffEndsAtUtc!.getTime()).toBeGreaterThan(Date.now());
      const audit = await auditRow("identity.account_closure_requested", { resourceId: id });
      expect(audit).toMatchObject({ userId: p.id, outcome: "success" });

      // The organization owner with members is blocked, and only a BLOCKED
      // record (never a cooling-off request) is written for them.
      const { ownerToken, ownerUserId } = harness.fixtures.teamA;
      await prisma.user.update({
        where: { id: ownerUserId },
        data: { passwordHash: hashPassword("Team-A-Owner-Pass-1") },
      });
      const blocked = await call({
        method: "POST",
        url: "/v1/identity/account-closure",
        token: ownerToken,
        payload: {
          confirmation: "close my account",
          stepUp: { method: "password", currentPassword: "Team-A-Owner-Pass-1" },
        },
      });
      expect(blocked.statusCode).toBe(409);
      expect((json(blocked).error as Json).code).toBe("closure_blocked");
      expect(
        await prisma.accountClosureRequest.count({ where: { userId: ownerUserId, status: "COOLING_OFF" } }),
      ).toBe(0);
    });
  });
});
