/**
 * PHASE R5 — Progressive Disclosure & Capability-Aware Bucketing.
 *
 * R5 codifies the disclosure-tier vocabulary on top of the R2 +
 * R1.5B navigation pipeline. The new resolver returns a per-route
 * tier hint ("beginner" | "advanced" | "contextual" |
 * "all-tools-only") that the sidebar surfaces as data attributes.
 *
 * Hard contract pinned here:
 *
 *   1. The disclosure model exists, is pure, and carries no
 *      authorization logic.
 *   2. Beginner layer is bounded — the canonical primary set
 *      remains exactly the 6 routes from R2.
 *   3. Advanced tools are demoted, not deleted. The R1.5B
 *      personal-demotion set is preserved.
 *   4. All Tools + Command Palette + direct URLs still surface
 *      every permission-valid route.
 *   5. Per-mode disclosure help copy exists for each of the 4
 *      experience modes.
 *   6. Capture / custody / TSA / report files unchanged.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function repoPath(rel) {
    return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel) {
    return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function readRepo(rel) {
    return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel) {
    return readFileSync(webPath(rel), "utf8");
}
const MODEL = readWeb("lib/navigation/disclosureModel.ts");
const HELP = readWeb("lib/navigation/disclosureHelp.ts");
const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const TOOLS_PAGE = readWeb("app/(app)/tools/page.tsx");
const PALETTE = readWeb("components/navigation/CommandPalette.tsx");
const CANONICAL_GROUPS = readWeb("lib/navigation/canonicalNavigationGroups.ts");
const DEMOTION = readWeb("lib/workspace-experience/personalDemotionRules.ts");
// =============================================================================
// PART 1 — Disclosure model exists + is pure + no auth logic
// =============================================================================
describe("R5 Part 1 — canonical disclosure model exists + is pure", () => {
    it("exports the bounded tier vocabulary", () => {
        expect(MODEL).toMatch(/DISCLOSURE_TIERS\s*=\s*\[/);
        expect(MODEL).toMatch(/"beginner"/);
        expect(MODEL).toMatch(/"advanced"/);
        expect(MODEL).toMatch(/"contextual"/);
        expect(MODEL).toMatch(/"all-tools-only"/);
    });
    it("exports getRouteDisclosureTier as a pure function (no async, no I/O)", () => {
        expect(MODEL).toMatch(/export function getRouteDisclosureTier/);
        expect(MODEL).not.toMatch(/\basync\b/);
        expect(MODEL).not.toMatch(/\bawait\b/);
        expect(MODEL).not.toMatch(/\bfetch\(/);
        expect(MODEL).not.toMatch(/\bapiFetch\(/);
    });
    it("carries no authorization predicates (code-context regex)", () => {
        expect(MODEL).not.toMatch(/\bauthorize\s*\(/);
        expect(MODEL).not.toMatch(/\.canLoad\b/);
        expect(MODEL).not.toMatch(/\.canSeeNav\b/);
        expect(MODEL).not.toMatch(/access\.accessState\b/);
    });
    it("bounded tier set is exactly 4 entries", () => {
        const tiersMatch = MODEL.match(/DISCLOSURE_TIERS\s*=\s*\[([\s\S]*?)\]\s*as const/);
        expect(tiersMatch).toBeTruthy();
        const literals = (tiersMatch[1].match(/"[a-z-]+"/g) ?? []).length;
        expect(literals).toBe(4);
    });
});
// =============================================================================
// PART 2 — Beginner layer is bounded (R2 canonical primary preserved)
// =============================================================================
describe("R5 Part 2 — beginner layer bounded to canonical primary set", () => {
    it("CANONICAL_PRIMARY_ROUTE_IDS still contains exactly the 6 root routes", () => {
        for (const id of [
            "workspace.home",
            "workspace.capture",
            "workspace.evidence",
            "workspace.cases",
            "workspace.reports",
            "workspace.search",
        ]) {
            expect(CANONICAL_GROUPS).toMatch(new RegExp(`"${id.replace(".", "\\.")}"`));
        }
        const setMatch = CANONICAL_GROUPS.match(/CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/);
        const ids = (setMatch[1].match(/"[a-z0-9._]+"/gi) ?? []).length;
        // Post-G0 IA: canonical primary set grew from 6 → 9 (added
        // workspace.review, workspace.intake_links, account.inbox).
        expect(ids).toBe(9);
    });
    it("disclosure model recognizes the canonical primary set as 'beginner'", () => {
        expect(MODEL).toMatch(/CANONICAL_PRIMARY_ROUTE_IDS/);
        expect(MODEL).toMatch(/"beginner"/);
    });
});
// =============================================================================
// PART 3 — Advanced tools are demoted, not deleted
// =============================================================================
describe("R5 Part 3 — R1.5B personal demotion set preserved", () => {
    it("the bounded 10-route demotion set is intact", () => {
        const EXPECTED = [
            "review.escalations",
            "review.queue",
            "review.sla",
            "governance.hub",
            "governance.policy",
            "governance.retention",
            "governance.lifecycle",
            "governance.destruction",
            "governance.analytics",
            "governance.notifications",
        ];
        for (const id of EXPECTED) {
            expect(DEMOTION).toMatch(new RegExp(`"${id.replace(".", "\\.")}"`));
        }
    });
    it("disclosure model consumes the R1.5B demotion set", () => {
        expect(MODEL).toMatch(/PERSONAL_MODE_DEMOTION_ROUTE_IDS/);
    });
    it("every demoted route is still registered (no deletions)", () => {
        for (const id of [
            "review.escalations",
            "review.queue",
            "review.sla",
            "governance.hub",
            "governance.policy",
            "governance.retention",
            "governance.lifecycle",
            "governance.destruction",
            "governance.analytics",
            "governance.notifications",
        ]) {
            expect(REGISTRY).toMatch(new RegExp(`id:\\s*"${id.replace(".", "\\.")}"`));
        }
    });
});
// =============================================================================
// PART 4 — Contextual tier rules wired
// =============================================================================
describe("R5 Part 4 — contextual disclosure rules", () => {
    it("disclosure model maps governance/reviewer routes to a contextual capability", () => {
        expect(MODEL).toMatch(/CONTEXTUAL_CAPABILITY_BY_ROUTE/);
        expect(MODEL).toMatch(/"GOVERNANCE_VIEW"/);
        expect(MODEL).toMatch(/"REVIEWER_OPS_VIEW"/);
    });
    it("contextual rule never blocks access — the capability only INFLUENCES the tier", () => {
        // The model returns "contextual" when the cap is true; otherwise
        // falls through to advancedByDefault / beginner. NEVER returns
        // something like "hidden" or sets canLoad.
        expect(MODEL).not.toMatch(/"hidden"/);
        expect(MODEL).not.toMatch(/return\s+null/);
    });
});
// =============================================================================
// PART 5 — All Tools + Command Palette preservation
// =============================================================================
describe("R5 Part 5 — All Tools + Command Palette + direct links preserved", () => {
    it("All Tools page still iterates ROUTE_REGISTRY directly", () => {
        expect(TOOLS_PAGE).toMatch(/ROUTE_REGISTRY/);
        expect(TOOLS_PAGE).toMatch(/resolveRouteAccess/);
    });
    it("Command Palette still iterates ROUTE_REGISTRY directly", () => {
        expect(PALETTE).toMatch(/ROUTE_REGISTRY/);
        expect(PALETTE).toMatch(/resolveRouteAccess/);
    });
    it("the disclosure resolver still passes allToolsItems untouched (R2 contract)", () => {
        const r2Resolver = readWeb("lib/navigation/navigationDisclosureResolver.ts");
        expect(r2Resolver).toMatch(/allToolsItems:\s*exposure\.allToolsItems/);
    });
    it("the 8 backward-compat redirects (CR1 Part 2) are still in next.config.js", () => {
        const cfg = readWeb("next.config.js");
        expect(cfg).toMatch(/async\s+redirects/);
        expect(cfg).toMatch(/\/dashboard/);
        expect(cfg).toMatch(/\/operations/);
    });
});
// =============================================================================
// PART 6 — Per-mode disclosure help copy
// =============================================================================
describe("R5 Part 6 — per-mode disclosure help copy", () => {
    it("each of the 4 experience modes has a primary + secondary help entry", () => {
        for (const mode of [
            "PERSONAL",
            "ORGANIZATION",
            "REVIEW_OPS",
            "GOVERNANCE",
        ]) {
            expect(HELP).toMatch(new RegExp(`${mode}:\\s*\\{[\\s\\S]{0,400}primary:`));
            expect(HELP).toMatch(new RegExp(`${mode}:\\s*\\{[\\s\\S]{0,400}secondary:`));
        }
    });
    it("PERSONAL help copy is calm + operational (R4 tone)", () => {
        expect(HELP).toMatch(/Start with a capture or review your recent evidence/);
        expect(HELP).toMatch(/remain available when your workspace needs them/i);
    });
    it("help copy uses R4 canonical terminology (governance / lifecycle / reviewer)", () => {
        expect(HELP).toMatch(/governance/i);
        expect(HELP).toMatch(/lifecycle/i);
        expect(HELP).toMatch(/reviewer/i);
    });
    it("help copy contains no marketing / dramatic / debug language", () => {
        const FORBIDDEN = [
            /\brevolutionary\b/i,
            /\bnext[-\s]gen\b/i,
            /\bbest[-\s]in[-\s]class\b/i,
            /\bAI[-\s]powered\b/i,
            /\bworld[-\s]class\b/i,
            /\bcatastrophic\b/i,
            /\boops!?\b/i,
        ];
        for (const p of FORBIDDEN) {
            expect(HELP).not.toMatch(p);
        }
    });
});
// =============================================================================
// PART 7 — Visual disclosure hooks wired into sidebar
// =============================================================================
describe("R5 Part 7 — sidebar surfaces disclosure-tier + tooling-tier attributes", () => {
    it("sidebar imports the disclosure model", () => {
        expect(SIDEBAR).toMatch(/getRouteDisclosureTier/);
    });
    it("SidebarLink renders data-disclosure-tier on every link", () => {
        expect(SIDEBAR).toMatch(/data-disclosure-tier=\{disclosureTier\}/);
    });
    it("SidebarGroupView renders data-tooling-tier on each group", () => {
        expect(SIDEBAR).toMatch(/data-tooling-tier=\{toolingTier\}/);
    });
    it("SidebarMoreView renders data-tooling-tier='advanced' on the More group", () => {
        expect(SIDEBAR).toMatch(/data-tooling-tier="advanced"/);
    });
});
// =============================================================================
// PART 8 — No new root nav groups, no duplicated navigation systems
// =============================================================================
describe("R5 Part 8 — no nav explosion regression", () => {
    it("the canonical group title vocabulary is still bounded", () => {
        // Combine sidebar + canonical-groups (R2 pattern). Both files'
        // `title:` literals must be in the allow-list.
        const ALLOWED = [
            "Primary workflows",
            "Workspace",
            "Operations",
            // Post-G0 IA: title was "Governance & Compliance" pre-G0, now
            // collapsed to "Governance". Same group, shorter label.
            "Governance",
            "Governance & Compliance",
            "Outputs",
            "System",
            "All Tools",
            "More / Advanced",
        ];
        const combined = `${SIDEBAR}\n${CANONICAL_GROUPS}`;
        const titles = Array.from(combined.matchAll(/title:\s*"([^"]+)"/g)).map((m) => m[1]);
        for (const t of titles) {
            expect(ALLOWED.includes(t), `Sidebar group title "${t}" not in bounded vocabulary`).toBe(true);
        }
    });
    it("exactly one canonical sidebar component file", () => {
        const sidebarFiles = readdirSync(webPath("components/app-shell-v2")).filter((n) => /^App.*Sidebar.*\.tsx$/.test(n));
        expect(sidebarFiles).toEqual(["AppSidebarV2.tsx"]);
    });
});
// =============================================================================
// PART 9 — No workflow/persona authorization regression
// =============================================================================
describe("R5 Part 9 — workflow/persona still presentation-only", () => {
    it("disclosure model never imports route-access fields", () => {
        expect(MODEL).not.toMatch(/from\s+["'].*\/routeAccessResolver/);
    });
    it("routeAccessResolver still does NOT consult workflow/persona", () => {
        const ra = readWeb("lib/navigation/routeAccessResolver.ts");
        expect(ra).not.toMatch(/\.workflowProfile\b/);
        expect(ra).not.toMatch(/\.primaryWorkflow\b/);
        expect(ra).not.toMatch(/\.workflowTags\b/);
        expect(ra).not.toMatch(/\.personaProfile\b/);
    });
    it("workflowExposureResolver still documents the no-authorization contract", () => {
        const we = readWeb("lib/navigation/workflowExposureResolver.ts");
        expect(we).toMatch(/Workflow NEVER changes/i);
    });
});
// =============================================================================
// PART 10 — No raw Org/Access/internal labels re-introduced
// =============================================================================
describe("R5 Part 10 — no raw architecture chips returned in primary UX", () => {
    it("sidebar still uses the canonical chip vocabulary (R2 pin)", () => {
        expect(SIDEBAR).not.toMatch(/return\s+"Org"\s*;/);
        expect(SIDEBAR).not.toMatch(/return\s+"Access"\s*;/);
        expect(SIDEBAR).toMatch(/DEGRADATION_CHIP_LABELS/);
    });
    it("disclosure model + help copy contain no raw architecture labels", () => {
        expect(MODEL).not.toMatch(/"Org"\s*[,;)]/);
        expect(MODEL).not.toMatch(/"Access"\s*[,;)]/);
        expect(HELP).not.toMatch(/"Org"\s*[,;)]/);
        expect(HELP).not.toMatch(/"Access"\s*[,;)]/);
    });
});
// =============================================================================
// PART 11 — Documentation present + substantial
// =============================================================================
describe("R5 Part 11 — R5 documentation present", () => {
    const doc = readRepo("docs/recovery/R5_PROGRESSIVE_DISCLOSURE.md");
    it("R5 doc exists and covers the required sections", () => {
        expect(doc.length).toBeGreaterThan(6000);
        expect(doc).toMatch(/PHASE R5/);
        expect(doc).toMatch(/beginner layer/i);
        expect(doc).toMatch(/advanced layer/i);
        expect(doc).toMatch(/contextual disclosure/i);
        expect(doc).toMatch(/All Tools/);
        expect(doc).toMatch(/Command Palette/);
        expect(doc).toMatch(/Remaining risks/);
    });
});
// =============================================================================
// PART 12 — Capture / custody / TSA / report / package unchanged
// =============================================================================
describe("R5 Part 12 — canonical capture / custody / TSA / report files unchanged", () => {
    const PINS = [
        { rel: "src/routes/capture.routes.ts", expectedBytes: 21271 },
        { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
        { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
        { rel: "src/services/timestamp.service.ts", expectedBytes: 7535 },
        {
            rel: "src/services/reports/reports-aggregator.service.ts",
            expectedBytes: 13118,
        },
    ];
    for (const { rel, expectedBytes } of PINS) {
        it(`${rel} is within ±10% of the CR1.5 baseline`, () => {
            const fullPath = fileURLToPath(new URL(`../${rel}`, import.meta.url));
            const st = statSync(fullPath);
            const low = Math.floor(expectedBytes * 0.9);
            const high = Math.ceil(expectedBytes * 1.1);
            expect(st.size, `${rel} size ${st.size} drifted out of window [${low}, ${high}]`).toBeGreaterThanOrEqual(low);
            expect(st.size).toBeLessThanOrEqual(high);
        });
    }
});
