/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies of several shapes. */
/**
 * FREE-USER AUDIT 0ea0 — B5B-F-301 remainder (live PostgreSQL 16, real routes).
 *
 * The lifecycle retention-policy writer (POST /v1/lifecycle/retention/policies,
 * POST /v1/lifecycle/retention/policies/:id/release) enforces the SAME account
 * step-up contract as its sibling writer to the same store
 * (governance-lifecycle.routes.ts: requireStepUpForSensitiveAction, purpose
 * RETENTION_POLICY_UPDATE, resource evidence_retention_policy — the team on
 * create, the policy on release). The Enterprise retention gate and the
 * permission check still answer first, so Free and non-admin callers see
 * exactly what they saw before. The web client that answers the challenge is
 * live (5e7c785); no native or extension client writes retention policies.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, PersonalTenant } from "./point7/product-fixtures.js";

type Res = { statusCode: number; body: string };
type Prisma = (typeof import("../src/db.js"))["prisma"];
const STEP = "x-proovra-step-up-challenge-id";

describe("B5B-F-301 — the lifecycle retention writer asks for account step-up (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let deps: FixtureDeps;
  let free: PersonalTenant;
  let ceremony: ReturnType<typeof import("./support/step-up-ceremony.js").createStepUpCeremony>;
  let ip = 1;

  const call = (url: string, token: string, payload: unknown, workspaceId: string, extra: Record<string, string> = {}): Promise<Res> =>
    h.app.inject({
      method: "POST",
      url,
      remoteAddress: `198.18.0.${(ip++ % 250) + 1}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-proovra-workspace-id": workspaceId,
        ...extra,
      },
      payload: payload as never,
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, any>;
  const A = () => h.fixtures.teamA;
  const policyBody = () => ({ name: `b5b-f-301 ${randomUUID().slice(0, 6)}`, template: "INSURANCE_7Y", scopeKind: "WORKSPACE" });
  const policiesNamed = (name: string) => prisma.evidenceRetentionPolicy.count({ where: { teamId: A().teamId, displayName: name } });

  async function activePolicy(): Promise<string> {
    const p = await prisma.evidenceRetentionPolicy.create({
      data: {
        teamId: A().teamId,
        displayName: `b5b-f-301 release ${randomUUID().slice(0, 6)}`,
        description: "lifecycle-template:INSURANCE_7Y",
        retentionDays: 7 * 365,
        scope: "WORKSPACE",
        status: "ACTIVE",
        createdByUserId: A().ownerUserId,
      },
      select: { id: true },
    });
    return p.id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    const fx = await import("./point7/product-fixtures.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({ prisma: prisma as never, inject: (opts) => h.app.inject(opts as never) as never });
    deps = {
      prisma: prisma as never,
      tag: `b5b301-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    free = await fx.seedPersonalTenant(deps, "FREE");

    // Team A is an Enterprise customer (retention policies are Enterprise-only).
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } }))
      .organizationId;
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("create: an entitled admin without proof gets STEP_UP_REQUIRED for the sibling's purpose and nothing is written; an approved challenge creates; a spent challenge is refused", async () => {
    const body = policyBody();
    const missing = await call("/v1/lifecycle/retention/policies", A().ownerToken, body, A().teamId);
    expect(missing.statusCode, missing.body).toBe(401);
    expect(json(missing).error.code).toBe("STEP_UP_REQUIRED");
    expect(json(missing).error.details).toMatchObject({
      purpose: "RETENTION_POLICY_UPDATE",
      resourceKind: "evidence_retention_policy",
      resourceId: A().teamId,
    });
    expect(await policiesNamed(body.name)).toBe(0);

    const header = await ceremony.approvedHeader({
      token: A().ownerToken,
      userId: A().ownerUserId,
      teamId: A().teamId,
      purpose: "RETENTION_POLICY_UPDATE",
      resourceKind: "evidence_retention_policy",
      resourceId: A().teamId,
    });
    const ok = await call("/v1/lifecycle/retention/policies", A().ownerToken, body, A().teamId, header);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await policiesNamed(body.name)).toBe(1);

    // The same challenge again is stale (single use): refused, nothing written.
    const second = policyBody();
    const stale = await call("/v1/lifecycle/retention/policies", A().ownerToken, second, A().teamId, header);
    expect(stale.statusCode, stale.body).toBe(401);
    expect(json(stale).error.code).toBe("STEP_UP_REQUIRED");
    expect(await policiesNamed(second.name)).toBe(0);

    // A garbage id is no challenge at all.
    const bogus = await call("/v1/lifecycle/retention/policies", A().ownerToken, second, A().teamId, { [STEP]: "not-a-challenge" });
    expect(bogus.statusCode).toBe(401);
    expect(await policiesNamed(second.name)).toBe(0);
  });

  it("release: no proof or a challenge for another policy is refused and the policy stays ACTIVE; a challenge for this policy archives it", async () => {
    const id = await activePolicy();
    const other = await activePolicy();
    const missing = await call(`/v1/lifecycle/retention/policies/${id}/release`, A().ownerToken, {}, A().teamId);
    expect(missing.statusCode, missing.body).toBe(401);
    expect(json(missing).error.code).toBe("STEP_UP_REQUIRED");
    expect(json(missing).error.details).toMatchObject({ purpose: "RETENTION_POLICY_UPDATE", resourceId: id });

    const forOther = await ceremony.approvedHeader({
      token: A().ownerToken,
      userId: A().ownerUserId,
      teamId: A().teamId,
      purpose: "RETENTION_POLICY_UPDATE",
      resourceKind: "evidence_retention_policy",
      resourceId: other,
    });
    const wrong = await call(`/v1/lifecycle/retention/policies/${id}/release`, A().ownerToken, {}, A().teamId, forOther);
    expect(wrong.statusCode, wrong.body).toBe(401);
    expect((await prisma.evidenceRetentionPolicy.findUniqueOrThrow({ where: { id } })).status).toBe("ACTIVE");

    const header = await ceremony.approvedHeader({
      token: A().ownerToken,
      userId: A().ownerUserId,
      teamId: A().teamId,
      purpose: "RETENTION_POLICY_UPDATE",
      resourceKind: "evidence_retention_policy",
      resourceId: id,
    });
    const ok = await call(`/v1/lifecycle/retention/policies/${id}/release`, A().ownerToken, {}, A().teamId, header);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.evidenceRetentionPolicy.findUniqueOrThrow({ where: { id } })).status).toBe("ARCHIVED");
  });

  it("Free keeps its 402 Enterprise answer (before any step-up), and a member without the permission keeps its 403", async () => {
    const body = policyBody();
    const freeRes = await call("/v1/lifecycle/retention/policies", free.owner.token, body, free.personalTeamId);
    expect(freeRes.statusCode, freeRes.body).toBe(402);
    expect(json(freeRes).error.code).toBe("ENTERPRISE_FEATURE_REQUIRED");
    expect(await prisma.evidenceRetentionPolicy.count({ where: { teamId: free.personalTeamId } })).toBe(0);

    const member = await call("/v1/lifecycle/retention/policies", A().memberToken, body, A().teamId);
    expect(member.statusCode, member.body).toBe(403);
    expect(JSON.stringify(json(member))).not.toContain("STEP_UP_REQUIRED");
    const id = await activePolicy();
    const memberRelease = await call(`/v1/lifecycle/retention/policies/${id}/release`, A().memberToken, {}, A().teamId);
    expect(memberRelease.statusCode, memberRelease.body).toBe(403);
    expect((await prisma.evidenceRetentionPolicy.findUniqueOrThrow({ where: { id } })).status).toBe("ACTIVE");
  });
});
