/**
 * IDENT-007 / MOBILE-007 — a person whose organization requires MFA and who has
 * no factor can reach a working session, and the half-finished sign-in can do
 * nothing else. Real login route, real TOTP codes, real tenant rows.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedOrganizationTenant, type FixtureDeps } from "./point7/product-fixtures.js";

function totp(secretBase32: string, atMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.from(bits.slice(0, bits.length - (bits.length % 8)).match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac("sha1", bytes).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

describe("MFA enrolment during sign-in (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  const tag = `mes-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const password = "Str0ng-enrol-passphrase!";

  const post = (url: string, token: string | null, payload: unknown = {}) =>
    harness.app.inject({
      method: "POST",
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      payload: payload as never,
    });
  const get = (url: string, token: string) =>
    harness.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  /** A member of an MFA-required organization, with a password and no factor. */
  async function memberWithPassword() {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { mfaPolicyLevel: "ALL_MEMBERS" },
    });
    const member = org.members[0]!;
    const { hashPassword } = await import("../src/services/email-password-auth.service.js");
    await prisma.user.update({
      where: { id: member.userId },
      data: { passwordHash: await hashPassword(password), emailVerifiedAt: new Date() },
    });
    const evidence = await prisma.evidence.create({
      data: { ownerUserId: org.owner.userId, teamId: org.workspaceId, organizationId: org.organizationId, type: "PHOTO" },
      select: { id: true },
    });
    return { org, member, recordId: evidence.id };
  }

  async function signIn(email: string) {
    const res = await post("/v1/auth/email/login", null, { email, password });
    return { res, body: JSON.parse(res.body) as Record<string, string> };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          60 * 60,
        ),
    };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("no factor: sign-in answers with an enrolment token that reaches the enrolment routes only", async () => {
    const { member, recordId } = await memberWithPassword();
    const { res, body } = await signIn(member.email);
    expect(res.statusCode, res.body).toBe(403);
    expect(body).toMatchObject({ mfaEnrollmentRequired: true, code: "MFA_ENROLLMENT_REQUIRED" });
    expect(body.token).toBeUndefined();
    const token = body.mfaEnrollmentToken as string;

    expect((await get(`/v1/evidence/${recordId}`, token)).statusCode).toBe(403);
    expect((await get("/v1/evidence", token)).statusCode).toBe(403);
    expect((await get("/v1/auth/me", token)).statusCode).toBe(403);
    expect((await get("/v1/identity/mfa/factors", token)).statusCode).toBe(200);
  });

  it("the token finishes nothing until this holder has verified a factor", async () => {
    const { member } = await memberWithPassword();
    const { body } = await signIn(member.email);
    const early = await post("/v1/auth/mfa/enrollment/complete", body.mfaEnrollmentToken);
    expect(early.statusCode, early.body).toBe(409);
    expect(await prisma.mfaFactor.count({ where: { userId: member.userId } })).toBe(0);
  });

  it("enrol, then finish: a real session reads the Organization and carries the second factor", async () => {
    const { member, recordId } = await memberWithPassword();
    const { body } = await signIn(member.email);
    const token = body.mfaEnrollmentToken as string;

    const start = await post("/v1/identity/mfa/enroll/start", token);
    expect(start.statusCode, start.body).toBe(200);
    const { factorId, secretBase32 } = JSON.parse(start.body) as { factorId: string; secretBase32: string };

    const wrong = await post("/v1/identity/mfa/enroll/verify", token, { factorId, code: "000000" });
    expect(wrong.statusCode).toBe(400);

    const verified = await post("/v1/identity/mfa/enroll/verify", token, { factorId, code: totp(secretBase32) });
    expect(verified.statusCode, verified.body).toBe(200);
    const verifiedBody = JSON.parse(verified.body) as { recoveryCodes: string[]; mfaEnrollmentToken: string };
    expect(verifiedBody.recoveryCodes.length).toBeGreaterThan(0);

    // The token from before the factor proves nothing.
    expect((await post("/v1/auth/mfa/enrollment/complete", token)).statusCode).toBe(409);

    const done = await post("/v1/auth/mfa/enrollment/complete", verifiedBody.mfaEnrollmentToken);
    expect(done.statusCode, done.body).toBe(200);
    const session = (JSON.parse(done.body) as { token: string }).token;

    const read = await get(`/v1/evidence/${recordId}`, session);
    expect(read.statusCode, read.body).toBe(200);
    expect(await prisma.authenticatedSession.count({ where: { userId: member.userId, revokedAtUtc: null } })).toBeGreaterThan(0);

    // Single use: the enrolment token ended with the sign-in.
    const replay = await post("/v1/auth/mfa/enrollment/complete", verifiedBody.mfaEnrollmentToken);
    expect(replay.statusCode).toBe(401);

    // The next sign-in is an ordinary challenge, not enrolment.
    const again = await signIn(member.email);
    expect(again.res.statusCode, again.res.body).toBe(200);
    expect(again.body).toMatchObject({ mfaRequired: true });
    expect(again.body.mfaEnrollmentToken).toBeUndefined();
  });

  it("a factor the holder did not verify finishes nothing for them", async () => {
    const { member } = await memberWithPassword();
    const { body } = await signIn(member.email);
    const start = await post("/v1/identity/mfa/enroll/start", member.token);
    const { factorId, secretBase32 } = JSON.parse(start.body) as { factorId: string; secretBase32: string };
    const other = await post("/v1/identity/mfa/enroll/verify", member.token, { factorId, code: totp(secretBase32) });
    expect(other.statusCode, other.body).toBe(200);
    const res = await post("/v1/auth/mfa/enrollment/complete", body.mfaEnrollmentToken);
    expect(res.statusCode, res.body).toBe(409);
  });

  it("an ordinary session cannot use the completion route to upgrade itself", async () => {
    const { member } = await memberWithPassword();
    const res = await post("/v1/auth/mfa/enrollment/complete", member.token);
    expect(res.statusCode, res.body).toBe(403);
  });
});
