/**
 * AUTH-LOCKOUT-NONTOTP — a step-up factor never turns sign-in into a second
 * factor the sign-in cannot take.
 *
 * A password account can enrol a verified phone as its FIRST factor through the
 * contact-factor routes (no other factor, so no step-up). The login MFA gate
 * counted it, so `POST /v1/auth/email/login` answered `mfaRequired` with a
 * pending token, while `POST /v1/auth/mfa/verify` accepts only an authenticator
 * or recovery code and the account had neither: the sign-in could not finish.
 *
 * Real routes against live PostgreSQL; one-time codes go to the in-process
 * recording messaging transport (no provider is contacted).
 */
import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, OrganizationTenant, SeededUser } from "./point7/product-fixtures.js";

function totp(secretBase32: string, atMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.from(bits.slice(0, bits.length - (bits.length % 8)).match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac("sha1", bytes).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

type Res = { statusCode: number; body: string };

describe("AUTH-LOCKOUT-NONTOTP — sign-in with a phone-only account (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let recording: typeof import("../src/services/communications/recording-provider.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let deps: FixtureDeps;
  const password = "Str0ng-nontotp-passphrase!";
  let ip = 1;

  const post = (url: string, token: string | null, payload: unknown = {}): Promise<Res> =>
    h.app.inject({
      method: "POST",
      url,
      remoteAddress: `198.51.100.${(ip++ % 250) + 1}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      payload: payload as never,
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, unknown>;

  const lastCodeTo = (phone: string) =>
    recording
      .recordedMessages()
      .filter((m) => m.recipientAlias === recording.recipientAliasForPhone(phone) && m.code)
      .at(-1)?.code;

  async function memberWithPassword(level: "OFF" | "ALL_MEMBERS"): Promise<{ o: OrganizationTenant; m: SeededUser }> {
    const o = await fx.seedOrganizationTenant(deps, { memberCount: 1 });
    if (level !== "OFF") {
      await prisma.organizationSecurityPolicy.update({
        where: { organizationId: o.organizationId },
        data: { mfaPolicyLevel: level },
      });
    }
    const m = o.members[0]!;
    await prisma.user.update({
      where: { id: m.userId },
      data: { passwordHash: hashPassword(password), emailVerifiedAt: new Date() },
    });
    return { o, m };
  }

  /** Enrol a phone through the real routes. The account holds no other factor. */
  async function enrolPhone(o: OrganizationTenant, m: SeededUser): Promise<string> {
    const phone = `+1415555${String(1000 + Math.floor(Math.random() * 8999))}`;
    const st = await post("/v1/identity-security/contact-factors/enroll/start", m.token, {
      teamId: o.workspaceId,
      channel: "SMS",
      destination: phone,
    });
    expect(st.statusCode, st.body).toBe(200);
    const factorId = (json(st).factor as { factorId: string }).factorId;
    const ok = await post("/v1/identity-security/contact-factors/enroll/verify", m.token, {
      teamId: o.workspaceId,
      factorId,
      verificationAttemptId: json(st).verificationAttemptId,
      code: lastCodeTo(phone),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await prisma.mfaFactor.count({ where: { userId: m.userId, status: "ACTIVE" } })).toBe(1);
    expect(await prisma.mfaFactor.count({ where: { userId: m.userId, kind: "TOTP" } })).toBe(0);
    return factorId;
  }

  const signIn = (email: string) => post("/v1/auth/email/login", null, { email, password });

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    recording = await import("../src/services/communications/recording-provider.js");
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `ntf-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it("no MFA policy: a phone-only account signs in — it is not handed a second factor it cannot answer", async () => {
    const { o, m } = await memberWithPassword("OFF");
    await enrolPhone(o, m);
    const res = await signIn(m.email);
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res);
    expect(body.mfaRequired).toBeUndefined();
    expect(body.mfaPendingToken).toBeUndefined();
    expect(typeof body.token).toBe("string");
  });

  it("organization requires MFA: a phone-only member is sent to enrol an authenticator, and can finish", async () => {
    // The phone was enrolled before the organization turned MFA on (under the
    // policy, a session without a second factor cannot reach enrolment at all).
    const { o, m } = await memberWithPassword("OFF");
    await enrolPhone(o, m);
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: o.organizationId },
      data: { mfaPolicyLevel: "ALL_MEMBERS" },
    });
    const res = await signIn(m.email);
    expect(res.statusCode, res.body).toBe(403);
    expect(json(res)).toMatchObject({ mfaEnrollmentRequired: true, code: "MFA_ENROLLMENT_REQUIRED" });
    const enrolToken = json(res).mfaEnrollmentToken as string;

    // The sign-in enrolment token is fresh primary authentication: holding a
    // phone does not put a step-up in its way.
    const start = await post("/v1/identity/mfa/enroll/start", enrolToken);
    expect(start.statusCode, start.body).toBe(200);
    const { factorId, secretBase32 } = json(start) as { factorId: string; secretBase32: string };
    const verified = await post("/v1/identity/mfa/enroll/verify", enrolToken, { factorId, code: totp(secretBase32) });
    expect(verified.statusCode, verified.body).toBe(200);
    const done = await post("/v1/auth/mfa/enrollment/complete", json(verified).mfaEnrollmentToken as string);
    expect(done.statusCode, done.body).toBe(200);
    expect(typeof json(done).token).toBe("string");
  });

  it("controls: an authenticator holder still needs the authenticator, and a recovery code still completes", async () => {
    const { o, m } = await memberWithPassword("OFF");
    await enrolPhone(o, m);
    // Adding the authenticator now needs the account step-up (PRO-015).
    const start = await post("/v1/identity/mfa/enroll/start", m.token, {
      stepUp: { method: "password", currentPassword: password },
    });
    expect(start.statusCode, start.body).toBe(200);
    const { factorId, secretBase32 } = json(start) as { factorId: string; secretBase32: string };
    const verified = await post("/v1/identity/mfa/enroll/verify", m.token, { factorId, code: totp(secretBase32) });
    expect(verified.statusCode, verified.body).toBe(200);
    const recoveryCodes = json(verified).recoveryCodes as string[];

    const first = await signIn(m.email);
    expect(first.statusCode, first.body).toBe(200);
    expect(json(first)).toMatchObject({ mfaRequired: true });
    expect(json(first).token).toBeUndefined();
    const wrong = await post("/v1/auth/mfa/verify", null, {
      mfaPendingToken: json(first).mfaPendingToken,
      code: String((Number(totp(secretBase32)) + 1) % 1_000_000).padStart(6, "0"),
    });
    expect(wrong.statusCode).toBe(401);
    // The authenticator's current code was spent by enrolment; use the next step.
    const ok = await post("/v1/auth/mfa/verify", null, {
      mfaPendingToken: json(first).mfaPendingToken,
      code: totp(secretBase32, Date.now() + 30_000),
    });
    expect(ok.statusCode, ok.body).toBe(200);

    const second = await signIn(m.email);
    expect(json(second)).toMatchObject({ mfaRequired: true });
    const byRecovery = await post("/v1/auth/mfa/verify", null, {
      mfaPendingToken: json(second).mfaPendingToken,
      recoveryCode: recoveryCodes[0],
    });
    expect(byRecovery.statusCode, byRecovery.body).toBe(200);
  });

  it("a person with nothing at all is unchanged (control)", async () => {
    const { m } = await memberWithPassword("OFF");
    const res = await signIn(m.email);
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res).mfaRequired).toBeUndefined();
  });
});
