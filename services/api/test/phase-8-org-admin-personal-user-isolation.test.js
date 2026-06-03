/**
 * Phase 8 — Personal-user isolation from org-admin surfaces.
 *
 * Pins Phase 8 success criterion #10 (personal users unaffected) at
 * the SOURCE-CONTRACT level. A user holding ONLY a Personal Workspace
 * (no organization membership) must:
 *
 *   (a) Not see /organizations/[id]/admin in any persona's primary
 *       navigation projection.
 *   (b) Hit the canonical PageRouteGate deny path on direct URL access
 *       (NOT a 200 with empty content).
 *   (c) Not see org-admin routes surfaced by the command palette /
 *       /tools projection because the route's gate stops them at the
 *       PageRouteGate boundary.
 *   (d) Continue to have Team CRUD available (constitutional rule:
 *       Team works in BOTH Personal and Organization workspaces).
 *
 * Source-contract test — no DB I/O. Verifies the structural properties
 * of routeRegistry + pillarRegistry + PageRouteGate + Team product so
 * that a future PR can't silently leak org-admin into personal nav.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const WEB_ROOT = fileURLToPath(new URL("../../../apps/web", import.meta.url));
function readWeb(rel) {
    return readFileSync(resolve(WEB_ROOT, rel), "utf8");
}
const ADMIN_ROUTE_IDS = [
    "account.organization_admin",
    "account.organization_admin_overview",
    "account.organization_admin_members",
    "account.organization_admin_departments",
    "account.organization_admin_governance",
    "account.organization_admin_access_reviews",
    "account.organization_admin_retention",
    "account.organization_admin_audit",
    "account.organization_admin_security",
    "account.organization_admin_trust",
];
// ---------------------------------------------------------------------------
// (a) Primary nav projection isolation
// ---------------------------------------------------------------------------
describe("Phase 8 — admin routes never appear in the primary sidebar", () => {
    const registry = readWeb("lib/navigation/routeRegistry.ts");
    for (const id of ADMIN_ROUTE_IDS) {
        it(`${id} declares sidebarEligible=false (excluded from sidebar projection)`, () => {
            // Capture the route block.
            const block = registry.match(new RegExp(`id:\\s*"${id.replace(/\./g, "\\.")}"[\\s\\S]{0,1000}?sidebarEligible:\\s*(true|false)\\s*,`));
            expect(block, `Route ${id} not found in registry`).not.toBeNull();
            expect(block?.[0]).toMatch(/sidebarEligible:\s*false/);
        });
    }
});
describe("Phase 8 — admin routes carry no workflowTags (no persona promotion)", () => {
    const registry = readWeb("lib/navigation/routeRegistry.ts");
    for (const id of ADMIN_ROUTE_IDS) {
        it(`${id} declares empty workflowTags`, () => {
            const block = registry.match(new RegExp(`id:\\s*"${id.replace(/\./g, "\\.")}"[\\s\\S]{0,1000}?sidebarEligible:\\s*(true|false)\\s*,`));
            expect(block?.[0]).toMatch(/workflowTags:\s*\[\s*\]/);
        });
    }
});
describe("Phase 8 — admin routes are advancedByDefault (never in any persona top-N)", () => {
    const registry = readWeb("lib/navigation/routeRegistry.ts");
    for (const id of ADMIN_ROUTE_IDS) {
        it(`${id} declares advancedByDefault=true`, () => {
            const block = registry.match(new RegExp(`id:\\s*"${id.replace(/\./g, "\\.")}"[\\s\\S]{0,1000}?sidebarEligible:\\s*(true|false)\\s*,`));
            expect(block?.[0]).toMatch(/advancedByDefault:\s*true/);
        });
    }
});
// ---------------------------------------------------------------------------
// (b) Direct URL access — PageRouteGate is the deny gate
//
// Every admin page wraps in PageRouteGate. PageRouteGate consults
// resolveRouteAccess which goes through the canonical capability + active
// space resolver. A personal-only user hitting /organizations/foo/admin
// hits the org-detail API endpoint (the layout reads /v1/orgs/:id) which
// returns 403 via checkOrgAccess — i.e. the server enforces membership
// even when the route gate is permissive.
// ---------------------------------------------------------------------------
describe("Phase 8 — every admin page wraps in PageRouteGate (deny path on access)", () => {
    const adminPages = [
        "app/(app)/organizations/[id]/admin/page.tsx",
        "app/(app)/organizations/[id]/admin/overview/page.tsx",
        "app/(app)/organizations/[id]/admin/members/page.tsx",
        "app/(app)/organizations/[id]/admin/departments/page.tsx",
        "app/(app)/organizations/[id]/admin/governance/page.tsx",
        "app/(app)/organizations/[id]/admin/access-reviews/page.tsx",
        "app/(app)/organizations/[id]/admin/retention/page.tsx",
        "app/(app)/organizations/[id]/admin/audit/page.tsx",
        "app/(app)/organizations/[id]/admin/security/page.tsx",
        "app/(app)/organizations/[id]/admin/trust/page.tsx",
    ];
    for (const page of adminPages) {
        it(`${page} wraps body in <PageRouteGate routeId="..."> (denies non-members)`, () => {
            const body = readWeb(page);
            expect(body).toMatch(/<PageRouteGate\s+routeId="account\.[^"]+"/);
        });
    }
});
describe("Phase 8 — admin layout reads /v1/orgs/:id (server-side membership gate)", () => {
    it("layout uses apiFetch on /v1/orgs/${orgId} (enforces checkOrgAccess server-side)", () => {
        const layout = readWeb("app/(app)/organizations/[id]/admin/layout.tsx");
        expect(layout).toMatch(/apiFetch\(`\/v1\/orgs\/\$\{orgId\}`/);
    });
    it("layout renders a 403-aware error state with requestId surfacing", () => {
        const layout = readWeb("app/(app)/organizations/[id]/admin/layout.tsx");
        expect(layout).toMatch(/status\s*===\s*403/);
        expect(layout).toMatch(/data-testid="org-admin-error-request-id"/);
    });
});
// ---------------------------------------------------------------------------
// (c) Sidebar / persona surfaces do not surface admin routes
//
// The Phase 8 routes are sidebarEligible=false + advancedByDefault=true
// + no workflowTags, so the canonical projection pipeline can NEVER
// surface them. We additionally verify the AppSidebarV2 file does not
// hard-code an org-admin nav row.
// ---------------------------------------------------------------------------
describe("Phase 8 — AppSidebarV2 does not hard-code org-admin links", () => {
    it("the sidebar source has no /organizations/${id}/admin literal", () => {
        const sidebar = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
        // Cover both unparameterized and template-style references.
        expect(sidebar).not.toMatch(/\/organizations\/[^"`']*\/admin/);
    });
});
// ---------------------------------------------------------------------------
// (d) Team CRUD remains available in BOTH workspace kinds
//
// Constitutional rule: Team is NOT a workspace and Team works in both
// Personal Workspace and Organization Workspace. Personal users get
// /collaboration-teams just like organization users.
// ---------------------------------------------------------------------------
describe("Phase 8 — Team CRUD remains available in BOTH workspace kinds (constitutional rule 6)", () => {
    it("the Collaboration Teams index page exists", () => {
        expect(() => readWeb("app/(app)/collaboration-teams/page.tsx")).not.toThrow();
    });
    it("the Collaboration Teams detail page exists", () => {
        expect(() => readWeb("app/(app)/collaboration-teams/[teamId]/page.tsx")).not.toThrow();
    });
    it("routeRegistry exposes workspace.collaboration_teams for both Personal + Org users", () => {
        const registry = readWeb("lib/navigation/routeRegistry.ts");
        // Find the team product route block.
        const block = registry.match(/id:\s*"workspace\.collaboration_teams"[\s\S]{0,1000}?sidebarEligible:\s*(true|false)\s*,/);
        expect(block, "workspace.collaboration_teams not found in registry").not
            .toBeNull();
        // Must not be ORGANIZATION_ONLY (Team is not org-only).
        expect(block?.[0]).not.toMatch(/requiredActiveSpace:\s*"ORGANIZATION_ONLY"/);
    });
});
