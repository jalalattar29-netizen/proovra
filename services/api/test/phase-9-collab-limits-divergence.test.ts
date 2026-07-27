/**
 * PHASE 9 STEP 5 fold-prep (2026-07-22) — divergence guard between the
 * PARALLEL `COLLABORATION_TEAM_PLAN_LIMITS` table (packages/shared) and the
 * canonical `getPlanCapabilities` vocabulary (packages/shared-billing).
 *
 * `COLLABORATION_TEAM_PLAN_LIMITS` is class E (UNRESOLVED_DECISION): it still
 * directly decides team-creation / member / invite capacity in billing-guards.
 * The fold (STEP 5 remaining item 4) will make it a zero-decision adapter over
 * the canonical capabilities and delete the parallel numbers. UNTIL then, this
 * test LOCKS the two sources to identical values so they cannot silently
 * diverge — a change to either table without the other fails here. It also
 * documents the exact fold mapping:
 *
 *   COLLABORATION_TEAM_PLAN_LIMITS.maxTeams          ≡ caps.maxOwnedTeams
 *   COLLABORATION_TEAM_PLAN_LIMITS.maxMembersPerTeam ≡ caps.maxMembersPerTeam
 *   maxPendingInvitesPerTeam / maxInvitesPer24h      → abuse rails NOT yet in
 *       canonical caps; the fold must add them to PlanCapabilities.
 */

import { describe, it, expect } from "vitest";
import { COLLABORATION_TEAM_PLAN_LIMITS } from "@proovra/shared-billing";
import { getPlanCapabilities, type PlanType } from "@proovra/shared-billing";

const PLANS: PlanType[] = ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"];

describe("Phase 9 — collaboration limits ≡ canonical capabilities (fold divergence guard)", () => {
  it("maxTeams matches canonical maxOwnedTeams for every plan", () => {
    for (const plan of PLANS) {
      const table = COLLABORATION_TEAM_PLAN_LIMITS[plan];
      const caps = getPlanCapabilities(plan);
      expect(table.maxTeams, `${plan}.maxTeams vs caps.maxOwnedTeams`).toBe(caps.maxOwnedTeams);
    }
  });

  it("maxMembersPerTeam matches canonical maxMembersPerTeam for every plan", () => {
    for (const plan of PLANS) {
      const table = COLLABORATION_TEAM_PLAN_LIMITS[plan];
      const caps = getPlanCapabilities(plan);
      expect(table.maxMembersPerTeam, `${plan}.maxMembersPerTeam`).toBe(caps.maxMembersPerTeam);
    }
  });

  it("documents the abuse-rail fields the fold must add to canonical caps", () => {
    // These two fields have no canonical home yet. The fold (STEP 5 item 4)
    // must add them to PlanCapabilities; this assertion pins that they exist
    // in the table so the fold cannot drop them.
    for (const plan of PLANS) {
      const table = COLLABORATION_TEAM_PLAN_LIMITS[plan];
      expect(typeof table.maxPendingInvitesPerTeam, `${plan}.maxPendingInvitesPerTeam`).toBe("number");
      expect(typeof table.maxInvitesPer24h, `${plan}.maxInvitesPer24h`).toBe("number");
    }
  });
});
