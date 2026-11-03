/**
 * IDENT-002, IDENT-003, IDENT-014 — OIDC sign-in, end to end, against a local
 * stand-in provider.
 *
 * The provider is a real HTTP server on loopback that behaves as the OIDC spec
 * says: it checks the client secret and the PKCE proof, and signs a real id_token.
 * It is not any named IdP, and no real IdP has been exercised.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedOrganizationTenant, type FixtureDeps, type OrganizationTenant } from "./point7/product-fixtures.js";

const CLIENT_ID = "local-client";
const CLIENT_SECRET = "local-client-secret-value";
const CHALLENGE_METHODS: string[] = [];

type Authorization = { nonce: string; challenge: string };

class LocalIdp {
  server!: Server;
  base = "";
  subject = "subject-1";
  email = "person@example.test";
  privateKey!: CryptoKey;
  jwk!: JWK;
  pending: Authorization | null = null;
  tokenCalls: Array<{ secret: string | null; verifier: string | null }> = [];

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
    if (url.pathname === "/userinfo") {
      return this.json(res, { sub: this.subject, email: this.email, name: "Person" });
    }
    if (url.pathname === "/token") {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const form = new URLSearchParams(raw);
      const secret = form.get("client_secret");
      const verifier = form.get("code_verifier");
      this.tokenCalls.push({ secret, verifier });
      const proof = verifier
        ? createHash("sha256").update(verifier, "ascii").digest("base64url")
        : null;
      if (secret !== CLIENT_SECRET) return this.json(res, { error: "invalid_client" }, 401);
      if (!this.pending || proof !== this.pending.challenge) {
        return this.json(res, { error: "invalid_grant" }, 400);
      }
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

describe("OIDC sign-in against a local stand-in provider (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let sso: typeof import("../src/services/access-control/sso.service.js");
  let hardening: typeof import("../src/services/access-control/sso-hardening.service.js");
  let deps: FixtureDeps;
  const idp = new LocalIdp();
  const tag = `oidc-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const originalLoopback = process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
  const originalWeb = process.env.WEB_BASE_URL;

  const mint = (userId: string, email: string) =>
    signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );

  /** A connection created the way the console does it, pointed at the stand-in. */
  async function activeConnection(org: OrganizationTenant, secret: string | null = CLIENT_SECRET) {
    const created = await sso.createSsoConnection({
      teamId: org.workspaceId,
      provider: "GENERIC_OIDC",
      displayName: "Local OIDC",
      issuerUrl: "https://placeholder.example.test/.well-known/openid-configuration",
      clientId: CLIENT_ID,
      clientSecret: secret ?? "secret-to-be-removed",
      allowedEmailDomains: ["example.test"],
      jitDefaultRole: "MEMBER",
      actorUserId: org.owner.userId,
    } as never);
    const id = created.projection.id;
    // The schema requires https for an issuer. The stand-in is loopback http,
    // which only the test-mode fence admits.
    await prisma.ssoConnection.update({
      where: { id },
      data: {
        issuerUrl: `${idp.base}/.well-known/openid-configuration`,
        ...(secret ? {} : { clientSecretSealed: null }),
      },
    });
    await sso.transitionSsoConnection({
      teamId: org.workspaceId,
      id,
      nextStatus: "ACTIVE",
      actorUserId: org.owner.userId,
    });
    return id;
  }

  function setCookie(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers["set-cookie"];
    const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
    return list
      .filter((c) => !/Expires=Thu, 01 Jan 1970/i.test(c) && !/Max-Age=0/i.test(c))
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  async function initiate(connectionId: string, redirectAfter?: string) {
    const url =
      `/v1/auth/sso/${connectionId}/initiate` +
      (redirectAfter ? `?redirectAfter=${encodeURIComponent(redirectAfter)}` : "");
    const res = await harness.app.inject({ method: "GET", url });
    expect(res.statusCode, res.body).toBe(302);
    const target = new URL(String(res.headers.location));
    expect(target.origin, String(res.headers.location)).toBe(idp.base);
    const state = target.searchParams.get("state")!;
    idp.pending = {
      nonce: target.searchParams.get("nonce")!,
      challenge: target.searchParams.get("code_challenge")!,
    };
    CHALLENGE_METHODS.push(target.searchParams.get("code_challenge_method") ?? "");
    return { state, cookie: setCookie(res) };
  }

  const callback = (state: string, cookie: string) =>
    harness.app.inject({
      method: "GET",
      url: `/v1/auth/sso/callback?state=${encodeURIComponent(state)}&code=auth-code-12345`,
      headers: { cookie },
    });

  beforeAll(async () => {
    process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = "1";
    process.env.WEB_BASE_URL = "https://web.example.test";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    sso = await import("../src/services/access-control/sso.service.js");
    hardening = await import("../src/services/access-control/sso-hardening.service.js");
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
    idp.tokenCalls.length = 0;
  });

  it("stores the secret sealed, and a sign-in completes through it", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);

    const stored = await prisma.ssoConnection.findUniqueOrThrow({ where: { id } });
    expect(stored.clientSecretSealed).toBeTruthy();
    expect(stored.clientSecretSealed).not.toContain(CLIENT_SECRET);

    const { state, cookie } = await initiate(id, "/evidence");
    // Sign-in state lives in the ledger: another instance has no memory of it.
    sso.__resetSsoServiceStateForTests();
    const res = await callback(state, cookie);

    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toBe("https://web.example.test/evidence");
    expect(idp.tokenCalls).toHaveLength(1);
    expect(idp.tokenCalls[0]!.secret).toBe(CLIENT_SECRET);
    expect(CHALLENGE_METHODS.at(-1)).toBe("S256");

    const session = setCookie(res);
    expect(session).toContain("proovra_session=");
    const row = await prisma.user.findFirst({ where: { email: idp.email }, select: { id: true } });
    expect(row).toBeTruthy();
    const mapping = await prisma.externalIdentityMapping.findFirst({ where: { userId: row!.id } });
    expect(mapping?.externalSubjectId).toBe(idp.subject);
    expect(
      await prisma.authenticatedSession.count({ where: { userId: row!.id, ssoConnectionId: id } }),
    ).toBe(1);
  });

  it("RT-015: a new OIDC account owes acceptance, is refused until it accepts, and is then let through", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { state, cookie } = await initiate(id, "/home");
    const session = /proovra_session=([^;]+)/.exec(setCookie(await callback(state, cookie)))![1]!;
    const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
      harness.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${session}`, ...(payload ? { "content-type": "application/json" } : {}) },
        ...(payload ? { payload: payload as never } : {}),
      });

    const owed = (await call("GET", "/v1/users/legal-status")).json() as {
      requiresReacceptance: boolean;
      missingPolicies: string[];
      requiredVersions: Record<string, string>;
    };
    expect(owed.requiresReacceptance).toBe(true);
    const gated = `/v1/orgs/${org.organizationId}/invites/bulk/validate`;
    expect((await call("POST", gated, { rows: [] })).statusCode).toBe(428);

    // What the step after sign-in posts.
    const accepted = await call("POST", "/v1/users/legal-acceptance", {
      source: "post_sign_in",
      acceptances: owed.missingPolicies.map((policyKey) => ({
        policyKey,
        policyVersion: owed.requiredVersions[policyKey],
      })),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(((await call("GET", "/v1/users/legal-status")).json() as { ok: boolean }).ok).toBe(true);
    expect((await call("POST", gated, { rows: [] })).statusCode).not.toBe(428);
  });

  it("refuses a second use of the same state", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { state, cookie } = await initiate(id);
    expect((await callback(state, cookie)).statusCode).toBe(302);

    const replay = await callback(state, cookie);
    expect(String(replay.headers.location)).toContain("https://web.example.test/login?sso_error=sso_state_replayed");
    expect(setCookie(replay)).not.toContain("proovra_session=");
    expect(idp.tokenCalls).toHaveLength(1);
  });

  it("an unknown state goes to the sign-in page with a reason, on the web host", async () => {
    const res = await callback("never-issued-state", "");
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain("https://web.example.test/login?sso_error=sso_browser_mismatch");
  });

  it("a callback in another browser is login CSRF: refused, and the state survives", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { state, cookie } = await initiate(id);

    const elsewhere = await callback(state, "");
    expect(String(elsewhere.headers.location)).toContain("sso_error=sso_browser_mismatch");
    expect(idp.tokenCalls).toHaveLength(0);
    const attempt = await prisma.ssoCallbackAttempt.findUnique({
      where: { stateHash: hardening.hashStateToken(state) },
    });
    expect(attempt?.status).toBe("PENDING");

    const mine = await callback(state, cookie);
    expect(String(mine.headers.location)).toBe("https://web.example.test/home");
  });

  it("a connection holding only a hash says so, and a rotated secret brings it back", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org, null);

    const readiness = await harness.app.inject({
      method: "GET",
      url: `/v1/auth/sso/readiness?teamId=${org.workspaceId}`,
      headers: { authorization: `Bearer ${org.owner.token}` },
    });
    expect(readiness.statusCode, readiness.body).toBe(200);
    const row = (
      readiness.json() as { readiness: { connections: Array<{ id: string; ready: boolean; blockers: string[] }> } }
    ).readiness.connections.find((c) => c.id === id)!;
    expect(row.ready).toBe(false);
    expect(row.blockers).toContain("CLIENT_SECRET_UNAVAILABLE");
    expect(readiness.body).not.toContain(CLIENT_SECRET);

    const { state, cookie } = await initiate(id);
    const failed = await callback(state, cookie);
    expect(String(failed.headers.location)).toContain("sso_error=sso_code_exchange_failed");
    expect(idp.tokenCalls).toHaveLength(0);

    await sso.updateSsoConnectionPolicy({
      teamId: org.workspaceId,
      id,
      actorUserId: org.owner.userId,
      clientSecret: CLIENT_SECRET,
    });
    const retried = await initiate(id);
    expect(String((await callback(retried.state, retried.cookie)).headers.location)).toBe(
      "https://web.example.test/home",
    );
  });

  it("a stale discovery document is refetched, and a private address is refused", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    await prisma.ssoConnection.update({
      where: { id },
      data: { issuerUrl: "https://169.254.169.254/latest/meta-data" },
    });
    const res = await harness.app.inject({ method: "GET", url: `/v1/auth/sso/${id}/initiate` });
    expect(String(res.headers.location)).toContain("sso_error=sso_discovery_failed");
    expect(String(res.headers.location)).not.toContain("169.254");
  });

  it("IDENT-010: an IdP cannot sign a closed account back in", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const first = await initiate(id);
    expect(String((await callback(first.state, first.cookie)).headers.location)).toBe("https://web.example.test/home");
    const user = await prisma.user.findFirstOrThrow({ where: { email: idp.email }, select: { id: true } });
    // Closed, with the mapping still linked: what an older closure left behind.
    await prisma.user.update({ where: { id: user.id }, data: { providerUserId: `closed:${user.id}` } });

    const again = await initiate(id);
    const res = await callback(again.state, again.cookie);
    expect(String(res.headers.location)).toContain("sso_error=sso_account_link_denied");
    expect(setCookie(res)).not.toContain("proovra_session=");
  });

  it("IDENT-020: an email on a verified domain finds its sign-in, and nothing else does", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const domain = `${randomUUID().slice(0, 8)}.verified.example`;
    const discover = async (email: string) =>
      (await harness.app.inject({ method: "POST", url: "/v1/auth/sso/discover", payload: { email } })).json() as {
        sso: boolean;
        loginPath?: string;
      };
    const claim = (organizationId: string, ownerId: string, verifiedAt: Date | null) =>
      prisma.organizationDomain.create({
        data: { organizationId, domain, verifiedAt, verificationToken: randomUUID(), createdByUserId: ownerId } as never,
      });

    await claim(org.organizationId, org.owner.userId, null);
    expect(await discover(`a@${domain}`)).toEqual({ sso: false });

    await prisma.organizationDomain.updateMany({ where: { domain }, data: { verifiedAt: new Date() } });
    expect(await discover(`a@${domain}`)).toEqual({ sso: true, loginPath: `/v1/auth/sso/${id}/initiate` });
    expect(await discover("a@elsewhere.example")).toEqual({ sso: false });
    expect(await discover("not an email")).toEqual({ sso: false });

    await prisma.ssoConnection.update({ where: { id }, data: { status: "DISABLED" } });
    expect(await discover(`a@${domain}`)).toEqual({ sso: false });
  });

  it("an abandoned attempt is swept once it is long past its expiry", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const id = await activeConnection(org);
    const { state } = await initiate(id);
    const old = new Date(Date.now() - 40 * 86_400_000);
    await prisma.ssoCallbackAttempt.update({
      where: { stateHash: hardening.hashStateToken(state) },
      data: { createdAt: old, expiresAtUtc: old },
    });
    await hardening.sweepStaleCallbackAttempts({ olderThanDays: 30 }, prisma as never);
    expect(
      await prisma.ssoCallbackAttempt.count({ where: { stateHash: hardening.hashStateToken(state) } }),
    ).toBe(0);
  });
});
