/**
 * Free-user audit 0ea0 — SMS-SEND-UNBOUNDED (B1-F-001, B3C-F-001).
 *
 * Two routes send a one-time code to a caller-chosen number through the
 * platform's messaging provider:
 *
 *   - B1-F-001: `POST /v1/identity-security/contact-factors/enroll/start`
 *     computed its per-user rate limit (5/hour) and ignored the verdict, and a
 *     fresh account needs no step-up there — so any Free account could drive
 *     unlimited sends to new numbers.
 *   - B3C-F-001: `POST /v1/communications/verify/start` let any workspace
 *     OWNER — a Free user in their own personal workspace included — send
 *     codes to any number, with no plan gate and only a per-recipient limit.
 *
 * Live PostgreSQL + Redis; codes go to the in-process recording transport, so
 * "a send happened" is counted exactly and no provider is contacted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";

type Res = { statusCode: number; body: string };

describe("SMS-SEND-UNBOUNDED — every code send is bounded (live PostgreSQL + Redis)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let fx: typeof import("./point7/product-fixtures.js");
  let recording: typeof import("../src/services/communications/recording-provider.js");
  let deps: FixtureDeps;
  let ip = 1;
  let seq = 0;

  const post = (url: string, token: string, payload: unknown): Promise<Res> =>
    h.app.inject({
      method: "POST",
      url,
      remoteAddress: `198.51.100.${(ip++ % 250) + 1}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: payload as never,
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, unknown>;
  /** A number never used before in this run, so the per-recipient limit never trips. */
  const freshPhone = () => `+1415${String(5_000_000 + Math.floor(Math.random() * 4_000_000) + seq++).padStart(7, "0")}`;
  const sends = () => recording.recordedMessages().length;

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    fx = await import("./point7/product-fixtures.js");
    recording = await import("../src/services/communications/recording-provider.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `smsb-${Date.now().toString(36)}`,
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

  it("B1-F-001: a fresh Free account gets 5 phone-factor enrolment starts an hour; the 6th is refused before any factor row or send", async () => {
    const t = await fx.seedPersonalTenant(deps, "FREE");
    for (let i = 0; i < 5; i++) {
      const r = await post("/v1/identity-security/contact-factors/enroll/start", t.owner.token, {
        teamId: t.personalTeamId,
        channel: "SMS",
        destination: freshPhone(),
      });
      expect(r.statusCode, r.body).toBe(200);
    }
    const factorsBefore = await prisma.mfaFactor.count({ where: { userId: t.owner.userId } });
    // API-G2 recheck (acceptance: "creates no VerificationAttempt or pending factor").
    const attemptsBefore = await prisma.verificationAttempt.count({ where: { initiatedByUserId: t.owner.userId } });
    expect(attemptsBefore, "each legitimate start recorded its attempt").toBe(5);
    const sendsBefore = sends();
    const sixth = await post("/v1/identity-security/contact-factors/enroll/start", t.owner.token, {
      teamId: t.personalTeamId,
      channel: "SMS",
      destination: freshPhone(),
    });
    expect(sixth.statusCode, sixth.body).toBe(429);
    expect(json(sixth)).toMatchObject({ error: { code: "rate_limited" } });
    expect(await prisma.mfaFactor.count({ where: { userId: t.owner.userId } })).toBe(factorsBefore);
    expect(await prisma.verificationAttempt.count({ where: { initiatedByUserId: t.owner.userId } })).toBe(attemptsBefore);
    expect(sends()).toBe(sendsBefore);
  });

  it("B3C-F-001: a Free owner cannot send messaging verification codes from their personal workspace — refused before any attempt row or send", async () => {
    const t = await fx.seedPersonalTenant(deps, "FREE");
    const sendsBefore = sends();
    const r = await post("/v1/communications/verify/start", t.owner.token, {
      teamId: t.personalTeamId,
      channel: "SMS",
      phone: freshPhone(),
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(json(r)).toMatchObject({ error: { code: "INTAKE_NOT_INCLUDED" } });
    expect(await prisma.verificationAttempt.count({ where: { teamId: t.personalTeamId } })).toBe(0);
    expect(sends()).toBe(sendsBefore);
  });

  it("B3C-F-001: a workspace that includes intake is still bounded per actor across distinct numbers", async () => {
    const t = await fx.seedPersonalTenant(deps, "PRO");
    for (let i = 0; i < 10; i++) {
      const r = await post("/v1/communications/verify/start", t.owner.token, {
        teamId: t.personalTeamId,
        channel: "SMS",
        phone: freshPhone(),
      });
      expect(r.statusCode, r.body).toBe(200);
    }
    const attemptsBefore = await prisma.verificationAttempt.count({ where: { teamId: t.personalTeamId } });
    const sendsBefore = sends();
    const eleventh = await post("/v1/communications/verify/start", t.owner.token, {
      teamId: t.personalTeamId,
      channel: "SMS",
      phone: freshPhone(),
    });
    expect(eleventh.statusCode, eleventh.body).toBe(429);
    expect(json(eleventh)).toMatchObject({ error: { code: "rate_limited" } });
    expect(await prisma.verificationAttempt.count({ where: { teamId: t.personalTeamId } })).toBe(attemptsBefore);
    expect(sends()).toBe(sendsBefore);
  });
});
