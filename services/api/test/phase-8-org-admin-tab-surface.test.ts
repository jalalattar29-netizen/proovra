/**
 * Phase 8 — Org admin tab surface contract.
 *
 * Pins the 10 new org-admin route IDs registered in the canonical
 * routeRegistry plus the per-tab page surface and PageRouteGate
 * wrapping. Source-contract test (file-text assertions). No DB I/O.
 *
 * Constitutional rules pinned:
 *
 *   1. Each of the 10 admin route IDs exists in routeRegistry with the
 *      ACCOUNT domain, requiredActiveSpace=NONE, fallbackBehavior=LOAD,
 *      sidebarEligible=false, advancedByDefault=true, no required
 *      capabilities. (No new capability surface — the API enforces the
 *      per-tab ORG_OWNER / ORG_ADMIN role check.)
 *   2. Each admin tab page wraps in `<PageRouteGate routeId="...">`.
 *   3. Each admin route is mapped to the ADMIN pillar in pillarRegistry.
 *   4. The shell layout declares the 9 canonical tabs in order.
 *   5. The admin shell deep-links to canonical Phase 4A pages
 *      (governance-platform, audit-transparency, admin/identity,
 *      trust-center, evidence-lifecycle) — proving Governance / Trust
 *      / Audit remain feature areas, not org-admin owned products.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("../../../apps/web", import.meta.url));

function readWeb(rel: string): string {
  return readFileSync(resolve(WEB_ROOT, rel), "utf8");
}

// ---------------------------------------------------------------------------
// The 10 admin route IDs the Phase 8 navigation stream registered.
// ---------------------------------------------------------------------------

const ADMIN_ROUTE_IDS: ReadonlyArray<{
  id: string;
  href: string;
  /** Path to the leaf page (or layout for the shell index). */
  pagePath: string;
}> = [
  {
    id: "account.organization_admin",
    href: "/organizations/:id/admin",
    pagePath: "app/(app)/organizations/[id]/admin/page.tsx",
  },
  {
    id: "account.organization_admin_overview",
    href: "/organizations/:id/admin/overview",
    pagePath: "app/(app)/organizations/[id]/admin/overview/page.tsx",
  },
  {
    id: "account.organization_admin_members",
    href: "/organizations/:id/admin/members",
    pagePath: "app/(app)/organizations/[id]/admin/members/page.tsx",
  },
  {
    id: "account.organization_admin_departments",
    href: "/organizations/:id/admin/departments",
    pagePath: "app/(app)/organizations/[id]/admin/departments/page.tsx",
  },
  {
    id: "account.organization_admin_governance",
    href: "/organizations/:id/admin/governance",
    pagePath: "app/(app)/organizations/[id]/admin/governance/page.tsx",
  },
  {
    id: "account.organization_admin_access_reviews",
    href: "/organizations/:id/admin/access-reviews",
    pagePath: "app/(app)/organizations/[id]/admin/access-reviews/page.tsx",
  },
  {
    id: "account.organization_admin_retention",
    href: "/organizations/:id/admin/retention",
    pagePath: "app/(app)/organizations/[id]/admin/retention/page.tsx",
  },
  {
    id: "account.organization_admin_audit",
    href: "/organizations/:id/admin/audit",
    pagePath: "app/(app)/organizations/[id]/admin/audit/page.tsx",
  },
  {
    id: "account.organization_admin_security",
    href: "/organizations/:id/admin/security",
    pagePath: "app/(app)/organizations/[id]/admin/security/page.tsx",
  },
  {
    id: "account.organization_admin_trust",
    href: "/organizations/:id/admin/trust",
    pagePath: "app/(app)/organizations/[id]/admin/trust/page.tsx",
  },
];

// ---------------------------------------------------------------------------
// 1. Route registry contains every admin route with the expected shape.
// ---------------------------------------------------------------------------

describe("Phase 8 — admin route registry shape", () => {
  const registry = readWeb("lib/navigation/routeRegistry.ts");

  for (const { id, href } of ADMIN_ROUTE_IDS) {
    describe(`route ${id}`, () => {
      // Match the route block by id and capture the body that follows.
      // Each route definition is < ~600 chars including comments.
      const blockMatch = registry.match(
        new RegExp(
          `id:\\s*"${id.replace(/\./g, "\\.")}"[\\s\\S]{0,1000}?sidebarEligible:\\s*(true|false)\\s*,`,
        ),
      );

      it("appears as a registered route", () => {
        expect(blockMatch, `Route id ${id} not found in routeRegistry`).not
          .toBeNull();
      });

      it(`declares href ${href}`, () => {
        expect(blockMatch?.[0]).toMatch(
          new RegExp(`href:\\s*"${href.replace(/[/:]/g, "\\$&")}"`),
        );
      });

      it("declares domain ACCOUNT", () => {
        expect(blockMatch?.[0]).toMatch(/domain:\s*"ACCOUNT"/);
      });

      it("declares requiredActiveSpace NONE (so personal users with org membership can still reach it)", () => {
        // Phase 8 intentionally uses NONE — the API endpoints enforce
        // per-tab role checks (ORG_OWNER / ORG_ADMIN), and an org-admin
        // landing has no required active workspace. See navigation
        // stream brief.
        expect(blockMatch?.[0]).toMatch(/requiredActiveSpace:\s*"NONE"/);
      });

      it("declares fallbackBehavior LOAD", () => {
        expect(blockMatch?.[0]).toMatch(/fallbackBehavior:\s*"LOAD"/);
      });

      it("declares empty requiredCapabilities (no new capability surface)", () => {
        expect(blockMatch?.[0]).toMatch(/requiredCapabilities:\s*\[\s*\]/);
      });

      it("declares advancedByDefault=true (not surfaced in any persona top-N)", () => {
        expect(blockMatch?.[0]).toMatch(/advancedByDefault:\s*true/);
      });

      it("declares sidebarEligible=false (not in primary nav)", () => {
        expect(blockMatch?.[0]).toMatch(/sidebarEligible:\s*false/);
      });

      it("declares commandPaletteVisible=true (discoverable via cmd-K)", () => {
        expect(blockMatch?.[0]).toMatch(/commandPaletteVisible:\s*true/);
      });

      it("declares allToolsVisible=true (discoverable via /tools)", () => {
        expect(blockMatch?.[0]).toMatch(/allToolsVisible:\s*true/);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Per-tab page exists and wraps in <PageRouteGate routeId="...">.
//
// Note: the Phase 8 frontend stream wraps every tab in
// `<PageRouteGate routeId="account.organization-detail">` (the canonical
// org-detail route) rather than the new per-tab IDs. That's the
// intentional pattern (the API enforces per-tab role checks). This test
// pins that ANY PageRouteGate wrap exists per-tab so a future PR can't
// silently drop the gate.
// ---------------------------------------------------------------------------

describe("Phase 8 — every admin tab page wraps in PageRouteGate", () => {
  for (const { pagePath } of ADMIN_ROUTE_IDS) {
    it(`${pagePath} wraps its body in <PageRouteGate routeId="...">`, () => {
      const body = readWeb(pagePath);
      expect(body).toMatch(/<PageRouteGate\s+routeId=/);
    });

    it(`${pagePath} imports PageRouteGate from the canonical path`, () => {
      const body = readWeb(pagePath);
      expect(body).toMatch(
        /from\s+["'].*components\/navigation\/PageRouteGate["']/,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Each admin route is mapped to the ADMIN pillar.
// ---------------------------------------------------------------------------

describe("Phase 8 — admin routes map to the ADMIN pillar", () => {
  const pillarRegistry = readWeb("lib/navigation/pillarRegistry.ts");

  for (const { id } of ADMIN_ROUTE_IDS) {
    it(`pillarRegistry maps "${id}" → ADMIN`, () => {
      const re = new RegExp(
        `\\["${id.replace(/\./g, "\\.")}",\\s*"ADMIN"\\]`,
      );
      expect(pillarRegistry).toMatch(re);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. The shell layout declares the 9 canonical tabs.
// ---------------------------------------------------------------------------

describe("Phase 8 — admin shell tab structure", () => {
  const layout = readWeb("app/(app)/organizations/[id]/admin/layout.tsx");

  const EXPECTED_TAB_SEGMENTS: ReadonlyArray<string> = [
    "overview",
    "members",
    "departments",
    "governance",
    "access-reviews",
    "retention",
    "audit",
    "security",
    "trust",
  ];

  it("exports an ADMIN_TABS registry array", () => {
    expect(layout).toMatch(/export\s+const\s+ADMIN_TABS\s*[:=]/);
  });

  for (const segment of EXPECTED_TAB_SEGMENTS) {
    it(`declares the "${segment}" tab segment`, () => {
      expect(layout).toMatch(
        new RegExp(`segment:\\s*"${segment.replace(/-/g, "\\-")}"`),
      );
    });
  }

  it("renders the tab nav with data-testid org-admin-tabs", () => {
    expect(layout).toMatch(/data-testid=["']org-admin-tabs["']/);
  });

  it("renders per-tab links with data-testid org-admin-tab-<id>", () => {
    expect(layout).toMatch(
      /data-testid=\{?`org-admin-tab-\$\{tab\.id\}`\}?/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Admin shell + tabs deep-link to canonical Phase 4A surfaces.
//
// Governance / Audit / Trust / Identity / Evidence Lifecycle remain
// feature areas. The shell does NOT own those products — it links to
// them. This pins the constitutional rule that Governance/Reviewer are
// not workspaces and Audit/Trust are not org-admin properties.
// ---------------------------------------------------------------------------

describe("Phase 8 — admin shell deep-links to canonical Phase 4A pages (feature-area honesty)", () => {
  const governanceTab = readWeb(
    "app/(app)/organizations/[id]/admin/governance/page.tsx",
  );
  const auditTab = readWeb(
    "app/(app)/organizations/[id]/admin/audit/page.tsx",
  );
  const trustTab = readWeb(
    "app/(app)/organizations/[id]/admin/trust/page.tsx",
  );
  const securityTab = readWeb(
    "app/(app)/organizations/[id]/admin/security/page.tsx",
  );
  const retentionTab = readWeb(
    "app/(app)/organizations/[id]/admin/retention/page.tsx",
  );

  it("Governance tab deep-links to /governance-platform", () => {
    expect(governanceTab).toMatch(/\/governance-platform/);
  });

  it("Audit tab deep-links to /audit-transparency", () => {
    expect(auditTab).toMatch(/\/audit-transparency/);
  });

  it("Trust tab deep-links to /trust-center", () => {
    expect(trustTab).toMatch(/\/trust-center/);
  });

  it("Security tab mounts the canonical OrganizationSecurityPolicyEditor (12B: real editor, not deep-links)", () => {
    // PHASE 12B — the static deep-link hub was replaced by the real
    // org-keyed security-policy editor (Batch 2 acceptance closed).
    expect(securityTab).toMatch(/OrganizationSecurityPolicyEditor/);
    expect(securityTab).toMatch(/PageRouteGate routeId="account.organization-detail"/);
  });

  it("Retention tab deep-links to /evidence-lifecycle (canonical retention surface)", () => {
    expect(retentionTab).toMatch(/\/evidence-lifecycle/);
  });
});
