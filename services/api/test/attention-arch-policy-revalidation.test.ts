/**
 * ATTENTION ARCHITECTURE — POLICY REVALIDATION (2026-08-22).
 *
 * Two policy decisions taken in the classification pass are re-proven here
 * against the FULL product matrix rather than the handful of cases that
 * happened to be convenient.
 *
 * ---------------------------------------------------------------------------
 * PART A — THE SIX SEPARATE AUTHORITIES
 * ---------------------------------------------------------------------------
 * These are six different questions with six different answers, and the
 * defect this program exists to fix began with two of them being treated as
 * one:
 *
 *   workspaceKind        STRUCTURAL   what kind of workspace is this
 *   OrganizationKind     STRUCTURAL   internal container vs real customer
 *   Entitlement          COMMERCIAL   what the ACCOUNT bought
 *   billingPlan          COMMERCIAL   what this WORKSPACE's package includes
 *   EnterpriseContract   COMMERCIAL   what the CUSTOMER ORG contracted for
 *   capabilities         DERIVED      what this actor may do here
 *
 * The invariant that matters most: a COMMERCIAL fact may never change a
 * STRUCTURAL one. An ENTERPRISE plan string on a PERSONAL workspace is data
 * drift; it must not make that workspace an enterprise customer, because the
 * next thing that follows from "enterprise" is a different tenancy model.
 *
 * ---------------------------------------------------------------------------
 * PART B — OPERATIONS_VIEW IS A CAPABILITY, NOT A SECOND PLAN ENGINE
 * ---------------------------------------------------------------------------
 * Every case below states WHY the answer is what it is, because the point of
 * the rule is that the tier behaviour is a CONSEQUENCE of "can this workspace
 * produce operational conditions", never a hardcoded plan list.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";
import { deriveEnterpriseAuthority } from "../src/services/platform-context/enterprise-authority.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const PAST = new Date("2025-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");

// ===========================================================================
// PART A — ENTERPRISE COMMERCIAL AUTHORITY, all nine required scenarios
// ===========================================================================

describe("Enterprise authority — the nine required scenarios", () => {
  const customerOrg = {
    workspaceKind: "ORGANIZATION" as const,
    organizationKind: "CUSTOMER" as const,
    organizationId: "org-1",
    contractReadFailed: false,
    now: NOW,
  };

  it("1. CUSTOMER org + ACTIVE contract → enterprise (source: contract)", () => {
    const v = deriveEnterpriseAuthority({
      ...customerOrg,
      workspaceBillingPlan: null,
      contract: { status: "ACTIVE", effectiveAtUtc: PAST, endsAtUtc: null },
    });
    expect(v.isEnterpriseCustomer).toBe(true);
    expect(v.source).toBe("contract");
    expect(v.contractInEffect).toBe(true);
  });

  it("2. CUSTOMER org + EXPIRED contract → NOT enterprise", () => {
    const v = deriveEnterpriseAuthority({
      ...customerOrg,
      workspaceBillingPlan: null,
      contract: { status: "ACTIVE", effectiveAtUtc: PAST, endsAtUtc: PAST },
    });
    expect(v.isEnterpriseCustomer).toBe(false);
    expect(v.source).toBe("contract");
    expect(v.contractInEffect).toBe(false);
  });

  it("3. CUSTOMER org + FUTURE contract → NOT enterprise until it starts", () => {
    const v = deriveEnterpriseAuthority({
      ...customerOrg,
      workspaceBillingPlan: null,
      contract: { status: "ACTIVE", effectiveAtUtc: FUTURE, endsAtUtc: null },
    });
    expect(v.isEnterpriseCustomer).toBe(false);
    expect(v.contractInEffect).toBe(false);
  });

  it("4. CUSTOMER org + no contract + LEGACY enterprise plan → enterprise, flagged legacy", () => {
    const v = deriveEnterpriseAuthority({
      ...customerOrg,
      workspaceBillingPlan: "ENTERPRISE",
      contract: null,
    });
    expect(v.isEnterpriseCustomer).toBe(true);
    // The provenance is the point: this is the ONLY path that is not a
    // contract, and it is labelled so it can be found and removed.
    expect(v.source).toBe("legacy_plan");
  });

  it("5. CUSTOMER org + no contract + NON-enterprise plan → not enterprise", () => {
    for (const plan of ["FREE", "PAYG", "PRO", "TEAM"] as const) {
      const v = deriveEnterpriseAuthority({
        ...customerOrg,
        workspaceBillingPlan: plan,
        contract: null,
      });
      expect(v.isEnterpriseCustomer, `plan ${plan}`).toBe(false);
      expect(v.source).toBe("none");
    }
  });

  it("6. SYSTEM org + enterprise-looking plan → NOT enterprise", () => {
    // A SYSTEM organization is the internal 1:1 bootstrap container every
    // workspace gets. It is never a commercial counterparty.
    const v = deriveEnterpriseAuthority({
      workspaceKind: "ORGANIZATION",
      organizationKind: "SYSTEM",
      organizationId: "org-sys",
      workspaceBillingPlan: "ENTERPRISE",
      contract: null,
      contractReadFailed: false,
      now: NOW,
    });
    expect(v.isEnterpriseCustomer).toBe(false);
  });

  it("7. PERSONAL workspace + enterprise-looking plan → NOT enterprise", () => {
    const v = deriveEnterpriseAuthority({
      workspaceKind: "PERSONAL",
      organizationKind: "SYSTEM",
      organizationId: "org-sys",
      workspaceBillingPlan: "ENTERPRISE",
      contract: null,
      contractReadFailed: false,
      now: NOW,
    });
    expect(v.isEnterpriseCustomer).toBe(false);
  });

  it("8. OWNED workspace + enterprise-looking plan → NOT enterprise", () => {
    const v = deriveEnterpriseAuthority({
      workspaceKind: "OWNED",
      organizationKind: "SYSTEM",
      organizationId: "org-sys",
      workspaceBillingPlan: "ENTERPRISE",
      contract: null,
      contractReadFailed: false,
      now: NOW,
    });
    expect(v.isEnterpriseCustomer).toBe(false);
  });

  it("9. contract READ FAILURE → fails closed, never promotes", () => {
    const v = deriveEnterpriseAuthority({
      ...customerOrg,
      workspaceBillingPlan: "ENTERPRISE",
      contract: null,
      contractReadFailed: true,
    });
    expect(v.isEnterpriseCustomer).toBe(false);
    expect(v.source).toBe("unavailable");
  });

  it("INVARIANT — a commercial upgrade never changes structural identity", () => {
    // Same workspace, same organization, only the plan string differs.
    // The STRUCTURAL kind is an input, never an output: nothing the
    // resolver returns can reclassify the workspace.
    const base = {
      organizationKind: "SYSTEM" as const,
      organizationId: "org-sys",
      contract: null,
      contractReadFailed: false,
      now: NOW,
    };
    for (const kind of ["PERSONAL", "OWNED"] as const) {
      const free = deriveEnterpriseAuthority({
        ...base,
        workspaceKind: kind,
        workspaceBillingPlan: "FREE",
      });
      const ent = deriveEnterpriseAuthority({
        ...base,
        workspaceKind: kind,
        workspaceBillingPlan: "ENTERPRISE",
      });
      // Buying a plan cannot turn a PERSONAL/OWNED workspace into an
      // enterprise customer context.
      expect(free.isEnterpriseCustomer).toBe(false);
      expect(ent.isEnterpriseCustomer).toBe(false);
    }
  });
});

describe("Enterprise authority — the legacy fallback is bounded and removable", () => {
  it("is reachable ONLY when a CUSTOMER org has no contract row", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/platform-context/enterprise-authority.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Exactly one reference to the legacy key set outside its declaration —
    // the single fallback branch. A second consumer would be a second
    // permanent enterprise authority, which is the thing to prevent.
    const refs = src.match(/LEGACY_ENTERPRISE_PLAN_KEYS/g) ?? [];
    expect(refs.length).toBe(2); // declaration + the one branch
    // Its removal condition is written down.
    expect(src).toMatch(/contract backfill/i);
  });
});

// ===========================================================================
// PART B — OPERATIONS_VIEW MATRIX, with the reason for every verdict
// ===========================================================================

/**
 * Each row states the CAUSE, so a future reader can see that the tier
 * behaviour falls out of the rule instead of being asserted alongside it.
 */
const OPERATIONS_MATRIX: ReadonlyArray<{
  label: string;
  kind: "PERSONAL" | "OWNED" | "ORGANIZATION" | "UNKNOWN";
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  produces: boolean;
  members: number;
  expected: boolean;
  why: string;
}> = [
  {
    label: "Personal Free",
    kind: "PERSONAL", role: "OWNER", produces: false, members: 1,
    expected: false,
    why: "FREE includes no reports/packages/intake/reviews and there is one operator — nothing shared to coordinate and no condition-producing feature. Integrity failures reach the user as a notification plus the Evidence record's own remediation path.",
  },
  {
    label: "Personal Pro",
    kind: "PERSONAL", role: "OWNER", produces: true, members: 1,
    expected: true,
    why: "PRO includes reports, verification packages and intake — conditions that outlive one record view and need a resolution state. Value is the lifecycle, not the sharing.",
  },
  {
    label: "OWNED self-service, free package, sole member",
    kind: "OWNED", role: "OWNER", produces: false, members: 1,
    expected: false,
    why: "Neither qualifier met: no condition-producing feature and no second operator. Structural kind alone never grants Operations.",
  },
  {
    label: "OWNED self-service, paid package, sole member",
    kind: "OWNED", role: "OWNER", produces: true, members: 1,
    expected: true,
    why: "The package produces conditions, so there is a queue with a lifecycle even for one operator.",
  },
  {
    label: "OWNED shared, free package",
    kind: "OWNED", role: "MEMBER", produces: false, members: 3,
    expected: true,
    why: "Two or more operators means 'has anyone dealt with this?' needs shared state, whatever the package includes.",
  },
  {
    label: "ORGANIZATION non-enterprise",
    kind: "ORGANIZATION", role: "ADMIN", produces: true, members: 5,
    expected: true,
    why: "Both qualifiers met. Enterprise contract state is irrelevant to VISIBILITY — it scales density, not access.",
  },
  {
    label: "ORGANIZATION enterprise (active contract)",
    kind: "ORGANIZATION", role: "OWNER", produces: true, members: 40,
    expected: true,
    why: "Same rule, same answer. Nothing in OPERATIONS_VIEW reads the contract.",
  },
  {
    label: "ORGANIZATION enterprise (INACTIVE contract)",
    kind: "ORGANIZATION", role: "OWNER", produces: true, members: 40,
    expected: true,
    why: "DELIBERATE: losing an enterprise contract must not blind operators to unresolved integrity conditions in evidence they still hold. The contract governs enterprise-tier FEATURES, not whether a workspace may see its own operational truth.",
  },
  {
    label: "UNKNOWN kind (unprovable workspace)",
    kind: "UNKNOWN", role: "OWNER", produces: true, members: 10,
    expected: false,
    why: "Fails closed. An unprovable workspace grants nothing.",
  },
];

describe("OPERATIONS_VIEW — full product matrix with stated cause", () => {
  for (const row of OPERATIONS_MATRIX) {
    it(`${row.label} → OPERATIONS_VIEW=${row.expected} — ${row.why.slice(0, 60)}…`, () => {
      const map = resolveCapabilities({
        scope: row.kind === "PERSONAL" ? "PERSONAL" : "TEAM",
        role: row.role,
        plan: null,
        isPlatformAdmin: false,
        workspaceKind: row.kind,
        packageProducesOperationalConditions: row.produces,
        memberCount: row.members,
      });
      expect(map.OPERATIONS_VIEW, row.why).toBe(row.expected);
    });
  }

  it("the rule reads NO plan name — visibility is derived, never enumerated", () => {
    // Same inputs, every plan string. The plan must not move the answer.
    const answers = new Set<boolean>();
    for (const plan of ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"] as const) {
      const map = resolveCapabilities({
        scope: "TEAM",
        role: "ADMIN",
        plan,
        isPlatformAdmin: false,
        workspaceKind: "OWNED",
        packageProducesOperationalConditions: false,
        memberCount: 1,
      });
      answers.add(map.OPERATIONS_VIEW);
    }
    expect(answers.size, "plan string changed OPERATIONS_VIEW").toBe(1);
    expect([...answers][0]).toBe(false);
  });

  it("platform admin does NOT gain tenant operational mutation by elevation", () => {
    const map = resolveCapabilities({
      scope: "TEAM",
      role: null, // no membership in this workspace
      plan: "ENTERPRISE",
      isPlatformAdmin: true,
      workspaceKind: "ORGANIZATION",
      packageProducesOperationalConditions: true,
      memberCount: 12,
    });
    // Elevation grants the PLATFORM consoles, never workspace mutation.
    expect(map.PLATFORM_ADMIN).toBe(true);
    expect(map.OPERATIONS_ACKNOWLEDGE).toBe(false);
    expect(map.OPERATIONS_ASSIGN).toBe(false);
    expect(map.OPERATIONS_RESOLVE).toBe(false);
    expect(map.OPERATIONS_SUPPRESS).toBe(false);
  });
});

// ===========================================================================
// PART C — NO SECOND OPERATIONS-VISIBILITY AUTHORITY IN THE WEB TREE
// ===========================================================================

describe("Operations visibility has ONE authority", () => {
  const WEB = fileURLToPath(new URL("../../../apps/web", import.meta.url));

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next" || e === "__tests__") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e)) out.push(p);
    }
    return out;
  }

  it("no page or component decides Operations visibility from a plan name or member count", () => {
    const offenders: string[] = [];
    for (const file of walk(WEB)) {
      const src = readFileSync(file, "utf8");
      // Only interested in files that mention Operations visibility at all.
      if (!/OPERATIONS_VIEW|operationsVisible|showOperations/.test(src)) continue;
      // …and then reach for a commercial or headcount shortcut beside it.
      if (
        /plan\s*===\s*["'](PRO|ENTERPRISE|TEAM)["']/.test(src) ||
        /memberCount\s*>\s*1/.test(src)
      ) {
        offenders.push(file.replace(WEB, "apps/web"));
      }
    }
    expect(
      offenders,
      "a surface is re-deriving Operations visibility instead of reading the resolved capability",
    ).toEqual([]);
  });
});
