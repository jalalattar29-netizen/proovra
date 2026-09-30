/**
 * ET-SEC-15 — the paid AI categorization run is a mutation, and the AI policy
 * is asked with its full inputs. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f POST /v1/evidence/:id/ai-categorization/run loaded the record
 * with READ access (a viewer spent the workspace's AI budget and rewrote its
 * categorization) and evaluated the workspace AI policy with no role and no
 * plan answer, so an allowedRoles restriction and the plan step never applied.
 *
 * The role and plan steps sit after the platform switch in the policy's
 * order, so the refusal cases run with the platform flag on. The route's
 * provider is built at boot (before the flag), so it stays the no-op provider:
 * nothing is sent anywhere, and every case here is refused before it anyway.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("AI categorization run authority (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let clearRates: () => Promise<unknown>;
  const created: string[] = [];
  const envBefore = { enabled: process.env.OPENAI_AI_ENABLED, key: process.env.OPENAI_API_KEY };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    for (const t of [h.fixtures.teamA, h.fixtures.teamB]) {
      await prisma.team.update({ where: { id: t.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    }
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await prisma?.workspaceAiPolicy
      .deleteMany({ where: { teamId: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } } })
      .catch(() => undefined);
    await prisma?.subscription.deleteMany({ where: { teamId: h.fixtures.teamB.teamId } }).catch(() => undefined);
    await h?.cleanup();
  });

  beforeEach(async () => {
    await clearRates();
  });
  afterEach(() => {
    for (const [k, v] of [["OPENAI_AI_ENABLED", envBefore.enabled], ["OPENAI_API_KEY", envBefore.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function platformAiOn() {
    process.env.OPENAI_AI_ENABLED = "true";
    process.env.OPENAI_API_KEY = "integration-test-placeholder";
  }

  async function record(teamId: string): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true, ownerUserId: true },
    });
    const { id } = await prisma.evidence.create({
      data: {
        title: "Categorization authority fixture",
        type: "PHOTO",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        sizeBytes: 1_000n,
      } as never,
      select: { id: true },
    });
    created.push(id);
    return id;
  }

  const run = (token: string, id: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/ai-categorization/run`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
  const traces = async (id: string) => ({
    categorizations: await prisma.evidenceAiCategorization.count({ where: { evidenceId: id } }),
  });

  it("a viewer (read access only) cannot run it: the same 404 as a missing record, nothing written", async () => {
    const id = await record(h.fixtures.teamA.teamId);
    const viewer = await run(h.fixtures.teamA.viewerToken, id);
    const missing = await run(h.fixtures.teamA.viewerToken, randomUUID());
    expect(viewer.statusCode, viewer.body).toBe(404);
    expect(missing.statusCode).toBe(404);
    // Same refusal (the body carries per-request ids).
    expect(viewer.json().error.code).toBe(missing.json().error.code);
    expect(await traces(id)).toEqual({ categorizations: 0 });
  });

  it("the workspace's AI role allowlist applies: a role on it runs, a member outside it is refused ROLE_NOT_PERMITTED", async () => {
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId: h.fixtures.teamA.teamId },
      create: { teamId: h.fixtures.teamA.teamId, allowedRolesJson: ["OWNER"] },
      update: { allowedRolesJson: ["OWNER"] },
    });
    const id = await record(h.fixtures.teamA.teamId);
    platformAiOn();

    const res = await run(h.fixtures.teamA.adminToken, id);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: "AI_WORKSPACE_POLICY_DENIED", decision: "ROLE_NOT_PERMITTED" });
    expect(await traces(id)).toEqual({ categorizations: 0 });

    // With no role passed, the allowlist refused EVERY role, the allowed one
    // too. The owner is on it, so the run proceeds (to the no-op provider).
    await clearRates();
    const owner = await run(h.fixtures.teamA.ownerToken, id);
    expect(owner.statusCode, owner.body).toBe(200);
  });

  it("the plan step applies: a workspace whose paid lifecycle has lapsed is refused PLAN_NOT_ENTITLED", async () => {
    const B = h.fixtures.teamB;
    await prisma.subscription.create({
      data: {
        userId: B.ownerUserId,
        teamId: B.teamId,
        provider: "STRIPE",
        providerSubId: `sec15-${randomUUID()}`,
        status: "PAST_DUE",
        plan: "TEAM",
        currentPeriodEnd: new Date("2020-01-01T00:00:00.000Z"),
      } as never,
    });
    const id = await record(B.teamId);
    platformAiOn();

    const res = await run(B.ownerToken, id);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: "AI_WORKSPACE_POLICY_DENIED", decision: "PLAN_NOT_ENTITLED" });
    expect(await traces(id)).toEqual({ categorizations: 0 });
  });
});
