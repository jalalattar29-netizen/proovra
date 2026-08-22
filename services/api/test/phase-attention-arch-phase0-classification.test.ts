/**
 * ATTENTION ARCHITECTURE — PHASE 0 (2026-08-22).
 *
 * Two authorities are pinned here, because both were previously decided by
 * a string comparison that could not answer the question it was asked.
 *
 * 1. WORKSPACE CLASSIFICATION.
 *
 *    `resolveCapabilities` classified workspaces through a two-value
 *    `scope` (PERSONAL | TEAM) derived from `Team.isPersonal`. The
 *    canonical discriminator is the three-value `Team.workspaceKind`
 *    (PERSONAL | OWNED | ORGANIZATION), which migration 20271125000000
 *    made NOT NULL precisely so readers could rely on it. OWNED and
 *    ORGANIZATION both carry `isPersonal = false` and therefore collapsed
 *    into one value — the exact distinction the P1 remediation created the
 *    column to make.
 *
 * 2. TENANT OPERATIONS ELIGIBILITY.
 *
 *    `OPERATIONS_VIEW` must NOT be a plan-name check. It is granted when a
 *    workspace can actually PRODUCE operational conditions: its package
 *    includes a condition-producing feature, or it is shared by more than
 *    one operator. The tier behaviour falls out of that rule rather than
 *    being hardcoded — which is the property that keeps it correct when
 *    packaging changes.
 *
 * 3. ENTERPRISE COMMERCIAL AUTHORITY.
 *
 *    "Is this an Enterprise customer?" is a CONTRACT question, answered by
 *    `EnterpriseContract`. `Team.billingPlan` answers a different question
 *    (what is in this workspace's package) and is documented in the schema
 *    as a LEGACY signal. A read failure must fail closed.
 *
 * Everything here is pure — no database, no envelope build.
 */

import { describe, expect, it } from "vitest";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";
import { deriveEnterpriseAuthority } from "../src/services/platform-context/enterprise-authority.js";

// Package shapes taken from the canonical catalog (PLAN_CAPABILITIES):
// FREE includes none of the four condition-producing features; PRO
// includes reports, verification packages and intake.

describe("Phase 0 — workspaceKind is the structural authority", () => {
  it("OWNED and ORGANIZATION are distinguishable, not collapsed into TEAM", () => {
    const owned = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
      workspaceKind: "OWNED",
      packageProducesOperationalConditions: true,
      memberCount: 3,
    });
    const organization = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "ENTERPRISE",
      isPlatformAdmin: false,
      workspaceKind: "ORGANIZATION",
      packageProducesOperationalConditions: true,
      memberCount: 3,
    });
    // Both are shared workspaces, so both operate. The point is that the
    // resolver now RECEIVES the distinction rather than being unable to
    // express it — a later rule can diverge them without a schema change.
    expect(owned.OPERATIONS_VIEW).toBe(true);
    expect(organization.OPERATIONS_VIEW).toBe(true);
    expect(owned.TEAM_VIEW).toBe(true);
    expect(organization.TEAM_VIEW).toBe(true);
  });

  it("an unprovable kind (UNKNOWN) grants no operations surface", () => {
    const map = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "ENTERPRISE",
      isPlatformAdmin: false,
      workspaceKind: "UNKNOWN",
      packageProducesOperationalConditions: true,
      memberCount: 12,
    });
    expect(map.OPERATIONS_VIEW).toBe(false);
    expect(map.OPERATIONS_ACKNOWLEDGE).toBe(false);
  });

  it("falls back to legacy scope when workspaceKind is absent", () => {
    const map = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
      packageProducesOperationalConditions: true,
      memberCount: 1,
    });
    // Legacy callers keep working; PERSONAL still resolves to PERSONAL.
    expect(map.OPERATIONS_VIEW).toBe(true);
    expect(map.TEAM_MANAGE).toBe(false);
  });
});

describe("Phase 4B — OPERATIONS_VIEW is capability-derived, never plan-named", () => {
  it("Personal Free: no operations surface", () => {
    const map = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
      workspaceKind: "PERSONAL",
      packageProducesOperationalConditions: false,
      memberCount: 1,
    });
    expect(map.OPERATIONS_VIEW).toBe(false);
    expect(map.OPERATIONS_ACKNOWLEDGE).toBe(false);
    expect(map.OPERATIONS_RESOLVE).toBe(false);
    expect(map.OPERATIONS_ASSIGN).toBe(false);
    expect(map.OPERATIONS_SUPPRESS).toBe(false);
  });

  it("Personal Pro: operations in single-operator mode (no assign/suppress semantics needed, but owner holds them)", () => {
    const map = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
      workspaceKind: "PERSONAL",
      packageProducesOperationalConditions: true,
      memberCount: 1,
    });
    expect(map.OPERATIONS_VIEW).toBe(true);
    expect(map.OPERATIONS_ACKNOWLEDGE).toBe(true);
    expect(map.OPERATIONS_RESOLVE).toBe(true);
  });

  it("a SHARED workspace operates even when its package includes no producer", () => {
    const map = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "FREE",
      isPlatformAdmin: false,
      workspaceKind: "OWNED",
      packageProducesOperationalConditions: false,
      memberCount: 4,
    });
    // Two operators means "has anyone dealt with this?" needs shared state,
    // whatever the package includes.
    expect(map.OPERATIONS_VIEW).toBe(true);
  });

  it("VIEWER may view but never act", () => {
    const map = resolveCapabilities({
      scope: "TEAM",
      role: "VIEWER",
      plan: "TEAM",
      isPlatformAdmin: false,
      workspaceKind: "ORGANIZATION",
      packageProducesOperationalConditions: true,
      memberCount: 6,
    });
    expect(map.OPERATIONS_VIEW).toBe(true);
    expect(map.OPERATIONS_ACKNOWLEDGE).toBe(false);
    expect(map.OPERATIONS_RESOLVE).toBe(false);
    expect(map.OPERATIONS_ASSIGN).toBe(false);
    expect(map.OPERATIONS_SUPPRESS).toBe(false);
  });

  it("writer acknowledges and resolves; only admin assigns and suppresses", () => {
    const writer = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: false,
      workspaceKind: "ORGANIZATION",
      packageProducesOperationalConditions: true,
      memberCount: 6,
    });
    expect(writer.OPERATIONS_ACKNOWLEDGE).toBe(true);
    expect(writer.OPERATIONS_RESOLVE).toBe(true);
    expect(writer.OPERATIONS_ASSIGN).toBe(false);
    expect(writer.OPERATIONS_SUPPRESS).toBe(false);

    const admin = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
      workspaceKind: "ORGANIZATION",
      packageProducesOperationalConditions: true,
      memberCount: 6,
    });
    expect(admin.OPERATIONS_ASSIGN).toBe(true);
    expect(admin.OPERATIONS_SUPPRESS).toBe(true);
  });

  it("no OPERATIONS_RETRY capability exists — retry stays with the domain", () => {
    const map = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "ENTERPRISE",
      isPlatformAdmin: false,
      workspaceKind: "ORGANIZATION",
      packageProducesOperationalConditions: true,
      memberCount: 20,
    });
    expect("OPERATIONS_RETRY" in map).toBe(false);
  });
});

describe("Phase 4A — platform-health capabilities are platform-admin only", () => {
  it("a tenant OWNER holds no platform console capability", () => {
    const map = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "ENTERPRISE",
      isPlatformAdmin: false,
      workspaceKind: "ORGANIZATION",
      packageProducesOperationalConditions: true,
      memberCount: 40,
    });
    expect(map.OPS_CENTER_VIEW).toBe(false);
    expect(map.OBSERVABILITY_VIEW).toBe(false);
    expect(map.RUNBOOKS_VIEW).toBe(false);
  });

  it("a platform admin holds them", () => {
    const map = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "FREE",
      isPlatformAdmin: true,
      workspaceKind: "OWNED",
      packageProducesOperationalConditions: false,
      memberCount: 1,
    });
    expect(map.OPS_CENTER_VIEW).toBe(true);
    expect(map.OBSERVABILITY_VIEW).toBe(true);
    expect(map.RUNBOOKS_VIEW).toBe(true);
  });
});

describe("Phase 0 — enterprise authority is the contract, not the plan string", () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const base = {
    workspaceKind: "ORGANIZATION" as const,
    organizationKind: "CUSTOMER" as const,
    organizationId: "org-1",
    workspaceBillingPlan: null,
    contractReadFailed: false,
    now,
  };

  it("an ACTIVE, in-effect contract grants enterprise", () => {
    const v = deriveEnterpriseAuthority({
      ...base,
      contract: {
        status: "ACTIVE",
        effectiveAtUtc: new Date("2026-01-01T00:00:00.000Z"),
        endsAtUtc: null,
      },
    });
    expect(v.isEnterpriseCustomer).toBe(true);
    expect(v.source).toBe("contract");
  });

  it("a TERMINATED contract does NOT, even with an ENTERPRISE plan string", () => {
    const v = deriveEnterpriseAuthority({
      ...base,
      workspaceBillingPlan: "ENTERPRISE",
      contract: {
        status: "TERMINATED",
        effectiveAtUtc: new Date("2026-01-01T00:00:00.000Z"),
        endsAtUtc: null,
      },
    });
    // The contract is the authority. A stale plan string cannot override it.
    expect(v.isEnterpriseCustomer).toBe(false);
    expect(v.source).toBe("contract");
  });

  it("an expired contract window does NOT grant enterprise", () => {
    const v = deriveEnterpriseAuthority({
      ...base,
      contract: {
        status: "ACTIVE",
        effectiveAtUtc: new Date("2025-01-01T00:00:00.000Z"),
        endsAtUtc: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    expect(v.isEnterpriseCustomer).toBe(false);
    expect(v.contractInEffect).toBe(false);
  });

  it("PENDING_ACTIVATION does not hand out the surface before activation", () => {
    const v = deriveEnterpriseAuthority({
      ...base,
      contract: {
        status: "PENDING_ACTIVATION",
        effectiveAtUtc: null,
        endsAtUtc: null,
      },
    });
    expect(v.isEnterpriseCustomer).toBe(false);
  });

  it("LEGACY fallback applies only to an ORGANIZATION workspace", () => {
    const org = deriveEnterpriseAuthority({
      ...base,
      contract: null,
      workspaceBillingPlan: "ENTERPRISE",
    });
    expect(org.isEnterpriseCustomer).toBe(true);
    expect(org.source).toBe("legacy_plan");

    // A PERSONAL or OWNED workspace carrying a drifted ENTERPRISE plan
    // string is data drift, not a customer. Promoting it is the exact
    // "commercial upgrade becomes a silent tenancy change" failure the
    // workspaceKind migration exists to prevent.
    for (const kind of ["PERSONAL", "OWNED"] as const) {
      const v = deriveEnterpriseAuthority({
        ...base,
        workspaceKind: kind,
        organizationKind: "SYSTEM",
        contract: null,
        workspaceBillingPlan: "ENTERPRISE",
      });
      expect(v.isEnterpriseCustomer).toBe(false);
      expect(v.source).toBe("none");
    }
  });

  it("a SYSTEM organization is never an enterprise counterparty", () => {
    const v = deriveEnterpriseAuthority({
      ...base,
      organizationKind: "SYSTEM",
      contract: {
        status: "ACTIVE",
        effectiveAtUtc: null,
        endsAtUtc: null,
      },
    });
    expect(v.source).not.toBe("contract");
    expect(v.isEnterpriseCustomer).toBe(false);
  });

  it("FAILS CLOSED — a contract read failure never promotes", () => {
    const v = deriveEnterpriseAuthority({
      ...base,
      workspaceBillingPlan: "ENTERPRISE",
      contract: null,
      contractReadFailed: true,
    });
    expect(v.isEnterpriseCustomer).toBe(false);
    expect(v.source).toBe("unavailable");
  });
});
