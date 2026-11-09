/**
 * MOBILE-002 / IDENT-020 — the native app's SAML leg, end to end, through the
 * real login and ACS routes with a genuinely signed assertion from the repo's
 * local signing fixture (the same fixture as saml-sign-in-integrity). No real
 * IdP and no device are exercised: the system browser is played by inject, and
 * the app's last step by POST /v1/auth/sso/native/exchange.
 *
 * Proven here, for SAML, against the web sign-in's own requirements: the PKCE
 * binding, a single-use and short-lived code, the fixed app return (no caller
 * redirect), refusals reported to the app, the MFA gate and enrolment refusal,
 * the session inventory row, managed identity, the session limit, an
 * SSO-required Organization refusing a password session that the SSO session
 * passes, and the audit and security records.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  ACS_URL,
  buildSignedSamlResponse,
  IDP_CERT_B64,
  IDP_ISSUER,
  SP_ENTITY_ID,
} from "./_fixtures/saml-signed-fixture.js";
import {
  registerSessionForToken,
  seedOrganizationTenant,
  verifyOrganizationDomain,
  type FixtureDeps,
  type OrganizationTenant,
} from "./point7/product-fixtures.js";

const WEB = "https://web.example.test";
const APP_RETURN = "proovra://sso/complete";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

describe("MOBILE-002 — native SAML sign-in through the PKCE-bound hand-off (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let mfaSecrets: typeof import("../src/services/security/mfa-secret-storage.js");
  let deps: FixtureDeps;
  const tag = `ssonsaml-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const saved: Record<string, string | undefined> = {};
  let currentDomain = "example.test";

  const mint = (userId: string, email: string) =>
    signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );

  async function connection(org: OrganizationTenant, extra: Record<string, unknown> = {}): Promise<string> {
    currentDomain = await verifyOrganizationDomain(deps, org.organizationId, org.owner.userId);
    const row = await prisma.ssoConnection.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        provider: "GENERIC_SAML",
        displayName: `${tag}-saml`,
        status: "ACTIVE",
        createdByUserId: org.owner.userId,
        allowedEmailDomains: [],
        jitDefaultRole: "MEMBER",
        samlCertificate: IDP_CERT_B64,
        samlIdpEntityId: IDP_ISSUER,
        samlEntityId: SP_ENTITY_ID,
        samlSsoUrl: "https://idp.example.test/sso",
        ...extra,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  const setCookies = (res: { headers: Record<string, unknown> }): string[] => {
    const raw = res.headers["set-cookie"];
    return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  };
  const sessionCookieSet = (res: { headers: Record<string, unknown> }) =>
    setCookies(res).some((c) => /^proovra_session=[^;]+/.test(c));

  /** The app opens the SAML login route in the system browser with its challenge. */
  async function nativeLogin(connId: string, challenge: string, extraQuery = "") {
    const login = await harness.app.inject({
      method: "GET",
      url: `/v1/auth/saml/${connId}/login?native=1&codeChallenge=${challenge}${extraQuery}`,
    });
    expect(login.statusCode, login.body).toBe(302);
    const location = new URL(String(login.headers.location));
    expect(location.origin).toBe("https://idp.example.test");
    const xml = inflateRawSync(Buffer.from(location.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
    const requestId = /\sID="([^"]+)"/.exec(xml)![1]!;
    const cookie = String(setCookies(login).find((c) => c.startsWith("proovra_sso_bind=")) ?? "").split(";")[0]!;
    return { requestId, relayState: location.searchParams.get("RelayState")!, cookie };
  }

  const postAcs = (samlResponse: string, relayState: string, cookie: string) =>
    harness.app.inject({
      method: "POST",
      url: "/v1/auth/saml/acs",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        host: new URL(ACS_URL).host,
        ...(cookie ? { cookie } : {}),
      },
      payload: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }).toString(),
    });

  /** Login → IdP → ACS; returns the ACS answer (a redirect to the app). */
  async function nativeAcs(connId: string, challenge: string, nameId: string, extraQuery = "") {
    const { requestId, relayState, cookie } = await nativeLogin(connId, challenge, extraQuery);
    return postAcs(buildSignedSamlResponse({ inResponseTo: requestId, nameId }), relayState, cookie);
  }

  async function nativeCode(connId: string, challenge: string, nameId: string, extraQuery = "") {
    const res = await nativeAcs(connId, challenge, nameId, extraQuery);
    expect(res.statusCode, res.body).toBe(302);
    const location = String(res.headers.location);
    expect(location.startsWith(`${APP_RETURN}?code=`), location).toBe(true);
    expect(sessionCookieSet(res)).toBe(false);
    return new URL(location).searchParams.get("code")!;
  }

  const exchange = (payload: unknown) =>
    harness.app.inject({ method: "POST", url: "/v1/auth/sso/native/exchange", payload: payload as never });

  async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    let v = await read();
    for (let i = 0; i < 40 && !ok(v); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      v = await read();
    }
    return v;
  }

  async function factorFor(userId: string): Promise<Buffer> {
    const raw = totp.generateTotpSecretBytes();
    const sealed = mfaSecrets.sealSecret(raw);
    const now = new Date();
    await prisma.mfaFactor.create({
      data: {
        userId,
        kind: "TOTP",
        status: "ACTIVE",
        label: "mobile-002",
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

  beforeAll(async () => {
    for (const k of ["SAML_ACS_URL", "SAML_SP_ACS_URL", "WEB_BASE_URL"]) saved[k] = process.env[k];
    delete process.env["SAML_ACS_URL"];
    process.env["SAML_SP_ACS_URL"] = ACS_URL;
    process.env["WEB_BASE_URL"] = WEB;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    mfaSecrets = await import("../src/services/security/mfa-secret-storage.js");
    deps = { prisma: prisma as never, tag, mintToken: mint };
  }, 180_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await harness?.cleanup();
  });

  it("the ACS hands the app a single-use code (no cookie, no token); the exchange gives a SAML session with its inventory row, audit and security event", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `native-${randomUUID().slice(0, 8)}@${currentDomain}`;
    const { verifier, challenge } = pkce();
    const code = await nativeCode(conn, challenge, email);

    const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(0);

    const res = await exchange({ code, codeVerifier: verifier });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { token: string; user: { id: string } };
    expect(body.user.id).toBe(user.id);
    expect(sessionCookieSet(res)).toBe(false);
    const claims = JSON.parse(Buffer.from(body.token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({ authMethod: "SAML", ssoConnId: conn, sub: user.id });

    const me = await harness.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode, me.body).toBe(200);

    const session = await prisma.authenticatedSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.ssoConnectionId).toBe(conn);
    expect(session.authMethod).toBe("SAML");
    expect(session.teamId).toBe(org.workspaceId);

    const audit = await eventually(
      () => prisma.adminAuditLog.findFirst({ where: { userId: user.id, action: "auth.saml_login_succeeded" } }),
      (v) => v !== null,
    );
    expect(audit, "no audit record of the native SAML sign-in").not.toBeNull();
    expect(audit!.organizationId).toBe(org.organizationId);
    const event = await eventually(
      () => prisma.securityEvent.findFirst({ where: { teamId: org.workspaceId, eventType: "saml_login_succeeded" } }),
      (v) => v !== null,
    );
    expect(event, "the SAML ACS's security event is missing for the native leg").not.toBeNull();
  });

  it("negative controls: a wrong verifier spends nothing, a reused code and an expired code are refused, and none mints a session", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `neg-${randomUUID().slice(0, 8)}@${currentDomain}`;
    const { verifier, challenge } = pkce();
    const code = await nativeCode(conn, challenge, email);
    const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });

    const wrong = await exchange({ code, codeVerifier: pkce().verifier });
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { error: { code: string } }).error.code).toBe("SSO_NATIVE_CODE_INVALID");
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(0);

    expect((await exchange({ code, codeVerifier: verifier })).statusCode).toBe(200);
    const reused = await exchange({ code, codeVerifier: verifier });
    expect(reused.statusCode).toBe(400);
    expect((reused.json() as { error: { code: string } }).error.code).toBe("SSO_NATIVE_CODE_INVALID");
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(1);

    const second = pkce();
    const code2 = await nativeCode(conn, second.challenge, email);
    await prisma.ssoNativeHandoff.updateMany({
      where: { codeChallenge: second.challenge },
      data: { codeExpiresAtUtc: new Date(Date.now() - 1000) },
    });
    const expired = await exchange({ code: code2, codeVerifier: second.verifier });
    expect(expired.statusCode).toBe(400);
    expect((expired.json() as { error: { code: string } }).error.code).toBe("SSO_NATIVE_CODE_INVALID");
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(1);
  });

  it("no caller-chosen redirect: a foreign redirectAfter on a native attempt is refused back to the fixed app URL, before the IdP", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const { challenge } = pkce();
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/auth/saml/${conn}/login?native=1&codeChallenge=${challenge}&redirectAfter=${encodeURIComponent("https://evil.example/steal")}`,
    });
    expect(String(res.headers.location)).toBe(`${APP_RETURN}?error=saml_state_persist_failed`);
    expect(await prisma.ssoNativeHandoff.count({ where: { codeChallenge: challenge } })).toBe(0);
  });

  it("a refused native assertion reports to the app, provisions nobody and issues no code", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `outside-${randomUUID().slice(0, 8)}@unproven-${randomUUID().slice(0, 6)}.example`;
    const { challenge } = pkce();
    const res = await nativeAcs(conn, challenge, email);
    const location = String(res.headers.location);
    expect(location.startsWith(`${APP_RETURN}?error=`), location).toBe(true);
    expect(location).not.toContain(WEB);
    expect(sessionCookieSet(res)).toBe(false);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    const handoff = await prisma.ssoNativeHandoff.findFirstOrThrow({ where: { codeChallenge: challenge } });
    expect(handoff.codeHash).toBeNull();
  });

  it("an assertion in a browser that did not start the native attempt is refused to the app, unspent", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `csrf-${randomUUID().slice(0, 8)}@${currentDomain}`;
    const { challenge } = pkce();
    const { requestId, relayState } = await nativeLogin(conn, challenge);
    const res = await postAcs(buildSignedSamlResponse({ inResponseTo: requestId, nameId: email }), relayState, "");
    expect(String(res.headers.location)).toBe(`${APP_RETURN}?error=saml_browser_mismatch`);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("a native login on an unavailable or unconfigured connection goes back to the app, not to the web sign-in page", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const disabled = await connection(org, { status: "DISABLED" });
    const noCert = await connection(org, { samlCertificate: null });
    const { challenge } = pkce();
    const a = await harness.app.inject({ method: "GET", url: `/v1/auth/saml/${disabled}/login?native=1&codeChallenge=${challenge}` });
    expect(String(a.headers.location)).toBe(`${APP_RETURN}?error=saml_connection_unavailable`);
    const b = await harness.app.inject({ method: "GET", url: `/v1/auth/saml/${noCert}/login?native=1&codeChallenge=${challenge}` });
    expect(String(b.headers.location)).toBe(`${APP_RETURN}?error=saml_not_configured`);
    // Control: the browser login is unchanged.
    const web = await harness.app.inject({ method: "GET", url: `/v1/auth/saml/${disabled}/login` });
    expect(String(web.headers.location)).toContain(`${WEB}/login?saml_error=saml_connection_unavailable`);
  });

  it("a connection disabled between the ACS and the exchange signs nobody in", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `late-${randomUUID().slice(0, 8)}@${currentDomain}`;
    const { verifier, challenge } = pkce();
    const code = await nativeCode(conn, challenge, email);
    await prisma.ssoConnection.update({ where: { id: conn }, data: { status: "DISABLED" } });
    const res = await exchange({ code, codeVerifier: verifier });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "SSO_SIGN_IN_REFUSED", reason: "sso_connection_unavailable" } });
    const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(0);
  });

  it("MFA after SSO: an account with a factor gets the challenge, not a session, and the session after the factor keeps the SAML proof", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `mfa-${randomUUID().slice(0, 8)}@${currentDomain}`;
    const first = pkce();
    expect((await exchange({ code: await nativeCode(conn, first.challenge, email), codeVerifier: first.verifier })).statusCode).toBe(200);
    const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
    const secret = await factorFor(user.id);
    const before = await prisma.authenticatedSession.count({ where: { userId: user.id } });

    const second = pkce();
    const res = await exchange({ code: await nativeCode(conn, second.challenge, email), codeVerifier: second.verifier });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { mfaRequired?: boolean; mfaPendingToken?: string; token?: string };
    expect(body.mfaRequired).toBe(true);
    expect(body.token).toBeUndefined();
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(before);

    const audit = await eventually(
      () => prisma.adminAuditLog.findFirst({ where: { userId: user.id, action: "auth.mfa_challenge_issued" } }),
      (v) => v !== null,
    );
    expect(audit, "the browser callback's MFA challenge audit is missing for the native leg").not.toBeNull();

    const verified = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      payload: { mfaPendingToken: body.mfaPendingToken, code: totp.computeTotpCode(secret, totp.timeStep(Math.floor(Date.now() / 1000))) },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const token = (verified.json() as { token: string }).token;
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({ authMethod: "SAML", ssoConnId: conn });
    const rows = await prisma.authenticatedSession.findMany({ where: { userId: user.id, ssoConnectionId: conn } });
    expect(rows.length).toBe(before + 1);
  });

  it("MFA enrolment required by the Organization: the exchange answers the enrolment refusal and no session", async () => {
    const org = await seedOrganizationTenant(deps, {});
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { mfaPolicyLevel: "ALL_MEMBERS" },
    });
    const conn = await connection(org);
    const email = `enrol-${randomUUID().slice(0, 8)}@${currentDomain}`;
    const { verifier, challenge } = pkce();
    const res = await exchange({ code: await nativeCode(conn, challenge, email), codeVerifier: verifier });
    expect(res.statusCode, res.body).toBe(403);
    const body = res.json() as { mfaEnrollmentRequired: boolean; code: string; mfaEnrollmentToken: string; token?: string };
    expect(body).toMatchObject({ mfaEnrollmentRequired: true, code: "MFA_ENROLLMENT_REQUIRED" });
    expect(body.mfaEnrollmentToken.length).toBeGreaterThan(20);
    expect(body.token).toBeUndefined();
    const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(0);
    const audit = await eventually(
      () => prisma.adminAuditLog.findFirst({ where: { userId: user.id, action: "auth.mfa_enrollment_required" } }),
      (v) => v !== null,
    );
    expect(audit).not.toBeNull();
  });

  it("an SSO-required, managed-identity Organization: the native SAML session is bound and admitted, a password session for the same person is not", async () => {
    const org = await seedOrganizationTenant(deps, { managedIdentityRequired: true });
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { ssoRequired: true },
    });
    const conn = await connection(org);
    const email = `req-${randomUUID().slice(0, 8)}@${currentDomain}`;
    const { verifier, challenge } = pkce();
    const res = await exchange({ code: await nativeCode(conn, challenge, email), codeVerifier: verifier });
    expect(res.statusCode, res.body).toBe(200);
    const { token, user } = res.json() as { token: string; user: { id: string } };

    const bound = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { managedBySsoConnectionId: true } });
    expect(bound.managedBySsoConnectionId).toBe(conn);

    // A new account owes the legal acceptance first, as after any sign-in (RT-015).
    const authorization = `Bearer ${token}`;
    const owed = (await harness.app.inject({ method: "GET", url: "/v1/users/legal-status", headers: { authorization } })).json() as {
      missingPolicies: string[];
      requiredVersions: Record<string, string>;
    };
    const accepted = await harness.app.inject({
      method: "POST",
      url: "/v1/users/legal-acceptance",
      headers: { authorization, "content-type": "application/json" },
      payload: {
        source: "post_sign_in",
        acceptances: owed.missingPolicies.map((policyKey) => ({ policyKey, policyVersion: owed.requiredVersions[policyKey] })),
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    const roster = (bearer: string) =>
      harness.app.inject({ method: "GET", url: `/v1/teams/${org.workspaceId}/members`, headers: { authorization: `Bearer ${bearer}` } });
    const admitted = await roster(token);
    expect(admitted.statusCode, admitted.body).toBe(200);

    const password = mint(user.id, email);
    await registerSessionForToken(deps, user.id, password);
    const refused = await roster(password);
    expect([401, 403, 404]).toContain(refused.statusCode);
    expect(refused.body).not.toContain(email);
  });

  it("the Organization's session limit holds on the native leg: refused with its reason, and the refused session is not left behind", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `limit-${randomUUID().slice(0, 8)}@${currentDomain}`;
    const first = pkce();
    expect((await exchange({ code: await nativeCode(conn, first.challenge, email), codeVerifier: first.verifier })).statusCode).toBe(200);
    const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { concurrentSessionLimit: 1 },
    });
    const before = await prisma.authenticatedSession.count({ where: { userId: user.id } });
    const second = pkce();
    const res = await exchange({ code: await nativeCode(conn, second.challenge, email), codeVerifier: second.verifier });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "SSO_SIGN_IN_REFUSED", reason: "concurrent_session_limit_reached" } });
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(before);
  });

  it("session end: signing out with the native SSO token revokes its inventory row and the token stops working", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `out-${randomUUID().slice(0, 8)}@${currentDomain}`;
    const { verifier, challenge } = pkce();
    const { token, user } = (await exchange({ code: await nativeCode(conn, challenge, email), codeVerifier: verifier })).json() as {
      token: string;
      user: { id: string };
    };
    const out = await harness.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(out.statusCode, out.body).toBe(200);
    const row = await prisma.authenticatedSession.findFirstOrThrow({ where: { userId: user.id, ssoConnectionId: conn } });
    expect(row.revokedAtUtc).not.toBeNull();
    const me = await harness.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(401);
  });
});
