/**
 * WHAT THE FRESH-ENTERPRISE JOURNEY FOUND, PINNED AT THE API.
 *
 * e2e/acceptance walks these in a browser. Each was a dead end for a new customer:
 * a step-up the modal could not start, an adaptive step-up nobody could answer, a
 * seat count that disagreed with the ceiling, and a seat refusal nobody was told.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedOperator, type Operator } from "./helpers/operator-step-up.js";
import type { IntegrationHarness } from "./integration-harness.js";
import {
  registerSessionForToken,
  seedOrganizationTenant,
  seedUser,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

type Json = Record<string, unknown>;

describe("fresh-enterprise repairs (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let operator: Operator;
  let gate: typeof import("../src/services/access-control/adaptive-runtime-gate.service.js");

  const startStepUp = (payload: Json, bearer = operator.token) =>
    harness.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      payload: payload as never,
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    gate = await import("../src/services/access-control/adaptive-runtime-gate.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `acc-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000), sid: randomUUID() } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    operator = await seedOperator(harness, deps, prisma as never, "acceptance-operator");
  });

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  it("the step-up route takes the null resource its own gate emits, and still refuses a bad one", async () => {
    const accepted = await startStepUp({
      teamId: operator.stepUpTeamId,
      purpose: "CAPABILITY_GRANT",
      resourceKind: "enterprise_provision",
      resourceId: null,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const row = await prisma.stepUpChallenge.findUniqueOrThrow({
      where: { id: (JSON.parse(accepted.body) as { challenge: { id: string } }).challenge.id },
    });
    expect(row.resourceId).toBeNull();

    const refused = await startStepUp({ teamId: operator.stepUpTeamId, purpose: "CAPABILITY_GRANT", resourceId: 7 });
    expect(refused.statusCode).toBe(400);
  });

  describe("a medium-risk session at the adaptive gate", () => {
    let userId: string;
    let token: string;
    let teamId: string;
    let sessionIdHash: string;

    const replyDouble = () => {
      const sent: { status?: number; body?: { error?: { code?: string; details?: Json } } } = {};
      const reply = {
        code(status: number) {
          sent.status = status;
          return this;
        },
        send(body: never) {
          sent.body = body;
          return this;
        },
      };
      return { sent, reply: reply as never };
    };
    const request = (extra: Record<string, string> = {}) =>
      ({ headers: { authorization: `Bearer ${token}`, ...extra }, ip: "127.0.0.1", user: { sessionIdHash } }) as never;

    beforeAll(async () => {
      userId = operator.userId;
      teamId = operator.stepUpTeamId;
      token = deps.mintToken(userId, operator.email);
      await registerSessionForToken(deps, userId, token, teamId);
      const { hashSessionId } = await import("../src/services/identity-security/session-revocation.service.js");
      const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sid: string };
      sessionIdHash = hashSessionId(claims.sid);
      await prisma.authenticatedSession.updateMany({
        where: { sessionIdHash: hashSessionId(claims.sid) },
        data: { riskScore: 45 },
      });
    });

    it("answers in the shape a client can act on, not a code nobody recognises", async () => {
      const { sent, reply } = replyDouble();
      const result = await gate.runtimeAdaptiveGate({ req: request(), reply, teamId, userId, action: "MEMBER_SUSPEND" });
      expect(result.allow).toBe(false);
      expect(sent.status).toBe(401);
      expect(sent.body?.error?.code).toBe("STEP_UP_REQUIRED");
      expect(sent.body?.error?.details?.purpose).toBe("SESSION_SANITY_CHECK");
    });

    it("lets a caller that runs its own step-up take the decision, sending nothing", async () => {
      const { sent, reply } = replyDouble();
      const result = await gate.runtimeAdaptiveGate({
        req: request(),
        reply,
        teamId,
        userId,
        action: "REVIEWER_APPROVE",
        callerEnforcesStepUp: true,
      });
      expect(result).toEqual({ allow: true, stepUpRequired: true });
      expect(sent.status).toBeUndefined();
    });

    it("passes with a real approved challenge, once, and never with a forged one", async () => {
      const forged = replyDouble();
      const refused = await gate.runtimeAdaptiveGate({
        req: request({ "x-proovra-step-up-challenge-id": randomUUID() }),
        reply: forged.reply,
        teamId,
        userId,
        action: "MEMBER_SUSPEND",
      });
      expect(refused.allow).toBe(false);

      // A challenge is bound to the session that started it.
      const started = await startStepUp(
        { teamId, purpose: "SESSION_SANITY_CHECK", resourceKind: "adaptive_runtime_gate" },
        token,
      );
      expect(started.statusCode, started.body).toBe(200);
      const challengeId = (JSON.parse(started.body) as { challenge: { id: string } }).challenge.id;
      const checked = await harness.app.inject({
        method: "POST",
        url: "/v1/identity-security/step-up/check",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { teamId, challengeId, code: operator.nextCode() },
      });
      expect(checked.statusCode, checked.body).toBe(200);

      const first = replyDouble();
      const allowed = await gate.runtimeAdaptiveGate({
        req: request({ "x-proovra-step-up-challenge-id": challengeId }),
        reply: first.reply,
        teamId,
        userId,
        action: "MEMBER_SUSPEND",
      });
      expect(allowed.allow, JSON.stringify(first.sent)).toBe(true);

      const replay = replyDouble();
      const again = await gate.runtimeAdaptiveGate({
        req: request({ "x-proovra-step-up-challenge-id": challengeId }),
        reply: replay.reply,
        teamId,
        userId,
        action: "MEMBER_SUSPEND",
      });
      expect(again.allow).toBe(false);
    });
  });

  describe("seats on a contract", () => {
    it("the billing projection counts what the ceiling counts: never the owner", async () => {
      const tenant = await seedOrganizationTenant(deps, { memberCount: 1 });
      await prisma.enterpriseContract.update({ where: { organizationId: tenant.organizationId }, data: { seatCount: 1 } });
      const res = await harness.app.inject({
        method: "GET",
        url: `/v1/billing/accounts/ORGANIZATION/${tenant.organizationId}`,
        headers: { authorization: `Bearer ${tenant.owner.token}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const seats = (JSON.parse(res.body) as { collaboration: { seats: { used: number; limit: number } } }).collaboration.seats;
      expect(seats).toMatchObject({ used: 1, limit: 1 });
    });

    it("acceptance into a full workspace keeps the membership, seats nobody and says so", async () => {
      const tenant = await seedOrganizationTenant(deps, { memberCount: 1 });
      await prisma.enterpriseContract.update({ where: { organizationId: tenant.organizationId }, data: { seatCount: 1 } });

      const invitee = await seedUser(deps, "no-seat-left");
      const created = await harness.app.inject({
        method: "POST",
        url: `/v1/orgs/${tenant.organizationId}/invites`,
        headers: { authorization: `Bearer ${tenant.owner.token}`, "content-type": "application/json" },
        payload: {
          email: invitee.email,
          role: "ORG_MEMBER",
          workspaceAssignments: [{ teamId: tenant.workspaceId, role: "MEMBER" }],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const inviteToken = (JSON.parse(created.body) as { token: string }).token;

      const accepted = await harness.app.inject({
        method: "POST",
        url: `/v1/org-invites/${inviteToken}/accept`,
        headers: { authorization: `Bearer ${invitee.token}` },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(JSON.parse(accepted.body)).toMatchObject({ assignedWorkspaceIds: [], refusedWorkspaceCount: 1 });

      expect(
        await prisma.organizationMembership.count({
          where: { organizationId: tenant.organizationId, userId: invitee.userId, status: "ACTIVE" },
        }),
      ).toBe(1);
      expect(await prisma.teamMember.count({ where: { teamId: tenant.workspaceId, userId: invitee.userId } })).toBe(0);
    });
  });
});
