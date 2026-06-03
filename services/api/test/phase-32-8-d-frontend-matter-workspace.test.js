/**
 * Phase 32.8D-frontend — Matter Operations Queue + Matter Workspace
 * source-contract tests.
 *
 * Pinned invariants:
 *
 *   1. /cases consumes /v1/cases/matter-queue (not /v1/cases/summary).
 *   2. /cases/:id consumes /v1/cases/:id/matter-workspace (not the
 *      legacy /v1/cases/:id/workspace).
 *   3. All 11 sections are rendered.
 *   4. Authority is canonical only — no useActiveWorkspaceId, no
 *      /v1/users/me authority fetch, no /v1/teams authority fetch,
 *      no inline role-string equality.
 *   5. No signed-URL / report / package generation on render.
 *   6. No legal-admissibility / authenticity / truth claims.
 *   7. The 7 audited mutation endpoints are wired with correct
 *      method + path shape.
 *   8. Mutation errors classified for 403 / 409 / 422 / 404 with
 *      explicit copy.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readWeb(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)), "utf8");
}
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const INDEX = readWeb("components/cases-experience/CasesIndex.tsx");
const INDEX_PAGE = readWeb("app/(app)/cases/page.tsx");
const TYPES = readWeb("components/cases-experience/types.ts");
// Phase C1 / C1.1 — the legacy `CaseWorkspace` (the 32.8D classic flow)
// was retired. The canonical `/cases/[id]` surface now mounts the
// tabbed `MatterWorkspace` component with a different internal contract
// (sections, mutation wiring, authority + safety). All canonical
// Matter-Workspace contract assertions live in
// `phase-c1-matter-workspace.test.ts`. The 32.8D-frontend file retains
// the **Matter Operations Queue** (CasesIndex) + **types contract**
// coverage; the 32.8D-frontend CaseWorkspace-specific Parts 2-4 below
// have been superseded.
// ===========================================================================
// PART 1 — Matter Operations Queue (CasesIndex)
// ===========================================================================
describe("Phase 32.8D-frontend — Matter Operations Queue", () => {
    it("/cases page delegates to the CasesIndex component", () => {
        expect(INDEX_PAGE).toMatch(/<CasesIndex\s*\/>/);
    });
    it("consumes GET /v1/cases/matter-queue with a teamId query", () => {
        expect(INDEX).toMatch(/apiFetch\(\s*[`"]\/v1\/cases\/matter-queue/);
        expect(INDEX).toMatch(/teamId/);
    });
    it("does NOT consume the legacy /v1/cases/summary endpoint anymore", () => {
        const live = stripComments(INDEX);
        expect(live).not.toMatch(/apiFetch\(\s*[`"]\/v1\/cases\/summary/);
    });
    it("renders the required operational counters per row", () => {
        for (const dataKey of [
            "linked-evidence",
            "evidence-gap",
            "open-incidents",
            "active-workflows",
            "overdue-workflows",
            "governance-blockers",
            "assignments",
        ]) {
            expect(INDEX).toContain(`data-matter-queue-row-counter`);
            expect(INDEX).toContain(`"${dataKey}"`);
        }
    });
    it("renders risk score / level / reason codes / recommended action per row", () => {
        expect(INDEX).toMatch(/data-matter-queue-row-chip="risk"/);
        expect(INDEX).toMatch(/data-matter-queue-row-reason-codes/);
        expect(INDEX).toMatch(/data-matter-queue-row-recommendation/);
    });
    it("renders legal hold chip when activeLegalHoldCount > 0", () => {
        expect(INDEX).toMatch(/data-matter-queue-row-chip="hold"/);
        expect(INDEX).toMatch(/activeLegalHoldCount/);
    });
    it("wires the required server filters as query parameters", () => {
        for (const param of [
            "status",
            "riskLevel",
            "assignedToUserId",
            "hasOpenIncidents",
            "hasGovernanceBlockers",
            "hasOverdueWorkflows",
            "hasLegalHold",
            "missingArtifact",
            "search",
        ]) {
            expect(INDEX).toMatch(new RegExp(`qs\\.set\\(\\s*[\\"\`]${param}`));
        }
    });
    it("Personal workspace renders CapabilityDegradedPanel (no plain-text fallback)", () => {
        expect(INDEX).toMatch(/CapabilityDegradedPanel/);
        expect(INDEX).toMatch(/data-cases-personal-mode/);
    });
    it("does NOT fabricate any counters — every counter reads from the row envelope", () => {
        const live = stripComments(INDEX);
        // No literal counter values like ` 42 evidence` that would
        // signal hardcoded data; values come from `row.X` accessors.
        expect(live).toMatch(/row\.linkedEvidenceCount/);
        expect(live).toMatch(/row\.openIncidentCount/);
        expect(live).toMatch(/row\.overdueWorkflowCount/);
        expect(live).toMatch(/row\.governanceBlockerCount/);
        expect(live).toMatch(/row\.activeLegalHoldCount/);
        expect(live).toMatch(/row\.riskScore/);
        expect(live).toMatch(/row\.riskLevel/);
    });
    it("has empty / loading / auth-error / unavailable shells with retry", () => {
        expect(INDEX).toMatch(/data-matter-queue-empty/);
        expect(INDEX).toMatch(/data-matter-queue-loading/);
        expect(INDEX).toMatch(/data-matter-queue-auth-error/);
        expect(INDEX).toMatch(/data-matter-queue-unavailable/);
        expect(INDEX).toMatch(/onRetry/);
    });
});
// ===========================================================================
// PARTS 2-4 — Matter Workspace (CaseWorkspace) — RETIRED
//
// The legacy `CaseWorkspace.tsx` (the 32.8D classic flow with section
// data attributes / risk tiles / closure-blocked banner / mutation
// wiring) was deleted in Phase C1.1. Its successor — the tabbed
// `MatterWorkspace.tsx` — has a different internal contract and is
// covered by `phase-c1-matter-workspace.test.ts`. The single
// canonical-state assertion below replaces the obsolete Parts 2-4 so
// the file no longer claims to test a deleted component.
// ===========================================================================
describe("Phase 32.8D-frontend — Matter Workspace canonical surface", () => {
    it("the canonical MatterWorkspace component exists at the canonical path (C1.1)", () => {
        // The 32.8D-frontend assertions about CaseWorkspace's section
        // data attributes + risk tiles + closure-blocked banner +
        // 7 mutation endpoints + status-code classifier are superseded
        // by `phase-c1-matter-workspace.test.ts`, which pins the
        // canonical tabbed MatterWorkspace contract. This single
        // assertion records the canonical mount existence so the
        // 32.8D-frontend file stays honest about what it covers
        // (CasesIndex + types).
        const fs = require("node:fs");
        const path = require("node:url").fileURLToPath(new URL("../../../apps/web/components/cases-experience/MatterWorkspace.tsx", import.meta.url));
        expect(fs.existsSync(path)).toBe(true);
    });
});
// ===========================================================================
// PART 5 — Types contract
// ===========================================================================
describe("Phase 32.8D-frontend — types contract", () => {
    it("frontend types export MatterQueueEnvelope + MatterQueueItem", () => {
        expect(TYPES).toMatch(/MatterQueueEnvelope/);
        expect(TYPES).toMatch(/MatterQueueItem/);
    });
    it("frontend types export MatterWorkspaceEnvelope with all 11 sections", () => {
        expect(TYPES).toMatch(/MatterWorkspaceEnvelope/);
        for (const key of [
            "commandSummary",
            "evidence",
            "relationships",
            "workflows",
            "incidentsAndCausality",
            "reviewerCoordination",
            "governance",
            "custodyAndIntegrity",
            "timeline",
            "notes",
            "deliverables",
        ]) {
            expect(TYPES).toContain(`${key}:`);
        }
    });
});
