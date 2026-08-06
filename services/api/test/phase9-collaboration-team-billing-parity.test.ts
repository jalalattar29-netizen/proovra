/**
 * Team-creation plan-ceiling parity — /v1/teams vs /v1/collaboration-teams.
 *
 * ## History (PHASE 12 POINT 4 STEP 3 — Pass G)
 *
 * The Phase 9 Billing audit found a real bypass: `POST /v1/teams` enforced the
 * per-user ceiling `getPlanCapabilities(plan).maxOwnedTeams`, while
 * `POST /v1/collaboration-teams` enforced only a workspace-scoped `maxTeams`,
 * so a FREE-plan user blocked on one route could create teams on the other.
 * Phase 9 scope forbade fixing it, so the parity assertions were parked behind
 * `describe.skip` and a companion "active" test pinned the gap as STILL OPEN by
 * asserting the string `maxOwnedTeams` was ABSENT from the collaboration path.
 *
 * The debt has since been paid — by a better mechanism than the skipped
 * assertions anticipated. `assertCanCreateCollaborationTeam` (billing-guards.ts)
 * resolves the OWNER's plan and counts that owner's non-archived collaboration
 * teams, refusing with `TEAM_PLAN_REQUIRED` at a zero ceiling and
 * `TEAM_LIMIT_REACHED` at capacity; and `COLLABORATION_TEAM_PLAN_LIMITS` is now
 * projected from the SAME capability catalog that supplies `maxOwnedTeams`.
 *
 * So the old file was doing active harm: a green suite that asserted a
 * security-relevant defect was still present, and a skipped block that would
 * never be un-skipped because its source-string trigger never fired. Both are
 * replaced here by the contract that actually matters — the two ceilings agree,
 * for every plan, and neither path admits a zero-ceiling plan.
 *
 * No `.skip`. No source-text pins on the fix.
 */

import { describe, expect, it } from "vitest";

import {
  COLLABORATION_TEAM_PLAN_LIMITS,
  getCollaborationTeamPlanLimits,
  getPlanCapabilities,
} from "@proovra/shared-billing";

const PLANS = ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"] as const;

describe("team-creation plan ceilings — the two paths agree", () => {
  it("every plan's collaboration ceiling equals its workspace ceiling", () => {
    // This is the Phase 9 finding, inverted into the invariant that closes it.
    // If the two tables are ever allowed to diverge again, whichever route has
    // the looser number becomes a bypass of the other's commercial contract.
    for (const plan of PLANS) {
      const collaboration = getCollaborationTeamPlanLimits(plan).maxTeams;
      const workspace = getPlanCapabilities(plan).maxOwnedTeams;
      expect(
        collaboration,
        `${plan}: collaboration maxTeams (${collaboration}) diverged from ` +
          `workspace maxOwnedTeams (${workspace}) — one route now admits ` +
          `team creation the other refuses`,
      ).toBe(workspace);
    }
  });

  it("the plan vocabulary is complete on both sides — no plan falls through", () => {
    // A plan missing from either table would resolve to `undefined` and the
    // `Math.max(0, …)` guards would silently read 0 or NaN. Both tables must
    // name every plan explicitly.
    for (const plan of PLANS) {
      expect(
        COLLABORATION_TEAM_PLAN_LIMITS[plan],
        `${plan} is absent from COLLABORATION_TEAM_PLAN_LIMITS`,
      ).toBeTruthy();
      expect(
        typeof getPlanCapabilities(plan).maxOwnedTeams,
        `${plan} has no maxOwnedTeams capability`,
      ).toBe("number");
    }
  });

  it("self-serve entry plans admit ZERO teams on BOTH paths", () => {
    // The original bypass in one sentence: FREE/PAYG must be unable to create
    // a team by ANY route. A non-zero ceiling on either side reopens it.
    for (const plan of ["FREE", "PAYG"] as const) {
      expect(
        getCollaborationTeamPlanLimits(plan).maxTeams,
        `${plan} must not include collaboration teams`,
      ).toBe(0);
      expect(
        getPlanCapabilities(plan).maxOwnedTeams,
        `${plan} must not include owned workspaces`,
      ).toBe(0);
    }
  });

  it("paid plans admit a positive, monotonically non-decreasing ceiling", () => {
    // Guards against a catalog edit that accidentally makes a higher plan
    // strictly worse than a lower one on either path.
    let previous = -1;
    for (const plan of PLANS) {
      const ceiling = getCollaborationTeamPlanLimits(plan).maxTeams;
      expect(
        ceiling,
        `${plan} ceiling ${ceiling} is lower than the preceding plan's ${previous}`,
      ).toBeGreaterThanOrEqual(previous);
      previous = ceiling;
    }
    for (const plan of ["PRO", "TEAM", "ENTERPRISE"] as const) {
      expect(getCollaborationTeamPlanLimits(plan).maxTeams).toBeGreaterThan(0);
    }
  });
});
