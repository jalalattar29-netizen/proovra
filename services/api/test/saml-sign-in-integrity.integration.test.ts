/**
 * IDENT-003, IDENT-006, IDENT-009, IDENT-010, IDENT-014 — SAML sign-in through the
 * real login and ACS routes, with a genuinely signed assertion from the repo's
 * local signing fixture. No real IdP is involved.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inflateRawSync } from "node:zlib";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  ACS_URL,
  buildSignedSamlResponse,
  IDP_CERT_B64,
  IDP_ISSUER,
  SP_ENTITY_ID,
} from "./_fixtures/saml-signed-fixture.js";
import {
  seedOrganizationTenant,
  seedPersonalTenant,
  type FixtureDeps,
  type OrganizationTenant,
} from "./point7/product-fixtures.js";

const WEB = "https://web.example.test";

describe("SAML sign-in integrity (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let closure: typeof import("../src/services/identity/account-closure.service.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let deps: FixtureDeps;
  const tag = `ssi-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const saved: Record<string, string | undefined> = {};

  const mint = (userId: string, email: string) =>
    signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );

  async function connection(
    org: OrganizationTenant,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
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

  /** The login route, then what the IdP needs to answer it. */
  async function startSignIn(connId: string) {
    const login = await harness.app.inject({ method: "GET", url: `/v1/auth/saml/${connId}/login` });
    expect(login.statusCode, login.body).toBe(302);
    const location = new URL(String(login.headers.location));
    const xml = inflateRawSync(Buffer.from(location.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
    const requestId = /\sID="([^"]+)"/.exec(xml)![1]!;
    const raw = login.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const cookie = String(list.find((c) => String(c).startsWith("proovra_sso_bind=")) ?? "").split(";")[0]!;
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

  async function signIn(connId: string, nameId: string) {
    const { requestId, relayState, cookie } = await startSignIn(connId);
    return postAcs(buildSignedSamlResponse({ inResponseTo: requestId, nameId }), relayState, cookie);
  }

  const sessionSet = (res: { headers: Record<string, unknown> }) => {
    const raw = res.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    return list.some((c) => /^proovra_session=[^;]+/.test(String(c)));
  };

  beforeAll(async () => {
    for (const k of ["SAML_ACS_URL", "SAML_SP_ACS_URL", "WEB_BASE_URL"]) saved[k] = process.env[k];
    delete process.env["SAML_ACS_URL"];
    process.env["SAML_SP_ACS_URL"] = ACS_URL;
    process.env["WEB_BASE_URL"] = WEB;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    closure = await import("../src/services/identity/account-closure.service.js");
    scim = await import("../src/services/access-control/scim.service.js");
    deps = { prisma: prisma as never, tag, mintToken: mint };
  }, 180_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await harness?.cleanup();
  });

  it("a successful sign-in lands on the web host, using the ACS the boot guard validates", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `new-${randomUUID().slice(0, 8)}@example.test`;
    const res = await signIn(conn, email);
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/home`);
    expect(sessionSet(res)).toBe(true);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("a failure lands on the web sign-in page with its reason", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/saml/acs",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ SAMLResponse: "x", RelayState: "" }).toString(),
    });
    expect(String(res.headers.location)).toBe(`${WEB}/login?saml_error=saml_missing_relay_state`);
  });

  it("IDENT-014: an assertion in a browser that did not start the sign-in is refused, unspent", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const { requestId, relayState, cookie } = await startSignIn(conn);
    const email = `csrf-${randomUUID().slice(0, 8)}@example.test`;
    const response = buildSignedSamlResponse({ inResponseTo: requestId, nameId: email });

    const elsewhere = await postAcs(response, relayState, "");
    expect(String(elsewhere.headers.location)).toContain("saml_error=saml_browser_mismatch");
    expect(sessionSet(elsewhere)).toBe(false);
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    const mine = await postAcs(response, relayState, cookie);
    expect(mine.headers.location).toBe(`${WEB}/home`);
  });

  it("IDENT-006: a sign-in the domain rule refuses leaves no user, mapping or membership", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org, {
      restrictToVerifiedDomains: true,
      allowedEmailDomains: ["unverified.example"],
    });
    const email = `refused-${randomUUID().slice(0, 8)}@unverified.example`;
    const res = await signIn(conn, email);
    expect(res.statusCode, res.body).toBe(302);
    expect(String(res.headers.location)).toContain("saml_error=");
    expect(sessionSet(res)).toBe(false);

    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.externalIdentityMapping.count({ where: { externalSubjectId: email } })).toBe(0);
    expect(await prisma.teamMember.count({ where: { teamId: org.workspaceId, user: { email } } })).toBe(0);
  });

  it("IDENT-006: control, the same sign-in on a verified domain provisions", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const domain = `${randomUUID().slice(0, 8)}.verified.example`;
    await prisma.organizationDomain.create({
      data: {
        organizationId: org.organizationId,
        domain,
        verifiedAt: new Date(),
        verificationToken: randomUUID(),
        createdByUserId: org.owner.userId,
      } as never,
    });
    const conn = await connection(org, { restrictToVerifiedDomains: true, allowedEmailDomains: [domain] });
    const email = `person@${domain}`;
    const res = await signIn(conn, email);
    expect(res.headers.location).toBe(`${WEB}/home`);
    expect(await prisma.teamMember.count({ where: { teamId: org.workspaceId, user: { email }, status: "ACTIVE" } })).toBe(1);
  });

  it("IDENT-009: moving part of a signed subject into CDATA does not truncate it", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const victim = `victim-${randomUUID().slice(0, 8)}@example.test`;
    const signedSubject = `${victim}.evil.example`;

    const firstSignIn = await signIn(conn, victim);
    expect(firstSignIn.headers.location).toBe(`${WEB}/home`);
    const victimUser = await prisma.user.findFirstOrThrow({ where: { email: victim }, select: { id: true } });

    const { requestId, relayState, cookie } = await startSignIn(conn);
    const signed = Buffer.from(
      buildSignedSamlResponse({ inResponseTo: requestId, nameId: signedSubject }),
      "base64",
    ).toString("utf8");
    const rewritten = signed.replace(signedSubject, `${victim}<![CDATA[.evil.example]]>`);
    expect(rewritten).not.toBe(signed);
    const res = await postAcs(Buffer.from(rewritten).toString("base64"), relayState, cookie);

    const sessions = await prisma.authenticatedSession.count({ where: { userId: victimUser.id } });
    expect(sessions).toBe(1);
    // The person it reads as is the one the signature covers.
    expect(await prisma.externalIdentityMapping.count({ where: { externalSubjectId: signedSubject } })).toBe(1);
    expect(res.statusCode).toBe(302);
  });

  it("IDENT-010: closure ends the mapping, and an IdP cannot sign the account back in", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `closing-${randomUUID().slice(0, 8)}@example.test`;
    expect((await signIn(conn, email)).headers.location).toBe(`${WEB}/home`);
    const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
    const before = await prisma.authenticatedSession.count({ where: { userId: user.id } });

    await closure.executeAccountClosure(user.id);

    const mapping = await prisma.externalIdentityMapping.findFirstOrThrow({
      where: { userId: user.id },
      select: { unlinkedAtUtc: true },
    });
    expect(mapping.unlinkedAtUtc).not.toBeNull();

    const refused = await signIn(conn, email);
    expect(String(refused.headers.location)).toContain("saml_error=");
    expect(sessionSet(refused)).toBe(false);
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(before);
  });

  it("IDENT-010: a mapping left linked by an older closure refuses too", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const conn = await connection(org);
    const email = `legacy-${randomUUID().slice(0, 8)}@example.test`;
    await signIn(conn, email);
    const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
    await prisma.user.update({ where: { id: user.id }, data: { providerUserId: `closed:${user.id}` } });

    const refused = await signIn(conn, email);
    expect(String(refused.headers.location)).toContain("saml_error=");
    expect(sessionSet(refused)).toBe(false);
  });

  it("IDENT-010: a directory cannot reopen a closed account, and can reopen an open one", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0]!;
    const ctx = {
      teamId: org.workspaceId,
      organizationId: org.organizationId,
      tokenId: randomUUID(),
    } as never;
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: org.workspaceId, userId: member.userId } },
      data: { status: "SUSPENDED" },
    });
    await prisma.user.update({ where: { id: member.userId }, data: { providerUserId: `closed:${member.userId}` } });
    expect(await scim.scimReactivateUser(ctx, member.userId, prisma as never)).toMatchObject({ ok: false });
    const row = await prisma.teamMember.findUniqueOrThrow({
      where: { teamId_userId: { teamId: org.workspaceId, userId: member.userId } },
      select: { status: true },
    });
    expect(row.status).toBe("SUSPENDED");

    const personal = await seedPersonalTenant(deps, "FREE");
    expect(personal.owner.userId).not.toBe(member.userId);
  });
});
