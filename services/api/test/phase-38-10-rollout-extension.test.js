/**
 * PHASE 38.10 — Rollout extension source-contract tests.
 *
 * Covers:
 *   1. Route registry expansion (intake_links, workflows,
 *      security_center, runbooks, escalations).
 *   2. Additional PageRouteGate migrations (workflows, intake-links,
 *      security-center, runbooks, reviewer-ops/escalations).
 *   3. CommandCenter consumes the canonical `getPersonaSectionOrder`
 *      helper for visible adaptive UX.
 *   4. Capture page consumes workflow-aware template ordering helper.
 *   5. Workflow template ordering helper is bounded + preserves count
 *      (pure partition+concat — never hides templates).
 *   6. Escalations migrated off `useTeamWorkspaceGate` (allow-list
 *      shrinkage).
 *   7. Cumulative PageRouteGate adoption ≥ 21 pages.
 *   8. Copy-safety locks hold on every newly-touched surface.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readWeb(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)), "utf8");
}
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const COMMAND_CENTER = readWeb("components/command-center/CommandCenter.tsx");
const CAPTURE = readWeb("app/(app)/capture/page.tsx");
const TEMPLATE_ORDER = readWeb("app/(app)/capture/_lib/workflowTemplateOrder.ts");
const ESCALATIONS = readWeb("app/(app)/reviewer-ops/escalations/page.tsx");
// =============================================================================
// PART 1 — Route registry expansion
// =============================================================================
describe("Phase 38.10 — route registry expansion (5 new routes)", () => {
    const NEW_ROUTES = [
        { id: "workspace.intake_links", href: "/intake-links" },
        { id: "workspace.workflows", href: "/workflows" },
        { id: "workspace.security_center", href: "/security-center" },
        { id: "platform.runbooks", href: "/ops/runbooks" },
        { id: "review.escalations", href: "/reviewer-ops/escalations" },
    ];
    for (const r of NEW_ROUTES) {
        it(`declares ${r.id} as a canonical route mapped to ${r.href}`, () => {
            expect(REGISTRY).toMatch(new RegExp(`id:\\s*"${r.id.replace(/\./g, "\\.")}"`));
            expect(REGISTRY).toMatch(new RegExp(`href:\\s*"${r.href.replace(/\//g, "\\/")}"`));
        });
    }
    it("all new routes are reachable from canonical nav (sidebar or discovery surfaces)", () => {
        // Phase IA-collapse — workspace.security_center demoted out of
        // the primary sidebar; remains in cmd-K + All Tools.
        const STILL_SIDEBAR_ELIGIBLE = [
            "workspace.intake_links",
            "workspace.workflows",
            "platform.runbooks",
            "review.escalations",
        ];
        for (const r of STILL_SIDEBAR_ELIGIBLE) {
            const block = REGISTRY.match(new RegExp(`id:\\s*"${r.replace(/\./g, "\\.")}"[\\s\\S]*?sidebarEligible:\\s*(true|false)`));
            expect(block?.[1], `${r} must be sidebarEligible`).toBe("true");
        }
        const sc = REGISTRY.match(/id:\s*"workspace\.security_center"[\s\S]*?sidebarEligible:\s*(true|false)/);
        expect(sc?.[1], "workspace.security_center is demoted from sidebar").toBe("false");
        const scCmdK = REGISTRY.match(/id:\s*"workspace\.security_center"[\s\S]*?commandPaletteVisible:\s*(true|false)/);
        expect(scCmdK?.[1], "workspace.security_center remains in cmd-K").toBe("true");
        const scAllTools = REGISTRY.match(/id:\s*"workspace\.security_center"[\s\S]*?allToolsVisible:\s*(true|false)/);
        expect(scAllTools?.[1], "workspace.security_center remains in All Tools").toBe("true");
    });
    it("review.escalations is organization-only (matches its operational scope)", () => {
        const block = REGISTRY.match(/id:\s*"review\.escalations"[\s\S]*?requiredActiveSpace:\s*"([A-Z_]+)"/);
        expect(block?.[1]).toBe("ORGANIZATION_ONLY");
    });
});
// =============================================================================
// PART 2 — Additional PageRouteGate migrations
// =============================================================================
describe("Phase 38.10 — additional PageRouteGate migrations", () => {
    const MIGRATIONS = [
        { page: "app/(app)/workflows/page.tsx", routeId: "workspace.workflows" },
        {
            page: "app/(app)/intake-links/page.tsx",
            routeId: "workspace.intake_links",
        },
        {
            page: "app/(app)/security-center/page.tsx",
            routeId: "workspace.security_center",
        },
        {
            page: "app/(app)/ops/runbooks/page.tsx",
            routeId: "platform.runbooks",
        },
        {
            page: "app/(app)/reviewer-ops/escalations/page.tsx",
            routeId: "review.escalations",
        },
    ];
    for (const entry of MIGRATIONS) {
        it(`${entry.page} wraps canonical content in <PageRouteGate routeId="${entry.routeId}">`, () => {
            const src = readWeb(entry.page);
            expect(src).toMatch(/PageRouteGate/);
            expect(src).toMatch(new RegExp(`routeId="${entry.routeId.replace(/\./g, "\\.")}"`));
            expect(src).toMatch(/from\s+["'].*navigation\/PageRouteGate["']/);
        });
    }
});
// =============================================================================
// PART 3 — Legacy gate shrinkage
// =============================================================================
describe("Phase 38.10 — legacy useTeamWorkspaceGate shrinkage", () => {
    it("reviewer-ops/escalations no longer imports useTeamWorkspaceGate", () => {
        expect(ESCALATIONS).not.toMatch(/useTeamWorkspaceGate/);
    });
    it("reviewer-ops/escalations now reads activeSpaceId from the canonical envelope", () => {
        expect(ESCALATIONS).toMatch(/useActiveSpaceId/);
    });
});
// =============================================================================
// PART 4 — Dashboard adaptive UX (client-side persona section order)
// =============================================================================
describe("Phase 38.10 — CommandCenter consumes getPersonaSectionOrder", () => {
    it("imports the canonical getPersonaSectionOrder helper", () => {
        expect(COMMAND_CENTER).toMatch(/import\s*\{[\s\S]*getPersonaSectionOrder[\s\S]*\}\s*from\s*["'][^"']*platform-context["']/);
    });
    it("uses the persona section order via the R3 dashboard orchestrator", () => {
        // R3 introduced `resolveDashboardSections` which CALLS the
        // canonical `getPersonaSectionOrder` helper internally. The
        // CommandCenter no longer invokes the helper directly — it
        // consumes the orchestrator which preserves the persona
        // contract.
        expect(COMMAND_CENTER).toMatch(/resolveDashboardSections\(\s*\{[\s\S]{0,200}persona:[\s\S]{0,200}availableSectionIds/);
        // Sanity-check that the orchestrator still wraps the persona
        // helper (so the persona contract is end-to-end preserved).
        const orchestratorSrc = readWeb("lib/dashboard/resolveDashboardSections.ts");
        expect(orchestratorSrc).toMatch(/getPersonaSectionOrder/);
    });
    it("exposes the workflow profile + computed section order as data attributes", () => {
        expect(COMMAND_CENTER).toMatch(/data-cc-workflow=\{workflowCode\}/);
        expect(COMMAND_CENTER).toMatch(/data-cc-persona-section-order/);
    });
    it("uses client-resolved section order in preference to the backend value", () => {
        // The component must prefer `clientSectionOrder` (workflow-aware,
        // re-ranked client-side) and fall back to backendSectionOrder only
        // when the client output is empty.
        expect(COMMAND_CENTER).toMatch(/clientSectionOrder/);
    });
});
// =============================================================================
// PART 5 — Capture workflow-aware template ordering
// =============================================================================
describe("Phase 38.10 — capture workflow-aware template ordering", () => {
    it("workflowTemplateOrder helper exports orderTemplatesByWorkflow", () => {
        expect(TEMPLATE_ORDER).toMatch(/export function orderTemplatesByWorkflow/);
    });
    it("priority list is declared for every workflow profile (bounded)", () => {
        for (const code of [
            "VERIFICATION_DOCUMENTATION",
            "LEGAL_CASEWORK",
            "REVIEW_OPERATIONS",
            "INVESTIGATION_RECONSTRUCTION",
            "MEDIA_VERIFICATION",
            "GOVERNANCE_COMPLIANCE",
            "OPERATIONAL_ADMINISTRATION",
        ]) {
            expect(TEMPLATE_ORDER).toMatch(new RegExp(`${code}:\\s*\\[`));
        }
    });
    it("helper is a pure partition + concat — never adds or removes templates", () => {
        // The function body uses `claimed` Set + the original templates
        // array to produce the result; structurally this is partition+concat
        // and the test pins both pieces.
        expect(TEMPLATE_ORDER).toMatch(/claimed\.has\(/);
        expect(TEMPLATE_ORDER).toMatch(/for\s*\(\s*const\s+t\s+of\s+input\.templates\)\s*\{[\s\S]*?if\s*\(!claimed\.has\(t\.id\)\)\s*ordered\.push\(t\)/);
    });
    it("capture page consumes orderTemplatesByWorkflow with the persona's workflow", () => {
        expect(CAPTURE).toMatch(/orderTemplatesByWorkflow/);
        expect(CAPTURE).toMatch(/workflowFromPersona\(personaProfile\.primaryProfile\)/);
    });
    it("capture page exposes the resolved order as a data attribute", () => {
        expect(CAPTURE).toMatch(/data-capture-template-order/);
        expect(CAPTURE).toMatch(/data-capture-workflow/);
    });
    it("capture page does NOT hide any templates (no template filtering by workflow)", () => {
        // The capture page must not contain a `.filter(...workflow...)` over
        // the template list — that would be hiding templates by workflow.
        expect(CAPTURE).not.toMatch(/collectionPlans\.filter\([\s\S]{0,80}workflow/);
        expect(CAPTURE).not.toMatch(/COLLECTION_PLAN_TEMPLATES\.filter\([\s\S]{0,80}workflow/);
    });
});
// =============================================================================
// PART 6 — Cumulative migration tally
// =============================================================================
describe("Phase 38.10 — cumulative <PageRouteGate> adoption", () => {
    it("at least 21 canonical pages now wrap in <PageRouteGate>", () => {
        const PAGES = [
            // Phase 38.7
            "app/(app)/reports/page.tsx",
            "app/(app)/cases/page.tsx",
            "app/(app)/search/page.tsx",
            // Phase 38.8
            "app/(app)/home/page.tsx",
            "app/(app)/governance/page.tsx",
            // Phase Final-Vocab-Alignment — canonical reviewer console is
            // `/review/page.tsx`; the legacy `/reviewer-ops/page.tsx` was
            // deleted and the URL redirects via `next.config.js`.
            "app/(app)/review/page.tsx",
            "app/(app)/ops/page.tsx",
            // Phase Final-Closure-Remediation — canonical surface is
            // `/workspaces`; the duplicate `/teams/page.tsx` was deleted.
            "app/(app)/workspaces/page.tsx",
            // Phase 38.9
            "app/(app)/evidence/page.tsx",
            "app/(app)/capture/page.tsx",
            "app/(app)/notifications/page.tsx",
            "app/(app)/integrations/page.tsx",
            "app/(app)/settings/page.tsx",
            "app/(app)/billing/page.tsx",
            "app/(app)/governance/retention/page.tsx",
            "app/(app)/settings/persona/page.tsx",
            // Phase 38.10
            "app/(app)/workflows/page.tsx",
            "app/(app)/intake-links/page.tsx",
            "app/(app)/security-center/page.tsx",
            "app/(app)/ops/runbooks/page.tsx",
            "app/(app)/reviewer-ops/escalations/page.tsx",
        ];
        for (const page of PAGES) {
            const src = readWeb(page);
            expect(src, `${page} must wrap in <PageRouteGate>`).toMatch(/PageRouteGate/);
        }
        expect(PAGES.length).toBeGreaterThanOrEqual(21);
    });
});
// =============================================================================
// PART 7 — Forbidden copy + safety statement
// =============================================================================
describe("Phase 38.10 — forbidden copy stays absent + safety statement holds", () => {
    const BANNED = [
        /"lawyer mode"/i,
        /"journalist mode"/i,
        /"insurance mode"/i,
        /"investigator mode"/i,
        /"only for lawyers"/i,
        /"only for journalists"/i,
        /"only for insurance"/i,
        /"not available for your workflow"/i,
        /"hidden because of workflow"/i,
        /"profession-only"/i,
    ];
    it("CommandCenter + capture + escalations contain no profession-locking copy", () => {
        for (const src of [COMMAND_CENTER, CAPTURE, ESCALATIONS, TEMPLATE_ORDER]) {
            for (const pattern of BANNED) {
                expect(src).not.toMatch(pattern);
            }
        }
    });
    it("capture page template-ordering helper documents that it never removes templates", () => {
        // Doc-comment span may include newlines + line-leading asterisks.
        expect(TEMPLATE_ORDER).toMatch(/NEVER[\s\S]{0,10}adds or removes/);
    });
});
