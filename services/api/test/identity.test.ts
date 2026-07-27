/**
 * Phase 17 — Identity & Access API tests.
 *
 *   - Access policy engine: pure evaluation against actor snapshots
 *     (member / service-account / contributor) — covers role floor,
 *     capability grants, delegated admin scopes, and deny paths
 *     (SUSPENDED, REVOKED, expired, scope missing).
 *   - Service error code surface (RbacError, AccessReviewError,
 *     ContributorGovernanceError, ExternalIdentityError).
 *   - Route surface: 404 (not 403) on non-members; 403 with deny reason
 *     on insufficient permission; identity routes are session auth
 *     (never service-account auth).
 *   - Public verify isolation: source-level grep proves no identity_*
 *     table is read from the public verify route.
 *   - Migration safety: file uses ADD COLUMN IF NOT EXISTS and DO $$ ...
 *     EXCEPTION blocks; no existing column is altered.
 *
 * No DB — source-text + pure-evaluation tests only.
 */

import { describe, expect, it } from "vitest";

import {
  evaluateAccess,
  type ActorSnapshot,
} from "../src/services/identity/access-policy.service.js";
import { RbacError } from "../src/services/identity/rbac.service.js";
import { AccessReviewError } from "../src/services/identity/access-review.service.js";
import { ContributorGovernanceError } from "../src/services/identity/contributor-governance.service.js";
import { ExternalIdentityError } from "../src/services/identity/external-identity.service.js";

const FUTURE = new Date(Date.now() + 365 * 24 * 3600 * 1000);
const PAST = new Date(Date.now() - 1_000);

function memberActor(overrides: Partial<{
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  accessExpiresAtUtc: Date | null;
  // PHASE 1 (2026-07-21, corrected) — workspace-kind + org-lifecycle fields.
  workspaceKind: "PERSONAL" | "OWNED" | "ORGANIZATION" | "UNKNOWN";
  organizationStatus: string | null;
  capabilityGrants: Array<{
    id: string;
    permission: string;
    expiresAtUtc: Date | null;
    revokedAtUtc: Date | null;
  }>;
  delegatedAdminScopes: Array<{
    id: string;
    scopeKind:
      | "GOVERNANCE_ADMIN"
      | "REVIEW_ADMIN"
      | "INTELLIGENCE_ADMIN"
      | "INTEGRATION_ADMIN"
      | "COLLABORATION_ADMIN"
      | "IDENTITY_ADMIN"
      | "RETENTION_ADMIN";
    expiresAtUtc: Date | null;
    revokedAtUtc: Date | null;
  }>;
}> = {}): ActorSnapshot {
  return {
    kind: "MEMBER",
    member: {
      teamMemberId: "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
      role: overrides.role ?? "MEMBER",
      status: overrides.status ?? "ACTIVE",
      accessExpiresAtUtc:
        overrides.accessExpiresAtUtc === undefined
          ? null
          : overrides.accessExpiresAtUtc,
      // PHASE 1 (2026-07-21, corrected) — default to a PERSONAL workspace so
      // pre-existing cases (which don't set org state) are exempt from
      // CUSTOMER-org lifecycle; override to drive the org-lifecycle / kind
      // deny paths.
      workspaceKind: overrides.workspaceKind ?? "PERSONAL",
      organizationStatus:
        overrides.organizationStatus === undefined
          ? "ACTIVE"
          : overrides.organizationStatus,
      capabilityGrants: overrides.capabilityGrants ?? [],
      delegatedAdminScopes: overrides.delegatedAdminScopes ?? [],
    },
  };
}

// -----------------------------------------------------------------------------
// Service error codes — stable surface
// -----------------------------------------------------------------------------

describe("RbacError — stable code surface", () => {
  it("covers every code the route layer maps", () => {
    const codes = [
      "member_not_found",
      "member_owner_immutable",
      "invalid_status_transition",
      "self_action_forbidden",
      "capability_unknown",
      "capability_already_active",
      "capability_not_found",
      "delegated_scope_already_active",
      "delegated_scope_not_found",
      "role_transition_to_owner_forbidden",
    ] as const;
    for (const code of codes) {
      const err = new RbacError(code);
      expect(err.code).toBe(code);
      expect(err.message).toBe(code);
    }
  });
});

describe("AccessReviewError + Contributor + External — stable codes", () => {
  it("AccessReviewError codes", () => {
    for (const c of ["review_not_found", "invalid_status_transition", "subject_missing"] as const) {
      const e = new AccessReviewError(c);
      expect(e.code).toBe(c);
    }
  });
  it("ContributorGovernanceError codes", () => {
    for (const c of ["session_not_found", "session_already_revoked", "session_already_terminal"] as const) {
      const e = new ContributorGovernanceError(c);
      expect(e.code).toBe(c);
    }
  });
  it("ExternalIdentityError codes", () => {
    for (const c of [
      "user_not_in_workspace",
      "mapping_already_active",
      "mapping_not_found",
    ] as const) {
      const e = new ExternalIdentityError(c);
      expect(e.code).toBe(c);
    }
  });
});

// -----------------------------------------------------------------------------
// Access policy engine — pure evaluation
// -----------------------------------------------------------------------------

describe("Access policy engine — member evaluation", () => {
  it("denies a null actor with no_actor", () => {
    const d = evaluateAccess(null, { permission: "evidence.read" });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("no_actor");
  });

  it("denies SUSPENDED members regardless of role", () => {
    const d = evaluateAccess(
      memberActor({ role: "ADMIN", status: "SUSPENDED" }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("member_not_active");
  });

  it("denies REVOKED members regardless of role", () => {
    const d = evaluateAccess(
      memberActor({ role: "OWNER", status: "REVOKED" }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("member_not_active");
  });

  it("denies a member whose accessExpiresAtUtc is in the past", () => {
    const d = evaluateAccess(
      memberActor({ role: "ADMIN", accessExpiresAtUtc: PAST }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("member_access_expired");
  });

  // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21, CORRECTED) — workspace-kind +
  // org-lifecycle gate, FAIL CLOSED (no "null means skip"). The 8 required
  // A-cases:

  // (3) ORGANIZATION + SUSPENDED → deny.
  it("A3: denies an ORGANIZATION member whose CUSTOMER Organization is SUSPENDED", () => {
    const d = evaluateAccess(
      memberActor({ role: "OWNER", workspaceKind: "ORGANIZATION", organizationStatus: "SUSPENDED" }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("organization_not_active");
  });

  // (4) ORGANIZATION + ARCHIVED → deny.
  it("A4: denies an ORGANIZATION member whose CUSTOMER Organization is ARCHIVED", () => {
    const d = evaluateAccess(
      memberActor({ role: "ADMIN", workspaceKind: "ORGANIZATION", organizationStatus: "ARCHIVED" }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("organization_not_active");
  });

  // (1)+(2) ORGANIZATION + missing Organization / null status → deny (NOT skip).
  it("A1/A2: denies an ORGANIZATION member when the Organization row/status is missing (null)", () => {
    const d = evaluateAccess(
      memberActor({ role: "OWNER", workspaceKind: "ORGANIZATION", organizationStatus: null }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("organization_not_active");
  });

  // (5) ORGANIZATION + ACTIVE → continue evaluation (allowed via role floor).
  it("A5: allows an ORGANIZATION member whose CUSTOMER Organization is ACTIVE", () => {
    const d = evaluateAccess(
      memberActor({ role: "OWNER", workspaceKind: "ORGANIZATION", organizationStatus: "ACTIVE" }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(true);
  });

  // (6) PERSONAL → CUSTOMER-org lifecycle not applicable (exempt even if the
  // backing SYSTEM container somehow carried a non-ACTIVE status).
  it("A6: PERSONAL workspace is exempt from CUSTOMER-org lifecycle", () => {
    const d = evaluateAccess(
      memberActor({ role: "OWNER", workspaceKind: "PERSONAL", organizationStatus: "ARCHIVED" }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(true);
  });

  // (7) OWNED → CUSTOMER-org lifecycle not incorrectly applied.
  it("A7: OWNED workspace is exempt from CUSTOMER-org lifecycle", () => {
    const d = evaluateAccess(
      memberActor({ role: "OWNER", workspaceKind: "OWNED", organizationStatus: "SUSPENDED" }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(true);
  });

  // (8) Unknown/unprovable kind → deny (fail closed).
  it("A8: denies when the workspace kind cannot be proven (workspace_kind_unresolved)", () => {
    const d = evaluateAccess(
      memberActor({ role: "OWNER", workspaceKind: "UNKNOWN", organizationStatus: "ACTIVE" }),
      { permission: "evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("workspace_kind_unresolved");
  });

  it("allows via canonical role floor (ADMIN -> identity.member.suspend)", () => {
    const d = evaluateAccess(memberActor({ role: "ADMIN" }), {
      permission: "identity.member.suspend",
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.via.kind).toBe("role");
  });

  it("denies REVIEWER on identity.member.suspend (role floor too low)", () => {
    const d = evaluateAccess(memberActor({ role: "MEMBER" }), {
      permission: "identity.member.suspend",
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("permission_not_granted");
  });

  it("allows via capability grant when role floor does NOT permit", () => {
    const d = evaluateAccess(
      memberActor({
        role: "MEMBER",
        capabilityGrants: [
          {
            id: "g1",
            permission: "identity.member.suspend",
            expiresAtUtc: null,
            revokedAtUtc: null,
          },
        ],
      }),
      { permission: "identity.member.suspend" },
    );
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.via.kind).toBe("capability_grant");
      if (d.via.kind === "capability_grant") expect(d.via.grantId).toBe("g1");
    }
  });

  it("ignores REVOKED capability grants (no effect)", () => {
    const d = evaluateAccess(
      memberActor({
        role: "MEMBER",
        capabilityGrants: [
          {
            id: "g1",
            permission: "identity.member.suspend",
            expiresAtUtc: null,
            revokedAtUtc: PAST,
          },
        ],
      }),
      { permission: "identity.member.suspend" },
    );
    expect(d.allowed).toBe(false);
  });

  it("ignores EXPIRED capability grants (no effect)", () => {
    const d = evaluateAccess(
      memberActor({
        role: "MEMBER",
        capabilityGrants: [
          {
            id: "g1",
            permission: "identity.member.suspend",
            expiresAtUtc: PAST,
            revokedAtUtc: null,
          },
        ],
      }),
      { permission: "identity.member.suspend" },
    );
    expect(d.allowed).toBe(false);
  });

  it("allows via delegated admin scope (GOVERNANCE_ADMIN -> legal hold)", () => {
    const d = evaluateAccess(
      memberActor({
        role: "MEMBER",
        delegatedAdminScopes: [
          {
            id: "s1",
            scopeKind: "GOVERNANCE_ADMIN",
            expiresAtUtc: FUTURE,
            revokedAtUtc: null,
          },
        ],
      }),
      { permission: "governance.legal_hold.manage" },
    );
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.via.kind).toBe("delegated_admin");
      if (d.via.kind === "delegated_admin")
        expect(d.via.scope).toBe("GOVERNANCE_ADMIN");
    }
  });

  it("denies when the delegated scope does NOT cover the permission", () => {
    // REVIEW_ADMIN scope must NOT grant identity.member.suspend.
    const d = evaluateAccess(
      memberActor({
        role: "MEMBER",
        delegatedAdminScopes: [
          {
            id: "s1",
            scopeKind: "REVIEW_ADMIN",
            expiresAtUtc: FUTURE,
            revokedAtUtc: null,
          },
        ],
      }),
      { permission: "identity.member.suspend" },
    );
    expect(d.allowed).toBe(false);
  });

  it("ignores REVOKED delegated admin scope (no effect)", () => {
    const d = evaluateAccess(
      memberActor({
        role: "MEMBER",
        delegatedAdminScopes: [
          {
            id: "s1",
            scopeKind: "GOVERNANCE_ADMIN",
            expiresAtUtc: null,
            revokedAtUtc: PAST,
          },
        ],
      }),
      { permission: "governance.legal_hold.manage" },
    );
    expect(d.allowed).toBe(false);
  });
});

describe("Access policy engine — service account evaluation", () => {
  it("denies REVOKED service account", () => {
    const d = evaluateAccess(
      {
        kind: "SERVICE_ACCOUNT",
        serviceAccount: {
          apiCredentialId: "11111111-1111-4111-8111-111111111111",
          teamId: "22222222-2222-4222-8222-222222222222",
          status: "REVOKED",
          scopes: ["integration.evidence.read"],
          expiresAtUtc: null,
          disabledAtUtc: null,
          rotationRequired: false,
        },
      },
      { permission: "integration.evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("service_account_revoked");
  });

  it("denies DISABLED service account", () => {
    const d = evaluateAccess(
      {
        kind: "SERVICE_ACCOUNT",
        serviceAccount: {
          apiCredentialId: "11111111-1111-4111-8111-111111111111",
          teamId: "22222222-2222-4222-8222-222222222222",
          status: "ACTIVE",
          scopes: ["integration.evidence.read"],
          expiresAtUtc: null,
          disabledAtUtc: PAST,
          rotationRequired: false,
        },
      },
      { permission: "integration.evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("service_account_disabled");
  });

  it("denies EXPIRED service account", () => {
    const d = evaluateAccess(
      {
        kind: "SERVICE_ACCOUNT",
        serviceAccount: {
          apiCredentialId: "11111111-1111-4111-8111-111111111111",
          teamId: "22222222-2222-4222-8222-222222222222",
          status: "ACTIVE",
          scopes: ["integration.evidence.read"],
          expiresAtUtc: PAST,
          disabledAtUtc: null,
          rotationRequired: false,
        },
      },
      { permission: "integration.evidence.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("service_account_expired");
  });

  it("denies when scope is missing", () => {
    const d = evaluateAccess(
      {
        kind: "SERVICE_ACCOUNT",
        serviceAccount: {
          apiCredentialId: "11111111-1111-4111-8111-111111111111",
          teamId: "22222222-2222-4222-8222-222222222222",
          status: "ACTIVE",
          scopes: ["integration.evidence.read"],
          expiresAtUtc: null,
          disabledAtUtc: null,
          rotationRequired: false,
        },
      },
      { permission: "integration.evidence.create" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("service_account_scope_missing");
  });

  it("allows when scope is present", () => {
    const d = evaluateAccess(
      {
        kind: "SERVICE_ACCOUNT",
        serviceAccount: {
          apiCredentialId: "11111111-1111-4111-8111-111111111111",
          teamId: "22222222-2222-4222-8222-222222222222",
          status: "ACTIVE",
          scopes: ["integration.evidence.read"],
          expiresAtUtc: FUTURE,
          disabledAtUtc: null,
          rotationRequired: false,
        },
      },
      { permission: "integration.evidence.read" },
    );
    expect(d.allowed).toBe(true);
  });
});

describe("Access policy engine — contributor evaluation", () => {
  it("denies revoked contributor session", () => {
    const d = evaluateAccess(
      {
        kind: "CONTRIBUTOR",
        contributor: {
          intakeSessionId: "11111111-1111-4111-8111-111111111111",
          intakeLinkId: "22222222-2222-4222-8222-222222222222",
          teamId: "33333333-3333-4333-8333-333333333333",
          revokedAtUtc: PAST,
          expiresAtUtc: FUTURE,
        },
      },
      { permission: "evidence.create" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("contributor_session_revoked");
  });

  it("denies expired contributor session", () => {
    const d = evaluateAccess(
      {
        kind: "CONTRIBUTOR",
        contributor: {
          intakeSessionId: "11111111-1111-4111-8111-111111111111",
          intakeLinkId: "22222222-2222-4222-8222-222222222222",
          teamId: "33333333-3333-4333-8333-333333333333",
          revokedAtUtc: null,
          expiresAtUtc: PAST,
        },
      },
      { permission: "evidence.create" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("contributor_session_expired");
  });

  it("denies unsupported permissions for contributors (privacy floor)", () => {
    const d = evaluateAccess(
      {
        kind: "CONTRIBUTOR",
        contributor: {
          intakeSessionId: "11111111-1111-4111-8111-111111111111",
          intakeLinkId: "22222222-2222-4222-8222-222222222222",
          teamId: "33333333-3333-4333-8333-333333333333",
          revokedAtUtc: null,
          expiresAtUtc: FUTURE,
        },
      },
      { permission: "identity.member.read" },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed)
      expect(d.reason).toBe("contributor_unsupported_permission");
  });
});

// -----------------------------------------------------------------------------
// Route surface — anti-enumeration + session-only auth
// -----------------------------------------------------------------------------

describe("Identity routes — anti-enumeration + session-only", () => {
  it("uses 404 (not 403) for non-members (anti-enumeration posture)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/identity.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // The membership guard returns 404 ("not_found") — never 403 — for
    // a non-member. 403 is reserved for permission denials AFTER
    // membership is confirmed.
    expect(src).toMatch(/code:\s*"not_found"/);
    const guardBlock = src.match(/requireIdentityActor[\s\S]{0,1500}/);
    expect(guardBlock).not.toBeNull();
    if (guardBlock) {
      // The non-member branch must NOT 403.
      const nonMemberBranch = guardBlock[0].match(/if \(!member\)[\s\S]{0,200}/);
      expect(nonMemberBranch).not.toBeNull();
      if (nonMemberBranch) {
        expect(nonMemberBranch[0]).not.toMatch(/reply\.code\(403\)/);
        expect(nonMemberBranch[0]).toMatch(/reply\.code\(404\)/);
      }
    }
  });

  it("identity routes use requireAuth (session) — NEVER requireApiKey", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/identity.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/requireApiKey\(/);
    expect(src).not.toMatch(/preHandler:\s*requireApiKey/);
    expect(src).toMatch(/preHandler:\s*requireAuth/);
  });
});

// -----------------------------------------------------------------------------
// Public verify isolation — identity must NEVER be exposed there
// -----------------------------------------------------------------------------

describe("Public verify isolation — identity NOT exposed", () => {
  it("public verify route does not read identity_* tables", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    const start = src.indexOf('app.get("/public/verify/:id"');
    expect(start).toBeGreaterThan(-1);
    const verifyBlock = src.slice(start, start + 8000);
    expect(verifyBlock).not.toMatch(/memberCapabilityGrant/);
    expect(verifyBlock).not.toMatch(/memberDelegatedAdminScope/);
    expect(verifyBlock).not.toMatch(/organizationSecurityPolicy/);
    expect(verifyBlock).not.toMatch(/accessReview/);
    expect(verifyBlock).not.toMatch(/externalIdentityMapping/);
  });
});

// -----------------------------------------------------------------------------
// Migration safety — additive only, no destructive ALTER
// -----------------------------------------------------------------------------

describe("Phase 17 migration — additive only", () => {
  it("uses IF NOT EXISTS / EXCEPTION blocks; never drops or renames", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../prisma/migrations/20260526100000_add_identity_phase17/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(src).toMatch(/EXCEPTION WHEN duplicate_object/);
    // Must NOT drop / rename existing columns in the forward path.
    expect(src.match(/^\s*ALTER TABLE [^;]+DROP COLUMN/m)).toBeNull();
    expect(src.match(/^\s*ALTER TABLE [^;]+RENAME COLUMN/m)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Service account hardening — middleware enforces expiry + disabled + ip
// -----------------------------------------------------------------------------

describe("integrations-auth middleware — Phase 17 hardening", () => {
  it("middleware calls verifyApiKeyDetailed (not the legacy boolean verify)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/middleware/integrations-auth.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/verifyApiKeyDetailed/);
  });

  it("middleware enforces ipAllowlist when non-empty", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/middleware/integrations-auth.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/isIpAddressAllowed/);
    expect(src).toMatch(/credential\.ipAllowlist\.length\s*>\s*0/);
  });

  it("middleware surfaces rotation-required as an x-proovra-rotation-required header", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/middleware/integrations-auth.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/x-proovra-rotation-required/);
  });
});
