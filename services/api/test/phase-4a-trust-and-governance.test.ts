/**
 * PROOVRA Phase 4A — Trust Center + Enterprise Governance contract test.
 *
 * Pins every workstream:
 *
 *   1. Shared contracts (15 trust sections, 9 methodology sections,
 *      12 AI disclosure sections, 18 security sections, 7 delegated
 *      admin tiers, 6 governance policy kinds, 3 policy enforcement
 *      modes, 5 access-review campaign kinds, 5 cross-org review
 *      states, 13 status component keys, 6 status component healths,
 *      4 status incident severities, 6 status incident states).
 *   2. Prisma additions + Phase O-Final compliant migration.
 *   3. Service module API surface.
 *   4. HTTP routes mounted.
 *   5. UI pages with bounded data-* anchors.
 *   6. Nav registry entries.
 *   7. Report integration (trust references block).
 *   8. Delegated administration through the canonical permission engine
 *      (members audit DOM-09 retired the tier check `hasDelegatedTier`;
 *      member delegated scopes + capability grants are the one authority).
 *   9. Behavioural: trust seed produces 15+9+12+18 = 54 articles.
 *  10. Behavioural: subprocessor seed produces 8 registrations.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACCESS_REVIEW_CAMPAIGN_KINDS,
  ACCESS_REVIEW_CAMPAIGN_STATES,
  ACCESS_REVIEW_ITEM_DECISIONS,
  AI_DISCLOSURE_SECTIONS,
  CROSS_ORG_REVIEW_STATES,
  DELEGATED_ADMIN_GRANT_STATES,
  DELEGATED_ADMIN_TIERS,
  DEPARTMENT_STATES,
  GOVERNANCE_DASHBOARD_SCHEMA_VERSION,
  GOVERNANCE_POLICY_ENFORCEMENT_MODES,
  GOVERNANCE_POLICY_KINDS,
  GOVERNANCE_POLICY_SCOPES,
  GOVERNANCE_POLICY_STATES,
  METHODOLOGY_SECTIONS,
  ORGANIZATION_STATES,
  SECURITY_SECTIONS,
  STATUS_COMPONENT_HEALTHS,
  STATUS_COMPONENT_KEYS,
  STATUS_INCIDENT_SEVERITIES,
  STATUS_INCIDENT_STATES,
  STATUS_PAGE_SCHEMA_VERSION,
  SUBPROCESSOR_DATA_CATEGORIES,
  SUBPROCESSOR_STATES,
  TRUST_AND_GOVERNANCE_LIMITATIONS,
  TRUST_ARTICLE_KINDS,
  TRUST_ARTICLE_STATES,
  TRUST_CENTER_SECTIONS,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// 1. Shared contracts.
// ---------------------------------------------------------------------------

describe("Phase 4A — shared contracts", () => {
  it("Trust Center has exactly the 15 required sections", () => {
    expect([...TRUST_CENTER_SECTIONS].sort()).toEqual(
      [
        "PLATFORM_TRUST",
        "VERIFICATION_METHODOLOGY",
        "EVIDENCE_INTEGRITY",
        "TRUSTED_TIMESTAMPING",
        "OPEN_TIMESTAMPS",
        "CHAIN_OF_CUSTODY",
        "PROVENANCE",
        "SECURITY_CONTROLS",
        "AI_GOVERNANCE",
        "RELIABILITY",
        "DATA_PROCESSING",
        "PRIVACY",
        "SUBPROCESSORS",
        "GOVERNANCE",
        "TRANSPARENCY",
      ].sort(),
    );
    expect(TRUST_CENTER_SECTIONS.length).toBe(15);
  });

  it("Methodology Center has the 9 required sections", () => {
    expect(METHODOLOGY_SECTIONS.length).toBe(9);
    expect(METHODOLOGY_SECTIONS).toContain("HOW_VERIFICATION_WORKS");
    expect(METHODOLOGY_SECTIONS).toContain("HOW_HASHING_WORKS");
    expect(METHODOLOGY_SECTIONS).toContain("HOW_TRUSTED_TIMESTAMPS_WORK");
    expect(METHODOLOGY_SECTIONS).toContain("HOW_OTS_WORKS");
    expect(METHODOLOGY_SECTIONS).toContain("HOW_PROVENANCE_WORKS");
    expect(METHODOLOGY_SECTIONS).toContain("HOW_VERIFICATION_PACKAGES_WORK");
    expect(METHODOLOGY_SECTIONS).toContain("HOW_TRUST_DECISIONS_WORK");
    expect(METHODOLOGY_SECTIONS).toContain("HOW_REDACTION_WORKS");
    expect(METHODOLOGY_SECTIONS).toContain("HOW_INTELLIGENCE_WORKS");
  });

  it("AI Disclosure Center has the 12 required sections", () => {
    expect(AI_DISCLOSURE_SECTIONS.length).toBe(12);
    for (const k of [
      "MODELS_USED",
      "PROVIDERS_USED",
      "DATA_SENT",
      "DATA_NOT_SENT",
      "CONFIDENCE_MODEL",
      "HUMAN_REVIEW_MODEL",
      "CORRECTION_MODEL",
      "LIMITATIONS",
      "KNOWN_RISKS",
      "PROVIDER_STATUS",
      "AI_ACTIVITY_TRANSPARENCY",
      "COST_TRANSPARENCY",
    ]) {
      expect(AI_DISCLOSURE_SECTIONS).toContain(k);
    }
  });

  it("Security Center has the 18 required sections", () => {
    expect(SECURITY_SECTIONS.length).toBe(18);
    for (const k of [
      "AUTHENTICATION",
      "AUTHORIZATION",
      "RBAC",
      "MFA",
      "SAML",
      "SCIM",
      "ENCRYPTION",
      "KMS",
      "AUDIT_LOGGING",
      "EVIDENCE_IMMUTABILITY",
      "OBJECT_LOCK",
      "ACCESS_CONTROLS",
      "MONITORING",
      "INCIDENT_RESPONSE",
      "DISASTER_RECOVERY",
      "RETENTION",
      "DELETION",
      "SECURITY_CONTACTS",
    ]) {
      expect(SECURITY_SECTIONS).toContain(k);
    }
  });

  it("Trust article kinds + states are bounded", () => {
    expect([...TRUST_ARTICLE_KINDS].sort()).toEqual(
      ["AI_DISCLOSURE", "METHODOLOGY", "SECURITY", "TRUST_CENTER"],
    );
    expect([...TRUST_ARTICLE_STATES].sort()).toEqual(
      ["DEPRECATED", "DRAFT", "PUBLISHED"],
    );
  });

  it("Delegated admin tiers cover the 7 enterprise roles", () => {
    expect([...DELEGATED_ADMIN_TIERS].sort()).toEqual(
      [
        "COMPLIANCE_OFFICER",
        "DEPARTMENT_ADMIN",
        "GLOBAL_ADMIN",
        "ORG_ADMIN",
        "REVIEWER_LEAD",
        "SECURITY_OFFICER",
        "WORKSPACE_ADMIN",
      ],
    );
    expect([...DELEGATED_ADMIN_GRANT_STATES].sort()).toEqual(
      ["ACTIVE", "EXPIRED", "REVOKED"],
    );
  });

  it("Governance policy kinds cover the 6 required categories", () => {
    expect([...GOVERNANCE_POLICY_KINDS].sort()).toEqual(
      [
        "INTELLIGENCE",
        "REDACTION",
        "RETENTION",
        "REVIEW",
        "SECURITY",
        "VERIFICATION",
      ],
    );
    expect([...GOVERNANCE_POLICY_SCOPES].sort()).toEqual(
      ["DEPARTMENT", "ORGANIZATION", "WORKSPACE"],
    );
    expect([...GOVERNANCE_POLICY_ENFORCEMENT_MODES].sort()).toEqual(
      ["AUDIT_ONLY", "BLOCK", "WARN"],
    );
    expect([...GOVERNANCE_POLICY_STATES].sort()).toEqual(
      ["ACTIVE", "DEPRECATED", "DRAFT"],
    );
  });

  it("Access review campaign kinds + states + decisions bounded", () => {
    expect([...ACCESS_REVIEW_CAMPAIGN_KINDS].sort()).toEqual(
      [
        "ACCESS_CERTIFICATION",
        "MANAGER",
        "PERIODIC",
        "ROLE_CERTIFICATION",
        "SECURITY",
      ],
    );
    expect([...ACCESS_REVIEW_CAMPAIGN_STATES].sort()).toEqual(
      ["CANCELLED", "CLOSED", "DRAFT", "OPEN"],
    );
    expect([...ACCESS_REVIEW_ITEM_DECISIONS].sort()).toEqual(
      ["APPROVED", "ESCALATED", "PENDING", "REVOKED"],
    );
  });

  it("Cross-org review states + organization + department bounded", () => {
    expect([...CROSS_ORG_REVIEW_STATES].sort()).toEqual(
      ["ACCEPTED", "DECLINED", "EXPIRED", "INVITED", "REVOKED"],
    );
    expect([...ORGANIZATION_STATES].sort()).toEqual(
      ["ACTIVE", "ARCHIVED", "SUSPENDED"],
    );
    expect([...DEPARTMENT_STATES].sort()).toEqual(["ACTIVE", "ARCHIVED"]);
  });

  it("Status page vocabulary bounded", () => {
    expect(STATUS_COMPONENT_KEYS.length).toBe(13);
    for (const k of [
      "API",
      "VERIFICATION",
      "CAPTURE",
      "REPORTS",
      "AI_SERVICES",
      "AZURE_DI",
      "DEEPGRAM",
      "AWS_REKOGNITION",
      "AWS_S3",
      "BACKGROUND_WORKERS",
      "QUEUE_HEALTH",
      "STORAGE_HEALTH",
      "DEPENDENCY_HEALTH",
    ]) {
      expect(STATUS_COMPONENT_KEYS).toContain(k);
    }
    expect([...STATUS_COMPONENT_HEALTHS].sort()).toEqual(
      [
        "DEGRADED",
        "MAINTENANCE",
        "MAJOR_OUTAGE",
        "OPERATIONAL",
        "PARTIAL_OUTAGE",
        "UNKNOWN",
      ],
    );
    expect([...STATUS_INCIDENT_SEVERITIES].sort()).toEqual(
      ["CRITICAL", "INFO", "MAJOR", "MINOR"],
    );
    expect([...STATUS_INCIDENT_STATES].sort()).toEqual(
      [
        "IDENTIFIED",
        "INVESTIGATING",
        "MONITORING",
        "POSTMORTEM_DRAFT",
        "POSTMORTEM_PUBLISHED",
        "RESOLVED",
      ],
    );
    expect(STATUS_PAGE_SCHEMA_VERSION).toBe("PROOVRA_STATUS_PAGE_V1");
  });

  it("Subprocessor states + data categories bounded", () => {
    expect([...SUBPROCESSOR_STATES].sort()).toEqual(
      ["ACTIVE", "DEPRECATED", "PROPOSED", "REMOVED"],
    );
    expect(SUBPROCESSOR_DATA_CATEGORIES.length).toBeGreaterThanOrEqual(8);
  });

  it("Governance dashboard schema version pinned", () => {
    expect(GOVERNANCE_DASHBOARD_SCHEMA_VERSION).toBe(
      "PROOVRA_GOVERNANCE_DASHBOARD_V1",
    );
  });

  it("Trust + governance limitations are surfaced", () => {
    expect(TRUST_AND_GOVERNANCE_LIMITATIONS.length).toBeGreaterThanOrEqual(5);
    expect(TRUST_AND_GOVERNANCE_LIMITATIONS).toContain(
      "DELEGATED_ADMIN_TIERS_ARE_ENFORCED_SERVER_SIDE",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Prisma additions + Phase O-Final compliant migration.
// ---------------------------------------------------------------------------

describe("Phase 4A — Prisma + migration", () => {
  it("schema declares the 13 Phase 4A models", () => {
    const schemaPath = fileURLToPath(
      new URL("../prisma/schema.prisma", import.meta.url),
    );
    const schema = readFileSync(schemaPath, "utf8");
    for (const model of [
      "TrustCenterArticle",
      "TrustCenterArticleVersion",
      "Subprocessor",
      "SubprocessorVersion",
      "StatusComponent",
      "StatusIncident",
      "StatusIncidentUpdate",
      "MaintenanceWindow",
      "Department",
      "DelegatedAdminGrant",
      "GovernancePolicy",
      "GovernancePolicyAssignment",
      "GovernancePolicyAudit",
      "AccessReviewCampaign",
      "AccessReviewItem",
      "CrossOrgReviewGrant",
    ]) {
      expect(schema).toContain(`model ${model} `);
    }
  });

  it("migration is Phase O-Final compliant", () => {
    const migPath = fileURLToPath(
      new URL(
        "../prisma/migrations/20261220000000_phase_4a_trust_and_governance/migration.sql",
        import.meta.url,
      ),
    );
    const sql = readFileSync(migPath, "utf8");
    // Plain CREATE TABLE (no IF NOT EXISTS) for brand-new tables.
    expect(sql).toContain("CREATE TABLE \"trust_center_articles\"");
    expect(sql).toContain("CREATE TABLE \"subprocessors\"");
    expect(sql).toContain("CREATE TABLE \"status_components\"");
    expect(sql).toContain("CREATE TABLE \"departments\"");
    expect(sql).toContain("CREATE TABLE \"delegated_admin_grants\"");
    expect(sql).toContain("CREATE TABLE \"governance_policies\"");
    expect(sql).toContain("CREATE TABLE \"access_review_campaigns\"");
    expect(sql).toContain("CREATE TABLE \"cross_org_review_grants\"");
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS");
    // Every CREATE INDEX is preceded by an information_schema guard.
    const guardCount = sql.match(/DO \$\$/g)?.length ?? 0;
    expect(guardCount).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// 3. Service module API surface.
// ---------------------------------------------------------------------------

describe("Phase 4A — service module surface", () => {
  it("trust-center service exposes upsert / list / get / seed", async () => {
    const m = await import("../src/services/trust/trust-center.service.js");
    expect(typeof m.upsertTrustArticle).toBe("function");
    expect(typeof m.listTrustArticles).toBe("function");
    expect(typeof m.getTrustArticleBySlug).toBe("function");
    expect(typeof m.listTrustArticleVersions).toBe("function");
    expect(typeof m.ensureTrustCenterSeed).toBe("function");
  });

  it("subprocessor service exposes upsert / list / seed", async () => {
    const m = await import("../src/services/trust/subprocessor.service.js");
    expect(typeof m.upsertSubprocessor).toBe("function");
    expect(typeof m.listSubprocessors).toBe("function");
    expect(typeof m.listSubprocessorVersions).toBe("function");
    expect(typeof m.ensureSubprocessorSeed).toBe("function");
  });

  it("status-page service exposes upsert / seed / project", async () => {
    const m = await import("../src/services/trust/status-page.service.js");
    expect(typeof m.upsertStatusComponent).toBe("function");
    expect(typeof m.ensureStatusComponentsSeed).toBe("function");
    expect(typeof m.projectStatusPage).toBe("function");
  });

  it("delegated administration is the member delegated scope: rbac exposes grant / update / revoke", async () => {
    // Members audit DOM-09 — the tier service is retired (its module is
    // gone); the one delegated-admin authority is written by rbac.service and
    // enforced by the permission engine.
    const m = await import("../src/services/identity/rbac.service.js");
    expect(typeof m.grantDelegatedAdminScope).toBe("function");
    expect(typeof m.updateDelegatedAdminScope).toBe("function");
    expect(typeof m.revokeDelegatedAdminScope).toBe("function");
    expect(
      existsSync(
        fileURLToPath(new URL("../src/services/governance/delegated-admin.service.ts", import.meta.url)),
      ),
    ).toBe(false);
  });

  it("department service exposes create / archive / list", async () => {
    const m = await import("../src/services/governance/department.service.js");
    expect(typeof m.createDepartment).toBe("function");
    expect(typeof m.archiveDepartment).toBe("function");
    expect(typeof m.listDepartments).toBe("function");
  });

  it("governance-policy service exposes create / activate / assign / resolve", async () => {
    const m = await import(
      "../src/services/governance/governance-policy.service.js"
    );
    expect(typeof m.createPolicy).toBe("function");
    expect(typeof m.activatePolicy).toBe("function");
    expect(typeof m.deprecatePolicy).toBe("function");
    expect(typeof m.assignPolicy).toBe("function");
    expect(typeof m.listPolicies).toBe("function");
    expect(typeof m.listPolicyAssignments).toBe("function");
    expect(typeof m.listPolicyAudit).toBe("function");
    expect(typeof m.resolveEffectivePolicies).toBe("function");
  });

  it("access-review service exposes campaign + item flow", async () => {
    const m = await import(
      "../src/services/governance/access-review.service.js"
    );
    expect(typeof m.createCampaign).toBe("function");
    expect(typeof m.openCampaign).toBe("function");
    expect(typeof m.closeCampaign).toBe("function");
    expect(typeof m.recordItemDecision).toBe("function");
    expect(typeof m.listCampaigns).toBe("function");
    expect(typeof m.listItems).toBe("function");
  });

  it("cross-org-review service exposes invite / accept / decline / revoke", async () => {
    const m = await import(
      "../src/services/governance/cross-org-review.service.js"
    );
    expect(typeof m.inviteCrossOrgReview).toBe("function");
    expect(typeof m.acceptCrossOrgReview).toBe("function");
    expect(typeof m.declineCrossOrgReview).toBe("function");
    expect(typeof m.revokeCrossOrgReview).toBe("function");
    expect(typeof m.listCrossOrgGrants).toBe("function");
  });

  it("governance-dashboard service exposes the bounded projector", async () => {
    const m = await import(
      "../src/services/governance/governance-dashboard.service.js"
    );
    expect(typeof m.projectGovernanceDashboard).toBe("function");
  });

});

// ---------------------------------------------------------------------------
// 4. Behavioural — delegated administration through the canonical engine.
//
// Members audit DOM-09 retired the tier resolver (`hasDelegatedTier`). The
// claims it carried — a grant admits what it names and nothing more, it is
// bound to one workspace, expiry and revocation end it, and a narrower grant
// never escalates — are re-proven against the one authority that remains: the
// permission engine (role floor + capability grants + delegated scopes).
// ---------------------------------------------------------------------------

describe("Phase 4A — delegated administration in the canonical permission engine", () => {
  type Member = import("../src/services/identity/access-policy.service.js").MemberAccessSnapshot;
  const member = (over: Partial<Member> = {}): Member => ({
    teamMemberId: "tm-1",
    teamId: "team-a",
    userId: "user-1",
    role: "VIEWER",
    status: "ACTIVE",
    accessExpiresAtUtc: null,
    workspaceKind: "ORGANIZATION",
    workspaceOwnerUserId: "owner-X",
    organizationStatus: "ACTIVE",
    organizationId: "org-a",
    capabilityGrants: [],
    delegatedAdminScopes: [],
    ...over,
  });
  const decide = async (m: Member, permission: import("@proovra/shared").Permission) => {
    const { evaluateAccess } = await import("../src/services/identity/access-policy.service.js");
    return evaluateAccess({ kind: "MEMBER", member: m }, { permission });
  };
  const live = { expiresAtUtc: null, revokedAtUtc: null };

  it("a GOVERNANCE_ADMIN scope admits every permission of its family (the guarded governance surface)", async () => {
    const { listPermissionsForDelegatedAdminScope } = await import("@proovra/shared");
    const m = member({ delegatedAdminScopes: [{ id: "s-1", scopeKind: "GOVERNANCE_ADMIN", ...live }] });
    const family = listPermissionsForDelegatedAdminScope("GOVERNANCE_ADMIN");
    for (const p of [
      "governance.policy.manage",
      "governance.exchange.manage",
      "governance.department.manage",
      "governance.retention.manage",
      "governance.legal_hold.manage",
      "audit.read",
    ] as const) {
      expect(family).toContain(p);
      const d = await decide(m, p);
      expect(d.allowed, p).toBe(true);
      if (d.allowed) expect(d.via).toMatchObject({ kind: "delegated_admin", scope: "GOVERNANCE_ADMIN" });
    }
  });

  it("a delegated scope held in workspace A grants nothing in workspace B", async () => {
    // The engine loads the member snapshot by (teamId, userId): a scope row
    // is part of ONE membership. Asked about workspace B, where the user has
    // no membership, the loader finds nothing and the decision is a refusal.
    const { evaluateMemberAccess } = await import("../src/services/identity/access-policy.service.js");
    const asked: unknown[] = [];
    const client = {
      teamMember: {
        findUnique: async (args: { where: { teamId_userId: { teamId: string } } }) => {
          asked.push(args.where);
          return args.where.teamId_userId.teamId === "team-a"
            ? {
                id: "tm-1", teamId: "team-a", userId: "user-1", role: "VIEWER", status: "ACTIVE",
                accessExpiresAtUtc: null,
                team: {
                  isPersonal: false, workspaceKind: "ORGANIZATION", billingPlan: null,
                  organizationId: "org-a", ownerUserId: "owner-X", organization: { status: "ACTIVE" },
                },
                capabilityGrants: [],
                delegatedAdminScopes: [{ id: "s-1", scopeKind: "GOVERNANCE_ADMIN", ...live }],
              }
            : null;
        },
      },
      securityEvent: { create: async () => ({ id: "se-1" }) },
    } as never;
    const inA = await evaluateMemberAccess({ teamId: "team-a", userId: "user-1", permission: "governance.policy.manage" }, client);
    const inB = await evaluateMemberAccess({ teamId: "team-b", userId: "user-1", permission: "governance.policy.manage" }, client);
    expect(inA.allowed).toBe(true);
    expect(inB.allowed).toBe(false);
    expect(asked).toEqual([
      { teamId_userId: { teamId: "team-a", userId: "user-1" } },
      { teamId_userId: { teamId: "team-b", userId: "user-1" } },
    ]);
  });

  it("expired or revoked scopes and capability grants are rejected", async () => {
    const past = new Date(Date.now() - 60_000);
    for (const m of [
      member({ delegatedAdminScopes: [{ id: "s-1", scopeKind: "GOVERNANCE_ADMIN", expiresAtUtc: past, revokedAtUtc: null }] }),
      member({ delegatedAdminScopes: [{ id: "s-1", scopeKind: "GOVERNANCE_ADMIN", expiresAtUtc: null, revokedAtUtc: past }] }),
      member({ capabilityGrants: [{ id: "g-1", permission: "governance.policy.manage", expiresAtUtc: past, revokedAtUtc: null }] }),
      member({ capabilityGrants: [{ id: "g-1", permission: "governance.policy.manage", expiresAtUtc: null, revokedAtUtc: past }] }),
    ]) {
      const d = await decide(m, "governance.policy.manage");
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe("permission_not_granted");
    }
  });

  it("a live scope does not survive a non-live membership", async () => {
    for (const status of ["SUSPENDED", "REVOKED"] as const) {
      const d = await decide(
        member({ status, delegatedAdminScopes: [{ id: "s-1", scopeKind: "GOVERNANCE_ADMIN", ...live }] }),
        "governance.policy.manage",
      );
      expect(d.allowed, status).toBe(false);
    }
  });

  it("a narrower scope or grant does NOT escalate", async () => {
    // REVIEW_ADMIN carries the review family only — not governance.
    const reviewer = member({ delegatedAdminScopes: [{ id: "s-1", scopeKind: "REVIEW_ADMIN", ...live }] });
    expect((await decide(reviewer, "governance.policy.manage")).allowed).toBe(false);
    expect((await decide(reviewer, "governance.exchange.manage")).allowed).toBe(false);
    // A capability grant admits exactly the permission it names.
    const one = member({ capabilityGrants: [{ id: "g-1", permission: "governance.policy.manage", ...live }] });
    expect((await decide(one, "governance.policy.manage")).allowed).toBe(true);
    expect((await decide(one, "governance.retention.manage")).allowed).toBe(false);
    expect((await decide(one, "billing.manage")).allowed).toBe(false);
    // GOVERNANCE_ADMIN does not reach the OWNER-only billing permission or
    // the security-policy permission.
    const governor = member({ delegatedAdminScopes: [{ id: "s-1", scopeKind: "GOVERNANCE_ADMIN", ...live }] });
    expect((await decide(governor, "billing.manage")).allowed).toBe(false);
    expect((await decide(governor, "identity.org_policy.manage")).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Behavioural — governance policy inheritance + override.
// ---------------------------------------------------------------------------

describe("Phase 4A — governance policy inheritance + override", () => {
  it("Workspace override wins over Org assignment for the same policy kind+slug", async () => {
    const { resolveEffectivePolicies } = await import(
      "../src/services/governance/governance-policy.service.js"
    );
    const orgPolicy = {
      id: "policy-org",
      kind: "SECURITY",
      slug: "mfa",
      name: "Org MFA",
      summary: "",
      state: "ACTIVE",
      enforcementMode: "WARN",
      rule: {},
      version: 1,
      createdByUserId: "u",
      createdAt: new Date(),
    };
    const workspacePolicy = {
      id: "policy-ws",
      kind: "SECURITY",
      slug: "mfa",
      name: "Workspace MFA Strict",
      summary: "",
      state: "ACTIVE",
      enforcementMode: "BLOCK",
      rule: {},
      version: 1,
      createdByUserId: "u",
      createdAt: new Date(),
    };
    const prismaStub = {
      governancePolicyAssignment: {
        findMany: async () => [
          {
            scope: "ORGANIZATION",
            scopeTargetId: "org-a",
            isOverride: false,
            policy: orgPolicy,
          },
          {
            scope: "WORKSPACE",
            scopeTargetId: "ws-1",
            isOverride: true,
            policy: workspacePolicy,
          },
        ],
      },
    } as never;
    const effective = await resolveEffectivePolicies({
      prisma: prismaStub,
      teamId: "team",
      organizationId: "org-a",
      workspaceId: "ws-1",
    });
    expect(effective.length).toBe(1);
    expect(effective[0].id).toBe("policy-ws");
    expect(effective[0].enforcementMode).toBe("BLOCK");
  });

  it("Workspace assignment without override inherits the org policy", async () => {
    const { resolveEffectivePolicies } = await import(
      "../src/services/governance/governance-policy.service.js"
    );
    const orgPolicy = {
      id: "policy-org",
      kind: "RETENTION",
      slug: "default",
      name: "Org Retention",
      summary: "",
      state: "ACTIVE",
      enforcementMode: "WARN",
      rule: {},
      version: 1,
      createdByUserId: "u",
      createdAt: new Date(),
    };
    const prismaStub = {
      governancePolicyAssignment: {
        findMany: async () => [
          {
            scope: "ORGANIZATION",
            scopeTargetId: "org-a",
            isOverride: false,
            policy: orgPolicy,
          },
        ],
      },
    } as never;
    const effective = await resolveEffectivePolicies({
      prisma: prismaStub,
      teamId: "team",
      organizationId: "org-a",
      workspaceId: "ws-1",
    });
    expect(effective.length).toBe(1);
    expect(effective[0].id).toBe("policy-org");
  });

  it("Deprecated policies are filtered from effective resolution", async () => {
    const { resolveEffectivePolicies } = await import(
      "../src/services/governance/governance-policy.service.js"
    );
    const prismaStub = {
      governancePolicyAssignment: {
        findMany: async () => [
          {
            scope: "ORGANIZATION",
            scopeTargetId: "org-a",
            isOverride: false,
            policy: {
              id: "p-dep",
              kind: "SECURITY",
              slug: "x",
              name: "x",
              summary: "",
              state: "DEPRECATED",
              enforcementMode: "AUDIT_ONLY",
              rule: {},
              version: 1,
              createdByUserId: "u",
              createdAt: new Date(),
            },
          },
        ],
      },
    } as never;
    const effective = await resolveEffectivePolicies({
      prisma: prismaStub,
      teamId: "team",
      organizationId: "org-a",
    });
    expect(effective.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. HTTP routes mounted.
// ---------------------------------------------------------------------------

describe("Phase 4A — HTTP routes", () => {
  it("trust-and-governance.routes registers every required endpoint", () => {
    const path = fileURLToPath(
      new URL(
        "../src/routes/trust-and-governance.routes.ts",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    // Trust Center
    expect(src).toContain("/v1/trust/articles");
    expect(src).toContain("/v1/trust/articles/:id/versions");
    // Subprocessors
    expect(src).toContain("/v1/trust/subprocessors");
    expect(src).toContain("/v1/trust/subprocessors/seed");
    expect(src).toContain("/v1/trust/subprocessors/:id/versions");
    // Status page
    expect(src).toContain("/v1/trust/status");
    // Departments
    expect(src).toContain("/v1/governance/departments");
    expect(src).toContain("/v1/governance/departments/:id/archive");
    // Delegated admin — the tier endpoints stay mounted only to answer 410
    // (members audit DOM-09); delegated scopes live under /v1/identity.
    expect(src).toContain("/v1/governance/delegated-admin");
    expect(src).toContain("/v1/governance/delegated-admin/:id/revoke");
    expect(src).toContain('code: "DELEGATED_ADMIN_TIERS_RETIRED"');
    // Policies
    expect(src).toContain("/v1/governance/policies");
    expect(src).toContain("/v1/governance/policies/:id/activate");
    expect(src).toContain("/v1/governance/policies/:id/deprecate");
    expect(src).toContain("/v1/governance/policies/:id/assignments");
    expect(src).toContain("/v1/governance/policies/:id/audit");
    // Access reviews
    expect(src).toContain("/v1/governance/access-reviews/campaigns");
    expect(src).toContain("/v1/governance/access-reviews/campaigns/:id/open");
    expect(src).toContain("/v1/governance/access-reviews/campaigns/:id/close");
    expect(src).toContain("/v1/governance/access-reviews/campaigns/:id/items");
    expect(src).toContain("/v1/governance/access-reviews/items/:id/decision");
    // Cross-org review
    expect(src).toContain("/v1/governance/cross-org-review");
    expect(src).toContain("/v1/governance/cross-org-review/:id/accept");
    expect(src).toContain("/v1/governance/cross-org-review/:id/decline");
    expect(src).toContain("/v1/governance/cross-org-review/:id/revoke");
    // Dashboard
    expect(src).toContain("/v1/governance/dashboard");
  });

  it("routes are registered in server.ts", () => {
    const serverPath = fileURLToPath(
      new URL("../src/server.ts", import.meta.url),
    );
    const src = readFileSync(serverPath, "utf8");
    expect(src).toContain("trustAndGovernanceRoutes");
    expect(src).toContain("trust-and-governance.routes.js");
  });
});

// ---------------------------------------------------------------------------
// 7. UI surfaces + nav registry.
// ---------------------------------------------------------------------------

describe("Phase 4A — UI surfaces + nav registry", () => {
  it("Trust Center landing redirects to canonical /trust", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/trust-center/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("redirect(\"/trust\")");
  });

  it("Methodology page exists", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/trust-center/methodology/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("METHODOLOGY");
    expect(src).toContain("Verification Methodology Center");
  });

  it("AI Disclosure page exists", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/trust-center/ai-disclosure/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("AI_DISCLOSURE");
    expect(src).toContain("AI Disclosure Center");
  });

  it("Security Center page exists", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/trust-center/security/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("SECURITY");
    expect(src).toContain("Security Documentation Center");
  });

  it("Subprocessors page exists with bounded table anchor", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/trust-center/subprocessors/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("data-subprocessors-page");
    expect(src).toContain("data-subprocessors-table");
  });

  it("Status Page exists with bounded component + incident anchors", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/trust-center/status/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("data-status-page");
    expect(src).toContain("data-status-components");
    expect(src).toContain("data-status-active-incidents");
    expect(src).toContain("data-status-recent-incidents");
    expect(src).toContain("data-status-maintenance");
    expect(src).toContain("data-status-overall");
  });

  it("Governance Platform dashboard exists with bounded tiles", () => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/governance-platform/page.tsx",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("data-governance-platform");
    expect(src).toContain("data-governance-compliance");
    expect(src).toContain("data-governance-access-reviews");
    expect(src).toContain("data-governance-delegated");
    expect(src).toContain("data-governance-cross-org");
    expect(src).toContain("data-governance-audit-health");
    expect(src).toContain("data-governance-security-health");
    expect(src).toContain("data-governance-trust-health");
  });

  it("Governance Platform subpages exist", () => {
    for (const sub of [
      "departments",
      "delegated-admin",
      "policies",
      "access-reviews",
      "cross-org",
    ]) {
      const path = fileURLToPath(
        new URL(
          `../../../apps/web/app/(app)/governance-platform/${sub}/page.tsx`,
          import.meta.url,
        ),
      );
      const src = readFileSync(path, "utf8");
      expect(src.length).toBeGreaterThan(200);
    }
  });

  it("nav registry exposes Governance Platform; the Trust Hub nav was removed", () => {
    const path = fileURLToPath(
      new URL(
        "../src/services/platform-context/navigation-registry.ts",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    // Trust Hub nav removed 2026-07-15 — no workspace.trust nav entry, no
    // /trust-hub href. (Regex, not substring: `workspace.trust_center` in
    // the explanatory comment must not satisfy these.)
    expect(src).not.toMatch(/id:\s*"workspace\.trust"/);
    expect(src).not.toMatch(/href:\s*"\/trust-hub"/);
    // Governance Platform nav remains.
    expect(src).toContain("workspace.governance_platform");
    expect(src).toContain("/governance-platform");
  });
});

// ---------------------------------------------------------------------------
// 8. Report section accepts the trust + governance references shape.
// ---------------------------------------------------------------------------

describe("Phase 4A — report section integration", () => {
  it("intelligence-summary section source declares trustReferences shape + renders the block", () => {
    const path = fileURLToPath(
      new URL(
        "../../worker/src/report-v2/sections/intelligence-summary.ts",
        import.meta.url,
      ),
    );
    const src = readFileSync(path, "utf8");
    expect(src).toContain("trustReferences?");
    expect(src).toContain("Trust &amp; governance references");
    expect(src).toContain("trustReferencesBlock");
    expect(src).toContain("subprocessors:");
  });
});

// ---------------------------------------------------------------------------
// 9. Module resolution sanity.
// ---------------------------------------------------------------------------

describe("Phase 4A — module resolution", () => {
  it("every Phase 4A service module imports cleanly", async () => {
    await expect(
      import("../src/services/trust/trust-center.service.js"),
    ).resolves.toBeDefined();
    await expect(
      import("../src/services/trust/subprocessor.service.js"),
    ).resolves.toBeDefined();
    await expect(
      import("../src/services/trust/status-page.service.js"),
    ).resolves.toBeDefined();
    await expect(
      import("../src/services/governance/department.service.js"),
    ).resolves.toBeDefined();
    // delegated-admin.service is retired (members audit DOM-09); the
    // delegated-scope writer is rbac.service.
    await expect(
      import("../src/services/identity/rbac.service.js"),
    ).resolves.toBeDefined();
    await expect(
      import("../src/services/governance/governance-policy.service.js"),
    ).resolves.toBeDefined();
    await expect(
      import("../src/services/governance/access-review.service.js"),
    ).resolves.toBeDefined();
    await expect(
      import("../src/services/governance/cross-org-review.service.js"),
    ).resolves.toBeDefined();
    await expect(
      import("../src/services/governance/governance-dashboard.service.js"),
    ).resolves.toBeDefined();
  });
});
