/**
 * PROOVRA Phase 4A Enterprise Closure — proves every closure gap is fixed.
 *
 * Sixteen sections, each pinning a closure work-stream:
 *
 *   1. Shared closure contracts
 *   2. Prisma + closure migration
 *   3. Service module surface
 *   4. Delegated tier enforcement applied to routes
 *   5. Trust mutation audit emissions
 *   6. Policy evaluation behaviour
 *   7. Access review REVOKED propagates
 *   8. Cross-org accept calls portal
 *   9. Status probes
 *  10. Department scope
 *  11. Security claim drift detection
 *  12. Trust article drift detection
 *  13. Verification package wires Phase 4A manifests
 *  14. Audit federator surfaces trust + governance lifecycle
 *  15. Governance dashboard reality
 *  16. UI completion
 *
 * Follows the pattern in `phase-4a-trust-and-governance.test.ts` — grep-style
 * source assertions for wire-up + lightweight Prisma stubs for behaviour.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  ACCESS_REVIEW_GRANT_KINDS,
  DEPARTMENT_MEMBERSHIP_ROLES,
  POLICY_EVALUATION_DECISIONS,
  SECURITY_CONTROL_CONFIDENCE,
  STATUS_PROBE_VERDICTS,
  TRUST_ARTICLE_DRIFT_STATES,
  TRUST_LIFECYCLE_CATEGORIES,
  TRUST_LIFECYCLE_CODES,
  classifyTrustLifecycleCategory,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSrc(relPath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relPath, import.meta.url)),
    "utf8",
  );
}

function srcExists(relPath: string): boolean {
  return existsSync(fileURLToPath(new URL(relPath, import.meta.url)));
}

// ---------------------------------------------------------------------------
// 1. Shared closure contracts
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — shared contracts", () => {
  it("TRUST_ARTICLE_DRIFT_STATES is bounded (CURRENT / STALE / NEEDS_REVIEW)", () => {
    expect([...TRUST_ARTICLE_DRIFT_STATES].sort()).toEqual(
      ["CURRENT", "NEEDS_REVIEW", "STALE"],
    );
  });

  it("ACCESS_REVIEW_GRANT_KINDS covers the propagation engine routes", () => {
    expect([...ACCESS_REVIEW_GRANT_KINDS].sort()).toEqual(
      ["DELEGATED_ADMIN", "DEPARTMENT_MEMBERSHIP", "EXTERNAL_REVIEW"],
    );
  });

  it("POLICY_EVALUATION_DECISIONS is bounded (ALLOW / WARN / BLOCK)", () => {
    expect([...POLICY_EVALUATION_DECISIONS].sort()).toEqual(
      ["ALLOW", "BLOCK", "WARN"],
    );
  });

  it("STATUS_PROBE_VERDICTS includes UNKNOWN as honest default", () => {
    expect([...STATUS_PROBE_VERDICTS].sort()).toEqual(
      ["DEGRADED", "DOWN", "OPERATIONAL", "UNKNOWN"],
    );
  });

  it("SECURITY_CONTROL_CONFIDENCE is bounded", () => {
    expect([...SECURITY_CONTROL_CONFIDENCE].sort()).toEqual(
      ["IMPLEMENTED", "PARTIAL", "PLANNED", "UNAVAILABLE"],
    );
  });

  it("DEPARTMENT_MEMBERSHIP_ROLES is bounded (MEMBER / LEAD / ADMIN)", () => {
    expect([...DEPARTMENT_MEMBERSHIP_ROLES].sort()).toEqual(
      ["ADMIN", "LEAD", "MEMBER"],
    );
  });

  it("TRUST_LIFECYCLE_CODES covers every Phase 4A audit subject", () => {
    expect(TRUST_LIFECYCLE_CODES.length).toBeGreaterThanOrEqual(20);
    for (const c of [
      "TRUST_ARTICLE_CREATED",
      "TRUST_ARTICLE_UPDATED",
      "TRUST_ARTICLE_PUBLISHED",
      "TRUST_ARTICLE_MARKED_STALE",
      "SUBPROCESSOR_CREATED",
      "STATUS_INCIDENT_CREATED",
      "ACCESS_REVIEW_DECIDED",
      "ACCESS_REVIEW_GRANT_REVOKED",
      "CROSS_ORG_REVIEW_CREATED",
      "DELEGATED_ADMIN_GRANTED",
      "DEPARTMENT_CREATED",
      "POLICY_EVALUATED",
      "POLICY_BLOCK",
      "POLICY_VIOLATION",
    ]) {
      expect(TRUST_LIFECYCLE_CODES).toContain(c);
    }
  });

  it("TRUST_LIFECYCLE_CATEGORIES is the disjoint 2-tuple", () => {
    expect([...TRUST_LIFECYCLE_CATEGORIES].sort()).toEqual(
      ["GOVERNANCE_LIFECYCLE", "TRUST_LIFECYCLE"],
    );
  });

  it("classifyTrustLifecycleCategory routes codes into the right bucket", () => {
    expect(classifyTrustLifecycleCategory("TRUST_ARTICLE_CREATED")).toBe(
      "TRUST_LIFECYCLE",
    );
    expect(classifyTrustLifecycleCategory("SUBPROCESSOR_CREATED")).toBe(
      "TRUST_LIFECYCLE",
    );
    expect(classifyTrustLifecycleCategory("STATUS_INCIDENT_CREATED")).toBe(
      "TRUST_LIFECYCLE",
    );
    expect(classifyTrustLifecycleCategory("ACCESS_REVIEW_DECIDED")).toBe(
      "GOVERNANCE_LIFECYCLE",
    );
    expect(classifyTrustLifecycleCategory("DEPARTMENT_CREATED")).toBe(
      "GOVERNANCE_LIFECYCLE",
    );
    expect(classifyTrustLifecycleCategory("POLICY_VIOLATION")).toBe(
      "GOVERNANCE_LIFECYCLE",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Prisma + closure migration
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — Prisma + closure migration", () => {
  const schema = readSrc("../prisma/schema.prisma");

  it("schema declares the two new closure models", () => {
    expect(schema).toContain("model DepartmentMembership ");
    expect(schema).toContain("model SecurityClaimCheck ");
  });

  it("Evidence model carries the optional departmentId column", () => {
    expect(schema).toMatch(/departmentId\s+String\?\s+@map\("department_id"\)/);
  });

  it("TrustCenterArticle declares driftState", () => {
    expect(schema).toContain("driftState");
    expect(schema).toContain("drift_state");
  });

  it("closure migration is Phase O-Final compliant", () => {
    const sql = readSrc(
      "../prisma/migrations/20261225000000_phase_4a_enterprise_closure/migration.sql",
    );
    // New tables → plain CREATE TABLE (no IF NOT EXISTS).
    expect(sql).toContain("CREATE TABLE \"department_memberships\"");
    expect(sql).toContain("CREATE TABLE \"security_claim_checks\"");
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS");
    // Additive columns must use ADD COLUMN IF NOT EXISTS.
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS \"department_id\"");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS \"drift_state\"");
    // Every CREATE INDEX must be inside a DO/information_schema guard.
    const guardCount = sql.match(/DO \$\$/g)?.length ?? 0;
    expect(guardCount).toBeGreaterThanOrEqual(3);
    expect(sql).toContain("information_schema.columns");
  });
});

// ---------------------------------------------------------------------------
// 3. Service module surface
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — service module surface", () => {
  it("require-delegated-tier middleware exposes the helpers", async () => {
    const m = await import("../src/middleware/require-delegated-tier.js");
    expect(typeof m.requireDelegatedTier).toBe("function");
    expect(typeof m.requireDelegatedTierAny).toBe("function");
  });

  it("department-membership service exposes grant / revoke / list", async () => {
    const m = await import(
      "../src/services/governance/department-membership.service.js"
    );
    expect(typeof m.grantDepartmentMembership).toBe("function");
    expect(typeof m.revokeDepartmentMembership).toBe("function");
    expect(typeof m.listDepartmentMemberships).toBe("function");
  });

  it("department-scope service exposes resolve / where / assert helpers", async () => {
    const m = await import(
      "../src/services/governance/department-scope.service.js"
    );
    expect(typeof m.resolveUserDepartmentScope).toBe("function");
    expect(typeof m.buildDepartmentScopeWhere).toBe("function");
    expect(typeof m.assertDepartmentAccess).toBe("function");
  });

  it("policy-evaluation service exposes the six evaluators", async () => {
    const m = await import(
      "../src/services/governance/policy-evaluation.service.js"
    );
    expect(typeof m.evaluateSecurityPolicy).toBe("function");
    expect(typeof m.evaluateRetentionPolicy).toBe("function");
    expect(typeof m.evaluateReviewPolicy).toBe("function");
    expect(typeof m.evaluateIntelligencePolicy).toBe("function");
    expect(typeof m.evaluateVerificationPolicy).toBe("function");
    expect(typeof m.evaluateRedactionPolicy).toBe("function");
  });

  it("status-probes service exposes the seven probes + fan-out", async () => {
    const m = await import("../src/services/trust/status-probes.service.js");
    expect(typeof m.probeApi).toBe("function");
    expect(typeof m.probeDatabase).toBe("function");
    expect(typeof m.probeRedis).toBe("function");
    expect(typeof m.probeQueue).toBe("function");
    expect(typeof m.probeStorage).toBe("function");
    expect(typeof m.probeKms).toBe("function");
    expect(typeof m.probeWorker).toBe("function");
    expect(typeof m.probeAll).toBe("function");
  });

  it("security-claim-check service exposes run + list", async () => {
    const m = await import(
      "../src/services/trust/security-claim-check.service.js"
    );
    expect(typeof m.runSecurityClaimChecks).toBe("function");
    expect(typeof m.listSecurityClaimChecks).toBe("function");
  });

  it("trust-drift service exposes scan + list + needs-review", async () => {
    const m = await import("../src/services/trust/trust-drift.service.js");
    expect(typeof m.runTrustArticleDriftScan).toBe("function");
    expect(typeof m.listStaleTrustArticles).toBe("function");
    expect(typeof m.markArticleNeedsReview).toBe("function");
  });

  it("trust-and-governance-audit service exposes every subject emitter", async () => {
    const m = await import(
      "../src/services/trust/trust-and-governance-audit.service.js"
    );
    expect(typeof m.emitTrustEvent).toBe("function");
    expect(typeof m.emitTrustArticleEvent).toBe("function");
    expect(typeof m.emitSubprocessorEvent).toBe("function");
    expect(typeof m.emitStatusIncidentEvent).toBe("function");
    expect(typeof m.emitAccessReviewDecisionEvent).toBe("function");
    expect(typeof m.emitCrossOrgEvent).toBe("function");
    expect(typeof m.emitDelegatedAdminEvent).toBe("function");
    expect(typeof m.emitDepartmentEvent).toBe("function");
  });

  it("access-review-escalation service exposes escalate + list", async () => {
    const m = await import(
      "../src/services/governance/access-review-escalation.service.js"
    );
    expect(typeof m.escalateAccessReviewItem).toBe("function");
    expect(typeof m.listEscalatedItems).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 4. Delegated tier enforcement applied to routes
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — delegated tier enforcement on routes", () => {
  const src = readSrc("../src/routes/trust-and-governance.routes.ts");

  it("middleware factories are imported", () => {
    expect(src).toContain("requireDelegatedTier");
    expect(src).toContain("requireDelegatedTierAny");
    expect(src).toContain("require-delegated-tier");
  });

  it("trust article + subprocessor + seed POSTs are tier-gated", () => {
    expect(src).toMatch(/"\/v1\/trust\/articles"[\s\S]{0,400}requireDelegatedTierAny/);
    expect(src).toMatch(
      /"\/v1\/trust\/articles\/seed"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/trust\/subprocessors"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/trust\/subprocessors\/seed"[\s\S]{0,400}requireDelegatedTierAny/,
    );
  });

  it("status mutations are tier-gated", () => {
    expect(src).toMatch(
      /"\/v1\/trust\/status\/incidents"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/trust\/status\/incidents\/:id\/updates"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/trust\/status\/maintenance"[\s\S]{0,400}requireDelegatedTierAny/,
    );
  });

  it("department + delegated-admin + membership mutations are tier-gated", () => {
    expect(src).toMatch(
      /"\/v1\/governance\/departments"[\s\S]{0,400}requireDelegatedTier\("ORG_ADMIN"\)/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/departments\/:id\/archive"[\s\S]{0,400}requireDelegatedTier\("ORG_ADMIN"\)/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/delegated-admin\/:id\/revoke"[\s\S]{0,400}requireDelegatedTier\("ORG_ADMIN"\)/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/departments\/:id\/memberships"[\s\S]{0,400}requireDelegatedTier\("DEPARTMENT_ADMIN"\)/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/departments\/memberships\/:id\/revoke"[\s\S]{0,400}requireDelegatedTier\("DEPARTMENT_ADMIN"\)/,
    );
  });

  it("policy + access-review + cross-org mutations are tier-gated", () => {
    expect(src).toMatch(
      /"\/v1\/governance\/policies"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/policies\/:id\/activate"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/policies\/:id\/deprecate"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/policies\/:id\/assignments"[\s\S]{0,400}requireDelegatedTier\("ORG_ADMIN"\)/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/access-reviews\/campaigns"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/access-reviews\/items\/:id\/decision"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/cross-org-review"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/governance\/cross-org-review\/:id\/accept"[\s\S]{0,400}requireDelegatedTier\("ORG_ADMIN"\)/,
    );
  });

  it("drift + security-claims scan routes are tier-gated", () => {
    expect(src).toMatch(
      /"\/v1\/trust\/drift\/scan"[\s\S]{0,400}requireDelegatedTierAny/,
    );
    expect(src).toMatch(
      /"\/v1\/trust\/security-claims\/scan"[\s\S]{0,400}requireDelegatedTierAny/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Trust mutation audit emissions
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — trust mutation audit emissions", () => {
  it("trust-center.service emits emitTrustArticleEvent in upsertTrustArticle", () => {
    const src = readSrc("../src/services/trust/trust-center.service.ts");
    expect(src).toContain("emitTrustArticleEvent");
    expect(src).toContain("TRUST_ARTICLE_CREATED");
    expect(src).toContain("TRUST_ARTICLE_UPDATED");
    expect(src).toContain("TRUST_ARTICLE_PUBLISHED");
  });

  it("subprocessor.service emits emitSubprocessorEvent", () => {
    const src = readSrc("../src/services/trust/subprocessor.service.ts");
    expect(src).toContain("emitSubprocessorEvent");
  });

  it("status-page.service emits emitStatusIncidentEvent", () => {
    const src = readSrc("../src/services/trust/status-page.service.ts");
    expect(src).toContain("emitStatusIncidentEvent");
  });

  it("cross-org-review.service emits emitCrossOrgEvent", () => {
    const src = readSrc(
      "../src/services/governance/cross-org-review.service.ts",
    );
    expect(src).toContain("emitCrossOrgEvent");
  });

  it("delegated-admin.service emits emitDelegatedAdminEvent", () => {
    const src = readSrc(
      "../src/services/governance/delegated-admin.service.ts",
    );
    expect(src).toContain("emitDelegatedAdminEvent");
  });

  it("department.service emits emitDepartmentEvent", () => {
    const src = readSrc("../src/services/governance/department.service.ts");
    expect(src).toContain("emitDepartmentEvent");
  });

  it("access-review.service emits emitAccessReviewDecisionEvent", () => {
    const src = readSrc(
      "../src/services/governance/access-review.service.ts",
    );
    expect(src).toContain("emitAccessReviewDecisionEvent");
  });
});

// ---------------------------------------------------------------------------
// 6. Policy evaluation behaviour
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — policy evaluation behaviour", () => {
  function buildPolicyAssignment(opts: {
    kind: string;
    enforcementMode: string;
    rule: Record<string, unknown>;
    scope?: string;
    scopeTargetId?: string;
  }) {
    return {
      scope: opts.scope ?? "WORKSPACE",
      scopeTargetId: opts.scopeTargetId ?? "ws-1",
      isOverride: false,
      policy: {
        id: "p-1",
        kind: opts.kind,
        slug: "rule-1",
        name: "rule-1",
        summary: "",
        state: "ACTIVE",
        enforcementMode: opts.enforcementMode,
        rule: opts.rule,
        version: 1,
        createdByUserId: "u",
        createdAt: new Date(),
      },
    };
  }

  function buildPrismaStub(assignments: ReadonlyArray<unknown>) {
    return {
      governancePolicyAssignment: {
        findMany: async () => assignments,
      },
      governancePolicyAudit: {
        create: async () => ({ id: "audit-1" }),
      },
      evidence: { findFirst: async () => null },
      evidenceLegalHold: { count: async () => 0 },
      qcSample: { findFirst: async () => null },
      workflowReviewDecision: { findMany: async () => [] },
      mediaIntelligenceRecord: { findFirst: async () => null },
      trustCenterArticle: { count: async () => 0 },
    } as never;
  }

  it("evaluateIntelligencePolicy returns BLOCK when disallowedProviders matches + mode=BLOCK", async () => {
    const { evaluateIntelligencePolicy } = await import(
      "../src/services/governance/policy-evaluation.service.js"
    );
    const prismaStub = buildPrismaStub([
      buildPolicyAssignment({
        kind: "INTELLIGENCE",
        enforcementMode: "BLOCK",
        rule: { disallowedProviders: ["OPENAI_ENTITY_EXTRACTION"] },
      }),
    ]);
    const res = await evaluateIntelligencePolicy({
      prisma: prismaStub,
      teamId: "team-1",
      provider: "OPENAI_ENTITY_EXTRACTION",
      operation: "EXTRACT_ENTITIES",
      workspaceId: "ws-1",
    });
    expect(res.decision).toBe("BLOCK");
    expect(res.reason).toBe("provider_disallowed");
  });

  it("evaluateSecurityPolicy returns BLOCK when requireMfa=true and mfaSatisfied=false", async () => {
    const { evaluateSecurityPolicy } = await import(
      "../src/services/governance/policy-evaluation.service.js"
    );
    const prismaStub = buildPrismaStub([
      buildPolicyAssignment({
        kind: "SECURITY",
        enforcementMode: "BLOCK",
        rule: { requireMfa: true },
      }),
    ]);
    const res = await evaluateSecurityPolicy({
      prisma: prismaStub,
      teamId: "team-1",
      userId: "user-1",
      action: "EXPORT",
      mfaSatisfied: false,
      workspaceId: "ws-1",
    });
    expect(res.decision).toBe("BLOCK");
    expect(res.reason).toBe("mfa_required");
  });

  it("evaluateSecurityPolicy returns ALLOW when mfaSatisfied=true", async () => {
    const { evaluateSecurityPolicy } = await import(
      "../src/services/governance/policy-evaluation.service.js"
    );
    const prismaStub = buildPrismaStub([
      buildPolicyAssignment({
        kind: "SECURITY",
        enforcementMode: "BLOCK",
        rule: { requireMfa: true },
      }),
    ]);
    const res = await evaluateSecurityPolicy({
      prisma: prismaStub,
      teamId: "team-1",
      userId: "user-1",
      action: "EXPORT",
      mfaSatisfied: true,
      workspaceId: "ws-1",
    });
    expect(res.decision).toBe("ALLOW");
  });
});

// ---------------------------------------------------------------------------
// 7. Access review REVOKED propagates
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — access review REVOKED propagates", () => {
  it("REVOKED on a delegated_admin grant calls revokeDelegatedAdmin", async () => {
    const delegated = await import(
      "../src/services/governance/delegated-admin.service.js"
    );
    const revokeSpy = vi
      .spyOn(delegated, "revokeDelegatedAdmin")
      .mockResolvedValue({ ok: true } as never);

    const { recordItemDecision } = await import(
      "../src/services/governance/access-review.service.js"
    );

    const grantUuid = "11111111-1111-1111-1111-111111111111";
    const prismaStub = {
      accessReviewItem: {
        findFirst: async () => ({
          id: "item-1",
          decision: "PENDING",
          grantRef: `delegated_admin:${grantUuid}`,
        }),
        update: async () => ({ id: "item-1" }),
      },
      intelligenceActivityEvent: {
        create: async () => ({ id: "evt-1" }),
      },
    } as never;

    const res = await recordItemDecision({
      prisma: prismaStub,
      teamId: "team-1",
      itemId: "item-1",
      decision: "REVOKED",
      reviewerUserId: "user-1",
      notes: null,
    });
    expect(res.ok).toBe(true);
    expect(revokeSpy).toHaveBeenCalled();
    const callArgs = revokeSpy.mock.calls[0]?.[0] as {
      grantId?: string;
    };
    expect(callArgs?.grantId).toBe(grantUuid);
    revokeSpy.mockRestore();
  });

  it("REVOKED on an external_review grant calls revokeInvitation", async () => {
    const invMod = await import(
      "../src/services/external-review/portal-invitation.service.js"
    );
    const invSpy = vi
      .spyOn(invMod, "revokeInvitation")
      .mockResolvedValue({ ok: true } as never);

    const { recordItemDecision } = await import(
      "../src/services/governance/access-review.service.js"
    );

    const grantUuid = "22222222-2222-2222-2222-222222222222";
    const prismaStub = {
      accessReviewItem: {
        findFirst: async () => ({
          id: "item-2",
          decision: "PENDING",
          grantRef: `external_review:${grantUuid}`,
        }),
        update: async () => ({ id: "item-2" }),
      },
      intelligenceActivityEvent: {
        create: async () => ({ id: "evt-2" }),
      },
    } as never;

    const res = await recordItemDecision({
      prisma: prismaStub,
      teamId: "team-1",
      itemId: "item-2",
      decision: "REVOKED",
      reviewerUserId: "user-1",
      notes: null,
    });
    expect(res.ok).toBe(true);
    expect(invSpy).toHaveBeenCalled();
    const callArgs = invSpy.mock.calls[0]?.[0] as { grantId?: string };
    expect(callArgs?.grantId).toBe(grantUuid);
    invSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 8. Cross-org accept calls the portal
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — cross-org accept calls portal", () => {
  it("acceptCrossOrgReview calls issueInvitation when externalReviewGrantId is null", async () => {
    const invMod = await import(
      "../src/services/external-review/portal-invitation.service.js"
    );
    const issueSpy = vi
      .spyOn(invMod, "issueInvitation")
      .mockResolvedValue({ ok: true, grantId: "portal-grant-1" } as never);

    const { acceptCrossOrgReview } = await import(
      "../src/services/governance/cross-org-review.service.js"
    );

    const prismaStub = {
      crossOrgReviewGrant: {
        findFirst: async () => ({
          id: "cog-1",
          teamId: "team-1",
          state: "INVITED",
          invitedOrgSlug: "external-org",
          expiresAtUtc: null,
        }),
        update: async () => ({ id: "cog-1" }),
      },
      intelligenceActivityEvent: {
        create: async () => ({ id: "evt-1" }),
      },
    } as never;

    const res = await acceptCrossOrgReview({
      prisma: prismaStub,
      teamId: "team-1",
      grantId: "cog-1",
      acceptingOrganizationId: "org-acc",
      externalReviewGrantId: null,
      actorUserId: "user-1",
    });
    expect(res.ok).toBe(true);
    expect(issueSpy).toHaveBeenCalled();
    issueSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 9. Status probes
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — status probes", () => {
  it("probeApi returns OPERATIONAL with componentKey=API", async () => {
    const { probeApi } = await import(
      "../src/services/trust/status-probes.service.js"
    );
    const r = await probeApi();
    expect(r.componentKey).toBe("API");
    expect(r.verdict).toBe("OPERATIONAL");
    expect(r.source).toBe("INTERNAL");
  });

  it("probeRedis returns UNKNOWN without REDIS_URL", async () => {
    const prior = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const { probeRedis } = await import(
        "../src/services/trust/status-probes.service.js"
      );
      const r = await probeRedis();
      expect(r.verdict).toBe("UNKNOWN");
      expect(r.source).toBe("INTERNAL");
    } finally {
      if (prior !== undefined) process.env.REDIS_URL = prior;
    }
  });

  it("probeStorage returns UNKNOWN without S3_EVIDENCE_BUCKET", async () => {
    const prior = process.env.S3_EVIDENCE_BUCKET;
    delete process.env.S3_EVIDENCE_BUCKET;
    try {
      const { probeStorage } = await import(
        "../src/services/trust/status-probes.service.js"
      );
      const r = await probeStorage();
      expect(r.verdict).toBe("UNKNOWN");
      expect(r.source).toBe("INTERNAL");
    } finally {
      if (prior !== undefined) process.env.S3_EVIDENCE_BUCKET = prior;
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Department scope
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — department scope", () => {
  it("resolveUserDepartmentScope returns unrestricted=true for GLOBAL_ADMIN", async () => {
    const { resolveUserDepartmentScope } = await import(
      "../src/services/governance/department-scope.service.js"
    );
    const prismaStub = {
      team: { findFirst: async () => ({ ownerUserId: "owner-X" }) },
      delegatedAdminGrant: {
        findMany: async () => [
          {
            tier: "GLOBAL_ADMIN",
            organizationId: "org-a",
            departmentId: null,
            workspaceId: null,
            expiresAtUtc: null,
          },
        ],
      },
      departmentMembership: { findMany: async () => [] },
    } as never;
    const envelope = await resolveUserDepartmentScope({
      prisma: prismaStub,
      teamId: "team-1",
      userId: "user-1",
    });
    expect(envelope.unrestricted).toBe(true);
  });

  it("resolveUserDepartmentScope returns unrestricted=false + empty allowed-set when no grants + no memberships", async () => {
    const { resolveUserDepartmentScope } = await import(
      "../src/services/governance/department-scope.service.js"
    );
    const prismaStub = {
      team: { findFirst: async () => ({ ownerUserId: "owner-X" }) },
      delegatedAdminGrant: { findMany: async () => [] },
      departmentMembership: { findMany: async () => [] },
    } as never;
    const envelope = await resolveUserDepartmentScope({
      prisma: prismaStub,
      teamId: "team-1",
      userId: "user-1",
    });
    expect(envelope.unrestricted).toBe(false);
    expect(envelope.allowedDepartmentIds.length).toBe(0);
  });

  it("assertDepartmentAccess: unrestricted envelope is always ok", async () => {
    const { assertDepartmentAccess } = await import(
      "../src/services/governance/department-scope.service.js"
    );
    const res = assertDepartmentAccess(
      {
        teamId: "team-1",
        userId: "user-1",
        unrestricted: true,
        allowedDepartmentIds: [],
      },
      "dept-x",
    );
    expect(res.ok).toBe(true);
  });

  it("assertDepartmentAccess denies DEPARTMENT_FORBIDDEN for an out-of-set department", async () => {
    const { assertDepartmentAccess } = await import(
      "../src/services/governance/department-scope.service.js"
    );
    const res = assertDepartmentAccess(
      {
        teamId: "team-1",
        userId: "user-1",
        unrestricted: false,
        allowedDepartmentIds: ["dept-a"],
      },
      "dept-b",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.denial).toBe("DEPARTMENT_FORBIDDEN");
    }
  });

  it("buildDepartmentScopeWhere returns undefined for unrestricted envelopes", async () => {
    const { buildDepartmentScopeWhere } = await import(
      "../src/services/governance/department-scope.service.js"
    );
    const where = buildDepartmentScopeWhere({
      teamId: "team-1",
      userId: "user-1",
      unrestricted: true,
      allowedDepartmentIds: [],
    });
    expect(where).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Security claim drift detection
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — security claim drift detection", () => {
  it("runSecurityClaimChecks persists one row per SECURITY section + SCIM is UNAVAILABLE", async () => {
    const { runSecurityClaimChecks } = await import(
      "../src/services/trust/security-claim-check.service.js"
    );
    const { SECURITY_SECTIONS } = await import("@proovra/shared");

    const upserted: Array<{
      where: { teamId_controlKey: { teamId: string; controlKey: string } };
    }> = [];
    const prismaStub = {
      trustCenterArticle: {
        findMany: async () => [],
      },
      securityClaimCheck: {
        upsert: async (args: {
          where: { teamId_controlKey: { teamId: string; controlKey: string } };
        }) => {
          upserted.push(args);
          return { id: "row-1" };
        },
      },
    } as never;

    const projections = await runSecurityClaimChecks({
      prisma: prismaStub,
      teamId: "team-1",
      systemUserId: null,
    });

    expect(projections.length).toBe(SECURITY_SECTIONS.length);
    expect(upserted.length).toBe(SECURITY_SECTIONS.length);
    const scim = projections.find((p) => p.controlKey === "SCIM");
    expect(scim).toBeDefined();
    expect(scim?.confidence).toBe("UNAVAILABLE");
    expect(scim?.limitation).toBe("scim_provisioning_via_idp_only");
  });
});

// ---------------------------------------------------------------------------
// 12. Trust article drift detection
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — trust article drift detection", () => {
  it("runTrustArticleDriftScan flips an article with a missing reference to STALE", async () => {
    const { runTrustArticleDriftScan } = await import(
      "../src/services/trust/trust-drift.service.js"
    );

    const updates: Array<{
      where: { id: string };
      data: { driftState?: string };
    }> = [];
    const prismaStub = {
      trustCenterArticle: {
        findMany: async () => [
          {
            id: "art-1",
            kind: "TRUST_CENTER",
            slug: "platform-trust",
            driftState: "CURRENT",
            implementationReferences: [
              "this/path/does/not/exist/phase-4a-closure-test-missing.ts",
            ],
          },
        ],
        update: async (args: {
          where: { id: string };
          data: { driftState?: string };
        }) => {
          updates.push(args);
          return { id: args.where.id };
        },
      },
      intelligenceActivityEvent: {
        create: async () => ({ id: "evt-1" }),
      },
    } as never;

    const res = await runTrustArticleDriftScan({
      prisma: prismaStub,
      teamId: "team-1",
    });
    expect(res.scanned).toBe(1);
    expect(res.stale).toBe(1);
    expect(updates.length).toBe(1);
    expect(updates[0].data.driftState).toBe("STALE");
  });
});

// ---------------------------------------------------------------------------
// 13. Verification package wires Phase 4A manifests
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — verification package wires manifests", () => {
  it("verification-package.ts imports + invokes buildTrustAndGovernanceManifests", () => {
    const src = readSrc(
      "../../worker/src/verification-package.ts",
    );
    expect(src).toContain("buildTrustAndGovernanceManifests");
    expect(src).toContain("verification-package-trust-and-governance");
  });

  it("verification-package-trust-and-governance.ts produces the five Phase 4A manifest paths", () => {
    const src = readSrc(
      "../../worker/src/verification-package-trust-and-governance.ts",
    );
    expect(src).toContain("intelligence/trust-manifest.json");
    expect(src).toContain("intelligence/governance-manifest.json");
    expect(src).toContain("intelligence/methodology-manifest.json");
    expect(src).toContain("intelligence/ai-disclosure-manifest.json");
    expect(src).toContain("intelligence/subprocessor-manifest.json");
  });
});

// ---------------------------------------------------------------------------
// 14. Audit federator surfaces trust + governance lifecycle
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — audit federator surfaces trust + governance lifecycle", () => {
  it("audit-transparency.service handles TRUST_LIFECYCLE and GOVERNANCE_LIFECYCLE", () => {
    const src = readSrc(
      "../src/services/intelligence/audit-transparency.service.ts",
    );
    expect(src).toContain("mapLifecycleCategoryToAudit");
    expect(src).toContain("TRUST_LIFECYCLE");
    expect(src).toContain("GOVERNANCE_LIFECYCLE");
  });
});

// ---------------------------------------------------------------------------
// 15. Governance dashboard reality
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — governance dashboard reality", () => {
  const src = readSrc(
    "../src/services/governance/governance-dashboard.service.ts",
  );

  it("securityHealth is derived from real queries — not a literal { mfaCoveragePct: 0, ... }", () => {
    expect(src).not.toMatch(
      /securityHealth\s*:\s*\{\s*mfaCoveragePct\s*:\s*0\s*,\s*samlEnabled\s*:\s*false\s*,\s*scimEnabled\s*:\s*false\s*\}/,
    );
    expect(src).toContain("mfaCoveragePct");
    // The real derivation reads teamMember + mfaFactor counts.
    expect(src).toContain("teamMember");
    expect(src).toContain("mfaFactor");
  });

  it("policyViolations.totalLast30d aggregates intelligenceActivityEvent.count", () => {
    expect(src).toContain("intelligenceActivityEvent");
    expect(src).toMatch(/intelligenceActivityEvent[\s\S]{0,200}count/);
    expect(src).toContain("POLICY_VIOLATION");
    expect(src).toContain("POLICY_BLOCK");
  });
});

// ---------------------------------------------------------------------------
// 16. UI completion
// ---------------------------------------------------------------------------

describe("Phase 4A Closure — UI completion", () => {
  it("per-campaign access review items page exists with bounded data anchor", () => {
    const relPath =
      "../../../apps/web/app/(app)/governance-platform/access-reviews/[campaignId]/page.tsx";
    expect(srcExists(relPath)).toBe(true);
    const src = readSrc(relPath);
    expect(src).toContain("data-access-review-items-page");
  });

  it("trust-center DriftBadge component exists", () => {
    const relPath = "../../../apps/web/app/(app)/trust-center/_drift-badge.tsx";
    expect(srcExists(relPath)).toBe(true);
  });

  it("trust-center page imports DriftBadge", () => {
    const src = readSrc(
      "../../../apps/web/app/(app)/trust-center/page.tsx",
    );
    expect(src).toContain("DriftBadge");
    expect(src).toContain("_drift-badge");
  });
});
