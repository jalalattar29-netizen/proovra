/**
 * PRO-A2-02 — owner decision A (2026-11-21): THE LIFETIME OF A SELF-SERVE
 * OWNER'S CONSENT TO AN ORGANIZATION IdP LINK.
 *
 * End to end against a disposable PostgreSQL 16 (the migration's triggers are
 * live). Every scenario is read by all four readers of a stored link:
 *
 *   OIDC sign-in   the real /v1/auth/sso/callback (local stand-in IdP on loopback)
 *   SAML sign-in   handleSamlAssertion, the mapping authority the ACS calls
 *   IdP step-up    resolveLinkedUserForSubject, the subject resolver of the
 *                  IDP_REAUTH rung
 *   SCIM           the real /v2/scim/Users/:id PATCH (the directory's reach)
 *
 * Consent is given ONLY through approveOrganizationLink (the owner-approval
 * flow behind POST /v1/identity/links/organization).
 *
 *   leave / removal / expiry       → refused; consent row ended, link kept
 *   rejoin                         → refused until a fresh approval, then allowed
 *   suspension                     → refused immediately; reactivation refused
 *                                    until a fresh approval (approval while
 *                                    suspended records nothing)
 *   withdrawal                     → stepped-up, own consent only; then refused
 *   legacy links (pre-decision)    → refused until approved; the remediation
 *                                    command never records consent
 *   another connection             → the consent does not carry over
 *   organization-originated link   → unaffected, no consent involved
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant } from "./point7/product-fixtures.js";

const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const CLIENT_ID = "a202-client";
const CLIENT_SECRET = "a202-client-secret-value";
const PASSWORD = "Consent-Withdraw-Pass-1234";

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

type Person = {
  id: string;
  email: string;
  token: string;
  orgMembershipId: string;
  teamMemberId: string;
  oidcSubject: string;
  samlSubject: string;
};

describe("PRO-A2-02 decision A — a self-serve IdP link is honoured only on the owner's current consent (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let deps: FixtureDeps;
  // Application modules load AFTER the harness has pointed the process at this
  // suite's database (the sibling ws-org-link-authority suite does the same).
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let sso: typeof import("../src/services/access-control/sso.service.js");
  let saml: typeof import("../src/services/security/saml-user-mapping.service.js");
  let linking: typeof import("../src/services/security/enterprise-account-linking.service.js");
  let stepUpIdp: typeof import("../src/services/identity-security/step-up-idp.js");
  let consentFlow: typeof import("../src/services/identity/organization-link-consent.service.js");
  let legacy: typeof import("../src/commands/remediate-admin-manual-identity-links.js");
  let external: typeof import("../src/services/identity/external-identity.service.js");
  let stepUp: typeof import("../src/services/identity-security/step-up.service.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  const idp = new LocalIdp();
  const originalLoopback = process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
  const originalWeb = process.env.WEB_BASE_URL;

  let org: OrganizationTenant;
  let domain: string;
  let scimToken: string;
  let oidcConnectionId: string;
  let samlConnectionId: string;
  let otherSamlConnectionId: string;

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

  /** A person who opened their own account and is an ordinary member of the Organization. */
  async function selfServeMember(label: string, opts: { password?: boolean } = {}): Promise<Person> {
    const seeded = await fx.seedUser(deps, label);
    const email = `${label}-${randomUUID().slice(0, 6)}@${domain}`;
    await prisma.user.update({
      where: { id: seeded.userId },
      data: {
        email,
        providerUserId: email,
        ...(opts.password ? { passwordHash: await hashPassword(PASSWORD) } : {}),
      },
    });
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
    return {
      id: seeded.userId,
      email,
      token,
      orgMembershipId: om.id,
      teamMemberId: tm.id,
      oidcSubject: `oidc-${label}-${randomUUID()}`,
      samlSubject: `saml-${label}-${randomUUID()}`,
    };
  }

  /** The owner approves (the ONLY consent writer) — one OIDC and one SAML link. */
  async function approve(person: Person, protocol: "OIDC" | "SAML") {
    return consentFlow.approveOrganizationLink(
      {
        userId: person.id,
        pending: {
          connectionId: protocol === "OIDC" ? oidcConnectionId : samlConnectionId,
          organizationId: org.organizationId,
          teamId: org.workspaceId,
          provider: protocol === "OIDC" ? "GENERIC_OIDC" : "GENERIC_SAML",
          protocol,
          subject: protocol === "OIDC" ? person.oidcSubject : person.samlSubject,
          email: person.email,
          displayName: null,
          userId: person.id,
          role: "MEMBER",
          organizationName: null,
          organizationRestrictsPersonalSpace: false,
        },
      },
      prisma as never,
    );
  }
  async function approveBoth(person: Person) {
    expect((await approve(person, "OIDC")).kind).toBe("ok");
    expect((await approve(person, "SAML")).kind).toBe("ok");
  }

  /** The real OIDC round trip: initiate, then the callback (handleOidcCallback). */
  async function oidcSignIn(subject: string, email: string) {
    idp.subject = subject;
    idp.email = email;
    const init = await harness.app.inject({
      method: "GET",
      url: `/v1/auth/sso/${oidcConnectionId}/initiate?redirectAfter=%2Fhome`,
    });
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
  const samlSignIn = (email: string, nameId: string, connectionId = samlConnectionId) =>
    saml.handleSamlAssertion(
      {
        teamId: org.workspaceId,
        connectionId,
        provider: "GENERIC_SAML",
        assertion: samlAssertion(email, nameId),
        attributeMapping: null,
        allowedEmailDomains: [domain],
        jitDefaultRole: "MEMBER",
        scimManaged: false,
      } as never,
      prisma as never,
    );

  const stepUpResolves = (subject: string, provider = "GENERIC_OIDC", connectionId = oidcConnectionId) =>
    stepUpIdp.resolveLinkedUserForSubject(prisma as never, {
      organizationId: org.organizationId,
      provider,
      externalSubjectId: subject,
      connectionId,
    });

  /** The directory's reach: a harmless userType write (MEMBER ↔ VIEWER alternately). */
  const scimRole = new Map<string, "MEMBER" | "VIEWER">();
  async function scimReach(person: Person): Promise<number> {
    const next = scimRole.get(person.id) === "VIEWER" ? "MEMBER" : "VIEWER";
    const res = await scimCall("PATCH", `/v2/scim/Users/${person.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "userType", value: next }],
    });
    if (res.statusCode === 200) scimRole.set(person.id, next);
    return res.statusCode;
  }

  const ssoSessions = (userId: string) =>
    prisma.authenticatedSession.count({ where: { userId, ssoConnectionId: oidcConnectionId } });

  /** Every reader honours the person's links. */
  async function expectAllowed(person: Person) {
    const ok = await oidcSignIn(person.oidcSubject, person.email);
    expect(ok.location, "OIDC sign-in").toBe("https://web.example.test/home");
    expect(ok.session).toBeTruthy();
    const samlOk = await samlSignIn(person.email, person.samlSubject);
    expect(samlOk.userId, "SAML sign-in").toBe(person.id);
    expect(await stepUpResolves(person.oidcSubject), "IdP step-up").toBe(person.id);
    expect(await stepUpResolves(person.samlSubject, "GENERIC_SAML", samlConnectionId), "IdP step-up (SAML)").toBe(person.id);
    expect(await scimReach(person), "SCIM reach").toBe(200);
  }

  /**
   * Every reader refuses. `fresh` = the person is an active member, so the
   * sign-in offers the owner-approval path; otherwise it is a plain denial.
   */
  async function expectRefused(person: Person, mode: "fresh_approval" | "not_a_member") {
    const before = await ssoSessions(person.id);
    const res = await oidcSignIn(person.oidcSubject, person.email);
    expect(res.location, "OIDC sign-in").toContain(
      mode === "fresh_approval" ? "sso_error=sso_account_link_requires_consent" : "sso_error=sso_account_link_denied",
    );
    expect(res.session).toBeUndefined();
    expect(await ssoSessions(person.id)).toBe(before);
    const err = await samlSignIn(person.email, person.samlSubject).catch((e) => e);
    expect(err, "SAML sign-in").toBeInstanceOf(saml.SamlMappingError);
    expect((err as { code: string }).code).toBe(
      mode === "fresh_approval" ? "SAML_ACCOUNT_LINK_REQUIRES_CONSENT" : "SAML_ACCOUNT_LINK_DENIED",
    );
    expect(await stepUpResolves(person.oidcSubject), "IdP step-up").toBeNull();
    expect(await stepUpResolves(person.samlSubject, "GENERIC_SAML", samlConnectionId), "IdP step-up (SAML)").toBeNull();
    expect(await scimReach(person), "SCIM reach").toBe(404);
  }

  const consents = (userId: string) =>
    prisma.identityLinkConsent.findMany({
      where: { userId, organizationId: org.organizationId },
      orderBy: { approvedAtUtc: "asc" },
    });
  const liveConsents = async (userId: string) => (await consents(userId)).filter((c) => c.endedAtUtc === null);

  async function linksKept(person: Person) {
    const rows = await prisma.externalIdentityMapping.findMany({
      where: { userId: person.id, organizationId: org.organizationId },
      select: { unlinkedAtUtc: true, linkSource: true },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.unlinkedAtUtc).toBeNull();
      expect(r.linkSource).toBe("OWNER_CONSENT");
    }
  }

  const orgRoute = (method: "POST" | "DELETE", url: string, token: string) =>
    harness.app.inject({ method, url, headers: bearer(token), payload: method === "POST" ? {} : undefined });

  beforeAll(async () => {
    process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = "1";
    process.env.WEB_BASE_URL = "https://web.example.test";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    fx = await import("./point7/product-fixtures.js");
    scim = await import("../src/services/access-control/scim.service.js");
    sso = await import("../src/services/access-control/sso.service.js");
    saml = await import("../src/services/security/saml-user-mapping.service.js");
    linking = await import("../src/services/security/enterprise-account-linking.service.js");
    stepUpIdp = await import("../src/services/identity-security/step-up-idp.js");
    consentFlow = await import("../src/services/identity/organization-link-consent.service.js");
    legacy = await import("../src/commands/remediate-admin-manual-identity-links.js");
    external = await import("../src/services/identity/external-identity.service.js");
    stepUp = await import("../src/services/identity-security/step-up.service.js");
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    deps = {
      prisma: prisma as never,
      tag: `a202-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        signJwt(
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
      name: "a202",
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
    oidcConnectionId = conn.projection.id;
    await prisma.ssoConnection.update({
      where: { id: oidcConnectionId },
      data: { issuerUrl: `${idp.base}/.well-known/openid-configuration` },
    });
    await sso.transitionSsoConnection({
      teamId: org.workspaceId,
      id: oidcConnectionId,
      nextStatus: "ACTIVE",
      actorUserId: org.owner.userId,
    });
    // SAML connections of the same workspace (approval re-validates the
    // connection; the ACS mapping authority is called with its id).
    const samlRow = (name: string, status: "ACTIVE" | "DISABLED") =>
      prisma.ssoConnection.create({
        data: {
          teamId: org.workspaceId,
          organizationId: org.organizationId,
          provider: "GENERIC_SAML",
          displayName: name,
          status,
          allowedEmailDomains: [domain],
          jitDefaultRole: "MEMBER",
          createdByUserId: org.owner.userId,
        } as never,
        select: { id: true },
      });
    samlConnectionId = (await samlRow("Local SAML", "ACTIVE")).id;
    // Another SAML connection of the Organization (one live per provider: this
    // one stands for a replaced / earlier connection the IdP could answer as).
    otherSamlConnectionId = (await samlRow("Second SAML", "DISABLED")).id;
  }, 300_000);

  afterAll(async () => {
    await idp.stop();
    if (originalLoopback === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
    else process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = originalLoopback;
    if (originalWeb === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = originalWeb;
    await harness?.cleanup();
  }, 300_000);

  it("leaving the Organization ends the consent: all four readers refuse; the link is kept and the ended consent stays as history", async () => {
    const p = await selfServeMember("leave");
    await approveBoth(p);
    await expectAllowed(p);

    expect((await orgRoute("POST", `/v1/orgs/${org.organizationId}/leave`, p.token)).statusCode).toBe(200);
    await expectRefused(p, "not_a_member");
    await linksKept(p);
    const rows = await consents(p.id);
    expect(rows).toHaveLength(2);
    for (const c of rows) {
      expect(c.endedAtUtc).not.toBeNull();
      expect(c.endReason).toBe("MEMBERSHIP_ENDED");
    }
  });

  it("removal by an administrator ends the consent: all four readers refuse", async () => {
    const p = await selfServeMember("removed");
    await approveBoth(p);
    await expectAllowed(p);

    const removed = await orgRoute("DELETE", `/v1/orgs/${org.organizationId}/members/${p.orgMembershipId}`, org.owner.token);
    expect(removed.statusCode, removed.body).toBe(200);
    await expectRefused(p, "not_a_member");
    await linksKept(p);
    expect(await liveConsents(p.id)).toHaveLength(0);
    expect((await consents(p.id)).every((c) => c.endReason === "MEMBERSHIP_ENDED")).toBe(true);
  });

  it("rejoining never revives the old consent: refused until the owner approves afresh, then allowed", async () => {
    const p = await selfServeMember("rejoin");
    await approveBoth(p);
    expect((await orgRoute("POST", `/v1/orgs/${org.organizationId}/leave`, p.token)).statusCode).toBe(200);

    // Re-added: the governance and workspace memberships are ACTIVE again (the
    // state an accepted re-invitation leaves).
    await prisma.organizationMembership.update({
      where: { id: p.orgMembershipId },
      data: { status: "ACTIVE", revokedAtUtc: null, revokedByUserId: null, revocationReason: null },
    });
    await prisma.teamMember.update({
      where: { id: p.teamMemberId },
      data: { status: "ACTIVE", revokedAtUtc: null, revokedByUserId: null, revocationReason: null },
    });
    expect(await linking.holdsActiveOrganizationMembership({ userId: p.id, organizationId: org.organizationId })).toBe(true);
    await expectRefused(p, "fresh_approval");
    expect(await liveConsents(p.id)).toHaveLength(0);

    await approveBoth(p);
    await expectAllowed(p);
    const rows = await consents(p.id);
    expect(rows).toHaveLength(4); // two ended by the departure, two fresh approvals
    expect(rows.filter((c) => c.endedAtUtc === null)).toHaveLength(2);
  });

  it("suspension refuses immediately; reactivation is refused until a fresh approval; approving while suspended records nothing", async () => {
    const p = await selfServeMember("suspend");
    await approveBoth(p);
    await expectAllowed(p);

    const suspended = await orgRoute("POST", `/v1/orgs/${org.organizationId}/members/${p.orgMembershipId}/suspend`, org.owner.token);
    expect(suspended.statusCode, suspended.body).toBe(200);
    await expectRefused(p, "not_a_member");
    expect((await consents(p.id)).every((c) => c.endReason === "MEMBERSHIP_SUSPENDED")).toBe(true);

    // An approval while suspended is refused and writes no consent.
    expect((await approve(p, "OIDC")).kind).toBe("membership_inactive");
    expect(await liveConsents(p.id)).toHaveLength(0);

    const restored = await orgRoute("POST", `/v1/orgs/${org.organizationId}/members/${p.orgMembershipId}/restore`, org.owner.token);
    expect(restored.statusCode, restored.body).toBe(200);
    await expectRefused(p, "fresh_approval");

    await approveBoth(p);
    await expectAllowed(p);
  });

  it("an expired membership window refuses; reopening the window does not revive the consent; a fresh approval does", async () => {
    // Governance window.
    const p = await selfServeMember("expiry-org");
    await approveBoth(p);
    await expectAllowed(p);
    await prisma.organizationMembership.update({
      where: { id: p.orgMembershipId },
      data: { validUntilUtc: new Date(Date.now() - 1000) },
    });
    await expectRefused(p, "not_a_member");
    await prisma.organizationMembership.update({ where: { id: p.orgMembershipId }, data: { validUntilUtc: null } });
    await expectRefused(p, "fresh_approval");
    expect((await consents(p.id)).every((c) => c.endReason === "MEMBERSHIP_EXPIRED")).toBe(true);
    await approveBoth(p);
    await expectAllowed(p);

    // A workspace access window that lapses with nobody writing anything: the
    // governance membership is still ACTIVE, yet the consent given before the
    // lapse is no longer current.
    const q = await selfServeMember("expiry-ws");
    await approveBoth(q);
    await prisma.teamMember.update({
      where: { id: q.teamMemberId },
      data: { accessExpiresAtUtc: new Date(Date.now() + 1500) },
    });
    await expectAllowed(q); // the window is still open
    await new Promise((r) => setTimeout(r, 1700));
    expect(await linking.holdsActiveOrganizationMembership({ userId: q.id, organizationId: org.organizationId })).toBe(true);
    await expectRefused(q, "fresh_approval");
    await prisma.teamMember.update({ where: { id: q.teamMemberId }, data: { accessExpiresAtUtc: null } });
    await expectRefused(q, "fresh_approval");
    await approveBoth(q);
    await expectAllowed(q);
  });

  it("withdrawal: the owner's stepped-up route ends the consent and every reader refuses; without step-up, by an administrator or by another person nothing changes", async () => {
    const p = await selfServeMember("withdraw", { password: true });
    await approveBoth(p);
    const other = await selfServeMember("withdraw-other");
    await approveBoth(other);
    const withdraw = (token: string, body: unknown) =>
      harness.app.inject({
        method: "POST",
        url: `/v1/identity/links/organization-consents/${org.organizationId}/withdraw`,
        headers: bearer(token),
        payload: body as never,
      });

    // The owner sees their own consents.
    const listed = await harness.app.inject({
      method: "GET",
      url: "/v1/identity/links/organization-consents",
      headers: bearer(p.token),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const view = JSON.parse(listed.body) as {
      consents: Array<{ organizationId: string; organizationName: string | null; endedAtUtc: string | null }>;
    };
    const mine = view.consents.filter((c) => c.organizationId === org.organizationId && c.endedAtUtc === null);
    expect(mine).toHaveLength(2);
    const orgRow = await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { name: true } });
    expect(mine.every((c) => c.organizationName === orgRow.name)).toBe(true);
    // Another person's list never shows this person's consents.
    const otherList = await harness.app.inject({
      method: "GET",
      url: "/v1/identity/links/organization-consents",
      headers: bearer(org.owner.token),
    });
    expect((JSON.parse(otherList.body) as { consents: unknown[] }).consents).toHaveLength(0);

    // No proof: the canonical account step-up refuses; nothing ended.
    const noProof = await withdraw(p.token, {});
    expect(noProof.statusCode, noProof.body).toBe(401);
    expect(JSON.parse(noProof.body)).toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });
    const wrong = await withdraw(p.token, { stepUp: { method: "password", currentPassword: "not-the-password-0" } });
    expect(wrong.statusCode, wrong.body).toBe(401);
    expect(await liveConsents(p.id)).toHaveLength(2);

    // The Organization owner (an administrator) cannot withdraw a member's
    // consent: the route only ever ends the caller's OWN consent.
    const byAdmin = await withdraw(org.owner.token, {});
    expect(byAdmin.statusCode, byAdmin.body).toBe(404);
    expect(await liveConsents(p.id)).toHaveLength(2);
    await expectAllowed(p);

    // The owner, stepped up, withdraws.
    const done = await withdraw(p.token, { stepUp: { method: "password", currentPassword: PASSWORD } });
    expect(done.statusCode, done.body).toBe(200);
    expect(JSON.parse(done.body)).toMatchObject({ withdrawn: true, count: 2 });
    await expectRefused(p, "fresh_approval");
    await linksKept(p);
    const rows = await consents(p.id);
    expect(rows.every((c) => c.endReason === "WITHDRAWN" && c.endedByUserId === p.id)).toBe(true);
    // Another person's consent is untouched.
    expect(await liveConsents(other.id)).toHaveLength(2);
    await expectAllowed(other);
    // Nothing left to withdraw.
    const again = await withdraw(p.token, { stepUp: { method: "password", currentPassword: PASSWORD } });
    expect(again.statusCode, again.body).toBe(404);

    // A fresh approval restores the link.
    await approveBoth(p);
    await expectAllowed(p);
  });

  it("legacy links: a pre-decision OWNER_CONSENT link and a pre-column link with a subject-bound grant are refused until the owner approves; the remediation command never records consent", async () => {
    const p = await selfServeMember("legacy");
    // Written by the previous release: owner-consented source, no consent row.
    await prisma.externalIdentityMapping.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        userId: p.id,
        provider: "GENERIC_OIDC",
        externalSubjectId: p.oidcSubject,
        linkSource: "OWNER_CONSENT",
      } as never,
    });
    // Pre-column link (NULL source) with the subject-bound grant the previous
    // rule accepted as evidence.
    const samlMapping = await prisma.externalIdentityMapping.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        userId: p.id,
        provider: "GENERIC_SAML",
        externalSubjectId: p.samlSubject,
      } as never,
      select: { id: true },
    });
    await prisma.membershipGrant.create({
      data: {
        teamMemberId: p.teamMemberId,
        source: "SSO_JIT",
        intent: "SSO_JIT",
        externalRef: linking.organizationLinkConsentRef({
          provider: "GENERIC_SAML",
          connectionId: samlConnectionId,
          externalSubjectId: p.samlSubject,
        }),
      } as never,
    });
    await expectRefused(p, "fresh_approval");

    // The repair command reports, never consents.
    const report = await legacy.remediateAdminManualIdentityLinks(prisma as never, { apply: true });
    expect(report.affected.find((a) => a.mappingId === samlMapping.id)?.evidence).toBe("BOUND_CONSENT_GRANT");
    expect((await prisma.externalIdentityMapping.findUniqueOrThrow({ where: { id: samlMapping.id } })).linkSource).toBeNull();
    expect(await consents(p.id)).toHaveLength(0);
    await expectRefused(p, "fresh_approval");

    await approveBoth(p);
    await expectAllowed(p);
  });

  it("consent is bound to the connection: a consent given through one SAML connection does not sign in through another connection of the Organization", async () => {
    const p = await selfServeMember("connection");
    await approveBoth(p);
    expect((await samlSignIn(p.email, p.samlSubject)).userId).toBe(p.id);
    const err = await samlSignIn(p.email, p.samlSubject, otherSamlConnectionId).catch((e) => e);
    expect(err).toBeInstanceOf(saml.SamlMappingError);
    expect((err as { code: string }).code).toBe("SAML_ACCOUNT_LINK_REQUIRES_CONSENT");
    expect(await stepUpResolves(p.samlSubject, "GENERIC_SAML", otherSamlConnectionId)).toBeNull();
  });

  it("consent history is append-only: a consent row cannot be deleted or un-ended, and no administrator path writes one", async () => {
    const p = await selfServeMember("history");
    await approveBoth(p);
    const [first] = await consents(p.id);
    await expect(prisma.identityLinkConsent.delete({ where: { id: first!.id } })).rejects.toThrow();
    await prisma.identityLinkConsent.update({
      where: { id: first!.id },
      data: { endedAtUtc: new Date(), endReason: "WITHDRAWN", endedByUserId: p.id },
    });
    await expect(
      prisma.identityLinkConsent.update({ where: { id: first!.id }, data: { endedAtUtc: null, endReason: null } }),
    ).rejects.toThrow();
    await expect(
      prisma.identityLinkConsent.updateMany({ where: { userId: p.id, endedAtUtc: null }, data: { subjectDigest: "0".repeat(64) } }),
    ).rejects.toThrow();

    // The administrator's manual link of a self-serve account (the service
    // behind POST /v1/identity/external-mappings) is refused and records no
    // consent.
    const q = await selfServeMember("history-admin");
    await expect(
      external.linkExternalIdentity({
        teamId: org.workspaceId,
        userId: q.id,
        provider: "GENERIC_OIDC" as never,
        externalSubjectId: q.oidcSubject,
        actorUserId: org.owner.userId,
      }),
    ).rejects.toMatchObject({ code: "owner_consent_required" });
    expect(await consents(q.id)).toHaveLength(0);

    // An approval naming another account than the signed-in owner records nothing.
    const mismatch = await consentFlow.approveOrganizationLink(
      {
        userId: org.owner.userId,
        pending: {
          connectionId: oidcConnectionId,
          organizationId: org.organizationId,
          teamId: org.workspaceId,
          provider: "GENERIC_OIDC",
          protocol: "OIDC",
          subject: q.oidcSubject,
          email: q.email,
          displayName: null,
          userId: q.id,
          role: "MEMBER",
          organizationName: null,
          organizationRestrictsPersonalSpace: false,
        },
      },
      prisma as never,
    );
    expect(mismatch.kind).toBe("account_mismatch");
    expect(await consents(q.id)).toHaveLength(0);
  });

  it("an organization-originated (directory / IdP-created) identity needs no consent and is unaffected", async () => {
    const seeded = await fx.seedUser(deps, "managed");
    const subject = `managed-${randomUUID()}`;
    const email = `managed-${randomUUID().slice(0, 6)}@${domain}`;
    await prisma.user.update({
      where: { id: seeded.userId },
      data: { email, providerUserId: `sso-${org.organizationId}:${subject}` },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: seeded.userId, role: "ORG_MEMBER" },
    });
    await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: seeded.userId, role: "MEMBER", status: "ACTIVE" },
    });
    await prisma.externalIdentityMapping.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        userId: seeded.userId,
        provider: "GENERIC_OIDC",
        externalSubjectId: subject,
        linkSource: "OIDC_JIT",
      } as never,
    });
    expect(
      await linking.evaluateExternalLinkAuthority({
        userId: seeded.userId,
        organizationId: org.organizationId,
        provider: "GENERIC_OIDC",
        externalSubjectId: subject,
        linkSource: "OIDC_JIT",
        connectionId: oidcConnectionId,
      }),
    ).toEqual({ honoured: true, basis: "ORGANIZATION_ORIGINATED" });
    const ok = await oidcSignIn(subject, email);
    expect(ok.location).toBe("https://web.example.test/home");
    expect(ok.session).toBeTruthy();
    expect(await stepUpResolves(subject)).toBe(seeded.userId);
    const res = await scimCall("PATCH", `/v2/scim/Users/${seeded.userId}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "userType", value: "VIEWER" }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await consents(seeded.userId)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Review follow-up 1 — the approval race. A suspension that commits while the
  // approval transaction is open must not leave a live consent beside a
  // SUSPENDED membership (a raw SUSPENDED→ACTIVE reactivation fires nothing and
  // writes no timestamp, so only the approval's row locks protect here).
  // ---------------------------------------------------------------------------

  it("a suspension committed while the approval transaction is open leaves no live consent: after reactivation the link is refused", async () => {
    const p = await selfServeMember("race");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let suspendedUncommitted!: () => void;
    const suspendedSignal = new Promise<void>((r) => (suspendedUncommitted = r));
    // Connection B: suspend (uncommitted), hold the transaction open. Its
    // suspension instant precedes the approval (the transaction began first),
    // so the timestamp defence cannot rescue a missing lock.
    const suspension = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "organization_memberships" SET "status" = 'SUSPENDED', "suspended_at_utc" = now() - interval '1 minute' WHERE "id" = $1::uuid`,
          p.orgMembershipId,
        );
        suspendedUncommitted();
        await gate;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await suspendedSignal;
    // Connection A: the owner approves while B is open.
    const approval = approve(p, "OIDC");
    await new Promise((r) => setTimeout(r, 1500));
    release();
    await suspension;
    const outcome = await approval;
    // Reactivation that records nothing (no timestamp, no trigger).
    await prisma.$executeRawUnsafe(
      `UPDATE "organization_memberships" SET "status" = 'ACTIVE', "suspended_at_utc" = NULL WHERE "id" = $1::uuid`,
      p.orgMembershipId,
    );
    expect(outcome.kind).toBe("membership_inactive");
    expect(await liveConsents(p.id)).toHaveLength(0);
    const res = await oidcSignIn(p.oidcSubject, p.email);
    expect(res.location).toContain("sso_error=sso_account_link_requires_consent");
    expect(await stepUpResolves(p.oidcSubject)).toBeNull();
  });

  it("defence in depth: a consent approved before the membership's last recorded status change is not current", async () => {
    const p = await selfServeMember("moved");
    await approveBoth(p);
    await expectAllowed(p);
    // A recorded governance transition after the approval (statusChangedAtUtc
    // alone fires no trigger): the consent predates the membership as it is.
    await prisma.organizationMembership.update({
      where: { id: p.orgMembershipId },
      data: { statusChangedAtUtc: new Date(Date.now() + 1000) },
    });
    await expectRefused(p, "fresh_approval");
    await prisma.organizationMembership.update({
      where: { id: p.orgMembershipId },
      data: { statusChangedAtUtc: new Date(Date.now() - 60_000) },
    });
    // A workspace suspension timestamp after the approval, likewise.
    await prisma.teamMember.update({
      where: { id: p.teamMemberId },
      data: { suspendedAtUtc: new Date(Date.now() + 1000) },
    });
    await expectRefused(p, "fresh_approval");
  });

  // ---------------------------------------------------------------------------
  // Review follow-up 2 — IdP step-up elevation after consent ends.
  // ---------------------------------------------------------------------------

  const CTX = "urn:proovra:test:ctx:strong";
  const PURPOSE = "COLLABORATION_TEAM_ARCHIVE";
  const RESOURCE = { resourceKind: "collaboration_team", resourceId: "a202-target" };

  async function acceptIdpContext() {
    const data = {
      stepUpAssurance: "STANDARD",
      stepUpSmsAllowed: true,
      idpStepUpAcceptedContexts: [CTX],
      idpStepUpMaxAgeSeconds: 300,
    };
    await prisma.organizationSecurityPolicy.upsert({
      where: { organizationId: org.organizationId },
      create: { organizationId: org.organizationId, policyVersion: 1, ...data } as never,
      update: data as never,
    });
  }
  /** An IdP-authenticated session on the OIDC connection carrying the accepted context. */
  async function idpSession(userId: string) {
    const sessionIdHash = createHash("sha256").update(randomUUID()).digest("hex");
    await prisma.authenticatedSession.create({
      data: {
        userId,
        sessionIdHash,
        expiresAtUtc: new Date(Date.now() + 3600_000),
        authMethod: "OIDC",
        ssoConnectionId: oidcConnectionId,
        authnContext: CTX,
        idpAuthAtUtc: new Date(),
      } as never,
    });
    return sessionIdHash;
  }
  const historySatisfies = (userId: string, sessionIdHash: string) =>
    stepUpIdp.sessionSatisfiesIdpStepUp(prisma as never, {
      sessionIdHash,
      userId,
      connectionId: oidcConnectionId,
      policy: { acceptedContexts: [CTX], maxAgeSeconds: 300, assurance: "STANDARD" } as never,
    });
  /** An IDP_REAUTH challenge the IdP already approved (not yet spent). */
  const approvedChallenge = (userId: string) =>
    prisma.stepUpChallenge.create({
      data: {
        teamId: org.workspaceId,
        initiatedByUserId: userId,
        organizationId: org.organizationId,
        purpose: PURPOSE,
        ...RESOURCE,
        status: "APPROVED",
        approvedAtUtc: new Date(),
        expiresAtUtc: new Date(Date.now() + 10 * 60_000),
        method: "IDP_REAUTH",
        ssoConnectionId: oidcConnectionId,
        authnContext: CTX,
      } as never,
      select: { id: true },
    });
  const spend = (userId: string, challengeId: string) =>
    stepUp.consumeApprovedChallenge(
      { teamId: org.workspaceId, userId, challengeId, purpose: PURPOSE as never, ...RESOURCE },
      prisma as never,
    );

  it("IdP step-up: after withdrawal neither a session's IdP history nor an already-approved challenge elevates", async () => {
    await acceptIdpContext();
    const p = await selfServeMember("stepup-withdraw");
    await approveBoth(p);
    const sid = await idpSession(p.id);
    expect(await historySatisfies(p.id, sid)).toEqual({ authnContext: CTX });
    const spentBefore = await approvedChallenge(p.id);
    expect((await spend(p.id, spentBefore.id)).id).toBe(spentBefore.id);
    const pending = await approvedChallenge(p.id);

    expect((await consentFlow.withdrawOrganizationLinkConsent({ userId: p.id, organizationId: org.organizationId })).withdrawn).toBe(2);
    expect(await historySatisfies(p.id, sid)).toBeNull();
    await expect(spend(p.id, pending.id)).rejects.toMatchObject({ code: "challenge_not_found" });
  });

  it("IdP step-up: a challenge approved before a suspension is refused at spend, and stays refused after reactivation", async () => {
    await acceptIdpContext();
    const p = await selfServeMember("stepup-suspend");
    await approveBoth(p);
    const before = await approvedChallenge(p.id);
    const suspended = await orgRoute("POST", `/v1/orgs/${org.organizationId}/members/${p.orgMembershipId}/suspend`, org.owner.token);
    expect(suspended.statusCode, suspended.body).toBe(200);
    await expect(spend(p.id, before.id)).rejects.toMatchObject({ code: "challenge_not_found" });
    const restored = await orgRoute("POST", `/v1/orgs/${org.organizationId}/members/${p.orgMembershipId}/restore`, org.owner.token);
    expect(restored.statusCode, restored.body).toBe(200);
    const after = await approvedChallenge(p.id);
    await expect(spend(p.id, after.id)).rejects.toMatchObject({ code: "challenge_not_found" });
    const sid = await idpSession(p.id);
    expect(await historySatisfies(p.id, sid)).toBeNull();
  });

  it("IdP step-up: an organization-created identity still elevates (session history and spend)", async () => {
    await acceptIdpContext();
    const seeded = await fx.seedUser(deps, "stepup-managed");
    const subject = `stepup-managed-${randomUUID()}`;
    await prisma.user.update({
      where: { id: seeded.userId },
      data: { email: `stepup-managed-${randomUUID().slice(0, 6)}@${domain}`, providerUserId: `sso-${org.organizationId}:${subject}` },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: seeded.userId, role: "ORG_MEMBER" },
    });
    await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: seeded.userId, role: "MEMBER", status: "ACTIVE" },
    });
    await prisma.externalIdentityMapping.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        userId: seeded.userId,
        provider: "GENERIC_OIDC",
        externalSubjectId: subject,
        linkSource: "OIDC_JIT",
      } as never,
    });
    const sid = await idpSession(seeded.userId);
    expect(await historySatisfies(seeded.userId, sid)).toEqual({ authnContext: CTX });
    const c = await approvedChallenge(seeded.userId);
    expect((await spend(seeded.userId, c.id)).id).toBe(c.id);
  });
});
