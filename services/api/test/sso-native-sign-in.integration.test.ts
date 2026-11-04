/**
 * MOBILE-002 — Enterprise SSO sign-in for the native app, end to end, against a
 * local stand-in OIDC provider (the same kind of stand-in as
 * oidc-sign-in-local-idp.integration.test.ts: a loopback HTTP server that checks
 * the client secret and the PKCE proof and signs a real id_token). No real IdP
 * is exercised.
 *
 * The browser callback sets a cookie the phone app cannot use, so an
 * SSO-required member could not sign in on it. A native attempt now records the
 * app's PKCE challenge at initiate; the callback verifies the IdP answer exactly
 * as for the web and then redirects to proovra://sso/complete with a single-use
 * code instead of setting a cookie; the app redeems the code with its verifier.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedOrganizationTenant, type FixtureDeps, type OrganizationTenant } from "./point7/product-fixtures.js";

const CLIENT_ID = "local-native-client";
const CLIENT_SECRET = "local-native-client-secret";

class LocalIdp {
  server!: Server;
  base = "";
  subject = "subject-1";
  email = "person@example.test";
  privateKey!: CryptoKey;
  jwk!: JWK;
  pending: { nonce: string; challenge: string } | null = null;
  tokenCalls = 0;

  async start() {
    const keys = await generateKeyPair("RS256", { extractable: true });
    this.privateKey = keys.privateKey as CryptoKey;
    this.jwk = { ...(await exportJWK(keys.publicKey)), alg: "RS256", use: "sig", kid: "k1" };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private json(res: import("node:http").ServerResponse, body: unknown, status = 200) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    if (url.pathname === "/.well-known/openid-configuration") {
      return this.json(res, {
        issuer: this.base,
        authorization_endpoint: `${this.base}/authorize`,
        token_endpoint: `${this.base}/token`,
        userinfo_endpoint: `${this.base}/userinfo`,
        jwks_uri: `${this.base}/jwks`,
      });
    }
    if (url.pathname === "/jwks") return this.json(res, { keys: [this.jwk] });
    if (url.pathname === "/userinfo") return this.json(res, { sub: this.subject, email: this.email, name: "Person" });
    if (url.pathname === "/token") {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const form = new URLSearchParams(raw);
      this.tokenCalls += 1;
      const verifier = form.get("code_verifier");
      const proof = verifier ? createHash("sha256").update(verifier, "ascii").digest("base64url") : null;
      if (form.get("client_secret") !== CLIENT_SECRET) return this.json(res, { error: "invalid_client" }, 401);
      if (!this.pending || proof !== this.pending.challenge) return this.json(res, { error: "invalid_grant" }, 400);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ nonce: this.pending.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(this.base)
        .setAudience(CLIENT_ID)
        .setSubject(this.subject)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(this.privateKey);
      return this.json(res, { id_token: idToken, access_token: "access", token_type: "Bearer" });
    }
    return this.json(res, { error: "not_found" }, 404);
  }
}

/** What the app does: a random verifier and its S256 challenge (RFC 7636). */
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

describe("MOBILE-002 — native SSO sign-in through a single-use, PKCE-bound hand-off (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let sso: typeof import("../src/services/access-control/sso.service.js");
  let policySvc: typeof import("../src/services/identity/org-security-policy.service.js");
  let deps: FixtureDeps;
  const idp = new LocalIdp();
  const tag = `ssonative-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const originalLoopback = process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
  const originalWeb = process.env.WEB_BASE_URL;

  const mint = (userId: string, email: string) =>
    signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );

  async function activeConnection(org: OrganizationTenant) {
    const created = await sso.createSsoConnection({
      teamId: org.workspaceId,
      provider: "GENERIC_OIDC",
      displayName: "Local OIDC",
      issuerUrl: "https://placeholder.example.test/.well-known/openid-configuration",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      allowedEmailDomains: ["example.test"],
      jitDefaultRole: "MEMBER",
      actorUserId: org.owner.userId,
    } as never);
    const id = created.projection.id;
    await prisma.ssoConnection.update({ where: { id }, data: { issuerUrl: `${idp.base}/.well-known/openid-configuration` } });
    await sso.transitionSsoConnection({ teamId: org.workspaceId, id, nextStatus: "ACTIVE", actorUserId: org.owner.userId });
    return id;
  }

  function cookies(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers["set-cookie"];
    const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
    return list
      .filter((c) => !/Expires=Thu, 01 Jan 1970/i.test(c) && !/Max-Age=0/i.test(c))
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  /** The system browser opens the initiate URL the app built. */
  async function initiate(connectionId: string, challenge: string | null) {
    const url = `/v1/auth/sso/${connectionId}/initiate${challenge ? `?native=1&codeChallenge=${challenge}` : ""}`;
    const res = await harness.app.inject({ method: "GET", url });
    expect(res.statusCode, res.body).toBe(302);
    const target = new URL(String(res.headers.location));
    expect(target.origin).toBe(idp.base);
    idp.pending = { nonce: target.searchParams.get("nonce")!, challenge: target.searchParams.get("code_challenge")! };
    return { state: target.searchParams.get("state")!, cookie: cookies(res) };
  }

  const callback = (state: string, cookie: string) =>
    harness.app.inject({
      method: "GET",
      url: `/v1/auth/sso/callback?state=${encodeURIComponent(state)}&code=auth-code-12345`,
      headers: { cookie },
    });

  const exchange = (payload: unknown) =>
    harness.app.inject({ method: "POST", url: "/v1/auth/sso/native/exchange", payload: payload as never });

  /** The full native leg up to the app redirect; returns the code from proovra://sso/complete. */
  async function nativeCode(connectionId: string, challenge: string) {
    const { state, cookie } = await initiate(connectionId, challenge);
    const res = await callback(state, cookie);
    expect(res.statusCode, res.body).toBe(302);
    const location = String(res.headers.location);
    expect(location.startsWith("proovra://sso/complete?"), location).toBe(true);
    expect(cookies(res)).not.toContain("proovra_session=");
    return new URL(location).searchParams.get("code")!;
  }

  beforeAll(async () => {
    process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = "1";
    process.env.WEB_BASE_URL = "https://web.example.test";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    sso = await import("../src/services/access-control/sso.service.js");
    policySvc = await import("../src/services/identity/org-security-policy.service.js");
    deps = { prisma: prisma as never, tag, mintToken: mint };
    await idp.start();
  }, 180_000);

  afterAll(async () => {
    await idp.stop();
    if (originalLoopback === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
    else process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = originalLoopback;
    if (originalWeb === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = originalWeb;
    await harness?.cleanup();
  });

  beforeEach(() => {
    idp.subject = `subject-${randomUUID()}`;
    idp.email = `person-${randomUUID().slice(0, 8)}@example.test`;
    idp.pending = null;
    idp.tokenCalls = 0;
  });

  it("the app gets a single-use code, not a cookie or a token, and redeems it for a session with its verifier", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { verifier, challenge } = pkce();
    const code = await nativeCode(id, challenge);
    expect(code.length).toBeGreaterThanOrEqual(32);

    const user = await prisma.user.findFirstOrThrow({ where: { email: idp.email }, select: { id: true } });
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(0);

    const res = await exchange({ code, codeVerifier: verifier });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { token: string; user: { id: string; email: string } };
    expect(body.user).toMatchObject({ id: user.id, email: idp.email });
    expect(cookies(res)).not.toContain("proovra_session=");

    const me = await harness.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect((me.json() as { user: { id: string } }).user.id).toBe(user.id);

    const session = await prisma.authenticatedSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.ssoConnectionId).toBe(id);
    expect(session.authMethod).toBe("OIDC");
    const handoff = await prisma.ssoNativeHandoff.findFirstOrThrow({ where: { userId: user.id } });
    expect(handoff.usedAtUtc).not.toBeNull();
    expect(JSON.stringify(handoff)).not.toContain(body.token);
  });

  it("a code is spent once: a replay is refused and mints nothing", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { verifier, challenge } = pkce();
    const code = await nativeCode(id, challenge);
    expect((await exchange({ code, codeVerifier: verifier })).statusCode).toBe(200);
    const replay = await exchange({ code, codeVerifier: verifier });
    expect(replay.statusCode).toBe(400);
    expect((replay.json() as { error: { code: string } }).error.code).toBe("SSO_NATIVE_CODE_INVALID");
    const user = await prisma.user.findFirstOrThrow({ where: { email: idp.email }, select: { id: true } });
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(1);
  });

  it("another app that intercepts the redirect cannot use the code without the verifier, and the real app still can", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { verifier, challenge } = pkce();
    const code = await nativeCode(id, challenge);

    const stolen = await exchange({ code, codeVerifier: pkce().verifier });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.body).not.toContain("token\":");
    const user = await prisma.user.findFirstOrThrow({ where: { email: idp.email }, select: { id: true } });
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(0);

    expect((await exchange({ code, codeVerifier: verifier })).statusCode).toBe(200);
  });

  it("an expired code is refused", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { verifier, challenge } = pkce();
    const code = await nativeCode(id, challenge);
    await prisma.ssoNativeHandoff.updateMany({ where: { codeChallenge: challenge }, data: { codeExpiresAtUtc: new Date(Date.now() - 1000) } });
    expect((await exchange({ code, codeVerifier: verifier })).statusCode).toBe(400);
  });

  it("a native initiate without a valid S256 challenge is refused before anything is written", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const before = await prisma.ssoCallbackAttempt.count({ where: { ssoConnectionId: id } });
    const res = await harness.app.inject({ method: "GET", url: `/v1/auth/sso/${id}/initiate?native=1&codeChallenge=short` });
    expect(res.statusCode).toBe(400);
    expect(await prisma.ssoCallbackAttempt.count({ where: { ssoConnectionId: id } })).toBe(before);
  });

  it("a refused native attempt reports to the app, not to the web sign-in page", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { state } = await initiate(id, pkce().challenge);
    // The callback arrives in a browser that did not start it (login CSRF guard).
    const res = await callback(state, "");
    expect(String(res.headers.location)).toBe("proovra://sso/complete?error=sso_browser_mismatch");
    expect(idp.tokenCalls).toBe(0);
  });

  it("control: the browser sign-in is unchanged — cookie, web redirect, no hand-off row", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { state, cookie } = await initiate(id, null);
    const res = await callback(state, cookie);
    expect(String(res.headers.location)).toBe("https://web.example.test/home");
    expect(cookies(res)).toContain("proovra_session=");
    const user = await prisma.user.findFirstOrThrow({ where: { email: idp.email }, select: { id: true } });
    expect(await prisma.ssoNativeHandoff.count({ where: { userId: user.id } })).toBe(0);
  });

  it("an SSO-required Organization's member signs in on the phone, and the session carries the SSO proof", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    await policySvc.applySecurityPolicyPatch({
      organizationId: org.organizationId,
      actorUserId: org.owner.userId,
      patch: { ssoRequired: true },
    });
    const { verifier, challenge } = pkce();
    const res = await exchange({ code: await nativeCode(id, challenge), codeVerifier: verifier });
    expect(res.statusCode, res.body).toBe(200);
    const { token } = res.json() as { token: string };
    const [, payload] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { authMethod: string; ssoConnId: string };
    expect(claims).toMatchObject({ authMethod: "OIDC", ssoConnId: id });
    const me = await harness.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode, me.body).toBe(200);
  });
});
