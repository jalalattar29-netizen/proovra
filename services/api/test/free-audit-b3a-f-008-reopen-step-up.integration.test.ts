/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies of several shapes. */
/**
 * FREE-USER AUDIT 0ea0 — B3A-F-008 remainder (live PostgreSQL 16, real routes).
 *
 * POST /v1/teams/:id/reopen asks the workspace owner for the same account
 * step-up the closure takes (verifyAccountStepUp, proof in the body) — behind
 * WORKSPACE_REOPEN_STEP_UP_ENFORCED, OFF by default, because an installed native
 * build may predate the client that answers the challenge. When ON it applies
 * to EVERY caller; no client version claim is read. The uniform 404 comes
 * first either way: a non-owner and an unknown id learn nothing, and are never
 * asked for proof.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Res = { statusCode: number; body: string };
type Prisma = (typeof import("../src/db.js"))["prisma"];
const FLAG = "WORKSPACE_REOPEN_STEP_UP_ENFORCED";

describe("B3A-F-008 — workspace reopen step-up behind WORKSPACE_REOPEN_STEP_UP_ENFORCED (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let hashPassword: (p: string) => Promise<string>;
  const PASSWORD = "B3a-F008-Reopen-Passphrase1";
  let ip = 1;
  const saved = process.env[FLAG];

  const reopen = (teamId: string, token: string, payload: unknown = {}): Promise<Res> =>
    h.app.inject({
      method: "POST",
      url: `/v1/teams/${teamId}/reopen`,
      remoteAddress: `198.18.1.${(ip++ % 250) + 1}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: payload as never,
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, any>;
  const B = () => h.fixtures.teamB;

  /** Team B, closed: a COMPLETED closure and the lifecycle marker set. */
  async function closeTeamB(): Promise<void> {
    await prisma.workspaceClosureRequest.create({
      data: {
        teamId: B().teamId,
        requestedByUserId: B().ownerUserId,
        status: "COMPLETED",
        completedAtUtc: new Date(),
      } as never,
    });
    await prisma.team.update({ where: { id: B().teamId }, data: { closedAtUtc: new Date() } });
  }
  const isClosed = async () =>
    (await prisma.team.findUniqueOrThrow({ where: { id: B().teamId }, select: { closedAtUtc: true } })).closedAtUtc !== null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    await prisma.user.update({ where: { id: B().ownerUserId }, data: { passwordHash: await hashPassword(PASSWORD) } });
  }, 300_000);

  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("ON: the owner without proof gets STEP_UP_REQUIRED and the workspace stays closed; a wrong password is STEP_UP_INVALID; the right one reopens", async () => {
    process.env[FLAG] = "true";
    await closeTeamB();

    const missing = await reopen(B().teamId, B().ownerToken);
    expect(missing.statusCode, missing.body).toBe(401);
    expect(json(missing).error.code).toBe("STEP_UP_REQUIRED");
    expect(json(missing).error.methods).toContain("password");
    expect(await isClosed()).toBe(true);

    const wrong = await reopen(B().teamId, B().ownerToken, { stepUp: { method: "password", currentPassword: "not-it-1A" } });
    expect(wrong.statusCode, wrong.body).toBe(401);
    expect(json(wrong).error.code).toBe("STEP_UP_INVALID");
    expect(await isClosed()).toBe(true);

    const ok = await reopen(B().teamId, B().ownerToken, { stepUp: { method: "password", currentPassword: PASSWORD } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(json(ok).reopened.teamId).toBe(B().teamId);
    expect(await isClosed()).toBe(false);
  });

  it("ON: a non-owner and an unknown id get the same 404 before any step-up — with or without proof", async () => {
    process.env[FLAG] = "true";
    await closeTeamB();
    const unknown = await reopen(randomUUID(), B().adminToken);
    const notOwner = await reopen(B().teamId, B().adminToken);
    const otherTenant = await reopen(B().teamId, h.fixtures.teamA.ownerToken);
    const withProof = await reopen(B().teamId, B().adminToken, { stepUp: { method: "password", currentPassword: PASSWORD } });
    for (const r of [unknown, notOwner, otherTenant, withProof]) {
      expect(r.statusCode, r.body).toBe(404);
      expect(r.body).toBe(unknown.body);
      expect(r.body).not.toContain("STEP_UP");
    }
    expect(await isClosed()).toBe(true);
    // Clean up for the next case: the owner reopens with proof.
    const ok = await reopen(B().teamId, B().ownerToken, { stepUp: { method: "password", currentPassword: PASSWORD } });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("OFF (default): reopen behaves as today — no proof asked, a body without stepUp reopens", async () => {
    delete process.env[FLAG];
    await closeTeamB();
    const ok = await reopen(B().teamId, B().ownerToken);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await isClosed()).toBe(false);
    // Any value other than "true" is OFF.
    process.env[FLAG] = "1";
    await closeTeamB();
    const stillOff = await reopen(B().teamId, B().ownerToken, {});
    expect(stillOff.statusCode, stillOff.body).toBe(200);
  });
});
