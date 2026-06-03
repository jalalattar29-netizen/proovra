/**
 * Phase 25.6 — Reviewer Ops UI maturity source-contract tests.
 *
 * Four new operational UI primitives ship in this phase:
 *
 *   1. PriorityChip — renders the shared PriorityScoreResult on a
 *      queue row. Compact, severity-toned, WCAG-readable.
 *   2. StuckBadge — renders the shared StuckClassification. Hides
 *      itself when the workflow isn't stuck.
 *   3. AssignmentSuggestionRow — renders one ReviewerSuggestion with
 *      a recommendation band, risk flags, and a reviewer label.
 *   4. WorkloadHeatTile — renders one reviewer workload snapshot
 *      with pressure tone + counter chips + imbalance / inactivity
 *      warnings.
 *
 * Pure source-contract tests: assert each component consumes the
 * canonical shared shape, never invents data, uses the Phase 28-I
 * light-surface tokens, exposes stable `data-*` attributes for any
 * downstream selector, and avoids privacy / governance leaks.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
const PRIMITIVE_FILES = [
    "../../../apps/web/components/operational/PriorityChip.tsx",
    "../../../apps/web/components/operational/StuckBadge.tsx",
    "../../../apps/web/components/operational/AssignmentSuggestionRow.tsx",
    "../../../apps/web/components/operational/WorkloadHeatTile.tsx",
];
// =============================================================================
// Barrel registration
// =============================================================================
describe("Phase 25.6 — operational barrel re-exports", () => {
    const src = readSource("../../../apps/web/components/operational/index.ts");
    it("re-exports the four Phase 25.6 primitives", () => {
        for (const name of [
            "PriorityChip",
            "StuckBadge",
            "AssignmentSuggestionRow",
            "WorkloadHeatTile",
        ]) {
            expect(src, `${name} not re-exported`).toContain(name);
        }
    });
    it("re-exports the typed prop shapes for downstream consumers", () => {
        expect(src).toContain("type PriorityChipProps");
        expect(src).toContain("type StuckBadgeProps");
        expect(src).toContain("type AssignmentSuggestionRowProps");
        expect(src).toContain("type WorkloadHeatTileProps");
        expect(src).toContain("type ReviewerWorkloadSnapshot");
    });
});
// =============================================================================
// PriorityChip
// =============================================================================
describe("Phase 25.6 — PriorityChip", () => {
    const src = readSource("../../../apps/web/components/operational/PriorityChip.tsx");
    it("imports the canonical PriorityScoreResult type from @proovra/shared (never invents a shape)", () => {
        expect(src).toMatch(/import\s+type\s*\{\s*PriorityScoreResult\s*\}\s+from\s+"@proovra\/shared"/);
        expect(src).toMatch(/import\s*\{\s*summarisePriorityReasons\s*\}\s+from\s+"@proovra\/shared"/);
    });
    it("maps band → tone via the Phase 28-I OPS_TONES catalog (light-surface, WCAG-readable)", () => {
        expect(src).toMatch(/URGENT:\s*OPS_TONES\.critical/);
        expect(src).toMatch(/ATTENTION:\s*OPS_TONES\.warning/);
        expect(src).toMatch(/STANDARD:\s*OPS_TONES\.healthy/);
    });
    it("exposes data attributes the queue page can use for selectors + tests", () => {
        expect(src).toContain("data-priority-chip");
        expect(src).toContain("data-priority-band");
        expect(src).toContain("data-priority-score");
        expect(src).toContain("data-priority-top-reason");
    });
    it("renders the bounded band labels (URGENT / ATTENTION / STANDARD)", () => {
        expect(src).toMatch(/URGENT:\s*"URGENT"/);
        expect(src).toMatch(/ATTENTION:\s*"ATTENTION"/);
        expect(src).toMatch(/STANDARD:\s*"STANDARD"/);
    });
    it("becomes a button when onSelect is provided (keyboard-accessible)", () => {
        expect(src).toMatch(/onSelect\s*\?[\s\S]*?<button/);
        expect(src).toMatch(/type="button"/);
    });
    it("shows a tooltip with the summary of top reasons (operator scan path)", () => {
        expect(src).toMatch(/summarisePriorityReasons\(priority\.reasons, 3\)/);
        expect(src).toMatch(/title=\{tooltip\}/);
    });
    it("never uses dark-shell rgba(255,255,255,...) tokens (light-surface invariant)", () => {
        expect(src).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/);
    });
});
// =============================================================================
// StuckBadge
// =============================================================================
describe("Phase 25.6 — StuckBadge", () => {
    const src = readSource("../../../apps/web/components/operational/StuckBadge.tsx");
    it("imports the canonical StuckClassification type from @proovra/shared", () => {
        expect(src).toMatch(/import\s+type\s*\{\s*StuckClassification\s*\}\s+from\s+"@proovra\/shared"/);
    });
    it("renders null when the workflow is NOT stuck (calm queue rows stay clean)", () => {
        expect(src).toMatch(/if \(!classification\.isStuck\) return null/);
    });
    it("severity tone is taken from OPS_TONES (no hand-rolled rgba)", () => {
        expect(src).toMatch(/INFO:\s*OPS_TONES\.info/);
        expect(src).toMatch(/WARNING:\s*OPS_TONES\.warning/);
        expect(src).toMatch(/HIGH:\s*OPS_TONES\.high/);
        expect(src).toMatch(/CRITICAL:\s*OPS_TONES\.critical/);
    });
    it("exposes data attributes for selectors + tests", () => {
        expect(src).toContain("data-stuck-badge");
        expect(src).toContain("data-stuck-severity");
        expect(src).toContain("data-stuck-label");
        expect(src).toContain("data-stuck-top-reason");
        expect(src).toContain("data-stuck-extra-count");
    });
    it("compact mode renders a +N indicator when multiple stuck reasons exist", () => {
        expect(src).toMatch(/reasonCount > 1/);
        expect(src).toMatch(/\+\$\{reasonCount - 1\}|\+\{reasonCount - 1\}/);
    });
    it("never uses dark-shell tokens", () => {
        expect(src).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/);
    });
});
// =============================================================================
// AssignmentSuggestionRow
// =============================================================================
describe("Phase 25.6 — AssignmentSuggestionRow", () => {
    const src = readSource("../../../apps/web/components/operational/AssignmentSuggestionRow.tsx");
    it("imports the canonical ReviewerSuggestion type from @proovra/shared", () => {
        expect(src).toMatch(/import\s+type\s*\{\s*ReviewerSuggestion\s*\}\s+from\s+"@proovra\/shared"/);
    });
    it("maps every recommendationBand to a token palette (no fallthrough)", () => {
        for (const band of [
            "RECOMMENDED",
            "ACCEPTABLE",
            "LAST_RESORT",
            "NOT_RECOMMENDED",
        ]) {
            expect(src, `band ${band} missing palette mapping`).toContain(`${band}: OPS_TONES`);
        }
    });
    it("renders bounded risk-flag short labels (no free-text leak)", () => {
        for (const code of [
            "reviewer_overloaded",
            "reviewer_overdue_pressure",
            "reviewer_escalation_pressure",
            "reviewer_recent_assignment_burst",
            "reviewer_inactive_warning",
            "workload_imbalance",
        ]) {
            expect(src, `risk code ${code} not handled`).toContain(code);
        }
    });
    it("displayName is caller-resolved (component never bypasses RBAC to fetch names)", () => {
        // No Prisma / fetch / api imports — the component is a pure render
        // surface.
        expect(src).not.toMatch(/from\s+"@prisma\/client"/);
        expect(src).not.toMatch(/from\s+"\.\.\/\.\.\/lib\/api"/);
    });
    it("uses fallback truncated id when displayName is missing (anti-leak hedge)", () => {
        expect(src).toMatch(/fallbackName/);
        expect(src).toMatch(/id\.slice\(0, 8\)/);
    });
    it("exposes data attributes for selectors + tests", () => {
        expect(src).toContain("data-suggestion-row");
        expect(src).toContain("data-suggestion-band");
        expect(src).toContain("data-suggestion-reviewer");
        expect(src).toContain("data-suggestion-top-reason");
        expect(src).toContain("data-suggestion-score");
        expect(src).toContain("data-risk-flag");
        expect(src).toContain("data-risk-severity");
    });
    it("becomes a button when onSelect is provided", () => {
        expect(src).toMatch(/onSelect\s*\?[\s\S]*?<button/);
    });
    it("never uses dark-shell tokens", () => {
        expect(src).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/);
    });
});
// =============================================================================
// WorkloadHeatTile
// =============================================================================
describe("Phase 25.6 — WorkloadHeatTile", () => {
    const src = readSource("../../../apps/web/components/operational/WorkloadHeatTile.tsx");
    it("declares a typed ReviewerWorkloadSnapshot shape — never accepts an unbounded object", () => {
        expect(src).toMatch(/export type ReviewerWorkloadSnapshot = \{[\s\S]*?reviewerId:\s*string/);
        expect(src).toMatch(/activeReviews:\s*number/);
        expect(src).toMatch(/overdueReviews:\s*number/);
        expect(src).toMatch(/dueSoonReviews:\s*number/);
        expect(src).toMatch(/escalatedReviews:\s*number/);
        expect(src).toMatch(/pressure:\s*"available"\s*\|\s*"balanced"\s*\|\s*"overloaded"/);
    });
    it("maps pressure → tone via OPS_TONES (light-surface readability)", () => {
        expect(src).toMatch(/available:\s*OPS_TONES\.healthy/);
        expect(src).toMatch(/balanced:\s*OPS_TONES\.info/);
        expect(src).toMatch(/overloaded:\s*OPS_TONES\.high/);
    });
    it("renders imbalance + inactivity warnings inline (real signals only)", () => {
        expect(src).toContain('data-warning="imbalance"');
        expect(src).toContain('data-warning="inactive"');
        // Imbalance is derived from the caller-supplied teamMeanActive.
        expect(src).toMatch(/teamMeanActive[\s\S]{0,80}\* 1\.5/);
        expect(src).toMatch(/inactivityDays.*>=.*14|>=.*14.*inactivityDays/);
    });
    it("counter chips never fabricate values — all four use snapshot fields directly", () => {
        expect(src).toMatch(/value=\{snapshot\.overdueReviews\}/);
        expect(src).toMatch(/value=\{snapshot\.dueSoonReviews\}/);
        expect(src).toMatch(/value=\{snapshot\.escalatedReviews\}/);
        expect(src).toMatch(/value=\{snapshot\.recentCompleted\}/);
    });
    it("does NOT render any chart / SVG / bar graph (operational tile, not BI)", () => {
        expect(src).not.toMatch(/<svg/);
        expect(src).not.toMatch(/from\s+"recharts"|from\s+"chart\.js"|from\s+"d3"/);
    });
    it("exposes data attributes for selectors + tests", () => {
        expect(src).toContain("data-workload-heat-tile");
        expect(src).toContain("data-workload-pressure");
        expect(src).toContain("data-workload-active");
        expect(src).toContain("data-pressure");
        expect(src).toContain("data-workload-chip");
        expect(src).toContain("data-warning");
    });
    it("never uses dark-shell tokens on a light surface", () => {
        expect(src).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/);
    });
});
// =============================================================================
// Cross-primitive invariants — privacy / governance / contrast
// =============================================================================
describe("Phase 25.6 — cross-primitive invariants", () => {
    it("no primitive imports Prisma / Node / Fastify (pure render surface)", () => {
        for (const rel of PRIMITIVE_FILES) {
            const src = readSource(rel);
            expect(src, `${rel} imports Prisma`).not.toMatch(/from\s+"@prisma\/client"/);
            expect(src, `${rel} imports Fastify`).not.toMatch(/from\s+"fastify"/);
            expect(src, `${rel} imports node:fs/api`).not.toMatch(/from\s+"node:fs"|from\s+"node:http"/);
        }
    });
    it("no primitive imports the api client (so RBAC stays at the page level)", () => {
        for (const rel of PRIMITIVE_FILES) {
            const src = readSource(rel);
            expect(src, `${rel} imports apiFetch directly`).not.toMatch(/from\s+"\.\.\/\.\.\/lib\/api"/);
        }
    });
    it("no primitive uses banned wording in string literals (tamper / forged / altered content)", () => {
        const banned = /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
        for (const rel of PRIMITIVE_FILES) {
            const src = readSource(rel);
            const literals = src.match(/"[^"\n]+"/g) ?? [];
            expect(literals.join(" "), `banned wording leaked into ${rel}`).not.toMatch(banned);
        }
    });
    it("no primitive references private/restricted evidence fields", () => {
        for (const rel of PRIMITIVE_FILES) {
            const src = readSource(rel);
            const noComments = src
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/\/\/[^\n]*/g, "");
            for (const forbidden of [
                "privateReviewerNote",
                "legalNoteBody",
                "storageKey",
                "signed_url",
                "raw_gps",
                "gpsCoordinates",
            ]) {
                expect(noComments, `${rel} references ${forbidden} in executable code`).not.toContain(forbidden);
            }
        }
    });
    it("no primitive renders a giant empty card — every component exits early when there's no signal", () => {
        // StuckBadge returns null when !isStuck.
        const stuck = readSource("../../../apps/web/components/operational/StuckBadge.tsx");
        expect(stuck).toMatch(/return null/);
        // The other primitives are signal-driven: each requires a typed
        // prop and renders dense content from it.
        for (const rel of PRIMITIVE_FILES) {
            const src = readSource(rel);
            // Forbid fixed "no data" placeholder text.
            expect(src).not.toMatch(/No data/i);
            expect(src).not.toMatch(/Nothing here/i);
            expect(src).not.toMatch(/Coming soon/i);
        }
    });
    it("no primitive fabricates operational counters", () => {
        for (const rel of PRIMITIVE_FILES) {
            const src = readSource(rel);
            expect(src).not.toMatch(/escalations:\s*\d+,/);
            expect(src).not.toMatch(/incidents:\s*\d+,/);
            expect(src).not.toMatch(/overdue:\s*\d+,/);
            expect(src).not.toMatch(/active:\s*\d+,/);
        }
    });
    it("every primitive exposes a `data-*` attribute root for downstream selectors", () => {
        const expectedRoots = {
            "../../../apps/web/components/operational/PriorityChip.tsx": "data-priority-chip",
            "../../../apps/web/components/operational/StuckBadge.tsx": "data-stuck-badge",
            "../../../apps/web/components/operational/AssignmentSuggestionRow.tsx": "data-suggestion-row",
            "../../../apps/web/components/operational/WorkloadHeatTile.tsx": "data-workload-heat-tile",
        };
        for (const [rel, attr] of Object.entries(expectedRoots)) {
            const src = readSource(rel);
            expect(src, `${rel} missing ${attr}`).toContain(attr);
        }
    });
});
