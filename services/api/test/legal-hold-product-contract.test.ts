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
 * They are not two answers to one question. The entitlement is the ONE
 * eligibility authority for placing, listing and releasing a legal hold: it is
 * the only thing `/v1/lifecycle/legal-holds` consults, and the plan flag was
 * never wired to a legal-hold route at all.
 *
 * What the plan flag actually gated was three routes in
 * `governance-lifecycle.routes.ts` — create a destruction review, decide one,
 * force a lifecycle transition. It gated them under the BORROWED NAME
 * `legalHold`, which is what made this look like a duplicated authority. The
 * flag is now `destructionGovernance`, carrying an identical value on every
 * plan, so the rename settles the classification without moving a price or
 * changing who is refused.
 *
 * These tests pin that resolution so it cannot silently merge back.
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

const GOVERNANCE_ROUTES = "routes/governance-lifecycle.routes.ts";
const LIFECYCLE_ROUTES = "routes/product-and-lifecycle.routes.ts";

describe("Legal Hold — the eligibility authority", () => {
  it("the hold surface gates on the ENTITLEMENT, and on nothing else", () => {
    const text = read(LIFECYCLE_ROUTES);
    // The entitlement is consulted for both the read and the placement.
    const featureGates =
      text.match(/key:\s*"FEATURE_LEGAL_HOLD"/g) ?? [];
    expect(featureGates.length).toBeGreaterThanOrEqual(2);
    // Placement is additionally bounded by the entitlement LIMIT.
    expect(text).toContain('key: "LEGAL_HOLD_MAX_ACTIVE"');
    // And the plan-axis gate does not appear on this surface at all: a second
    // eligibility authority here is exactly the defect being closed.
    expect(text).not.toContain("assertTeamAllowsEnterpriseFeature");
    expect(text).not.toContain("denyIfTeamNotEnterprise");
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
