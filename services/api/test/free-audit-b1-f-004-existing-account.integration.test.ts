/**
 * FREE-USER AUDIT 0ea0 — B1-F-004 (live PostgreSQL 16, real routes).
 *
 * One person, one self-serve account per VERIFIED address. A Google/Apple
 * sign-in whose verified address an existing personal account holds — with no
 * link for that provider subject — is refused with a guidance code instead of
 * opening a second identity (and a second Free allowance, D-03); a password
 * registration for an address a Google/Apple account holds verified is refused
 * the same way. Resolution stays by provider subject: an email match never
 * authenticates, merges or links. Every refusal has a control on the same rows.
 *
 * External boundaries stay local: the Google JWKS is answered by a fake
 * transport with a key generated here; nothing else may be fetched.
 */
import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("B1-F-004 — an existing account's verified address does not open a second account (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let auth: typeof import("../src/services/email-password-auth.service.js");
  let social: typeof import("../src/services/auth.service.js");

  const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
  const GOOGLE_AUD = "b1f004.apps.googleusercontent.test";
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const KID = `b1f004-${randomUUID().slice(0, 8)}`;
  const PASSWORD = "B1f004-Strong-Passphrase1";
  let ipCounter = 1;
  const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;
  const address = (label: string) => `b1f004-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;

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

  async function freshToken(sub: string, email: string, extra: Json = {}): Promise<string> {
    const r = await call("POST", "/v1/auth/oauth/nonce", undefined, { provider: "google" });
    expect(r.statusCode, r.body).toBe(200);
    return googleIdToken(sub, email, { nonce: body(r).nonce, ...extra });
  }

  async function google(sub: string, email: string, extra: Json = {}) {
    const r = await call("POST", "/v1/auth/google", undefined, { idToken: await freshToken(sub, email, extra) });
    return { status: r.statusCode, json: body(r) };
  }

  async function legal(userId: string) {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId,
        policyKey,
        policyVersion: policyVersion as string,
        source: "b1-f-004",
      })),
    });
  }

  async function passwordAccount(label: string, opts: { verified?: boolean } = {}) {
    const email = address(label);
    const u = await prisma.user.create({
      data: {
        email,
        provider: "EMAIL",
        providerUserId: email,
        passwordHash: await auth.hashPassword(PASSWORD),
        emailVerifiedAt: opts.verified === false ? null : new Date(),
      },
    });
    await legal(u.id);
    return { id: u.id, email };
  }

  const accountsAt = (email: string) =>
    prisma.user.findMany({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, provider: true },
    });

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = GOOGLE_AUD;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    auth = await import("../src/services/email-password-auth.service.js");
    social = await import("../src/services/auth.service.js");
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
      throw new Error(`b1-f-004 fake transport refuses ${url}`);
    }) as typeof fetch);
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_CLIENT_ID;
    await harness?.cleanup();
  }, 300_000);

  it("password first, then Google with the same verified address: refused with guidance, nothing created; after linking (step-up) Google signs in to that account", async () => {
    const owner = await passwordAccount("pw-first");
    const sub = `b1f004-pwfirst-${randomUUID()}`;

    const refused = await google(sub, owner.email.toUpperCase());
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("EXISTING_ACCOUNT_SIGN_IN_REQUIRED");
    expect(refused.json.token).toBeUndefined();
    // Nothing about the existing account is disclosed.
    expect(JSON.stringify(refused.json)).not.toContain(owner.id);
    expect(refused.json.user).toBeUndefined();
    // No second account, no link, no second Free allowance.
    expect(await accountsAt(owner.email)).toEqual([{ id: owner.id, provider: "EMAIL" }]);
    expect(await prisma.user.count({ where: { provider: "GOOGLE", providerUserId: sub } })).toBe(0);
    expect(await prisma.userIdentityLink.count({ where: { provider: "GOOGLE", providerSubjectId: sub } })).toBe(0);

    // The guided path: sign in with the password, connect Google with step-up.
    const login = await call("POST", "/v1/auth/email/login", undefined, { email: owner.email, password: PASSWORD });
    expect(login.statusCode, login.body).toBe(200);
    const withoutStepUp = await call("POST", "/v1/identity/links/google", body(login).token as string, {
      idToken: await freshToken(sub, owner.email),
    });
    expect(withoutStepUp.statusCode).not.toBe(200);
    const linked = await call("POST", "/v1/identity/links/google", body(login).token as string, {
      idToken: await freshToken(sub, owner.email),
      stepUp: { method: "password", currentPassword: PASSWORD },
    });
    expect(linked.statusCode, linked.body).toBe(200);

    const after = await google(sub, owner.email);
    expect(after.status).toBe(200);
    expect((after.json.user as Json).id).toBe(owner.id);
    expect(await accountsAt(owner.email)).toHaveLength(1);
  });

  it("an UNVERIFIED provider address neither reveals the account nor is refused: it behaves as before (its own account, no verified stamp)", async () => {
    const owner = await passwordAccount("unverified-claim");
    const sub = `b1f004-unverified-${randomUUID()}`;
    const r = await google(sub, owner.email, { email_verified: false });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain("EXISTING_ACCOUNT_SIGN_IN_REQUIRED");
    const created = await prisma.user.findFirstOrThrow({ where: { provider: "GOOGLE", providerUserId: sub } });
    expect(created.id).not.toBe(owner.id);
    expect(created.emailVerifiedAt).toBeNull();
  });

  it("an unverified password row (a stranger's unfinished registration) does not lock the mailbox owner out of Google", async () => {
    const squatter = await passwordAccount("squat", { verified: false });
    const sub = `b1f004-squat-${randomUUID()}`;
    const r = await google(sub, squatter.email);
    expect(r.status).toBe(200);
    expect((r.json.user as Json).id).not.toBe(squatter.id);
  });

  // Residual pass 2026-11-17 — the remaining two-account path: a password
  // registration left unverified, then a first-time Google sign-in for the same
  // (Google-verified) address, then the password account's own verification.
  // The verifier holds the emailed token AND the password, so naming the
  // existing account tells them nothing they do not control; the address stays
  // with the account that proved it first, the token stays unspent, and the
  // unverified row can never sign in (EV4 login gate).
  it("an unverified password account cannot verify an address a Google account now holds verified: 409 with guidance, nothing stamped, token unspent", async () => {
    const pending = await passwordAccount("pending", { verified: false });
    const g = await google(`b1f004-pending-${randomUUID()}`, pending.email);
    expect(g.status).toBe(200);
    const googleId = (g.json.user as Json).id as string;
    expect(googleId).not.toBe(pending.id);

    const raw = `b1f004-verify-${randomUUID()}`;
    const tokenRow = await prisma.emailVerificationToken.create({
      data: {
        userId: pending.id,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const r = await call("POST", "/v1/auth/email/verify", undefined, { token: raw, password: PASSWORD });
    expect(r.statusCode, r.body).toBe(409);
    expect((body(r).error as Json).code).toBe("EXISTING_ACCOUNT_SIGN_IN_REQUIRED");
    expect(r.body).not.toContain(googleId);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: pending.id }, select: { emailVerifiedAt: true } });
    expect(after.emailVerifiedAt).toBeNull();
    const t = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: tokenRow.id }, select: { usedAt: true } });
    expect(t.usedAt).toBeNull();
    // The unverified row still cannot sign in.
    const login = await call("POST", "/v1/auth/email/login", undefined, { email: pending.email, password: PASSWORD });
    expect(login.statusCode).not.toBe(200);
  });

  it("Google first, then password registration of the same address: refused (409 EMAIL_ALREADY_EXISTS), availability says taken, no EMAIL row; an unverified Google address does not block", async () => {
    const email = address("google-first");
    const sub = `b1f004-gfirst-${randomUUID()}`;
    const first = await google(sub, email);
    expect(first.status).toBe(200);
    const googleId = (first.json.user as Json).id as string;

    const avail = await call("GET", `/v1/auth/email/availability?email=${encodeURIComponent(email)}`);
    expect(body(avail)).toEqual({ available: false, reason: "EMAIL_ALREADY_EXISTS" });
    const reg = await call("POST", "/v1/auth/email/register", undefined, { email, password: PASSWORD });
    expect(reg.statusCode).toBe(409);
    expect((body(reg).error as Json).code).toBe("EMAIL_ALREADY_EXISTS");
    expect(await accountsAt(email)).toEqual([{ id: googleId, provider: "GOOGLE" }]);

    // Control: the provider never vouched for this address — registration proceeds as before.
    const loose = address("google-unverified");
    expect((await google(`b1f004-gloose-${randomUUID()}`, loose, { email_verified: false })).status).toBe(200);
    const availLoose = await call("GET", `/v1/auth/email/availability?email=${encodeURIComponent(loose)}`);
    expect(body(availLoose)).toEqual({ available: true });
    const regLoose = await call("POST", "/v1/auth/email/register", undefined, { email: loose, password: PASSWORD });
    expect(regLoose.statusCode, regLoose.body).toBe(201);
  });

  it("social-only 'forgot password' stays enumeration-safe: the same neutral answer as an unknown address, no reset token", async () => {
    const email = address("social-reset");
    const sub = `b1f004-sreset-${randomUUID()}`;
    const g = await google(sub, email);
    expect(g.status).toBe(200);
    const uid = (g.json.user as Json).id as string;
    const known = await call("POST", "/v1/auth/password-reset/request", undefined, { email });
    const unknown = await call("POST", "/v1/auth/password-reset/request", undefined, { email: address("nobody") });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
    expect(await prisma.passwordResetToken.count({ where: { userId: uid } })).toBe(0);
  });

  it("a closed account, a directory-created row and a managed identity do not block a personal Google account (SSO/SCIM rows are never linked here)", async () => {
    const closedAcc = await passwordAccount("closed");
    await prisma.user.update({ where: { id: closedAcc.id }, data: { providerUserId: `closed:${closedAcc.id}` } });
    const c = await google(`b1f004-closed-${randomUUID()}`, closedAcc.email);
    expect(c.status).toBe(200);
    expect((c.json.user as Json).id).not.toBe(closedAcc.id);

    const dirEmail = address("scim");
    const dir = await prisma.user.create({
      data: {
        email: dirEmail,
        provider: "EMAIL",
        providerUserId: `scim-${randomUUID()}:ext-${randomUUID().slice(0, 8)}`,
        emailVerifiedAt: new Date(),
      },
    });
    const d = await google(`b1f004-scim-${randomUUID()}`, dirEmail);
    expect(d.status).toBe(200);
    expect((d.json.user as Json).id).not.toBe(dir.id);
    expect(await prisma.userIdentityLink.count({ where: { userId: dir.id } })).toBe(0);

    const managedEmail = address("managed");
    const managed = await prisma.user.create({
      data: {
        email: managedEmail,
        provider: "EMAIL",
        providerUserId: managedEmail,
        emailVerifiedAt: new Date(),
        identityMode: "MANAGED_ENTERPRISE",
      },
    });
    const m = await google(`b1f004-managed-${randomUUID()}`, managedEmail);
    expect(m.status).toBe(200);
    expect((m.json.user as Json).id).not.toBe(managed.id);
  });

  it("a linked subject stays authoritative and an existing duplicate keeps signing in", async () => {
    // Linked: a password account with Google linked signs in there even when
    // Google now reports another verified account's address.
    const owner = await passwordAccount("linked");
    const other = await passwordAccount("other");
    const sub = `b1f004-linked-${randomUUID()}`;
    await prisma.userIdentityLink.create({
      data: { userId: owner.id, provider: "GOOGLE", providerSubjectId: sub, status: "ACTIVE", providerEmailVerified: true },
    });
    const linked = await google(sub, other.email);
    expect(linked.status).toBe(200);
    expect((linked.json.user as Json).id).toBe(owner.id);

    // Existing duplicate (created before this rule): untouched, still signs in.
    const pw = await passwordAccount("dup");
    const dupSub = `b1f004-dup-${randomUUID()}`;
    const dup = await prisma.user.create({
      data: { email: pw.email, provider: "GOOGLE", providerUserId: dupSub, emailVerifiedAt: new Date() },
    });
    const again = await google(dupSub, pw.email);
    expect(again.status).toBe(200);
    expect((again.json.user as Json).id).toBe(dup.id);
    expect(await accountsAt(pw.email)).toHaveLength(2);
  });

  it("Apple (service level): a first-time Apple subject with a verified address an account holds is refused; unverified is not", async () => {
    const owner = await passwordAccount("apple");
    const sub = `b1f004-apple-${randomUUID()}`;
    const profile = {
      provider: "APPLE" as const,
      providerUserId: sub,
      email: owner.email,
      displayName: null,
      avatarUrl: null,
    };
    await expect(social.upsertUserWithEmailLink({ ...profile, emailVerified: true } as never)).rejects.toMatchObject({
      code: "EXISTING_ACCOUNT_SIGN_IN_REQUIRED",
    });
    expect(await prisma.user.count({ where: { provider: "APPLE", providerUserId: sub } })).toBe(0);
    const loose = await social.upsertUserWithEmailLink({ ...profile, emailVerified: false } as never);
    expect(loose.id).not.toBe(owner.id);
  });

  it("concurrent: first-time Google and Apple sign-ins carrying one fresh verified address open exactly ONE account", async () => {
    for (let round = 0; round < 4; round += 1) {
      const email = address(`race-${round}`);
      const gSub = `b1f004-race-g-${round}-${randomUUID()}`;
      const aSub = `b1f004-race-a-${round}-${randomUUID()}`;
      const idToken = await freshToken(gSub, email);
      const [g, a] = await Promise.allSettled([
        call("POST", "/v1/auth/google", undefined, { idToken }),
        social.upsertUserWithEmailLink({
          provider: "APPLE",
          providerUserId: aSub,
          email,
          emailVerified: true,
          displayName: null,
          avatarUrl: null,
        } as never),
      ]);
      const holders = await accountsAt(email);
      expect(holders, `round ${round}`).toHaveLength(1);
      const googleOk = g.status === "fulfilled" && g.value.statusCode === 200;
      const appleOk = a.status === "fulfilled";
      expect(googleOk !== appleOk, `round ${round}: exactly one sign-in opens the account`).toBe(true);
      if (!googleOk) {
        expect(g.status === "fulfilled" && body(g.value).code).toBe("EXISTING_ACCOUNT_SIGN_IN_REQUIRED");
      } else {
        expect(a.status === "rejected" && (a.reason as { code?: string }).code).toBe("EXISTING_ACCOUNT_SIGN_IN_REQUIRED");
      }
    }
  });

  it("concurrent: a password registration and a first-time Google sign-in for one fresh address never leave the Google account and a password registration made after it", async () => {
    for (let round = 0; round < 3; round += 1) {
      const email = address(`reg-race-${round}`);
      const sub = `b1f004-reg-race-${round}-${randomUUID()}`;
      const idToken = await freshToken(sub, email);
      const [reg, g] = await Promise.all([
        call("POST", "/v1/auth/email/register", undefined, { email, password: PASSWORD }),
        call("POST", "/v1/auth/google", undefined, { idToken }),
      ]);
      expect(g.statusCode, g.body).toBe(200);
      // An UNVERIFIED registration holds nothing (PROV-001), so the Google
      // account may open beside it; once Google holds the address verified,
      // registration is refused.
      expect([201, 409]).toContain(reg.statusCode);
      const after = await call("POST", "/v1/auth/email/register", undefined, { email: email, password: `${PASSWORD}x` });
      expect(after.statusCode).toBe(409);
    }
  });

  it("concurrent: two simultaneous first-time Google sign-ins of one subject resolve to one account", async () => {
    const email = address("twin");
    const sub = `b1f004-twin-${randomUUID()}`;
    const [a, b] = await Promise.all([
      call("POST", "/v1/auth/google", undefined, { idToken: await freshToken(sub, email) }),
      call("POST", "/v1/auth/google", undefined, { idToken: await freshToken(sub, email) }),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect((body(a).user as Json).id).toBe((body(b).user as Json).id);
    expect(await prisma.user.count({ where: { provider: "GOOGLE", providerUserId: sub } })).toBe(1);
    expect(await prisma.userIdentityLink.count({ where: { provider: "GOOGLE", providerSubjectId: sub, status: "ACTIVE" } })).toBe(1);
  });

  it("concurrent: linking a subject to account A while that subject signs in for the first time never leaves it split across two accounts", async () => {
    for (let round = 0; round < 3; round += 1) {
      const owner = await passwordAccount(`split-${round}`);
      const login = await call("POST", "/v1/auth/email/login", undefined, { email: owner.email, password: PASSWORD });
      expect(login.statusCode, login.body).toBe(200);
      const sub = `b1f004-split-${round}-${randomUUID()}`;
      const otherAddress = address(`split-g-${round}`);
      const [link, signIn] = await Promise.all([
        call("POST", "/v1/identity/links/google", body(login).token as string, {
          idToken: await freshToken(sub, otherAddress),
          stepUp: { method: "password", currentPassword: PASSWORD },
        }),
        call("POST", "/v1/auth/google", undefined, { idToken: await freshToken(sub, otherAddress) }),
      ]);
      expect([200, 409]).toContain(link.statusCode);
      const activeLinks = await prisma.userIdentityLink.findMany({
        where: { provider: "GOOGLE", providerSubjectId: sub, status: "ACTIVE" },
        select: { userId: true },
      });
      expect(activeLinks).toHaveLength(1);
      const pairRow = await prisma.user.findFirst({ where: { provider: "GOOGLE", providerUserId: sub }, select: { id: true } });
      // One owner: if a pair row exists it is the link's owner.
      if (pairRow) expect(activeLinks[0]!.userId).toBe(pairRow.id);
      if (signIn.statusCode === 200) {
        const next = await google(sub, otherAddress);
        expect(next.status).toBe(200);
        expect((next.json.user as Json).id).toBe(activeLinks[0]!.userId);
      }
    }
  });
});
