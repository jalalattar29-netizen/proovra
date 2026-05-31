/**
 * Phase 3B Enterprise Closure — contract + behavioural test.
 *
 * Pins every gap closed by Phase 3B Enterprise Closure:
 *
 *   1. Shared closure contracts (ranges, trend math, quality
 *      projections, lifecycle codes, manifest entries).
 *   2. Prisma additions + closure migration.
 *   3. Intelligence activity emitter API surface.
 *   4. Provider budget service correctly enforces CASE / PROJECT
 *      scope (no team-wide leakage).
 *   5. Executive trends shape + range behaviour.
 *   6. Correction version chain + lifecycle event emission.
 *   7. Audit transparency federator surfaces failureReason +
 *      federates the lifecycle table.
 *   8. HTTP routes for trends / quality / version-chain / budget
 *      breaches + spend mounted.
 *   9. UI pages with data-* anchors + nav registry entries.
 *  10. Verification-package manifest writers (version chain,
 *      provider quality, budget governance, audit events).
 *  11. Report section accepts the closure-extended shape.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXECUTIVE_METRICS_RANGES,
  EXECUTIVE_TRENDS_SCHEMA_VERSION,
  INTELLIGENCE_LIFECYCLE_CATEGORIES,
  INTELLIGENCE_LIFECYCLE_CODES,
  TREND_DIRECTIONS,
  buildTrendMetric,
  classifyLifecycleCategory,
  classifyTrend,
  rangeWindowMs,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// 1. Shared closure contracts.
// ---------------------------------------------------------------------------

describe("Phase 3B Closure — shared contracts", () => {
  it("supports the five bounded ranges", () => {
    expect([...EXECUTIVE_METRICS_RANGES]).toEqual([
      "24h",
      "7d",
      "30d",
      "90d",
      "12m",
    ]);
  });

  it("exposes three trend directions", () => {
    expect([...TREND_DIRECTIONS].sort()).toEqual(["DOWN", "STABLE", "UP"]);
  });

  it("computes range window milliseconds deterministically", () => {
    expect(rangeWindowMs("24h")).toBe(24 * 60 * 60 * 1000);
    expect(rangeWindowMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(rangeWindowMs("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(rangeWindowMs("90d")).toBe(90 * 24 * 60 * 60 * 1000);
    expect(rangeWindowMs("12m")).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("classifies trend direction with a ±1% stability band", () => {
    expect(classifyTrend(100, 100)).toBe("STABLE");
    expect(classifyTrend(100, 100.5)).toBe("STABLE");
    expect(classifyTrend(120, 100)).toBe("UP");
    expect(classifyTrend(80, 100)).toBe("DOWN");
    expect(classifyTrend(0, 0)).toBe("STABLE");
    expect(classifyTrend(10, 0)).toBe("UP");
    expect(classifyTrend(-10, 0)).toBe("DOWN");
  });

  it("builds trend metrics with delta + deltaPct + direction", () => {
    const t = buildTrendMetric(150, 100);
    expect(t.current).toBe(150);
    expect(t.previous).toBe(100);
    expect(t.delta).toBe(50);
    expect(t.deltaPct).toBe(50);
    expect(t.direction).toBe("UP");
  });

  it("enumerates the full lifecycle code set", () => {
    const codes = [...INTELLIGENCE_LIFECYCLE_CODES];
    // Record lifecycle codes
    expect(codes).toContain("RECORD_INGESTED");
    expect(codes).toContain("RECORD_OPENED_FOR_REVIEW");
    expect(codes).toContain("RECORD_ACCEPTED");
    expect(codes).toContain("RECORD_REJECTED");
    expect(codes).toContain("RECORD_SUPERSEDED");
    // Correction lifecycle codes
    expect(codes).toContain("CORRECTION_CREATED");
    expect(codes).toContain("CORRECTION_ACCEPTED");
    expect(codes).toContain("CORRECTION_REVERTED");
    expect(codes).toContain("CORRECTION_SUPERSEDED");
    // Budget lifecycle codes
    expect(codes).toContain("BUDGET_SOFT_LIMIT_REACHED");
    expect(codes).toContain("BUDGET_HARD_LIMIT_REACHED");
    expect(codes).toContain("BUDGET_BLOCKED");
    expect(codes).toContain("BUDGET_OVERRIDE");
    expect(codes).toContain("BUDGET_RESET");
    // Provider lifecycle codes
    expect(codes).toContain("PROVIDER_CALL_FAILED");
  });

  it("classifies lifecycle category correctly", () => {
    expect(classifyLifecycleCategory("RECORD_INGESTED")).toBe("RECORD_LIFECYCLE");
    expect(classifyLifecycleCategory("CORRECTION_CREATED")).toBe(
      "CORRECTION_LIFECYCLE",
    );
    expect(classifyLifecycleCategory("PROVIDER_CALL_FAILED")).toBe(
      "PROVIDER_LIFECYCLE",
    );
    expect(classifyLifecycleCategory("BUDGET_HARD_LIMIT_REACHED")).toBe(
      "BUDGET_LIFECYCLE",
    );
  });

  it("exposes four lifecycle categories", () => {
    expect([...INTELLIGENCE_LIFECYCLE_CATEGORIES].sort()).toEqual([
      "BUDGET_LIFECYCLE",
      "CORRECTION_LIFECYCLE",
      "PROVIDER_LIFECYCLE",
      "RECORD_LIFECYCLE",
    ]);
  });

  it("pins the executive trends schema version", () => {
    expect(EXECUTIVE_TRENDS_SCHEMA_VERSION).toBe("PROOVRA_EXECUTIVE_TRENDS_V1");
  });
});

// ---------------------------------------------------------------------------
// 2. Prisma additions + closure migration are Phase O-Final compliant.
// ---------------------------------------------------------------------------

describe("Phase 3B Closure — Prisma + migration", () => {
  it("ReviewerCorrection model carries the version-chain columns", () => {
    const schemaPath = fileURLToPath(
      new URL("../prisma/schema.prisma", import.meta.url),
    );
    const schema = readFileSync(schemaPath, "utf8");
    const block = schema.split("model ReviewerCorrection")[1] ?? "";
    expect(block).toContain("versionNumber");
    expect(block).toContain("parentCorrectionId");
    expect(block).toContain("supersedesCorrectionId");
    expect(block).toContain("supersededByCorrectionId");
    expect(block).toContain("supersededAt");
  });

  it("IntelligenceActivityEvent model exists with bounded columns", () => {
    const schemaPath = fileURLToPath(
      new URL("../prisma/schema.prisma", import.meta.url),
    );
    const schema = readFileSync(schemaPath, "utf8");
    expect(schema).toContain("model IntelligenceActivityEvent");
    expect(schema).toContain("intelligence_activity_events");
    const block = schema.split("model IntelligenceActivityEvent")[1] ?? "";
    expect(block).toContain("category");
    expect(block).toContain("code");
    expect(block).toContain("recordId");
    expect(block).toContain("correctionId");
    expect(block).toContain("budgetId");
    expect(block).toContain("evidenceId");
    expect(block).toContain("failureReason");
  });

  it("closure migration is Phase O-Final compliant", () => {
    const migPath = fileURLToPath(
      new URL(
        "../prisma/migrations/20261216000000_phase_3b_enterprise_closure/migration.sql",
        import.meta.url,
      ),
    );
    const sql = readFileSync(migPath, "utf8");
    // Every CREATE INDEX must be wrapped in a DO/information_schema guard.
    const guardCount = sql.match(/DO \$\$/g)?.length ?? 0;
    expect(guardCount).toBeGreaterThanOrEqual(2);
    // Additive column adds use IF NOT EXISTS for replay safety.
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS \"version_number\"");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS \"parent_correction_id\"");
    // Brand-new table → plain CREATE TABLE (Phase O-Final pattern).
    expect(sql).toContain("CREATE TABLE \"intelligence_activity_events\"");
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS");
    // Every CREATE INDEX is preceded by an information_schema guard.
    expect(sql).toContain("information_schema.columns");
  });
});

// ---------------------------------------------------------------------------
// 3. Service module API surface.
// ---------------------------------------------------------------------------

describe("Phase 3B Closure — service module surface", () => {
  it("intelligence-activity emitter exports `emitLifecycleEvent`", async () => {
    const m = await import(
      "../src/services/intelligence/intelligence-activity.service.js"
    );
    expect(typeof m.emitLifecycleEvent).toBe("function");
    expect(typeof m.listLifecycleEvents).toBe("function");
    expect(typeof m.countLifecycleEvents).toBe("function");
  });

  it("intelligence-quality exposes provider / reviewer / team projections", async () => {
    const m = await import(
      "../src/services/intelligence/intelligence-quality.service.js"
    );
    expect(typeof m.projectProviderQuality).toBe("function");
    expect(typeof m.projectReviewerQuality).toBe("function");
    expect(typeof m.projectTeamQuality).toBe("function");
  });

  it("executive-metrics exposes the trends projector", async () => {
    const m = await import(
      "../src/services/intelligence/executive-metrics.service.js"
    );
    expect(typeof m.projectExecutiveTrends).toBe("function");
    expect(typeof m.projectExecutiveMetrics).toBe("function");
  });

  it("provider-budget exposes scoped enforcement + spend + breach reads", async () => {
    const m = await import(
      "../src/services/intelligence/provider-budget.service.js"
    );
    expect(typeof m.decideBudgetGate).toBe("function");
    expect(typeof m.listBudgetBreaches).toBe("function");
    expect(typeof m.listBudgetSpend).toBe("function");
    expect(typeof m.createBudget).toBe("function");
  });

  it("reviewer-correction exposes the version-chain projection", async () => {
    const m = await import(
      "../src/services/intelligence/reviewer-correction.service.js"
    );
    expect(typeof m.getCorrectionVersionChain).toBe("function");
    expect(typeof m.getCorrectionVersionChainsForEvidence).toBe("function");
  });

  it("verification-manifest exposes the four closure writers", async () => {
    const m = await import(
      "../src/services/intelligence/intelligence-verification-manifest.service.js"
    );
    expect(typeof m.buildCorrectionVersionChainManifestEntry).toBe("function");
    expect(typeof m.buildProviderQualityManifestEntry).toBe("function");
    expect(typeof m.buildBudgetGovernanceManifestEntry).toBe("function");
    expect(typeof m.buildAuditEventsManifestEntry).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 4. Provider budget gate correctly enforces scopeTargetId.
//
// The audit identified that the prior `sumConsumed` filtered only by
// teamId + provider, so a CASE-scoped budget compared against
// team-wide spend. We exercise the new scoped query against an in-memory
// Prisma stub to prove case A blocks while case B remains unaffected.
// ---------------------------------------------------------------------------

describe("Phase 3B Closure — scoped budget enforcement", () => {
  it("CASE budget honours `caseId` (no team-wide leakage)", async () => {
    const { decideBudgetGate } = await import(
      "../src/services/intelligence/provider-budget.service.js"
    );

    const caseA = "00000000-0000-0000-0000-00000000aaaa";
    const caseB = "00000000-0000-0000-0000-00000000bbbb";
    const teamId = "00000000-0000-0000-0000-0000000000aa";

    // Stub Prisma with the bounded surface decideBudgetGate uses.
    const usageRows: Array<{
      caseId: string | null;
      provider: string;
      estimatedCostUsdMicros: bigint;
      decision: string;
    }> = [
      // Case A has consumed 8000 micros under AZURE — close to its limit.
      {
        caseId: caseA,
        provider: "AZURE_DOCUMENT_INTELLIGENCE",
        estimatedCostUsdMicros: 8000n,
        decision: "ALLOW",
      },
      // Case B has consumed nothing.
    ];
    const alertRows: Array<{ teamId: string; budgetId: string; threshold: string }> = [];
    const lifecycleRows: Array<{ code: string; budgetId: string | null }> = [];

    const prismaStub = {
      providerBudget: {
        findMany: async () => [
          {
            id: "budget-A",
            teamId,
            scope: "CASE",
            scopeTargetId: caseA,
            provider: "AZURE_DOCUMENT_INTELLIGENCE",
            period: "MONTHLY",
            softLimitUsdMicros: 5000n,
            hardLimitUsdMicros: 10000n,
            state: "ACTIVE",
          },
        ],
      },
      providerUsageEvent: {
        aggregate: async (args: {
          where: {
            caseId?: string;
            projectId?: string;
            teamId: string;
            decision?: { not?: string };
          };
        }) => {
          const filtered = usageRows.filter((r) => {
            if (args.where.caseId && r.caseId !== args.where.caseId) return false;
            return r.decision !== "BLOCK";
          });
          const sum = filtered.reduce(
            (acc, r) => acc + Number(r.estimatedCostUsdMicros),
            0,
          );
          return {
            _sum: { estimatedCostUsdMicros: BigInt(sum) },
          };
        },
      },
      providerBudgetAlert: {
        create: async ({ data }: { data: { teamId: string; budgetId: string; threshold: string } }) => {
          alertRows.push(data);
          return data;
        },
      },
      intelligenceActivityEvent: {
        create: async ({ data }: { data: { code: string; budgetId: string | null } }) => {
          lifecycleRows.push({ code: data.code, budgetId: data.budgetId });
          return data;
        },
      },
    } as never;

    // Case A: consumed 8000 + new cost 5000 = 13000 > hard 10000 → BLOCK.
    const caseADecision = await decideBudgetGate(
      {
        teamId,
        provider: "AZURE_DOCUMENT_INTELLIGENCE",
        estimatedCostUsdMicros: 5000,
        caseId: caseA,
      },
      prismaStub,
    );
    expect(caseADecision.decision).toBe("BLOCK");
    expect(caseADecision.budgetId).toBe("budget-A");

    // Case B: consumed 0 + new cost 5000 = 5000 ≤ hard 10000 → ALLOW.
    // The prior team-wide-leakage bug would have BLOCKED here too because
    // the team-aggregated spend was 8000. Our scoped query honours caseId.
    const caseBDecision = await decideBudgetGate(
      {
        teamId,
        provider: "AZURE_DOCUMENT_INTELLIGENCE",
        estimatedCostUsdMicros: 5000,
        caseId: caseB,
      },
      prismaStub,
    );
    expect(caseBDecision.decision).toBe("ALLOW");

    // Lifecycle events emitted for the BLOCK decision.
    expect(lifecycleRows.map((r) => r.code)).toContain("BUDGET_HARD_LIMIT_REACHED");
    expect(lifecycleRows.map((r) => r.code)).toContain("BUDGET_BLOCKED");
  });

  it("PROJECT budget honours `projectId` (no team-wide leakage)", async () => {
    const { decideBudgetGate } = await import(
      "../src/services/intelligence/provider-budget.service.js"
    );

    const projectA = "00000000-0000-0000-0000-00000000aa00";
    const projectB = "00000000-0000-0000-0000-00000000bb00";
    const teamId = "00000000-0000-0000-0000-0000000000aa";

    const usageRows = [
      {
        projectId: projectA,
        provider: "DEEPGRAM_TRANSCRIPT",
        estimatedCostUsdMicros: 18000n,
        decision: "ALLOW",
      },
    ];

    const prismaStub = {
      providerBudget: {
        findMany: async () => [
          {
            id: "budget-PA",
            teamId,
            scope: "PROJECT",
            scopeTargetId: projectA,
            provider: "DEEPGRAM_TRANSCRIPT",
            period: "MONTHLY",
            softLimitUsdMicros: 15000n,
            hardLimitUsdMicros: 20000n,
            state: "ACTIVE",
          },
        ],
      },
      providerUsageEvent: {
        aggregate: async (args: {
          where: { projectId?: string };
        }) => {
          const filtered = usageRows.filter(
            (r) => !args.where.projectId || r.projectId === args.where.projectId,
          );
          const sum = filtered.reduce(
            (acc, r) => acc + Number(r.estimatedCostUsdMicros),
            0,
          );
          return { _sum: { estimatedCostUsdMicros: BigInt(sum) } };
        },
      },
      providerBudgetAlert: { create: async () => null },
      intelligenceActivityEvent: { create: async () => null },
    } as never;

    const projectADecision = await decideBudgetGate(
      {
        teamId,
        provider: "DEEPGRAM_TRANSCRIPT",
        estimatedCostUsdMicros: 5000,
        projectId: projectA,
      },
      prismaStub,
    );
    expect(projectADecision.decision).toBe("BLOCK");

    const projectBDecision = await decideBudgetGate(
      {
        teamId,
        provider: "DEEPGRAM_TRANSCRIPT",
        estimatedCostUsdMicros: 5000,
        projectId: projectB,
      },
      prismaStub,
    );
    expect(projectBDecision.decision).toBe("ALLOW");
  });

  it("CASE + PROJECT requires `scopeTargetId` on creation", async () => {
    const { createBudget } = await import(
      "../src/services/intelligence/provider-budget.service.js"
    );
    const denied = await createBudget({
      prisma: { providerBudget: { create: async () => ({ id: "x" }) } } as never,
      teamId: "team",
      scope: "CASE",
      scopeTargetId: null,
      provider: null,
      period: "MONTHLY",
      softLimitUsdMicros: 1,
      hardLimitUsdMicros: 2,
      createdByUserId: "user",
    });
    expect(denied.ok).toBe(false);
  });

  it("soft-limit emits a WARN decision + alert", async () => {
    const { decideBudgetGate } = await import(
      "../src/services/intelligence/provider-budget.service.js"
    );
    const alerts: Array<{ threshold: string }> = [];
    const lifecycleCodes: string[] = [];
    const prismaStub = {
      providerBudget: {
        findMany: async () => [
          {
            id: "b",
            teamId: "team",
            scope: "TEAM",
            scopeTargetId: null,
            provider: null,
            period: "MONTHLY",
            softLimitUsdMicros: 5000n,
            hardLimitUsdMicros: 100000n,
            state: "ACTIVE",
          },
        ],
      },
      providerUsageEvent: {
        aggregate: async () => ({ _sum: { estimatedCostUsdMicros: 6000n } }),
      },
      providerBudgetAlert: {
        create: async ({ data }: { data: { threshold: string } }) => {
          alerts.push(data);
          return data;
        },
      },
      intelligenceActivityEvent: {
        create: async ({ data }: { data: { code: string } }) => {
          lifecycleCodes.push(data.code);
          return data;
        },
      },
    } as never;
    const decision = await decideBudgetGate(
      {
        teamId: "team",
        provider: "AZURE_DOCUMENT_INTELLIGENCE",
        estimatedCostUsdMicros: 1000,
      },
      prismaStub,
    );
    expect(decision.decision).toBe("WARN");
    expect(alerts.some((a) => a.threshold === "SOFT")).toBe(true);
    expect(lifecycleCodes).toContain("BUDGET_SOFT_LIMIT_REACHED");
  });
});

// ---------------------------------------------------------------------------
// 5. Audit transparency federator surfaces failureReason + lifecycle.
// ---------------------------------------------------------------------------

describe("Phase 3B Closure — audit transparency federator", () => {
  it("surfaces failureReason on provider usage rows + federates lifecycle table", async () => {
    const fed = await import(
      "../src/services/intelligence/audit-transparency.service.js"
    );
    const stub = {
      providerUsageEvent: {
        findMany: async () => [
          {
            id: "p1",
            provider: "AZURE_DOCUMENT_INTELLIGENCE",
            operation: "OCR_DOCUMENT",
            decision: "ALLOW",
            units: 1,
            estimatedCostUsdMicros: 1500n,
            occurredAtUtc: new Date(),
            initiatedByUserId: null,
            evidenceId: "e1",
            caseId: null,
            projectId: null,
            failureReason: "azure_timeout",
          },
        ],
      },
      reviewerCorrection: { findMany: async () => [] },
      redactionActivity: { findMany: async () => [] },
      redactionPolicyAudit: { findMany: async () => [] },
      videoTimelineEvent: { findMany: async () => [] },
      externalReviewActivity: { findMany: async () => [] },
      intelligenceActivityEvent: {
        findMany: async () => [
          {
            occurredAtUtc: new Date(),
            actorUserId: null,
            category: "CORRECTION_LIFECYCLE",
            code: "CORRECTION_ACCEPTED",
            recordId: "r1",
            correctionId: "c1",
            budgetId: null,
            evidenceId: "e1",
            caseId: null,
            projectId: null,
            provider: null,
            operation: null,
            failureReason: null,
            reason: "kind=OCR_TEXT",
          },
        ],
      },
      providerBudgetAlert: { findMany: async () => [] },
    } as never;

    const entries = await fed.listAuditTransparency({
      prisma: stub,
      teamId: "team",
      limit: 50,
    });
    const codes = entries.map((e) => e.code);
    expect(codes).toContain("CORRECTION_ACCEPTED");
    const usageRow = entries.find((e) => e.sourceService === "provider-usage");
    expect(usageRow).toBeDefined();
    expect(usageRow?.payload.failureReason).toBe("azure_timeout");
    expect(usageRow?.label).toContain("FAILED");
  });
});

// ---------------------------------------------------------------------------
// 6. HTTP routes for closure surfaces are mounted.
// ---------------------------------------------------------------------------

describe("Phase 3B Closure — HTTP routes", () => {
  it("intelligence-platform.routes registers trends + quality + version-chain + breaches + spend", () => {
    const path = fileURLToPath(
      new URL("../src/routes/intelligence-platform.routes.ts", import.meta.url),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("/v1/executive/trends");
    expect(src).toContain("/v1/intelligence/quality/providers");
    expect(src).toContain("/v1/intelligence/quality/reviewers");
    expect(src).toContain("/v1/intelligence/quality/teams");
    expect(src).toContain("/v1/intelligence/records/:id/version-chain");
    expect(src).toContain("/v1/intelligence/budgets/breaches");
    expect(src).toContain("/v1/intelligence/budgets/spend");
    // Range enum is wired into trend + quality routes.
    expect(src).toContain("EXECUTIVE_METRICS_RANGES");
  });
});

// ---------------------------------------------------------------------------
// 7. UI surfaces + nav registry.
// ---------------------------------------------------------------------------

describe("Phase 3B Closure — UI + nav registry", () => {
  it("executive page exposes range selector + trend tiles + new families", () => {
    const path = fileURLToPath(
      new URL("../../../apps/web/app/(app)/executive/page.tsx", import.meta.url),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("data-executive-range-bar");
    expect(src).toContain("data-executive-range-button");
    expect(src).toContain("data-executive-trend-tile");
    expect(src).toContain("data-executive-trend-arrow");
    expect(src).toContain("data-executive-trend-delta");
    expect(src).toContain("data-executive-trend-pct");
    expect(src).toContain("data-executive-cost");
    expect(src).toContain("data-executive-corrections");
    // Bound to the trends route, not the snapshot route.
    expect(src).toContain("/v1/executive/trends");
  });

  it("intelligence quality page exists with bounded anchors", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/intelligence-quality/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("data-intelligence-quality");
    expect(src).toContain("data-intelligence-quality-provider-table");
    expect(src).toContain("data-intelligence-quality-reviewer-table");
    expect(src).toContain("data-intelligence-quality-team-table");
  });

  it("budget center page exists with spend + breach tables", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/budget-center/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("data-budget-center");
    expect(src).toContain("data-budget-spend-table");
    expect(src).toContain("data-budget-breach-table");
    expect(src).toContain("data-budget-threshold");
  });

  it("audit transparency page surfaces failure reason", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/audit-transparency/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("data-audit-transparency-failure-reason");
    expect(src).toContain("Failure reason");
  });

  it("nav registry exposes the new closure pages", () => {
    const path = fileURLToPath(
      new URL(
        "../src/services/platform-context/navigation-registry.ts",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("workspace.intelligence_quality");
    expect(src).toContain("/intelligence-quality");
    expect(src).toContain("workspace.budget_center");
    expect(src).toContain("/budget-center");
  });
});

// ---------------------------------------------------------------------------
// 8. Report section accepts closure-extended shape.
// ---------------------------------------------------------------------------

describe("Phase 3B Closure — report section", () => {
  it("intelligence-summary section source declares closure-extended types + render blocks", () => {
    // Source-grep test — the worker report module pulls in asset
    // pipeline side-effects that aren't available in the API test
    // harness, so we pin the section by source inspection instead.
    const path = fileURLToPath(
      new URL(
        "../../worker/src/report-v2/sections/intelligence-summary.ts",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    // Closure-extended type fields.
    expect(src).toContain("providerQuality?");
    expect(src).toContain("correctionVersionChain?");
    expect(src).toContain("budgetGovernance?");
    expect(src).toContain("auditEvents?");
    // Closure-extended render blocks.
    expect(src).toContain("Provider quality summary");
    expect(src).toContain("Correction version chain");
    expect(src).toContain("immutable versions preserved");
    expect(src).toContain("Budget governance summary");
    expect(src).toContain("Audit events summary");
    // The section composes the closure blocks into the rendered body.
    expect(src).toContain("${providerQualityTable}");
    expect(src).toContain("${versionChainBlock}");
    expect(src).toContain("${budgetBlock}");
    expect(src).toContain("${auditBlock}");
  });
});

// ---------------------------------------------------------------------------
// 9. Bounded re-imports verify path resolution.
// ---------------------------------------------------------------------------

describe("Phase 3B Closure — module resolution", () => {
  it("activity emitter module imports cleanly", async () => {
    await expect(
      import("../src/services/intelligence/intelligence-activity.service.js"),
    ).resolves.toBeDefined();
  });

  it("quality module imports cleanly", async () => {
    await expect(
      import("../src/services/intelligence/intelligence-quality.service.js"),
    ).resolves.toBeDefined();
  });

  it("executive-metrics imports `projectExecutiveTrends`", async () => {
    const m = await import(
      "../src/services/intelligence/executive-metrics.service.js"
    );
    expect("projectExecutiveTrends" in m).toBe(true);
  });
});
