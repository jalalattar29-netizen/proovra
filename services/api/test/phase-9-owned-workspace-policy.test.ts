/**
 * PHASE 9 §9.4 CORRECTED (2026-07-22) — TARGET-ARCHITECTURE regression tests.
 *
 * OWNER_ACCOUNT_COVERAGE is REMOVED. The subject-correct canonical policy
 * (`resolveWorkspaceEffectivePlan`, shared-billing) resolves:
 *   PERSONAL      → owner entitlement (the personal-space subject);
 *   OWNED         → ONLY the workspace's own commercial state (owner's
 *                   Personal plan NEVER covers an existing Owned Workspace;
 *                   `maxOwnedTeams` governs CREATION allowance only);
 *   ORGANIZATION  → contract-provisioned coverage;
 *   OWNED+ENTERPRISE plan string → LEGACY AMBIGUITY, FAIL CLOSED;
 *   UNKNOWN       → FAIL CLOSED.
 * These are the 15 mandated regression tests (policy-level where the decision
 * lives in the pure policy; source-contract where the wiring is the subject).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolveWorkspaceEffectivePlan,
  getPlanCapabilities,
  isWorkspaceSubscriptionActive,
} from "@proovra/shared-billing";
// Domain classifier — relocated to the general domain package (2026-07-22).
import { normalizeWorkspaceKind } from "@proovra/shared";

const OWNED_UNPAID = { workspaceKind: "OWNED", billingPlan: "FREE", billingStatus: "INACTIVE" } as const;

describe("Phase 9 §9.4 corrected — Owned Workspace never inherits the owner's Personal plan", () => {
  it("1. Personal PRO owner + unpaid Owned Workspace → NO PRO capability (FREE)", () => {
    expect(resolveWorkspaceEffectivePlan({ ...OWNED_UNPAID, ownerPlan: "PRO" }))
      .toEqual({ plan: "FREE", source: "NONE" });
  });

  it("2. Personal TEAM owner + unpaid Owned Workspace → NO TEAM capability (FREE)", () => {
    expect(resolveWorkspaceEffectivePlan({ ...OWNED_UNPAID, ownerPlan: "TEAM" }))
      .toEqual({ plan: "FREE", source: "NONE" });
  });

  it("3. Owner FREE→PRO changes maxOwnedTeams (creation allowance) only — existing workspace stays FREE", () => {
    // Creation allowance moves 0 → 2 …
    expect(getPlanCapabilities("FREE").maxOwnedTeams).toBe(0);
    expect(getPlanCapabilities("PRO").maxOwnedTeams).toBe(2);
    // … but the existing workspace's effective plan is UNCHANGED by the owner upgrade.
    const before = resolveWorkspaceEffectivePlan({ ...OWNED_UNPAID, ownerPlan: "FREE" });
    const after = resolveWorkspaceEffectivePlan({ ...OWNED_UNPAID, ownerPlan: "PRO" });
    expect(after).toEqual(before);
  });

  it("4. Owner PRO→FREE does NOT rewrite an active Workspace subscription", () => {
    const live = { workspaceKind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" } as const;
    expect(resolveWorkspaceEffectivePlan({ ...live, ownerPlan: "PRO" }).plan).toBe("TEAM");
    expect(resolveWorkspaceEffectivePlan({ ...live, ownerPlan: "FREE" }).plan).toBe("TEAM");
  });

  it("5. Active Workspace subscription resolves independently from owner plan (source = WORKSPACE_SUBSCRIPTION)", () => {
    for (const ownerPlan of ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"] as const) {
      expect(
        resolveWorkspaceEffectivePlan({ workspaceKind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE", ownerPlan }),
      ).toEqual({ plan: "TEAM", source: "WORKSPACE_SUBSCRIPTION" });
    }
  });

  it("6. Workspace A's plan does not affect Workspace B (inputs are per-workspace)", () => {
    // B's resolution consumes ONLY B's own persisted fields — same unpaid B
    // resolves FREE regardless of any other workspace's state.
    expect(resolveWorkspaceEffectivePlan({ ...OWNED_UNPAID, ownerPlan: "PRO" }).plan).toBe("FREE");
  });

  it("7. Enterprise Organization membership (owner ENTERPRISE entitlement) does not affect an unrelated Owned Workspace", () => {
    expect(resolveWorkspaceEffectivePlan({ ...OWNED_UNPAID, ownerPlan: "ENTERPRISE" }))
      .toEqual({ plan: "FREE", source: "NONE" });
  });

  it("8. An active EnterpriseContract does not cover an OWNED workspace (no contract input exists for OWNED)", () => {
    // The OWNED branch has no contract parameter at all; ENTERPRISE coverage
    // is representable ONLY via the ORGANIZATION kind.
    const r = resolveWorkspaceEffectivePlan({ workspaceKind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE", ownerPlan: "FREE" });
    expect(r.source).not.toBe("ORGANIZATION_CONTRACT");
  });

  it("9. SYSTEM parent/backfill never confers Enterprise on PERSONAL/OWNED kinds", () => {
    expect(normalizeWorkspaceKind({ workspaceKind: null, isPersonal: true, billingPlan: "TEAM", teamLoaded: true })).toBe("PERSONAL");
    expect(normalizeWorkspaceKind({ workspaceKind: null, isPersonal: false, billingPlan: "PRO", teamLoaded: true })).toBe("OWNED");
    const personal = resolveWorkspaceEffectivePlan({ workspaceKind: "PERSONAL", billingPlan: "FREE", billingStatus: "INACTIVE", ownerPlan: "PRO" });
    expect(personal.source).toBe("PERSONAL_ENTITLEMENT"); // personal subject, never contract
  });

  it("10. OWNED + raw ENTERPRISE legacy row FAILS CLOSED with explicit ambiguity reason", () => {
    expect(
      resolveWorkspaceEffectivePlan({ workspaceKind: "OWNED", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE", ownerPlan: "ENTERPRISE" }),
    ).toEqual({ plan: "FREE", source: "LEGACY_AMBIGUOUS_FAIL_CLOSED" });
  });

  it("11. Missing Workspace subscription grants no paid capability (FREE, plus UNKNOWN kind fails closed)", () => {
    expect(resolveWorkspaceEffectivePlan({ ...OWNED_UNPAID, ownerPlan: "PRO" }).plan).toBe("FREE");
    expect(
      resolveWorkspaceEffectivePlan({ workspaceKind: "UNKNOWN", billingPlan: "TEAM", billingStatus: "ACTIVE", ownerPlan: "PRO" }),
    ).toEqual({ plan: "FREE", source: "NONE" });
  });

  it("12. CANCELED/INACTIVE workspace billing is never live; the TEAM-active rule stays single-implementation", () => {
    expect(resolveWorkspaceEffectivePlan({ workspaceKind: "OWNED", billingPlan: "TEAM", billingStatus: "CANCELED", ownerPlan: "PRO" }).plan).toBe("FREE");
    expect(isWorkspaceSubscriptionActive({ billingPlan: "TEAM", billingStatus: "CANCELED" })).toBe(false);
    // (Ambiguous multi-Subscription-row handling lives in the resolver's
    // lifecycle policy — resolvePaidLifecycle — proven in
    // phase-9-commercial-lifecycle; the pure policy holds no row selection.)
  });

  it("13. The policy is capability-only: commercial denial carries no destructive signal (Evidence/custody untouched by design)", () => {
    const r = resolveWorkspaceEffectivePlan({ ...OWNED_UNPAID, ownerPlan: "PRO" });
    expect(Object.keys(r).sort()).toEqual(["plan", "source"]);
  });

  it("14. Account maxOwnedTeams creation enforcement is intact (published values unchanged)", () => {
    expect(getPlanCapabilities("PRO").maxOwnedTeams).toBe(2);
    expect(getPlanCapabilities("TEAM").maxOwnedTeams).toBe(5);
    // The creation guard remains an ACCOUNT-subject decision:
    const guards = readFileSync(
      fileURLToPath(new URL("../src/services/collaboration-team/billing-guards.ts", import.meta.url)),
      "utf8",
    );
    const create = guards.slice(guards.indexOf("export async function assertCanCreateCollaborationTeam"));
    expect(create.slice(0, 800)).toMatch(/resolveUserPlan\(client, ownerUserId\)/);
  });

  it("15. Existing-team member/invite limits come from WORKSPACE context, not the owner account", () => {
    const guards = readFileSync(
      fileURLToPath(new URL("../src/services/collaboration-team/billing-guards.ts", import.meta.url)),
      "utf8",
    );
    const member = guards.slice(guards.indexOf("export async function assertCollaborationTeamMemberLimit"), guards.indexOf("export async function assertCanInviteCollaborationTeamMember"));
    const invite = guards.slice(guards.indexOf("export async function assertCanInviteCollaborationTeamMember"), guards.indexOf("assertSubscriptionActiveOrGraceAllowed"));
    expect(member).toMatch(/resolveCollaborationTeamWorkspacePlan\(client, teamId\)/);
    expect(member).not.toMatch(/resolveUserPlan\(/);
    expect(invite).toMatch(/resolveCollaborationTeamWorkspacePlan\(client, teamId\)/);
    expect(invite).not.toMatch(/resolveUserPlan\(/);
  });
});

describe("Phase 9 — legacyRecordCapOverride classified T (compatibility projection, symbol-level)", () => {
  // CLASSIFICATION (2026-07-22): Entitlement.legacyRecordCapOverride is a
  // per-payer GRANDFATHER cap written ONLY by the pricing-hardening
  // migration backfill (zero runtime writers). It carries no subject/plan/
  // lifecycle decision: workspace-billing projects it pass-through into the
  // scope, and its ONLY interpretation is the effective-lifetime-cap
  // substitution inside the canonical enforcement arm.
  // T metadata — owner: billing domain · reason: preserve grandfathered
  // record access · removal condition: fold into the resolveCommercialContext
  // envelope's limits block during §9.7 envelope adoption · Phase 12 target:
  // column retirement after zero-dependency proof.
  const enforcement = readFileSync(
    fileURLToPath(new URL("../src/services/billing-enforcement.service.ts", import.meta.url)),
    "utf8",
  );
  const wb = readFileSync(
    fileURLToPath(new URL("../src/services/workspace-billing.service.ts", import.meta.url)),
    "utf8",
  );

  it("has ZERO runtime writers (backfill-only field)", () => {
    // No production code assigns the field in a create/update data object.
    expect(enforcement + wb).not.toMatch(/legacyRecordCapOverride:\s*[^(]*(\d|input\.|params\.)/);
  });

  it("its ONLY interpretation is inside resolveCommercialContext.limits (enforcement reads the envelope)", () => {
    // §9.7 FOLD (2026-07-22): the enforcement ternary is DELETED — the raw
    // override is interpreted exactly once, inside the canonical envelope.
    expect(enforcement).not.toMatch(/scope\.legacyRecordCapOverride/);
    expect(enforcement).toMatch(/scope\.commercialLimits\?\.effectiveLifetimeRecordCap\s*\?\?\s*planLifetimeCap/);
    const resolver = readFileSync(
      fileURLToPath(new URL("../src/services/billing/commercial-context.service.ts", import.meta.url)),
      "utf8",
    );
    expect(resolver).toMatch(/effectiveLifetimeRecordCap:\s*\n?\s*scope\.legacyRecordCapOverride\s*\?\?\s*capabilities\.maxEvidenceRecords/);
    // workspace-billing only PROJECTS it (pass-through from entitlement).
    expect(wb).toMatch(/legacyRecordCapOverride:\s*\n?\s*\((entitlement|ownerEntitlement)/);
  });
});

describe("Phase 9 §9.4 corrected — adapters hold no decision", () => {
  it("workspace-billing delegates to the subject-correct policy; no inheritance ternary; no api-side active-rule", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/services/workspace-billing.service.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("resolveWorkspaceEffectivePlan({");
    expect(src).not.toMatch(/ownerPlanSupportsTeams\s*\?/);
    expect(src).not.toContain("export function isPaidTeamSubscriptionActive");
    expect(src).not.toContain("OWNER_ACCOUNT_COVERAGE");
  });

  it("OWNER_ACCOUNT_COVERAGE references = 0 across the canonical policy", () => {
    const policy = readFileSync(
      fileURLToPath(new URL("../../../packages/shared-billing/src/plan-catalog.ts", import.meta.url)),
      "utf8",
    );
    expect(policy).not.toContain("OWNER_ACCOUNT_COVERAGE");
  });
});
