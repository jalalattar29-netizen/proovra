/**
 * D27 (P1 SECURITY) — the external reviewer portal's MFA gate, proven live.
 *
 * A grant marked `mfaRequired` used to accept ANY six digits at
 * POST /v1/portal/auth: it recorded MFA_CHALLENGE_PASSED and stamped
 * `mfaSatisfiedAtUtc` without checking them against anything. The gate now
 * emails a one-time code to the grant's reviewer address and checks the answer
 * against a scrypt verifier held in Redis.
 *
 * Everything runs through `harness.app.inject` against a disposable
 * PostgreSQL 16 and the disposable Redis the harness points REDIS_URL at. The
 * email transport is the RECORDING provider (safe-environment.ts): the code is
 * read from the recorded message — never from Redis or the database.
 *
 * D27b — a verified code satisfies the SESSION it opened, not the grant: a
 * second holder of the same token must answer a fresh code.
 */

import { randomUUID } from "node:crypto";

import IORedis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("D27 portal MFA — emailed one-time code (live PostgreSQL 16 + Redis)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let recorder: typeof import("@proovra/shared-runtime");
  let challenge: typeof import("../src/services/external-review/portal-mfa-challenge.service.js");
  let redis: IORedis;

  const auth = (payload: Json) =>
    harness.app.inject({
      method: "POST",
      url: "/v1/portal/auth",
      headers: { "content-type": "application/json" },
      payload: payload as never,
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;
  const challengeKey = (grantId: string) => `portal:mfa-challenge:${grantId}`;
  const sessionKey = (grantId: string, sessionId: string) => `portal:mfa-session:${grantId}:${sessionId}`;
  const dashboard = (rawToken: string, sessionId?: string) =>
    harness.app.inject({
      method: "GET",
      url: "/v1/portal/dashboard",
      headers: {
        authorization: `Bearer ${rawToken}`,
        ...(sessionId ? { "x-portal-session": sessionId } : {}),
      },
    });

  async function issueMfaGrant() {
    const { issueInvitation } = await import(
      "../src/services/external-review/portal-invitation.service.js"
    );
    const { teamA } = harness.fixtures;
    const reviewerEmail = `d27-reviewer-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const issued = await issueInvitation({
      teamId: teamA.teamId,
      invitedByUserId: teamA.ownerUserId,
      reviewerEmail,
      role: "EXTERNAL_REVIEWER",
      mfaRequired: true,
      scope: { kind: "EVIDENCE", evidenceId: teamA.evidenceId },
      expiresAtUtc: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    if (!issued.ok) throw new Error(`invitation refused: ${issued.denial}`);
    return { grantId: issued.grantId, rawToken: issued.rawToken, reviewerEmail };
  }

  /** Every acknowledged message the recorder holds for this address. */
  const mailsTo = (email: string) => {
    const alias = recorder.recipientAliasFor(email);
    return recorder.recordedEmails().filter((m) => m.recipientAlias === alias);
  };
  /** The code a reviewer would read from their most recent message. */
  const mailedCode = (email: string): string => {
    const last = mailsTo(email)
      .filter((m) => m.result === "acknowledged")
      .at(-1);
    const match = last ? /^(\d{6}) is your .+ reviewer sign-in code$/.exec(last.subject) : null;
    if (!match) throw new Error("no sign-in code was mailed to the reviewer");
    return match[1]!;
  };
  const otherCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

  const satisfiedAt = async (grantId: string) =>
    (
      await prisma.externalReviewerRoleAssignment.findUniqueOrThrow({
        where: { id: grantId },
        select: { mfaSatisfiedAtUtc: true },
      })
    ).mfaSatisfiedAtUtc;
  const activity = (grantId: string, code: string) =>
    prisma.externalReviewActivity.findMany({
      where: { grantId, code },
      orderBy: { occurredAtUtc: "asc" },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    recorder = await import("@proovra/shared-runtime");
    challenge = await import("../src/services/external-review/portal-mfa-challenge.service.js");
    redis = new IORedis(process.env.REDIS_URL as string, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    await redis.connect();
  }, 180_000);

  afterEach(() => {
    challenge?.setPortalMfaChallengeRedisForTests(null);
    recorder?.scriptRecordingProviderFailure(null);
  });

  afterAll(async () => {
    redis?.disconnect();
    await harness?.cleanup();
  });

  it("no code: MFA_REQUIRED, and exactly one six-digit code is emailed to the invited address; a repeat within a minute sends nothing new", async () => {
    const grant = await issueMfaGrant();
    const before = mailsTo(grant.reviewerEmail).length;

    const res = await auth({ token: grant.rawToken });
    expect(res.statusCode).toBe(401);
    const body = json(res);
    expect(body).toMatchObject({ denial: "MFA_REQUIRED", codeSent: true, resendAvailableInSeconds: 60 });
    // Only the masked address leaves the API.
    expect(body.destination).toBe(`d***@test.proovra.local`);
    expect(res.body).not.toContain(grant.reviewerEmail);

    const mails = mailsTo(grant.reviewerEmail);
    expect(mails).toHaveLength(before + 1);
    expect(mails.at(-1)!.result).toBe("acknowledged");
    const code = mailedCode(grant.reviewerEmail);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(res.body).not.toContain(code);

    // Stored: a verifier with a TTL — never the code.
    const key = challengeKey(grant.grantId);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    const stored = await redis.hgetall(key);
    expect(Object.keys(stored).sort()).toEqual(["attempts", "cid", "record"]);
    const record = JSON.parse(stored.record!) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      "challengeId",
      "expiresAtMs",
      "issuedAtMs",
      "saltHex",
      "verifierHex",
    ]);
    expect(Object.values(record)).not.toContain(code);
    expect(stored.attempts).toBe("0");

    // Nothing was satisfied by asking.
    expect(await satisfiedAt(grant.grantId)).toBeNull();
    expect(await activity(grant.grantId, "MFA_CHALLENGE_PASSED")).toHaveLength(0);
    expect(await activity(grant.grantId, "LOGIN")).toHaveLength(0);
    // Holding the token is not enough to accept the invitation.
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grant.grantId } })).state).toBe(
      "INVITED",
    );

    // "Send a new code" inside the cooldown reuses the live code.
    const again = await auth({ token: grant.rawToken });
    expect(again.statusCode).toBe(401);
    expect(json(again)).toMatchObject({ denial: "MFA_REQUIRED", codeSent: true });
    expect(Number(json(again).resendAvailableInSeconds)).toBeGreaterThan(0);
    expect(mailsTo(grant.reviewerEmail)).toHaveLength(before + 1);
    expect(JSON.parse((await redis.hget(key, "record"))!).challengeId).toBe(record.challengeId);

    const outcomes = (await activity(grant.grantId, "MFA_CHALLENGE_FAILED")).map(
      (r) => (r.payload as { outcome?: string } | null)?.outcome,
    );
    expect(outcomes).toEqual(["CODE_SENT", "CODE_REUSED"]);
  });

  it("an arbitrary six-digit code is refused with MFA_INVALID and satisfies nothing — with or without a live challenge", async () => {
    // No challenge was ever requested for this grant.
    const cold = await issueMfaGrant();
    const coldRes = await auth({ token: cold.rawToken, mfaToken: "123456" });
    expect(coldRes.statusCode).toBe(401);
    expect(json(coldRes).denial).toBe("MFA_INVALID");
    expect(await satisfiedAt(cold.grantId)).toBeNull();
    expect(await activity(cold.grantId, "MFA_CHALLENGE_PASSED")).toHaveLength(0);
    expect(await activity(cold.grantId, "LOGIN")).toHaveLength(0);

    // A live challenge exists, and the answer is not its code.
    const grant = await issueMfaGrant();
    expect((await auth({ token: grant.rawToken })).statusCode).toBe(401);
    const wrong = otherCode(mailedCode(grant.reviewerEmail));
    const res = await auth({ token: grant.rawToken, mfaToken: wrong });
    expect(res.statusCode).toBe(401);
    expect(json(res)).toMatchObject({ denial: "MFA_INVALID", attemptsRemaining: 4 });
    expect(await satisfiedAt(grant.grantId)).toBeNull();
    expect(await activity(grant.grantId, "MFA_CHALLENGE_PASSED")).toHaveLength(0);
    expect(await activity(grant.grantId, "LOGIN")).toHaveLength(0);
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grant.grantId } })).state).toBe(
      "INVITED",
    );
  });

  it("the emailed code opens the session once: satisfaction is stamped, the challenge is consumed, and the same code never works again", async () => {
    const grant = await issueMfaGrant();
    expect((await auth({ token: grant.rawToken })).statusCode).toBe(401);
    const code = mailedCode(grant.reviewerEmail);

    const res = await auth({ token: grant.rawToken, mfaToken: code });
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res);
    expect(body.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.reviewerEmail).toBe(grant.reviewerEmail);

    expect(await satisfiedAt(grant.grantId)).toBeInstanceOf(Date);
    const passed = await activity(grant.grantId, "MFA_CHALLENGE_PASSED");
    expect(passed).toHaveLength(1);
    expect(passed[0]!.payload).toEqual({ method: "EMAIL_CODE" });
    expect(await activity(grant.grantId, "LOGIN")).toHaveLength(1);
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: grant.grantId } })).state).toBe(
      "ACTIVE",
    );
    // Consumed.
    expect(await redis.exists(challengeKey(grant.grantId))).toBe(0);

    // Within the satisfaction window no code is asked for again.
    const within = await auth({ token: grant.rawToken, existingSessionId: String(body.sessionId) });
    expect(within.statusCode).toBe(200);

    // Once the session's satisfaction lapses, the spent code is worthless.
    const stamped = await satisfiedAt(grant.grantId);
    expect(await redis.del(sessionKey(grant.grantId, String(body.sessionId)))).toBe(1);
    const replay = await auth({ token: grant.rawToken, mfaToken: code, existingSessionId: String(body.sessionId) });
    expect(replay.statusCode).toBe(401);
    expect(json(replay).denial).toBe("MFA_INVALID");
    expect(await satisfiedAt(grant.grantId)).toEqual(stamped);
    expect(await activity(grant.grantId, "MFA_CHALLENGE_PASSED")).toHaveLength(1);
  });

  it("D27b — satisfaction belongs to the session: another holder of the token, a forged session id and a logged-out session all need a code", async () => {
    const grant = await issueMfaGrant();
    expect((await auth({ token: grant.rawToken })).statusCode).toBe(401);
    const opened = await auth({ token: grant.rawToken, mfaToken: mailedCode(grant.reviewerEmail) });
    expect(opened.statusCode, opened.body).toBe(200);
    const sessionId = String(json(opened).sessionId);

    // The reviewer's own session is satisfied and slides.
    const own = await dashboard(grant.rawToken, sessionId);
    expect(own.statusCode, own.body).toBe(200);

    // A second holder of the same token, moments later, starts a new session:
    // no session is issued, and a code goes to the invited mailbox.
    const mailsBefore = mailsTo(grant.reviewerEmail).length;
    const second = await auth({ token: grant.rawToken });
    expect(second.statusCode).toBe(401);
    expect(json(second)).toMatchObject({ denial: "MFA_REQUIRED", codeSent: true });
    expect(json(second).sessionId).toBeUndefined();
    expect(mailsTo(grant.reviewerEmail).length).toBe(mailsBefore + 1);
    // …and cannot use the portal without one either.
    const bare = await dashboard(grant.rawToken);
    expect(bare.statusCode).toBe(401);
    expect(json(bare)).toEqual({ denial: "MFA_REQUIRED" });

    // A made-up session id is not a satisfied session.
    const forged = await dashboard(grant.rawToken, "0".repeat(32));
    expect(forged.statusCode).toBe(401);
    expect(json(forged)).toEqual({ denial: "MFA_REQUIRED" });
    expect(await activity(grant.grantId, "MFA_CHALLENGE_PASSED")).toHaveLength(1);
    expect(await redis.pttl(sessionKey(grant.grantId, sessionId))).toBeGreaterThan(0);

    // Logging out ends the session's satisfaction.
    const logout = await harness.app.inject({
      method: "POST",
      url: "/v1/portal/logout",
      headers: { authorization: `Bearer ${grant.rawToken}`, "x-portal-session": sessionId },
    });
    expect(logout.statusCode, logout.body).toBe(200);
    expect(await redis.exists(sessionKey(grant.grantId, sessionId))).toBe(0);
    const after = await dashboard(grant.rawToken, sessionId);
    expect(after.statusCode).toBe(401);
    expect(json(after)).toEqual({ denial: "MFA_REQUIRED" });
  });

  it("five wrong codes destroy the challenge (MFA_CODE_EXHAUSTED); the real code no longer works and a new one must be requested", async () => {
    const grant = await issueMfaGrant();
    expect((await auth({ token: grant.rawToken })).statusCode).toBe(401);
    const code = mailedCode(grant.reviewerEmail);
    const wrong = otherCode(code);

    for (const remaining of [4, 3, 2, 1]) {
      const res = await auth({ token: grant.rawToken, mfaToken: wrong });
      expect(res.statusCode).toBe(401);
      expect(json(res)).toMatchObject({ denial: "MFA_INVALID", attemptsRemaining: remaining });
    }
    const fifth = await auth({ token: grant.rawToken, mfaToken: wrong });
    expect(fifth.statusCode).toBe(401);
    expect(json(fifth)).toMatchObject({ denial: "MFA_CODE_EXHAUSTED", attemptsRemaining: 0 });
    expect(await redis.exists(challengeKey(grant.grantId))).toBe(0);

    const late = await auth({ token: grant.rawToken, mfaToken: code });
    expect(late.statusCode).toBe(401);
    expect(json(late).denial).toBe("MFA_INVALID");
    expect(await satisfiedAt(grant.grantId)).toBeNull();
    expect(await activity(grant.grantId, "MFA_CHALLENGE_PASSED")).toHaveLength(0);

    // A new code can be requested and works.
    expect(json(await auth({ token: grant.rawToken }))).toMatchObject({ denial: "MFA_REQUIRED", codeSent: true });
    const fresh = mailedCode(grant.reviewerEmail);
    expect((await auth({ token: grant.rawToken, mfaToken: fresh })).statusCode).toBe(200);
    expect(await satisfiedAt(grant.grantId)).toBeInstanceOf(Date);
  });

  it("code issuance is rate limited per grant (5 per 15 minutes)", async () => {
    const grant = await issueMfaGrant();
    const before = mailsTo(grant.reviewerEmail).length;
    for (let i = 0; i < 5; i += 1) {
      // Retire the live challenge so each request is a real issuance rather
      // than a reuse inside the one-minute cooldown.
      await redis.del(challengeKey(grant.grantId));
      const res = await auth({ token: grant.rawToken });
      expect(json(res)).toMatchObject({ denial: "MFA_REQUIRED", codeSent: true });
    }
    expect(mailsTo(grant.reviewerEmail)).toHaveLength(before + 5);
    await redis.del(challengeKey(grant.grantId));
    const limited = await auth({ token: grant.rawToken });
    expect(limited.statusCode).toBe(429);
    expect(json(limited)).toEqual({ denial: "RATE_LIMITED" });
    expect(mailsTo(grant.reviewerEmail)).toHaveLength(before + 5);
    expect(await satisfiedAt(grant.grantId)).toBeNull();
  });

  it("an email the transport refuses fails closed with MFA_UNAVAILABLE and leaves no answerable challenge", async () => {
    const grant = await issueMfaGrant();
    recorder.scriptRecordingProviderFailure({
      kind: "permanent",
      errorCode: "provider_rejected_422",
      httpStatus: 422,
    });
    const res = await auth({ token: grant.rawToken });
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ denial: "MFA_UNAVAILABLE" });
    expect(mailsTo(grant.reviewerEmail).filter((m) => m.result === "acknowledged")).toHaveLength(0);
    expect(await redis.exists(challengeKey(grant.grantId))).toBe(0);
    const guess = await auth({ token: grant.rawToken, mfaToken: "000000" });
    expect(json(guess).denial).toBe("MFA_INVALID");
    expect(await satisfiedAt(grant.grantId)).toBeNull();
  });

  it("an unreachable challenge store fails closed with MFA_UNAVAILABLE for both issuing and checking", async () => {
    const grant = await issueMfaGrant();
    const before = mailsTo(grant.reviewerEmail).length;
    // Nothing listens on loopback port 1.
    const dead = new IORedis("redis://127.0.0.1:1", {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      retryStrategy: () => null,
    });
    dead.on("error", () => undefined);
    challenge.setPortalMfaChallengeRedisForTests(dead);
    try {
      const ask = await auth({ token: grant.rawToken });
      expect(ask.statusCode).toBe(503);
      expect(json(ask)).toEqual({ denial: "MFA_UNAVAILABLE" });
      expect(mailsTo(grant.reviewerEmail)).toHaveLength(before);

      const answer = await auth({ token: grant.rawToken, mfaToken: "123456" });
      expect(answer.statusCode).toBe(503);
      expect(json(answer)).toEqual({ denial: "MFA_UNAVAILABLE" });
      expect(await satisfiedAt(grant.grantId)).toBeNull();
      expect(await activity(grant.grantId, "MFA_CHALLENGE_PASSED")).toHaveLength(0);
      expect(await activity(grant.grantId, "LOGIN")).toHaveLength(0);
    } finally {
      dead.disconnect();
    }
  });

  it("portal requests other than the token exchange never send a code", async () => {
    // An accepted grant, asked for by a request with no satisfied session.
    const grant = await issueMfaGrant();
    expect((await auth({ token: grant.rawToken })).statusCode).toBe(401);
    expect((await auth({ token: grant.rawToken, mfaToken: mailedCode(grant.reviewerEmail) })).statusCode).toBe(200);
    const before = mailsTo(grant.reviewerEmail).length;
    const res = await dashboard(grant.rawToken);
    expect(res.statusCode).toBe(401);
    expect(json(res)).toEqual({ denial: "MFA_REQUIRED" });
    expect(mailsTo(grant.reviewerEmail)).toHaveLength(before);
    expect(await redis.exists(challengeKey(grant.grantId))).toBe(0);
  });
});
