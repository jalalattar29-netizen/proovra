/**
 * PLATFORM COMMERCIAL AUTHORITY CLOSURE (2026-09-07).
 *
 * ONE commercial truth per capability. A purchased plan must grant exactly
 * what the product says it grants — no second engine answering the same
 * question from a different table with a different number.
 *
 * These are contract tests over the CANONICAL authorities, plus source-level
 * pins that the retired duplicates cannot come back. They are deliberately
 * source-reading in places: the defect class this file closes is not "the
 * number is wrong", it is "a second reader exists", and only source can prove
 * a reader's absence.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PLAN_CAPABILITIES, getPlanCapabilities } from "@proovra/shared-billing";
import { ENTITLEMENT_KEYS } from "@proovra/shared";
import {
  NO_CONTRACT_LIMITS,
  resolveEffectiveContractAiCap,
  resolveEffectiveExternalReviewIncluded,
} from "../src/services/billing/enterprise-contract-limits.js";

const repo = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.resolve(repo, rel), "utf8");

// Strip comments so a pin proves a CALL, never a mention of one.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

describe("External Review — one commercial authority", () => {
  it("the approved plan matrix is the catalog's answer", () => {
    expect(PLAN_CAPABILITIES.FREE.externalReviewIncluded).toBe(false);
    expect(PLAN_CAPABILITIES.PAYG.externalReviewIncluded).toBe(false);
    expect(PLAN_CAPABILITIES.PRO.externalReviewIncluded).toBe(true);
    expect(PLAN_CAPABILITIES.TEAM.externalReviewIncluded).toBe(true);
    expect(PLAN_CAPABILITIES.ENTERPRISE.externalReviewIncluded).toBe(true);
  });

  it("the effective resolver returns the catalog answer for every plan", () => {
    for (const plan of ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"] as const) {
      expect(
        resolveEffectiveExternalReviewIncluded({
          plan,
          contract: NO_CONTRACT_LIMITS,
        }),
        `${plan} must resolve to its catalog answer`,
      ).toBe(getPlanCapabilities(plan).externalReviewIncluded);
    }
  });

  it("a non-ACTIVE Enterprise contract does not strip an ENTERPRISE plan's inclusion", () => {
    /*
     * The numeric siblings fall back to the catalog when a contract is not
     * ACTIVE, and the catalog answer for ENTERPRISE is "included". Lifecycle is
     * `assertCommercialLifecycleAllowsPaidMutation`'s question, asked upstream
     * — answering it a second time here would be a second lifecycle authority,
     * which is the exact defect class this file exists to prevent.
     */
    expect(
      resolveEffectiveExternalReviewIncluded({
        plan: "ENTERPRISE",
        contract: { ...NO_CONTRACT_LIMITS, contractGovernsCapability: false },
      }),
    ).toBe(true);
  });

  it("both enforcement sites and the console projection call the SAME function", () => {
    for (const rel of [
      "services/api/src/routes/external-review.routes.ts",
      "services/api/src/routes/external-portal.routes.ts",
      "services/api/src/services/platform-context/platform-context.service.ts",
    ]) {
      expect(
        codeOnly(read(rel)),
        `${rel} must resolve External Review through the canonical authority`,
      ).toContain("workspaceIncludesExternalReview");
    }
  });

  it("no enforcement site re-derives the answer from a plan NAME", () => {
    for (const rel of [
      "services/api/src/routes/external-review.routes.ts",
      "services/api/src/routes/external-portal.routes.ts",
    ]) {
      expect(codeOnly(read(rel))).not.toMatch(
        /plan\s*===\s*"(FREE|PAYG|PRO|TEAM|ENTERPRISE)"/,
      );
    }
  });

  it("the commercial gate no longer fails OPEN on resolver error", () => {
    /*
     * The external-portal gate used to sit inside `try { ... } catch {}`, so a
     * packaging-engine failure ADMITTED the mutation. A commercial gate that
     * fails open is not a gate.
     */
    const src = read("services/api/src/routes/external-portal.routes.ts");
    const idx = src.indexOf("workspaceIncludesExternalReview(");
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, idx - 400), idx);
    expect(window).not.toMatch(/try\s*\{[^}]*$/);
  });
});

describe("AI operations — one monthly commercial allowance", () => {
  it("the approved plan matrix is the catalog's answer", () => {
    expect(PLAN_CAPABILITIES.FREE.aiAdvisoryMonthlyOperations).toBe(10);
    expect(PLAN_CAPABILITIES.PAYG.aiAdvisoryMonthlyOperations).toBe(50);
    expect(PLAN_CAPABILITIES.PRO.aiAdvisoryMonthlyOperations).toBe(100);
    expect(PLAN_CAPABILITIES.TEAM.aiAdvisoryMonthlyOperations).toBe(500);
    expect(PLAN_CAPABILITIES.ENTERPRISE.aiAdvisoryMonthlyOperations).toBeNull();
  });

  it("an ACTIVE contract figure wins; contract silence falls back to the catalog", () => {
    expect(
      resolveEffectiveContractAiCap({
        plan: "ENTERPRISE",
        contract: {
          ...NO_CONTRACT_LIMITS,
          contractGovernsCapability: true,
          aiOperationsPerMonth: 25_000,
        },
      }),
    ).toBe(25_000);
    expect(
      resolveEffectiveContractAiCap({
        plan: "TEAM",
        contract: NO_CONTRACT_LIMITS,
      }),
    ).toBe(500);
  });

  it("a TEAM workspace is never capped below what its plan sells", () => {
    /*
     * THE REGRESSION THIS FILE EXISTS FOR. The packaging engine's
     * `QUOTA_AI_OPERATIONS_PER_MONTH` defaulted to 25 and no purchase path
     * wrote a grant, so a TEAM workspace sold 500 operations was refused at 25
     * by whichever engine ran first.
     */
    const cap = resolveEffectiveContractAiCap({
      plan: "TEAM",
      contract: NO_CONTRACT_LIMITS,
    });
    expect(cap).not.toBe(25);
    expect(cap).toBe(500);
  });

  it("the provider orchestrator asks the canonical authority, not the packaging engine", () => {
    const src = read(
      "services/api/src/services/intelligence/media-intelligence.service.ts",
    );
    const code = codeOnly(src);
    expect(code).toContain("evaluateWorkspaceAiOperation(");
    expect(code).toContain("recordWorkspaceAiOperationForWorkspace(");
    // The packaging engine is not merely unused here — it is not imported, so
    // it cannot be called.
    expect(src).not.toContain("packaging/entitlement.service.js");
  });

  it("every AI operation is counted on ONE key", () => {
    const src = read("services/api/src/services/billing-enforcement.service.ts");
    expect(src).toContain(
      'export const AI_USAGE_KEY = "ai_advisory_operations"',
    );
    const mi = read(
      "services/api/src/services/intelligence/media-intelligence.service.ts",
    );
    expect(codeOnly(mi)).not.toContain("QUOTA_AI_OPERATIONS_PER_MONTH");
  });
});

describe("commercial subject — the workspace, never the actor's own plan", () => {
  it("the AI routes resolve the ACTIVE WORKSPACE, not PERSONAL_ACCOUNT", () => {
    /*
     * All three AI routes used `{ type: "PERSONAL_ACCOUNT", userId }`, so a
     * FREE member of a TEAM workspace spent TEAM work against their personal
     * ten-a-month allowance, and the usage landed on their personal Team row
     * where the billed workspace could not see it.
     */
    const src = read("services/api/src/routes/ai.routes.ts");
    const code = codeOnly(src);
    expect(code).toContain("resolveAiCommercialScope(userId)");
    expect(code).not.toContain(
      'resolveCommercialContext({ type: "PERSONAL_ACCOUNT", userId })).scope',
    );
    // The pointer is re-proven, not trusted: a stale `currentWorkspaceId` must
    // not borrow another workspace's allowance.
    expect(code).toContain("currentWorkspaceId");
    expect(code).toContain("teamMember.findUnique");
    expect(code).toMatch(/status\s*===\s*"ACTIVE"/);
  });

  it("the workspace-subject readers resolve the workspace, not the requester", () => {
    const src = codeOnly(
      read("services/api/src/services/billing-enforcement.service.ts"),
    );
    const idx = src.indexOf("async function resolveWorkspaceCommercialScope(");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 900);
    expect(body).toContain('type: "WORKSPACE"');
    expect(body).toContain("requesterUserId: workspace.ownerUserId");
  });
});

describe("the retired duplicate authorities cannot come back", () => {
  const RETIRED = [
    "FEATURE_EXTERNAL_PORTAL",
    "FEATURE_INTELLIGENCE",
    "FEATURE_REVIEWER_WORKSPACE",
    "QUOTA_AI_OPERATIONS_PER_MONTH",
  ] as const;

  it("none of them is in the entitlement vocabulary", () => {
    for (const key of RETIRED) {
      expect(
        ENTITLEMENT_KEYS as ReadonlyArray<string>,
        `${key} must not be grantable`,
      ).not.toContain(key);
    }
  });

  it("no production source reads one of them", () => {
    for (const rel of [
      "services/api/src/routes/external-review.routes.ts",
      "services/api/src/routes/external-portal.routes.ts",
      "services/api/src/routes/reviewer-workspace.routes.ts",
      "services/api/src/services/intelligence/media-intelligence.service.ts",
      "services/api/src/services/platform-context/platform-context.service.ts",
      "services/api/src/services/packaging/entitlement.service.ts",
    ]) {
      const code = codeOnly(read(rel));
      for (const key of RETIRED) {
        expect(code, `${rel} must not read ${key}`).not.toContain(key);
      }
    }
  });

  it("reviewer operations have one authority, and it is the catalog", () => {
    // The packaging default was TRUE — it granted the reviewer workspace to
    // FREE while the catalog reserved it for TEAM and above. A duplicate that
    // fails OPEN is still a duplicate.
    expect(PLAN_CAPABILITIES.FREE.reviewerOperationsIncluded).toBe(false);
    expect(PLAN_CAPABILITIES.PRO.reviewerOperationsIncluded).toBe(false);
    expect(PLAN_CAPABILITIES.TEAM.reviewerOperationsIncluded).toBe(true);
    expect(
      codeOnly(read("services/api/src/routes/reviewer-workspace.routes.ts")),
    ).toContain("workspaceIncludesReviewerOperations");
  });
});

describe("a commercial allowance is not a rate limit", () => {
  it("the AI cost/abuse/policy controls survive the quota retirement", () => {
    const mi = codeOnly(
      read(
        "services/api/src/services/intelligence/media-intelligence.service.ts",
      ),
    );
    // Budget engine (spend), workspace AI policy (customer opt-out) and the
    // provider policy evaluation are different questions from the commercial
    // allowance, and all of them stay.
    expect(mi).toContain("decideBudgetGate(");
    expect(mi).toContain("resolveWorkspaceAiPolicy");
    const ai = codeOnly(read("services/api/src/routes/ai.routes.ts"));
    expect(ai).toContain("AiCostGuard");
    expect(ai).toContain("enforceAiEndpointGuard");
    expect(ai).toContain("evaluateWorkspaceAiPolicy");
  });

  it("the budget engine still refuses to answer the entitlement question", () => {
    const pb = codeOnly(
      read("services/api/src/services/intelligence/provider-budget.service.ts"),
    );
    expect(pb).not.toContain("assertQuotaEntitlement");
    expect(pb).not.toContain("evaluateWorkspaceAiOperation");
  });
});

describe("Workspace seats — one authority, including the bulk path", () => {
  it("no surface computes a seat ceiling with its own max()", () => {
    for (const rel of [
      "services/api/src/routes/analytics.routes.ts",
      "services/api/src/routes/organizations-bulk-invite.routes.ts",
      "services/api/src/routes/organizations-governance.routes.ts",
    ]) {
      const code = codeOnly(read(rel));
      expect(
        code,
        `${rel} must not derive a seat ceiling from caps.includedSeats`,
      ).not.toContain("caps.includedSeats");
      expect(code).not.toMatch(/Math\.max\([^)]*includedSeats/);
    }
  });

  it("the bulk-invite path resolves the canonical seat state", () => {
    /*
     * It summed the RAW `Team.includedSeats` column and read a zero as "no
     * ceiling", so the ONE path that can add many members at once enforced
     * nothing on every plan below Enterprise.
     */
    const code = codeOnly(
      read("services/api/src/routes/organizations-bulk-invite.routes.ts"),
    );
    expect(code).toContain("resolveEffectiveContractSeats({");
    // The organization's contract is resolved ONCE for the batch — an
    // Enterprise term is an ORG-level fact, so the ceiling is exact without an
    // N+1 on an enforcement path.
    expect(code).toContain("resolveEnterpriseContract(orgId)");
    // The ceiling is no longer conditional on a column that is usually zero.
    expect(code).not.toContain("if (included > 0) hasSeatCap = true");
  });

  it("the org rollup reports the ceiling the invite paths enforce", () => {
    const code = codeOnly(
      read("services/api/src/routes/organizations-governance.routes.ts"),
    );
    expect(code).toContain("resolveEffectiveContractSeats({");
    expect(code).toContain("resolveEnterpriseContract(orgId)");
  });

  it("the platform sweep calls the shared rule, not a local formula", () => {
    const code = codeOnly(read("services/api/src/routes/analytics.routes.ts"));
    expect(code).toContain("resolveEffectiveContractSeats({");
  });
});
