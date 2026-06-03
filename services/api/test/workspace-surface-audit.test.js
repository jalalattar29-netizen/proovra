/**
 * Workspace Surface Audit — pins the navigation visibility, empty-state
 * copy, locked-state copy, and label clarifications that landed as the
 * minimal remediation set for the workspace-wide IA audit.
 *
 * Background:
 *   The audit cataloged the four discovery surfaces (sidebar, /tools "All
 *   Tools" picker, Cmd-K command palette, PageRouteGate) against every
 *   workspace route in `routeRegistry.ts`. The minimal fixes that
 *   shipped per the synthesis report were:
 *
 *     - NAV_VISIBILITY: two enterprise dashboards (Executive Dashboard,
 *       Intelligence) were sidebar-hidden / cmd-K-only despite having
 *       leadership personas (ORG + GOVERNANCE_VIEW). They now appear in
 *       the Governance sidebar pillar while keeping the same backend
 *       capability gating.
 *     - LABEL_CLARIFICATION: two enterprise surfaces were renamed for
 *       operator legibility — "Intelligence Platform" → "Intelligence",
 *       "Trust Center" → "Trust & Compliance".
 *     - EMPTY_STATE_COPY: /investigation hub and /investigation/duplicates
 *       were valid-empty on fresh workspaces (reconciliation is cron-only,
 *       perceptual similarity is producer-missing); the empty-state copy
 *       now explains the reality instead of reading as "broken".
 *     - LOCKED_STATE_COPY: /integrations 503 FEATURE_DISABLED panel now
 *       says "Integrations are not available on this workspace" (sharpens
 *       the scope) and points operators at the platform administrator
 *       (operator-actionable next step) without naming env vars.
 *
 * Bounded checks pinned by this file:
 *   - No CORE_DAILY route (Capture, Evidence, Cases, Search) had its
 *     sidebarEligible flipped to false.
 *   - Every route flipped to "sidebar-hidden but cmd-K visible" must keep
 *     commandPaletteVisible=true so it remains reachable.
 *
 * Test style: vitest source-contract — read source files via
 * fs.readFileSync and assert against literal substrings/patterns. No DB
 * I/O, no compilation. Matches the
 * `phase-7-team-vs-workspace-anti-confusion.test.ts` pattern.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readWeb(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)), "utf8");
}
const ROUTE_REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const INVESTIGATION_HUB_PAGE = readWeb("app/(app)/investigation/page.tsx");
const INVESTIGATION_DUPLICATES_PAGE = readWeb("app/(app)/investigation/duplicates/page.tsx");
const INTEGRATIONS_PAGE = readWeb("app/(app)/integrations/page.tsx");
/**
 * Slice the body of a single route registry entry by id. Routes are
 * declared as `{ id: "<id>", ... }` blocks separated by `},` — this
 * helper returns the substring from the entry's `id:` line to the
 * closing `},` so flag assertions don't accidentally match against a
 * neighbouring route's flag.
 */
function sliceRouteEntry(id) {
    const marker = `id: "${id}"`;
    const start = ROUTE_REGISTRY.indexOf(marker);
    if (start === -1) {
        throw new Error(`route id ${id} not found in routeRegistry.ts`);
    }
    // Walk back to the opening `{` to capture leading metadata too.
    const lineStart = ROUTE_REGISTRY.lastIndexOf("{", start);
    // The closing `},` for this entry is the next `},` followed by
    // whitespace and the next `{` (route boundary) OR the array tail.
    // Use a CRLF-tolerant regex so Windows line endings don't fall
    // through to the next entry's body.
    const tail = ROUTE_REGISTRY.slice(start);
    const tailMatch = /\},\s*(\{|\];)/.exec(tail);
    const end = tailMatch ? start + tailMatch.index : start + 4000;
    return ROUTE_REGISTRY.slice(lineStart, end + 1);
}
// ---------------------------------------------------------------------------
// NAV_VISIBILITY — Executive Dashboard + Intelligence are sidebar-eligible
// ---------------------------------------------------------------------------
describe("Workspace surface audit — NAV_VISIBILITY changes (sidebarEligible flips)", () => {
    it("workspace.executive (Executive Dashboard) is sidebarEligible:true", () => {
        const entry = sliceRouteEntry("workspace.executive");
        expect(entry).toMatch(/sidebarEligible:\s*true/);
    });
    it("workspace.executive remains commandPaletteVisible:true (cmd-K still works)", () => {
        const entry = sliceRouteEntry("workspace.executive");
        expect(entry).toMatch(/commandPaletteVisible:\s*true/);
    });
    it("workspace.executive remains allToolsVisible:true (/tools picker still works)", () => {
        const entry = sliceRouteEntry("workspace.executive");
        expect(entry).toMatch(/allToolsVisible:\s*true/);
    });
    it("workspace.intelligence_platform (Intelligence) is sidebarEligible:true", () => {
        const entry = sliceRouteEntry("workspace.intelligence_platform");
        expect(entry).toMatch(/sidebarEligible:\s*true/);
    });
    it("workspace.intelligence_platform remains commandPaletteVisible:true", () => {
        const entry = sliceRouteEntry("workspace.intelligence_platform");
        expect(entry).toMatch(/commandPaletteVisible:\s*true/);
    });
    it("workspace.intelligence_platform remains allToolsVisible:true", () => {
        const entry = sliceRouteEntry("workspace.intelligence_platform");
        expect(entry).toMatch(/allToolsVisible:\s*true/);
    });
});
// ---------------------------------------------------------------------------
// LABEL_CLARIFICATION — operator-legible labels
// ---------------------------------------------------------------------------
describe("Workspace surface audit — LABEL_CLARIFICATION changes", () => {
    it("workspace.intelligence_platform label is the clarified 'Intelligence' (not 'Intelligence Platform')", () => {
        const entry = sliceRouteEntry("workspace.intelligence_platform");
        expect(entry).toMatch(/label:\s*"Intelligence"/);
        // The clarified label must NOT carry the legacy "Platform" suffix
        // as the operator-facing label string for this entry.
        expect(entry).not.toMatch(/label:\s*"Intelligence Platform"/);
    });
    it("workspace.trust_center label is the clarified 'Trust & Compliance' (not 'Trust Center')", () => {
        const entry = sliceRouteEntry("workspace.trust_center");
        expect(entry).toMatch(/label:\s*"Trust & Compliance"/);
        expect(entry).not.toMatch(/label:\s*"Trust Center"/);
    });
});
// ---------------------------------------------------------------------------
// EMPTY_STATE_COPY — investigation hub
// ---------------------------------------------------------------------------
describe("Workspace surface audit — EMPTY_STATE_COPY for /investigation hub", () => {
    it("renders the new 'populate as you capture' empty-state copy", () => {
        expect(INVESTIGATION_HUB_PAGE).toMatch(/Investigation surfaces populate as you capture evidence and open\s+cases\. No setup required — capture content and return here\./);
    });
    it("does NOT render the legacy 'No analyses recorded yet — open an evidence record' copy", () => {
        expect(INVESTIGATION_HUB_PAGE).not.toMatch(/No analyses recorded yet — open an evidence record to start analysis\./);
    });
});
// ---------------------------------------------------------------------------
// EMPTY_STATE_COPY — investigation duplicates
// ---------------------------------------------------------------------------
describe("Workspace surface audit — EMPTY_STATE_COPY for /investigation/duplicates", () => {
    it("the empty-state title explains exact-match reconciliation reality", () => {
        expect(INVESTIGATION_DUPLICATES_PAGE).toMatch(/Exact-match duplicates appear here automatically as evidence\s+is reconciled\./);
    });
    it("the empty-state surfaces the perceptual-similarity producer gap honestly", () => {
        expect(INVESTIGATION_DUPLICATES_PAGE).toMatch(/Perceptual similarity is not yet available on\s+this workspace\./);
    });
});
// ---------------------------------------------------------------------------
// LOCKED_STATE_COPY — integrations disabled panel
// ---------------------------------------------------------------------------
describe("Workspace surface audit — LOCKED_STATE_COPY for /integrations disabled panel", () => {
    it("disabled panel title scopes the message to the workspace", () => {
        expect(INTEGRATIONS_PAGE).toMatch(/Integrations are not available on this workspace/);
    });
    it("disabled panel points operators at a platform administrator (actionable next step)", () => {
        expect(INTEGRATIONS_PAGE).toMatch(/contact your platform\s+administrator/);
    });
    it("disabled panel does NOT name raw env vars in user-facing copy", () => {
        // Strip block + line comments so legitimate doc comments that mention
        // env vars (e.g. the PRODUCTION FIX header explaining what triggers
        // the panel) are not counted as UI leakage.
        const stripped = INTEGRATIONS_PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        expect(stripped).not.toMatch(/INTEGRATIONS_ENABLED/);
        expect(stripped).not.toMatch(/API_KEY_SECRET/);
    });
});
// ---------------------------------------------------------------------------
// Bounded check — CORE_DAILY routes are never sidebar-hidden
// ---------------------------------------------------------------------------
describe("Workspace surface audit — CORE_DAILY routes remain sidebar-visible", () => {
    const CORE_DAILY_ROUTE_IDS = [
        "workspace.capture",
        "workspace.evidence",
        "workspace.cases",
        "workspace.search",
    ];
    for (const id of CORE_DAILY_ROUTE_IDS) {
        it(`${id} keeps sidebarEligible:true (core daily route — must stay visible)`, () => {
            const entry = sliceRouteEntry(id);
            expect(entry).toMatch(/sidebarEligible:\s*true/);
            expect(entry).not.toMatch(/sidebarEligible:\s*false/);
        });
        it(`${id} keeps commandPaletteVisible:true (cmd-K reachable)`, () => {
            const entry = sliceRouteEntry(id);
            expect(entry).toMatch(/commandPaletteVisible:\s*true/);
        });
    }
});
