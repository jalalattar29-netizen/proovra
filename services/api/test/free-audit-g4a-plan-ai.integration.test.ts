/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies and mocked payloads of many shapes. */
/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G4A-PLAN-AI (live PostgreSQL + Redis).
 *
 * Server-side plan and entitlement enforcement, and AI spend accounting.
 * Every refusal has a positive control on a plan that includes the
 * capability (PRO personal workspace, or an entitlement grant), so a test
 * cannot pass by refusing everything. No live provider is contacted: the
 * provider-run control uses the LOCAL entity-extraction adapter, and the
 * advisory provider is the module-load Noop provider.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, PersonalTenant } from "./point7/product-fixtures.js";

type Res = { statusCode: number; body: string; headers: Record<string, unknown> };
type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("free-audit 0ea0 — API-G4A-PLAN-AI (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fx: typeof import("./point7/product-fixtures.js");
  let deps: FixtureDeps;
  let policySvc: typeof import("../src/services/ai/workspace-ai-policy.service.js");
  let ledger: typeof import("../src/services/ai/ai-usage-ledger.service.js");
  let mi: typeof import("../src/services/intelligence/media-intelligence.service.js");
  let adapters: typeof import("../src/services/intelligence/providers/provider-adapter.js");
  let budget: typeof import("../src/services/intelligence/provider-budget.service.js");
  let batch: typeof import("../src/services/batch-analysis.service.js");
  let billing: typeof import("../src/services/billing-enforcement.service.js");
  let grant: typeof import("../src/services/packaging/entitlement.service.js")["upsertEntitlementGrant"];
  let clearRates: () => Promise<unknown>;
  let ip = 1;

  let free: PersonalTenant;
  let pro: PersonalTenant;

  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH",
    url: string,
    token: string | null,
    payload?: unknown,
    workspaceId?: string,
  ): Promise<Res> =>
    h.app.inject({
      method,
      url,
      remoteAddress: `203.0.113.${(ip++ % 250) + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(workspaceId ? { "x-proovra-workspace-id": workspaceId } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, any>;

  async function evidenceIn(teamId: string, ownerUserId: string, extra: Record<string, unknown> = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: `g4a ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
        ...extra,
      } as never,
      select: { id: true },
    });
  }

  const aiConsumed = async (teamId: string) =>
    Number(
      (
        await prisma.entitlementUsage.findUnique({
          where: {
            teamId_key_periodStartUtc: {
              teamId,
              key: billing.AI_USAGE_KEY,
              periodStartUtc: billing.startOfCurrentMonthUtc(),
            },
          },
          select: { consumed: true },
        })
      )?.consumed ?? 0n,
    );

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    fx = await import("./point7/product-fixtures.js");
    const { signJwt } = await import("../src/services/jwt.js");
    policySvc = await import("../src/services/ai/workspace-ai-policy.service.js");
    ledger = await import("../src/services/ai/ai-usage-ledger.service.js");
    await import("../src/services/intelligence/providers/openai-adapter.js");
    mi = await import("../src/services/intelligence/media-intelligence.service.js");
    adapters = await import("../src/services/intelligence/providers/provider-adapter.js");
    budget = await import("../src/services/intelligence/provider-budget.service.js");
    batch = await import("../src/services/batch-analysis.service.js");
    billing = await import("../src/services/billing-enforcement.service.js");
    ({ upsertEntitlementGrant: grant } = await import("../src/services/packaging/entitlement.service.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    deps = {
      prisma: prisma as never,
      tag: `g4a-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    free = await fx.seedPersonalTenant(deps, "FREE");
    pro = await fx.seedPersonalTenant(deps, "PRO");
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // B6-F-22 / B6-F-46 — per-capability AI plan eligibility.
  // ---------------------------------------------------------------------------
  describe("B6-F-22 / B6-F-46 — paid AI capabilities", () => {
    it("a Free owner cannot switch paid capabilities on through PUT ai-policy; trial switches and a PRO owner can", async () => {
      const refused = await call("PUT", "/v1/teams/ai-policy", free.owner.token, {
        teamId: free.personalTeamId,
        contentIntelligenceEnabled: true,
        ocrAllowed: true,
        reviewerCopilotEnabled: true,
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(json(refused).error.code).toBe("ENTITLEMENT_REQUIRED");
      expect(json(refused).error.details.fields).toEqual(
        expect.arrayContaining(["contentIntelligenceEnabled", "ocrAllowed", "reviewerCopilotEnabled"]),
      );
      expect(await prisma.workspaceAiPolicy.findUnique({ where: { teamId: free.personalTeamId } })).toBeNull();

      const proOk = await call("PUT", "/v1/teams/ai-policy", pro.owner.token, {
        teamId: pro.personalTeamId,
        contentIntelligenceEnabled: true,
        ocrAllowed: true,
        reviewerCopilotEnabled: true,
      });
      expect(proOk.statusCode, proOk.body).toBe(200);
      expect(json(proOk).policy).toMatchObject({ contentIntelligenceEnabled: true, ocrAllowed: true });
    });

    it("the evaluator refuses a paid feature on FREE (PLAN_NOT_ENTITLED), allows it on PRO, and a downgrade stops a saved switch", async () => {
      const t = await fx.seedPersonalTenant(deps, "PRO");
      await prisma.workspaceAiPolicy.create({
        data: { teamId: t.personalTeamId, reviewerCopilotEnabled: true, caseCopilotEnabled: true, semanticSearchEnabled: true },
      });
      const ask = (feature: "REVIEWER_COPILOT" | "CASE_COPILOT") =>
        policySvc.evaluateWorkspaceAiPolicy({ teamId: t.personalTeamId, feature, dataClass: "METADATA", userRole: "OWNER" });
      expect((await ask("REVIEWER_COPILOT")).decision).toBe("ALLOWED");
      expect((await ask("CASE_COPILOT")).decision).toBe("ALLOWED");
      await fx.setAccountPlan(deps, t.owner.userId, "FREE");
      expect((await ask("REVIEWER_COPILOT")).decision).toBe("PLAN_NOT_ENTITLED");
      expect((await ask("CASE_COPILOT")).decision).toBe("PLAN_NOT_ENTITLED");
    });

    it("a vendor provider run on a Free workspace is refused before dispatch, taking no allowance; PRO runs and takes exactly one", async () => {
      const f = await fx.seedPersonalTenant(deps, "FREE");
      await prisma.workspaceAiPolicy.create({
        data: { teamId: f.personalTeamId, contentIntelligenceEnabled: true, rawContentProcessingAllowed: true, ocrAllowed: true },
      });
      const fe = await evidenceIn(f.personalTeamId, f.owner.userId);
      const before = await aiConsumed(f.personalTeamId);
      const res = await mi.runProviderOperation({
        teamId: f.personalTeamId,
        evidenceId: fe.id,
        provider: "LOCAL_ENTITY_EXTRACTION",
        operation: "EXTRACT_ENTITIES",
        initiatedByUserId: f.owner.userId,
        text: "Contact Jane Doe at jane@example.com on 2026-01-02.",
      } as never);
      expect(res).toMatchObject({ ok: false, decision: "BLOCK", reason: "entitlement_required:AI_CAPABILITY_NOT_INCLUDED" });
      expect(await aiConsumed(f.personalTeamId)).toBe(before);

      // Positive control (and B6-F-20 evidence for run/*): PRO is metered once.
      const p = await fx.seedPersonalTenant(deps, "PRO");
      await prisma.workspaceAiPolicy.create({ data: { teamId: p.personalTeamId, contentIntelligenceEnabled: true } });
      const pe = await evidenceIn(p.personalTeamId, p.owner.userId);
      const run = () =>
        mi.runProviderOperation({
          teamId: p.personalTeamId,
          evidenceId: pe.id,
          provider: "LOCAL_ENTITY_EXTRACTION",
          operation: "EXTRACT_ENTITIES",
          initiatedByUserId: p.owner.userId,
          text: "Contact Jane Doe at jane@example.com on 2026-01-02.",
        } as never);
      // PRO-AI1-08 — an in-process (local) adapter is not provider work: the
      // run succeeds and takes no plan AI operation.
      const local = await run();
      expect(local.ok, JSON.stringify(local)).toBe(true);
      expect(await aiConsumed(p.personalTeamId)).toBe(0);
      // The metered half needs a PROVIDER operation: the same adapter without
      // its `local` mark stands in for a vendor (no network is involved).
      const localAdapter = adapters.getAdapter("LOCAL_ENTITY_EXTRACTION" as never)!;
      expect(localAdapter.local).toBe(true);
      const vendorLike = { ...localAdapter, local: false };
      adapters.registerAdapter(vendorLike as never);
      try {
        const ok = await run();
        expect(ok.ok, JSON.stringify(ok)).toBe(true);
        expect(await aiConsumed(p.personalTeamId)).toBe(1);
      } finally {
        adapters.registerAdapter(localAdapter);
      }
    });

    it("provider budgets cannot be created by a Free owner; a PRO owner can", async () => {
      const body = { scope: "WORKSPACE", period: "MONTHLY", softLimitUsdMicros: 1000, hardLimitUsdMicros: 2000 };
      const refused = await call("POST", "/v1/intelligence/providers/budgets", free.owner.token, body, free.personalTeamId);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(json(refused).error.code).toBe("ENTITLEMENT_REQUIRED");
      expect(await prisma.providerBudget.count({ where: { teamId: free.personalTeamId } })).toBe(0);
      const ok = await call("POST", "/v1/intelligence/providers/budgets", pro.owner.token, body, pro.personalTeamId);
      expect(ok.statusCode, ok.body).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // R2-F-002 — first save compare-and-set.
  // ---------------------------------------------------------------------------
  describe("R2-F-002 — expectedVersion null", () => {
    it("two first saves that both read the default: the first wins, the second is 409 with zero mutation", async () => {
      const t = await fx.seedPersonalTenant(deps, "FREE");
      const first = await call("PUT", "/v1/teams/ai-policy", t.owner.token, {
        teamId: t.personalTeamId,
        expectedVersion: null,
        captureAssistanceEnabled: false,
      });
      expect(first.statusCode, first.body).toBe(200);
      const second = await call("PUT", "/v1/teams/ai-policy", t.owner.token, {
        teamId: t.personalTeamId,
        expectedVersion: null,
        captureAssistanceEnabled: true,
        supportChatEnabled: false,
      });
      expect(second.statusCode, second.body).toBe(409);
      expect(json(second).error.code).toBe("POLICY_VERSION_CONFLICT");
      const row = await prisma.workspaceAiPolicy.findUniqueOrThrow({ where: { teamId: t.personalTeamId } });
      expect(row).toMatchObject({ captureAssistanceEnabled: false, supportChatEnabled: true, policyVersion: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // B6-F-26 — a released reservation gives the rollups back.
  // ---------------------------------------------------------------------------
  describe("B6-F-26 — ledger release", () => {
    it("release decrements the day and month rollups once; reconcile keeps them", async () => {
      const t = await fx.seedPersonalTenant(deps, "PRO");
      const store = ledger.buildPrismaLedgerStore();
      const reserve = () =>
        ledger.tryReserveAiBudget({
          teamId: t.personalTeamId,
          userId: t.owner.userId,
          feature: "EVIDENCE_COPILOT",
          model: "test",
          requestId: `g4a:${randomUUID()}`,
          estimatedCostUsdMicros: 250_000n,
        });
      const month = ledger.monthUtcOf(new Date());
      const ops = async () =>
        (await prisma.aiUsageMonthly.findUnique({ where: { workspaceId_monthUtc: { workspaceId: t.personalTeamId, monthUtc: month } } }))
          ?.operations ?? 0;
      const a = await reserve();
      expect(await ops()).toBe(1);
      await ledger.releaseAiReservation(store, a.reservationId!);
      await ledger.releaseAiReservation(store, a.reservationId!);
      expect(await ops()).toBe(0);
      const b = await reserve();
      await ledger.reconcileAiUsage(store, b.reservationId!, null);
      await ledger.releaseAiReservation(store, b.reservationId!);
      expect(await ops()).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // B6-F-44 — budget hard limit is a reservation.
  // ---------------------------------------------------------------------------
  describe("B6-F-44 — atomic budget gate", () => {
    it("eight concurrent runs against a hard limit of two estimates admit at most two", async () => {
      const t = await fx.seedPersonalTenant(deps, "PRO");
      await prisma.providerBudget.create({
        data: {
          teamId: t.personalTeamId,
          scope: "WORKSPACE",
          provider: null,
          period: "MONTHLY",
          softLimitUsdMicros: 150_000n,
          hardLimitUsdMicros: 200_000n,
          createdByUserId: t.owner.userId,
        } as never,
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          budget.reserveBudgetGate({
            teamId: t.personalTeamId,
            provider: "LOCAL_ENTITY_EXTRACTION",
            operation: "EXTRACT_ENTITIES",
            estimatedCostUsdMicros: 100_000,
          } as never),
        ),
      );
      const admitted = results.filter((r) => r.decision !== "BLOCK");
      // Serialised per workspace: exactly the two estimates the limit holds.
      expect(admitted.length).toBe(2);
      for (const r of admitted) await budget.releaseBudgetReservation(r.reservationId);
      expect(
        await prisma.providerUsageEvent.count({ where: { teamId: t.personalTeamId, failureReason: budget.BUDGET_RESERVATION_MARKER } }),
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // B6-F-40 / B6-F-41 / B6-F-49 / B6-F-50 — batch analysis.
  // ---------------------------------------------------------------------------
  describe("batch analysis is bound to the proven workspace", () => {
    let foreignTeamId: string;
    let foreignEvidenceId: string;
    beforeAll(async () => {
      // The PRO user is also a MEMBER of the FREE team B, holding a record there.
      foreignTeamId = h.fixtures.teamB.teamId;
      await prisma.teamMember.create({
        data: { teamId: foreignTeamId, userId: pro.owner.userId, role: "MEMBER", status: "ACTIVE" },
      });
      foreignEvidenceId = (await evidenceIn(foreignTeamId, pro.owner.userId)).id;
    });

    it("B6-F-40 — create refuses records from another workspace; same-workspace records are accepted", async () => {
      const refused = await call(
        "POST",
        "/v1/batch-analysis",
        pro.owner.token,
        { evidenceIds: [foreignEvidenceId], name: "cross" },
        pro.personalTeamId,
      );
      expect(refused.statusCode, refused.body).toBe(400);
      expect(await prisma.batchAnalysisJob.count({ where: { ownerUserId: pro.owner.userId, teamId: foreignTeamId } })).toBe(0);
      const own = await evidenceIn(pro.personalTeamId, pro.owner.userId);
      const ok = await call("POST", "/v1/batch-analysis", pro.owner.token, { evidenceIds: [own.id], name: "own" }, pro.personalTeamId);
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("B6-F-40 — a VIEWER of a professional workspace cannot start a batch (A2-14)", async () => {
      const viewer = await fx.seedUser(deps, "g4a-viewer");
      await prisma.teamMember.create({
        data: { teamId: pro.personalTeamId, userId: viewer.userId, role: "VIEWER", status: "ACTIVE" },
      });
      const own = await evidenceIn(pro.personalTeamId, viewer.userId);
      const res = await call("POST", "/v1/batch-analysis", viewer.token, { evidenceIds: [own.id], name: "v" }, pro.personalTeamId);
      expect(res.statusCode, res.body).toBe(403);
    });

    it("B6-F-40 — a job in another workspace is not served under this workspace's entitlement", async () => {
      const foreignJob = await batch.createJob({
        ownerUserId: pro.owner.userId,
        teamId: foreignTeamId,
        evidenceIds: [foreignEvidenceId],
        name: "foreign",
      });
      const get = await call("GET", `/v1/batch-analysis/${foreignJob.id}`, pro.owner.token, undefined, pro.personalTeamId);
      expect(get.statusCode, get.body).toBe(404);
      const list = await call("GET", "/v1/batch-analysis", pro.owner.token, undefined, pro.personalTeamId);
      expect(list.statusCode).toBe(200);
      expect((json(list).data as Array<{ id: string }>).map((j) => j.id)).not.toContain(foreignJob.id);
    });

    it("B6-F-41 — a processed job exports the per-record metadata it produced", async () => {
      const own = await evidenceIn(pro.personalTeamId, pro.owner.userId, { mimeType: "image/jpeg" });
      const created = await call("POST", "/v1/batch-analysis", pro.owner.token, { evidenceIds: [own.id], name: "export" }, pro.personalTeamId);
      const id = json(created).data.id as string;
      const started = await call("POST", `/v1/batch-analysis/${id}/process`, pro.owner.token, undefined, pro.personalTeamId);
      expect(started.statusCode, started.body).toBe(200);
      for (let i = 0; i < 50; i += 1) {
        const row = await prisma.batchAnalysisJob.findUniqueOrThrow({ where: { id }, select: { status: true } });
        if (row.status === "COMPLETED") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const csv = await call("GET", `/v1/batch-analysis/${id}/export`, pro.owner.token, undefined, pro.personalTeamId);
      expect(csv.statusCode, csv.body).toBe(200);
      expect(csv.body).toContain('"PHOTO"');
      expect(csv.body).toContain('"image/jpeg"');
      expect(csv.body).not.toContain("N/A");
    });

    it("B6-F-41 — cancelling leaves counters equal to the item states", async () => {
      const a = await evidenceIn(pro.personalTeamId, pro.owner.userId);
      const b = await evidenceIn(pro.personalTeamId, pro.owner.userId);
      const job = await batch.createJob({ ownerUserId: pro.owner.userId, teamId: pro.personalTeamId, evidenceIds: [a.id, b.id], name: "c" });
      await prisma.batchAnalysisJobItem.updateMany({ where: { jobId: job.id, evidenceId: a.id }, data: { status: "COMPLETED" } });
      await prisma.batchAnalysisJob.update({ where: { id: job.id }, data: { status: "PROCESSING" } });
      expect(await batch.cancelJob(pro.owner.userId, job.id)).toBe("CANCELLED");
      const row = await prisma.batchAnalysisJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(row).toMatchObject({ status: "CANCELLED", processedItems: 1, failedItems: 1 });
    });

    it("B6-F-50 — the owner cancels their own job after a downgrade (no plan gate on cancel)", async () => {
      const t = await fx.seedPersonalTenant(deps, "PRO");
      const e = await evidenceIn(t.personalTeamId, t.owner.userId);
      const job = await batch.createJob({ ownerUserId: t.owner.userId, teamId: t.personalTeamId, evidenceIds: [e.id], name: "d" });
      await fx.setAccountPlan(deps, t.owner.userId, "FREE");
      const res = await call("POST", `/v1/batch-analysis/${job.id}/cancel`, t.owner.token, undefined, t.personalTeamId);
      expect(res.statusCode, res.body).toBe(200);
      expect((await prisma.batchAnalysisJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
    });

    it("B6-F-49 — usage-stats are this workspace's, with the cost basis labelled", async () => {
      const res = await call("GET", "/v1/usage-stats", pro.owner.token, undefined, pro.personalTeamId);
      expect(res.statusCode, res.body).toBe(200);
      const data = json(res).data;
      expect(data.workspaceId).toBe(pro.personalTeamId);
      expect(data.costBasis).toBe("ILLUSTRATIVE_LIST_RATE_ESTIMATE");
      expect(data.costIsCharged).toBe(false);
      const ownCount = await prisma.evidence.count({ where: { teamId: pro.personalTeamId, deletedAt: null } });
      expect(data.topEvidenceTypes.photo).toBe(ownCount);
    });
  });

  // ---------------------------------------------------------------------------
  // B5B-F-300 / B5B-F-301 — lifecycle writers.
  // ---------------------------------------------------------------------------
  describe("lifecycle writers ask the plan", () => {
    it("B5B-F-300 — archive transition: Free 403 ENTITLEMENT_REQUIRED with no row; entitled reaches the bounded denial", async () => {
      const e = await evidenceIn(free.personalTeamId, free.owner.userId);
      const res = await call("POST", "/v1/lifecycle/archive/transition", free.owner.token, { evidenceId: e.id, toTier: "DEEP_ARCHIVE" }, free.personalTeamId);
      expect(res.statusCode, res.body).toBe(403);
      expect(json(res)).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_ARCHIVE_TIERS" });
      expect(await prisma.archiveTierTransition.count({ where: { evidenceId: e.id } })).toBe(0);

      const t = await fx.seedPersonalTenant(deps, "PRO");
      await grant({ teamId: t.personalTeamId, key: "FEATURE_ARCHIVE_TIERS", value: true, kind: "FEATURE", source: "CUSTOM", grantedByUserId: t.owner.userId });
      const te = await evidenceIn(t.personalTeamId, t.owner.userId);
      const passed = await call("POST", "/v1/lifecycle/archive/transition", t.owner.token, { evidenceId: te.id, toTier: "DEEP_ARCHIVE" }, t.personalTeamId);
      expect(passed.statusCode, passed.body).toBe(409);
      expect(json(passed).denial).toBe("evidence_has_no_storage_key");
    });

    it("B5B-F-301 — a Free account cannot create a binding retention policy", async () => {
      const res = await call(
        "POST",
        "/v1/lifecycle/retention/policies",
        free.owner.token,
        { name: "one year", template: "CUSTOM", years: 1, scopeKind: "WORKSPACE" },
        free.personalTeamId,
      );
      expect(res.statusCode, res.body).toBe(402);
      expect(json(res).error.code).toBe("ENTERPRISE_FEATURE_REQUIRED");
      expect(await prisma.evidenceRetentionPolicy.count({ where: { teamId: free.personalTeamId } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Low rows on plan gates.
  // ---------------------------------------------------------------------------
  describe("plan gates on the remaining surfaces", () => {
    it("B3B-F-501 — reviewer criteria authoring: Free refused with nothing written; PRO creates", async () => {
      const body = (teamId: string) => ({ teamId, name: "c", title: "c", criteria: [{ key: "k", title: "t" }] });
      const refused = await call("POST", "/v1/reviewer-criteria", free.owner.token, body(free.personalTeamId));
      expect(refused.statusCode, refused.body).toBe(403);
      expect(json(refused).error.code).toBe("ENTITLEMENT_REQUIRED");
      expect(json(refused).error.reason).toBe("reviewer_operations_not_included");
      expect(await prisma.reviewerCriteriaSet.count({ where: { workspaceId: free.personalTeamId } })).toBe(0);
      const ok = await call("POST", "/v1/reviewer-criteria", pro.owner.token, body(pro.personalTeamId));
      expect(ok.statusCode, ok.body).toBe(201);
    });

    it("B5A-F-10 — media-intelligence/run: Free refused before any run row; a foreign record is 404 before enqueue", async () => {
      const e = await evidenceIn(free.personalTeamId, free.owner.userId);
      const refused = await call("POST", `/v1/evidence/${e.id}/media-intelligence/run`, free.owner.token, { teamId: free.personalTeamId, async: true });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(await prisma.mediaIntelligenceRun.count({ where: { evidenceId: e.id } })).toBe(0);
      const foreign = await call("POST", `/v1/evidence/${e.id}/media-intelligence/run`, pro.owner.token, { teamId: pro.personalTeamId, async: true });
      expect(foreign.statusCode, foreign.body).toBe(404);
      expect(await prisma.mediaIntelligenceRun.count({ where: { evidenceId: e.id } })).toBe(0);
    });

    it("B7A-F-004 — reliability API: Free personal owner 403 operations_not_included", async () => {
      const res = await call("GET", `/v1/reliability/summary?teamId=${free.personalTeamId}`, free.owner.token);
      expect(res.statusCode, res.body).toBe(403);
      expect(json(res).error.reason).toBe("operations_not_included");
    });

    it("B7B-F06 — governance policy authoring: Free 403 ENTITLEMENT_REQUIRED before any write", async () => {
      const res = await call(
        "POST",
        "/v1/governance/policies",
        free.owner.token,
        { kind: "SECURITY", slug: "g4a", name: "n", summary: "s", enforcementMode: "WARN", rule: {} },
        free.personalTeamId,
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(json(res)).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_GOVERNANCE_PLATFORM" });
      expect(await prisma.governancePolicy.count({ where: { teamId: free.personalTeamId } })).toBe(0);
    });

    it("B5B-F-204 — redaction provider health is not projected to a workspace without FEATURE_REDACTION", async () => {
      const res = await call("GET", "/v1/redaction/providers/health", free.owner.token, undefined, free.personalTeamId);
      expect(res.statusCode, res.body).toBe(403);
      expect(json(res)).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_REDACTION" });
    });

    it("B5A-F-11 — a trashed record cannot be locked; an active one can", async () => {
      const trashed = await evidenceIn(free.personalTeamId, free.owner.userId, { deletedAt: new Date(), lifecycleState: "TRASHED" });
      const refused = await call("POST", `/v1/evidence/${trashed.id}/lock`, free.owner.token, { locked: true });
      expect(refused.statusCode, refused.body).toBe(409);
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id: trashed.id }, select: { lockedAt: true } })).lockedAt).toBeNull();
      const active = await evidenceIn(free.personalTeamId, free.owner.userId);
      const ok = await call("POST", `/v1/evidence/${active.id}/lock`, free.owner.token, { locked: true });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("B6-F-23 — a record never categorized answers categorization null (Run is offered)", async () => {
      const e = await evidenceIn(free.personalTeamId, free.owner.userId);
      const res = await call("GET", `/v1/evidence/${e.id}/ai-categorization`, free.owner.token);
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).categorization).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // B6-F-24 / B6-F-25 / B6-F-28 — the assistant's policy inputs and free path.
  // ---------------------------------------------------------------------------
  describe("assistant policy inputs", () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      // Makes the evaluator reach its workspace steps. The advisory provider
      // was built at module load (Noop), so nothing is sent anywhere.
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

    it("B6-F-24 — allowedRoles [OWNER, ADMIN] admits the owner (the role reaches the evaluator)", async () => {
      const t = await fx.seedPersonalTenant(deps, "FREE");
      await prisma.workspaceAiPolicy.create({ data: { teamId: t.personalTeamId, allowedRolesJson: ["OWNER", "ADMIN"] } });
      const res = await call("GET", "/v1/ai/availability", t.owner.token, undefined, t.personalTeamId);
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).data.decision).toBe("ALLOWED");
    });

    it("B6-F-25 — an unprovable workspace falls back to the PERSONAL policy, honouring its opt-out", async () => {
      const t = await fx.seedPersonalTenant(deps, "FREE");
      await prisma.workspaceAiPolicy.create({ data: { teamId: t.personalTeamId, aiEnabled: false } });
      const res = await call("GET", "/v1/ai/availability", t.owner.token, undefined, h.fixtures.teamB.teamId);
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).data.decision).toBe("WORKSPACE_DISABLED");
    });

    it("B6-F-28 — at 10/10 a product question is still answered from built-in documentation", async () => {
      await clearRates();
      const t = await fx.seedPersonalTenant(deps, "FREE");
      await prisma.entitlementUsage.create({
        data: { teamId: t.personalTeamId, key: billing.AI_USAGE_KEY, periodStartUtc: billing.startOfCurrentMonthUtc(), consumed: 10n },
      });
      const res = await call("POST", "/v1/ai/chat", t.owner.token, { messages: [{ role: "user", content: "How do I capture evidence?" }] }, t.personalTeamId);
      expect(res.statusCode, res.body).toBe(200);
      expect(await aiConsumed(t.personalTeamId)).toBe(10);
    });
  });
});
