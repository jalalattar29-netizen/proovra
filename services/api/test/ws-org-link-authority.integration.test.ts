/**
 * PRO-A2-02 (High) — AN ORGANIZATION'S IdP NEVER AUTHENTICATES A SELF-SERVE
 * PERSON WITHOUT THAT PERSON'S CURRENT, SUBJECT-BOUND CONSENT.
 *
 * End to end against a disposable PostgreSQL 16: the real OIDC callback route
 * (handleOidcCallback behind /v1/auth/sso/callback, a local stand-in IdP on
 * loopback — no real IdP is exercised), the SAML mapping authority the ACS
 * calls (handleSamlAssertion), the real /v2/scim routes and the real
 * /v1/orgs/:id/leave route.
 *
 *   an administrator-made link on a self-serve member      → refused, no session
 *   a pre-column link + a consent grant naming no subject  → refused, no session
 *     (the owner approved subject S1; an administrator then linked S2)
 *   a pre-column link + a grant naming ANOTHER subject     → refused
 *   a pre-column link + a grant naming THIS subject        → signs in
 *   an owner-consented link, active member (control)       → signs in
 *   the same link after the person left the Organization   → refused; the link
 *     is not unlinked and nobody is signed out
 *   SCIM PATCH / DELETE for a pre-column administrator link→ 404, nothing changed
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant } from "./point7/product-fixtures.js";

const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const CLIENT_ID = "wsorg-client";
const CLIENT_SECRET = "wsorg-client-secret-value";

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

describe("PRO-A2-02 — a stored organization link is honoured only on current, subject-bound owner consent (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let sso: typeof import("../src/services/access-control/sso.service.js");
  let saml: typeof import("../src/services/security/saml-user-mapping.service.js");
  let linking: typeof import("../src/services/security/enterprise-account-linking.service.js");
  let stepUpIdp: typeof import("../src/services/identity-security/step-up-idp.js");
  let deps: FixtureDeps;
  const idp = new LocalIdp();
  const originalLoopback = process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
  const originalWeb = process.env.WEB_BASE_URL;

  let org: OrganizationTenant;
  let domain: string;
  let scimToken: string;
  let connectionId: string;

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
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

  /** A person who opened their own account and is an ordinary member of the Organization. */
  async function selfServeMember(label: string) {
    const seeded = await fx.seedUser(deps, label);
    const email = `${label}-${randomUUID().slice(0, 6)}@${domain}`;
    await prisma.user.update({ where: { id: seeded.userId }, data: { email, providerUserId: email } });
    await fx.bootstrapPersonalSpace(deps, seeded.userId);
    const om = await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: seeded.userId, role: "ORG_MEMBER" },
      select: { id: true },
    });
    const tm = await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: seeded.userId, role: "MEMBER", status: "ACTIVE" },
      select: { id: true },
    });
    const token = deps.mintToken(seeded.userId, email);
    await fx.registerSessionForToken(deps, seeded.userId, token);
    return { id: seeded.userId, email, token, orgMembershipId: om.id, teamMemberId: tm.id };
  }

  const link = (
    userId: string,
    provider: "GENERIC_OIDC" | "GENERIC_SAML",
    subject: string,
    linkSource: string | null,
  ) =>
    prisma.externalIdentityMapping.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        userId,
        provider,
        externalSubjectId: subject,
        ...(linkSource ? { linkSource } : {}),
      } as never,
      select: { id: true },
    });

  const consentGrant = (teamMemberId: string, externalRef: string) =>
    prisma.membershipGrant.create({
      data: { teamMemberId, source: "SSO_JIT", intent: "SSO_JIT", externalRef } as never,
    });

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

  /** The real OIDC round trip: initiate, then the callback (handleOidcCallback). */
  async function oidcSignIn(subject: string, email: string) {
    idp.subject = subject;
    idp.email = email;
    const init = await harness.app.inject({ method: "GET", url: `/v1/auth/sso/${connectionId}/initiate?redirectAfter=%2Fhome` });
    expect(init.statusCode, init.body).toBe(302);
    const target = new URL(String(init.headers.location));
    idp.pending = { nonce: target.searchParams.get("nonce")!, challenge: target.searchParams.get("code_challenge")! };
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/auth/sso/callback?state=${encodeURIComponent(target.searchParams.get("state")!)}&code=auth-code-12345`,
      headers: {
        cookie: Object.entries(cookies(init))
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
    });
    return { location: String(res.headers.location ?? ""), session: cookies(res)["proovra_session"] };
  }

  const ssoSessions = (userId: string) =>
    prisma.authenticatedSession.count({ where: { userId, ssoConnectionId: connectionId } });

  async function expectOidcRefused(userId: string, subject: string, email: string, code: string) {
    const before = await ssoSessions(userId);
    const res = await oidcSignIn(subject, email);
    expect(res.location).toContain(`sso_error=${code}`);
    expect(res.session).toBeUndefined();
    expect(await ssoSessions(userId)).toBe(before);
  }

  const samlAssertion = (email: string, nameId: string) =>
    ({
      nameId,
      nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      nameIdHash: createHash("sha256").update(nameId).digest("hex"),
      sessionIndex: null,
      inResponseTo: null,
      issuer: "https://idp.example.test",
      attributes: { email: [email] },
      authnContextClassRef: null,
      notBefore: null,
      notOnOrAfter: null,
      audienceRestriction: [],
    }) as never;
  /** The mapping authority the SAML ACS calls with a validated assertion. */
  const samlSignIn = (email: string, nameId: string) =>
    saml.handleSamlAssertion(
      {
        teamId: org.workspaceId,
        connectionId: randomUUID(),
        provider: "GENERIC_SAML",
        assertion: samlAssertion(email, nameId),
        attributeMapping: null,
        allowedEmailDomains: [domain],
        jitDefaultRole: "MEMBER",
        scimManaged: false,
      } as never,
      prisma as never,
    );
  async function expectSamlRefused(email: string, nameId: string, code: string) {
    const err = await samlSignIn(email, nameId).catch((e) => e);
    expect(err).toBeInstanceOf(saml.SamlMappingError);
    expect((err as { code: string }).code).toBe(code);
  }

  const leave = async (person: { token: string }) => {
    const left = await harness.app.inject({
      method: "POST",
      url: `/v1/orgs/${org.organizationId}/leave`,
      headers: bearer(person.token),
      payload: {},
    });
    expect(left.statusCode, left.body).toBe(200);
  };

  beforeAll(async () => {
    process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = "1";
    process.env.WEB_BASE_URL = "https://web.example.test";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const jwt = await import("../src/services/jwt.js");
    fx = await import("./point7/product-fixtures.js");
    scim = await import("../src/services/access-control/scim.service.js");
    sso = await import("../src/services/access-control/sso.service.js");
    saml = await import("../src/services/security/saml-user-mapping.service.js");
    linking = await import("../src/services/security/enterprise-account-linking.service.js");
    stepUpIdp = await import("../src/services/identity-security/step-up-idp.js");
    deps = {
      prisma: prisma as never,
      tag: `wsla-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
    await idp.start();

    org = await fx.seedOrganizationTenant(deps);
    domain = await fx.verifyOrganizationDomain(deps, org.organizationId, org.owner.userId);
    const created = await scim.createScimToken({
      teamId: org.workspaceId,
      name: "wsla",
      scopes: ["users.read", "users.write", "users.deactivate"],
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
  // OIDC — the real callback
  // ---------------------------------------------------------------------------

  it("OIDC: an administrator-made link on a self-serve member mints no session, whichever address the IdP asserts", async () => {
    const victim = await selfServeMember("oidc-admin");
    const subject = `attacker-${randomUUID()}`;
    await link(victim.id, "GENERIC_OIDC", subject, "ADMIN_MANUAL");

    // The administrator's IdP asserts an address of its own choosing…
    await expectOidcRefused(victim.id, subject, `someone-${randomUUID().slice(0, 6)}@${domain}`, "sso_account_link_denied");
    // …or the member's own: the owner-consent path, still no session.
    await expectOidcRefused(victim.id, subject, victim.email, "sso_account_link_requires_consent");
  });

  it("OIDC: a pre-column link is refused on a consent grant that names no subject or another subject, and honoured on one that names it", async () => {
    const victim = await selfServeMember("oidc-legacy");
    // The owner once approved subject S1 (pre-rule evidence: provider and
    // connection only); an administrator then unlinked S1 and linked S2.
    const s2 = `s2-${randomUUID()}`;
    await link(victim.id, "GENERIC_OIDC", s2, null);
    await consentGrant(victim.teamMemberId, `org-link:GENERIC_OIDC:${connectionId}`);
    await expectOidcRefused(victim.id, s2, victim.email, "sso_account_link_requires_consent");
    await expectOidcRefused(victim.id, s2, `other-${randomUUID().slice(0, 6)}@${domain}`, "sso_account_link_denied");

    // Evidence bound to a DIFFERENT subject proves nothing about this link.
    await consentGrant(
      victim.teamMemberId,
      linking.organizationLinkConsentRef({ provider: "GENERIC_OIDC", connectionId, externalSubjectId: `s1-${randomUUID()}` }),
    );
    await expectOidcRefused(victim.id, s2, victim.email, "sso_account_link_requires_consent");

    // Evidence bound to THIS provider and THIS subject is the owner's consent.
    await consentGrant(
      victim.teamMemberId,
      linking.organizationLinkConsentRef({ provider: "GENERIC_OIDC", connectionId, externalSubjectId: s2 }),
    );
    const ok = await oidcSignIn(s2, victim.email);
    expect(ok.location).toBe("https://web.example.test/home");
    expect(ok.session).toBeTruthy();
  });

  it("OIDC: an owner-consented link signs in while the person is an active member, and is refused once they left — not unlinked, nobody signed out", async () => {
    const person = await selfServeMember("oidc-leave");
    const subject = `consented-${randomUUID()}`;
    const mapping = await link(person.id, "GENERIC_OIDC", subject, "OWNER_CONSENT");

    const ok = await oidcSignIn(subject, person.email);
    expect(ok.location).toBe("https://web.example.test/home");
    expect(ok.session).toBeTruthy();
    expect(
      await stepUpIdp.resolveLinkedUserForSubject(prisma as never, {
        organizationId: org.organizationId,
        provider: "GENERIC_OIDC",
        externalSubjectId: subject,
      }),
    ).toBe(person.id);

    await leave(person);
    const revokedBefore = await prisma.revokedSession.count({ where: { userId: person.id } });
    await expectOidcRefused(person.id, subject, person.email, "sso_account_link_denied");
    // Refused at use time only: the link stays, and the refusal ends no session.
    expect((await prisma.externalIdentityMapping.findUniqueOrThrow({ where: { id: mapping.id } })).unlinkedAtUtc).toBeNull();
    expect(await prisma.revokedSession.count({ where: { userId: person.id } })).toBe(revokedBefore);
    expect(
      await stepUpIdp.resolveLinkedUserForSubject(prisma as never, {
        organizationId: org.organizationId,
        provider: "GENERIC_OIDC",
        externalSubjectId: subject,
      }),
    ).toBeNull();
    expect(
      await linking.evaluateExternalLinkAuthority({
        userId: person.id,
        organizationId: org.organizationId,
        provider: "GENERIC_OIDC",
        externalSubjectId: subject,
        linkSource: "OWNER_CONSENT",
      }),
    ).toEqual({ honoured: false, reason: "owner_consent_membership_ended" });
  });

  // ---------------------------------------------------------------------------
  // SAML — the mapping authority the ACS calls
  // ---------------------------------------------------------------------------

  it("SAML: an administrator-made link and a pre-column link with an unbound consent grant are both refused", async () => {
    const victim = await selfServeMember("saml-admin");
    const subject = `saml-attacker-${randomUUID()}`;
    await link(victim.id, "GENERIC_SAML", subject, "ADMIN_MANUAL");
    await expectSamlRefused(`someone-${randomUUID().slice(0, 6)}@${domain}`, subject, "SAML_ACCOUNT_LINK_DENIED");
    await expectSamlRefused(victim.email, subject, "SAML_ACCOUNT_LINK_REQUIRES_CONSENT");

    const legacyVictim = await selfServeMember("saml-legacy");
    const s2 = `saml-s2-${randomUUID()}`;
    await link(legacyVictim.id, "GENERIC_SAML", s2, null);
    await consentGrant(legacyVictim.teamMemberId, `org-link:GENERIC_SAML:${randomUUID()}`);
    await expectSamlRefused(`other-${randomUUID().slice(0, 6)}@${domain}`, s2, "SAML_ACCOUNT_LINK_DENIED");
    await expectSamlRefused(legacyVictim.email, s2, "SAML_ACCOUNT_LINK_REQUIRES_CONSENT");
  });

  it("SAML: an owner-consented link signs in while the person is an active member, and is refused once they left", async () => {
    const person = await selfServeMember("saml-leave");
    const subject = `saml-consented-${randomUUID()}`;
    const mapping = await link(person.id, "GENERIC_SAML", subject, "OWNER_CONSENT");

    const ok = await samlSignIn(person.email, subject);
    expect(ok.userId).toBe(person.id);
    expect(ok.isNewlyProvisioned).toBe(false);

    await leave(person);
    await expectSamlRefused(person.email, subject, "SAML_ACCOUNT_LINK_DENIED");
    expect((await prisma.externalIdentityMapping.findUniqueOrThrow({ where: { id: mapping.id } })).unlinkedAtUtc).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // SCIM — the directory's reach is an allow-list
  // ---------------------------------------------------------------------------

  it("SCIM: the directory cannot change the role or the status of a self-serve member through a pre-column administrator link; an owner-consented member is within reach", async () => {
    const victim = await selfServeMember("scim-legacy");
    await link(victim.id, "GENERIC_OIDC", `scim-s2-${randomUUID()}`, null);
    await consentGrant(victim.teamMemberId, `org-link:GENERIC_OIDC:${connectionId}`);

    const roleFlip = await scimCall("PATCH", `/v2/scim/Users/${victim.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "userType", value: "VIEWER" }],
    });
    expect(roleFlip.statusCode, roleFlip.body).toBe(404);
    const deactivate = await scimCall("PATCH", `/v2/scim/Users/${victim.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(deactivate.statusCode, deactivate.body).toBe(404);
    const del = await scimCall("DELETE", `/v2/scim/Users/${victim.id}`);
    expect(del.statusCode, del.body).toBe(404);
    const untouched = await prisma.teamMember.findUniqueOrThrow({
      where: { id: victim.teamMemberId },
      select: { role: true, status: true },
    });
    expect(untouched).toEqual({ role: "MEMBER", status: "ACTIVE" });
    expect(
      (await prisma.organizationMembership.findUniqueOrThrow({ where: { id: victim.orgMembershipId }, select: { status: true } })).status,
    ).toBe("ACTIVE");

    // Control: the owner consented to this subject and is an active member.
    const consented = await selfServeMember("scim-consented");
    await link(consented.id, "GENERIC_OIDC", `scim-ok-${randomUUID()}`, "OWNER_CONSENT");
    const allowed = await scimCall("PATCH", `/v2/scim/Users/${consented.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "userType", value: "VIEWER" }],
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(
      (await prisma.teamMember.findUniqueOrThrow({ where: { id: consented.teamMemberId }, select: { role: true } })).role,
    ).toBe("VIEWER");
  });
});
