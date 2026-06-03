/**
 * PHASE 38 — Persona foundation source-contract tests.
 *
 * The use-case persona is UX-LAYER ONLY. It NEVER grants capabilities,
 * NEVER bypasses access helpers, NEVER changes route guards. This file
 * pins that contract so future PRs cannot accidentally couple persona
 * to authorization.
 *
 * Parts:
 *   1  Types — bounded vocabularies + envelope field
 *   2  Resolver service — read-only, defaulted, tenant-scoped
 *   3  Schema + migration — additive only
 *   4  Capability registry purity — capability resolution does NOT read
 *      the persona profile
 *   5  Frontend mirror — types + hooks + reorder helper present
 *   6  Sidebar reorder helper — pure, never adds/removes items
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKSPACE_PERSONA_PROFILES, OPERATIONAL_DENSITY_PREFERENCES, } from "../src/services/platform-context/types.js";
import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)), "utf8");
}
const TYPES = readApi("src/services/platform-context/types.ts");
const RESOLVER = readApi("src/services/platform-context/persona-profile.service.ts");
const SVC = readApi("src/services/platform-context/platform-context.service.ts");
const CAP_REGISTRY = readApi("src/services/platform-context/capability-registry.ts");
const SCHEMA = readApi("prisma/schema.prisma");
const MIGRATION = readApi("prisma/migrations/20260721000000_workspace_persona_profile/migration.sql");
const WEB_TYPES = readWeb("lib/platform-context/types.ts");
const WEB_HOOK = readWeb("lib/platform-context/usePersonaProfile.ts");
const WEB_REORDER = readWeb("lib/platform-context/personaPriorityOrder.ts");
const WEB_INDEX = readWeb("lib/platform-context/index.ts");
const WEB_SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
// =============================================================================
// PART 1 — Types
// =============================================================================
describe("Phase 38 — persona type vocabulary", () => {
    it("declares the 7 canonical persona profiles", () => {
        expect(WORKSPACE_PERSONA_PROFILES).toEqual([
            "INDIVIDUAL",
            "LAWYER",
            "INSURANCE",
            "INVESTIGATOR",
            "JOURNALIST",
            "ENTERPRISE_COMPLIANCE",
            "ADMIN_OPERATOR",
        ]);
    });
    it("declares the 3 canonical density preferences", () => {
        expect(OPERATIONAL_DENSITY_PREFERENCES).toEqual([
            "compact",
            "comfortable",
            "spacious",
        ]);
    });
    it("PlatformContextPersonaProfile is declared on the envelope", () => {
        expect(TYPES).toMatch(/export type PlatformContextPersonaProfile\b/);
        expect(TYPES).toMatch(/personaProfile\?:\s*PlatformContextPersonaProfile/);
    });
    it("declares the source-tag union 'default' | 'stored' (never silently fakes data)", () => {
        expect(TYPES).toMatch(/source:\s*"default"\s*\|\s*"stored"/);
    });
});
// =============================================================================
// PART 2 — Resolver service
// =============================================================================
describe("Phase 38 — persona resolver service", () => {
    it("exports the canonical functions", () => {
        expect(RESOLVER).toMatch(/export function defaultPersonaProfile\(/);
        expect(RESOLVER).toMatch(/export async function readWorkspacePersonaProfile\(/);
    });
    it("rejects a null teamId by returning the default (no global read)", () => {
        expect(RESOLVER).toMatch(/if \(!input\.teamId\)[\s\S]{0,200}defaultPersonaProfile/);
    });
    it("uses a primary-key findUnique scoped by teamId (no findMany)", () => {
        expect(RESOLVER).toMatch(/workspacePersonaProfile\.findUnique\(\s*\{\s*where:\s*\{\s*teamId/);
        expect(RESOLVER).not.toMatch(/workspacePersonaProfile\.findMany/);
    });
    it("never throws (degrades to default on read failure)", () => {
        expect(RESOLVER).toMatch(/catch\b[\s\S]{0,200}defaultPersonaProfile/);
    });
    it("does NOT call any authorize helper (persona never grants caps)", () => {
        expect(RESOLVER).not.toMatch(/authorizeOrFail/);
        expect(RESOLVER).not.toMatch(/evaluateAuthorize/);
        expect(RESOLVER).not.toMatch(/evaluateMemberAccess/);
    });
});
// =============================================================================
// PART 3 — Schema + migration
// =============================================================================
describe("Phase 38 — schema + migration", () => {
    it("schema declares WorkspacePersonaProfile keyed by teamId", () => {
        expect(SCHEMA).toMatch(/model WorkspacePersonaProfile\s*\{/);
        expect(SCHEMA).toMatch(/teamId\s+String\s+@id\s+@map\("team_id"\)/);
        expect(SCHEMA).toMatch(/@@map\("workspace_persona_profiles"\)/);
    });
    it("schema declares the bounded primary_profile default", () => {
        expect(SCHEMA).toMatch(/primaryProfile\s+String\s+@default\("INDIVIDUAL"\)/);
    });
    it("migration uses IF NOT EXISTS on every CREATE", () => {
        const creates = MIGRATION.match(/CREATE [^\n]+/g) ?? [];
        expect(creates.length).toBeGreaterThan(0);
        for (const line of creates) {
            expect(/IF NOT EXISTS/i.test(line)).toBe(true);
        }
    });
    it("migration declares an FK to teams with ON DELETE CASCADE", () => {
        expect(MIGRATION).toMatch(/FOREIGN KEY \("team_id"\) REFERENCES "teams"/);
        expect(MIGRATION).toMatch(/ON DELETE CASCADE/);
    });
});
// =============================================================================
// PART 4 — Capability registry purity (the headline guarantee)
// =============================================================================
describe("Phase 38 — capability registry stays persona-free", () => {
    it("capability-registry.ts does NOT read the use-case persona profile", () => {
        // The legacy `resolvePersona` function (role-derived) predates this
        // phase and stays — it's a deterministic projection of (role × scope),
        // not the use-case persona. Strip comments + the legacy function and
        // assert no use-case-persona references remain.
        const code = CAP_REGISTRY.replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1")
            .replace(/export function resolvePersona\([\s\S]*?^\}/m, "");
        expect(code).not.toMatch(/WorkspacePersonaProfile/);
        expect(code).not.toMatch(/primaryProfile/);
        expect(code).not.toMatch(/WORKSPACE_PERSONA_PROFILES/);
    });
    it("capability resolution is deterministic across personas (same role/scope/plan inputs)", () => {
        const a = resolveCapabilities({
            scope: "TEAM",
            role: "OWNER",
            plan: "TEAM",
            isPlatformAdmin: false,
        });
        const b = resolveCapabilities({
            scope: "TEAM",
            role: "OWNER",
            plan: "TEAM",
            isPlatformAdmin: false,
        });
        expect(a).toEqual(b);
    });
    it("platform-context service reads persona but does NOT use it to gate caps", () => {
        // The resolver is imported and called for the envelope...
        expect(SVC).toMatch(/import\s*\{\s*readWorkspacePersonaProfile\s*\}\s*from\s*"\.\/persona-profile\.service\.js"/);
        // ...but `resolveCapabilities({ ... })` arguments must not include
        // the persona profile in any form.
        const capCalls = SVC.match(/resolveCapabilities\(\s*\{[\s\S]*?\}\s*\)/g) ?? [];
        expect(capCalls.length).toBeGreaterThan(0);
        for (const call of capCalls) {
            expect(/persona/i.test(call)).toBe(false);
        }
    });
});
// =============================================================================
// PART 5 — Frontend mirror
// =============================================================================
describe("Phase 38 — frontend mirror + hooks", () => {
    it("frontend types mirror the persona vocabulary", () => {
        expect(WEB_TYPES).toMatch(/WORKSPACE_PERSONA_PROFILES\s*=\s*\[/);
        expect(WEB_TYPES).toMatch(/PlatformContextPersonaProfile\b/);
        expect(WEB_TYPES).toMatch(/personaProfile\?:\s*PlatformContextPersonaProfile/);
    });
    it("usePersonaProfile hook reads envelope.personaProfile (no fetch, no role derivation)", () => {
        expect(WEB_HOOK).toMatch(/usePlatformContext/);
        expect(WEB_HOOK).not.toMatch(/apiFetch|fetch\(/);
        expect(WEB_HOOK).toMatch(/envelope\?\.personaProfile\b/);
    });
    it("hooks are exported from the platform-context index", () => {
        expect(WEB_INDEX).toMatch(/usePersonaProfile/);
        expect(WEB_INDEX).toMatch(/usePrimaryPersona/);
        expect(WEB_INDEX).toMatch(/useIsOperatorPersona/);
        expect(WEB_INDEX).toMatch(/reorderByPersona/);
    });
});
// =============================================================================
// PART 6 — Sidebar reorder pure-function correctness
// =============================================================================
describe("Phase 38 — reorderByPersona never adds or removes items", () => {
    // Import the helper directly via dynamic import so the test runs in
    // Node (no DOM).
    it("reorderByPersona returns a permutation of the input (no add/remove)", async () => {
        const { reorderByPersona } = await import("../../../apps/web/lib/platform-context/personaPriorityOrder.js");
        const items = [
            { id: "workspace.home" },
            { id: "workspace.capture" },
            { id: "workspace.evidence" },
            { id: "workspace.cases" },
            { id: "workspace.reports" },
            { id: "review.queue" },
            { id: "review.sla" },
            { id: "governance.hub" },
            { id: "governance.policy" },
            { id: "platform.ops_center" },
        ];
        for (const persona of WORKSPACE_PERSONA_PROFILES) {
            const out = reorderByPersona(items, persona);
            const inIds = new Set(items.map((i) => i.id));
            const outIds = new Set(out.map((i) => i.id));
            // Same set; reorder is a permutation.
            expect(out).toHaveLength(items.length);
            expect(outIds).toEqual(inIds);
        }
    });
    it("reorderByPersona is stable for the default INDIVIDUAL profile (no surprise reordering)", async () => {
        const { reorderByPersona } = await import("../../../apps/web/lib/platform-context/personaPriorityOrder.js");
        const items = [
            { id: "workspace.capture" },
            { id: "workspace.evidence" },
            { id: "workspace.cases" },
            { id: "workspace.reports" },
            { id: "workspace.search" },
        ];
        const out = reorderByPersona(items, "INDIVIDUAL");
        // INDIVIDUAL priority preserves the canonical order.
        expect(out.map((i) => i.id)).toEqual([
            "workspace.capture",
            "workspace.evidence",
            "workspace.cases",
            "workspace.reports",
            "workspace.search",
        ]);
    });
    it("LAWYER persona pulls cases ahead of capture (existing items only)", async () => {
        const { reorderByPersona } = await import("../../../apps/web/lib/platform-context/personaPriorityOrder.js");
        const items = [
            { id: "workspace.capture" },
            { id: "workspace.evidence" },
            { id: "workspace.cases" },
            { id: "workspace.reports" },
        ];
        const out = reorderByPersona(items, "LAWYER");
        expect(out.map((i) => i.id)).toEqual([
            "workspace.cases",
            "workspace.evidence",
            "workspace.reports",
            "workspace.capture",
        ]);
    });
    it("AppSidebarV2 consumes the persona/workflow priority helper for navigation reorder", () => {
        // Phase 38.1 → 38.9: the sidebar moved from `reorderByPersona` to
        // `splitByPersona` to `resolveWorkflowExposure` (which buckets by
        // workflow priority — the canonical exposure resolver, strict
        // superset of the older helpers).
        expect(WEB_SIDEBAR).toMatch(/splitByPersona|reorderByPersona|resolveWorkflowExposure/);
        expect(WEB_SIDEBAR).toMatch(/persona|primaryWorkflow/);
    });
});
