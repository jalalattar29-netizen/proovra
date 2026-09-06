/**
 * Phase 2 blocker 2 — TEAM is a subscription plan, NOT an enterprise
 * workspace (locked product model).
 *
 * Proves, at the plan-capability layer:
 *   1. FREE / PAYG / PRO / TEAM unlock ZERO enterprise features
 *      (SSO/SCIM, MFA enforcement, access reviews, session governance,
 *      legal hold, retention policy, org audit logs, object lock).
 *   2. ENTERPRISE unlocks ALL of them.
 *   3. TEAM keeps its correct (non-enterprise) plan features intact.
 *
 * The surface-tier half of the model (ENTERPRISE-tier routes hidden from
 * FREE/PAYG/PRO/TEAM, visible to ENTERPRISE) is proven separately in the
 * frontend suite `apps/web/__tests__/enterprise-tier-gating.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  getPlanCapabilities,
  type EnterpriseFeatureFlags,
  type PlanType,
} from "@proovra/shared-billing";

const ENTERPRISE_FEATURE_KEYS: Array<keyof EnterpriseFeatureFlags> = [
  "ssoScim",
  "mfaEnforcement",
  "accessReviews",
  "sessionGovernance",
  "legalHold",
  "retentionPolicy",
  "organizationAuditLogs",
  "objectLock",
];

const NON_ENTERPRISE_PLANS: PlanType[] = ["FREE", "PAYG", "PRO", "TEAM"];

describe("Phase 2 — TEAM is not enterprise (plan capabilities)", () => {
  it("FREE / PAYG / PRO / TEAM unlock NO enterprise features", () => {
    for (const plan of NON_ENTERPRISE_PLANS) {
      const feats = getPlanCapabilities(plan).enterpriseFeatures;
      for (const key of ENTERPRISE_FEATURE_KEYS) {
        expect(
          feats[key],
          `${plan}.enterpriseFeatures.${key} must be false`,
        ).toBe(false);
      }
    }
  });

  it("ENTERPRISE unlocks EVERY enterprise feature", () => {
    const feats = getPlanCapabilities("ENTERPRISE").enterpriseFeatures;
    for (const key of ENTERPRISE_FEATURE_KEYS) {
      expect(feats[key], `ENTERPRISE.enterpriseFeatures.${key}`).toBe(true);
    }
  });

  it("TEAM keeps its correct (non-enterprise) plan features", () => {
    const team = getPlanCapabilities("TEAM");
    // TEAM is a real paid collaboration plan — these stay true.
    expect(team.reportsIncluded).toBe(true);
    expect(team.verificationPackageIncluded).toBe(true);
    expect(team.allowsSharedWorkspace).toBe(true);
    expect(team.includedSeats).toBe(5);
    // APPROVED CHANGE — TEAM seats 10 people, PRO seats 5. The two tiers used
    // to carry the same seat number, which meant the £79 tier bought no
    // additional people over the £19 one.
    expect(team.maxWorkspaceSeats).toBe(10);
    // ...but never governance/SSO/SCIM.
    expect(team.enterpriseFeatures.ssoScim).toBe(false);
    expect(team.enterpriseFeatures.legalHold).toBe(false);
    expect(team.enterpriseFeatures.retentionPolicy).toBe(false);
  });

  it("only ENTERPRISE is an enterprise workspace key (source lock)", () => {
    // PHASE 0 (2026-08-22) — the invariant is unchanged; its home moved.
    //
    // `ENTERPRISE_PLAN_KEYS` used to live in platform-context.service.ts and
    // was the ONLY enterprise signal. It is now `LEGACY_ENTERPRISE_PLAN_KEYS`
    // inside the canonical enterprise authority, where it serves solely as
    // the bounded compatibility fallback for an ORGANIZATION workspace that
    // has no EnterpriseContract row yet.
    //
    // What this test protects is what it always protected: TEAM / PRO /
    // FREE / PAYG must never be read as "enterprise".
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/platform-context/enterprise-authority.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const body = src.match(
      /LEGACY_ENTERPRISE_PLAN_KEYS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
    )?.[1];
    expect(body, "LEGACY_ENTERPRISE_PLAN_KEYS must exist").toBeTruthy();
    expect(body!).toContain('"ENTERPRISE"');
    expect(body!).not.toContain('"TEAM"');
    expect(body!).not.toContain('"PRO"');
    expect(body!).not.toContain('"FREE"');
    expect(body!).not.toContain('"PAYG"');
  });

  it("the plan string is no longer the enterprise authority (Phase 0)", () => {
    // The builder must not decide enterprise from a plan comparison any
    // more — it delegates to the contract-backed resolver.
    const svc = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/platform-context/platform-context.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(svc).toContain("resolveEnterpriseAuthority");
    expect(svc).toContain("enterprise.isEnterpriseCustomer");
    // The old local constant must be gone, so a future edit cannot
    // resurrect the plan-string path beside the contract one.
    expect(svc).not.toMatch(/const ENTERPRISE_PLAN_KEYS/);
  });
});
