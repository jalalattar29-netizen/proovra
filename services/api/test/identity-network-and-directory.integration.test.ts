/**
 * IDENT-017, IDENT-021, IDENT-013 — a network restriction that restricts, a SCIM
 * allowlist that compares networks, and a directory row a reset cannot take over.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedUser,
  type FixtureDeps,
  type OrganizationTenant,
} from "./point7/product-fixtures.js";
import { ipInRanges, isValidIpRange } from "../src/services/access-control/ip-ranges.js";

describe("IP ranges", () => {
  it("compares networks, not strings", () => {
    expect(ipInRanges("1.2.3.4", ["1.2.3.4"])).toBe(true);
    expect(ipInRanges("1.2.3.45", ["1.2.3.4"])).toBe(false);
    expect(ipInRanges("10.99.200.1", ["10.99.0.0/16"])).toBe(true);
    expect(ipInRanges("10.100.0.1", ["10.99.0.0/16"])).toBe(false);
    expect(ipInRanges("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipInRanges("2001:db9::1", ["2001:db8::/32"])).toBe(false);
  });

  it("reads an IPv4 client through a dual-stack socket", () => {
    expect(ipInRanges("::ffff:10.99.0.1", ["10.99.0.0/16"])).toBe(true);
  });

  it("an unknown or malformed address is on no list", () => {
    expect(ipInRanges(null, ["0.0.0.0/0"])).toBe(false);
    expect(ipInRanges("not-an-ip", ["0.0.0.0/0"])).toBe(false);
  });

  it("knows what a range is", () => {
    for (const ok of ["1.2.3.4", "10.0.0.0/8", "::1", "2001:db8::/32", "0.0.0.0/0"]) {
      expect(isValidIpRange(ok), ok).toBe(true);
    }
    for (const bad of ["", "10.0.0.0/33", "10.0.0/8", "example.com", "1.2.3.4/8/9", "2001:db8::/129"]) {
      expect(isValidIpRange(bad), bad).toBe(false);
    }
  });
});

describe("Network policy and directory accounts (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let policySvc: typeof import("../src/services/identity/org-security-policy.service.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let resets: typeof import("../src/services/email-password-auth.service.js");
  let deps: FixtureDeps;
  const tag = `ind-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const mint = (userId: string, email: string) =>
    signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );

  const from = (ip: string, url: string, token: string) =>
    harness.app.inject({
      method: "GET",
      url,
      remoteAddress: ip,
      headers: { authorization: `Bearer ${token}` },
    });

  const restrict = (org: OrganizationTenant, ranges: string[]) =>
    prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { restrictedIpRanges: ranges },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    policySvc = await import("../src/services/identity/org-security-policy.service.js");
    scim = await import("../src/services/access-control/scim.service.js");
    resets = await import("../src/services/email-password-auth.service.js");
    deps = { prisma: prisma as never, tag, mintToken: mint };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("IDENT-017: a member reads from inside the range and not from outside, owners included", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0]!;
    const url = `/v1/teams/${org.workspaceId}/members`;
    expect((await from("198.51.100.7", url, member.token)).statusCode).toBe(200);

    await restrict(org, ["10.99.0.0/16"]);
    expect((await from("198.51.100.7", url, member.token)).statusCode).toBe(404);
    expect((await from("198.51.100.7", url, org.owner.token)).statusCode).toBe(404);
    expect((await from("10.99.4.2", url, member.token)).statusCode).toBe(200);
    expect((await from("10.99.4.2", url, org.owner.token)).statusCode).toBe(200);
  });

  it("IDENT-017: the same session keeps Personal, which no Organization governs", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    await restrict(org, ["10.99.0.0/16"]);
    const res = await from("198.51.100.7", "/v1/evidence?scope=active", org.members[0]!.token);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("IDENT-017: an unreadable range and a self-lockout are refused, with nothing written", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const patch = (ranges: string[], ipAddress: string) =>
      policySvc.applySecurityPolicyPatch({
        organizationId: org.organizationId,
        actorUserId: org.owner.userId,
        patch: { restrictedIpRanges: ranges },
        ipAddress,
      });
    await expect(patch(["10.0.0.0/33"], "10.0.0.1")).rejects.toMatchObject({ code: "RESTRICTED_IP_RANGE_INVALID" });
    await expect(patch(["10.99.0.0/16"], "198.51.100.7")).rejects.toMatchObject({ code: "RESTRICTED_IP_EXCLUDES_ACTOR" });
    const row = await prisma.organizationSecurityPolicy.findUniqueOrThrow({
      where: { organizationId: org.organizationId },
      select: { restrictedIpRanges: true },
    });
    expect(row.restrictedIpRanges).toEqual([]);

    await patch(["10.99.0.0/16"], "10.99.0.1");
    const saved = await prisma.organizationSecurityPolicy.findUniqueOrThrow({
      where: { organizationId: org.organizationId },
      select: { restrictedIpRanges: true },
    });
    expect(saved.restrictedIpRanges).toEqual(["10.99.0.0/16"]);
  });

  it("IDENT-021: a SCIM allowlist admits the network, not a string prefix, and no unknown caller", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const created = await scim.createScimToken(
      {
        teamId: org.workspaceId,
        actorUserId: org.owner.userId,
        name: "dir",
        scopes: ["users.read"] as never,
        ipAllowlist: ["1.2.3.4", "10.0.0.0/8"],
      },
      prisma as never,
    );
    const check = (remoteIp: string | null) =>
      scim.authenticateScimRequest(
        { authorizationHeader: `Bearer ${created.tokenOnce}`, remoteIp },
        prisma as never,
      );
    expect((await check("1.2.3.4")).ok).toBe(true);
    expect((await check("10.5.6.7")).ok).toBe(true);
    expect(await check("1.2.3.45")).toMatchObject({ ok: false, reason: "ip_not_allowed" });
    expect(await check(null)).toMatchObject({ ok: false, reason: "ip_not_allowed" });
  });

  async function directoryRow(org: OrganizationTenant, email: string) {
    const subject = randomUUID();
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: `saml-${org.organizationId}:${subject}` },
      select: { id: true },
    });
    await prisma.externalIdentityMapping.create({
      data: {
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        userId: user.id,
        provider: "GENERIC_SAML",
        externalSubjectId: subject,
        externalEmail: email,
      },
    });
    return user.id;
  }

  it("IDENT-013: no reset on a row an IdP created for an address it never proved", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const email = `person-${randomUUID().slice(0, 8)}@other.example`;
    const userId = await directoryRow(org, email);
    expect(await resets.createPasswordResetTokenForEmail(email)).toBeNull();
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(0);
  });

  it("IDENT-013: controls, a proved domain resets, and so does the person's own account", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const domain = `${randomUUID().slice(0, 8)}.proved.example`;
    await prisma.organizationDomain.create({
      data: {
        organizationId: org.organizationId,
        domain,
        verifiedAt: new Date(),
        verificationToken: randomUUID(),
        createdByUserId: org.owner.userId,
      } as never,
    });
    const provenEmail = `person@${domain}`;
    await directoryRow(org, provenEmail);
    expect(await resets.createPasswordResetTokenForEmail(provenEmail)).not.toBeNull();

    // A squatted row at the same address cannot divert the real owner's reset.
    const own = await seedUser(deps, "own-account");
    const row = await prisma.user.update({
      where: { id: own.userId },
      data: { passwordHash: "scrypt$placeholder" },
      select: { email: true },
    });
    await directoryRow(org, row.email!);
    const issued = await resets.createPasswordResetTokenForEmail(row.email!);
    expect(issued).not.toBeNull();
    expect(await prisma.passwordResetToken.count({ where: { userId: own.userId } })).toBe(1);
  });
});
