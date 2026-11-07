/**
 * AUTH-LOCKOUT-NONTOTP — sign-in asks for, and accepts, the second factor the
 * person enrolled.
 *
 * A password account can enrol a verified phone or a passkey as its FIRST
 * factor. The login MFA gate counted it, while `POST /v1/auth/mfa/verify`
 * accepted only an authenticator or recovery code, so the sign-in could not
 * finish. An interim fix stopped counting those factors, which signed such an
 * account in with a password alone, bypassing the owner's own MFA choice.
 *
 * Now: every enrolled kind makes the sign-in ask for a second factor, with or
 * without an Organization MFA policy, and each kind can answer it (a code sent
 * to the enrolled phone; a passkey on the web; a passkey proved in the mobile
 * app's system browser). A password alone never completes such a sign-in.
 *
 * Real routes against live PostgreSQL; one-time codes go to the in-process
 * recording messaging transport (no provider is contacted); passkeys are a
 * software authenticator (test/helpers/soft-authenticator.ts).
 */
import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { SoftAuthenticator } from "./helpers/soft-authenticator.js";
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

  const RP_ID = "app.proovra.test";
  const ORIGIN = "https://app.proovra.test";
  /** A passkey as completePasskeyRegistration stores it, for a software authenticator. */
  async function seedPasskey(m: SeededUser): Promise<SoftAuthenticator> {
    const auth = new SoftAuthenticator(RP_ID, ORIGIN);
    const now = new Date();
    const factor = await prisma.mfaFactor.create({
      data: { userId: m.userId, kind: "PASSKEY", status: "ACTIVE", label: "Test key", verifiedAtUtc: now, enrolledAt: now },
      select: { id: true },
    });
    await prisma.mfaWebauthnCredential.create({
      data: {
        factorId: factor.id,
        userId: m.userId,
        credentialId: auth.id,
        publicKey: new Uint8Array(auth.coseKey()),
        signCount: BigInt(0),
        transports: ["internal"],
      },
    });
    return auth;
  }

  /** Signs in with the password and asserts a second factor is demanded, not skipped. */
  async function pendingFor(email: string): Promise<string> {
    const res = await signIn(email);
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toMatchObject({ mfaRequired: true });
    expect(json(res).token).toBeUndefined();
    return json(res).mfaPendingToken as string;
  }

  const savedEnv = { rp: process.env.WEBAUTHN_RP_ID, origins: process.env.WEBAUTHN_ORIGINS };

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    process.env.WEBAUTHN_RP_ID = RP_ID;
    process.env.WEBAUTHN_ORIGINS = ORIGIN;
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
    for (const [key, value] of [["WEBAUTHN_RP_ID", savedEnv.rp], ["WEBAUTHN_ORIGINS", savedEnv.origins]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await h?.cleanup();
  });

  /** The phone the account enrolled, for reading the recorded code. */
  const phoneOf = new Map<string, string>();
  async function enrolPhoneRemembered(o: OrganizationTenant, m: SeededUser): Promise<void> {
    const before = recording.recordedMessages().length;
    await enrolPhone(o, m);
    const sent = recording.recordedMessages().slice(before).find((x) => x.code);
    expect(sent).toBeTruthy();
    phoneOf.set(m.userId, sent!.recipientAlias);
  }
  const lastCodeToAlias = (alias: string) =>
    recording.recordedMessages().filter((x) => x.recipientAlias === alias && x.code).at(-1)?.code;

  it("no MFA policy: a phone-only account is asked for its phone code — a password alone does not sign it in", async () => {
    const { o, m } = await memberWithPassword("OFF");
    await enrolPhoneRemembered(o, m);
    const pending = await pendingFor(m.email);

    const methods = await post("/v1/auth/mfa/methods", null, { mfaPendingToken: pending });
    expect(methods.statusCode, methods.body).toBe(200);
    expect(json(methods).methods).toEqual(["SMS"]);
    expect(String(json(methods).destinationMask)).not.toMatch(/[0-9]{6}/);

    // Without a code having been sent, a guessed code answers nothing.
    const early = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, contactCode: "123456" });
    expect(early.statusCode).toBe(401);

    const sent = await post("/v1/auth/mfa/send-code", null, { mfaPendingToken: pending });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(json(sent)).toMatchObject({ sent: true, channel: "SMS" });
    const code = lastCodeToAlias(phoneOf.get(m.userId)!)!;
    const wrong = await post("/v1/auth/mfa/verify", null, {
      mfaPendingToken: pending,
      contactCode: code === "000000" ? "111111" : "000000",
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, contactCode: code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(typeof json(ok).token).toBe("string");
    // Spent: the same pending token completes nothing twice.
    const replay = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, contactCode: code });
    expect(replay.statusCode).toBe(401);
  });

  it("organization requires MFA: a phone-only member answers with the phone it enrolled", async () => {
    const { o, m } = await memberWithPassword("OFF");
    await enrolPhoneRemembered(o, m);
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: o.organizationId },
      data: { mfaPolicyLevel: "ALL_MEMBERS" },
    });
    const pending = await pendingFor(m.email);
    const sent = await post("/v1/auth/mfa/send-code", null, { mfaPendingToken: pending });
    expect(sent.statusCode, sent.body).toBe(200);
    const ok = await post("/v1/auth/mfa/verify", null, {
      mfaPendingToken: pending,
      contactCode: lastCodeToAlias(phoneOf.get(m.userId)!),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(typeof json(ok).token).toBe("string");
  });

  it("a passkey-only account is asked for its passkey on the web, and only that passkey's assertion completes", async () => {
    const { m } = await memberWithPassword("OFF");
    const auth = await seedPasskey(m);
    const pending = await pendingFor(m.email);
    const methods = await post("/v1/auth/mfa/methods", null, { mfaPendingToken: pending });
    expect(methods.statusCode, methods.body).toBe(200);
    expect(json(methods).methods).toEqual(["PASSKEY"]);
    const options = json(methods).passkeyOptions as { challenge: string };
    expect(typeof options.challenge).toBe("string");

    // Another authenticator, or this one signing another challenge, answers nothing.
    const stranger = new SoftAuthenticator(RP_ID, ORIGIN);
    expect((await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, passkeyAssertion: stranger.assert(options) })).statusCode).toBe(401);
    const otherChallenge = auth.assert(options, { challenge: Buffer.alloc(32, 9).toString("base64url") });
    expect((await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, passkeyAssertion: otherChallenge })).statusCode).toBe(401);
    // Claiming a browser handoff that never happened answers nothing.
    expect((await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, passkeyHandoff: true })).statusCode).toBe(401);

    const ok = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, passkeyAssertion: auth.assert(options) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(typeof json(ok).token).toBe("string");
  });

  it("mobile: the passkey is proved in the system browser by a single-use handoff, and the app completes the sign-in", async () => {
    const { m } = await memberWithPassword("OFF");
    const auth = await seedPasskey(m);
    const pending = await pendingFor(m.email);
    const methods = await post("/v1/auth/mfa/methods", null, { mfaPendingToken: pending, handoff: true });
    expect(methods.statusCode, methods.body).toBe(200);
    expect(json(methods).passkeyOptions).toBeNull();
    const url = String(json(methods).passkeyHandoffUrl);
    expect(url).toMatch(/\/auth\/mfa-passkey#token=/);
    const token = decodeURIComponent(url.split("#token=")[1]!.split("&")[0]!);

    const opts = await post("/v1/auth/mfa/passkey-handoff/options", null, { token });
    expect(opts.statusCode, opts.body).toBe(200);
    const options = json(opts).passkeyOptions as { challenge: string };

    // A wrong authenticator proves nothing, and the app still cannot complete.
    const stranger = new SoftAuthenticator(RP_ID, ORIGIN);
    expect((await post("/v1/auth/mfa/passkey-handoff/answer", null, { token, assertion: stranger.assert(options) })).statusCode).toBe(401);
    expect((await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, passkeyHandoff: true })).statusCode).toBe(401);

    const answered = await post("/v1/auth/mfa/passkey-handoff/answer", null, { token, assertion: auth.assert(options) });
    expect(answered.statusCode, answered.body).toBe(200);
    // The handoff token answers once.
    expect((await post("/v1/auth/mfa/passkey-handoff/options", null, { token })).statusCode).toBe(401);

    const ok = await post("/v1/auth/mfa/verify", null, { mfaPendingToken: pending, passkeyHandoff: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(typeof json(ok).token).toBe("string");
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
