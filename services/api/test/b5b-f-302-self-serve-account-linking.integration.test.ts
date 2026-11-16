/**
 * B5B-F-302 (High) — a verified domain never links or converts a PRE-EXISTING
 * SELF-SERVE account. End to end against a disposable PostgreSQL 16, through
 * the real /v2/scim routes, the real OIDC callback (a local stand-in IdP on
 * loopback — no real IdP is exercised), the SAML mapping authority, the
 * owner's consent route and the remediation command.
 *
 *   SCIM create on a self-serve account      → 409 uniqueness, nothing written
 *   SCIM create / re-push of a new address   → provisions MANAGED as before
 *   SCIM deprovision                          → releases MANAGED, removes access,
 *                                               Personal Space returns, org stays closed
 *   SAML / OIDC JIT on a self-serve account  → coded refusal, no link, no session
 *   the owner's consent                       → membership + link, Personal Space
 *                                               and export kept, SSO then signs in
 *   remediation command                       → dry run lists, apply releases, idempotent
 *   OIDC MFA resolver throws                  → 503, no session (fail closed)
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant } from "./point7/product-fixtures.js";

// The OIDC fail-closed case makes the MFA enforcement resolver throw; every
// other case runs the real resolver.
const M = vi.hoisted(() => ({ mfaThrows: false }));
vi.mock("../src/services/security/login-mfa-enforcement.service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/security/login-mfa-enforcement.service.js")>();
  return {
    ...real,
    resolveLoginMfaEnforcement: async (...args: Parameters<typeof real.resolveLoginMfaEnforcement>) => {
      if (M.mfaThrows) throw new Error("resolver unavailable (test)");
      return real.resolveLoginMfaEnforcement(...args);
    },
  };
});

type Json = Record<string, unknown>;
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const CLIENT_ID = "b5b-client";
const CLIENT_SECRET = "b5b-client-secret-value";
const PASSWORD = "Correct-Horse-9-battery";

class LocalIdp {
  server!: Server;
  base = "";
  subject = "subject-1";
  email = "person@example.test";
  privateKey!: CryptoKey;
  jwk!: JWK;
  pending: { nonce: string; challenge: string } | null = null;

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
      const verifier = form.get("code_verifier");
      const proof = verifier ? createHash("sha256").update(verifier, "ascii").digest("base64url") : null;
      if (form.get("client_secret") !== CLIENT_SECRET) return this.json(res, { error: "invalid_client" }, 401);
      if (!this.pending || proof !== this.pending.challenge) return this.json(res, { error: "invalid_grant" }, 400);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ nonce: this.pending.nonce, email_verified: true })
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

describe("B5B-F-302 — pre-existing self-serve accounts are never linked or converted on domain proof (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let jwt: typeof import("../src/services/jwt.js");
  let fx: typeof import("./point7/product-fixtures.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let sso: typeof import("../src/services/access-control/sso.service.js");
  let saml: typeof import("../src/services/security/saml-user-mapping.service.js");
  let identityMode: typeof import("../src/services/identity/identity-mode.service.js");
  let remediation: typeof import("../src/commands/remediate-domain-only-managed-links.js");
  let deps: FixtureDeps;
  const idp = new LocalIdp();
  const originalLoopback = process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
  const originalWeb = process.env.WEB_BASE_URL;

  // One managed-required enterprise Organization with a verified domain, a
  // directory credential and an OIDC connection.
  let org: OrganizationTenant;
  let domain: string;
  let scimToken: string;
  let connectionId: string;

  const scimCall = (method: string, url: string, payload?: unknown) =>
    harness.app.inject({
      method: method as never,
      url,
      headers: {
        authorization: `Bearer ${scimToken}`,
        ...(payload !== undefined ? { "content-type": "application/scim+json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const scimUser = (email: string, externalId = `ext-${randomUUID()}`) => ({
    schemas: [USER],
    userName: email,
    externalId,
    emails: [{ value: email, primary: true }],
    active: true,
  });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const freshToken = async (userId: string, email: string) => {
    const t = deps.mintToken(userId, email);
    await fx.registerSessionForToken(deps, userId, t);
    return t;
  };

  /** A self-serve account somebody opened for themselves at an address in the org's domain. */
  async function selfServeAccount(label: string, opts: { password?: boolean } = {}) {
    const seeded = await fx.seedUser(deps, label);
    const email = `${label}-${randomUUID().slice(0, 6)}@${domain}`;
    await prisma.user.update({
      where: { id: seeded.userId },
      data: {
        email,
        providerUserId: email,
        ...(opts.password
          ? { passwordHash: await (await import("../src/services/email-password-auth.service.js")).hashPassword(PASSWORD) }
          : {}),
      },
    });
    const personal = await fx.bootstrapPersonalSpace(deps, seeded.userId);
    return { id: seeded.userId, email, personalTeamId: personal.teamId };
  }

  async function fingerprint(userId: string) {
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { identityMode: true, managingOrganizationId: true, managedIdentitySource: true } as never,
    });
    return {
      user: u,
      mappings: await prisma.externalIdentityMapping.count({ where: { userId } }),
      orgWorkspaceMembers: await prisma.teamMember.count({ where: { userId, team: { organizationId: org.organizationId } } }),
      orgMemberships: await prisma.organizationMembership.count({ where: { userId, organizationId: org.organizationId } }),
      personalTeams: await prisma.team.count({ where: { ownerUserId: userId, isPersonal: true } }),
    };
  }

  function cookies(res: { headers: Record<string, unknown> }): Record<string, string> {
    const raw = res.headers["set-cookie"];
    const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
    const out: Record<string, string> = {};
    for (const c of list) {
      if (/Expires=Thu, 01 Jan 1970/i.test(c) || /Max-Age=0/i.test(c)) continue;
      const [pair] = c.split(";");
      const at = pair!.indexOf("=");
      out[pair!.slice(0, at)] = pair!.slice(at + 1);
    }
    return out;
  }
  const cookieHeader = (jar: Record<string, string>) =>
    Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

  async function oidcSignIn() {
    const init = await harness.app.inject({ method: "GET", url: `/v1/auth/sso/${connectionId}/initiate?redirectAfter=%2Fhome` });
    expect(init.statusCode, init.body).toBe(302);
    const target = new URL(String(init.headers.location));
    const state = target.searchParams.get("state")!;
    idp.pending = { nonce: target.searchParams.get("nonce")!, challenge: target.searchParams.get("code_challenge")! };
    return harness.app.inject({
      method: "GET",
      url: `/v1/auth/sso/callback?state=${encodeURIComponent(state)}&code=auth-code-12345`,
      headers: { cookie: cookieHeader(cookies(init)) },
    });
  }

  beforeAll(async () => {
    process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = "1";
    process.env.WEB_BASE_URL = "https://web.example.test";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    jwt = await import("../src/services/jwt.js");
    fx = await import("./point7/product-fixtures.js");
    scim = await import("../src/services/access-control/scim.service.js");
    sso = await import("../src/services/access-control/sso.service.js");
    saml = await import("../src/services/security/saml-user-mapping.service.js");
    identityMode = await import("../src/services/identity/identity-mode.service.js");
    remediation = await import("../src/commands/remediate-domain-only-managed-links.js");
    deps = {
      prisma: prisma as never,
      tag: `b5b-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
    await idp.start();

    org = await fx.seedOrganizationTenant(deps, { managedIdentityRequired: true });
    domain = await fx.verifyOrganizationDomain(deps, org.organizationId, org.owner.userId);
    const created = await scim.createScimToken({
      teamId: org.workspaceId,
      name: "b5b",
      scopes: ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"],
      actorUserId: org.owner.userId,
    } as never);
    scimToken = (created as unknown as { tokenOnce: string }).tokenOnce;

    const conn = await sso.createSsoConnection({
      teamId: org.workspaceId,
      provider: "GENERIC_OIDC",
      displayName: "Local OIDC",
      issuerUrl: "https://placeholder.example.test/.well-known/openid-configuration",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      allowedEmailDomains: [domain],
      jitDefaultRole: "MEMBER",
      actorUserId: org.owner.userId,
    } as never);
    connectionId = conn.projection.id;
    await prisma.ssoConnection.update({
      where: { id: connectionId },
      data: { issuerUrl: `${idp.base}/.well-known/openid-configuration` },
    });
    await sso.transitionSsoConnection({
      teamId: org.workspaceId,
      id: connectionId,
      nextStatus: "ACTIVE",
      actorUserId: org.owner.userId,
    });
  }, 300_000);

  afterAll(async () => {
    await idp.stop();
    if (originalLoopback === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
    else process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = originalLoopback;
    if (originalWeb === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = originalWeb;
    await harness?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // SCIM
  // ---------------------------------------------------------------------------

  it("SCIM POST naming a pre-existing self-serve account → 409 uniqueness, the account untouched", async () => {
    const person = await selfServeAccount("scim-self", { password: true });
    const before = await fingerprint(person.id);
    expect(before.personalTeams).toBe(1);

    const res = await scimCall("POST", "/v2/scim/Users", scimUser(person.email));
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      schemas: [SCIM_ERROR],
      status: "409",
      scimType: "uniqueness",
      detail: "existing_account_requires_user_consent",
    });

    expect(await fingerprint(person.id)).toEqual(before);
    expect((before.user as { identityMode: string }).identityMode).toBe("STANDARD");
    expect(await identityMode.resolvePersonalSpaceEligibility(person.id)).toEqual({ allowed: true });
    await expect(identityMode.assertPersonalExportAllowed(person.id)).resolves.toBeUndefined();
  });

  let directoryPerson: { id: string; email: string; externalId: string };

  it("control: a brand-new address in the verified domain still provisions MANAGED, and a re-push is idempotent", async () => {
    const email = `new-${randomUUID().slice(0, 6)}@${domain}`;
    const externalId = `ext-${randomUUID()}`;
    const created = await scimCall("POST", "/v2/scim/Users", scimUser(email, externalId));
    expect(created.statusCode, created.body).toBe(201);
    const id = (JSON.parse(created.body) as Json).id as string;
    directoryPerson = { id, email, externalId };
    const managed = await identityMode.resolveManagedIdentity(id);
    expect(managed).toMatchObject({ state: "MANAGED", managingOrganizationId: org.organizationId, source: "SCIM" });

    const again = await scimCall("POST", "/v2/scim/Users", scimUser(email, externalId));
    expect(again.statusCode, again.body).toBe(200);
    expect((JSON.parse(again.body) as Json).id).toBe(id);
    expect((await identityMode.resolveManagedIdentity(id)).state).toBe("MANAGED");
  });

  it("deprovisioning releases MANAGED: org access ends, Personal Space returns, org data stays closed; reactivation re-binds", async () => {
    const { id, email } = directoryPerson;
    expect(await identityMode.resolvePersonalSpaceEligibility(id)).toMatchObject({ allowed: false, reason: "MANAGED_IDENTITY" });

    const del = await scimCall("DELETE", `/v2/scim/Users/${id}`);
    expect(del.statusCode, del.body).toBe(204);

    expect((await identityMode.resolveManagedIdentity(id)).state).toBe("STANDARD");
    expect(await identityMode.resolvePersonalSpaceEligibility(id)).toEqual({ allowed: true });
    await expect(identityMode.assertPersonalExportAllowed(id)).resolves.toBeUndefined();
    const member = await prisma.teamMember.findUniqueOrThrow({
      where: { teamId_userId: { teamId: org.workspaceId, userId: id } },
    });
    expect(member.status).toBe("SUSPENDED");
    expect(await prisma.externalIdentityMapping.count({ where: { userId: id, unlinkedAtUtc: null } })).toBe(0);

    // Sessions minted before the deprovisioning are revoked; a fresh one
    // cannot enter the Organization's workspace, and lands in Personal.
    await new Promise((r) => setTimeout(r, 1100));
    const t = await freshToken(id, email);
    const intoOrg = await harness.app.inject({
      method: "POST",
      url: "/v1/platform/context/switch-workspace",
      headers: bearer(t),
      payload: { workspaceId: org.workspaceId },
    });
    expect(intoOrg.statusCode, intoOrg.body).toBe(403);
    const toPersonal = await harness.app.inject({
      method: "POST",
      url: "/v1/platform/context/switch-workspace",
      headers: bearer(t),
      payload: { workspaceId: null },
    });
    expect(toPersonal.statusCode, toPersonal.body).toBe(200);

    // The directory re-grants an account it created: MANAGED again.
    const back = await scimCall("PATCH", `/v2/scim/Users/${id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await identityMode.resolveManagedIdentity(id)).toMatchObject({
      state: "MANAGED",
      managingOrganizationId: org.organizationId,
    });
  });

  // ---------------------------------------------------------------------------
  // SAML JIT (the mapping authority the ACS calls)
  // ---------------------------------------------------------------------------

  const assertion = (email: string, nameId = email) =>
    ({
      nameId,
      nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      nameIdHash: createHash("sha256").update(nameId).digest("hex"),
      sessionIndex: null,
      inResponseTo: null,
      issuer: "https://idp.example.test",
      attributes: {},
      authnContextClassRef: null,
      notBefore: null,
      notOnOrAfter: null,
      audienceRestriction: [],
    }) as never;
  const samlInput = (email: string) =>
    ({
      teamId: org.workspaceId,
      connectionId: randomUUID(),
      provider: "GENERIC_SAML",
      assertion: assertion(email),
      attributeMapping: null,
      allowedEmailDomains: [domain],
      jitDefaultRole: "MEMBER",
      scimManaged: false,
    }) as never;

  it("SAML JIT for a pre-existing self-serve account → coded refusal, no link, no membership; a new address still provisions", async () => {
    const person = await selfServeAccount("saml-self");
    const before = await fingerprint(person.id);
    const err = await saml.handleSamlAssertion(samlInput(person.email), prisma as never).catch((e) => e);
    expect(err).toBeInstanceOf(saml.SamlMappingError);
    expect((err as { code: string }).code).toBe("SAML_ACCOUNT_LINK_REQUIRES_CONSENT");
    expect(await fingerprint(person.id)).toEqual(before);

    const fresh = `saml-new-${randomUUID().slice(0, 6)}@${domain}`;
    const ok = await saml.handleSamlAssertion(samlInput(fresh), prisma as never);
    expect(ok.isNewlyProvisioned).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ok.userId }, select: { providerUserId: true } });
    expect(row.providerUserId.startsWith(`saml-${org.organizationId}:`)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // OIDC JIT + the owner's consent
  // ---------------------------------------------------------------------------

  it("OIDC sign-in for a pre-existing self-serve account → no link, no session; the owner approves signed in and keeps Personal Space and export", async () => {
    const person = await selfServeAccount("oidc-self", { password: true });
    idp.subject = `subject-${randomUUID()}`;
    idp.email = person.email;
    const before = await fingerprint(person.id);

    const refused = await oidcSignIn();
    expect(refused.statusCode).toBe(302);
    expect(String(refused.headers.location)).toContain("sso_error=sso_account_link_requires_consent");
    const jar = cookies(refused);
    expect(jar["proovra_session"]).toBeUndefined();
    expect(jar["proovra_org_link"]).toBeTruthy();
    expect(await fingerprint(person.id)).toEqual(before);
    expect(await prisma.authenticatedSession.count({ where: { userId: person.id, ssoConnectionId: connectionId } })).toBe(0);

    // The owner signs in to their own account and reviews the pending link.
    const token = await freshToken(person.id, person.email);
    const linkCookie = `proovra_org_link=${jar["proovra_org_link"]}`;
    const review = await harness.app.inject({
      method: "GET",
      url: "/v1/identity/links/organization",
      headers: { ...bearer(token), cookie: linkCookie },
    });
    expect(review.statusCode, review.body).toBe(200);
    expect((review.json() as { pending: Json }).pending).toMatchObject({
      organizationId: org.organizationId,
      protocol: "OIDC",
      convertsToManagedIdentity: false,
    });

    // Another account cannot spend this ticket.
    const stranger = await fx.seedUser(deps, "stranger");
    const wrong = await harness.app.inject({
      method: "POST",
      url: "/v1/identity/links/organization",
      headers: { ...bearer(stranger.token), cookie: linkCookie, "content-type": "application/json" },
      payload: { stepUp: { method: "password", currentPassword: PASSWORD } },
    });
    expect(wrong.statusCode, wrong.body).toBe(403);

    // Approval requires the account step-up.
    const noProof = await harness.app.inject({
      method: "POST",
      url: "/v1/identity/links/organization",
      headers: { ...bearer(token), cookie: linkCookie, "content-type": "application/json" },
      payload: {},
    });
    expect(noProof.statusCode, noProof.body).not.toBe(200);
    expect(await prisma.externalIdentityMapping.count({ where: { userId: person.id } })).toBe(0);

    const approved = await harness.app.inject({
      method: "POST",
      url: "/v1/identity/links/organization",
      headers: { ...bearer(token), cookie: linkCookie, "content-type": "application/json" },
      payload: { stepUp: { method: "password", currentPassword: PASSWORD } },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ linked: true, organizationId: org.organizationId, managedIdentity: false });

    const after = await fingerprint(person.id);
    expect(after.mappings).toBe(1);
    expect(after.orgWorkspaceMembers).toBe(1);
    expect((after.user as { identityMode: string }).identityMode).toBe("STANDARD");
    expect(after.personalTeams).toBe(1);
    expect(await identityMode.resolvePersonalSpaceEligibility(person.id)).toEqual({ allowed: true });
    await expect(identityMode.assertPersonalExportAllowed(person.id)).resolves.toBeUndefined();

    // The next SSO sign-in lands in the owner's account — and the
    // Organization's managed requirement still does not convert it.
    const signedIn = await oidcSignIn();
    expect(String(signedIn.headers.location)).toBe("https://web.example.test/home");
    expect(cookies(signedIn)["proovra_session"]).toBeTruthy();
    expect((await identityMode.resolveManagedIdentity(person.id)).state).toBe("STANDARD");
    expect(await identityMode.resolvePersonalSpaceEligibility(person.id)).toEqual({ allowed: true });

    // …and a later directory push for the same person is still refused.
    const push = await scimCall("POST", "/v2/scim/Users", scimUser(person.email));
    expect(push.statusCode, push.body).toBe(409);
    expect((await identityMode.resolveManagedIdentity(person.id)).state).toBe("STANDARD");
  });

  it("control: OIDC JIT for a brand-new address still creates the account and signs in", async () => {
    idp.subject = `subject-${randomUUID()}`;
    idp.email = `oidc-new-${randomUUID().slice(0, 6)}@${domain}`;
    const res = await oidcSignIn();
    expect(String(res.headers.location)).toBe("https://web.example.test/home");
    expect(cookies(res)["proovra_session"]).toBeTruthy();
    const row = await prisma.user.findFirstOrThrow({ where: { email: idp.email }, select: { id: true, providerUserId: true } });
    expect(row.providerUserId.startsWith(`sso-${org.organizationId}:`)).toBe(true);
    expect((await identityMode.resolveManagedIdentity(row.id)).state).toBe("MANAGED");
  });

  it("OIDC sign-in fails CLOSED when the MFA enforcement resolver throws: 503, no session", async () => {
    idp.subject = `subject-${randomUUID()}`;
    idp.email = `oidc-mfa-${randomUUID().slice(0, 6)}@${domain}`;
    M.mfaThrows = true;
    try {
      const res = await oidcSignIn();
      expect(res.statusCode, res.body).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe("SECURITY_CONTEXT_UNAVAILABLE");
      expect(cookies(res)["proovra_session"]).toBeUndefined();
      const row = await prisma.user.findFirst({ where: { email: idp.email }, select: { id: true } });
      if (row) {
        expect(await prisma.authenticatedSession.count({ where: { userId: row.id } })).toBe(0);
      }
    } finally {
      M.mfaThrows = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Remediation of accounts already converted by domain-only linking
  // ---------------------------------------------------------------------------

  it("remediation: dry run lists an affected account and changes nothing; apply releases it; a second apply is a no-op; an org-created account is never listed", async () => {
    // What the pre-fix code left behind: a self-serve account linked by a
    // directory push on the domain alone and converted to MANAGED.
    const victim = await selfServeAccount("affected", { password: true });
    await prisma.externalIdentityMapping.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        userId: victim.id,
        provider: "GENERIC_SCIM",
        externalSubjectId: `legacy-${randomUUID()}`,
        externalEmail: victim.email,
      },
    });
    await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: victim.id, role: "MEMBER", status: "ACTIVE" },
    });
    await prisma.user.update({
      where: { id: victim.id },
      data: {
        identityMode: "MANAGED_ENTERPRISE",
        managingOrganizationId: org.organizationId,
        managedIdentitySource: "SCIM",
      } as never,
    });
    expect(await identityMode.resolvePersonalSpaceEligibility(victim.id)).toMatchObject({ allowed: false });

    const dry = await remediation.remediateDomainOnlyManagedLinks(prisma as never);
    expect(dry.dryRun).toBe(true);
    const listed = dry.affected.find((a) => a.userId === victim.id);
    expect(listed).toMatchObject({
      organizationId: org.organizationId,
      managedIdentitySource: "SCIM",
      hasPassword: true,
      hasPersonalWorkspace: true,
      providerIdKind: "EMAIL_ADDRESS",
      liveOrganizationMappings: 1,
    });
    // The Organization's own directory person (MANAGED again after reactivation) is not listed.
    expect(dry.affected.some((a) => a.userId === directoryPerson.id)).toBe(false);
    expect(dry.remediated).toBe(0);
    expect((await identityMode.resolveManagedIdentity(victim.id)).state).toBe("MANAGED");

    const applied = await remediation.remediateDomainOnlyManagedLinks(prisma as never, { apply: true });
    expect(applied.affected.some((a) => a.userId === victim.id)).toBe(true);
    expect(applied.remediated).toBeGreaterThanOrEqual(1);
    expect((await identityMode.resolveManagedIdentity(victim.id)).state).toBe("STANDARD");
    expect(await identityMode.resolvePersonalSpaceEligibility(victim.id)).toEqual({ allowed: true });
    expect(await prisma.externalIdentityMapping.count({ where: { userId: victim.id, unlinkedAtUtc: null } })).toBe(0);
    // Kept as an ordinary member.
    const member = await prisma.teamMember.findUniqueOrThrow({
      where: { teamId_userId: { teamId: org.workspaceId, userId: victim.id } },
    });
    expect(member.status).toBe("ACTIVE");
    // The Organization's directory person stays MANAGED.
    expect((await identityMode.resolveManagedIdentity(directoryPerson.id)).state).toBe("MANAGED");

    const second = await remediation.remediateDomainOnlyManagedLinks(prisma as never, { apply: true });
    expect(second.affected.some((a) => a.userId === victim.id)).toBe(false);
    expect(second.remediated).toBe(0);

    // A directory reactivation cannot re-convert the released account.
    const reconvert = await scimCall("PATCH", `/v2/scim/Users/${victim.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(reconvert.statusCode, reconvert.body).toBe(409);
    expect((await identityMode.resolveManagedIdentity(victim.id)).state).toBe("STANDARD");
  });
});
