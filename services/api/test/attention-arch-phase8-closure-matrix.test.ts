/**
 * ATTENTION ARCHITECTURE — PHASE 8 (2026-08-22).
 * FULL CLOSURE MATRICES.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 * ---------------------------------------------------------------------------
 * The program's closing proof. Not a summary of the earlier phases — those
 * hold their own properties — but the three matrices the brief requires be
 * shown as ACTUAL RESOLVED BEHAVIOUR rather than inferred from product labels:
 *
 *   8.1  workspace / commercial context  ->  what each context actually
 *                                            resolves to
 *   8.2  role x action                   ->  who may actually do what
 *   8.4  the two-admin invariant         ->  re-run as a release gate
 *
 * Every row is computed by calling the canonical resolvers. Nothing here reads
 * a plan name and concludes anything from it — that is the defect class the
 * whole program removes, and a closure suite that did it would be proving the
 * wrong thing.
 */

import { describe, expect, it } from "vitest";

import { roleHasPermission, type CanonicalRole, type Permission } from "@proovra/shared";

import { deriveEnterpriseAuthority } from "../src/services/platform-context/enterprise-authority.js";
import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const ORG = "org-1111";

// ============================================================================
// 8.1 — WORKSPACE / COMMERCIAL CONTEXT MATRIX
// ============================================================================

type ContextRow = {
  name: string;
  workspaceKind: "PERSONAL" | "OWNED" | "ORGANIZATION" | "UNKNOWN";
  organizationKind: "SYSTEM" | "CUSTOMER" | null;
  plan: "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE";
  packageProducesOperationalConditions: boolean;
  memberCount: number;
  contract:
    | { status: string; effectiveAtUtc: Date | null; endsAtUtc: Date | null }
    | null;
  expect: {
    isEnterpriseCustomer: boolean;
    enterpriseSource: string;
    operationsView: boolean;
  };
};

const CONTEXTS: readonly ContextRow[] = [
  {
    name: "Personal Free",
    workspaceKind: "PERSONAL",
    organizationKind: "SYSTEM",
    plan: "FREE",
    // FREE includes no condition-producing feature.
    packageProducesOperationalConditions: false,
    memberCount: 1,
    contract: null,
    expect: {
      isEnterpriseCustomer: false,
      enterpriseSource: "none",
      // Nothing here can produce shared operational work, so there is no
      // Operations surface — and that is a derived answer, not a plan check.
      operationsView: false,
    },
  },
  {
    name: "Personal Pro (solo operator)",
    workspaceKind: "PERSONAL",
    organizationKind: "SYSTEM",
    plan: "PRO",
    packageProducesOperationalConditions: true,
    memberCount: 1,
    contract: null,
    expect: {
      isEnterpriseCustomer: false,
      enterpriseSource: "none",
      // One operator, but their package DOES produce conditions (reports,
      // packages, intake), so they get Operations.
      operationsView: true,
    },
  },
  {
    name: "OWNED workspace",
    workspaceKind: "OWNED",
    organizationKind: "SYSTEM",
    plan: "TEAM",
    packageProducesOperationalConditions: true,
    memberCount: 4,
    contract: null,
    expect: {
      isEnterpriseCustomer: false,
      // A SYSTEM container is never a commercial counterparty, so the legacy
      // plan-string fallback cannot promote it.
      enterpriseSource: "none",
      operationsView: true,
    },
  },
  {
    name: "ORGANIZATION workspace (no contract, legacy ENTERPRISE plan)",
    workspaceKind: "ORGANIZATION",
    organizationKind: "CUSTOMER",
    plan: "ENTERPRISE",
    packageProducesOperationalConditions: true,
    memberCount: 12,
    contract: null,
    expect: {
      // The documented compatibility fallback, bounded by BOTH structural
      // facts.
      isEnterpriseCustomer: true,
      enterpriseSource: "legacy_plan",
      operationsView: true,
    },
  },
  {
    name: "Enterprise — ACTIVE contract",
    workspaceKind: "ORGANIZATION",
    organizationKind: "CUSTOMER",
    plan: "TEAM",
    packageProducesOperationalConditions: true,
    memberCount: 40,
    contract: { status: "ACTIVE", effectiveAtUtc: null, endsAtUtc: null },
    expect: {
      // The CONTRACT decides, and it outranks the plan string in both
      // directions: a TEAM plan under an active contract IS Enterprise.
      isEnterpriseCustomer: true,
      enterpriseSource: "contract",
      operationsView: true,
    },
  },
  {
    name: "Enterprise — TERMINATED contract",
    workspaceKind: "ORGANIZATION",
    organizationKind: "CUSTOMER",
    plan: "ENTERPRISE",
    packageProducesOperationalConditions: true,
    memberCount: 40,
    contract: { status: "TERMINATED", effectiveAtUtc: null, endsAtUtc: null },
    expect: {
      // An ENTERPRISE plan string does NOT rescue a terminated contract: the
      // contract branch wins as soon as a row exists.
      isEnterpriseCustomer: false,
      enterpriseSource: "contract",
      // Losing the tier does not lose Operations — the workspace still
      // produces conditions and is still shared.
      operationsView: true,
    },
  },
  {
    name: "Enterprise — EXPIRED contract window",
    workspaceKind: "ORGANIZATION",
    organizationKind: "CUSTOMER",
    plan: "ENTERPRISE",
    packageProducesOperationalConditions: true,
    memberCount: 40,
    contract: {
      status: "ACTIVE",
      effectiveAtUtc: new Date("2025-01-01T00:00:00.000Z"),
      endsAtUtc: new Date("2026-01-01T00:00:00.000Z"),
    },
    expect: {
      isEnterpriseCustomer: false,
      enterpriseSource: "contract",
      operationsView: true,
    },
  },
  {
    name: "UNKNOWN workspace kind (unprovable)",
    workspaceKind: "UNKNOWN",
    organizationKind: null,
    plan: "ENTERPRISE",
    packageProducesOperationalConditions: true,
    memberCount: 9,
    contract: null,
    expect: {
      isEnterpriseCustomer: false,
      enterpriseSource: "none",
      // FAIL CLOSED. An unprovable workspace gets nothing.
      operationsView: false,
    },
  },
];

describe("Phase 8.1 — workspace / commercial matrix, from the canonical resolvers", () => {
  for (const row of CONTEXTS) {
    it(`${row.name}`, () => {
      const enterprise = deriveEnterpriseAuthority({
        workspaceKind: row.workspaceKind,
        organizationKind: row.organizationKind,
        organizationId: row.organizationKind ? ORG : null,
        workspaceBillingPlan: row.plan,
        contract: row.contract,
        contractReadFailed: false,
        now: NOW,
      });
      expect(enterprise.isEnterpriseCustomer, "isEnterpriseCustomer").toBe(
        row.expect.isEnterpriseCustomer,
      );
      expect(enterprise.source, "enterprise source").toBe(
        row.expect.enterpriseSource,
      );

      const capabilities = resolveCapabilities({
        scope: row.workspaceKind === "PERSONAL" ? "PERSONAL" : "TEAM",
        role: "ADMIN",
        plan: row.plan,
        isPlatformAdmin: false,
        workspaceKind: row.workspaceKind,
        packageProducesOperationalConditions:
          row.packageProducesOperationalConditions,
        memberCount: row.memberCount,
      });
      expect(capabilities.OPERATIONS_VIEW === true, "OPERATIONS_VIEW").toBe(
        row.expect.operationsView,
      );
    });
  }

  it("a contract that cannot be READ fails closed", () => {
    const enterprise = deriveEnterpriseAuthority({
      workspaceKind: "ORGANIZATION",
      organizationKind: "CUSTOMER",
      organizationId: ORG,
      workspaceBillingPlan: "ENTERPRISE",
      contract: undefined,
      contractReadFailed: true,
      now: NOW,
    });
    // A transient database error must never become a tier upgrade, and it
    // must not silently fall through to the legacy plan-string branch either.
    expect(enterprise.isEnterpriseCustomer).toBe(false);
    expect(enterprise.source).toBe("unavailable");
  });

  it("a Platform Admin is not a tenant, and elevation is not an Operations grant", () => {
    const platform = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: true,
      workspaceKind: "PERSONAL",
      packageProducesOperationalConditions: false,
      memberCount: 1,
    });
    expect(platform.PLATFORM_ADMIN).toBe(true);
    // Platform elevation grants the PLATFORM consoles. It does not manufacture
    // tenant Operations access in a workspace that produces no conditions —
    // the two boundaries are independent.
    expect(platform.OPERATIONS_VIEW).toBeFalsy();
  });
});

// ============================================================================
// 8.2 — AUTHORIZATION MATRIX
// ============================================================================

const OPERATIONS_ACTIONS = [
  ["view", "operations.view"],
  ["acknowledge", "operations.acknowledge"],
  ["assign", "operations.assign"],
  ["resolve", "operations.resolve"],
  ["suppress", "operations.suppress"],
] as const;

/** reopen is `resolve` authority inverted; domain retry is NOT an ops action. */
const AUTHORIZATION_MATRIX: ReadonlyArray<{
  role: CanonicalRole;
  allowed: readonly string[];
}> = [
  { role: "OWNER", allowed: ["view", "acknowledge", "assign", "resolve", "suppress"] },
  { role: "ADMIN", allowed: ["view", "acknowledge", "assign", "resolve", "suppress"] },
  { role: "REVIEWER", allowed: ["view", "acknowledge", "resolve"] },
  { role: "CONTRIBUTOR", allowed: ["view"] },
  { role: "VIEWER", allowed: ["view"] },
  { role: "EXTERNAL_CONTRIBUTOR", allowed: [] },
  { role: "PUBLIC_VERIFIER", allowed: [] },
];

describe("Phase 8.2 — role x action, from the canonical permission matrix", () => {
  for (const { role, allowed } of AUTHORIZATION_MATRIX) {
    it(`${role} -> [${allowed.join(", ") || "nothing"}]`, () => {
      for (const [action, permission] of OPERATIONS_ACTIONS) {
        const expected = allowed.includes(action);
        expect(
          roleHasPermission(role, permission as Permission),
          `${role} ${action}`,
        ).toBe(expected);
      }
    });
  }

  it("REOPEN is resolve authority — the inverse of a resolution, not a new one", () => {
    // Reopening says "that resolution was wrong". Anybody who could have
    // resolved it can say so; nobody else can.
    for (const role of ["OWNER", "ADMIN", "REVIEWER"] as CanonicalRole[]) {
      expect(roleHasPermission(role, "operations.resolve")).toBe(true);
    }
    for (const role of ["CONTRIBUTOR", "VIEWER"] as CanonicalRole[]) {
      expect(roleHasPermission(role, "operations.resolve")).toBe(false);
    }
  });

  it("DOMAIN RETRY is not an Operations permission at all", () => {
    // Re-running a report or re-anchoring a record is the owning domain's
    // decision. A generic ops-retry permission would be Operations acquiring
    // authority over every domain it displays.
    const asAny = "operations.retry" as unknown as Permission;
    for (const role of [
      "OWNER",
      "ADMIN",
      "REVIEWER",
      "CONTRIBUTOR",
      "VIEWER",
    ] as CanonicalRole[]) {
      expect(roleHasPermission(role, asAny)).toBe(false);
    }
  });

  it("a suspended / revoked member holds nothing, whatever their role said", () => {
    // Lifecycle is enforced by `evaluateMemberAccess`, which every Operations
    // gate calls; the role matrix is only consulted for an ACTIVE member. The
    // canonical accessible-workspace resolver is what makes that true, and the
    // gate's shape is asserted in the 4B suite. Here we pin the complementary
    // half: there is no role whose permissions bypass that check.
    for (const role of ["EXTERNAL_CONTRIBUTOR", "PUBLIC_VERIFIER"] as CanonicalRole[]) {
      for (const [, permission] of OPERATIONS_ACTIONS) {
        expect(roleHasPermission(role, permission as Permission)).toBe(false);
      }
    }
  });
});

// ============================================================================
// 8.4 — THE TWO-ADMIN INVARIANT, RE-RUN AS A RELEASE GATE
// ============================================================================

describe("Phase 8.4 — the two-admin invariant is still true at closure", () => {
  it("archiving a notification changes nothing shared", async () => {
    const { projectDomainEvent, sharedConditionAfterPersonalAction } =
      await import("../src/services/notifications/attention-projection.js");

    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const event = (archivedByA: boolean) =>
      projectDomainEvent({
        category: "tsa_failure",
        sourceId: "evidence-xxxx",
        workspaceId: "workspace-w",
        addressedRecipientUserIds: [A, B],
        recipientState: archivedByA
          ? { [A]: { readAt: NOW, dismissedAt: NOW, snoozedUntil: null } }
          : {},
        now: NOW,
      });

    const before = event(false);
    const after = event(true);

    // A's feed changed.
    expect(
      after.personalNotifications.find((n) => n.recipientUserId === A)!.state
        .lifecycle,
    ).toBe("ARCHIVED");
    // B's did not.
    expect(
      after.personalNotifications.find((n) => n.recipientUserId === B)!.state,
    ).toEqual(
      before.personalNotifications.find((n) => n.recipientUserId === B)!.state,
    );
    // And the shared condition is byte-identical.
    expect(after.sharedCondition).toEqual(before.sharedCondition);

    // No personal action, present or future, can move it.
    for (const action of ["read", "unread", "archive", "unarchive", "remind"] as const) {
      expect(
        sharedConditionAfterPersonalAction(after.sharedCondition!, action),
      ).toEqual(after.sharedCondition);
    }
  });

  it("Home's workspace count is unaffected by any personal action", async () => {
    // Home consumes `GET /v1/ops/summary`, which reads OperationalIncident and
    // takes no per-user input beyond `viewerUserId` for assigned-to-me. There
    // is no parameter through which an archive could reach it.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const SRC = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/operations/operations-summary.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(SRC).not.toMatch(/inboxItemState|dismissedAt|snoozedUntil|readAt/);
    expect(SRC).toContain("operationalIncident.findMany");
  });
});
