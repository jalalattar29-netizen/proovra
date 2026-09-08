/**
 * LEGAL HOLD — ONE commercial answer, and one that can never weaken a hold.
 *
 * ===========================================================================
 * THE CLASSIFICATION
 * ===========================================================================
 * Legal Hold looked like it was priced twice:
 *
 *   * the PLAN axis — `PLAN_CAPABILITIES[plan].enterpriseFeatures.legalHold`,
 *     true on ENTERPRISE only, and
 *   * the PRODUCT-LINE axis — the `FEATURE_LEGAL_HOLD` entitlement, granted by
 *     `applyProductLine` on the INVESTIGATIONS and ENTERPRISE lines.
 *
 * They are not two answers to one question. The plan flag was never wired to a
 * legal-hold route at all: what it actually gated was three routes in
 * `governance-lifecycle.routes.ts` — create a destruction review, decide one,
 * force a lifecycle transition — under the BORROWED NAME `legalHold`, which is
 * what made this look like a duplicated authority. That flag is now
 * `destructionGovernance`, carrying an identical value on every plan, so the
 * rename settled the classification without moving a price.
 *
 * ===========================================================================
 * WHAT CHANGED SINCE (2026-09-08)
 * ===========================================================================
 * The classification was right and the entitlement was still unreachable.
 * `FEATURE_LEGAL_HOLD` was fed only by `EntitlementGrant` rows from
 * `applyProductLine`, so an ENTERPRISE workspace with no product line applied
 * resolved to `false` — while two governance routes reached the same canonical
 * writer with no entitlement check at all.
 *
 * Legal Hold is now an ENTERPRISE capability whose availability is CONTRACT
 * DRIVEN: plan eligibility, then an ACTIVE Enterprise contract stating the
 * term, resolved once in `resolveEntitlement` so every route and the UI read
 * the same answer. The behavioural cases live in
 * `legal-hold-enterprise-entitlement.test.ts`; this file pins the source shape
 * and the safety invariant so neither can silently regress.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalCanEnterPendingDestruction,
  type CanonicalDestructionFacts,
} from "@proovra/shared";
import {
  PLAN_CAPABILITIES,
  type PlanType,
} from "@proovra/shared-billing";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = join(HERE, "..", "src");
const read = (p: string) => readFileSync(join(API_SRC, p), "utf8");

/**
 * Executable source only.
 *
 * A retired key is allowed — required, really — to be NAMED in the comment
 * explaining why it was retired. What must not survive is a live gate reading
 * it, so the assertions below run against the code with comments stripped
 * rather than against the raw file.
 */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const GOVERNANCE_ROUTES = "routes/governance-lifecycle.routes.ts";
const LIFECYCLE_ROUTES = "routes/product-and-lifecycle.routes.ts";
/** The EVIDENCE- and CASE-scoped hold routes. Not the same file as
 *  GOVERNANCE_ROUTES above, which is destruction/lifecycle governance. */
const HOLD_ROUTES = "routes/governance.routes.ts";

describe("Legal Hold — the eligibility authority", () => {
  it("the hold surface gates on the ENTITLEMENT, and on nothing else", () => {
    const text = codeOnly(read(LIFECYCLE_ROUTES));
    // CREATION is gated.
    const featureGates =
      text.match(/key:\s*"FEATURE_LEGAL_HOLD"/g) ?? [];
    expect(featureGates.length).toBeGreaterThanOrEqual(1);
    /*
     * READING IS NOT, deliberately. A lapsed or suspended contract must never
     * hide a workspace's own ACTIVE holds: they still block destruction, and
     * the operator who has just been refused a deletion is exactly the person
     * who needs to see why. The list is authorization-gated
     * (`governance.policy.read`, anti-enumerating) and not entitlement-gated.
     */
    const listHandler = text.slice(
      text.indexOf('"/v1/lifecycle/legal-holds"'),
      text.indexOf("listLifecycleLegalHoldsLegacyShape("),
    );
    expect(listHandler.length).toBeGreaterThan(0);
    expect(
      listHandler,
      "the legal-hold LIST must not require commercial entitlement",
    ).not.toContain("FEATURE_LEGAL_HOLD");
    expect(listHandler).toContain("governance.policy.read");
    // No numeric ceiling. `LEGAL_HOLD_MAX_ACTIVE` was retired: 0 / 25 / 1000,
    // none of them a contract term, and the default of 0 would have refused
    // every workspace the contract had just entitled.
    expect(text).not.toContain("LEGAL_HOLD_MAX_ACTIVE");
    // And the plan-axis gate does not appear on this surface at all: a second
    // eligibility authority here is exactly the defect being closed.
    expect(text).not.toContain("assertTeamAllowsEnterpriseFeature");
    expect(text).not.toContain("denyIfTeamNotEnterprise");
  });

  it("EVERY route reaching the canonical writer checks the entitlement", () => {
    /*
     * THE GAP THIS CLOSES. `placeCanonicalLegalHold` is the one writer, and
     * three routes reach it. Two of them — the evidence-scoped and case-scoped
     * governance routes — checked permission and step-up and no entitlement at
     * all, so the commercial answer was never asked for on those paths.
     *
     * The assertion is on CALL COUNTS in executable source: every file that
     * calls the writer must check the key at least as many times as it calls
     * it. That fails the moment a fourth route is added without a gate, which
     * is the regression worth catching.
     */
    for (const file of [HOLD_ROUTES, LIFECYCLE_ROUTES]) {
      const text = codeOnly(read(file));
      const writes = (text.match(/placeCanonicalLegalHold\(/g) ?? []).length;
      expect(writes, `${file} should reach the canonical writer`).toBeGreaterThan(0);
      const gates = (text.match(/key:\s*"FEATURE_LEGAL_HOLD"/g) ?? []).length;
      expect(
        gates,
        `${file}: ${writes} call(s) to placeCanonicalLegalHold but only ${gates} entitlement check(s) — a creation path is ungated`,
      ).toBeGreaterThanOrEqual(writes);
    }
  });

  it("the contract term is the only thing that can grant it", () => {
    // The resolver reads plan + contract and nothing else. A stored grant
    // deciding this key is the duplicate-authority defect returning.
    const engine = codeOnly(
      read("services/packaging/entitlement.service.ts"),
    );
    expect(engine).toContain("resolveLegalHoldEntitlement");
    expect(engine).toContain("limits.legalHoldEnabled");
    // Eligibility is checked before the contract is read.
    expect(engine).toContain('ctx.plan !== "ENTERPRISE"');
  });

  it("no route anywhere gates a legal-hold operation on the plan flag", () => {
    const text = read(GOVERNANCE_ROUTES);
    // The governance routes still carry a plan gate — for DESTRUCTION
    // GOVERNANCE, which is a different question and now says so.
    expect(text).toContain('"destructionGovernance"');
    // The borrowed name is gone. This is the assertion that stops somebody
    // "restoring" it and recreating the duplicate authority.
    expect(text).not.toContain('"legalHold"');
  });
});

describe("Legal Hold — the rename moved no price", () => {
  it("destructionGovernance carries the same value as legalHold on every plan", () => {
    const plans = Object.keys(PLAN_CAPABILITIES) as PlanType[];
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      const features = PLAN_CAPABILITIES[plan].enterpriseFeatures;
      expect(
        features.destructionGovernance,
        `${plan}: destructionGovernance must match legalHold — the split was a rename, not a repricing`,
      ).toBe(features.legalHold);
    }
  });

  it("both remain ENTERPRISE-only, which is what the catalog already promised", () => {
    for (const plan of Object.keys(PLAN_CAPABILITIES) as PlanType[]) {
      const features = PLAN_CAPABILITIES[plan].enterpriseFeatures;
      const expected = plan === "ENTERPRISE";
      expect(features.legalHold, `${plan}.legalHold`).toBe(expected);
      expect(
        features.destructionGovernance,
        `${plan}.destructionGovernance`,
      ).toBe(expected);
    }
  });
});

describe("Legal Hold — commercial state can never weaken an ACTIVE hold", () => {
  /**
   * THE INVARIANT THAT MATTERS MOST.
   *
   * Whatever is decided commercially, a hold that EXISTS must keep blocking
   * destruction. The canonical formula takes only lifecycle facts — it has no
   * plan parameter and no entitlement parameter — so there is no commercial
   * input that could flip it. These cases prove the property rather than the
   * prose.
   */
  const held: CanonicalDestructionFacts = {
    fromState: "ACTIVE",
    hasActiveDirectHold: true,
    hasActiveCaseHold: false,
    immutableRetention: false,
  };

  it("a direct hold blocks destruction, and blocks it FIRST", () => {
    const decision = canonicalCanEnterPendingDestruction(held);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("blocked_by_hold");
  });

  it("a case hold blocks destruction on its own", () => {
    const decision = canonicalCanEnterPendingDestruction({
      ...held,
      hasActiveDirectHold: false,
      hasActiveCaseHold: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("blocked_by_case_hold");
  });

  it("the hold decision takes no commercial input at all", () => {
    // Every field the formula accepts is a lifecycle fact. If a plan or
    // entitlement ever became an input, this shape assertion fails and the
    // author has to justify it.
    const keys = Object.keys(held).sort();
    expect(keys).toEqual([
      "fromState",
      "hasActiveCaseHold",
      "hasActiveDirectHold",
      "immutableRetention",
    ]);
    const source = readFileSync(
      join(HERE, "..", "..", "..", "packages", "shared", "src", "canonical-decisions.ts"),
      "utf8",
    );
    const formula = source.slice(
      source.indexOf("export function canonicalCanEnterPendingDestruction"),
    );
    const body = formula.slice(0, formula.indexOf("\n}\n") + 3);
    for (const forbidden of [
      "plan",
      "entitlement",
      "Entitlement",
      "billing",
      "FEATURE_",
    ]) {
      expect(
        body,
        `the destruction formula must not consult ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });

  it("a hold outranks every other blocker, so precedence cannot be reordered away", () => {
    // Held AND already under review AND retention-locked: the answer must still
    // name the hold, because that is the one an operator must clear first.
    const decision = canonicalCanEnterPendingDestruction({
      ...held,
      immutableRetention: true,
      hasActiveDestructionReview: true,
    });
    expect(decision.reason).toBe("blocked_by_hold");
  });
});
