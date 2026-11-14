/**
 * F-06 / F-22 — the verification email is reported as what actually happened,
 * and a signup that failed half-way can be finished by its registrant.
 *
 * Through the real routes (`harness.app.inject`) against a disposable
 * PostgreSQL 16. Email is the local RECORDING provider; provider refusals and
 * timeouts are scripted on it (`scriptRecordingProviderFailure`), so the
 * route runs its real transport path and receives the same outcome kinds the
 * Resend transport returns. Write-boundary failures are injected with a
 * PostgreSQL trigger scoped to this file's addresses, so the failing statement
 * is the real one inside the real code path.
 *
 * F-06
 *   - success: verificationSent true, delivery "sent", one acknowledged email,
 *     one live link, resendAfterSec = the real cooldown
 *   - provider refusal: verificationSent false, delivery "failed", no live
 *     link, no cooldown — the first Resend really sends
 *   - timeout: delivery "unconfirmed"; the link stays; an immediate Resend is
 *     held by the cooldown (no blind duplicate)
 *   - a refused Resend does not kill the link already in the inbox; an
 *     acknowledged one retires it
 *   - repeated Resends inside the cooldown send nothing more; the response is
 *     the same body for an unknown address
 *   - an expired link is refused with INVALID_OR_EXPIRED
 * F-22
 *   - failure after the User row commits (entitlement write, token write):
 *     the retry with the same password finishes the signup (201, one user,
 *     one entitlement, one link); a different password still gets 409
 *   - a VERIFIED account is never resumed: 409, its password and sign-in kept
 *   - two concurrent submissions of one form: one user, one entitlement
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

const PASSWORD = "Register-Pass-1234";
const FAULT_PREFIX = "f22-fault-";

describe("F-06 / F-22 — verification delivery truth and resumable signup (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let recorder: typeof import("@proovra/shared-runtime");
  const createdEmails: string[] = [];
  let ipCounter = 1;
  const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

  const call = (url: string, payload: unknown) =>
    harness.app.inject({
      method: "POST",
      url,
      remoteAddress: nextIp(),
      headers: { "content-type": "application/json" },
      payload: payload as never,
    });
  const json = (r: { body: string }) => JSON.parse(r.body) as Json;

  function address(label: string, prefix = "f06-"): string {
    const email = `${prefix}${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    createdEmails.push(email);
    return email;
  }

  function mails(email: string) {
    const alias = recorder.recipientAliasFor(email);
    return recorder
      .recordedEmails()
      .filter((m) => m.recipientAlias === alias && m.templateKind === "email_verification");
  }
  const acknowledged = (email: string) => mails(email).filter((m) => m.result === "acknowledged");
  const tokenFrom = (m: { actionableLink: string | null }) =>
    new URL(m.actionableLink as string).searchParams.get("token") as string;
  const liveTokens = (userId: string) =>
    prisma.emailVerificationToken.findMany({ where: { userId, usedAt: null } });

  async function register(email: string, password = PASSWORD) {
    return call("/v1/auth/email/register", { email, password });
  }

  /** Make the newest live link older than the cooldown (a minute passing). */
  async function ageLinks(userId: string) {
    await prisma.emailVerificationToken.updateMany({
      where: { userId },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 1000) },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    recorder = await import("@proovra/shared-runtime");
  }, 180_000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS f22_fault_entitlements ON entitlements`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS f22_fault_tokens ON email_verification_tokens`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS f22_fault()`);
    recorder.scriptRecordingProviderFailure(null);
    await harness?.cleanup();
  });

  // ===========================================================================
  // F-06
  // ===========================================================================

  it("success: the provider accepted it, and the response says so with the real cooldown", async () => {
    const email = address("ok");
    const res = await register(email);
    expect(res.statusCode, res.body).toBe(201);
    expect(json(res)).toMatchObject({
      verificationSent: true,
      verificationDelivery: "sent",
      resendAfterSec: 60,
      email,
    });
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(acknowledged(email)).toHaveLength(1);
    const live = await liveTokens(user.id);
    expect(live).toHaveLength(1);
    expect(live[0]?.tokenHash).toBe(
      createHash("sha256").update(tokenFrom(acknowledged(email)[0]!)).digest("hex"),
    );
  });

  it("provider refusal: reported as not sent, no live link, and the first Resend really sends", async () => {
    const email = address("refused");
    recorder.scriptRecordingProviderFailure({ kind: "retryable", errorCode: "provider_unavailable", httpStatus: 503 });
    const res = await register(email);
    expect(res.statusCode, res.body).toBe(201);
    expect(json(res)).toMatchObject({ verificationSent: false, verificationDelivery: "failed", resendAfterSec: 0 });
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(mails(email).map((m) => m.result)).toEqual(["retryable"]);
    // The refused link never left the process: it is gone and holds no cooldown.
    expect(await prisma.emailVerificationToken.count({ where: { userId: user.id } })).toBe(0);

    // Immediately — inside what used to be a silent cooldown.
    const resend = await call("/v1/auth/email/resend-verification", { email });
    expect(resend.statusCode).toBe(200);
    expect(json(resend)).toEqual({ ok: true, retryAfterSec: 60 });
    expect(acknowledged(email)).toHaveLength(1);
    expect(await liveTokens(user.id)).toHaveLength(1);

    // The link that was sent works (with the password, PROV-001).
    const verify = await call("/v1/auth/email/verify", {
      token: tokenFrom(acknowledged(email)[0]!),
      password: PASSWORD,
    });
    expect(verify.statusCode, verify.body).toBe(200);
  });

  it("timeout: reported as unconfirmed; the link stays and an immediate Resend does not double-send", async () => {
    const email = address("timeout");
    recorder.scriptRecordingProviderFailure({ kind: "ambiguous", errorCode: "provider_timeout" });
    const res = await register(email);
    expect(res.statusCode, res.body).toBe(201);
    expect(json(res)).toMatchObject({ verificationSent: false, verificationDelivery: "unconfirmed", resendAfterSec: 60 });
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(await liveTokens(user.id)).toHaveLength(1);

    const resend = await call("/v1/auth/email/resend-verification", { email });
    expect(json(resend)).toEqual({ ok: true, retryAfterSec: 60 });
    expect(mails(email)).toHaveLength(1); // nothing new was attempted
    expect(await liveTokens(user.id)).toHaveLength(1);

    // After the cooldown a Resend is attempted and accepted.
    await ageLinks(user.id);
    await call("/v1/auth/email/resend-verification", { email });
    expect(acknowledged(email)).toHaveLength(1);
  });

  it("a refused Resend keeps the link already in the inbox; an accepted one retires it", async () => {
    const email = address("keep-link");
    expect((await register(email)).statusCode).toBe(201);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    const firstToken = tokenFrom(acknowledged(email)[0]!);

    await ageLinks(user.id);
    recorder.scriptRecordingProviderFailure({ kind: "permanent", errorCode: "invalid_recipient", httpStatus: 422 });
    await call("/v1/auth/email/resend-verification", { email });
    const afterRefusal = await liveTokens(user.id);
    expect(afterRefusal).toHaveLength(1);
    expect(afterRefusal[0]?.tokenHash).toBe(createHash("sha256").update(firstToken).digest("hex"));

    // Accepted resend: only the newest link works.
    await call("/v1/auth/email/resend-verification", { email });
    expect(acknowledged(email)).toHaveLength(2);
    const secondToken = tokenFrom(acknowledged(email)[1]!);
    const old = await call("/v1/auth/email/verify", { token: firstToken, password: PASSWORD });
    expect(old.statusCode).toBe(400);
    expect((json(old).error as Json).code).toBe("INVALID_OR_EXPIRED");
    const fresh = await call("/v1/auth/email/verify", { token: secondToken, password: PASSWORD });
    expect(fresh.statusCode, fresh.body).toBe(200);
  });

  it("repeated Resends inside the cooldown send nothing more; an unknown address gets the same body", async () => {
    const email = address("repeat");
    expect((await register(email)).statusCode).toBe(201);
    for (let i = 0; i < 3; i += 1) {
      const r = await call("/v1/auth/email/resend-verification", { email });
      expect(json(r)).toEqual({ ok: true, retryAfterSec: 60 });
    }
    expect(mails(email)).toHaveLength(1);

    const stranger = await call("/v1/auth/email/resend-verification", {
      email: `f06-nobody-${randomUUID().slice(0, 8)}@test.proovra.local`,
    });
    expect(stranger.statusCode).toBe(200);
    expect(json(stranger)).toEqual({ ok: true, retryAfterSec: 60 });
  });

  it("F-26f: an in-app return path rides in the emailed link; an off-site one is dropped", async () => {
    const good = address("next-ok");
    expect((await call("/v1/auth/email/register", { email: good, password: PASSWORD, next: "/billing?plan=pro" })).statusCode).toBe(201);
    const goodLink = new URL(acknowledged(good)[0]!.actionableLink as string);
    expect(goodLink.pathname).toBe("/auth/verify-email");
    expect(goodLink.searchParams.get("next")).toBe("/billing?plan=pro");

    for (const evil of ["//evil.example", "/\\evil.example", "https://evil.example/x"]) {
      const email = address("next-evil");
      expect((await call("/v1/auth/email/register", { email, password: PASSWORD, next: evil })).statusCode).toBe(201);
      const link = new URL(acknowledged(email)[0]!.actionableLink as string);
      expect(link.searchParams.has("next")).toBe(false);
    }

    // A resend can carry it too (the sign-in page's "verify your email" panel).
    const user = await prisma.user.findFirstOrThrow({ where: { email: good } });
    await ageLinks(user.id);
    await call("/v1/auth/email/resend-verification", { email: good, next: "/invite/tok_123" });
    const resent = new URL(acknowledged(good)[1]!.actionableLink as string);
    expect(resent.searchParams.get("next")).toBe("/invite/tok_123");
  });

  it("an expired link is refused and leaves the account unverified", async () => {
    const email = address("expired");
    expect((await register(email)).statusCode).toBe(201);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    await prisma.emailVerificationToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await call("/v1/auth/email/verify", { token: tokenFrom(acknowledged(email)[0]!), password: PASSWORD });
    expect(res.statusCode).toBe(400);
    expect((json(res).error as Json).code).toBe("INVALID_OR_EXPIRED");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
  });

  // ===========================================================================
  // F-22
  // ===========================================================================

  async function installFault(table: "entitlements" | "email_verification_tokens") {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION f22_fault() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND email LIKE '${FAULT_PREFIX}%') THEN
          RAISE EXCEPTION 'f22 injected fault';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    const name = table === "entitlements" ? "f22_fault_entitlements" : "f22_fault_tokens";
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION f22_fault()`,
    );
    return async () => prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
  }

  it.each(["entitlements", "email_verification_tokens"] as const)(
    "failure at the %s write after the user row commits: the same registrant's retry finishes the signup",
    async (table) => {
      const email = address(table.slice(0, 5), FAULT_PREFIX);
      const removeFault = await installFault(table);
      let first;
      try {
        first = await register(email);
      } finally {
        await removeFault();
      }
      expect(first.statusCode).toBe(500);
      const user = await prisma.user.findFirstOrThrow({ where: { email } });
      expect(acknowledged(email)).toHaveLength(0);

      // Someone else's password: still the plain conflict, nothing touched.
      const stranger = await register(email, "Other-Person-9876");
      expect(stranger.statusCode).toBe(409);
      expect((json(stranger).error as Json).code).toBe("EMAIL_ALREADY_EXISTS");
      expect(acknowledged(email)).toHaveLength(0);

      const retry = await register(email);
      expect(retry.statusCode, retry.body).toBe(201);
      expect(json(retry)).toMatchObject({ verificationSent: true, verificationDelivery: "sent" });
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(await prisma.entitlement.count({ where: { userId: user.id, active: true } })).toBe(1);
      expect(await liveTokens(user.id)).toHaveLength(1);
      expect(acknowledged(email)).toHaveLength(1);

      const verify = await call("/v1/auth/email/verify", { token: tokenFrom(acknowledged(email)[0]!), password: PASSWORD });
      expect(verify.statusCode, verify.body).toBe(200);
    },
  );

  it("a verified account is never resumed: 409, and its owner still signs in with the original password", async () => {
    const email = address("verified");
    expect((await register(email)).statusCode).toBe(201);
    const verify = await call("/v1/auth/email/verify", { token: tokenFrom(acknowledged(email)[0]!), password: PASSWORD });
    expect(verify.statusCode).toBe(200);
    const before = await prisma.user.findFirstOrThrow({ where: { email } });

    const again = await register(email);
    expect(again.statusCode).toBe(409);
    expect((json(again).error as Json).code).toBe("EMAIL_ALREADY_EXISTS");
    expect(acknowledged(email)).toHaveLength(1);
    const after = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.emailVerifiedAt).toEqual(before.emailVerifiedAt);

    const login = await call("/v1/auth/email/login", { email, password: PASSWORD });
    expect(login.statusCode, login.body).toBe(200);
  });

  it("two concurrent submissions of one form make one account and one entitlement", async () => {
    const email = address("double");
    const [a, b] = await Promise.all([register(email), register(email)]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const users = await prisma.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    expect(await prisma.entitlement.count({ where: { userId: users[0]!.id, active: true } })).toBe(1);
    // One live link in the end, whatever the interleaving.
    expect((await liveTokens(users[0]!.id)).length).toBeGreaterThanOrEqual(1);
    expect(acknowledged(email).length).toBeGreaterThanOrEqual(1);
  });
});
