/**
 * PHASE 12 — POINT 4, STEP 1: org-admin surface projection.
 *
 * The per-role org-admin tab-visibility matrix used to be decided in the
 * BROWSER (`apps/web/app/(app)/organizations/[id]/admin/layout.tsx`
 * `ADMIN_TABS[].roles` + `visibleAdminTabsForRole`), and it failed OPEN: while
 * `GET /v1/orgs/:id` was in flight the shell rendered the FULL tab set to
 * every role, so an ORG_MEMBER saw Billing, Security, Domains and Governance
 * until the response landed.
 *
 * Which org role may SEE which administration surface is an authorization
 * question, so the table now lives beside `checkOrgAccess` and is projected
 * onto the response the shell already consumed. This file owns the matrix
 * that the web test used to own — migrated, not rebaselined.
 *
 * Every leaf endpoint keeps its own `checkOrgAccess(minRole)` gate; the
 * projection governs what the shell renders, never what the API trusts.
 */

import { describe, expect, it } from "vitest";

import {
  ORG_ADMIN_SURFACE_ACCESS,
  ORG_ROLE_CATALOG,
  listOrgAdminSurfaces,
} from "../src/services/organization/org-access.js";
import type { OrgRole } from "../src/services/organization/organization-resolver.service.js";

/** Every org role, from the canonical precedence catalog. */
const ALL_ORG_ROLES: ReadonlyArray<OrgRole> = ORG_ROLE_CATALOG.map(
  (r) => r.id,
);

/**
 * The canonical org-admin surface vocabulary, in tab-bar order. The SAME
 * literal is pinned browser-side against `ADMIN_TABS.map((t) => t.id)` in
 * apps/web/__tests__/enterprise-admin-tabs-visibility.test.ts, so neither side
 * can gain or lose a surface without the other failing.
 */
const CANONICAL_ORG_ADMIN_SURFACES = [
  "overview",
  "members",
  "roles",
  "departments",
  "integrations",
  "billing",
  "security",
  "domains",
  "governance",
  "access-reviews",
  "retention",
  "bulk-invite",
  "reports",
  "readiness",
  "audit",
  "trust",
];

const GOVERNANCE_FAMILY = ["governance", "retention", "access-reviews"];

describe("org-admin surface projection — vocabulary", () => {
  it("declares exactly the canonical surface vocabulary, in tab-bar order", () => {
    expect(ORG_ADMIN_SURFACE_ACCESS.map((s) => s.id)).toEqual(
      CANONICAL_ORG_ADMIN_SURFACES,
    );
  });

  it("ORG_OWNER and ORG_ADMIN see every surface", () => {
    expect(listOrgAdminSurfaces("ORG_OWNER")).toEqual(
      CANONICAL_ORG_ADMIN_SURFACES,
    );
    expect(listOrgAdminSurfaces("ORG_ADMIN")).toEqual(
      CANONICAL_ORG_ADMIN_SURFACES,
    );
  });

  it("every surface is visible to at least one role, and names only real roles", () => {
    const roleSet = new Set<string>(ALL_ORG_ROLES);
    for (const surface of ORG_ADMIN_SURFACE_ACCESS) {
      expect(
        surface.roles.length,
        `${surface.id} must be visible to some role`,
      ).toBeGreaterThan(0);
      for (const role of surface.roles) {
        expect(roleSet.has(role), `${surface.id} names unknown role ${role}`).toBe(
          true,
        );
      }
    }
  });
});

describe("org-admin surface projection — per-role matrix", () => {
  it("ORG_SECURITY_ADMIN sees security + domains but NOT billing", () => {
    const ids = listOrgAdminSurfaces("ORG_SECURITY_ADMIN");
    expect(ids).toContain("security");
    expect(ids).toContain("domains");
    expect(ids).toContain("overview");
    expect(ids).not.toContain("billing");
  });

  it("ORG_BILLING_ADMIN sees billing but NOT security / domains", () => {
    const ids = listOrgAdminSurfaces("ORG_BILLING_ADMIN");
    expect(ids).toContain("billing");
    expect(ids).toContain("overview");
    expect(ids).not.toContain("security");
    expect(ids).not.toContain("domains");
  });

  it("ORG_AUDITOR sees audit + overview and no admin-only mutation surfaces", () => {
    const ids = listOrgAdminSurfaces("ORG_AUDITOR");
    expect(ids).toContain("audit");
    expect(ids).toContain("overview");
    expect(ids).not.toContain("departments");
    expect(ids).not.toContain("integrations");
  });

  it("ORG_MEMBER is minimal — read-only reference surfaces only", () => {
    const ids = listOrgAdminSurfaces("ORG_MEMBER");
    for (const hidden of [
      "departments",
      "integrations",
      "billing",
      "security",
      "domains",
      "governance",
      "access-reviews",
      "retention",
      "bulk-invite",
      "reports",
      "readiness",
      "members",
    ]) {
      expect(ids, `${hidden} must be hidden for a plain member`).not.toContain(
        hidden,
      );
    }
    expect(ids).toContain("overview");
    expect(ids).toContain("roles");
    expect(ids).toContain("audit");
    expect(ids).toContain("trust");
  });
});

describe("org-admin surface projection — governance family (SCOPE-K)", () => {
  it("OWNER and ADMIN see every governance-family surface", () => {
    for (const role of ["ORG_OWNER", "ORG_ADMIN"] as const) {
      const ids = listOrgAdminSurfaces(role);
      for (const surface of GOVERNANCE_FAMILY) {
        expect(ids, `${role} must see ${surface}`).toContain(surface);
      }
    }
  });

  it("SECURITY_ADMIN sees the governance family (security oversight)", () => {
    const ids = listOrgAdminSurfaces("ORG_SECURITY_ADMIN");
    for (const surface of GOVERNANCE_FAMILY) {
      expect(ids).toContain(surface);
    }
  });

  it("AUDITOR has read-only governance + audit visibility", () => {
    const ids = listOrgAdminSurfaces("ORG_AUDITOR");
    for (const surface of GOVERNANCE_FAMILY) {
      expect(ids).toContain(surface);
    }
    expect(ids).toContain("audit");
  });

  it("BILLING_ADMIN is EXCLUDED from every governance-family surface", () => {
    const ids = listOrgAdminSurfaces("ORG_BILLING_ADMIN");
    for (const surface of GOVERNANCE_FAMILY) {
      expect(ids).not.toContain(surface);
    }
  });

  it("MEMBER is EXCLUDED from every governance-family surface", () => {
    const ids = listOrgAdminSurfaces("ORG_MEMBER");
    for (const surface of GOVERNANCE_FAMILY) {
      expect(ids).not.toContain(surface);
    }
  });
});

describe("org-admin surface projection — structural invariants", () => {
  it("is monotonic — a full admin's set is a superset of every other role's", () => {
    const adminIds = new Set(listOrgAdminSurfaces("ORG_ADMIN"));
    for (const role of ALL_ORG_ROLES) {
      for (const id of listOrgAdminSurfaces(role)) {
        expect(
          adminIds.has(id),
          `role ${role} sees ${id} that ORG_ADMIN does not`,
        ).toBe(true);
      }
    }
  });

  it("preserves the canonical order for every role", () => {
    for (const role of ALL_ORG_ROLES) {
      const ids = listOrgAdminSurfaces(role);
      const expected = CANONICAL_ORG_ADMIN_SURFACES.filter((id) =>
        ids.includes(id),
      );
      expect(ids).toEqual(expected);
    }
  });
});
