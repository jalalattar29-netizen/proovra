/**
 * PHASE R6 — Operational Hubs & Tool Consolidation guardrails.
 *
 * R6 builds a canonical hub-orchestration library + a shared
 * `HubQuickActionsBar` and wires the bar into all 4 hub pages
 * (investigation, governance, reviewer-ops, ops). Each hub becomes
 * a workflow-orchestration SURFACE — not a portal page, not a
 * mega-dashboard.
 *
 * Hard contract pinned here:
 *
 *   1. Exactly 4 canonical hub ids (investigation / governance /
 *      reviewer / operations). Bounded vocabulary.
 *   2. Per-hub quick actions are bounded (≤ 4) and link to existing
 *      registered routes.
 *   3. Orchestration is pure (no fetches, no async, no auth).
 *   4. HubQuickActionsBar is mounted at the top of every hub page.
 *   5. No new dashboard / portal / mega-page introduced.
 *   6. Direct routes + All Tools + Command Palette preserved.
 *   7. Capture / custody / TSA / report files unchanged.
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
const TYPES = readWeb("lib/hubs/types.ts");
const DEFS = readWeb("lib/hubs/hubDefinitions.ts");
const RESOLVER = readWeb("lib/hubs/resolveHubContext.ts");
const BAR = readWeb("components/hubs/HubQuickActionsBar.tsx");
const INVESTIGATION_PAGE = readWeb("app/(app)/investigation/page.tsx");
const GOVERNANCE_PAGE = readWeb("app/(app)/governance/page.tsx");
// Phase Final-Vocab-Alignment — `/reviewer-ops/page.tsx` was deleted;
// the canonical reviewer console moved to `/review/page.tsx`. The
// canonical reviewer page now uses `<ReviewerConsole>` (keyboard-first
// consolidated queue) instead of the HubQuickActionsBar wrapper used
// by the other hubs. The PageRouteGate invariant still applies.
const REVIEWER_PAGE = readWeb("app/(app)/review/page.tsx");
const OPS_PAGE = readWeb("app/(app)/ops/page.tsx");
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
// =============================================================================
// PART 1 — Canonical hub ids + pure orchestration
// =============================================================================
describe("R6 Part 1 — canonical hub vocabulary + pure orchestration", () => {
    it("HUB_IDS is bounded to exactly the 4 canonical hubs", () => {
        const listMatch = TYPES.match(/HUB_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/);
        expect(listMatch).toBeTruthy();
        const ids = (listMatch[1].match(/"[a-z]+"/g) ?? []).length;
        expect(ids).toBe(4);
        expect(TYPES).toMatch(/"investigation"/);
        expect(TYPES).toMatch(/"governance"/);
        expect(TYPES).toMatch(/"reviewer"/);
        expect(TYPES).toMatch(/"operations"/);
    });
    it("resolver is pure (no fetches, no await, no auth predicates)", () => {
        // Header comments may legitimately discuss async / auth concepts;
        // tighten to code-context matches.
        expect(RESOLVER).not.toMatch(/\bfetch\(/);
        expect(RESOLVER).not.toMatch(/\bapiFetch\(/);
        expect(RESOLVER).not.toMatch(/^\s*await\s/m);
        expect(RESOLVER).not.toMatch(/\bauthorize\s*\(/);
        expect(RESOLVER).not.toMatch(/\.requiredCapabilities\b/);
    });
});
// =============================================================================
// PART 2 — Per-hub bounded quick actions
// =============================================================================
describe("R6 Part 2 — quick actions bounded + reference registered routes", () => {
    it("HUB_QUICK_ACTIONS_MAX is 4", () => {
        expect(DEFS).toMatch(/HUB_QUICK_ACTIONS_MAX\s*=\s*4/);
    });
    it("every quick-action href is a registered route in the registry", () => {
        const hrefs = Array.from(DEFS.matchAll(/href:\s*"([^"]+)"/g)).map((m) => m[1]);
        expect(hrefs.length).toBeGreaterThan(0);
        for (const href of hrefs) {
            expect(REGISTRY.includes(`href: "${href}"`), `hub quick action href ${href} must be a registered route in routeRegistry.ts`).toBe(true);
        }
    });
    it("each hub definition stays within the bound (≤ 4 quick actions)", () => {
        for (const hub of ["investigation", "governance", "reviewer", "operations"]) {
            // Each hub block is a key inside HUB_DEFINITIONS; the
            // quickActions array is a fixed shape.
            const blockMatch = DEFS.match(new RegExp(`${hub}:\\s*\\{[\\s\\S]*?quickActions:\\s*\\[([\\s\\S]*?)\\]`));
            expect(blockMatch, `${hub} definition must declare quickActions`).toBeTruthy();
            const actionCount = (blockMatch[1].match(/\bid:\s*"/g) ?? []).length;
            expect(actionCount, `${hub} quick action count ${actionCount} must be ≤ 4`).toBeLessThanOrEqual(4);
            expect(actionCount).toBeGreaterThanOrEqual(2);
        }
    });
});
// =============================================================================
// PART 3 — HubQuickActionsBar mounted at the top of every hub page
// =============================================================================
describe("R6 Part 3 — HubQuickActionsBar mounted on each hub page", () => {
    it("investigation page mounts the hub bar with hubId='investigation'", () => {
        expect(INVESTIGATION_PAGE).toMatch(/HubQuickActionsBar/);
        expect(INVESTIGATION_PAGE).toMatch(/hubId="investigation"/);
        expect(INVESTIGATION_PAGE).toMatch(/data-hub-page-id="investigation"/);
    });
    it("governance page mounts the hub bar with hubId='governance'", () => {
        expect(GOVERNANCE_PAGE).toMatch(/HubQuickActionsBar/);
        expect(GOVERNANCE_PAGE).toMatch(/hubId="governance"/);
        expect(GOVERNANCE_PAGE).toMatch(/data-hub-page-id="governance"/);
    });
    it("canonical reviewer page mounts the consolidated reviewer console (Phase Final-Vocab-Alignment supersedes the HubQuickActionsBar mount on `/reviewer-ops/page.tsx`)", () => {
        // Phase Final-Vocab-Alignment retired `/reviewer-ops/page.tsx` (the
        // legacy queue index) and made `/review/page.tsx` the canonical
        // reviewer console. The new canonical surface uses the
        // keyboard-first `<ReviewerConsole>` component instead of the
        // HubQuickActionsBar wrapper used by Investigation / Governance /
        // Ops. The hub-bar invariant therefore no longer applies to the
        // reviewer surface; the canonical mount is asserted instead.
        expect(REVIEWER_PAGE).toMatch(/<ReviewerConsole\b/);
        // PageRouteGate still wraps the canonical surface with the
        // `review.queue` route id (asserted again under PART 6 below).
        expect(REVIEWER_PAGE).toMatch(/routeId="review\.queue"/);
    });
    it("ops page mounts the hub bar with hubId='operations'", () => {
        expect(OPS_PAGE).toMatch(/HubQuickActionsBar/);
        expect(OPS_PAGE).toMatch(/hubId="operations"/);
        expect(OPS_PAGE).toMatch(/data-hub-page-id="operations"/);
    });
});
// =============================================================================
// PART 4 — HubQuickActionsBar is a thin presentation component
// =============================================================================
describe("R6 Part 4 — HubQuickActionsBar is a bounded presentation wrapper", () => {
    it("bar consumes resolveHubContext + resolveDisclosureHelp (R5) + resolveWorkspaceExperience (R1.5B)", () => {
        expect(BAR).toMatch(/resolveHubContext/);
        expect(BAR).toMatch(/resolveDisclosureHelp/);
        expect(BAR).toMatch(/resolveWorkspaceExperience/);
    });
    it("bar carries no authorization decisions", () => {
        expect(BAR).not.toMatch(/\bauthorize\s*\(/);
        expect(BAR).not.toMatch(/\bapiFetch\(/);
        expect(BAR).not.toMatch(/\.requiredCapabilities\b/);
    });
    it("bar renders bounded markup (title + subtitle + help + quick actions)", () => {
        expect(BAR).toMatch(/data-hub-title/);
        expect(BAR).toMatch(/data-hub-subtitle/);
        expect(BAR).toMatch(/data-hub-help/);
        expect(BAR).toMatch(/data-hub-quick-actions/);
    });
});
// =============================================================================
// PART 5 — No giant portal / mega-dashboard created
// =============================================================================
describe("R6 Part 5 — no giant portal / mega-page introduced", () => {
    it("HubQuickActionsBar.tsx is bounded in size (< 6 KB)", () => {
        const fullPath = webPath("components/hubs/HubQuickActionsBar.tsx");
        const st = statSync(fullPath);
        expect(st.size, "HubQuickActionsBar should remain a bounded header, not a portal page").toBeLessThan(6000);
    });
    it("no new HubPortal / HubDashboard / HubEverything component file", () => {
        const root = webPath("components");
        function listAllFiles(dirAbs) {
            const out = [];
            const stack = [dirAbs];
            while (stack.length > 0) {
                const dir = stack.pop();
                let entries;
                try {
                    entries = readdirSync(dir);
                }
                catch {
                    continue;
                }
                for (const name of entries) {
                    const full = `${dir}/${name}`;
                    try {
                        const st = statSync(full);
                        if (st.isFile() && /\.tsx?$/.test(name))
                            out.push(full);
                        else if (st.isDirectory())
                            stack.push(full);
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            return out;
        }
        const all = listAllFiles(root);
        const FORBIDDEN_NAMES = [
            "HubPortal.tsx",
            "HubDashboard.tsx",
            "HubEverything.tsx",
            "InvestigationPortal.tsx",
            "GovernancePortal.tsx",
            "ReviewerPortal.tsx",
            "OperationsPortal.tsx",
            "MegaDashboard.tsx",
        ];
        for (const file of all) {
            const name = file.split(/[\\/]/).pop();
            expect(FORBIDDEN_NAMES.includes(name), `R6 forbids portal / mega-dashboard components — found ${name}`).toBe(false);
        }
    });
    it("hubs/ package only exports the orchestration library (no rendering components)", () => {
        const barrel = readWeb("lib/hubs/index.ts");
        expect(barrel).not.toMatch(/HubPortal/);
        expect(barrel).not.toMatch(/HubDashboard/);
        expect(barrel).not.toMatch(/HubEverything/);
    });
});
// =============================================================================
// PART 6 — Direct routes + All Tools + Cmd+K still work
// =============================================================================
describe("R6 Part 6 — direct routes + All Tools + Command Palette preserved", () => {
    it("All Tools page still iterates ROUTE_REGISTRY directly (unchanged from R2)", () => {
        const tools = readWeb("app/(app)/tools/page.tsx");
        expect(tools).toMatch(/ROUTE_REGISTRY/);
        expect(tools).toMatch(/resolveRouteAccess/);
    });
    it("Command Palette still iterates ROUTE_REGISTRY directly (unchanged)", () => {
        const palette = readWeb("components/navigation/CommandPalette.tsx");
        expect(palette).toMatch(/ROUTE_REGISTRY/);
        expect(palette).toMatch(/resolveRouteAccess/);
    });
    it("every hub member route still exists in the registry (no deletions)", () => {
        for (const id of [
            "investigation.hub",
            "investigation.timeline",
            "investigation.graph",
            "investigation.duplicates",
            "investigation.relationships",
            "investigation.reviewers",
            "governance.hub",
            "governance.retention",
            "governance.lifecycle",
            "governance.destruction",
            "governance.analytics",
            "governance.notifications",
            "governance.policy",
            "review.queue",
            "review.escalations",
            "review.sla",
            "platform.ops_center",
            "platform.observability",
            "platform.runbooks",
            "workspace.integrations",
        ]) {
            expect(REGISTRY).toMatch(new RegExp(`id:\\s*"${id.replace(".", "\\.")}"`));
        }
    });
    it("PageRouteGate still wraps each hub page", () => {
        for (const [name, src] of [
            ["investigation", INVESTIGATION_PAGE],
            ["governance", GOVERNANCE_PAGE],
            ["reviewer-ops", REVIEWER_PAGE],
            ["ops", OPS_PAGE],
        ]) {
            expect(src, `${name} page must still wrap in PageRouteGate`).toMatch(/<PageRouteGate routeId=/);
        }
    });
});
// =============================================================================
// PART 7 — No workflow/persona authorization regression
// =============================================================================
describe("R6 Part 7 — no workflow/persona authorization regression", () => {
    it("hub resolver does not import route-access fields", () => {
        expect(RESOLVER).not.toMatch(/from\s+["'].*\/routeAccessResolver/);
    });
    it("hub definitions carry no auth predicates", () => {
        expect(DEFS).not.toMatch(/\bauthorize\s*\(/);
        expect(DEFS).not.toMatch(/\.canLoad\b/);
        expect(DEFS).not.toMatch(/requiredCapabilities/);
    });
    it("routeAccessResolver still does NOT consult workflow/persona (no regression)", () => {
        const ra = readWeb("lib/navigation/routeAccessResolver.ts");
        expect(ra).not.toMatch(/\.workflowProfile\b/);
        expect(ra).not.toMatch(/\.primaryWorkflow\b/);
        expect(ra).not.toMatch(/\.workflowTags\b/);
        expect(ra).not.toMatch(/\.personaProfile\b/);
    });
});
// =============================================================================
// PART 8 — Hub copy uses R4 canonical vocabulary
// =============================================================================
describe("R6 Part 8 — hub copy uses R4 canonical vocabulary", () => {
    it("hub definitions use operational terms (governance / lifecycle / reviewer / SLA / observability)", () => {
        expect(DEFS).toMatch(/governance/i);
        expect(DEFS).toMatch(/lifecycle/i);
        expect(DEFS).toMatch(/reviewer/i);
        expect(DEFS).toMatch(/SLA/);
        expect(DEFS).toMatch(/observability/i);
    });
    it("hub copy contains no marketing / dramatic / debug language", () => {
        const FORBIDDEN = [
            /\brevolutionary\b/i,
            /\bnext[-\s]gen\b/i,
            /\bbest[-\s]in[-\s]class\b/i,
            /\bAI[-\s]powered\b/i,
            /\bworld[-\s]class\b/i,
            /\bcatastrophic\b/i,
            /\boops!?\b/i,
            /\bobject\s+not\s+found\b/i,
        ];
        for (const p of FORBIDDEN) {
            expect(DEFS, `hub definitions contain forbidden ${p}`).not.toMatch(p);
        }
    });
});
// =============================================================================
// PART 9 — Documentation present + substantial
// =============================================================================
describe("R6 Part 9 — R6 documentation present", () => {
    const doc = readRepo("docs/recovery/R6_OPERATIONAL_HUBS.md");
    it("R6 doc exists and covers the required sections", () => {
        expect(doc.length).toBeGreaterThan(6000);
        expect(doc).toMatch(/PHASE R6/);
        expect(doc).toMatch(/Investigation Center/);
        expect(doc).toMatch(/Governance Center/);
        expect(doc).toMatch(/Reviewer Center/);
        expect(doc).toMatch(/Operations Center/);
        expect(doc).toMatch(/Remaining risks/);
    });
});
// =============================================================================
// PART 10 — Capture / custody / TSA / report / package unchanged
// =============================================================================
describe("R6 Part 10 — canonical capture/custody/TSA/report files unchanged", () => {
    const PINS = [
        { rel: "src/routes/capture.routes.ts", expectedBytes: 21271 },
        { rel: "src/services/evidence-complete.service.ts", expectedBytes: 46824 },
        { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
        { rel: "src/services/timestamp.service.ts", expectedBytes: 12988 },
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
