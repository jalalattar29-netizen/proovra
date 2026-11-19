/**
 * RG-02 (WS-BILL, 2026-11-18) — every paid consumer reads the ONE commercial
 * lifecycle verdict (DEC-10), on live PostgreSQL with the real routes:
 *
 *   PRO-P3CZ-01  assistant chat refuses a lapsed paid plan before the provider
 *                (402 COMMERCIAL_LIFECYCLE_RESTRICTED, nothing consumed);
 *   PRO-R1-12    External Review issuance/renewal is not included past grace;
 *   PRO-PSZ-03   the Operations workbench keeps reads but loses writes past
 *                grace, in the capability resolver AND the envelope;
 *   PRO-N1-13    the envelope projects the person's own billing signal.
 *
 * Inside grace nothing changes (positive controls).
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";

type Res = { statusCode: number; body: string };
type Envelope = {
  account: { billingSignal?: { state?: string; graceEndsAtUtc?: string | null } | null };
  capabilities: Record<string, boolean>;
};
const DAY = 86_400_000;

describe("RG-02 — paid consumers follow the lifecycle verdict (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let enforcement: typeof import("../src/services/billing-enforcement.service.js");
  let capability: typeof import("../src/services/platform-context/workspace-capability.service.js");
  let ip = 1;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    enforcement = await import("../src/services/billing-enforcement.service.js");
    capability = await import("../src/services/platform-context/workspace-capability.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `blc-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown, workspaceId?: string): Promise<Res> =>
    h.app.inject({
      method,
      url,
      remoteAddress: `198.18.0.${(ip++ % 250) + 1}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(workspaceId ? { "x-proovra-workspace-id": workspaceId } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;

  /** A personal Pro whose subscription is PAST_DUE, its period having ended `daysAgo` days ago. */
  async function pastDuePro(daysAgo: number) {
    const t = await seedPersonalTenant(deps, "PRO");
    await prisma.subscription.create({
      data: {
        userId: t.owner.userId,
        provider: "STRIPE",
        providerSubId: `sub_${randomUUID().slice(0, 12)}`,
        status: "PAST_DUE",
        plan: "PRO",
        currentPeriodEnd: new Date(Date.now() - daysAgo * DAY),
        activatedAtUtc: new Date(Date.now() - 60 * DAY),
      },
    });
    return t;
  }

  describe("PRO-R1-12 / PRO-PSZ-03 / PRO-N1-13", () => {
    it("past grace: no External Review, Operations read-only, envelope says PAST_DUE_EXPIRED", async () => {
      const t = await pastDuePro(10);
      expect(await enforcement.workspaceIncludesExternalReview(t.personalTeamId)).toBe(false);

      const caps = await capability.resolveMemberWorkspaceCapabilities({ userId: t.owner.userId, teamId: t.personalTeamId });
      expect(caps?.capabilities.OPERATIONS_VIEW).toBe(true);
      expect(caps?.capabilities.OPERATIONS_RESOLVE).toBe(false);
      expect(caps?.capabilities.OPERATIONS_ACKNOWLEDGE).toBe(false);
      expect(caps?.capabilities.OPERATIONS_SUPPRESS).toBe(false);

      const env = await call("GET", "/v1/platform/context", t.owner.token, undefined, t.personalTeamId);
      expect(env.statusCode, env.body).toBe(200);
      const body = JSON.parse(env.body) as Envelope;
      expect(body.account.billingSignal).toMatchObject({ state: "PAST_DUE_EXPIRED" });
      expect(body.capabilities.OPERATIONS_RESOLVE).toBe(false);
      expect(body.capabilities.OPERATIONS_VIEW).toBe(true);
    });

    it("inside grace (positive control): External Review and Operations writes stay; the envelope says PAST_DUE with the grace end", async () => {
      const t = await pastDuePro(2);
      expect(await enforcement.workspaceIncludesExternalReview(t.personalTeamId)).toBe(true);
      const caps = await capability.resolveMemberWorkspaceCapabilities({ userId: t.owner.userId, teamId: t.personalTeamId });
      expect(caps?.capabilities.OPERATIONS_RESOLVE).toBe(true);

      const env = await call("GET", "/v1/platform/context", t.owner.token, undefined, t.personalTeamId);
      const body = JSON.parse(env.body) as Envelope;
      expect(body.account.billingSignal).toMatchObject({ state: "PAST_DUE" });
      expect(typeof body.account.billingSignal?.graceEndsAtUtc).toBe("string");
    });

    it("an ACTIVE renewing plan and FREE carry no billing signal", async () => {
      const free = await seedPersonalTenant(deps, "FREE");
      const env = await call("GET", "/v1/platform/context", free.owner.token, undefined, free.personalTeamId);
      expect((JSON.parse(env.body) as Envelope).account.billingSignal ?? null).toBeNull();
    });
  });

  describe("PRO-P3CZ-01 — assistant chat", () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      // Lets the evaluator reach the plan/lifecycle steps; the advisory provider
      // is the module-load Noop, so nothing is sent anywhere.
      for (const k of ["OPENAI_AI_ENABLED", "OPENAI_API_KEY"]) saved[k] = process.env[k];
      process.env.OPENAI_AI_ENABLED = "true";
      process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const consumed = async (teamId: string) =>
      Number(
        (await prisma.entitlementUsage.findFirst({ where: { teamId }, select: { consumed: true } }))?.consumed ?? 0n,
      );

    it("past grace: a provider-bound question is refused 402 COMMERCIAL_LIFECYCLE_RESTRICTED and consumes nothing", async () => {
      const t = await pastDuePro(10);
      const res = await call(
        "POST",
        "/v1/ai/chat",
        t.owner.token,
        { messages: [{ role: "user", content: "Suggest tags for the evidence metadata of my warehouse inspection photos." }] },
        t.personalTeamId,
      );
      expect(res.statusCode, res.body).toBe(402);
      expect(res.body).toContain("COMMERCIAL_LIFECYCLE_RESTRICTED");
      expect(await consumed(t.personalTeamId)).toBe(0);
    });
  });
});
