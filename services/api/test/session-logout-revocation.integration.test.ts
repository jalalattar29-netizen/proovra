/**
 * AUD-020 — sign-out ENDS the session, against a disposable PostgreSQL 16 and
 * the real Fastify app (`harness.app.inject` only).
 *
 * Before: `POST /v1/auth/logout` cleared the browser cookie and answered 200,
 * and the token stayed valid for the rest of its 30-day life. A copied bearer,
 * or the same cookie value replayed, kept working after the person had signed
 * out. Now the presented session is revoked through the canonical registry
 * (`revokeSession`, SINGLE_SESSION) and its inventory row is ended — and only
 * that session: the person's other devices stay signed in.
 *
 * Sessions here are REAL: they come from `POST /v1/auth/email/login`, the same
 * route the web and mobile clients call, so each carries the sid and the
 * `AuthenticatedSession` row production writes.
 */

import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const WEB_ORIGIN = "http://127.0.0.1:3007";
const PASSWORD = "Logout-Proof-Pass-123";

describe("AUD-020 — logout revokes the presented session (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let signJwt: (typeof import("../src/services/jwt.js"))["signJwt"];
  let hashSessionId: (typeof import("../src/services/identity-security/session-revocation.service.js"))["hashSessionId"];
  let revokeAllSessionsForUser: (typeof import("../src/services/identity-security/session-revocation.service.js"))["revokeAllSessionsForUser"];
  let clearAllRateLimitBuckets: (typeof import("../src/services/rate-limit.js"))["clearAllRateLimitBuckets"];
  const createdUserIds: string[] = [];

  const me = (headers: Record<string, string>) =>
    harness.app.inject({ method: "GET", url: "/v1/auth/me", headers });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function persona(label: string): Promise<{ id: string; email: string }> {
    const { hashPassword } = await import("../src/services/email-password-auth.service.js");
    const email = `aud020-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: {
        email,
        firstName: "Aud",
        lastName: label,
        provider: "EMAIL",
        providerUserId: email,
        passwordHash: hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
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
        source: "aud020-fixture",
      })),
    });
    return { id: user.id, email };
  }

  /** A real device sign-in. `web` asks for the browser session cookie too. */
  async function signIn(email: string, opts: { web?: boolean } = {}) {
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/email/login",
      headers: {
        "content-type": "application/json",
        ...(opts.web ? { "x-web-client": "1", origin: WEB_ORIGIN } : {}),
      },
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    const token = (JSON.parse(res.body) as { token: string }).token;
    const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    const cookie = setCookie
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("proovra_session=") && c.length > "proovra_session=".length);
    return { token, cookie: cookie ?? null };
  }

  function sidOf(token: string): string {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as {
      sid: string;
    };
    return payload.sid;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ hashSessionId, revokeAllSessionsForUser } = await import(
      "../src/services/identity-security/session-revocation.service.js"
    ));
    ({ clearAllRateLimitBuckets } = await import("../src/services/rate-limit.js"));
  });

  beforeEach(async () => {
    await clearAllRateLimitBuckets();
  });

  afterAll(async () => {
    if (prisma && createdUserIds.length > 0) {
      await prisma.revokedSession.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.authenticatedSession.deleteMany({ where: { userId: { in: createdUserIds } } });
    }
    await harness?.cleanup();
  });

  it("bearer logout: the replayed token is 401, the session is revoked SINGLE_SESSION and its row ended; the other device stays signed in", async () => {
    const p = await persona("bearer");
    const phone = await signIn(p.email);
    const laptop = await signIn(p.email);
    expect((await me(bearer(phone.token))).statusCode).toBe(200);
    expect((await me(bearer(laptop.token))).statusCode).toBe(200);

    const out = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: bearer(phone.token),
    });
    expect(out.statusCode, out.body).toBe(200);

    // Replay of the signed-out token.
    const replay = await me(bearer(phone.token));
    expect(replay.statusCode).toBe(401);

    const hash = hashSessionId(sidOf(phone.token));
    const revoked = await prisma.revokedSession.findMany({ where: { userId: p.id } });
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.scope).toBe("SINGLE_SESSION");
    expect(revoked[0]!.sessionIdHash).toBe(hash);
    expect(revoked[0]!.reason).toBe("USER_LOGGED_OUT");
    const row = await prisma.authenticatedSession.findFirstOrThrow({
      where: { userId: p.id, sessionIdHash: hash },
    });
    expect(row.revokedAtUtc).not.toBeNull();
    expect(row.revokedReason).toBe("USER_LOGOUT");

    // Multi-device semantics: logout is THIS session only.
    expect((await me(bearer(laptop.token))).statusCode).toBe(200);
    const laptopRow = await prisma.authenticatedSession.findFirstOrThrow({
      where: { userId: p.id, sessionIdHash: hashSessionId(sidOf(laptop.token)) },
    });
    expect(laptopRow.revokedAtUtc).toBeNull();

    // A second logout with the dead token is a no-op that still answers.
    const again = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: bearer(phone.token),
    });
    expect(again.statusCode).toBe(200);
    expect(await prisma.revokedSession.count({ where: { userId: p.id } })).toBe(1);
  });

  it("cookie logout: the browser cookie is cleared AND the replayed cookie value is 401", async () => {
    const p = await persona("cookie");
    const browser = await signIn(p.email, { web: true });
    expect(browser.cookie).not.toBeNull();
    const other = await signIn(p.email);

    const before = await me({ cookie: browser.cookie! });
    expect(before.statusCode).toBe(200);

    const out = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: browser.cookie!, origin: WEB_ORIGIN, "x-web-client": "1" },
    });
    expect(out.statusCode, out.body).toBe(200);
    const cleared = ([] as string[]).concat(out.headers["set-cookie"] ?? []);
    expect(cleared.some((c) => /^proovra_session=;/.test(c))).toBe(true);

    // The attacker who kept the cookie value replays it.
    expect((await me({ cookie: browser.cookie! })).statusCode).toBe(401);
    // ...and the same token as a bearer is equally dead.
    expect((await me(bearer(browser.token))).statusCode).toBe(401);
    expect((await me(bearer(other.token))).statusCode).toBe(200);
  });

  it("concurrent devices: two devices signing out at once end exactly those two sessions", async () => {
    const p = await persona("concurrent");
    const a = await signIn(p.email);
    const b = await signIn(p.email);
    const c = await signIn(p.email);

    const [outA, outB, readC] = await Promise.all([
      harness.app.inject({ method: "POST", url: "/v1/auth/logout", headers: bearer(a.token) }),
      harness.app.inject({ method: "POST", url: "/v1/auth/logout", headers: bearer(b.token) }),
      me(bearer(c.token)),
    ]);
    expect(outA.statusCode).toBe(200);
    expect(outB.statusCode).toBe(200);
    expect(readC.statusCode).toBe(200);

    expect((await me(bearer(a.token))).statusCode).toBe(401);
    expect((await me(bearer(b.token))).statusCode).toBe(401);
    expect((await me(bearer(c.token))).statusCode).toBe(200);
    const live = await prisma.authenticatedSession.count({
      where: { userId: p.id, revokedAtUtc: null },
    });
    expect(live).toBe(1);
  });

  it("a revoked user (sign out everywhere / suspension) is refused on every device", async () => {
    const p = await persona("revoked");
    const a = await signIn(p.email);
    const b = await signIn(p.email);
    expect((await me(bearer(a.token))).statusCode).toBe(200);
    // `iat` is second-granular: the deny row covers tokens issued at or before it.
    await revokeAllSessionsForUser({ userId: p.id, reason: "MEMBER_SUSPENDED" });
    expect((await me(bearer(a.token))).statusCode).toBe(401);
    expect((await me(bearer(b.token))).statusCode).toBe(401);
  });

  it("an expired token is refused, and logging out with it ends nothing", async () => {
    const p = await persona("expired");
    const secret = process.env.AUTH_JWT_SECRET!;
    const expired = signJwt(
      { sub: p.id, provider: "EMAIL", email: p.email, authMethod: "PASSWORD", authAt: 1 },
      secret,
      -60,
    );
    expect((await me(bearer(expired))).statusCode).toBe(401);
    const out = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: bearer(expired),
    });
    expect(out.statusCode).toBe(200);
    expect(await prisma.revokedSession.count({ where: { userId: p.id } })).toBe(0);
  });

  it("algorithm confusion: alg=none, alg=RS256 over the HMAC secret and a missing alg are all refused", async () => {
    const p = await persona("alg");
    const secret = process.env.AUTH_JWT_SECRET!;
    const good = (await signIn(p.email)).token;
    const [, payloadB64] = good.split(".");
    const forge = (header: Record<string, unknown>, sign: boolean) => {
      const h = Buffer.from(JSON.stringify(header)).toString("base64url");
      const input = `${h}.${payloadB64}`;
      const sig = sign ? createHmac("sha256", secret).update(input).digest("base64url") : "";
      return `${input}.${sig}`;
    };
    // Every forgery carries a VALID HMAC over its own header + the real
    // payload, so the header is the only thing that can refuse it.
    for (const header of [
      { alg: "none", typ: "JWT" },
      { alg: "RS256", typ: "JWT" },
      { alg: "hs256", typ: "JWT" },
      { typ: "JWT" },
      { alg: "HS256", typ: "JWS+evil" },
    ]) {
      const res = await me(bearer(forge(header, true)));
      expect(res.statusCode, JSON.stringify(header)).toBe(401);
    }
    expect((await me(bearer(forge({ alg: "none" }, false)))).statusCode).toBe(401);
    // Control: the same payload under the real header is accepted.
    expect((await me(bearer(forge({ alg: "HS256", typ: "JWT" }, true)))).statusCode).toBe(200);
  });

  it("fail closed: when the revocation cannot be recorded, logout answers 503 and the session stays visibly live (never a false 200)", async () => {
    const p = await persona("failclosed");
    const s = await signIn(p.email);
    // The revocation store refuses the write once (an outage at exactly that
    // moment); every later call reaches the real store. Not restored: the
    // Prisma delegate is a proxy that a restored spy no longer binds, so this
    // case runs after every case that writes a revocation.
    vi.spyOn(prisma.revokedSession, "create").mockRejectedValueOnce(
      new Error("simulated revocation store outage"),
    );
    const out = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: bearer(s.token),
    });
    expect(out.statusCode).toBe(503);
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: { code: "logout_incomplete" } });
    // The client was told the truth: nothing was recorded, so the session is
    // still live and no inventory row claims it ended.
    expect(await prisma.revokedSession.count({ where: { userId: p.id } })).toBe(0);
    expect((await me(bearer(s.token))).statusCode).toBe(200);
  });

  it("a token without a revocable sid/iat is refused (it could never be signed out)", async () => {
    const p = await persona("nosid");
    const secret = process.env.AUTH_JWT_SECRET!;
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: p.id, provider: "EMAIL", authMethod: "PASSWORD", authAt: now, exp: now + 600 }),
    ).toString("base64url");
    const sig = createHmac("sha256", secret).update(`${h}.${body}`).digest("base64url");
    expect((await me(bearer(`${h}.${body}.${sig}`))).statusCode).toBe(401);
  });
});
