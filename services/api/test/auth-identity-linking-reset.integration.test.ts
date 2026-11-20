/**
 * Round 3, batch auth-identity — identity linking, social provenance, password
 * reset and the extension authorization code, through the real routes against a
 * disposable PostgreSQL 16 (`harness.app.inject` only).
 *
 *   PRO-009 (AUTH-03)  re-linking an unlinked Google identity from another account
 *   PRO-010 (AUTH-04)  unlinking Google on a Google-created account; its added password
 *   PRO-008 (AUTH-02)  Google + MFA sessions keep SOCIAL_OAUTH provenance
 *   PRO-004            one reset token, one password, concurrently
 *   PRO-011 (AUTH-05)  a reset does not reopen a closure a legal hold defers
 *   PRO-024 (AUTH-18)  an extension code dies with the session that authorized it
 *
 * Every case carries an authorized control next to the refusal, and reads the
 * durable rows (links, users, revocations, closure request), not only statuses.
 *
 * External boundaries stay local: the Google JWKS is answered by a fake
 * transport with a key generated here; nothing else may be fetched.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";

type Json = Record<string, unknown>;

describe("auth-identity remediation — linking, provenance, reset, extension code (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let auth: typeof import("../src/services/email-password-auth.service.js");
  let jwt: typeof import("../src/services/jwt.js");
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let fx: typeof import("./point7/product-fixtures.js");
  let closure: typeof import("../src/services/identity/account-closure.service.js");
  let holds: typeof import("../src/services/governance/legal-hold.service.js");
  let deps: FixtureDeps;

  const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
  const GOOGLE_AUD = "rem3-auth-identity.apps.googleusercontent.test";
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const KID = `rem3-${randomUUID().slice(0, 8)}`;
  const secrets = new Map<string, Buffer>();
  let ipCounter = 1;
  const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

  function googleIdToken(sub: string, email: string, extra: Json = {}): string {
    const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = b({ alg: "RS256", kid: KID, typ: "JWT" });
    const body = b({
      iss: "https://accounts.google.com",
      aud: GOOGLE_AUD,
      sub,
      email,
      email_verified: true,
      iat: now,
      exp: now + 600,
      ...extra,
    });
    const s = createSign("RSA-SHA256");
    s.update(`${head}.${body}`);
    s.end();
    return `${head}.${body}.${Buffer.from(s.sign(key.privateKey)).toString("base64url")}`;
  }

  /** PRO-034 — a token for an attempt this API started: fetch a nonce first. */
  async function freshToken(sub: string, email: string, extra: Json = {}): Promise<string> {
    const r = await call("POST", "/v1/auth/oauth/nonce", undefined, { provider: "google" });
    expect(r.statusCode, r.body).toBe(200);
    return googleIdToken(sub, email, { nonce: (JSON.parse(r.body) as Json).nonce, ...extra });
  }

  const call = (method: string, url: string, token?: string, payload?: unknown) =>
    harness.app.inject({
      method: method as never,
      url,
      remoteAddress: nextIp(),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });
  const body = (r: { body: string }) => JSON.parse(r.body) as Json;
  const claims = (t: string) =>
    JSON.parse(Buffer.from(t.split(".")[1] ?? "", "base64url").toString("utf8")) as Json;
  const nextSecond = async () => {
    const s0 = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === s0) await new Promise((r) => setTimeout(r, 50));
  };

  async function legal(userId: string) {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId,
        policyKey,
        policyVersion: policyVersion as string,
        source: "rem3-auth-identity",
      })),
    });
  }

  async function emailUser(label: string, password: string) {
    const email = `rem3-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const u = await prisma.user.create({
      data: {
        email,
        provider: "EMAIL",
        providerUserId: email,
        passwordHash: await auth.hashPassword(password),
        emailVerifiedAt: new Date(),
      },
    });
    await legal(u.id);
    return { id: u.id, email };
  }

  async function login(email: string, password: string) {
    const r = await call("POST", "/v1/auth/email/login", undefined, { email, password });
    return { status: r.statusCode, token: r.statusCode === 200 ? (body(r).token as string) : null };
  }

  async function google(sub: string, email: string) {
    const r = await call("POST", "/v1/auth/google", undefined, { idToken: await freshToken(sub, email) });
    return { status: r.statusCode, json: r.statusCode === 200 ? body(r) : null, raw: r };
  }

  async function seedTotp(userId: string) {
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
  async function code(userId: string) {
    await prisma.mfaFactor.updateMany({
      where: { userId, kind: "TOTP", status: "ACTIVE" },
      data: { lastUsedAt: null },
    });
    return totp.computeTotpCode(secrets.get(userId)!, totp.timeStep(Math.floor(Date.now() / 1000)));
  }

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = GOOGLE_AUD;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    auth = await import("../src/services/email-password-auth.service.js");
    jwt = await import("../src/services/jwt.js");
    totp = await import("../src/services/security/mfa-totp.js");
    fx = await import("./point7/product-fixtures.js");
    closure = await import("../src/services/identity/account-closure.service.js");
    holds = await import("../src/services/governance/legal-hold.service.js");
    deps = {
      prisma: prisma as never,
      tag: `r3ai-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === GOOGLE_JWKS) {
        return new Response(
          JSON.stringify({
            keys: [{ ...(key.publicKey.export({ format: "jwk" }) as Json), kid: KID, alg: "RS256", use: "sig" }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`rem3 fake transport refuses ${url}`);
    }) as typeof fetch);
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_CLIENT_ID;
    await harness?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // PRO-034 (AUTH-28)
  // ---------------------------------------------------------------------------
  it("PRO-034: an id_token signs in once, for a nonce this API issued, while it is fresh", async () => {
    const sub = `rem3-nonce-${randomUUID()}`;
    const email = `rem3-nonce-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const post = (idToken: string, headers: Record<string, string> = {}) =>
      harness.app.inject({
        method: "POST",
        url: "/v1/auth/google",
        remoteAddress: nextIp(),
        headers: { "content-type": "application/json", ...headers },
        payload: { idToken } as never,
      });

    // Control: an issued nonce signs in.
    const t = await freshToken(sub, email);
    const ok = await post(t);
    expect(ok.statusCode, ok.body).toBe(200);
    // The same token again: refused.
    const replay = await post(t);
    expect(replay.statusCode).toBe(401);
    expect(body(replay).code).toBe("nonce_invalid");
    // A nonce this API never issued.
    const foreign = await post(googleIdToken(sub, email, { nonce: "never-issued-by-proovra" }));
    expect(foreign.statusCode).toBe(401);
    expect(body(foreign).code).toBe("nonce_invalid");
    // No nonce at all (the rollout switch is off).
    const none = await post(googleIdToken(sub, email));
    expect(none.statusCode).toBe(401);
    expect(body(none).code).toBe("nonce_required");
    // Issued 30 days ago, still unexpired: refused by the iat window.
    const old = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const stale = await post(await freshToken(sub, email, { iat: old }));
    expect(stale.statusCode).toBe(401);

    // A web nonce is bound to the browser that asked for it.
    const issued = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/oauth/nonce",
      remoteAddress: nextIp(),
      headers: { "content-type": "application/json", "x-web-client": "1" },
      payload: { provider: "google" } as never,
    });
    expect(issued.statusCode).toBe(200);
    const setCookie = String(([] as string[]).concat(issued.headers["set-cookie"] as never)[0] ?? "");
    expect(setCookie).toMatch(/proovra_oauth_bind=[^;]+;.*HttpOnly/i);
    const bindCookie = setCookie.split(";")[0]!;
    const webToken = googleIdToken(sub, email, { nonce: (JSON.parse(issued.body) as Json).nonce });
    const otherBrowser = await post(webToken, { "x-web-client": "1" });
    expect(otherBrowser.statusCode).toBe(401);
    const sameBrowser = await post(webToken, { "x-web-client": "1", cookie: bindCookie });
    expect(sameBrowser.statusCode, sameBrowser.body).toBe(200);

    // The rollout switch for native builds without a nonce: accepted once, never from the web.
    process.env.SOCIAL_NONCELESS_ID_TOKENS = "accept";
    try {
      const legacy = googleIdToken(sub, email);
      expect((await post(legacy)).statusCode).toBe(200);
      const again = await post(legacy);
      expect(again.statusCode).toBe(401);
      expect(body(again).code).toBe("token_replayed");
      expect((await post(googleIdToken(sub, email), { "x-web-client": "1" })).statusCode).toBe(401);
    } finally {
      delete process.env.SOCIAL_NONCELESS_ID_TOKENS;
    }
    // Only hashes are stored.
    const rows = await prisma.socialSignInNonce.findMany({ take: 50, orderBy: { createdAtUtc: "desc" } });
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.nonceHash))).toBe(true);
  });

  it("B-01: a web sign-in or link answers only a nonce bound to this browser; native answers only an unbound one", async () => {
    const sub = `rem3-b01-${randomUUID()}`;
    const email = `rem3-b01-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const post = (url: string, payload: Json, headers: Record<string, string> = {}) =>
      harness.app.inject({
        method: "POST",
        url,
        remoteAddress: nextIp(),
        headers: { "content-type": "application/json", ...headers },
        payload: payload as never,
      });
    const webNonce = async () => {
      const r = await post("/v1/auth/oauth/nonce", { provider: "google" }, { "x-web-client": "1" });
      expect(r.statusCode, r.body).toBe(200);
      const setCookie = String(([] as string[]).concat(r.headers["set-cookie"] as never)[0] ?? "");
      return { nonce: (JSON.parse(r.body) as Json).nonce as string, cookie: setCookie.split(";")[0]! };
    };
    const nativeNonce = async () => {
      const r = await post("/v1/auth/oauth/nonce", { provider: "google" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers["set-cookie"]).toBeUndefined();
      return (JSON.parse(r.body) as Json).nonce as string;
    };
    const nonceRow = (nonce: string) =>
      prisma.socialSignInNonce.findUniqueOrThrow({
        where: { nonceHash: createHash("sha256").update(`nonce:${nonce}`, "utf8").digest("hex") },
      });

    // The attack: an unbound (native) nonce, its token posted by the web — with or without a bind cookie.
    const { cookie: victimCookie } = await webNonce();
    const unbound = await nativeNonce();
    const injected = googleIdToken(sub, email, { nonce: unbound });
    const noCookie = await post("/v1/auth/google", { idToken: injected }, { "x-web-client": "1" });
    expect(noCookie.statusCode).toBe(401);
    expect(body(noCookie).code).toBe("nonce_invalid");
    const withCookie = await post("/v1/auth/google", { idToken: injected }, { "x-web-client": "1", cookie: victimCookie });
    expect(withCookie.statusCode).toBe(401);
    expect(body(withCookie).code).toBe("nonce_invalid");
    expect(withCookie.headers["set-cookie"]).toBeUndefined();
    expect((await nonceRow(unbound)).consumedAtUtc).toBeNull();

    // Native control: the same unbound nonce, posted without the web header, signs in.
    const native = await post("/v1/auth/google", { idToken: injected });
    expect(native.statusCode, native.body).toBe(200);
    expect((await nonceRow(unbound)).consumedAtUtc).not.toBeNull();

    // A web-bound nonce: the web with its cookie passes; native cannot spend it.
    const bound = await webNonce();
    const boundToken = googleIdToken(sub, email, { nonce: bound.nonce });
    const nativeSpend = await post("/v1/auth/google", { idToken: boundToken });
    expect(nativeSpend.statusCode).toBe(401);
    expect(body(nativeSpend).code).toBe("nonce_invalid");
    const web = await post("/v1/auth/google", { idToken: boundToken }, { "x-web-client": "1", cookie: bound.cookie });
    expect(web.statusCode, web.body).toBe(200);

    // The link path (signed in, linking Google) applies the same rule.
    const P = "LinkB01Password123";
    const owner = await emailUser("b01-link", P);
    const session = await login(owner.email, P);
    const linkSub = `rem3-b01-link-${randomUUID()}`;
    const link = (idToken: string, headers: Record<string, string> = {}) =>
      post(
        "/v1/identity/links/google",
        { idToken, stepUp: { method: "password", currentPassword: P } },
        { authorization: `Bearer ${session.token!}`, ...headers },
      );
    const linkUnbound = await link(googleIdToken(linkSub, email, { nonce: await nativeNonce() }), {
      "x-web-client": "1",
      cookie: victimCookie,
    });
    expect(linkUnbound.statusCode).toBe(400);
    expect((body(linkUnbound).error as Json).reason).toBe("nonce_invalid");
    expect(await prisma.userIdentityLink.count({ where: { provider: "GOOGLE", providerSubjectId: linkSub } })).toBe(0);
    const linkBound = await webNonce();
    const linked = await link(googleIdToken(linkSub, email, { nonce: linkBound.nonce }), {
      "x-web-client": "1",
      cookie: linkBound.cookie,
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(
      (await prisma.userIdentityLink.findFirstOrThrow({ where: { provider: "GOOGLE", providerSubjectId: linkSub } })).userId,
    ).toBe(owner.id);
  });

  it("B-04 / PRO-A1-04: a linked sign-in never rewrites a password account's address; a provider-created account's change is verified only when vouched", async () => {
    const P = "LinkB04Password123";
    const owner = await emailUser("b04", P);
    const verifiedBefore = (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).emailVerifiedAt!;
    const session = await login(owner.email, P);
    const sub = `rem3-b04-${randomUUID()}`;
    const linked = await call("POST", "/v1/identity/links/google", session.token!, {
      idToken: await freshToken(sub, owner.email),
      stepUp: { method: "password", currentPassword: P },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    // PRO-A1-04 — the linked identity reports another address: the account keeps its own.
    const other = `rem3-b04-other-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const viaLink = await call("POST", "/v1/auth/google", undefined, { idToken: await freshToken(sub, other) });
    expect(viaLink.statusCode, viaLink.body).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id }, select: { email: true, emailVerifiedAt: true } })).toEqual({
      email: owner.email,
      emailVerifiedAt: verifiedBefore,
    });

    // B-04 — a Google-CREATED account follows its provider's address, verified only when vouched.
    const gSub = `rem3-b04-created-${randomUUID()}`;
    const created = await call("POST", "/v1/auth/google", undefined, {
      idToken: await freshToken(gSub, `rem3-b04-c-${randomUUID().slice(0, 8)}@test.proovra.local`),
    });
    expect(created.statusCode, created.body).toBe(200);
    const createdId = (body(created).user as Json).id as string;
    const createdBefore = (await prisma.user.findUniqueOrThrow({ where: { id: createdId } })).emailVerifiedAt!;
    const signIn = async (email: string, emailVerified: boolean) => {
      const r = await call("POST", "/v1/auth/google", undefined, {
        idToken: await freshToken(gSub, email, { email_verified: emailVerified }),
      });
      expect(r.statusCode, r.body).toBe(200);
      expect((body(r).user as Json).id).toBe(createdId);
      return prisma.user.findUniqueOrThrow({ where: { id: createdId }, select: { email: true, emailVerifiedAt: true } });
    };

    // A new address the provider does NOT vouch for: no longer verified.
    const unvouched = `rem3-b04-unvouched-${randomUUID().slice(0, 8)}@test.proovra.local`;
    expect(await signIn(unvouched, false)).toEqual({ email: unvouched, emailVerifiedAt: null });
    // A new address the provider vouches for: verified now.
    const vouched = `rem3-b04-vouched-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const after = await signIn(vouched, true);
    expect(after.email).toBe(vouched);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.emailVerifiedAt!.getTime()).toBeGreaterThan(createdBefore.getTime());
  });

  it("B-05: an MFA sign-in still pending when the account closes never mints a session", async () => {
    const t = await fx.seedPersonalTenant(deps, "FREE");
    const uid = t.owner.userId;
    const PW = "ClosurePendingMfa123";
    await prisma.user.update({ where: { id: uid }, data: { passwordHash: await auth.hashPassword(PW), emailVerifiedAt: new Date() } });
    await seedTotp(uid);
    const pending = await call("POST", "/v1/auth/email/login", undefined, { email: t.owner.email, password: PW });
    expect(pending.statusCode, pending.body).toBe(200);
    expect(body(pending).mfaRequired).toBe(true);

    const req = await prisma.accountClosureRequest.create({
      data: { userId: uid, status: "PROCESSING", startedAtUtc: new Date() },
    });
    await closure.executeAccountClosure(uid, { closureRequestId: req.id });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: uid } })).providerUserId).toBe(`closed:${uid}`);
    await nextSecond(); // a token minted now would carry an iat past the closure's revocation
    const sessionsBefore = await prisma.authenticatedSession.count({ where: { userId: uid } });

    const v = await call("POST", "/v1/auth/mfa/verify", undefined, {
      mfaPendingToken: body(pending).mfaPendingToken,
      code: await code(uid),
    });
    expect(v.statusCode, v.body).toBe(401);
    expect(body(v).message).toBe("mfa_pending_invalid");
    expect(body(v).token).toBeUndefined();
    expect(await prisma.authenticatedSession.count({ where: { userId: uid } })).toBe(sessionsBefore);
  });

  it("B-11: two concurrent uses of one verification link — exactly one succeeds, the other is already_used", async () => {
    const u = await emailUser("b11", "VerifyRacePass123");
    for (let round = 0; round < 3; round += 1) {
      // PRO-A1-10 — a link verifies only an UNVERIFIED account (a leftover link
      // of a verified account is refused), so each round starts unverified
      // (and password-less, so the race is on the token alone).
      await prisma.user.update({ where: { id: u.id }, data: { emailVerifiedAt: null, passwordHash: null } });
      const { rawToken } = await auth.createEmailVerificationToken(u.id);
      const results = await Promise.all([
        auth.consumeEmailVerificationToken(rawToken),
        auth.consumeEmailVerificationToken(rawToken),
        auth.consumeEmailVerificationToken(rawToken),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => (r as { reason: string }).reason)).toEqual([
        "already_used",
        "already_used",
      ]);
      // And a later replay of the spent link is refused too.
      expect(await auth.consumeEmailVerificationToken(rawToken)).toEqual({ ok: false, reason: "already_used" });
    }
  });

  // ---------------------------------------------------------------------------
  // PRO-009 (AUTH-03)
  // ---------------------------------------------------------------------------
  it("PRO-009: an identity A unlinked is re-owned by B when B links it, and signs in to B, never A", async () => {
    const PA = "AccountAPassword123";
    const PB = "AccountBPassword123";
    const A = await emailUser("link-a", PA);
    const B = await emailUser("link-b", PB);
    const sub = `rem3-g-${randomUUID()}`;
    const gEmail = `rem3-g-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const a = await login(A.email, PA);
    const b = await login(B.email, PB);

    const linkA = await call("POST", "/v1/identity/links/google", a.token!, {
      idToken: await freshToken(sub, gEmail),
      stepUp: { method: "password", currentPassword: PA },
    });
    expect(linkA.statusCode, linkA.body).toBe(200);
    // Control: while A's link is ACTIVE, B is refused and nothing moves.
    const bWhileActive = await call("POST", "/v1/identity/links/google", b.token!, {
      idToken: await freshToken(sub, gEmail),
      stepUp: { method: "password", currentPassword: PB },
    });
    expect(bWhileActive.statusCode).toBe(409);
    const linkRow = await prisma.userIdentityLink.findFirstOrThrow({ where: { provider: "GOOGLE", providerSubjectId: sub } });
    expect(linkRow.userId).toBe(A.id);

    const unlink = await call("DELETE", `/v1/identity/links/${linkRow.id}`, a.token!, {
      stepUp: { method: "password", currentPassword: PA },
    });
    expect(unlink.statusCode, unlink.body).toBe(200);

    const linkB = await call("POST", "/v1/identity/links/google", b.token!, {
      idToken: await freshToken(sub, gEmail),
      stepUp: { method: "password", currentPassword: PB },
    });
    expect(linkB.statusCode, linkB.body).toBe(200);
    const after = await prisma.userIdentityLink.findUniqueOrThrow({ where: { id: linkRow.id } });
    expect(after.userId).toBe(B.id);
    expect(after.status).toBe("ACTIVE");

    const signIn = await google(sub, gEmail);
    expect(signIn.status, signIn.raw.body).toBe(200);
    expect((signIn.json!.user as Json).id).toBe(B.id);

    // And A can no longer take it back while B holds it.
    const aAgain = await call("POST", "/v1/identity/links/google", a.token!, {
      idToken: await freshToken(sub, gEmail),
      stepUp: { method: "password", currentPassword: PA },
    });
    expect(aAgain.statusCode).toBe(409);
    expect((await prisma.userIdentityLink.findUniqueOrThrow({ where: { id: linkRow.id } })).userId).toBe(B.id);
  });

  // ---------------------------------------------------------------------------
  // PRO-010 (AUTH-04)
  // ---------------------------------------------------------------------------
  it("PRO-010: a Google-created account's added password signs in, and unlinking Google ends Google's way in", async () => {
    const sub = `rem3-gn-${randomUUID()}`;
    const gEmail = `rem3-gn-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const first = await google(sub, gEmail);
    expect(first.status, first.raw.body).toBe(200);
    const uid = (first.json!.user as Json).id as string;
    await legal(uid);
    const PW = "GoogleNativeAdded123";

    const add = await call("POST", "/v1/identity/password", first.json!.token as string, { newPassword: PW });
    expect(add.statusCode, add.body).toBe(200);
    const converted = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    expect(converted.provider).toBe("EMAIL");
    expect(converted.providerUserId).toBe(gEmail.toLowerCase());
    const pw = await login(gEmail, PW);
    expect(pw.status).toBe(200);

    // Google still signs in to the same account through its ACTIVE link.
    const viaLink = await google(sub, gEmail);
    expect((viaLink.json!.user as Json).id).toBe(uid);

    const link = await prisma.userIdentityLink.findFirstOrThrow({ where: { userId: uid, provider: "GOOGLE", status: "ACTIVE" } });
    const unlink = await call("DELETE", `/v1/identity/links/${link.id}`, pw.token!, {
      stepUp: { method: "password", currentPassword: PW },
    });
    expect(unlink.statusCode, unlink.body).toBe(200);

    // Google no longer signs in here. B1-F-004 (free-audit 0ea0): the address
    // is this account's, verified, so the unlinked identity does not open a
    // second account either — it is told to sign in and connect Google again.
    const again = await google(sub, gEmail);
    expect(again.status, again.raw.body).toBe(409);
    expect(body(again.raw).code).toBe("EXISTING_ACCOUNT_SIGN_IN_REQUIRED");
    expect(body(again.raw).token).toBeUndefined();
    expect((await prisma.userIdentityLink.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("REVOKED");
    expect(await prisma.user.count({ where: { provider: "GOOGLE", providerUserId: sub } })).toBe(0);
    // The account itself is untouched and still signs in with its password.
    expect((await login(gEmail, PW)).status).toBe(200);
  });

  it("PRO-010: an account unlinked before the fix (pair intact, link REVOKED) no longer signs in through its pair", async () => {
    const sub = `rem3-legacy-${randomUUID()}`;
    const gEmail = `rem3-legacy-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const legacy = await prisma.user.create({
      data: { email: gEmail, provider: "GOOGLE", providerUserId: sub, emailVerifiedAt: new Date() },
    });
    await prisma.userIdentityLink.create({
      data: { userId: legacy.id, provider: "GOOGLE", providerSubjectId: sub, status: "REVOKED", revokedAtUtc: new Date() },
    });
    // B1-F-004 (free-audit 0ea0) — not through the pair, and not into a second
    // account for the address this account holds verified: guidance instead.
    const signIn = await google(sub, gEmail);
    expect(signIn.status, signIn.raw.body).toBe(409);
    expect(body(signIn.raw).code).toBe("EXISTING_ACCOUNT_SIGN_IN_REQUIRED");
    const detached = await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(detached.providerUserId.startsWith("unlinked:")).toBe(true);

    // Control: an ordinary Google account with an ACTIVE link keeps signing in.
    const sub2 = `rem3-ok-${randomUUID()}`;
    const e2 = `rem3-ok-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const s1 = await google(sub2, e2);
    const s2 = await google(sub2, e2);
    expect((s2.json!.user as Json).id).toBe((s1.json!.user as Json).id);
  });

  // ---------------------------------------------------------------------------
  // PRO-008 (AUTH-02)
  // ---------------------------------------------------------------------------
  it("PRO-008: Google + MFA keeps SOCIAL_OAUTH, so an org that allows only PASSWORD and SSO still refuses it", async () => {
    const org = await fx.seedOrganizationTenant(deps, { memberCount: 0 });
    const sub = `rem3-mfa-${randomUUID()}`;
    const gEmail = `rem3-mfa-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const first = await google(sub, gEmail);
    const gUserId = (first.json!.user as Json).id as string;
    await legal(gUserId);
    await prisma.organizationMembership.create({ data: { organizationId: org.organizationId, userId: gUserId, role: "ORG_MEMBER" } });
    await prisma.teamMember.create({ data: { teamId: org.workspaceId, userId: gUserId, role: "MEMBER", status: "ACTIVE" } });
    await prisma.user.update({ where: { id: gUserId }, data: { currentWorkspaceId: org.workspaceId } });
    const ev = await prisma.evidence.create({
      data: { type: "PHOTO", status: "CREATED", title: "rem3 social evidence", ownerUserId: gUserId, teamId: org.workspaceId, organizationId: org.organizationId },
    });
    const policy = await prisma.organizationSecurityPolicy.findFirstOrThrow({ where: { organizationId: org.organizationId } });
    try {
      await prisma.organizationSecurityPolicy.update({ where: { id: policy.id }, data: { allowedAuthMethods: ["PASSWORD", "SSO"] } });
      await seedTotp(gUserId);
      const pending = await google(sub, gEmail);
      expect(pending.json!.mfaRequired).toBe(true);
      expect(claims(pending.json!.mfaPendingToken as string).authMethod).toBe("SOCIAL_OAUTH");
      const v = await call("POST", "/v1/auth/mfa/verify", undefined, {
        mfaPendingToken: pending.json!.mfaPendingToken,
        code: await code(gUserId),
      });
      expect(v.statusCode, v.body).toBe(200);
      const t = body(v).token as string;
      expect(claims(t).authMethod).toBe("SOCIAL_OAUTH");
      expect(typeof claims(t).mfaAt).toBe("number");
      const read = await call("GET", `/v1/evidence/${ev.id}`, t);
      expect(read.statusCode).toBe(401);

      // Control: with the policy open the same MFA-completed social session reads.
      await prisma.organizationSecurityPolicy.update({ where: { id: policy.id }, data: { allowedAuthMethods: [] } });
      expect((await call("GET", `/v1/evidence/${ev.id}`, t)).statusCode).toBe(200);
    } finally {
      await prisma.evidence.delete({ where: { id: ev.id } }).catch(() => null);
    }

    // Control: a password sign-in through MFA keeps PASSWORD.
    const PW = "PasswordMfaControl123";
    const u = await emailUser("pw-mfa", PW);
    await seedTotp(u.id);
    const p = await call("POST", "/v1/auth/email/login", undefined, { email: u.email, password: PW });
    const pv = await call("POST", "/v1/auth/mfa/verify", undefined, {
      mfaPendingToken: body(p).mfaPendingToken,
      code: await code(u.id),
    });
    expect(pv.statusCode, pv.body).toBe(200);
    expect(claims(body(pv).token as string).authMethod).toBe("PASSWORD");
  });

  // ---------------------------------------------------------------------------
  // PRO-004
  // ---------------------------------------------------------------------------
  it("PRO-004: two concurrent confirms of one reset link — exactly one wins, the loser is refused, revocation happens once", async () => {
    const P0 = "InitialResetPass123";
    const P1 = "ResetWinnerOne123";
    const P2 = "ResetWinnerTwo123";
    const u = await emailUser("reset-race", P0);
    for (let round = 0; round < 3; round += 1) {
      // "Once" is one revoke-all: since PRO-019 a revocation also ends each
      // live session by id (SINGLE_SESSION rows), and from the second round the
      // user holds the session the previous round signed in with.
      const revokeAlls = () =>
        prisma.revokedSession.count({ where: { userId: u.id, scope: "ALL_FOR_USER" } });
      const before = await revokeAlls();
      const t = await auth.createPasswordResetTokenForEmail(u.email);
      expect(t).not.toBeNull();
      const [a, b] = await Promise.all([
        call("POST", "/v1/auth/password-reset/confirm", undefined, { token: t!.rawToken, newPassword: P1 }),
        call("POST", "/v1/auth/password-reset/confirm", undefined, { token: t!.rawToken, newPassword: P2 }),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 400]);
      const loser = a.statusCode === 400 ? a : b;
      expect(body(loser).message).toBe("invalid_or_expired");
      const winnerPassword = a.statusCode === 200 ? P1 : P2;
      const loserPassword = a.statusCode === 200 ? P2 : P1;
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(await auth.verifyPassword(winnerPassword, row.passwordHash!)).toBe(true);
      expect(await auth.verifyPassword(loserPassword, row.passwordHash!)).toBe(false);
      expect(await revokeAlls()).toBe(before + 1);
      // Replay of the spent link is refused too.
      const replay = await call("POST", "/v1/auth/password-reset/confirm", undefined, { token: t!.rawToken, newPassword: "ReplayAttempt12345" });
      expect(replay.statusCode).toBe(400);
      await nextSecond();
      expect((await login(u.email, winnerPassword)).status).toBe(200);
    }
  });

  // ---------------------------------------------------------------------------
  // PRO-011 (AUTH-05)
  // ---------------------------------------------------------------------------
  it("PRO-011: while a legal hold defers anonymisation, neither a pre-closure link nor a new reset reopens the account", async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS rem3_auth_fail (key text NOT NULL)`);
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION rem3_auth_fail_fn() RETURNS trigger AS $$ BEGIN IF EXISTS (SELECT 1 FROM rem3_auth_fail f WHERE f.key = NEW.action || ':' || COALESCE(NEW.resource_id, '')) THEN RAISE EXCEPTION 'rem3 injected'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS rem3_auth_fail_trg ON admin_audit_logs`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER rem3_auth_fail_trg BEFORE INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION rem3_auth_fail_fn()`,
    );
    try {
      const t = await fx.seedPersonalTenant(deps, "FREE");
      const uid = t.owner.userId;
      const PW = "ClosureHoldPass123";
      await prisma.user.update({ where: { id: uid }, data: { passwordHash: await auth.hashPassword(PW), emailVerifiedAt: new Date() } });
      expect((await login(t.owner.email, PW)).status).toBe(200);
      const preToken = await auth.createPasswordResetTokenForEmail(t.owner.email);
      expect(preToken).not.toBeNull();
      const req = await prisma.accountClosureRequest.create({
        data: { userId: uid, status: "PROCESSING", startedAtUtc: new Date(Date.now() - 2 * 3600e3) },
      });
      // Phase A commits; phase B fails (injected), so the request waits in PROCESSING.
      await prisma.$executeRawUnsafe(`INSERT INTO rem3_auth_fail (key) VALUES ($1)`, `identity.account_closure_completed:${req.id}`);
      await expect(closure.executeAccountClosure(uid, { closureRequestId: req.id })).rejects.toThrow();
      await prisma.$executeRawUnsafe(`DELETE FROM rem3_auth_fail`);
      await holds.placeCanonicalLegalHold({ teamId: t.personalTeamId, scope: "WORKSPACE", actorUserId: uid, title: "rem3 hold" } as never);
      await closure.processAccountClosures(new Date());
      const deferred = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
      expect(deferred.providerUserId).toBe(`closed:${uid}`);
      expect(deferred.email).not.toBeNull();
      // Phase A retired the link that was waiting in the mailbox.
      expect(await prisma.passwordResetToken.count({ where: { userId: uid, usedAt: null } })).toBe(0);

      const NEW = "ReopenAttemptPass123";
      const confirmPre = await call("POST", "/v1/auth/password-reset/confirm", undefined, { token: preToken!.rawToken, newPassword: NEW });
      expect(confirmPre.statusCode).toBe(400);
      const before = await prisma.passwordResetToken.count({ where: { userId: uid } });
      const request = await call("POST", "/v1/auth/password-reset/request", undefined, { email: t.owner.email });
      expect(request.statusCode).toBe(200); // neutral answer
      expect(await prisma.passwordResetToken.count({ where: { userId: uid } })).toBe(before);
      expect(await auth.createPasswordResetTokenForEmail(t.owner.email)).toBeNull();

      const after = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
      expect(after.providerUserId).toBe(`closed:${uid}`);
      expect(after.passwordHash).toBeNull();
      expect((await login(t.owner.email, NEW)).status).toBe(401);
      await prisma.accountClosureRequest.update({ where: { id: req.id }, data: { startedAtUtc: new Date(Date.now() - 2 * 3600e3) } });
      await closure.processAccountClosures(new Date());
      const reqAfter = await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(reqAfter.status).toBe("PROCESSING");
      expect(reqAfter.failureCode).toBe("legal_hold_deferred");

      // Control: an open account's reset still works end to end.
      const C = await emailUser("closure-control", "ControlResetPass123");
      const ct = await auth.createPasswordResetTokenForEmail(C.email);
      const ok = await call("POST", "/v1/auth/password-reset/confirm", undefined, { token: ct!.rawToken, newPassword: "ControlResetPass456" });
      expect(ok.statusCode).toBe(200);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS rem3_auth_fail_trg ON admin_audit_logs`).catch(() => null);
    }
  });

  // ---------------------------------------------------------------------------
  // PRO-024 (AUTH-18)
  // ---------------------------------------------------------------------------
  describe("PRO-024: the extension authorization code and its authorizing session", () => {
    const REDIRECT = `https://${"a".repeat(32)}.chromiumapp.org/cb`;
    let savedAllow: string | undefined;
    beforeAll(() => {
      savedAllow = process.env.EXTENSION_OAUTH_REDIRECT_ALLOW;
      process.env.EXTENSION_OAUTH_REDIRECT_ALLOW = REDIRECT;
    });
    afterAll(() => {
      if (savedAllow === undefined) delete process.env.EXTENSION_OAUTH_REDIRECT_ALLOW;
      else process.env.EXTENSION_OAUTH_REDIRECT_ALLOW = savedAllow;
    });

    async function authorize(token: string) {
      const verifier = randomBytes(48).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const q = new URLSearchParams({
        response_type: "code",
        client_id: "proovra-extension",
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "rem3",
      });
      // PRO-X1-01 — the explicit approval the web confirmation page obtains.
      const approved = await call("POST", "/v1/oauth/extension/approve", token, {
        client_id: "proovra-extension",
        redirect_uri: REDIRECT,
        code_challenge: challenge,
      });
      expect(approved.statusCode, approved.body).toBe(200);
      q.set("approval", body(approved).approval as string);
      const r = await call("GET", `/v1/oauth/extension/authorize?${q.toString()}`, token);
      expect(r.statusCode, r.body).toBe(302);
      const code = new URL(r.headers.location as string).searchParams.get("code")!;
      return { code, verifier };
    }
    const exchange = (c: { code: string; verifier: string }) =>
      call("POST", "/v1/oauth/extension/token", undefined, {
        grant_type: "authorization_code",
        code: c.code,
        code_verifier: c.verifier,
        client_id: "proovra-extension",
        redirect_uri: REDIRECT,
      });

    it("a live session's code exchanges once; after sign-out or a password reset it does not", async () => {
      const PW = "ExtensionUserPass123";
      const u = await emailUser("ext", PW);

      // Control: live session → 200, the token works, a replay is refused.
      const s1 = await login(u.email, PW);
      const c1 = await authorize(s1.token!);
      const ok = await exchange(c1);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await call("GET", "/v1/platform/context", body(ok).access_token as string)).statusCode).toBe(200);
      expect((await exchange(c1)).statusCode).toBe(400);

      // PRO-X1-04 — signing out of the web session ends the extension session it
      // authorized (and only that one).
      const extToken = body(ok).access_token as string;
      const other = await login(u.email, PW);
      expect((await call("POST", "/v1/auth/logout", s1.token!)).statusCode).toBe(200);
      expect((await call("GET", "/v1/platform/context", extToken)).statusCode).toBe(401);
      expect((await call("GET", "/v1/auth/me", other.token!)).statusCode).toBe(200);

      // Sign-out before the exchange.
      const s2 = await login(u.email, PW);
      const c2 = await authorize(s2.token!);
      const out = await call("POST", "/v1/auth/logout", s2.token!);
      expect(out.statusCode).toBe(200);
      expect((await call("GET", "/v1/auth/me", s2.token!)).statusCode).toBe(401);
      const afterLogout = await exchange(c2);
      expect(afterLogout.statusCode).toBe(400);
      expect(body(afterLogout).error).toBe("invalid_grant");

      // A password reset before the exchange.
      const s3 = await login(u.email, PW);
      const c3 = await authorize(s3.token!);
      await nextSecond();
      const rt = await auth.createPasswordResetTokenForEmail(u.email);
      const reset = await call("POST", "/v1/auth/password-reset/confirm", undefined, { token: rt!.rawToken, newPassword: "ExtensionUserPass456" });
      expect(reset.statusCode).toBe(200);
      expect((await call("GET", "/v1/auth/me", s3.token!)).statusCode).toBe(401);
      const afterReset = await exchange(c3);
      expect(afterReset.statusCode).toBe(400);
      expect(body(afterReset).error).toBe("invalid_grant");
    });

    it("matrix review NEW-RG10-1 (DEC-29): ending the authorizing web session from another device (my-sessions/:id/revoke) ends the extension session it authorized; the revoking device and an unrelated extension session survive", async () => {
      const PW = "ExtensionRevokePass123";
      const u = await emailUser("ext-revoke", PW);
      const parent = await login(u.email, PW);
      const ext = await exchange(await authorize(parent.token!));
      expect(ext.statusCode, ext.body).toBe(200);
      const extToken = body(ext).access_token as string;
      // An unrelated extension session, authorized by a different web session.
      const sibling = await login(u.email, PW);
      const siblingExt = await exchange(await authorize(sibling.token!));
      expect(siblingExt.statusCode, siblingExt.body).toBe(200);
      const siblingExtToken = body(siblingExt).access_token as string;
      const device = await login(u.email, PW);
      expect((await call("GET", "/v1/platform/context", extToken)).statusCode).toBe(200);

      // The parent's inventory row: the session list marks the caller's own.
      const mine = await call("GET", "/v1/identity-security/my-sessions", parent.token!);
      expect(mine.statusCode, mine.body).toBe(200);
      const parentId = (body(mine).sessions as Array<{ id: string; isCurrent: boolean }>).find((s) => s.isCurrent)!.id;
      const parentRow = await prisma.authenticatedSession.findUniqueOrThrow({
        where: { id: parentId },
        select: { id: true, sessionIdHash: true },
      });
      const child = await prisma.authenticatedSession.findFirstOrThrow({
        where: { userId: u.id, parentSessionIdHash: parentRow.sessionIdHash },
        select: { sessionIdHash: true },
      });
      const r = await call("POST", `/v1/identity-security/my-sessions/${parentRow.id}/revoke`, device.token!, {
        stepUp: { method: "password", currentPassword: PW },
      });
      expect(r.statusCode, r.body).toBe(200);

      expect((await call("GET", "/v1/auth/me", parent.token!)).statusCode).toBe(401);
      expect((await call("GET", "/v1/platform/context", extToken)).statusCode).toBe(401);
      const childAfter = await prisma.authenticatedSession.findFirstOrThrow({
        where: { userId: u.id, sessionIdHash: child.sessionIdHash },
        select: { revokedAtUtc: true, revokedReason: true },
      });
      expect(childAfter.revokedAtUtc).toBeInstanceOf(Date);
      expect(childAfter.revokedReason).toBe("PARENT_SESSION_ENDED");
      // Unrelated sessions are untouched.
      expect((await call("GET", "/v1/auth/me", device.token!)).statusCode).toBe(200);
      expect((await call("GET", "/v1/auth/me", sibling.token!)).statusCode).toBe(200);
      expect((await call("GET", "/v1/platform/context", siblingExtToken)).statusCode).toBe(200);
    });
  });
});
