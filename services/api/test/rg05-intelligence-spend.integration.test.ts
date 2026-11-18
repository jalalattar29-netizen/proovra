/**
 * RG-05 — content-intelligence spend and its outputs (live PostgreSQL 16).
 *
 *   PRO-AI1-04   one paid extraction per evidence part: a retried or concurrent
 *                execution finds the part claimed or done and spends nothing.
 *   PRO-AI1Z-01  returned OCR/transcript text is written by the canonical
 *                writer as COMPLETED under the vendor's name (not SKIPPED noop).
 *   PRO-AI1-08   a local, no-provider operation takes no plan AI operation and
 *                records zero cost.
 *   PRO-AI1-09   each entity is stored once, against its own record.
 *   PRO-AI1-10   CASE budgets apply through the evidence's case links, and a
 *                budget cannot name another workspace's case.
 *   PRO-AI1-11   the bulk refresh asks the plan and is rate limited.
 *   PRO-AI1C-05  a legacy NULL-team Personal record's signals can be read.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

describe("RG-05 intelligence spend (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let billing: typeof import("../src/services/billing-enforcement.service.js");
  let mi: typeof import("../src/services/intelligence/media-intelligence.service.js");
  let extraction: typeof import("../src/services/intelligence/extraction.service.js");
  let budgets: typeof import("../src/services/intelligence/provider-budget.service.js");
  let signJwt: (typeof import("../src/services/jwt.js"))["signJwt"];
  let deps: FixtureDeps;
  let pro: SeededUser;
  let free: SeededUser;
  let proTeam: string;
  let proOrg: string;
  let freeTeam: string;

  function mint(userId: string, email: string): string {
    return signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET!,
      3600,
    );
  }

  async function evidenceIn(teamId: string | null, orgId: string | null, ownerUserId: string): Promise<string> {
    const id = randomUUID();
    await prisma.evidence.create({
      data: {
        id,
        teamId,
        ...(orgId ? { organization: { connect: { id: orgId } } } : {}),
        type: "DOCUMENT",
        ownerUserId,
        uploadedByUserId: ownerUserId,
        status: "SIGNED",
        title: `rg05 ${id.slice(0, 6)}`,
      } as never,
    });
    return id;
  }

  async function consumed(teamId: string): Promise<number> {
    const row = await prisma.entitlementUsage.findUnique({
      where: {
        teamId_key_periodStartUtc: {
          teamId,
          key: billing.AI_USAGE_KEY,
          periodStartUtc: billing.startOfCurrentMonthUtc(),
        },
      },
      select: { consumed: true },
    });
    return Number(row?.consumed ?? 0n);
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    billing = await import("../src/services/billing-enforcement.service.js");
    mi = await import("../src/services/intelligence/media-intelligence.service.js");
    await import("../src/services/intelligence/providers/openai-adapter.js");
    extraction = await import("../src/services/intelligence/extraction.service.js");
    budgets = await import("../src/services/intelligence/provider-budget.service.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    deps = { prisma: prisma as never, mintToken: mint, tag: `rg05i-${randomUUID().slice(0, 8)}` };
    pro = await seedUser(deps, "rg05-pro");
    await setAccountPlan(deps, pro.userId, "PRO");
    ({ teamId: proTeam, organizationId: proOrg } = await bootstrapPersonalSpace(deps, pro.userId));
    free = await seedUser(deps, "rg05-free");
    ({ teamId: freeTeam } = await bootstrapPersonalSpace(deps, free.userId));
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId: proTeam },
      create: { teamId: proTeam, aiEnabled: true, contentIntelligenceEnabled: true } as never,
      update: { aiEnabled: true, contentIntelligenceEnabled: true },
    });
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 120_000);

  it("PRO-AI1-08 / PRO-AI1-09: a local entity run spends nothing and stores each entity once", async () => {
    const evidenceId = await evidenceIn(proTeam, proOrg, pro.userId);
    const before = await consumed(proTeam);
    const text = "Contact alice@example.com, bob@example.org or carol@example.net about the claim.";
    const first = await mi.runProviderOperation({
      teamId: proTeam,
      evidenceId,
      provider: "LOCAL_ENTITY_EXTRACTION",
      operation: "EXTRACT_ENTITIES",
      text,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(await consumed(proTeam)).toBe(before);
    const usage = await prisma.providerUsageEvent.findMany({
      where: { teamId: proTeam, evidenceId, decision: { not: "BLOCK" }, failureReason: null },
      select: { estimatedCostUsdMicros: true },
    });
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) expect(u.estimatedCostUsdMicros).toBe(0n);

    const records = await prisma.mediaIntelligenceRecord.count({ where: { teamId: proTeam, evidenceId } });
    const entitiesAfterFirst = await prisma.mediaIntelligenceEntity.count({ where: { teamId: proTeam, evidenceId } });
    expect(records).toBeGreaterThan(1);
    expect(entitiesAfterFirst).toBe(records);
    await mi.runProviderOperation({
      teamId: proTeam,
      evidenceId,
      provider: "LOCAL_ENTITY_EXTRACTION",
      operation: "EXTRACT_ENTITIES",
      text,
    });
    expect(await prisma.mediaIntelligenceEntity.count({ where: { teamId: proTeam, evidenceId } })).toBe(records);
  });

  it("PRO-AI1-04 / PRO-AI1Z-01: a part is extracted once; the vendor text is COMPLETED under its name", async () => {
    const evidenceId = await evidenceIn(proTeam, proOrg, pro.userId);
    const part = randomUUID();
    const claimInput = {
      evidenceId,
      teamId: proTeam,
      kind: "TRANSCRIPT_AUDIO" as const,
      provider: "deepgram",
      sourcePartId: part,
    };
    const [a, b] = await Promise.all([
      extraction.claimExtractionPart(claimInput, prisma),
      extraction.claimExtractionPart(claimInput, prisma),
    ]);
    const states = [a.state, b.state].sort();
    expect(states).toEqual(["BUSY", "CLAIMED"]);
    const claim = (a.state === "CLAIMED" ? a : b) as { state: "CLAIMED"; claimId: string };
    await extraction.runExtractionInline(
      {
        evidenceId,
        teamId: proTeam,
        mimeType: "audio/mpeg",
        kind: "TRANSCRIPT_AUDIO",
        jobKind: "TRANSCRIPT",
        supplied: { text: "The caller reported the crane failure at noon.", provider: "deepgram" },
        sourcePartId: part,
        claimRowId: claim.claimId,
      },
      prisma,
    );
    const rows = await prisma.evidenceExtractedText.findMany({ where: { evidenceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "COMPLETED", provider: "deepgram", sourcePartId: part });
    expect(rows[0]!.text).toContain("crane failure");
    // The retry: nothing to claim, nothing to spend.
    await expect(extraction.claimExtractionPart(claimInput, prisma)).resolves.toMatchObject({ state: "DONE" });
  });

  it("PRO-AI1-10: a CASE budget applies to its linked evidence without a caller case id, and cannot name a foreign case", async () => {
    const evidenceId = await evidenceIn(proTeam, proOrg, pro.userId);
    const caseRow = await prisma.case.create({
      data: { name: "rg05 case", teamId: proTeam, ownerUserId: pro.userId } as never,
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({ data: { caseId: caseRow.id, evidenceId, teamId: proTeam } });
    const created = await budgets.createBudget({
      prisma,
      teamId: proTeam,
      scope: "CASE",
      scopeTargetId: caseRow.id,
      provider: null,
      period: "MONTHLY",
      softLimitUsdMicros: 1_000,
      hardLimitUsdMicros: 1_500,
      createdByUserId: pro.userId,
    });
    expect(created.ok).toBe(true);
    // Earlier automatic spend on the linked evidence, recorded with no case id.
    await prisma.providerUsageEvent.create({
      data: {
        teamId: proTeam,
        provider: "DEEPGRAM_TRANSCRIPT",
        operation: "TRANSCRIBE_AUDIO",
        unit: "CALL",
        units: 1,
        estimatedCostUsdMicros: 1_000n,
        decision: "ALLOW",
        evidenceId,
      },
    });
    const gate = await budgets.decideBudgetGate(
      {
        teamId: proTeam,
        provider: "DEEPGRAM_TRANSCRIPT",
        estimatedCostUsdMicros: 1_000,
        caseIds: [caseRow.id],
      } as never,
      prisma,
    );
    expect(gate.decision).toBe("BLOCK");

    const foreignCase = await prisma.case.create({
      data: { name: "rg05 foreign", teamId: freeTeam, ownerUserId: free.userId } as never,
      select: { id: true },
    });
    const refused = await budgets.createBudget({
      prisma,
      teamId: proTeam,
      scope: "CASE",
      scopeTargetId: foreignCase.id,
      provider: null,
      period: "MONTHLY",
      softLimitUsdMicros: 1_000,
      hardLimitUsdMicros: 1_500,
      createdByUserId: pro.userId,
    });
    expect(refused).toEqual({ ok: false, denial: "POLICY_REJECTED" });
  });

  it("PRO-AI1-11: the bulk refresh refuses a plan without content intelligence", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/investigation/media-intelligence/refresh",
      headers: { authorization: `Bearer ${free.token}`, "content-type": "application/json" },
      payload: { teamId: freeTeam },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "ENTITLEMENT_REQUIRED" } });
  });

  it("PRO-AI1-11: the bulk refresh is rate limited per workspace", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/investigation/media-intelligence/refresh",
        headers: { authorization: `Bearer ${pro.token}`, "content-type": "application/json" },
        payload: { teamId: proTeam },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 3).every((c) => c !== 429 && c !== 403)).toBe(true);
    expect(codes[3]).toBe(429);
  });

  it("PRO-AI1C-05: a legacy NULL-team Personal record's media intelligence is readable in its owner's personal workspace", async () => {
    const legacyId = await evidenceIn(null, null, pro.userId);
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${legacyId}/media-intelligence?teamId=${proTeam}`,
      headers: { authorization: `Bearer ${pro.token}` },
    });
    expect(res.statusCode).toBe(200);
    const other = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${legacyId}/media-intelligence?teamId=${freeTeam}`,
      headers: { authorization: `Bearer ${free.token}` },
    });
    expect(other.statusCode).toBe(404);
  });
});
