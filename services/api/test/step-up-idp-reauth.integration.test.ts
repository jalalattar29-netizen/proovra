/**
 * 2026-10-28 — IDP_REAUTH STEP-UP, driven over the REGISTERED routes against a
 * real PostgreSQL: the Enterprise rung of the authenticator ladder.
 *
 * What is proven (letters follow the mandate):
 *   (a) a session that came from the Organization's IdP with an ACCEPTED
 *       context, within the max age, gets an IMMEDIATELY APPROVED
 *       COLLABORATION_TEAM_ARCHIVE step-up — via a real signed SAML sign-in
 *       through the ACS, and via a real verified OIDC sign-in;
 *   (b) a stale or insufficient context yields IDP_REAUTH PENDING + handoffUrl;
 *   (c) the forced reauth round trip (SAML and OIDC) approves with a sufficient
 *       context; insufficient context / stale or missing AuthnInstant
 *       (auth_time) / subject mismatch / another connection / bad nonce /
 *       cancel are DENIED with a stable code and the challenge stays unapproved;
 *       the round trip never mints a session;
 *   (d) replaying the same SAML response / RelayState, the same OIDC state, or
 *       the same handoff link is refused;
 *   (e) an Enterprise member with NO phone and NO authenticator app completes
 *       step-up through the IdP (never forced to enrol a phone);
 *   (f) PHISHING_RESISTANT with SMS-only enrolment → STEP_UP_ENROLLMENT_REQUIRED;
 *       stepUpSmsAllowed=false removes SMS from availableMethods;
 *   (g) a SCIM-provisioned member with no factors and no SSO link →
 *       STEP_UP_ENROLLMENT_REQUIRED (SCIM never authenticates);
 *   (h) after the IdP link is removed, or the connection deactivated, an
 *       approved IdP challenge can no longer be spent.
 * Plus: SSO sessions record method/context/IdP instant; MFA after SSO keeps the
 * SSO provenance on the final session.
 */
import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

import {
  ACS_URL,
  buildSignedSamlResponse,
  IDP_CERT_B64,
  IDP_ISSUER,
  SP_ENTITY_ID,
} from "./_fixtures/saml-signed-fixture.js";
import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { REQUIRED_LEGAL_VERSIONS } from "../src/legal/legal-versioning.js";
// Modules that bind the database client are loaded AFTER the harness points
// the process at the disposable database (a static import would bind the
// client to the ambient DATABASE_URL first). Loaded once, in beforeAll.
type Mods = {
  jwt: typeof import("../src/services/jwt.js");
  revocation: typeof import("../src/services/identity-security/session-revocation.service.js");
  hardening: typeof import("../src/services/access-control/sso-hardening.service.js");
  sso: typeof import("../src/services/access-control/sso.service.js");
  stepUp: typeof import("../src/services/identity-security/step-up.service.js");
  idp: typeof import("../src/services/identity-security/step-up-idp.js");
  flow: typeof import("../src/services/identity-security/step-up-idp-flow.js");
  totp: typeof import("../src/services/security/mfa-totp.js");
  sealed: typeof import("../src/services/security/mfa-secret-storage.js");
  mfa: typeof import("../src/services/security/mfa.service.js");
};
let m: Mods;
const hashStateToken = (raw: string) => m.hardening.hashStateToken(raw);

// ── OIDC test IdP: the JWKS transport is the only thing replaced ────────────
const oidcKeys = vi.hoisted(() => ({ publicJwk: null as unknown }));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () =>
      (await actual.importJWK(oidcKeys.publicJwk as JWK, "RS256")) as never,
  };
});

const OIDC_ISSUER = "https://oidc-idp.step-up.test";
const OIDC_CLIENT_ID = "proovra-step-up-client";
const OIDC_AUTHORIZE = `${OIDC_ISSUER}/authorize`;
const OIDC_TOKEN = `${OIDC_ISSUER}/token`;
const OIDC_USERINFO = `${OIDC_ISSUER}/userinfo`;
const APP_BASE = "https://app.step-up.test";
const DONE = `${APP_BASE}/step-up/idp`;
const X509 = "urn:oasis:names:tc:SAML:2.0:ac:classes:X509";
const PASSWORD_CTX = "urn:oasis:names:tc:SAML:2.0:ac:classes:Password";
const PHR = "urn:proovra:test:acr:phr";
// Response bodies are asserted field by field; their shape is the subject under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const PURPOSE = "COLLABORATION_TEAM_ARCHIVE";
const RESOURCE = { resourceKind: "collaboration_team", resourceId: "team-archive-target" };

const net = vi.hoisted(() => ({
  idToken: "",
  userinfo: {} as Record<string, unknown>,
}));

describe("IDP_REAUTH step-up — Enterprise SAML / OIDC reauthentication", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let teamId: string;
  let orgId: string;
  let samlConnId: string;
  let oidcConnId: string;
  let memberId: string;
  let memberToken: string;
  let memberSubject: string;
  let adminId: string;
  let adminToken: string;
  let adminSubject: string;
  let viewerId: string;
  let viewerSubject: string;
  let secret: string;
  const savedEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  const extraUsers: string[] = [];
  const tag = `idp-${Date.now()}`;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const mint = (userId: string, email: string) =>
    m.jwt.signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      secret,
      3600,
    );
  const sidHash = (token: string) => m.revocation.hashSessionId(m.jwt.mintedSessionClaims(token).sid);

  async function setPolicy(p: {
    assurance?: "STANDARD" | "PHISHING_RESISTANT";
    sms?: boolean;
    contexts?: string[];
    maxAge?: number;
  }): Promise<void> {
    const data = {
      stepUpAssurance: p.assurance ?? "STANDARD",
      stepUpSmsAllowed: p.sms ?? true,
      idpStepUpAcceptedContexts: p.contexts ?? [],
      idpStepUpMaxAgeSeconds: p.maxAge ?? 300,
    };
    await prisma.organizationSecurityPolicy.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, policyVersion: 1, ...data },
      update: data,
    });
  }

  /** The ladder bounds starts per person; each case starts from a clean window. */
  async function freshWindow(): Promise<void> {
    await prisma.stepUpChallenge.updateMany({
      where: { teamId },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
  }

  async function start(token: string) {
    await freshWindow();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      headers: auth(token),
      payload: { teamId, purpose: PURPOSE, ...RESOURCE },
    });
    return { res, json: JSON.parse(res.body) as Json };
  }

  function handoffOf(url: string): { challengeId: string; token: string } {
    const u = new URL(url);
    expect(u.search, "the handoff never travels in the query").toBe("");
    const frag = new URLSearchParams(u.hash.slice(1));
    return { challengeId: frag.get("challenge")!, token: frag.get("token")! };
  }

  async function begin(challengeId: string, token: string) {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/handoff/idp/begin",
      payload: { challengeId, token },
    });
    return { res, json: JSON.parse(res.body) as Json };
  }

  function samlRequestOf(redirectUrl: string): { xml: string; id: string; relayState: string } {
    const u = new URL(redirectUrl);
    const xml = inflateRawSync(Buffer.from(u.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
    const id = / ID="([^"]+)"/.exec(xml)![1]!;
    return { xml, id, relayState: u.searchParams.get("RelayState")! };
  }

  const postAcs = (samlResponseBase64: string, relayState: string) =>
    h.app.inject({
      method: "POST",
      url: "/v1/auth/saml/acs",
      headers: { "content-type": "application/x-www-form-urlencoded", host: new URL(ACS_URL).host },
      payload: new URLSearchParams({ SAMLResponse: samlResponseBase64, RelayState: relayState }).toString(),
    });

  const sessionCookie = (res: { headers: Record<string, unknown> }): string | null => {
    const raw = res.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    // A sign-in clears any old cookie before setting the new one: the session
    // is the last non-empty value.
    const values = list
      .filter((x) => x.startsWith("proovra_session="))
      .map((x) => decodeURIComponent(x.split(";")[0]!.slice("proovra_session=".length)))
      .filter((v) => v.length > 0);
    return values.length > 0 ? values[values.length - 1]! : null;
  };

  async function challengeRow(id: string) {
    return prisma.stepUpChallenge.findUniqueOrThrow({ where: { id } });
  }

  async function idToken(claims: Record<string, unknown>, sub: string): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(OIDC_ISSUER)
      .setAudience(OIDC_CLIENT_ID)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  async function createMember(label: string): Promise<{ id: string; email: string; token: string }> {
    const email = `${label}-${tag}@step-up.test`;
    const user = await prisma.user.create({
      data: { email, firstName: label, lastName: "StepUp", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    await prisma.teamMember.create({ data: { teamId, userId: user.id, role: "MEMBER", status: "ACTIVE" } });
    extraUsers.push(user.id);
    return { id: user.id, email, token: mint(user.id, email) };
  }

  async function link(userId: string, provider: string, subject: string): Promise<void> {
    await prisma.externalIdentityMapping.create({
      data: { teamId, organizationId: orgId, userId, provider: provider as never, externalSubjectId: subject },
    });
  }

  async function addTotp(userId: string): Promise<Buffer> {
    const raw = m.totp.generateTotpSecretBytes();
    const sealed = m.sealed.sealSecret(raw);
    const now = new Date();
    await prisma.mfaFactor.create({
      data: {
        userId,
        kind: "TOTP",
        status: "ACTIVE",
        label: "step-up-idp",
        secretCiphertext: Buffer.from(sealed.ciphertext),
        secretIv: Buffer.from(sealed.iv),
        secretAuthTag: Buffer.from(sealed.authTag),
        secretKekId: sealed.kekId,
        verifiedAtUtc: now,
        enrolledAt: now,
      },
    });
    return raw;
  }

  async function addSms(userId: string): Promise<void> {
    const now = new Date();
    const sealed = m.sealed.sealSecret(Buffer.from("+15555550123", "utf8"));
    await prisma.mfaFactor.create({
      data: {
        userId,
        kind: "SMS",
        status: "ACTIVE",
        label: "step-up-idp-sms",
        verifiedAtUtc: now,
        enrolledAt: now,
        destinationCiphertext: Buffer.from(sealed.ciphertext),
        destinationIv: Buffer.from(sealed.iv),
        destinationAuthTag: Buffer.from(sealed.authTag),
        destinationKekId: sealed.kekId,
        destinationHash: `step-up-idp-${userId}`.padEnd(64, "0").slice(0, 64),
        destinationMask: "+••• ••• 0123",
      },
    });
  }

  /** A real SAML sign-in through the registered login + ACS routes. */
  async function samlSignIn(nameId: string, ctx: string, instant = new Date()) {
    const login = await h.app.inject({ method: "GET", url: `/v1/auth/saml/${samlConnId}/login` });
    expect(login.statusCode, login.body).toBe(302);
    const req = samlRequestOf(login.headers["location"] as string);
    expect(req.xml).toContain('ForceAuthn="false"');
    expect(req.xml, "ordinary sign-in requests no context").not.toContain("RequestedAuthnContext");
    return postAcs(
      buildSignedSamlResponse({ inResponseTo: req.id, nameId, authnContextClassRef: ctx, authnInstant: instant }),
      req.relayState,
    );
  }

  /** start (fresh, no recent IdP sign-in) → begin → the SAML request the IdP would get. */
  async function samlBegin(token: string) {
    const started = await start(token);
    expect(started.res.statusCode, started.res.body).toBe(200);
    expect(started.json.method).toBe("IDP_REAUTH");
    expect(started.json.challenge.status).toBe("PENDING");
    const { challengeId, token: handoff } = handoffOf(started.json.handoffUrl);
    const begun = await begin(challengeId, handoff);
    expect(begun.res.statusCode, begun.res.body).toBe(200);
    return { challengeId, handoff, ...samlRequestOf(begun.json.redirectUrl as string) };
  }

  beforeAll(async () => {
    for (const k of ["SAML_ACS_URL", "APP_BASE_URL", "SSO_CALLBACK_REDIRECT_URI"]) savedEnv[k] = process.env[k];
    process.env["SAML_ACS_URL"] = ACS_URL;
    process.env["APP_BASE_URL"] = APP_BASE;
    process.env["SSO_CALLBACK_REDIRECT_URI"] = "https://api.step-up.test/v1/auth/sso/callback";

    const keys = await generateKeyPair("RS256", { extractable: true });
    privateKey = keys.privateKey;
    oidcKeys.publicJwk = { ...(await exportJWK(keys.publicKey)), alg: "RS256", use: "sig" };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const json = (body: unknown, status = 200) =>
        ({ ok: status < 300, status, json: async () => body }) as unknown as Response;
      if (u === OIDC_ISSUER) {
        return json({
          issuer: OIDC_ISSUER,
          authorization_endpoint: OIDC_AUTHORIZE,
          token_endpoint: OIDC_TOKEN,
          userinfo_endpoint: OIDC_USERINFO,
          jwks_uri: `${OIDC_ISSUER}/jwks`,
        });
      }
      if (u === OIDC_TOKEN && init?.method === "POST") return json({ id_token: net.idToken, access_token: "at-step-up" });
      if (u === OIDC_USERINFO) return json(net.userinfo);
      return originalFetch(input as never, init);
    }) as typeof fetch;
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    m = {
      jwt: await import("../src/services/jwt.js"),
      revocation: await import("../src/services/identity-security/session-revocation.service.js"),
      hardening: await import("../src/services/access-control/sso-hardening.service.js"),
      sso: await import("../src/services/access-control/sso.service.js"),
      stepUp: await import("../src/services/identity-security/step-up.service.js"),
      idp: await import("../src/services/identity-security/step-up-idp.js"),
      flow: await import("../src/services/identity-security/step-up-idp-flow.js"),
      totp: await import("../src/services/security/mfa-totp.js"),
      sealed: await import("../src/services/security/mfa-secret-storage.js"),
      mfa: await import("../src/services/security/mfa.service.js"),
    };
    m.sso.setClientSecretResolver(() => "step-up-test-secret");
    secret = process.env["AUTH_JWT_SECRET"]!;
    teamId = h.fixtures.teamA.teamId;
    memberId = h.fixtures.teamA.memberUserId;
    memberToken = h.fixtures.teamA.memberToken;
    adminId = h.fixtures.teamA.adminUserId;
    adminToken = h.fixtures.teamA.adminToken;
    viewerId = h.fixtures.teamA.viewerUserId;
    await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    orgId = (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } }))
      .organizationId;
    await setPolicy({});

    samlConnId = (
      await prisma.ssoConnection.create({
        data: {
          team: { connect: { id: teamId } },
          organization: { connect: { id: orgId } },
          createdBy: { connect: { id: h.fixtures.teamA.ownerUserId } },
          provider: "GENERIC_SAML",
          displayName: `${tag}-saml`,
          status: "ACTIVE",
          allowedEmailDomains: [],
          samlCertificate: IDP_CERT_B64,
          samlIdpEntityId: IDP_ISSUER,
          samlEntityId: SP_ENTITY_ID,
          samlSsoUrl: "https://idp.example.com/sso",
        },
        select: { id: true },
      })
    ).id;
    oidcConnId = (
      await prisma.ssoConnection.create({
        data: {
          team: { connect: { id: teamId } },
          organization: { connect: { id: orgId } },
          createdBy: { connect: { id: h.fixtures.teamA.ownerUserId } },
          provider: "GENERIC_OIDC",
          displayName: `${tag}-oidc`,
          status: "ACTIVE",
          allowedEmailDomains: [],
          issuerUrl: OIDC_ISSUER,
          clientId: OIDC_CLIENT_ID,
          clientSecretHash: "not-used-by-the-exchange",
        },
        select: { id: true },
      })
    ).id;

    // The member and viewer sign in with SAML; the admin with OIDC. Nobody
    // holds a phone or an authenticator app (case e).
    memberSubject = `member-${tag}@idp.example.com`;
    viewerSubject = `viewer-${tag}@idp.example.com`;
    adminSubject = `oidc-admin-${tag}`;
    await link(memberId, "GENERIC_SAML", memberSubject);
    await link(viewerId, "GENERIC_SAML", viewerSubject);
    await link(adminId, "GENERIC_OIDC", adminSubject);
    await prisma.mfaFactor.deleteMany({ where: { userId: { in: [memberId, adminId, viewerId] } } });
  }, 900_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (prisma) {
      const users = [memberId, adminId, viewerId, ...extraUsers];
      await prisma.stepUpChallenge.deleteMany({ where: { teamId } }).catch(() => undefined);
      await prisma.ssoCallbackAttempt.deleteMany({ where: { teamId } }).catch(() => undefined);
      await prisma.externalIdentityMapping.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
      await prisma.authenticatedSession.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
      await prisma.mfaFactor.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
      await prisma.mfaFactor.deleteMany({ where: { label: { startsWith: "step-up-idp" } } }).catch(() => undefined);
      await prisma.ssoConnection.deleteMany({ where: { displayName: { startsWith: tag } } }).catch(() => undefined);
      await prisma.teamMember.deleteMany({ where: { userId: { in: extraUsers } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: extraUsers } } }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  beforeEach(async () => {
    if (prisma) await setPolicy({ contexts: [X509], maxAge: 300 });
  });

  // ===========================================================================
  // (a) + session recording — SAML
  // ===========================================================================
  it("(a) SAML: a recent sign-in with an accepted context is recorded and approves step-up at once", async () => {
    const instant = new Date(Date.now() - 5_000);
    const signedIn = await samlSignIn(memberSubject, X509, instant);
    expect(signedIn.statusCode, signedIn.body).toBe(302);
    const token = sessionCookie(signedIn);
    expect(token, "the SAML sign-in mints a session").toBeTruthy();

    // The inventory row is the one the token addresses, and it carries the
    // asserted context and the IdP's own AuthnInstant.
    const row = await prisma.authenticatedSession.findFirstOrThrow({
      where: { userId: memberId, sessionIdHash: sidHash(token!) },
    });
    expect(row.authMethod).toBe("SAML");
    expect(row.ssoConnectionId).toBe(samlConnId);
    expect(row.authnContext).toBe(X509);
    expect(row.idpAuthAtUtc?.toISOString()).toBe(new Date(Math.floor(instant.getTime())).toISOString());

    const started = await start(token!);
    expect(started.res.statusCode, started.res.body).toBe(200);
    expect(started.json.method).toBe("IDP_REAUTH");
    expect(started.json.challenge.status).toBe("APPROVED");
    expect(started.json.handoffUrl).toBeNull();
    const stored = await challengeRow(started.json.challenge.id);
    expect(stored.authnContext).toBe(X509);
    expect(stored.ssoConnectionId).toBe(samlConnId);

    // …and the approval is spendable by that session.
    const spent = await m.stepUp.consumeApprovedChallenge({
      teamId,
      userId: memberId,
      challengeId: stored.id,
      purpose: PURPOSE as never,
      ...RESOURCE,
      sessionIdHash: sidHash(token!),
    });
    expect(spent.id).toBe(stored.id);
  });

  // ===========================================================================
  // (b) stale or insufficient → PENDING + handoffUrl
  // ===========================================================================
  it("(b) a stale IdP sign-in, or one with an unaccepted context, needs the forced round trip", async () => {
    const stale = await samlSignIn(memberSubject, X509, new Date(Date.now() - 20 * 60_000));
    const staleToken = sessionCookie(stale)!;
    expect(staleToken).toBeTruthy();
    const a = await start(staleToken);
    expect(a.res.statusCode, a.res.body).toBe(200);
    expect(a.json.method).toBe("IDP_REAUTH");
    expect(a.json.challenge.status).toBe("PENDING");
    expect(String(a.json.handoffUrl)).toMatch(new RegExp(`^${APP_BASE}/step-up/idp#challenge=`));

    const weak = await samlSignIn(memberSubject, PASSWORD_CTX);
    const weakToken = sessionCookie(weak)!;
    const b = await start(weakToken);
    expect(b.json.method).toBe("IDP_REAUTH");
    expect(b.json.challenge.status).toBe("PENDING");
    expect(b.json.handoffUrl).toBeTruthy();

    // An empty accepted list never takes the shortcut, however fresh.
    await setPolicy({ contexts: [], maxAge: 300 });
    const fresh = await samlSignIn(memberSubject, X509);
    const c = await start(sessionCookie(fresh)!);
    expect(c.json.challenge.status).toBe("PENDING");
  });

  // ===========================================================================
  // (c) + (d) + (e) the SAML round trip
  // ===========================================================================
  describe("(c)(d)(e) the forced SAML round trip", () => {
    it("(e) a member with no phone and no authenticator app is offered the IdP, not enrolment", async () => {
      const started = await start(memberToken);
      expect(started.res.statusCode, started.res.body).toBe(200);
      expect(started.json.method).toBe("IDP_REAUTH");
      expect(started.json.availableMethods).toEqual(["IDP_REAUTH"]);
    });

    it("(c) begin sends ForceAuthn and the exact accepted contexts; a sufficient response approves, with no session", async () => {
      const { challengeId, xml, id, relayState } = await samlBegin(memberToken);
      expect(xml).toContain('ForceAuthn="true"');
      expect(xml).toContain(
        `<samlp:RequestedAuthnContext Comparison="exact"><saml:AuthnContextClassRef>${X509}</saml:AuthnContextClassRef></samlp:RequestedAuthnContext>`,
      );
      const response = buildSignedSamlResponse({
        inResponseTo: id,
        nameId: memberSubject,
        authnContextClassRef: X509,
        authnInstant: new Date(),
      });
      const res = await postAcs(response, relayState);
      expect(res.statusCode).toBe(302);
      expect(res.headers["location"]).toBe(`${DONE}?result=approved`);
      expect(sessionCookie(res), "the step-up branch NEVER mints a session").toBeNull();
      const row = await challengeRow(challengeId);
      expect(row.status).toBe("APPROVED");
      expect(row.authnContext).toBe(X509);

      // (d) the same response + RelayState again is refused as a replay.
      const replay = await postAcs(response, relayState);
      expect(replay.headers["location"]).toBe(`${DONE}?result=denied&reason=IDP_REAUTH_REPLAYED`);
      expect(sessionCookie(replay)).toBeNull();
    });

    it("(d) the handoff link begins only once", async () => {
      const started = await start(memberToken);
      const { challengeId, token } = handoffOf(started.json.handoffUrl);
      expect((await begin(challengeId, token)).res.statusCode).toBe(200);
      const again = await begin(challengeId, token);
      expect(again.res.statusCode).toBe(400);
      expect(again.json.error.code).toBe("STEP_UP_HANDOFF_INVALID");
      const forged = await begin(challengeId, "x".repeat(43));
      expect(forged.json.error.code).toBe("STEP_UP_HANDOFF_INVALID");
    });

    const denials: Array<{
      label: string;
      reason: string;
      opts: (subject: string) => Parameters<typeof buildSignedSamlResponse>[0];
    }> = [
      { label: "an insufficient context", reason: "IDP_CONTEXT_INSUFFICIENT", opts: (s) => ({ nameId: s, authnContextClassRef: PASSWORD_CTX }) },
      { label: "no context at all", reason: "IDP_CONTEXT_INSUFFICIENT", opts: (s) => ({ nameId: s, authnContextClassRef: null }) },
      { label: "a stale AuthnInstant", reason: "IDP_REAUTH_STALE", opts: (s) => ({ nameId: s, authnContextClassRef: X509, authnInstant: new Date(Date.now() - 30 * 60_000) }) },
      { label: "a missing AuthnInstant", reason: "IDP_AUTH_TIME_MISSING", opts: (s) => ({ nameId: s, authnContextClassRef: X509, authnInstant: null }) },
      { label: "another linked person", reason: "IDP_SUBJECT_MISMATCH", opts: () => ({ nameId: viewerSubject, authnContextClassRef: X509 }) },
      { label: "an unlinked subject", reason: "IDP_SUBJECT_MISMATCH", opts: () => ({ nameId: `nobody-${tag}@idp.example.com`, authnContextClassRef: X509 }) },
      { label: "a forged signature (wrong issuer)", reason: "IDP_RESPONSE_INVALID", opts: (s) => ({ nameId: s, authnContextClassRef: X509, issuer: "https://evil.example.com" }) },
    ];
    for (const d of denials) {
      it(`(c) ${d.label} is denied (${d.reason}) and the challenge stays unapproved`, async () => {
        const { challengeId, id, relayState } = await samlBegin(memberToken);
        const res = await postAcs(buildSignedSamlResponse({ inResponseTo: id, ...d.opts(memberSubject) }), relayState);
        expect(res.headers["location"]).toBe(`${DONE}?result=denied&reason=${d.reason}`);
        expect(sessionCookie(res)).toBeNull();
        const row = await challengeRow(challengeId);
        expect(row.status).toBe("PENDING");
        expect(row.approvedAtUtc).toBeNull();
        const attempt = await prisma.ssoCallbackAttempt.findUniqueOrThrow({ where: { stateHash: hashStateToken(relayState) } });
        expect(attempt.status).toBe("FAILED");
        expect(attempt.failureReason).toBe(d.reason.toLowerCase());
      });
    }

    it("(c) a VERIFIED response through ANOTHER connection is denied (IDP_CONNECTION_MISMATCH)", async () => {
      // An Organization holds one connection per provider, so the other
      // connection here is its OIDC one: a step-up state for the member's
      // SAML-bound challenge, issued against the OIDC connection (what a
      // confused or malicious hop would produce). The id_token verifies; the
      // judgement still refuses it because the connection is not the
      // challenge's.
      const { challengeId } = await samlBegin(memberToken);
      const state = `other-${tag}-${Date.now()}`;
      const nonce = `nonce-${tag}-${Date.now()}`;
      await prisma.ssoCallbackAttempt.create({
        data: {
          teamId,
          organizationId: orgId,
          ssoConnectionId: oidcConnId,
          stateHash: hashStateToken(state),
          nonceHash: hashStateToken(nonce),
          status: "PENDING",
          redirectAfter: `${m.flow.STEP_UP_IDP_ATTEMPT_MARKER}${challengeId}`,
          expiresAtUtc: new Date(Date.now() + 600_000),
        },
      });
      net.idToken = await idToken({ nonce, acr: X509, auth_time: Math.floor(Date.now() / 1000) }, adminSubject);
      const res = await h.app.inject({
        method: "GET",
        url: `/v1/auth/sso/callback?state=${encodeURIComponent(state)}&code=code-other-${tag}`,
      });
      expect(res.headers["location"]).toBe(`${DONE}?result=denied&reason=IDP_CONNECTION_MISMATCH`);
      expect(sessionCookie(res)).toBeNull();
      expect((await challengeRow(challengeId)).status).toBe("PENDING");
    });

    it("(c) STANDARD with no accepted list accepts the forced fresh sign-in; PHISHING_RESISTANT with no list never offers the IdP", async () => {
      await setPolicy({ contexts: [], maxAge: 300 });
      const { challengeId, xml, id, relayState } = await samlBegin(memberToken);
      expect(xml).toContain('ForceAuthn="true"');
      expect(xml).not.toContain("RequestedAuthnContext");
      const res = await postAcs(
        buildSignedSamlResponse({ inResponseTo: id, nameId: memberSubject, authnContextClassRef: PASSWORD_CTX }),
        relayState,
      );
      expect(res.headers["location"]).toBe(`${DONE}?result=approved`);
      expect((await challengeRow(challengeId)).authnContext).toBe(PASSWORD_CTX);

      await setPolicy({ assurance: "PHISHING_RESISTANT", contexts: [] });
      const refused = await start(memberToken);
      expect(refused.res.statusCode).toBe(403);
      expect(refused.json.error.code).toBe("STEP_UP_ENROLLMENT_REQUIRED");
    });

    it("(c) PHISHING_RESISTANT with a list approves only a listed context", async () => {
      await setPolicy({ assurance: "PHISHING_RESISTANT", contexts: [X509] });
      const ok = await samlBegin(memberToken);
      const res = await postAcs(
        buildSignedSamlResponse({ inResponseTo: ok.id, nameId: memberSubject, authnContextClassRef: X509 }),
        ok.relayState,
      );
      expect(res.headers["location"]).toBe(`${DONE}?result=approved`);
      const weak = await samlBegin(memberToken);
      const refused = await postAcs(
        buildSignedSamlResponse({ inResponseTo: weak.id, nameId: memberSubject, authnContextClassRef: PASSWORD_CTX }),
        weak.relayState,
      );
      expect(refused.headers["location"]).toBe(`${DONE}?result=denied&reason=IDP_CONTEXT_INSUFFICIENT`);
    });
  });

  // ===========================================================================
  // OIDC — session recording, (a), round trip, replay
  // ===========================================================================
  describe("OIDC", () => {
    beforeEach(async () => {
      await setPolicy({ contexts: [PHR], maxAge: 300 });
    });

    it("(a) OIDC: the sign-in records acr + auth_time, and a recent accepted acr approves at once", async () => {
      const init = await h.app.inject({ method: "GET", url: `/v1/auth/sso/${oidcConnId}/initiate` });
      expect(init.statusCode, init.body).toBe(302);
      const authz = new URL(init.headers["location"] as string);
      expect(authz.searchParams.get("prompt"), "ordinary sign-in does not force").toBeNull();
      expect(authz.searchParams.get("max_age")).toBeNull();
      expect(authz.searchParams.get("acr_values")).toBeNull();
      const authTime = Math.floor(Date.now() / 1000) - 3;
      net.idToken = await idToken({ nonce: authz.searchParams.get("nonce"), acr: PHR, auth_time: authTime }, adminSubject);
      net.userinfo = { sub: adminSubject, email: `admin-${tag}@oidc.step-up.test` };
      const cb = await h.app.inject({
        method: "GET",
        url: `/v1/auth/sso/callback?state=${encodeURIComponent(authz.searchParams.get("state")!)}&code=code-${tag}-a`,
      });
      expect(cb.statusCode, cb.body).toBe(302);
      const token = sessionCookie(cb);
      expect(token, String(cb.headers["location"])).toBeTruthy();
      const row = await prisma.authenticatedSession.findFirstOrThrow({
        where: { userId: adminId, sessionIdHash: sidHash(token!) },
      });
      expect(row.authMethod).toBe("OIDC");
      expect(row.ssoConnectionId).toBe(oidcConnId);
      expect(row.authnContext).toBe(PHR);
      expect(row.idpAuthAtUtc?.getTime()).toBe(authTime * 1000);

      const started = await start(token!);
      expect(started.res.statusCode, started.res.body).toBe(200);
      expect(started.json.method).toBe("IDP_REAUTH");
      expect(started.json.challenge.status).toBe("APPROVED");
    });

    async function oidcBegin() {
      const started = await start(adminToken);
      expect(started.res.statusCode, started.res.body).toBe(200);
      expect(started.json.method).toBe("IDP_REAUTH");
      const { challengeId, token } = handoffOf(started.json.handoffUrl);
      const begun = await begin(challengeId, token);
      expect(begun.res.statusCode, begun.res.body).toBe(200);
      const authz = new URL(begun.json.redirectUrl as string);
      return { challengeId, authz, state: authz.searchParams.get("state")!, nonce: authz.searchParams.get("nonce")! };
    }

    const callback = (state: string, extra = `&code=code-${Math.random().toString(36).slice(2, 12)}`) =>
      h.app.inject({ method: "GET", url: `/v1/auth/sso/callback?state=${encodeURIComponent(state)}${extra}` });

    it("(c)(d) the forced OIDC round trip approves once; the same state again is a replay", async () => {
      const { challengeId, authz, state, nonce } = await oidcBegin();
      expect(`${authz.origin}${authz.pathname}`).toBe(OIDC_AUTHORIZE);
      expect(authz.searchParams.get("prompt")).toBe("login");
      expect(authz.searchParams.get("max_age")).toBe("0");
      expect(authz.searchParams.get("acr_values")).toBe(PHR);
      net.idToken = await idToken({ nonce, acr: PHR, auth_time: Math.floor(Date.now() / 1000) }, adminSubject);
      const res = await callback(state);
      expect(res.headers["location"]).toBe(`${DONE}?result=approved`);
      expect(sessionCookie(res)).toBeNull();
      const row = await challengeRow(challengeId);
      expect(row.status).toBe("APPROVED");
      expect(row.authnContext).toBe(PHR);

      const replay = await callback(state);
      expect(replay.headers["location"]).toBe(`${DONE}?result=denied&reason=IDP_REAUTH_REPLAYED`);
    });

    const oidcDenials: Array<{ label: string; reason: string; claims: (nonce: string) => Record<string, unknown>; sub?: () => string }> = [
      { label: "a missing auth_time", reason: "IDP_AUTH_TIME_MISSING", claims: (n) => ({ nonce: n, acr: PHR }) },
      { label: "a stale auth_time", reason: "IDP_REAUTH_STALE", claims: (n) => ({ nonce: n, acr: PHR, auth_time: Math.floor(Date.now() / 1000) - 3600 }) },
      { label: "an unaccepted acr", reason: "IDP_CONTEXT_INSUFFICIENT", claims: (n) => ({ nonce: n, acr: "urn:weak", auth_time: Math.floor(Date.now() / 1000) }) },
      { label: "a wrong nonce", reason: "IDP_RESPONSE_INVALID", claims: () => ({ nonce: "not-the-nonce", acr: PHR, auth_time: Math.floor(Date.now() / 1000) }) },
      { label: "another subject", reason: "IDP_SUBJECT_MISMATCH", claims: (n) => ({ nonce: n, acr: PHR, auth_time: Math.floor(Date.now() / 1000) }), sub: () => `someone-else-${tag}` },
    ];
    for (const d of oidcDenials) {
      it(`(c) OIDC: ${d.label} is denied (${d.reason}); the challenge stays unapproved`, async () => {
        const { challengeId, state, nonce } = await oidcBegin();
        net.idToken = await idToken(d.claims(nonce), d.sub ? d.sub() : adminSubject);
        const res = await callback(state);
        expect(res.headers["location"]).toBe(`${DONE}?result=denied&reason=${d.reason}`);
        expect((await challengeRow(challengeId)).status).toBe("PENDING");
      });
    }

    it("(c) OIDC: a cancel at the IdP is reported calmly and spends the state", async () => {
      const { challengeId, state } = await oidcBegin();
      const res = await callback(state, "&error=access_denied");
      expect(res.headers["location"]).toBe(`${DONE}?result=denied&reason=IDP_REAUTH_CANCELLED`);
      expect((await challengeRow(challengeId)).status).toBe("PENDING");
      const again = await callback(state);
      expect(again.headers["location"]).toBe(`${DONE}?result=denied&reason=IDP_REAUTH_EXPIRED`);
    });
  });

  // ===========================================================================
  // (f) (g) the policy narrows; SCIM never authenticates
  // ===========================================================================
  it("(f) PHISHING_RESISTANT with only an SMS factor → STEP_UP_ENROLLMENT_REQUIRED", async () => {
    const smsOnly = await createMember("sms-only");
    await addSms(smsOnly.id);
    await setPolicy({ assurance: "PHISHING_RESISTANT", contexts: [X509] });
    const res = await start(smsOnly.token);
    expect(res.res.statusCode, res.res.body).toBe(403);
    expect(res.json.error.code).toBe("STEP_UP_ENROLLMENT_REQUIRED");
  });

  it("(f) stepUpSmsAllowed=false removes SMS from availableMethods", async () => {
    const both = await createMember("totp-sms");
    await addTotp(both.id);
    await addSms(both.id);
    await setPolicy({ sms: true, contexts: [X509] });
    const allowed = await start(both.token);
    expect(allowed.res.statusCode, allowed.res.body).toBe(200);
    expect(allowed.json.availableMethods).toEqual(["TOTP", "SMS"]);
    await setPolicy({ sms: false, contexts: [X509] });
    const narrowed = await start(both.token);
    expect(narrowed.res.statusCode, narrowed.res.body).toBe(200);
    expect(narrowed.json.method).toBe("TOTP");
    expect(narrowed.json.availableMethods).toEqual(["TOTP"]);

    const smsOnly = await createMember("sms-only-std");
    await addSms(smsOnly.id);
    const refused = await start(smsOnly.token);
    expect(refused.res.statusCode).toBe(403);
    expect(refused.json.error.code).toBe("STEP_UP_ENROLLMENT_REQUIRED");
  });

  it("(g) a SCIM-provisioned member with no factor and no SSO link cannot step up", async () => {
    const scim = await createMember("scim");
    await link(scim.id, "GENERIC_SCIM", `scim-ext-${tag}`);
    expect(await m.idp.resolveIdpStepUpConnection(prisma, { userId: scim.id, teamId })).toBeNull();
    const res = await start(scim.token);
    expect(res.res.statusCode, res.res.body).toBe(403);
    expect(res.json.error.code).toBe("STEP_UP_ENROLLMENT_REQUIRED");
  });

  // ===========================================================================
  // (h) the approval dies with the link / the connection
  // ===========================================================================
  describe("(h) an approved IdP challenge is unspendable once the binding is gone", () => {
    async function approvedChallenge(): Promise<string> {
      const { challengeId, id, relayState } = await samlBegin(memberToken);
      const res = await postAcs(
        buildSignedSamlResponse({ inResponseTo: id, nameId: memberSubject, authnContextClassRef: X509 }),
        relayState,
      );
      expect(res.headers["location"]).toBe(`${DONE}?result=approved`);
      return challengeId;
    }
    const spend = (challengeId: string) =>
      m.stepUp.consumeApprovedChallenge({
        teamId,
        userId: memberId,
        challengeId,
        purpose: PURPOSE as never,
        ...RESOURCE,
        sessionIdHash: sidHash(memberToken),
      });

    it("positive control: with the link and connection intact it spends", async () => {
      const id = await approvedChallenge();
      expect((await spend(id)).id).toBe(id);
    });

    it("after the IdP link is removed", async () => {
      const id = await approvedChallenge();
      await prisma.externalIdentityMapping.updateMany({
        where: { userId: memberId, provider: "GENERIC_SAML" },
        data: { unlinkedAtUtc: new Date() },
      });
      try {
        await expect(spend(id)).rejects.toBeInstanceOf(m.stepUp.StepUpError);
      } finally {
        await prisma.externalIdentityMapping.updateMany({
          where: { userId: memberId, provider: "GENERIC_SAML" },
          data: { unlinkedAtUtc: null },
        });
      }
    });

    it("after the connection is deactivated", async () => {
      const id = await approvedChallenge();
      await prisma.ssoConnection.update({ where: { id: samlConnId }, data: { status: "DISABLED" } });
      try {
        await expect(spend(id)).rejects.toBeInstanceOf(m.stepUp.StepUpError);
      } finally {
        await prisma.ssoConnection.update({ where: { id: samlConnId }, data: { status: "ACTIVE" } });
      }
    });
  });

  // ===========================================================================
  // MFA after SSO keeps the SSO provenance
  // ===========================================================================
  it("MFA after a SAML sign-in: the final session keeps SAML provenance, connection and context", async () => {
    const mfaUser = await createMember("mfa-sso");
    const subject = `mfa-${tag}@idp.example.com`;
    await link(mfaUser.id, "GENERIC_SAML", subject);
    const secretBytes = await addTotp(mfaUser.id);
    const instant = new Date(Date.now() - 2_000);

    const signedIn = await samlSignIn(subject, X509, instant);
    expect(signedIn.statusCode).toBe(302);
    expect(String(signedIn.headers["location"])).toContain("/auth/mfa-challenge");
    expect(sessionCookie(signedIn), "no session before the second factor").toBeNull();
    const raw = signedIn.headers["set-cookie"];
    const pending = (Array.isArray(raw) ? raw : [String(raw)])
      .find((c) => c.startsWith("proovra_mfa_pending="))!
      .split(";")[0]!
      .slice("proovra_mfa_pending=".length);

    const code = m.totp.computeTotpCode(secretBytes, m.totp.timeStep(Math.floor(Date.now() / 1000)));
    const verified = await h.app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      payload: { mfaPendingToken: decodeURIComponent(pending), code },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const token = (JSON.parse(verified.body) as { token: string }).token;
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims.authMethod).toBe("SAML");
    expect(claims.ssoConnId).toBe(samlConnId);
    expect(typeof claims.mfaAt).toBe("number");

    const row = await prisma.authenticatedSession.findFirstOrThrow({
      where: { userId: mfaUser.id, sessionIdHash: sidHash(token) },
    });
    expect(row.authMethod).toBe("SAML");
    expect(row.ssoConnectionId).toBe(samlConnId);
    expect(row.authnContext).toBe(X509);
    expect(row.idpAuthAtUtc?.getTime()).toBe(Math.floor(instant.getTime() / 1000) * 1000);

    // …which is why this session can answer step-up at once.
    const started = await start(token);
    expect(started.res.statusCode, started.res.body).toBe(200);
    expect(started.json.method).toBe("IDP_REAUTH");
    expect(started.json.challenge.status).toBe("APPROVED");
  });

  it("a password login through MFA still records PASSWORD (unchanged)", async () => {
    // The pending token a password login mints carries PASSWORD provenance;
    // the verify endpoint must not invent SSO provenance for it.
    const user = await createMember("mfa-password");
    const secretBytes = await addTotp(user.id);
    const challenge = await m.mfa.createMfaPendingChallenge({ userId: user.id, purpose: "LOGIN", ipAddress: null, userAgent: null, metadata: {} });
    const pending = m.jwt.signMfaPendingToken(
      { sub: user.id, provider: "EMAIL", email: user.email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      secret,
      challenge.jti,
    );
    const code = m.totp.computeTotpCode(secretBytes, m.totp.timeStep(Math.floor(Date.now() / 1000)));
    const verified = await h.app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { mfaPendingToken: pending, code } });
    expect(verified.statusCode, verified.body).toBe(200);
    const token = (JSON.parse(verified.body) as { token: string }).token;
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims.authMethod).toBe("PASSWORD");
    expect(claims.ssoConnId).toBeUndefined();
    const row = await prisma.authenticatedSession.findFirstOrThrow({ where: { userId: user.id, sessionIdHash: sidHash(token) } });
    expect(row.authMethod).toBe("PASSWORD");
    expect(row.ssoConnectionId).toBeNull();
    expect(row.authnContext).toBeNull();
  });

  // ===========================================================================
  // The Organization policy admin surface
  // ===========================================================================
  it("policy PATCH: the four fields are validated, normalised, versioned and read back (admin surface)", async () => {
    const ownerId = h.fixtures.teamA.ownerUserId;
    const ownerToken = h.fixtures.teamA.ownerToken;
    await prisma.mfaFactor.deleteMany({ where: { userId: ownerId, label: "step-up-idp" } });
    const ownerSecret = await addTotp(ownerId);
    const patch = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
      h.app.inject({
        method: "PATCH",
        url: "/v1/security-policy",
        headers: { ...auth(ownerToken), ...headers },
        payload: { organizationId: orgId, ...payload },
      });

    // Out-of-bounds values are refused before anything else runs.
    for (const bad of [
      { stepUpAssurance: "WEAK" },
      { idpStepUpMaxAgeSeconds: 29 },
      { idpStepUpMaxAgeSeconds: 3601 },
      { idpStepUpAcceptedContexts: Array.from({ length: 17 }, (_, i) => `urn:ctx:${i}`) },
      { idpStepUpAcceptedContexts: ["x".repeat(257)] },
      { idpStepUpAcceptedContexts: ["   "] },
      { stepUpSmsAllowed: "no" },
    ]) {
      const res = await patch(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }

    // A valid change goes through the existing ORG_SECURITY_POLICY_UPDATE step-up.
    await freshWindow();
    const started = await h.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      headers: auth(ownerToken),
      payload: { teamId, purpose: "ORG_SECURITY_POLICY_UPDATE" },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (JSON.parse(started.body) as { challenge: { id: string } }).challenge.id;
    const code = m.totp.computeTotpCode(ownerSecret, m.totp.timeStep(Math.floor(Date.now() / 1000)));
    const checked = await h.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      headers: auth(ownerToken),
      payload: { teamId, challengeId, code },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    const before = await prisma.organizationSecurityPolicy.findUniqueOrThrow({ where: { organizationId: orgId } });
    const ok = await patch(
      {
        stepUpAssurance: "PHISHING_RESISTANT",
        stepUpSmsAllowed: false,
        idpStepUpAcceptedContexts: [`  ${X509}  `, X509, PHR],
        idpStepUpMaxAgeSeconds: 120,
      },
      { "x-proovra-step-up-challenge-id": challengeId },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    const policy = (JSON.parse(ok.body) as { policy: Record<string, unknown> }).policy;
    expect(policy.stepUpAssurance).toBe("PHISHING_RESISTANT");
    expect(policy.stepUpSmsAllowed).toBe(false);
    expect(policy.idpStepUpAcceptedContexts).toEqual([X509, PHR]);
    expect(policy.idpStepUpMaxAgeSeconds).toBe(120);
    expect(policy.policyVersion).toBe(before.policyVersion + 1);
    const stored = await prisma.organizationSecurityPolicy.findUniqueOrThrow({ where: { organizationId: orgId } });
    expect(stored.idpStepUpAcceptedContexts).toEqual([X509, PHR]);

    const read = await h.app.inject({ method: "GET", url: `/v1/security-policy?organizationId=${orgId}`, headers: auth(ownerToken) });
    expect(read.statusCode, read.body).toBe(200);
    expect((JSON.parse(read.body) as { policy: Record<string, unknown> }).policy.stepUpAssurance).toBe("PHISHING_RESISTANT");
    // The admin read is not reachable by a plain member.
    const asMember = await h.app.inject({ method: "GET", url: `/v1/security-policy?organizationId=${orgId}`, headers: auth(memberToken) });
    expect(asMember.statusCode).toBeGreaterThanOrEqual(400);
    expect(asMember.body).not.toContain("idpStepUpAcceptedContexts");
  });
});
