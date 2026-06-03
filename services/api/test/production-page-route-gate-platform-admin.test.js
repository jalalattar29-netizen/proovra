/**
 * Production PageRouteGate fix — PLATFORM_ADMIN_ONLY renders a panel,
 * not a blank page.
 *
 * Pins the fix for the production bug where non-platform-admin users
 * who typed `/operations/observability` (or any other platform-admin
 * route) directly into the URL bar saw a completely blank page. The
 * component's header rule explicitly says "NEVER renders a blank page",
 * but the PLATFORM_ADMIN_ONLY branch returned `null`. This test holds
 * the fix in place.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readWeb(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)), "utf8");
}
const GATE = readWeb("components/navigation/PageRouteGate.tsx");
describe("Production fix — PageRouteGate PLATFORM_ADMIN_ONLY is no longer blank", () => {
    it("does NOT return null on PLATFORM_ADMIN_ONLY (was the production blank-page bug)", () => {
        // The legacy code was `if (access.accessState === "PLATFORM_ADMIN_ONLY") return null;`.
        // After the fix, the PLATFORM_ADMIN_ONLY branch must render a panel,
        // not return null. We scan the surrounding 800 chars for `return null`
        // — none should appear in the PLATFORM_ADMIN_ONLY block.
        const branchIdx = GATE.indexOf(`access.accessState === "PLATFORM_ADMIN_ONLY"`);
        expect(branchIdx).toBeGreaterThan(-1);
        const branchBlock = GATE.slice(branchIdx, branchIdx + 800);
        expect(branchBlock).not.toMatch(/\breturn\s+null\s*;/);
    });
    it("renders a structured panel with primary + secondary actions on PLATFORM_ADMIN_ONLY", () => {
        // The new panel must include the canonical structure: main element +
        // header + actions section + Back-to-home primary + Browse-all-tools
        // secondary. We assert the markers (data attributes + link hrefs).
        const branchIdx = GATE.indexOf(`access.accessState === "PLATFORM_ADMIN_ONLY"`);
        expect(branchIdx).toBeGreaterThan(-1);
        const branchBlock = GATE.slice(branchIdx, branchIdx + 3000);
        expect(branchBlock).toMatch(/data-page-route-gate-state=\{access\.accessState\}/);
        expect(branchBlock).toMatch(/href="\/home"/);
        expect(branchBlock).toMatch(/href="\/tools"/);
        expect(branchBlock).toMatch(/data-page-route-gate-primary-action/);
        expect(branchBlock).toMatch(/Back to home/);
    });
    it("uses the canonical denial vocabulary (accessStateToDenialReason)", () => {
        // Reuses the existing canonical denial-vocabulary helpers so copy
        // stays consistent across gates.
        const branchIdx = GATE.indexOf(`access.accessState === "PLATFORM_ADMIN_ONLY"`);
        expect(branchIdx).toBeGreaterThan(-1);
        const branchBlock = GATE.slice(branchIdx, branchIdx + 3000);
        expect(branchBlock).toMatch(/accessStateToDenialReason/);
    });
});
