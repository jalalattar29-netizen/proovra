/**
 * PRO-AI1Z-04 — Settings > AI status is evaluated for the VIEWER's role and
 * with the plan allowance as an input (live PostgreSQL 16, real routes).
 *
 * At the base SHA the status route evaluated SUPPORT_CHAT with no role, so as
 * soon as a workspace set an allowed-roles list every member — the OWNER on
 * the list included — read NOT_PERMITTED_FOR_ROLE, and a spent allowance was
 * reported AVAILABLE.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PRO-AI1Z-04 AI assistance status (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let billing: typeof import("../src/services/billing-enforcement.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    billing = await import("../src/services/billing-enforcement.service.js");
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  beforeEach(() => {
    // Platform AI on (advisory family); the key is never used — no call is made.
    process.env.OPENAI_AI_ENABLED = "true";
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  });

  async function status(token: string) {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/workspaces/ai-assistance-status?teamId=${h.fixtures.teamA.teamId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { status: string; available: boolean; reason?: string };
  }

  it("an OWNER on the allowed-roles list is AVAILABLE; a VIEWER off it is NOT_PERMITTED_FOR_ROLE", async () => {
    const teamId = h.fixtures.teamA.teamId;
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId },
      create: { teamId, allowedRolesJson: ["OWNER"] } as never,
      update: { allowedRolesJson: ["OWNER"] },
    });
    await prisma.entitlementUsage.deleteMany({ where: { teamId, key: billing.AI_USAGE_KEY } });
    expect((await status(h.fixtures.teamA.ownerToken)).status).toBe("AVAILABLE");
    expect((await status(h.fixtures.teamA.viewerToken)).status).toBe("NOT_PERMITTED_FOR_ROLE");
  });

  it("a spent monthly allowance is not reported AVAILABLE", async () => {
    const teamId = h.fixtures.teamA.teamId;
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId },
      create: { teamId } as never,
      update: { allowedRolesJson: null as never },
    });
    const allowance = await billing.evaluateWorkspaceAiOperation({ teamId });
    expect(typeof allowance.cap).toBe("number");
    await prisma.entitlementUsage.upsert({
      where: {
        teamId_key_periodStartUtc: {
          teamId,
          key: billing.AI_USAGE_KEY,
          periodStartUtc: billing.startOfCurrentMonthUtc(),
        },
      },
      create: {
        teamId,
        key: billing.AI_USAGE_KEY,
        periodStartUtc: billing.startOfCurrentMonthUtc(),
        consumed: BigInt(allowance.cap as number),
      },
      update: { consumed: BigInt(allowance.cap as number) },
    });
    const body = await status(h.fixtures.teamA.ownerToken);
    expect(body.available).toBe(false);
    expect(body.reason).toBe("ALLOWANCE_EXHAUSTED");
  });
});
